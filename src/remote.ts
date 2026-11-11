import { workerEventSchema } from "./contracts";
import type { WorkerEvent } from "./contracts";
import { targetFor } from "./targets";

export class RemoteError extends Error {
  constructor(message: string, readonly exitCode: number | null = null) {
    super(message);
    this.name = "RemoteError";
  }
}

export function quoteShell(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export function sshCommand(host: string, command: string): string[] {
  return [
    "ssh", "-T", "-o", "BatchMode=yes", "-o", "ConnectTimeout=8",
    "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=2", "--", host, command,
  ];
}

export type RemoteRequest = {
  readonly host: string;
  readonly operation: "discover" | "datasetui" | "configs" | "episodes" | "evaluate";
  readonly repo?: string;
  readonly roots?: readonly string[];
  readonly datasetuiContainer?: string;
  readonly datasetuiRoot?: string;
  readonly config?: string;
  readonly checkpoint?: string;
  readonly dataset?: string;
  readonly episodes?: readonly number[];
  readonly maxSamples?: number;
  readonly stride?: number;
  readonly seed?: number;
  readonly numSteps?: number;
  readonly tensorrt?: boolean;
};

/** Remote interpreter for PyTorch checkpoints on `host` (env override, then target); `~` expands remotely. */
export function pytorchPython(host?: string): string {
  return process.env["VLAEVAL_PYTORCH_PYTHON"]
    ?? (host === undefined ? undefined : targetFor(host)?.pytorchPython) ?? "~/kgs/venvs/pi05_cu128/bin/python";
}

/** Shell fragment assigning $py: the PyTorch interpreter when the checkpoint holds model.safetensors. */
export function openpiPythonSelector(repo: string, checkpoint: string): string {
  const torch = pytorchPython();
  const torchShell = torch.startsWith("~/") ? `"$HOME"/${quoteShell(torch.slice(2))}` : quoteShell(torch);
  return `c=${quoteShell(checkpoint)}; case "$c" in */model.safetensors|*/params) c="\${c%/*}";; esac; `
    + `if [ -f "$c/model.safetensors" ]; then py=${torchShell}; else py=${quoteShell(`${repo}/.venv/bin/python`)}; fi; `;
}

export function workerCommand(request: RemoteRequest): string {
  const python = request.operation === "discover" || request.operation === "datasetui" ? "python3" : `${request.repo}/.venv/bin/python`;
  const payload = Buffer.from(JSON.stringify(request.operation === "evaluate"
    ? { ...request, pytorchPython: pytorchPython(request.host) } : request)).toString("base64");
  return `exec env PYTHONDONTWRITEBYTECODE=1 XLA_PYTHON_CLIENT_PREALLOCATE=false ${quoteShell(python)} -u - ${quoteShell(payload)}`;
}

export async function consumeLines(
  stream: ReadableStream<Uint8Array>,
  onLine: (line: string) => void,
): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      // Search only the new chunk: rescanning a multi-megabyte pending line per chunk is quadratic.
      const searched = pending.length;
      pending += decoder.decode(value, { stream: true });
      let newline = pending.indexOf("\n", searched);
      while (newline >= 0) {
        onLine(pending.slice(0, newline).replace(/\r$/, ""));
        pending = pending.slice(newline + 1);
        newline = pending.indexOf("\n");
      }
    }
    pending += decoder.decode();
    if (pending) onLine(pending);
  } finally {
    reader.releaseLock();
  }
}

export async function runRemote(
  request: RemoteRequest,
  onEvent: (event: WorkerEvent) => void,
  onLog: (line: string) => void,
): Promise<void> {
  const script = await Bun.file(new URL("../worker.py", import.meta.url)).text();
  const child = Bun.spawn(sshCommand(request.host, workerCommand(request)), {
    stdin: new Blob([script]), stdout: "pipe", stderr: "pipe",
  });
  const errors: string[] = [];
  let eventError: string | null = null;
  let cancelled = false;
  try {
    await Promise.all([
      consumeLines(child.stdout, (line) => {
        if (!line.startsWith("VLAEVAL ")) {
          if (line) onLog(line.slice(0, 2000));
          return;
        }
        const event = workerEventSchema.parse(JSON.parse(line.slice(8)));
        if (event.type === "error") eventError = event.message;
        if (event.type === "cancelled") cancelled = true;
        onEvent(event);
      }),
      consumeLines(child.stderr, (line) => {
        errors.push(line.slice(0, 2000));
        if (errors.length > 20) errors.shift();
        if (line) onLog(line.slice(0, 2000));
      }),
    ]);
    const code = await child.exited;
    if (eventError) throw new RemoteError(eventError, code);
    if (code !== 0 && !cancelled) {
      throw new RemoteError(errors.join("\n") || `SSH worker exited with code ${code}.`, code);
    }
  } finally {
    if (child.exitCode === null) child.kill();
    await child.exited;
  }
}

export async function cancelRemote(host: string, pid: number): Promise<void> {
  if (!Number.isSafeInteger(pid) || pid < 2) throw new RemoteError("잘못된 worker PID입니다.");
  const child = Bun.spawn(sshCommand(host, `kill -TERM ${pid}`), {
    stdin: "ignore", stdout: "pipe", stderr: "pipe",
  });
  const stderr = await new Response(child.stderr).text();
  const code = await child.exited;
  if (code !== 0) throw new RemoteError(stderr || "원격 평가 취소에 실패했습니다.", code);
}
