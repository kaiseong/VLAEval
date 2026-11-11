import { deflateSync } from "node:zlib";
import { diagnosticRunnerEventSchema } from "./diagnostic-run-contracts";
import type { AttentionVideoRequest, DiagnosticRequest, DiagnosticRunner } from "./diagnostic-run-contracts";
import { maximumDiagnosticBytes } from "./diagnostic-contracts";
import { maximumAttentionVideoBytes } from "./attention-video-contracts";
import { cancelRemote, consumeLines, openpiPythonSelector, RemoteError, sshCommand } from "./remote";

/** All source and request data travel on stdin, never in SSH's argument vector. */
export async function diagnosticScript(request: DiagnosticRequest | AttentionVideoRequest): Promise<string> {
  const entry = "mode" in request && request.mode === "video" ? "runtime_video_main" : "runtime_main";
  const torchAdapter = Bun.file(new URL("../../vlaeval-attention/attention_adapter_pytorch.py", import.meta.url));
  const [diagnostics, worker, adapter, adapterTorch] = await Promise.all([
    Bun.file(new URL("../diagnostics_worker.py", import.meta.url)).text(),
    Bun.file(new URL("../worker.py", import.meta.url)).text(),
    Bun.file(new URL("../../vlaeval-attention/attention_adapter.py", import.meta.url)).text(),
    torchAdapter.exists().then((exists) => exists ? torchAdapter.text() : ""),
  ]);
  const packed = (source: string) => deflateSync(Buffer.from(source)).toString("base64");
  // Separate compile units preserve __future__ imports and prevent worker.py's CLI entrypoint.
  return `import os, signal, ctypes, json, base64, zlib, hashlib, sys
if os.getpgrp() != os.getpid():
    os.setpgid(0, 0)
_parent = os.getppid()
if ctypes.CDLL(None).prctl(1, signal.SIGKILL, 0, 0, 0) != 0:
    raise RuntimeError("Cannot install diagnostic parent-death signal")
if os.getppid() != _parent:
    os.kill(os.getpid(), signal.SIGKILL)
print("VLAEVAL_DIAGNOSTIC " + json.dumps({"type": "started", "pid": os.getpid()}), flush=True)
_namespace = {"__name__": "vlaeval_diagnostics"}
exec(compile(zlib.decompress(base64.b64decode(${JSON.stringify(packed(diagnostics))})).decode(), "diagnostics_worker.py", "exec"), _namespace)
_request = json.loads(base64.b64decode(${JSON.stringify(Buffer.from(JSON.stringify(request)).toString("base64"))}))
_worker = zlib.decompress(base64.b64decode(${JSON.stringify(packed(worker))})).decode()
_ckpt = os.path.expanduser(_request["checkpoint"])
if os.path.basename(_ckpt) in ("params", "model.safetensors"):
    _ckpt = os.path.dirname(_ckpt)
_request["backend"] = "pytorch" if os.path.isfile(os.path.join(_ckpt, "model.safetensors")) else "jax"
_adapter = zlib.decompress(base64.b64decode(${JSON.stringify(packed(adapter))} if _request["backend"] == "jax" else ${JSON.stringify(packed(adapterTorch))})).decode()
_request["adapterSha256"] = hashlib.sha256(_adapter.encode()).hexdigest()
sys.exit(_namespace[${JSON.stringify(entry)}](_request, _worker, _adapter))
`;
}

export const runDiagnostic: DiagnosticRunner<DiagnosticRequest | AttentionVideoRequest> = async ({ host, request, signal }, onEvent) => {
  const lineLimit = ("mode" in request && request.mode === "video" ? maximumAttentionVideoBytes : maximumDiagnosticBytes) + 1024;
  const allowedHost = process.env["VLAEVAL_DIAGNOSTIC_HOST"] ?? "rtx6000@192.168.0.3";
  if (host !== allowedHost) {
    onEvent({ type: "error", status: "unsupported", message: `Diagnostics are enabled only on ${allowedHost}; selected run uses ${host}` });
    return;
  }
  const script = await diagnosticScript(request);
  // A cancellation before spawn cannot have left a remote process behind.
  if (signal.aborted) return;
  const command = `${openpiPythonSelector(request.repo, request.checkpoint)}exec env PYTHONDONTWRITEBYTECODE=1 XLA_PYTHON_CLIENT_PREALLOCATE=false "$py" -u -`;
  const child = Bun.spawn(sshCommand(host, command), {
    stdin: new Blob([script]), stdout: "pipe", stderr: "pipe",
  });
  let pid: number | null = null;
  let cancellation: Promise<void> | null = null;
  let reportedError = false;
  const errors: string[] = [];
  const terminate = () => {
    if (pid === null || cancellation) return;
    const remotePid = pid;
    cancellation = (async () => {
      // First use the standard worker cancellation path; always kill the isolated group too.
      let failure: unknown;
      try { await cancelRemote(host, remotePid); } catch (error) { failure = error; }
      const killer = Bun.spawn(sshCommand(host,
        `kill -KILL -- -${remotePid} 2>/dev/null || ! kill -0 -- -${remotePid} 2>/dev/null`), {
        stdin: "ignore", stdout: "ignore", stderr: "pipe",
      });
      const stderr = await new Response(killer.stderr).text();
      if (await killer.exited !== 0)
        throw new RemoteError(stderr || (failure instanceof Error ? failure.message : "Remote diagnostic termination failed"));
    })();
    // The promise is joined below, including when cancellation arrived during parsing.
    void cancellation.catch((error: unknown) => {
      errors.push(error instanceof Error ? error.message : String(error));
    });
  };
  const abort = () => terminate();
  signal.addEventListener("abort", abort, { once: true });
  try {
    await Promise.all([
      consumeLines(child.stdout, (line) => {
        if (!line.startsWith("VLAEVAL_DIAGNOSTIC ")) return;
        if (Buffer.byteLength(line) > lineLimit)
          throw new RemoteError("Diagnostic event exceeds byte limit");
        const event = diagnosticRunnerEventSchema.parse(JSON.parse(line.slice("VLAEVAL_DIAGNOSTIC ".length)));
        if (event.type === "error") reportedError = true;
        if (event.type === "started") {
          if (pid !== null && pid !== event.pid) throw new RemoteError("Diagnostic worker PID changed");
          pid = event.pid;
          if (signal.aborted) terminate();
        }
        onEvent(event);
      }),
      consumeLines(child.stderr, (line) => {
        errors.push(line.slice(0, 2000));
        if (errors.length > 20) errors.shift();
      }),
    ]);
    const code = await child.exited;
    if (cancellation) await cancellation;
    if (code !== 0 && !signal.aborted && !reportedError)
      throw new RemoteError(errors.join("\n") || `Diagnostic SSH exited with code ${code}`, code);
  } finally {
    signal.removeEventListener("abort", abort);
    // A parser failure must not orphan GPU work after closing the local SSH process.
    if (child.exitCode === null) terminate();
    try {
      if (cancellation) await cancellation;
    } finally {
      if (child.exitCode === null) child.kill();
      await child.exited;
    }
  }
};
