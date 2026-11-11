import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { JobStore } from "../src/jobs";
import { ProfileCatalog } from "../src/kinematics/catalog";
import { captureProjection } from "../src/projection-capture";
import { jimtofFrontCalibration } from "../src/projection-calibration";
import type { FrameObservation } from "../src/projection-reader";
import { diagnosticFixture, diagnosticTestImage } from "./diagnostic-fixture";

async function setup(dataset: string = jimtofFrontCalibration.bindings[0].dataset) {
  const directory = await mkdtemp(join(tmpdir(), "vlaeval-projection-"));
  const { job } = diagnosticFixture();
  if (!job.result) throw new Error("Result required");
  const names = ["right", "left"].flatMap((side) => Array.from({ length: 7 }, (_, i) => `${side}_arm_${i}`))
    .concat(["right_gripper_0", "left_gripper_0"]);
  job.result.dataset = dataset;
  job.request.dataset = job.result.dataset;
  job.result.actionNames = names;
  job.result.samples = [{ episode: 3, frame: 0, prompt: "fixture", predicted: [Array(16).fill(0)],
    target: [Array(16).fill(0)], valid: [true] }];
  job.result.traces = [{ episode: 3, frames: [0], predicted: [Array(16).fill(0)], target: [Array(16).fill(0)] }];
  await Bun.write(join(directory, `${job.id}.json`), JSON.stringify(job));
  const store = new JobStore(directory, undefined, undefined, true);
  await store.initialize();
  const bytes = diagnosticTestImage(640, 480);
  const observation: FrameObservation = { episode: 3, frame: 0, timestampSeconds: 0, fps: job.result.fps,
    image: { datasetKey: "observation.images.front", width: 640, height: 480, mime: "image/png",
      sha256: createHash("sha256").update(bytes).digest("hex"), dataBase64: bytes.toString("base64") },
    vectors: { action: { names, values: Array(16).fill(0) } }, info: {} };
  return { directory, job, store, observation, profiles: new ProfileCatalog() };
}

test.each([...jimtofFrontCalibration.bindings])("CPU projection attaches source-bound calibration for $label and preserves the saved evaluation", async (binding) => {
  const fixture = await setup(binding.dataset);
  const before = JSON.stringify(fixture.store.get(fixture.job.id));
  try {
    const packet = await captureProjection(fixture.store, fixture.profiles, fixture.job.id, { episode: 3, frame: 0 },
      new AbortController().signal, async () => fixture.observation);
    expect(packet.projection?.calibrationHash).toBe(jimtofFrontCalibration.recordSha256);
    expect(packet.projection?.poseEvidence.kind).toBe("declared_fixed");
    expect(packet.projection?.source.kind).toBe("joint");
    expect(packet.attention).toBeNull();
    expect(packet.provenance.backend).toBe("none");
    expect(packet.images[0]?.preprocessing).toBeNull();
    expect(JSON.stringify(fixture.store.get(fixture.job.id))).toBe(before);
    expect((await fixture.store.getDiagnostic(fixture.job.id, 3, 0)).projection).toEqual(packet.projection);
    expect((await fixture.store.storage()).runs[0]?.deletable).toBe(true);
  } finally { await rm(fixture.directory, { recursive: true, force: true }); }
});

test.each([
  jimtofFrontCalibration.bindings[1].dataset.replace("8d3534c7602129ffd18794425546df39fa98c0ab", "different-revision"),
  jimtofFrontCalibration.bindings[1].dataset.replace("JIMTOF_real_20261014_132034", "JIMTOF_unverified_robot"),
])("unbound source %s cannot execute the reader or publish", async (dataset) => {
  const fixture = await setup(dataset);
  let reads = 0;
  try {
    await expect(captureProjection(fixture.store, fixture.profiles, fixture.job.id, { episode: 3, frame: 0 },
      new AbortController().signal, async () => { reads++; return fixture.observation; })).rejects.toThrow();
    expect(reads).toBe(0);
    await expect(fixture.store.getDiagnostic(fixture.job.id, 3, 0)).rejects.toThrow();
    expect((await fixture.store.storage()).runs[0]?.deletable).toBe(true);
  } finally { await rm(fixture.directory, { recursive: true, force: true }); }
});

test("frame read owns publication and deletion until completed", async () => {
  const fixture = await setup(), entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  try {
    const pending = captureProjection(fixture.store, fixture.profiles, fixture.job.id, { episode: 3, frame: 0 },
      new AbortController().signal, async () => { entered.resolve(); await release.promise; return fixture.observation; });
    await entered.promise;
    expect((await fixture.store.storage()).runs[0]?.deletable).toBe(false);
    await expect(fixture.store.delete(fixture.job.id)).rejects.toThrow();
    release.resolve(); await pending;
    expect((await fixture.store.storage()).runs[0]?.deletable).toBe(true);
  } finally { release.resolve(); await rm(fixture.directory, { recursive: true, force: true }); }
});

test.each(["action", "dimensions", "abort", "frame"] as const)("rejects %s mismatch without publishing or retaining reservation", async (kind) => {
  const fixture = await setup(), controller = new AbortController();
  try {
    const reader = async () => {
      switch (kind) {
        case "action": fixture.observation.vectors["action"]?.values.fill(1); break;
        case "dimensions": fixture.observation.image.width = 800; break;
        case "frame": fixture.observation.frame = 1; break;
        case "abort": controller.abort(); break;
      }
      return fixture.observation;
    };
    await expect(captureProjection(fixture.store, fixture.profiles, fixture.job.id, { episode: 3, frame: 0 },
      controller.signal, reader)).rejects.toThrow();
    await expect(fixture.store.getDiagnostic(fixture.job.id, 3, 0)).rejects.toThrow();
    expect((await fixture.store.storage()).runs[0]?.deletable).toBe(true);
  } finally { await rm(fixture.directory, { recursive: true, force: true }); }
});
