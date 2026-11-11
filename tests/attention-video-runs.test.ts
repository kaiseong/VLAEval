import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApi } from "../src/api";
import { attentionVideoRunStateSchema, attentionVideoSchema } from "../src/attention-video-contracts";
import type { AttentionVideo, AttentionVideoRunState } from "../src/attention-video-contracts";
import { AttentionVideoRunManager } from "../src/attention-video-runs";
import { diagnosticRunnerEventSchema } from "../src/diagnostic-run-contracts";
import type { AttentionVideoRequest, DiagnosticRunner } from "../src/diagnostic-run-contracts";
import { DiagnosticRunManager } from "../src/diagnostic-runs";
import { diagnosticScript } from "../src/diagnostic-runner";
import { JobStore } from "../src/jobs";
import { diagnosticFixture } from "./diagnostic-fixture";

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0)) await fs.rm(directory, { recursive: true, force: true });
});

function f32(values: readonly number[]): string {
  const buffer = Buffer.alloc(values.length * 4);
  values.forEach((value, i) => buffer.writeFloatLE(value, i * 4));
  return buffer.toString("base64");
}

function videoFixture(identity: AttentionVideo["identity"]): AttentionVideo {
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);
  const frames = [0, 3, 6].map((frame) => ({
    frame, timestampSeconds: frame / 10,
    masses: [{ groupId: "camera:base_0_rgb", value: 0.6 }, { groupId: "instruction", value: 0.4 }],
    maps: [{ modelKey: "base_0_rgb", valuesF32LE: f32([0.3, 0.1, 0.1, 0.1]), letterboxMass: null }],
    images: [{ role: "front" as const, datasetKey: "observation.images.front", modelKey: "base_0_rgb",
      width: 4, height: 3, timestampSeconds: frame / 10, sha256: createHash("sha256").update(jpeg).digest("hex"),
      mime: "image/jpeg" as const, dataBase64: jpeg.toString("base64"), geometryResolved: false, preprocessing: null }],
  }));
  return attentionVideoSchema.parse({
    schemaVersion: 1, identity,
    provenance: { kind: "synthetic", adapterRevision: "1.2.0", adapterSchema: "vlaeval.attention_diagnostics/2", backend: "jax" },
    selection: { stepIndex: identity.numSteps - 1, layers: "all", queries: "all", stride: 3 },
    fps: 10, episodeLength: 8,
    keyGroups: [{ id: "camera:base_0_rgb", kind: "image", modelKey: "base_0_rgb" }, { id: "instruction", kind: "instruction" }],
    cameras: [{ role: "front", modelKey: "base_0_rgb", datasetKey: "observation.images.front",
      gridWidth: 2, gridHeight: 2, patchValidFraction: null }],
    frames, timing: { totalMs: 30, perFrameMs: 10, frames: 3 },
  });
}

async function setup(evaluationRunner?: ConstructorParameters<typeof JobStore>[1]) {
  const { job, packet } = diagnosticFixture();
  const result = job.result;
  if (!result) throw new Error("Fixture requires result");
  const directory = await fs.mkdtemp(join(tmpdir(), "attention-video-"));
  directories.push(directory);
  await fs.writeFile(join(directory, `${job.id}.json`), JSON.stringify(job));
  const store = new JobStore(directory, evaluationRunner, undefined, true);
  await store.initialize();
  const entered = Promise.withResolvers<{
    execution: Parameters<DiagnosticRunner<AttentionVideoRequest>>[0]; emit: Parameters<DiagnosticRunner>[1];
  }>();
  const exited = Promise.withResolvers<void>();
  const runner: DiagnosticRunner<AttentionVideoRequest> = async (execution, emit) => {
    entered.resolve({ execution, emit });
    await exited.promise;
  };
  const videos = new AttentionVideoRunManager(store, runner);
  const diagnostics = new DiagnosticRunManager(store, async () => { throw new Error("Must not execute"); });
  const api = createApi(store, undefined, diagnostics, videos);
  const base = `http://localhost:4310/api/jobs/${job.id}/attention-video`;
  const request = (suffix = "", method = "GET", body?: unknown) => api(new Request(`${base}${suffix}`, {
    method, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }));
  const video = videoFixture({ jobId: job.id, episode: 3, dataset: result.dataset, config: result.config,
    checkpoint: result.checkpoint, seed: result.seed, numSteps: result.numSteps });
  const path = join(directory, `${job.id}.attnvideo-3.json`);
  return { job, packet, directory, store, videos, api, request, video, path, entered, exited };
}

function terminal(manager: AttentionVideoRunManager, id: string): Promise<AttentionVideoRunState> {
  const result = Promise.withResolvers<AttentionVideoRunState>();
  const stop = manager.subscribe(id, 3, (state) => {
    if (["completed", "failed", "blocked", "unsupported", "cancelled"].includes(state.status)) {
      stop();
      result.resolve(state);
    }
  });
  return result.promise;
}

async function sseState(reader: ReadableStreamDefaultReader<Uint8Array>) {
  const item = await reader.read();
  if (item.done) throw new Error("Unexpected end of attention video event stream");
  return attentionVideoRunStateSchema.parse(JSON.parse(new TextDecoder().decode(item.value).slice(6).trim()));
}

test("video run streams lifecycle, publishes only after exit, and serves the artifact", async () => {
  const h = await setup();
  expect((await h.request("?episode=3")).status).toBe(404);
  const events = await h.request("/run/events?episode=3");
  expect(events.headers.get("content-type")).toBe("text/event-stream");
  const reader = events.body?.getReader();
  if (!reader) throw new Error("Missing SSE body");
  expect((await sseState(reader)).status).toBe("idle");
  const response = await h.request("/run", "POST", { episode: 3 });
  expect(response.status).toBe(202);
  const initial = attentionVideoRunStateSchema.parse(await response.json());
  expect(initial).toMatchObject({ episode: 3, status: "preflight" });
  expect(await sseState(reader)).toEqual(initial);
  const { execution, emit } = await h.entered.promise;
  expect(execution.request).toMatchObject({
    mode: "video", jobId: h.job.id, episode: 3, stride: 3, minimumFreeMiB: 20480,
    config: h.job.result?.config, numSteps: h.job.result?.numSteps,
  });
  emit({ type: "started", pid: 321 });
  expect((await sseState(reader)).status).toBe("running");
  emit({ type: "progress", status: "running", message: "attention video frame 10/20" });
  expect((await sseState(reader)).message).toBe("attention video frame 10/20");
  emit({ type: "video", video: h.video });
  expect(await fs.readdir(h.directory)).toEqual([`${h.job.id}.json`]);
  h.exited.resolve();
  expect((await sseState(reader)).status).toBe("completed");
  expect((await reader.read()).done).toBe(true);
  expect(attentionVideoSchema.parse(await (await h.request("?episode=3")).json())).toEqual(h.video);
  expect(attentionVideoRunStateSchema.parse(await (await h.request("/run?episode=3")).json()).status).toBe("completed");
}, 5000);

test("state query never starts work and rejects ambiguous episodes", async () => {
  const h = await setup();
  expect(attentionVideoRunStateSchema.parse(await (await h.request("/run?episode=3")).json()))
    .toMatchObject({ runId: null, status: "idle" });
  expect((await h.request("/run?episode=3&episode=4")).status).toBe(400);
  expect((await h.request("/run", "POST", { episode: 3, checkpoint: "/override" })).status).toBe(400);
  expect((await h.request("/run", "POST", { episode: 99 })).status).toBe(400);
  expect((await h.api(new Request(`http://localhost:4310/api/jobs/${h.job.id}/attention-video/run`, {
    method: "POST", body: JSON.stringify({ episode: 3 }), headers: { origin: "https://foreign.example" },
  }))).status).toBe(403);
  const probe = crypto.randomUUID();
  expect(h.store.acquireAttentionVideoRun(h.job.id, 3, probe).id).toBe(h.job.id);
  h.store.releaseDiagnosticRun(probe);
}, 5000);

test("video reservation excludes diagnostics, evaluation, deletion, publication and itself; cancel waits for exit", async () => {
  const h = await setup();
  const initial = attentionVideoRunStateSchema.parse(await (await h.request("/run", "POST", { episode: 3 })).json());
  const { execution } = await h.entered.promise;
  const done = terminal(h.videos, h.job.id);
  expect((await h.request("/run", "POST", { episode: 3 })).status).toBe(409);
  expect((await h.api(new Request(`http://localhost:4310/api/jobs/${h.job.id}/diagnostics/run`, {
    method: "POST", body: JSON.stringify({ episode: 3, frame: 0 }),
  }))).status).toBe(409);
  await expect(h.store.start(h.job.request)).rejects.toMatchObject({ status: 409 });
  await expect(h.store.delete(h.job.id)).rejects.toMatchObject({ status: 409 });
  await expect(h.store.saveDiagnostic(h.job.id, h.packet)).rejects.toMatchObject({ status: 409 });
  await expect(h.store.saveAttentionVideo(h.job.id, h.video)).rejects.toMatchObject({ status: 409 });
  const cancel = await h.request("/run/cancel", "POST", { runId: initial.runId });
  expect(attentionVideoRunStateSchema.parse(await cancel.json()).status).toBe("cancelling");
  expect(execution.signal.aborted).toBe(true);
  expect((await h.store.storage()).runs[0]?.deletable).toBe(false);
  h.exited.resolve();
  expect((await done).status).toBe("cancelled");
  expect((await h.store.storage()).runs[0]?.deletable).toBe(true);
  expect(await fs.readdir(h.directory)).toEqual([`${h.job.id}.json`]);
}, 5000);

test("an active selected-frame diagnostic excludes video acquisition", async () => {
  const h = await setup();
  const runId = crypto.randomUUID();
  h.store.acquireDiagnosticRun(h.job.id, 3, 0, runId);
  expect((await h.request("/run", "POST", { episode: 3 })).status).toBe(409);
  h.store.releaseDiagnosticRun(runId);
  expect((await h.request("/run", "POST", { episode: 3 })).status).toBe(202);
  const done = terminal(h.videos, h.job.id);
  h.exited.resolve();
  expect((await done).status).toBe("failed");
}, 5000);

test.each([
  ["identity", (video: AttentionVideo) => ({ ...video, identity: { ...video.identity, config: "other" } })],
  ["episode", (video: AttentionVideo) => ({ ...video, identity: { ...video.identity, episode: 4 } })],
] as const)("mismatched %s fails without publishing", async (_name, mutate) => {
  const h = await setup();
  await h.request("/run", "POST", { episode: 3 });
  const { emit } = await h.entered.promise;
  const done = terminal(h.videos, h.job.id);
  emit({ type: "video", video: mutate(h.video) });
  h.exited.resolve();
  expect((await done).status).toBe("failed");
  expect(await fs.readdir(h.directory)).toEqual([`${h.job.id}.json`]);
}, 5000);

test("worker refusal statuses release the slot", async () => {
  const h = await setup();
  await h.request("/run", "POST", { episode: 3 });
  const { emit } = await h.entered.promise;
  const done = terminal(h.videos, h.job.id);
  emit({ type: "error", status: "blocked", message: "GPU has 100 MiB free" });
  h.exited.resolve();
  expect(await done).toMatchObject({ status: "blocked", message: "GPU has 100 MiB free" });
  expect((await h.store.storage()).runs[0]?.deletable).toBe(true);
}, 5000);

test("schema rejects malformed frames, maps and letterbox semantics", () => {
  const { job } = diagnosticFixture();
  const video = videoFixture({ jobId: job.id, episode: 3, dataset: "/d", config: "c", checkpoint: "/k", seed: 0, numSteps: 2 });
  const [first, second, third] = video.frames;
  if (!first || !second || !third) throw new Error("Fixture requires frames");
  const invalid: unknown[] = [
    { ...video, frames: [second, first, third] },
    { ...video, episodeLength: 6 },
    { ...video, frames: [{ ...first, maps: [{ ...first.maps[0], valuesF32LE: f32([1.5, 0, 0, 0]) }] }, second, third] },
    { ...video, frames: [{ ...first, maps: [{ ...first.maps[0], valuesF32LE: f32([0.1, 0.1]) }] }, second, third] },
    { ...video, frames: [{ ...first, maps: [{ ...first.maps[0], letterboxMass: 0.1 }] }, second, third] },
    { ...video, frames: [{ ...first, masses: [{ groupId: "instruction", value: 1 }] }, second, third] },
    { ...video, selection: { ...video.selection, stepIndex: 0 } },
    { ...video, timing: { ...video.timing, frames: 2 } },
  ];
  for (const item of invalid) expect(attentionVideoSchema.safeParse(item).success).toBe(false);
  expect(diagnosticRunnerEventSchema.safeParse({ type: "video", video: invalid[0] }).success).toBe(false);
  expect(diagnosticRunnerEventSchema.parse({ type: "video", video }).type).toBe("video");
});

test("storage counts video artifacts, deletion removes them, and symlinks are refused", async () => {
  const h = await setup();
  const before = (await h.store.storage()).totalBytes;
  await h.store.saveAttentionVideo(h.job.id, h.video);
  const size = (await fs.stat(h.path)).size;
  expect((await h.store.storage()).totalBytes).toBe(before + size);
  await fs.unlink(h.path);
  await fs.writeFile(join(h.directory, "elsewhere.json"), "{}");
  await fs.symlink(join(h.directory, "elsewhere.json"), h.path);
  await expect(h.store.saveAttentionVideo(h.job.id, h.video)).rejects.toMatchObject({ status: 409 });
  expect((await h.request("?episode=3")).status).toBe(409);
  expect((await h.store.storage()).runs[0]).toMatchObject({ bytes: null, deletable: false });
  await expect(h.store.delete(h.job.id)).rejects.toMatchObject({ status: 409 });
  await fs.unlink(h.path);
  await h.store.saveAttentionVideo(h.job.id, h.video);
  await h.store.delete(h.job.id);
  expect((await fs.readdir(h.directory)).sort()).toEqual(["elsewhere.json"]);
}, 5000);

test("video script transport invokes runtime_video_main; selected-frame keeps runtime_main", async () => {
  const { job } = diagnosticFixture();
  const common = { jobId: job.id, episode: 3, repo: "/repo", dataset: "/d", config: "c", checkpoint: "/k", seed: 0,
    numSteps: 2, minimumFreeMiB: 20480 } as const;
  const video = await diagnosticScript({ ...common, mode: "video", stride: 3 });
  expect(video).toContain('sys.exit(_namespace["runtime_video_main"]');
  const frame = await diagnosticScript({ ...common, frame: 0, actionNames: [], savedActions: [],
    savedActionsScope: "chunk", savedValid: [] });
  expect(frame).toContain('sys.exit(_namespace["runtime_main"]');
});
