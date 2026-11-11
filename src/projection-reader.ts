import { deflateSync } from "node:zlib";
import { z } from "zod";
import { quoteShell, RemoteError, sshCommand } from "./remote";

const numeric = z.number().finite();
export const projectionFrameRequestSchema = z.object({
  repo: z.string().startsWith("/").refine((s) => !s.includes("\0")),
  dataset: z.string().startsWith("/").refine((s) => !s.includes("\0")),
  episode: z.number().int().nonnegative().safe(),
  frame: z.number().int().nonnegative().safe(),
  datasetKey: z.literal("observation.images.front"),
}).strict();
export type ProjectionFrameRequest = z.infer<typeof projectionFrameRequestSchema>;

export const frameObservationSchema = z.object({
  episode: z.number().int().nonnegative().safe(),
  frame: z.number().int().nonnegative().safe(),
  timestampSeconds: numeric.nonnegative(),
  fps: numeric.positive(),
  image: z.object({
    datasetKey: z.literal("observation.images.front"),
    width: z.number().int().positive(), height: z.number().int().positive(),
    mime: z.literal("image/png"), sha256: z.string().regex(/^[a-f0-9]{64}$/),
    dataBase64: z.string().min(1),
  }).strict(),
  vectors: z.record(z.object({
    names: z.array(z.string()).nullable(), values: z.array(numeric),
  }).strict().refine((v) => v.names === null || v.names.length === v.values.length)),
  info: z.record(z.unknown()),
}).strict();
export type FrameObservation = z.infer<typeof frameObservationSchema>;
export const maximumProjectionBytes = 32 * 1024 * 1024;
export const projectionTimeoutMs = 60_000;
const prefix = "VLAEVAL_PROJECTION ";
const eventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("started"), pid: z.number().int().min(2).safe() }),
  z.object({ type: z.literal("result"), observation: frameObservationSchema }),
  z.object({ type: z.literal("error"), message: z.string() }),
]);

export async function projectionScript(request: ProjectionFrameRequest): Promise<string> {
  const sources = await Promise.all(["projection_worker.py", "worker.py"].map(
    (name) => Bun.file(new URL(`../${name}`, import.meta.url)).text(),
  ));
  const packed = sources.map((source) => deflateSync(Buffer.from(source)).toString("base64"));
  const payload = deflateSync(Buffer.from(JSON.stringify(request))).toString("base64");
  return `import os, signal, ctypes, base64, zlib, json, sys
if os.getpgrp() != os.getpid():
    os.setpgid(0, 0)
_parent = os.getppid()
if ctypes.CDLL(None).prctl(1, signal.SIGKILL, 0, 0, 0) != 0:
    raise RuntimeError("Cannot install projection parent-death signal")
if os.getppid() != _parent or _parent == 1:
    os.killpg(os.getpgrp(), signal.SIGKILL)
print(${JSON.stringify(prefix)} + json.dumps({"type": "started", "pid": os.getpid()}), flush=True)
_namespace = {"__name__": "vlaeval_projection"}
exec(compile(zlib.decompress(base64.b64decode(${JSON.stringify(packed[0])})), "projection_worker.py", "exec"), _namespace)
sys.exit(_namespace["runtime_main"](json.loads(zlib.decompress(base64.b64decode(${JSON.stringify(payload)}))), zlib.decompress(base64.b64decode(${JSON.stringify(packed[1])})).decode()))
`;
}

/** No remote reads occur until host/request validation and pre-abort checks pass. */
export async function readProjectionFrame(
  host: string, input: ProjectionFrameRequest, signal: AbortSignal,
): Promise<FrameObservation> {
  const allowed = process.env["VLAEVAL_DIAGNOSTIC_HOST"] ?? "rtx6000@192.168.0.3";
  if (host !== allowed) throw new RemoteError(`Projection reads are enabled only on ${allowed}`);
  const request = projectionFrameRequestSchema.parse(input);
  signal.throwIfAborted();
  const script = await projectionScript(request);
  signal.throwIfAborted();
  const command = `exec env PYTHONDONTWRITEBYTECODE=1 CUDA_VISIBLE_DEVICES='' HF_HUB_OFFLINE=1 HF_DATASETS_OFFLINE=1 ${quoteShell(`${request.repo}/.venv/bin/python`)} -u -`;
  const child = Bun.spawn(sshCommand(host, command), { stdin: new Blob([script]), stdout: "pipe", stderr: "pipe" });
  let pid: number | null = null;
  let cleanup: Promise<void> | null = null;
  let failure: Error | null = null;
  let observation: FrameObservation | null = null;
  let stderr = "";
  // This mutable state joins cleanup exactly once, even if abort precedes started.
  const terminate = () => {
    if (pid !== null && cleanup === null) {
      const killer = Bun.spawn(sshCommand(host,
        `kill -KILL -- -${pid} 2>/dev/null || ! kill -0 -- -${pid} 2>/dev/null`),
      { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
      const deadline = setTimeout(() => killer.kill(), 10_000);
      cleanup = killer.exited.then((code) => {
        clearTimeout(deadline);
        if (code !== 0) throw new RemoteError("Remote projection cleanup failed", code);
      });
      void cleanup.catch(() => { /* Joined in finally. */ });
    }
    // PDEATHSIG covers the interval before the started PID reaches this process.
    if (child.exitCode === null) child.kill();
  };
  const abort = () => { failure = new DOMException("Projection read aborted", "AbortError"); terminate(); };
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();
  const timer = setTimeout(() => {
    failure = new RemoteError("Projection read timed out"); terminate();
  }, projectionTimeoutMs);
  async function consume(stream: ReadableStream<Uint8Array>, limit: number, onLine: (line: string) => void) {
    const reader = stream.getReader();
    let total = 0;
    let pending = "";
    const decoder = new TextDecoder();
    try {
      while (true) {
        const item = await reader.read();
        if (item.done) break;
        total += item.value.byteLength;
        if (total > limit) throw new RemoteError("Projection output exceeds byte limit");
        pending += decoder.decode(item.value, { stream: true });
        let newline: number;
        while ((newline = pending.indexOf("\n")) >= 0) {
          onLine(pending.slice(0, newline));
          pending = pending.slice(newline + 1);
        }
      }
      pending += decoder.decode();
      if (pending) onLine(pending);
    } finally { reader.releaseLock(); }
  }
  try {
    await Promise.all([
      consume(child.stdout, maximumProjectionBytes, (line) => {
        if (!line.startsWith(prefix)) return;
        const event = eventSchema.parse(JSON.parse(line.slice(prefix.length)));
        switch (event.type) {
          case "started":
            if (pid !== null && pid !== event.pid) throw new RemoteError("Projection PID changed");
            pid = event.pid;
            if (failure) terminate();
            break;
          case "error": throw new RemoteError(event.message);
          case "result":
            if (observation) throw new RemoteError("Duplicate projection result");
            observation = event.observation;
            break;
        }
      }),
      consume(child.stderr, 64 * 1024, (line) => { stderr = (stderr + line + "\n").slice(-4000); }),
    ]);
    const code = await child.exited;
    if (failure) throw failure;
    if (code !== 0) throw new RemoteError(stderr || "Projection SSH failed", code);
    if (!observation) throw new RemoteError("Projection worker returned no frame");
    const result: FrameObservation = observation;
    if (result.episode !== request.episode || result.frame !== request.frame)
      throw new RemoteError("Projection response does not match selected frame");
    const bytes = Buffer.from(result.image.dataBase64, "base64");
    if (new Bun.CryptoHasher("sha256").update(bytes).digest("hex") !== result.image.sha256)
      throw new RemoteError("Projection image SHA256 mismatch");
    return result;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", abort);
    if (child.exitCode === null) terminate();
    try { if (cleanup) await cleanup; }
    finally { if (child.exitCode === null) child.kill(); await child.exited; }
  }
}
