import { expect, test } from "bun:test";
import { FkController, type FkWorker } from "../../src/client/analysis/fk-controller";
import { fkRequestSchema, type FkRequest, type FkResult, type CompiledProfile } from "../../src/kinematics/contracts";
import { deriveForward } from "../../src/kinematics/forward";
import { buildFkWorkerAsset } from "../../src/kinematics/worker-asset";
import { fkIdentitySchema } from "../../src/kinematics/contracts";
import { unpackFkRequest, type FkCommand, type FkSelection } from "../../src/client/analysis/fk-protocol";
import { buildFkView, fkPoseSeries } from "../../src/client/analysis/fk-view";
import { fkJsonExport, fkCsvExport } from "../../src/client/analysis/exports";

function fixture(): FkRequest {
  const chain = (side: "right" | "left"): CompiledProfile["rightChain"] => [
    ...Array.from({ length: 7 }, (_, i): CompiledProfile["rightChain"][number] => ({
      name: `${side}_arm_${i}`, type: "revolute", axis: [0, 0, 1],
      parentLink: i === 0 ? "link_torso_5" : `link_${side}_arm_${i - 1}`,
      childLink: `link_${side}_arm_${i}`, origin: { xyz: [0, 0, 0], rpy: [0, 0, 0] },
    })),
    { name: `tool_${side}`, type: "fixed", parentLink: `link_${side}_arm_6`, childLink: `ee_${side}`,
      origin: { xyz: [0.1, 0, 0], rpy: [0, 0, 0] } },
  ];
  const actionNames = [
    ...Array.from({ length: 7 }, (_, i) => `right_arm_${i}`),
    ...Array.from({ length: 7 }, (_, i) => `left_arm_${i}`), "right_gripper_0", "left_gripper_0",
  ];
  return fkRequestSchema.parse({
    schemaVersion: 1, jobId: "c9a7752e-74ba-4052-9ec1-ecbc8306d975", episode: 4,
    profileHash: "a".repeat(64), generation: 12, jointUnit: "rad", representation: "absolute_joint_position",
    convention: { kind: "nominal_sign_zero", nominalSignZeroConfirmed: true, source: "user_declared" },
    profile: { schemaVersion: 1, profileHash: "a".repeat(64), sourcePath: "/synthetic.urdf",
      urdfSha256: "b".repeat(64), model: "synthetic", revision: "test", rootLink: "link_torso_5",
      tips: { right: "ee_right", left: "ee_left" }, rightChain: chain("right"), leftChain: chain("left") },
    actionNames, jointMapping: actionNames.slice(0, 14).map((name, sourceIndex) => ({
      jointName: name, channelName: name, sourceIndex,
    })),
    frames: [0, 3, 9].map((frame) => ({
      frame, predicted: [Math.PI / 2, ...Array(15).fill(0)], target: Array(16).fill(0),
    })),
  });
}

/** Captures deliveries before triggering them, including queued events after termination. */
class DeferredWorker implements FkWorker {
  onmessage: FkWorker["onmessage"] = null;
  onerror: FkWorker["onerror"] = null;
  onmessageerror: FkWorker["onmessageerror"] = null;
  request: FkRequest | null = null;
  selection: FkSelection | null = null;
  terminated = false;
  postMessage(input: FkCommand, transfer: Transferable[] = []): void {
    const command = structuredClone(input, { transfer });
    switch (command.kind) {
      case "derive": this.request = unpackFkRequest(command); this.selection = command.selection; break;
      case "export": {
        if (!this.request) throw new Error("Missing source");
        const input = { identity: command.identity, completed: this.result(),
          context: { profile: this.request.profile, sourceJobId: this.request.jobId, sourceEpisode: this.request.episode } };
        const artifact = command.format === "json" ? fkJsonExport(input) : fkCsvExport(input);
        if (!artifact) throw new Error("Missing export");
        this.onmessage?.(new MessageEvent("message", { data: structuredClone({ ...artifact,
          kind: "export", identity: command.identity, serial: command.serial, format: command.format,
          content: new Blob([artifact.content], { type: artifact.mediaType }) }) }));
        break;
      }
      case "view":
      case "point": throw new Error("Unexpected query in lifecycle fixture");
      default: { const exhaustive: never = command; throw exhaustive; }
    }
  }
  terminate(): void { this.terminated = true; }
  result(): FkResult {
    if (this.request === null) throw new Error("No posted request");
    return deriveForward(this.request);
  }
  reply(result = this.result()) {
    if (!this.selection) throw new Error("Missing selection");
    const { samples, ...metadata } = result;
    return { kind: "view", identity: fkIdentitySchema.parse(result), serial: 0,
      payload: JSON.stringify({ result: { ...metadata, frameCount: samples.length,
        firstFrame: samples[0]?.frame ?? null, lastFrame: samples.at(-1)?.frame ?? null },
      view: buildFkView(fkPoseSeries(result, 30), this.selection),
      selected: samples.find((sample) => sample.frame === this.selection?.sourceFrame) ?? null }) };
  }
  delivery() {
    const handler = this.onmessage;
    const signal = Promise.withResolvers<unknown>();
    const delivered = signal.promise.then((data) => handler?.(new MessageEvent("message", { data: structuredClone(data) })));
    return { release: signal.resolve, delivered };
  }
}

test("keeps B when held A completes after same-job same-episode replacement", async () => {
  // Given two pre-registered completion events and overlapping job/episode numbers.
  const a = new DeferredWorker(), b = new DeferredWorker();
  const workers = [a, b];
  const controller = new FkController(() => {}, () => {
    const worker = workers.shift();
    if (!worker) throw new Error("Unexpected Worker creation");
    return worker;
  });
  try {
    controller.start(fixture());
    const heldA = a.delivery();
    controller.start({ ...fixture(), jointUnit: "deg" });
    const finishB = b.delivery();
    expect(controller.exportResult).toBeNull();
    expect(a.terminated).toBe(true);
    expect([a.onmessage, a.onerror, a.onmessageerror]).toEqual([null, null, null]);
    // When B finishes before the already queued A callback is released.
    finishB.release(b.reply());
    await finishB.delivered;
    const completedB = controller.exportResult;
    heldA.release(a.reply());
    await heldA.delivered;
    // Then only the exact B identity and all original frames remain exportable.
    expect(controller.exportResult).toBe(completedB);
    expect(completedB?.jointUnit).toBe("deg");
    expect(completedB?.generation).not.toBe(a.request?.generation);
    expect(completedB?.frameCount).toBe(3);
    const exported = await controller.export("json");
    expect(JSON.parse(await exported?.content.text() ?? "null").source.frames).toEqual([0, 3, 9]);
    // The live generation now owns exact point queries and full exports until invalidated.
    expect(b.terminated).toBe(false);
  } finally { controller.dispose(); }
});

for (const mismatch of [
  { jobId: "00000000-0000-4000-8000-000000000006" }, { episode: 5 },
  { profileHash: "c".repeat(64) }, { jointUnit: "deg" }, { generation: 12 },
] as const) test(`ignores a completion with mismatched ${Object.keys(mismatch)[0]}`, async () => {
  // Given a pending selected derivation and a registered delivery.
  const worker = new DeferredWorker(), controller = new FkController(() => {}, () => worker);
  try {
    controller.start(fixture());
    const event = worker.delivery();
    // When a valid but unrelated identity arrives.
    event.release(worker.reply({ ...worker.result(), ...mismatch }));
    await event.delivered;
    // Then no derived export is available.
    expect(controller.state.status).toBe("pending");
    expect(controller.exportResult).toBeNull();
  } finally { controller.dispose(); }
});

for (const event of ["error", "messageerror", "invalidate", "dispose"] as const) {
  test(`invalidates exports and cleans handlers when ${event} occurs`, () => {
    // Given a completed result followed by a fresh pending selection.
    const worker = new DeferredWorker(), controller = new FkController(() => {}, () => worker);
    controller.start(fixture());
    worker.onmessage?.(new MessageEvent("message", { data: worker.reply() }));
    expect(controller.exportResult?.frameCount).toBe(3);
    controller.start(fixture());
    expect(controller.exportResult).toBeNull();
    // When computation fails or its owner terminates it.
    switch (event) {
      case "error": worker.onerror?.(new ErrorEvent("error", { message: "load failed" })); break;
      case "messageerror": worker.onmessageerror?.(new MessageEvent("messageerror")); break;
      case "invalidate": controller.invalidate(); break;
      case "dispose": controller.dispose(); break;
      default: { const exhaustive: never = event; throw exhaustive; }
    }
    // Then state and export remain unavailable, with no owned Worker handlers.
    expect(controller.state.status).toBe("unavailable");
    expect(controller.exportResult).toBeNull();
    expect(worker.terminated).toBe(true);
    expect([worker.onmessage, worker.onerror, worker.onmessageerror]).toEqual([null, null, null]);
    controller.dispose();
  });
}

test("rejects malformed result and incomplete source arrays without stale export", () => {
  // Given a fresh controller and a schema-valid derived fixture.
  const worker = new DeferredWorker(), controller = new FkController(() => {}, () => worker);
  try {
    controller.start(fixture());
    const result = worker.result();
    // When a result silently drops a source frame.
    worker.onmessage?.(new MessageEvent("message", { data: worker.reply({ ...result, samples: result.samples.slice(1) }) }));
    // Then it is unavailable instead of exporting partial data.
    expect(controller.state.status).toBe("unavailable");
    expect(controller.exportResult).toBeNull();
  } finally { controller.dispose(); }
});

test("invalidates a ready export before rejecting invalid new source admission", () => {
  // Given a completed, exportable derivation.
  const worker = new DeferredWorker(), controller = new FkController(() => {}, () => worker);
  controller.start(fixture());
  worker.onmessage?.(new MessageEvent("message", { data: worker.reply() }));
  expect(controller.exportResult).not.toBeNull();
  // When the selected profile no longer matches its digest.
  controller.start({ ...fixture(), profileHash: "c".repeat(64) });
  // Then admission leaves no stale result or export.
  expect(controller.state.status).toBe("unavailable");
  expect(controller.exportResult).toBeNull();
  controller.dispose();
});

test("reports construction failures as unavailable", () => {
  // Given a browser security boundary that rejects Worker construction.
  const controller = new FkController(() => {}, () => { throw new DOMException("blocked", "SecurityError"); });
  // When requesting a derivation.
  controller.start(fixture());
  // Then no pending or previous export survives.
  expect(controller.state.status).toBe("unavailable");
  expect(controller.exportResult).toBeNull();
  controller.dispose();
});

test("cleans the Worker when posting the request fails to clone", () => {
  // Given a Worker whose browser clone boundary rejects the request.
  const worker = new DeferredWorker();
  worker.postMessage = () => { throw new DOMException("uncloneable", "DataCloneError"); };
  const controller = new FkController(() => {}, () => worker);
  // When sending full raw data.
  controller.start(fixture());
  // Then no Worker, pending state or export survives.
  expect(controller.state.status).toBe("unavailable");
  expect(controller.exportResult).toBeNull();
  expect([worker.onmessage, worker.onerror, worker.onmessageerror]).toEqual([null, null, null]);
  expect(worker.terminated).toBe(true);
  controller.dispose();
});

test("does not create a Worker after the owner closes", () => {
  // Given a disposed owner with a factory that records accidental resurrection.
  let creations = 0;
  const controller = new FkController(() => {}, () => { creations++; return new DeferredWorker(); });
  controller.dispose();
  // When a late UI request attempts to restart computation.
  controller.start(fixture());
  // Then shutdown remains unavailable without allocating resources.
  expect(creations).toBe(0);
  expect(controller.state.status).toBe("unavailable");
  expect(controller.exportResult).toBeNull();
});

test("serves the actual browser build over an owned same-origin HTTP asset", async () => {
  // Given the exact production builder (no copied/injected Worker code).
  const asset = await buildFkWorkerAsset();
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    routes: { "/assets/fk.worker.js": () => new Response(asset, { headers: { "content-type": "text/javascript" } }) },
  });
  try {
    // When retrieving the production asset via HTTP.
    const response = await fetch(new URL("/assets/fk.worker.js", server.url));
    // Then bytes and MIME match the browser build.
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/javascript");
    expect(await response.arrayBuffer()).toEqual(await asset.arrayBuffer());
  } finally { server.stop(true); }
});
