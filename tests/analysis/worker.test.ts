import { expect, test } from "bun:test";
import { FkController, type FkWorker } from "../../src/client/analysis/fk-controller";
import { currentFkExport, fkJsonExport } from "../../src/client/analysis/exports";
import { fkIdentitySchema, fkRequestSchema } from "../../src/kinematics/contracts";
import { deriveForward } from "../../src/kinematics/forward";
import { buildFkView, fkPoseSeries } from "../../src/client/analysis/fk-view";
import { fkCommandSchema, fkReplySchema, fkWindowSchema, unpackFkRequest, type FkCommand, type FkReply } from "../../src/client/analysis/fk-protocol";
const fixturePath = "../fixtures/redesign/index.mjs";
const { fixtureSnapshot } = await import(fixturePath);
const fixture = () => fkRequestSchema.parse(fixtureSnapshot("fk-certified").fkRequest);

test("Worker view excludes out-of-window extremes at a fractional end", () => {
  // Given full source samples with a distinct final position outside the window.
  const result = deriveForward(fixture());
  result.samples.forEach((sample, index) => {
    sample.arms.right.pose.predicted.translationM = [index === 2 ? 0.1 : index / 1000, 0, 0];
    sample.arms.right.pose.target.translationM = [index === 2 ? 0.1 : index / 1000, 0, 0];
  });
  const selection = { sourceFrame: 1, window: { startFrame: 0, endFrame: 1.5 } };
  // When the Worker projects and samples that continuous frame window.
  const view = buildFkView(fkPoseSeries(result, 30), selection);
  const channel = view.channels.find((item) => item.side === "right" && item.axis === "X");
  // Then domain and vertices use only the original frames inside it.
  expect(channel?.domain).toEqual([0, 1]);
  expect(channel?.geometry.kind).toBe("ready");
  if (channel?.geometry.kind !== "ready") throw new Error("Expected bounded view");
  expect(channel.geometry.predicted.segments.flat().map((point) => point.frame)).toEqual([0, 1]);
  expect(view.window).toEqual(selection.window);
  expect(view.sourceFrame).toBe(1);
});

for (const window of [
  { startFrame: 0, endFrame: 1.5 }, { startFrame: 0.5, endFrame: 1.5 },
  { startFrame: -0.5, endFrame: 1.5 }, { startFrame: 0.5, endFrame: 0.5 },
]) test(`Worker protocol preserves finite ordered fractional window ${JSON.stringify(window)}`, () => {
  // Given finite ordered bounds accepted by the native window contract.
  const before = structuredClone(window);
  // When they cross the Worker protocol boundary.
  const parsed = fkWindowSchema.safeParse(window);
  // Then the exact bounds survive without integer or nonnegative narrowing.
  expect(parsed.success).toBe(true);
  if (!parsed.success) throw new Error("Valid continuous window rejected");
  expect(parsed.data).toEqual(before);
});

test("Worker protocol still rejects nonfinite or reversed windows", () => {
  // Given bounds outside the existing finite ordered contract.
  const windows = [{ startFrame: NaN, endFrame: 1.5 }, { startFrame: 0, endFrame: Infinity },
    { startFrame: 1.5, endFrame: 0.5 }];
  // When they cross the Worker protocol boundary.
  const admitted = windows.map((window) => fkWindowSchema.safeParse(window).success);
  // Then accepting fractional values has not relaxed finiteness or ordering.
  expect(admitted).toEqual([false, false, false]);
});

/** The browser boundary snapshots both directions, including retained old listeners. */
class WorkerPort implements FkWorker {
  onmessage: FkWorker["onmessage"] = null;
  onerror: FkWorker["onerror"] = null;
  onmessageerror: FkWorker["onmessageerror"] = null;
  command: FkCommand | null = null;
  terminated = false;
  postMessage(command: FkCommand, transfer: Transferable[] = []) {
    this.command = fkCommandSchema.parse(structuredClone(command, { transfer }));
  }
  terminate() { this.terminated = true; }
  completed() {
    if (this.command?.kind !== "derive") throw new Error("Expected derive command");
    const selection = this.command.selection;
    const result = deriveForward(unpackFkRequest(this.command));
    const { samples, ...metadata } = result;
    const display = { result: { ...metadata, frameCount: samples.length,
      firstFrame: samples[0]?.frame ?? null, lastFrame: samples.at(-1)?.frame ?? null },
      view: buildFkView(fkPoseSeries(result, 30), selection),
      selected: samples.find((sample) => sample.frame === selection.sourceFrame) ?? null };
    return { kind: "view", serial: 0, identity: fkIdentitySchema.parse(result), payload: JSON.stringify(display) } satisfies FkReply;
  }
  deliver(reply: unknown) { this.onmessage?.(new MessageEvent("message", { data: structuredClone(reply) })); }
}

test("fractional Worker windows preserve exact selected source points", () => {
  // Given an exact selected source frame inside finite fractional view bounds.
  const input = fixture(), worker = new WorkerPort();
  const source = input.frames[1];
  if (!source) throw new Error("Missing selected fixture frame");
  const controller = new FkController(() => {}, () => worker);
  const selection = { sourceFrame: 1, window: { startFrame: 0.5, endFrame: 1.5 } };
  try {
    // When the request and bounded reply cross real structured-clone boundaries.
    controller.start(input, selection);
    worker.deliver(worker.completed());
    // Then the view retains the fractional bounds and inspection retains the exact row.
    expect(controller.state.status).toBe("ready");
    if (controller.state.status !== "ready") throw new Error("Expected ready");
    expect(controller.state.view.window).toEqual(selection.window);
    expect(controller.state.result.frameCount).toBe(input.frames.length);
    expect(controller.state.selected?.frame).toBe(1);
    expect(controller.state.selected?.source).toEqual({
      predicted: source.predicted, target: source.target,
    });
  } finally { controller.dispose(); }
});

test("keeps immutable declaration and exact point snapshots when caller inputs mutate", () => {
  // Given a real structured-clone boundary and a submitted source.
  const worker = new WorkerPort(), controller = new FkController(() => {}, () => worker);
  const input = fixture(), original = structuredClone(input);
  controller.start(input);
  // When the caller mutates source and declaration after submission.
  input.profile.model = "mutated"; input.convention.source = "user_declared";
  input.frames[0]?.predicted.fill(999);
  worker.deliver(worker.completed());
  // Then the UI snapshot still belongs to the original source, and cannot be mutated.
  expect(controller.state.status).toBe("ready");
  if (controller.state.status !== "ready") throw new Error("Expected ready");
  expect(controller.state.result.profile.model).toBe(original.profile.model);
  expect(controller.state.selected?.source.predicted).toEqual(original.frames[0]?.predicted);
  expect(Object.isFrozen(controller.state.selected?.source.predicted)).toBe(true);
  expect(Object.isFrozen(controller.state.view.channels)).toBe(true);
  expect("samples" in controller.state.result).toBe(false);
  controller.dispose();
});

test("retained A cannot publish after invalid B admission rejects", () => {
  // Given a retained listener from A, before B is attempted.
  const worker = new WorkerPort(), controller = new FkController(() => {}, () => worker);
  controller.start(fixture());
  const listener = worker.onmessage, reply = worker.completed();
  // When B fails preflight and the old queued callback arrives.
  controller.start({ ...fixture(), profileHash: "c".repeat(64) });
  listener?.(new MessageEvent("message", { data: structuredClone(reply) }));
  // Then B's rejection cannot resurrect A's display or exports.
  expect(controller.state.status).toBe("unavailable");
  expect(controller.exportResult).toBeNull();
  expect(worker.terminated).toBe(true);
  controller.dispose();
});

for (const damage of ["count", "bounds", "channels", "point", "payload"] as const)
  test(`rejects partial or malformed bounded replies when ${damage} is corrupted`, () => {
    // Given a valid Worker-owned result and its compact display reply.
    const worker = new WorkerPort(), controller = new FkController(() => {}, () => worker);
    controller.start(fixture());
    const reply = worker.completed();
    const display = JSON.parse(reply.payload);
    // When the returned compact contract is damaged.
    switch (damage) {
      case "count": display.result.frameCount--; break;
      case "bounds": display.result.lastFrame++; break;
      case "channels": display.view.channels.pop(); break;
      case "point": display.selected.frame++; break;
      case "payload": reply.payload = " ".repeat(8 * 1024 * 1024 + 1); break;
      default: { const exhaustive: never = damage; throw exhaustive; }
    }
    worker.deliver(damage === "payload" ? reply : { ...reply, payload: JSON.stringify(display) });
    // Then no partial scientific result is represented as ready or exportable.
    expect(controller.state.status).toBe("unavailable");
    expect(controller.exportResult).toBeNull();
    controller.dispose();
  });

test("ignores obsolete points when a newer exact frame is selected", () => {
  // Given a completed result and a point query for frame 1.
  const worker = new WorkerPort(), controller = new FkController(() => {}, () => worker);
  const input = fixture(), result = deriveForward(input);
  controller.start(input); worker.deliver(worker.completed());
  controller.select({ sourceFrame: 1, window: { startFrame: 0, endFrame: 2 } });
  const first = worker.command;
  if (first?.kind !== "point") throw new Error("Expected point query");
  // When frame 2 is requested, then the retained frame 1 reply arrives.
  controller.select({ sourceFrame: 2, window: { startFrame: 0, endFrame: 2 } });
  worker.deliver({ kind: "point", identity: first.identity, serial: first.serial, sourceFrame: 1, payload: JSON.stringify(result.samples[1]) });
  // Then it cannot masquerade as the current exact point.
  expect(controller.state.status === "ready" && controller.state.selected?.frame).toBe(0);
  controller.dispose();
});

test("refuses a queued export when the owner invalidates before the consumer resumes", async () => {
  // Given a complete result and an export subscribed before delivery.
  const worker = new WorkerPort(), controller = new FkController(() => {}, () => worker);
  controller.start(fixture()); worker.deliver(worker.completed());
  const exported = currentFkExport(controller, "json"), command = worker.command;
  if (command?.kind !== "export") throw new Error("Expected export");
  // When a correctly identified Blob arrives immediately before invalidation.
  const mediaType = "application/json;charset=utf-8";
  worker.deliver({ kind: "export", identity: command.identity, serial: command.serial, format: "json",
    filename: `vlaeval-${command.identity.jobId}-ep${command.identity.episode}.fk.json`, mediaType,
    content: new Blob(["{}"], { type: mediaType }) });
  controller.invalidate();
  // Then the async consumer cannot download a previous generation.
  expect(await exported).toBeNull();
  controller.dispose();
});

test("keeps export identity current when a wrong generation replies first", async () => {
  // Given an export subscribed to the current completed generation.
  const worker = new WorkerPort(), controller = new FkController(() => {}, () => worker);
  controller.start(fixture()); worker.deliver(worker.completed());
  const exported = currentFkExport(controller, "json"), command = worker.command;
  if (command?.kind !== "export") throw new Error("Expected export");
  const mediaType = "application/json;charset=utf-8";
  const reply = { kind: "export", identity: command.identity, serial: command.serial, format: "json",
    filename: `vlaeval-${command.identity.jobId}-ep${command.identity.episode}.fk.json`, mediaType,
    content: new Blob(["current"], { type: mediaType }) };
  // When a stale response precedes the real response for the same serial.
  worker.deliver({ ...reply, identity: { ...command.identity, generation: command.identity.generation - 1 },
    content: new Blob(["stale"], { type: mediaType }) });
  worker.deliver(reply);
  // Then only current-generation bytes reach the consumer.
  expect(await (await exported)?.content.text()).toBe("current");
  controller.dispose();
});

test("resolves pending exports as unavailable when the Worker cannot decode a response", async () => {
  // Given a completed derivation with an outstanding export.
  const worker = new WorkerPort(), controller = new FkController(() => {}, () => worker);
  controller.start(fixture()); worker.deliver(worker.completed());
  const exported = currentFkExport(controller, "csv");
  // When the native transport reports messageerror.
  worker.onmessageerror?.(new MessageEvent("messageerror"));
  // Then the promise settles without stale data and the resource is terminated.
  expect(await exported).toBeNull();
  expect(worker.terminated).toBe(true);
  expect(controller.state.status).toBe("unavailable");
  controller.dispose();
});

test("retains all exported source rows when bounded geometry omits points", async () => {
  // Given 3000 exact source frames, not a display projection.
  const input = fixture(), source = input.frames[0];
  if (!source) throw new Error("Missing fixture source");
  input.frames = Array.from({ length: 3000 }, (_, frame) => ({ ...structuredClone(source), frame }));
  const worker = new WorkerPort(), controller = new FkController(() => {}, () => worker);
  controller.start(input);
  const reply = worker.completed();
  worker.deliver(reply);
  const result = deriveForward({ ...input, generation: reply.identity.generation });
  const artifact = fkJsonExport({ identity: reply.identity, completed: result,
    context: { profile: input.profile, sourceJobId: input.jobId, sourceEpisode: input.episode } });
  if (!artifact) throw new Error("Missing full export");
  // When the actual serializer's encoded full-source Blob is delivered.
  const exported = currentFkExport(controller, "json"), command = worker.command;
  if (command?.kind !== "export") throw new Error("Expected export");
  worker.deliver({ ...artifact, kind: "export", format: "json", identity: command.identity, serial: command.serial,
    content: new Blob([artifact.content], { type: artifact.mediaType }) });
  const download = await exported;
  // Then export source rows remain exact even though the rendered geometry is bounded.
  const document = JSON.parse(await download?.content.text() ?? "null");
  expect(document.samples.map((sample: { readonly source: unknown }) => sample.source)).toEqual(
    input.frames.map(({ predicted, target }) => ({ predicted, target })));
  expect(document.source.frames).toEqual(input.frames.map((sample) => sample.frame));
  expect(controller.state.status === "ready" && controller.state.view.channels.every(
    (channel) => channel.geometry.kind !== "ready" || channel.geometry.vertexCount <= 4096)).toBe(true);
  expect(fkReplySchema.safeParse({ ...reply, payload: 123 }).success).toBe(false);
  controller.dispose();
});
