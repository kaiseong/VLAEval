import { afterEach, expect, spyOn, test } from "bun:test";
import * as remote from "../src/remote";
import {
  frameObservationSchema, maximumProjectionBytes, projectionScript, readProjectionFrame,
  projectionTimeoutMs,
} from "../src/projection-reader";
import type { FrameObservation } from "../src/projection-reader";

const request = { repo: "/repo's path", dataset: "/data", episode: 1, frame: 2,
  datasetKey: "observation.images.front" } as const;
const host = process.env["VLAEVAL_DIAGNOSTIC_HOST"] ?? "rtx6000@192.168.0.3";
const bytes = Buffer.from("fixture PNG payload");
const observation = {
  episode: 1, frame: 2, timestampSeconds: .2, fps: 10,
  image: { datasetKey: request.datasetKey, width: 4, height: 2, mime: "image/png",
    sha256: new Bun.CryptoHasher("sha256").update(bytes).digest("hex"), dataBase64: bytes.toString("base64") },
  vectors: { action: { names: ["a"], values: [12] } }, info: { features: {} },
} satisfies FrameObservation;
const restores: (() => void)[] = [];
afterEach(() => { for (const restore of restores.splice(0)) restore(); });

function localTransport(program: string) {
  const commands: string[] = [];
  const command = spyOn(remote, "sshCommand").mockImplementation((_host, command) => {
    commands.push(command);
    if (command.startsWith("kill ")) return ["sh", "-c", command];
    return ["python3", "-u", "-c", program];
  });
  restores.push(() => command.mockRestore());
  return commands;
}
const started = `import os, json, sys, signal
os.setpgid(0, 0)
print("VLAEVAL_PROJECTION " + json.dumps({"type":"started", "pid":os.getpid()}), flush=True)
`;
function emit(value: unknown) {
  return `print(${JSON.stringify(`VLAEVAL_PROJECTION ${JSON.stringify(value)}`)}, flush=True)\n`;
}

test("reads a validated selected frame through a local process transport", async () => {
  // Given
  const commands = localTransport(started + emit({ type: "result", observation }));
  // When
  const result = await readProjectionFrame(host, request, new AbortController().signal);
  // Then
  expect(result).toEqual(observation);
  expect(commands).toHaveLength(1);
  expect(commands[0]).toContain("CUDA_VISIBLE_DEVICES=''");
  expect(commands[0]).toContain(remote.quoteShell(`${request.repo}/.venv/bin/python`));
  expect(commands[0]).not.toContain(request.dataset);
});

test("rejects a different host and pre-aborted request without spawning SSH", async () => {
  // Given
  const commands = localTransport("raise AssertionError()");
  const controller = new AbortController();
  controller.abort();
  // When / Then
  await expect(readProjectionFrame("other-host", request, controller.signal)).rejects.toThrow("only on");
  await expect(readProjectionFrame(host, request, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
  expect(commands).toEqual([]);
});

test("compressed stdin bootstrap runs locally without importing model code", async () => {
  // Given
  const script = await projectionScript({ ...request, dataset: "/missing/projection-fixture" });
  // When
  const process = Bun.spawn(["python3", "-u", "-"], { stdin: new Blob([script]), stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([
    new Response(process.stdout).text(), new Response(process.stderr).text(), process.exited,
  ]);
  // Then
  expect(code).toBe(1);
  expect(err).toBe("");
  const events = out.trim().split("\n").map((line) => JSON.parse(line.slice("VLAEVAL_PROJECTION ".length)));
  expect(events.at(-1)).toMatchObject({ type: "error" });
  expect(events.at(-1).message).toContain("FileNotFoundError");
});

test.each([
  { ...observation, frame: 3 },
  { ...observation, image: { ...observation.image, sha256: "0".repeat(64) } },
])("rejects a mismatched response identity or image digest", async (invalid) => {
  // Given
  localTransport(started + emit({ type: "result", observation: invalid }));
  // When / Then
  await expect(readProjectionFrame(host, request, new AbortController().signal)).rejects.toThrow();
});

test("malformed output terminates the known remote process group", async () => {
  // Given
  const commands = localTransport(started + `print('VLAEVAL_PROJECTION {bad', flush=True)\nsignal.pause()\n`);
  // When / Then
  await expect(readProjectionFrame(host, request, new AbortController().signal)).rejects.toThrow();
  expect(commands.some((command) => command.startsWith("kill -KILL -- -"))).toBe(true);
});

test("stdout without a newline is bounded and terminates the worker", async () => {
  // Given
  localTransport(started + `sys.stdout.write("x" * ${maximumProjectionBytes + 1})\nsys.stdout.flush()\nsignal.pause()\n`);
  // When / Then
  await expect(readProjectionFrame(host, request, new AbortController().signal)).rejects.toThrow("byte limit");
});

test("abort arriving during spawn closes the local transport", async () => {
  // Given: abort happens after the reader's pre-spawn check, before PID delivery.
  const controller = new AbortController();
  const command = spyOn(remote, "sshCommand").mockImplementation(() => {
    controller.abort();
    return ["python3", "-c", "import signal; signal.pause()"];
  });
  restores.push(() => command.mockRestore());
  // When / Then
  await expect(readProjectionFrame(host, request, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
});

test("timeout closes a transport even before a PID is delivered", async () => {
  // Given: fire the actual registered deadline at the next microtask boundary.
  const timer = spyOn(globalThis, "setTimeout");
  const command = spyOn(remote, "sshCommand").mockImplementation(() => {
    queueMicrotask(() => {
      const deadline = timer.mock.calls.find(([, ms]) => ms === projectionTimeoutMs);
      if (!deadline || typeof deadline[0] !== "function") throw new Error("Missing projection deadline");
      deadline[0]();
    });
    return ["python3", "-c", "import signal; signal.pause()"];
  });
  restores.push(() => timer.mockRestore());
  restores.push(() => command.mockRestore());
  // When / Then
  await expect(readProjectionFrame(host, request, new AbortController().signal)).rejects.toThrow("timed out");
});

test("schema refuses mismatched feature names and nonfinite numeric vectors", () => {
  // Given / When / Then
  expect(frameObservationSchema.safeParse({ ...observation,
    vectors: { action: { names: ["a", "b"], values: [1] } } }).success).toBe(false);
  expect(frameObservationSchema.safeParse({ ...observation,
    vectors: { action: { names: null, values: [Infinity] } } }).success).toBe(false);
});
