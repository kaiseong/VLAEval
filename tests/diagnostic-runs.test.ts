import { afterEach, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApi } from "../src/api";
import { diagnosticRunStateSchema } from "../src/diagnostic-run-contracts";
import type { DiagnosticRunner, DiagnosticRunState } from "../src/diagnostic-run-contracts";
import { DiagnosticRunManager } from "../src/diagnostic-runs";
import { JobStore } from "../src/jobs";
import { diagnosticFixture } from "./diagnostic-fixture";

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0)) await fs.rm(directory, { recursive: true, force: true });
});
const anchor = { episode: 3, frame: 0 };

async function setup(evaluationRunner?: ConstructorParameters<typeof JobStore>[1]) {
  const { job, packet } = diagnosticFixture();
  const directory = await fs.mkdtemp(join(tmpdir(), "diagnostic-runs-"));
  directories.push(directory);
  await fs.writeFile(join(directory, `${job.id}.json`), JSON.stringify(job));
  const store = new JobStore(directory, evaluationRunner, undefined, true);
  await store.initialize();
  const entered = Promise.withResolvers<{
    execution: Parameters<DiagnosticRunner>[0]; emit: Parameters<DiagnosticRunner>[1];
  }>();
  const exited = Promise.withResolvers<void>();
  const runner: DiagnosticRunner = async (execution, emit) => {
    entered.resolve({ execution, emit });
    await exited.promise;
  };
  const manager = new DiagnosticRunManager(store, runner);
  const api = createApi(store, undefined, manager);
  const path = `/api/jobs/${job.id}/diagnostics/run`;
  const request = (suffix = "", method = "GET", body?: unknown) => api(new Request(
    `http://localhost:4310${path}${suffix}`, {
      method, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
  ));
  const state = async () => diagnosticRunStateSchema.parse(await (await request("?episode=3&frame=0")).json());
  return { job, packet, directory, store, manager, api, request, state, entered, exited };
}

function terminal(manager: DiagnosticRunManager, id: string): Promise<DiagnosticRunState> {
  const result = Promise.withResolvers<DiagnosticRunState>();
  const stop = manager.subscribe(id, anchor, (state) => {
    if (["completed", "failed", "blocked", "unsupported", "cancelled"].includes(state.status)) {
      stop();
      result.resolve(state);
    }
  });
  return result.promise;
}

test("attention recapture retains an already attached compatible projection", async () => {
  const h = await setup();
  const projection = h.packet.projection;
  await h.store.saveDiagnostic(h.job.id, { ...h.packet, attention: null });
  const ended = terminal(h.manager, h.job.id);
  h.manager.start(h.job.id, anchor);
  const { emit } = await h.entered.promise;
  emit({ type: "result", packet: { ...h.packet, projection: null } });
  h.exited.resolve();
  expect((await ended).status).toBe("completed");
  const saved = await h.store.getDiagnostic(h.job.id, 3, 0);
  expect(saved.projection).toEqual(projection);
  expect(saved.attention).toEqual(h.packet.attention);
});

async function sseState(reader: ReadableStreamDefaultReader<Uint8Array>) {
  const item = await reader.read();
  if (item.done) throw new Error("Unexpected end of diagnostic event stream");
  return diagnosticRunStateSchema.parse(JSON.parse(new TextDecoder().decode(item.value).slice(6).trim()));
}

test("routes emit initial and exact lifecycle states only after exit and publication", async () => {
  const h = await setup();
  Object.assign(h.store.get(h.job.id).request, {
    config: "stale-request", checkpoint: "/stale-checkpoint", dataset: "/stale-dataset", seed: 99, numSteps: 99,
  });
  const events = await h.request("/events?episode=3&frame=0");
  expect(events.headers.get("content-type")).toBe("text/event-stream");
  const reader = events.body?.getReader();
  if (!reader) throw new Error("Missing SSE body");
  expect((await sseState(reader)).status).toBe("idle");
  expect((await h.state()).runId).toBeNull();
  const response = await h.request("", "POST", anchor);
  expect(response.status).toBe(202);
  const initial = diagnosticRunStateSchema.parse(await response.json());
  expect(initial.status).toBe("preflight");
  expect(await sseState(reader)).toEqual(initial);
  const { execution, emit } = await h.entered.promise;
  expect(execution.request).toMatchObject({
    jobId: h.job.id, ...anchor, savedActionsScope: "chunk", minimumFreeMiB: 20480,
    savedActions: h.job.result?.samples[0]?.predicted, savedValid: h.job.result?.samples[0]?.valid,
    dataset: h.job.result?.dataset, config: h.job.result?.config, checkpoint: h.job.result?.checkpoint,
    seed: h.job.result?.seed, numSteps: h.job.result?.numSteps,
  });
  emit({ type: "started", pid: 123 });
  expect((await sseState(reader)).status).toBe("running");
  emit({ type: "progress", message: "extracting" });
  expect((await sseState(reader)).message).toBe("extracting");
  emit({ type: "progress", message: "extracting" }); // No duplicate update.
  emit({ type: "result", packet: h.packet });
  expect((await h.state()).status).toBe("running");
  expect(await fs.readdir(h.directory)).toEqual([`${h.job.id}.json`]);
  h.exited.resolve();
  expect((await sseState(reader)).status).toBe("completed");
  expect((await reader.read()).done).toBe(true);
  expect(await h.store.getDiagnostic(h.job.id, 3, 0)).toEqual(h.packet);
  expect(h.store.get(h.job.id).result).toEqual(h.job.result);
}, 5000);

test("cancellation remains cancelling and reserved until the runner confirms exit", async () => {
  const h = await setup();
  const response = await h.request("", "POST", anchor);
  const initial = diagnosticRunStateSchema.parse(await response.json());
  const { execution } = await h.entered.promise;
  const done = terminal(h.manager, h.job.id);
  const cancel = await h.request("/cancel", "POST", { runId: initial.runId });
  expect(diagnosticRunStateSchema.parse(await cancel.json()).status).toBe("cancelling");
  expect(execution.signal.aborted).toBe(true);
  await expect(h.store.start(h.job.request)).rejects.toMatchObject({ status: 409 });
  await expect(h.store.delete(h.job.id)).rejects.toMatchObject({ status: 409 });
  h.exited.resolve();
  expect((await done).status).toBe("cancelled");
  expect((await h.store.storage()).runs[0]?.deletable).toBe(true);
  expect((await h.request("/cancel", "POST", { runId: initial.runId })).status).toBe(200);
}, 5000);

test("diagnostic reservation rejects duplicate managers evaluation deletion and external publication", async () => {
  const h = await setup();
  await h.request("", "POST", anchor);
  await h.entered.promise;
  const done = terminal(h.manager, h.job.id);
  expect((await h.request("", "POST", anchor)).status).toBe(409);
  const sibling = new DiagnosticRunManager(h.store, async () => { throw new Error("Must not execute"); });
  expect(() => sibling.start(h.job.id, anchor)).toThrow();
  expect((await h.api(new Request(`http://localhost:4310/api/jobs`, {
    method: "POST", body: JSON.stringify(h.job.request),
  }))).status).toBe(409);
  expect((await h.api(new Request(`http://localhost:4310/api/jobs/${h.job.id}`, { method: "DELETE" }))).status).toBe(409);
  expect((await h.api(new Request(`http://localhost:4310/api/jobs/${h.job.id}/diagnostics?episode=3&frame=0`, {
    method: "PUT", body: JSON.stringify(h.packet),
  }))).status).toBe(409);
  h.exited.resolve();
  expect((await done).status).toBe("failed");
}, 5000);

test.each(["failed", "blocked", "unsupported"] as const)("releases the slot on worker %s without publishing", async (status) => {
  const h = await setup();
  await h.request("", "POST", anchor);
  const { emit } = await h.entered.promise;
  const done = terminal(h.manager, h.job.id);
  emit({ type: "error", status, message: "worker refusal" });
  expect((await h.store.storage()).runs[0]?.deletable).toBe(false);
  h.exited.resolve();
  expect((await done).status).toBe(status);
  expect((await h.store.storage()).runs[0]?.deletable).toBe(true);
  const nextRun = crypto.randomUUID();
  expect(h.store.acquireDiagnosticRun(h.job.id, 3, 0, nextRun).id).toBe(h.job.id);
  h.store.releaseDiagnosticRun(nextRun);
}, 5000);

test("releases reservation after runner rejection", async () => {
  const h = await setup();
  await h.request("", "POST", anchor);
  await h.entered.promise;
  const done = terminal(h.manager, h.job.id);
  h.exited.reject(new Error("SSH disconnected"));
  expect((await done).status).toBe("failed");
  expect((await h.store.storage()).runs[0]?.deletable).toBe(true);
}, 5000);

test("artifact persistence failure is terminal failed and releases the slot", async () => {
  const h = await setup();
  await h.request("", "POST", anchor);
  const { emit } = await h.entered.promise;
  const done = terminal(h.manager, h.job.id);
  emit({ type: "result", packet: h.packet });
  const failure = spyOn(h.store, "saveDiagnostic").mockRejectedValueOnce(new Error("disk full"));
  h.exited.resolve();
  expect((await done).status).toBe("failed");
  failure.mockRestore();
  expect((await h.state()).message).toContain("disk full");
  expect((await h.store.storage()).runs[0]?.deletable).toBe(true);
  expect(await fs.readdir(h.directory)).toEqual([`${h.job.id}.json`]);
}, 5000);

test("publication retains reservation until atomic artifact persistence completes", async () => {
  const h = await setup();
  const saving = Promise.withResolvers<void>(), persisted = Promise.withResolvers<void>();
  const original = h.store.saveDiagnostic.bind(h.store);
  const publication = spyOn(h.store, "saveDiagnostic").mockImplementation(async (id, packet, runId) => {
    saving.resolve();
    await persisted.promise;
    await original(id, packet, runId);
  });
  await h.request("", "POST", anchor);
  const { emit } = await h.entered.promise;
  const done = terminal(h.manager, h.job.id);
  emit({ type: "result", packet: h.packet });
  h.exited.resolve();
  await saving.promise;
  await expect(h.store.start(h.job.request)).rejects.toMatchObject({ status: 409 });
  await expect(h.store.delete(h.job.id)).rejects.toMatchObject({ status: 409 });
  expect((await h.state()).status).toBe("preflight");
  persisted.resolve();
  expect((await done).status).toBe("completed");
  publication.mockRestore();
}, 5000);

test("an active normal evaluation excludes diagnostics before runner entry", async () => {
  const evaluate = Promise.withResolvers<void>();
  const h = await setup(async () => { await evaluate.promise; });
  const job = await h.store.start(h.job.request);
  const finished = Promise.withResolvers<void>();
  const unsubscribe = h.store.subscribe(job.id, (state) => {
    if (state.status === "failed") finished.resolve();
  });
  expect((await h.request("", "POST", anchor)).status).toBe(409);
  evaluate.resolve();
  await finished.promise;
  unsubscribe();
  expect((await h.request("", "POST", anchor)).status).toBe(202);
  const done = terminal(h.manager, h.job.id);
  h.exited.resolve();
  await done;
}, 5000);

test("trace-only selection carries an explicit one-row comparison scope", async () => {
  const h = await setup();
  const stored = h.store.get(h.job.id);
  if (!stored.result) throw new Error("Missing result");
  stored.result.samples = [];
  await h.request("", "POST", anchor);
  const { execution } = await h.entered.promise;
  expect(execution.request.savedActionsScope).toBe("trace_row");
  const row = stored.result.traces[0]?.predicted[0];
  if (!row) throw new Error("Missing trace row");
  expect(execution.request.savedActions).toEqual([row]);
  expect(execution.request.savedValid).toEqual([true]);
  const done = terminal(h.manager, h.job.id);
  h.exited.resolve();
  await done;
}, 5000);

test("selected-frame identity mismatch cannot save a different packet", async () => {
  const h = await setup();
  await h.request("", "POST", anchor);
  const { emit } = await h.entered.promise;
  const done = terminal(h.manager, h.job.id);
  emit({ type: "result", packet: { ...h.packet, identity: { ...h.packet.identity, frame: 1 } } });
  h.exited.resolve();
  expect((await done).status).toBe("failed");
  expect(await fs.readdir(h.directory)).toEqual([`${h.job.id}.json`]);
}, 5000);

test("model query groups are independent of ground-truth validity", async () => {
  const h = await setup();
  const result = h.store.get(h.job.id).result;
  if (!result?.samples[0]) throw new Error("Missing chunk");
  result.samples[0].valid = [true, false, false, false];
  await expect(h.store.saveDiagnostic(h.job.id, h.packet)).resolves.toBeUndefined();
}, 5000);

test("pending external publication excludes diagnostic acquisition", async () => {
  const h = await setup();
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const rename = fs.rename;
  const publication = spyOn(fs, "rename").mockImplementation(async (from, to) => {
    entered.resolve();
    await release.promise;
    await rename(from, to);
  });
  const saving = h.store.saveDiagnostic(h.job.id, h.packet);
  await entered.promise;
  try {
    expect((await h.request("", "POST", anchor)).status).toBe(409);
  } finally {
    release.resolve();
    await saving;
    publication.mockRestore();
  }
}, 5000);

test("routes reject cross-origin requests and ambiguous or extra anchor input", async () => {
  const h = await setup();
  expect((await h.request("?episode=3&episode=3&frame=0")).status).toBe(400);
  expect((await h.request("", "POST", { ...anchor, checkpoint: "/override" })).status).toBe(400);
  expect((await h.api(new Request(`http://localhost:4310/api/jobs/${h.job.id}/diagnostics/run`, {
    method: "POST", body: JSON.stringify(anchor), headers: { origin: "https://foreign.example" },
  }))).status).toBe(403);
  expect((await h.state()).status).toBe("idle");
}, 5000);
