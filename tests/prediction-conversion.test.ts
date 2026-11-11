import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { derivePrediction } from "../src/client/analysis/prediction";
import { predictionRequestSchema, predictionResultSchema, type PredictionRequest } from "../src/client/analysis/prediction-contracts";
import { fkRequestSchema, type CompiledProfile } from "../src/kinematics/contracts";
import { deriveForward, forwardChain } from "../src/kinematics/forward";
import { solveInverse } from "../src/kinematics/inverse";
import { originTransform, poseFromTransform, rotationError, type Pose } from "../src/kinematics/math";
import { buildPredictionWorkerAsset } from "../src/kinematics/worker-asset";

function profile(): CompiledProfile {
  const chain = (side: "left" | "right"): CompiledProfile["leftChain"] => [
    ...Array.from({ length: 7 }, (_, i): CompiledProfile["leftChain"][number] => ({
      name: `${side}_arm_${i}`, type: "revolute", axis: [0, 0, 1], limit: { lower: -2, upper: 2 },
      parentLink: i === 0 ? "link_torso_5" : `link_${side}_arm_${i - 1}`,
      childLink: `link_${side}_arm_${i}`, origin: { xyz: [0, 0, 0], rpy: [0, 0, 0] },
    })),
    { name: `tool_${side}`, type: "fixed", parentLink: `link_${side}_arm_6`, childLink: `ee_${side}`,
      origin: { xyz: side === "left" ? [0.2, 0, 0.1] : [0.3, 0, -0.1], rpy: [0, 0, 0] } },
  ];
  return { schemaVersion: 1, profileHash: "a".repeat(64), sourcePath: "synthetic", model: "synthetic",
    revision: "test", urdfSha256: "b".repeat(64), rootLink: "link_torso_5",
    tips: { left: "ee_left", right: "ee_right" }, leftChain: chain("left"), rightChain: chain("right") };
}

function jointInput(): PredictionRequest {
  const row = Array.from({ length: 16 }, (_, i) => i / 100);
  return predictionRequestSchema.parse({
    actionNames: row.map((_, i) => `arbitrary_${i}`), profile: profile(), seed: null,
    source: { kind: "joint", unit: "rad", representation: "absolute", nominalSignZeroConfirmed: true,
      left: { joints: [15, 1, 13, 3, 11, 5, 9], gripper: 7 },
      right: { joints: [0, 14, 2, 12, 4, 10, 6], gripper: 8 } },
    series: { frames: [10], predicted: [row], target: [row.map((v) => -v)], fps: 30 },
    chunks: [{ frame: 10, predicted: [row, row], target: [row, row], valid: [true, false] }],
  });
}

function cartesianInput(quaternion = false): PredictionRequest {
  const model = profile();
  const pose = (side: "left" | "right", angle: number) =>
    forwardChain(model[`${side}Chain`], new Map(Array.from({ length: 7 }, (_, i) => [`${side}_arm_${i}`, angle])));
  const row = (angle: number) => (["left", "right"] as const).flatMap((side) => {
    const p = pose(side, side === "left" ? angle : -angle);
    return [...p.translationM, ...(quaternion ? p.quaternionXyzw : p.rpyDeg.map((v) => (v ?? NaN) * Math.PI / 180)),
      side === "left" ? 41 : 82];
  });
  const width = quaternion ? 8 : 7, first = row(0.04), second = row(0.06);
  return predictionRequestSchema.parse({
    actionNames: first.map((_, i) => `column_${i}`), profile: model,
    seed: { kind: "manual", unit: "rad", positions: Array.from({ length: 14 }, (_, i) => i < 7 ? 0.02 : -0.02) },
    source: { kind: "cartesian", positionUnit: "m",
      orientation: quaternion ? { kind: "quaternion_xyzw" } : { kind: "rpy_xyz", unit: "rad" },
      referenceFrame: "link_torso_5", representation: "absolute", nominalSignZeroConfirmed: true,
      left: { position: [0, 1, 2], rotation: quaternion ? [3, 4, 5, 6] : [3, 4, 5], gripper: width - 1 },
      right: { position: [width, width + 1, width + 2],
        rotation: quaternion ? [width + 3, width + 4, width + 5, width + 6] : [width + 3, width + 4, width + 5],
        gripper: 2 * width - 1 } },
    series: { frames: [10, 11], predicted: [first, second], target: [first, second], fps: 29.97 },
    chunks: [{ frame: 10, predicted: [first, second], target: [first, second], valid: [true, true] }],
  });
}

function rowAt(rows: readonly (number | null)[][] | undefined, index = 0) {
  const row = rows?.[index];
  if (row === undefined) throw new Error("Missing expected output row");
  return row;
}

function valueAt(row: readonly number[], index: number): number {
  const value = row[index];
  if (value === undefined) throw new Error("Missing expected fixture value");
  return value;
}

function solvedPose(model: CompiledProfile, side: "left" | "right", row: readonly (number | null)[]): Pose {
  const start = side === "left" ? 0 : 8;
  return forwardChain(model[`${side}Chain`], new Map(Array.from({ length: 7 }, (_, i): [string, number] => {
    const value = row[start + i];
    if (value === null || value === undefined) throw new Error("Expected successful solution");
    return [`${side}_arm_${i}`, value];
  })));
}

describe("prediction normalization and conversion", () => {
  test("manual-seeded first-step predictions carry the same continuity as one chunk", () => {
    const input = cartesianInput();
    const output = derivePrediction(input);
    expect(output.joint?.series.predicted).toEqual(output.joint?.chunks[0]?.predicted);
  });
  test("native Cartesian RPY preserves winding and explicitly recorded singular components", () => {
    const input = cartesianInput();
    if (input.source.kind !== "cartesian") throw new Error("Cartesian fixture required");
    input.profile = null;
    input.source.orientation = { kind: "rpy_xyz", unit: "deg" };
    const row = input.series.predicted[0];
    if (!row) throw new Error("Missing fixture row");
    row[3] = 37; row[4] = 90; row[5] = 370;
    const original = structuredClone(input);
    const output = derivePrediction(input);
    expect(output.cartesian?.series.predicted[0]?.slice(3, 6)).toEqual([37, 90, 370]);
    expect(input).toEqual(original);
  });
  for (const unit of ["rad", "deg", "unknown"] as const) test(`keeps ${unit} joint values in explicit canonical order without a model`, () => {
    // Given arbitrary mapped columns and absent grippers/model.
    const input = jointInput();
    if (input.source.kind !== "joint") throw new Error("Joint fixture required");
    input.source.unit = unit;
    input.source.left.gripper = null;
    input.profile = null;
    const before = structuredClone(input), raw = input.series.predicted[0];
    if (raw === undefined) throw new Error("Missing fixture row");
    // When admitted without conversion settings.
    const output = derivePrediction(input);
    // Then native values and frame/mask identity survive without unit inference.
    expect(rowAt(output.joint?.series.predicted)).toEqual([
      ...input.source.left.joints.map((i) => valueAt(raw, i)), null,
      ...input.source.right.joints.map((i) => valueAt(raw, i)), valueAt(raw, 8),
    ]);
    expect(output.joint?.series.frames).toEqual([10]);
    expect(output.joint?.chunks[0]?.valid).toEqual([true, false]);
    expect(output.cartesian).toBeNull();
    expect(output.unavailable.cartesian).not.toBeNull();
    expect(output.provenance.joint).toBe("source");
    expect(input).toEqual(before);
  });

  test("matches trusted deriveForward with arbitrary mapping and degree conversion", () => {
    // Given explicitly mapped degree joints and native grippers.
    const input = jointInput();
    if (input.source.kind !== "joint" || input.profile === null) throw new Error("Joint profile fixture required");
    input.source.unit = "deg";
    const source = input.source;
    const names = Array<string>(16).fill("");
    for (const side of ["left", "right"] as const) {
      source[side].joints.forEach((index, i) => { names[index] = `${side}_arm_${i}`; });
      const index = source[side].gripper;
      if (index !== null) names[index] = `${side}_gripper_0`;
    }
    const trusted = deriveForward(fkRequestSchema.parse({
      schemaVersion: 1, jobId: "c9a7752e-74ba-4052-9ec1-ecbc8306d975", episode: 0, generation: 0,
      profileHash: input.profile.profileHash, profile: input.profile, jointUnit: "deg",
      representation: "absolute_joint_position",
      convention: { kind: "nominal_sign_zero", nominalSignZeroConfirmed: true, source: "user_declared" },
      actionNames: names,
      jointMapping: (["left", "right"] as const).flatMap((side) => source[side].joints.map((sourceIndex, i) => ({
        jointName: `${side}_arm_${i}`, channelName: `${side}_arm_${i}`, sourceIndex,
      }))),
      frames: [{ frame: 10, predicted: input.series.predicted[0], target: input.series.target[0] }],
    }));
    // When converting source joints through trusted FK.
    const output = derivePrediction(input);
    // Then mm/RPY and native grippers exactly match the independent trusted derive.
    for (const stream of ["predicted", "target"] as const) {
      const sample = trusted.samples[0];
      if (sample === undefined) throw new Error("Missing trusted sample");
      expect(rowAt(output.cartesian?.series[stream])).toEqual((["left", "right"] as const).flatMap((side) => {
        const pose = sample.arms[side].pose[stream], index = source[side].gripper;
        return [...(pose.translationM ?? []).map((v) => v * 1000), ...pose.rpyDeg,
          index === null ? null : valueAt(sample.source[stream], index)];
      }));
    }
    expect(rowAt(output.cartesian?.chunks[0]?.predicted, 1)).toEqual([...Array(6).fill(null), 0.07, ...Array(6).fill(null), 0.08]);
    expect(output.provenance.cartesian).toBe("fk");
  });

  for (const gate of ["unknown_unit", "delta", "unconfirmed"] as const) test(`blocks cross-space conversion for ${gate}`, () => {
    // Given a joint request missing one explicit conversion declaration.
    const input = jointInput();
    if (input.source.kind !== "joint") throw new Error("Joint fixture required");
    switch (gate) {
      case "unknown_unit": input.source.unit = "unknown"; break;
      case "delta": input.source.representation = "delta"; break;
      case "unconfirmed": input.source.nominalSignZeroConfirmed = false; break;
    }
    // When converting.
    const output = derivePrediction(input);
    // Then source remains available and FK does not run.
    expect(output.joint).not.toBeNull();
    expect(output.cartesian).toBeNull();
    expect(output.unavailable.cartesian).not.toBeNull();
  });

  for (const quaternion of [false, true]) test(`normalizes ${quaternion ? "quaternion" : "RPY"} Cartesian source without profile or seed`, () => {
    // Given known poses in m and rad or xyzw, independently of model admission.
    const input = cartesianInput(quaternion);
    input.profile = null; input.seed = null;
    const before = structuredClone(input);
    // When normalizing raw Cartesian rows.
    const output = derivePrediction(input);
    // Then canonical mm and fixed XYZ RPY degrees are visible with native grippers.
    const row = rowAt(output.cartesian?.series.predicted);
    expect(row[0]).toBeCloseTo(200 * Math.cos(0.28), 9);
    expect(row[1]).toBeCloseTo(200 * Math.sin(0.28), 9);
    expect(row[2]).toBeCloseTo(100, 9);
    expect(row[5]).toBeCloseTo(0.28 * 180 / Math.PI, 9);
    expect(row[6]).toBe(41); expect(row[13]).toBe(82);
    expect(output.joint).toBeNull();
    expect(output.provenance.cartesian).toBe("source");
    expect(input).toEqual(before);
  });

  test("normalizes declared mm/degree RPY with arbitrary Cartesian columns", () => {
    // Given a permuted mm/degree source.
    const input = cartesianInput();
    if (input.source.kind !== "cartesian") throw new Error("Cartesian fixture required");
    input.source.positionUnit = "mm";
    input.source.orientation = { kind: "rpy_xyz", unit: "deg" };
    input.source.left = { position: [13, 12, 11], rotation: [10, 9, 8], gripper: 7 };
    input.source.right = { position: [6, 5, 4], rotation: [3, 2, 1], gripper: null };
    const row = [999, 60, 20, 10, 300, 200, 100, 77, 30, -20, -10, 600, 500, 400];
    input.series = { frames: [42], fps: 25, predicted: [row], target: [row] };
    input.chunks = [];
    input.profile = null;
    // When converting declared units and mappings.
    const output = derivePrediction(input);
    // Then positions, rotations and absent gripper follow mapped source semantics.
    const result = rowAt(output.cartesian?.series.predicted);
    expect(result.slice(0, 3)).toEqual([400, 500, 600]);
    expect(result[3]).toBeCloseTo(-10, 10); expect(result[4]).toBeCloseTo(-20, 10);
    expect(result[5]).toBeCloseTo(30, 10); expect(result[6]).toBe(77);
    expect(result[13]).toBeNull();
  });

  test("keeps invalid quaternion and overflowing translation null with aggregated issues", () => {
    // Given finite but invalid quaternion and mm-overflowing source positions.
    const input = cartesianInput(true);
    const row = input.series.predicted[0];
    if (row === undefined) throw new Error("Missing fixture row");
    row[0] = 1e308;
    row.splice(3, 4, 0, 0, 0, 0);
    input.series.predicted[1] = [...row];
    input.profile = null;
    // When normalizing without repairing invalid components.
    const output = derivePrediction(input);
    // Then valid components survive and failures are nullable, not zero-filled.
    const result = rowAt(output.cartesian?.series.predicted);
    expect(result[0]).toBeNull();
    expect(result.slice(3, 6)).toEqual([null, null, null]);
    expect(result[2]).toBe(100);
    expect(result[6]).toBe(41);
    expect(output.issues).toContainEqual({ reason: "invalid_rotation", count: 2 });
    expect(output.issues).toContainEqual({ reason: "nonfinite_component", count: 2 });
    expect(new Set(output.issues.map((item) => item.reason)).size).toBe(output.issues.length);
  });

  test("keeps undefined quaternion-derived RPY components null", () => {
    // Given a quaternion at the RPY pitch singularity without a model.
    const input = cartesianInput(true);
    const row = input.series.predicted[0];
    if (row === undefined) throw new Error("Missing fixture row");
    row.splice(3, 4, 0, Math.SQRT1_2, 0, Math.SQRT1_2);
    input.profile = null;
    // When decomposing the quaternion into fixed XYZ RPY.
    const output = derivePrediction(input);
    // Then ambiguous roll/yaw stay null rather than zero.
    const displayed = rowAt(output.cartesian?.series.predicted);
    expect(displayed[3]).toBeNull();
    expect(displayed[4]).toBeCloseTo(90, 10);
    expect(displayed[5]).toBeNull();
    expect(output.issues.some((item) => item.count > 0)).toBe(true);
  });

  test("solves reachable Cartesian inputs with manual degrees and independent FK residuals", () => {
    // Given explicit nonzero manual seeds, reachable quaternion poses and mask gaps.
    const input = cartesianInput(true);
    if (input.seed?.kind !== "manual" || input.profile === null) throw new Error("Manual profile fixture required");
    input.seed.positions = input.seed.positions.map((v) => v * 180 / Math.PI);
    input.seed.unit = "deg";
    const before = structuredClone(input);
    // When deriving IK.
    const output = derivePrediction(input);
    // Then solutions are radians and satisfy independent FK, with no joint-vector identity assumption.
    const row = rowAt(output.joint?.series.predicted);
    for (const side of ["left", "right"] as const) {
      const actual = solvedPose(input.profile, side, row), offset = side === "left" ? 0 : 8;
      const raw = input.series.predicted[0];
      if (raw === undefined) throw new Error("Missing fixture row");
      const goal = raw.slice(offset, offset + 3);
      expect(Math.hypot(...actual.translationM.map((v, i) => v - (goal[i] ?? NaN)))).toBeLessThanOrEqual(1e-4);
      const [x, y, z, w] = raw.slice(offset + 3, offset + 7);
      if (x === undefined || y === undefined || z === undefined || w === undefined) throw new Error("Missing quaternion");
      expect(rotationError(actual.quaternionXyzw, [x, y, z, w])).toBeLessThanOrEqual(1e-3);
    }
    expect(output.provenance.joint).toBe("ik");
    expect(row[7]).toBe(41); expect(row[15]).toBe(82);
    expect(input).toEqual(before);
  });

  for (const condition of ["missing_seed", "wrong_frame", "missing_limits", "invalid_seed", "unreachable", "invalid_orientation"] as const) {
    test(`returns no fabricated joint solution for ${condition}`, () => {
      // Given a Cartesian request with the named unavailable condition.
      const input = cartesianInput(true);
      if (input.profile === null || input.seed?.kind !== "manual" || input.source.kind !== "cartesian")
        throw new Error("Cartesian profile fixture required");
      switch (condition) {
        case "missing_seed": input.seed = null; break;
        case "wrong_frame": input.source.referenceFrame = "world"; break;
        case "missing_limits":
          input.profile.leftChain = input.profile.leftChain.map((joint) => {
            if (joint.type === "fixed") return joint;
            const { limit: _limit, ...withoutLimit } = joint;
            return withoutLimit;
          });
          break;
        case "invalid_seed": input.seed.positions[0] = 3; break;
        case "unreachable": {
          const row = input.series.predicted[0];
          if (row === undefined) throw new Error("Missing fixture row");
          row[0] = 10;
          break;
        }
        case "invalid_orientation": {
          const row = input.series.predicted[0];
          if (row === undefined) throw new Error("Missing fixture row");
          row.splice(3, 4, 0, 0, 0, 0);
          break;
        }
      }
      // When attempting conversion.
      const output = derivePrediction(input);
      // Then native Cartesian and grippers survive, but unavailable joints never become zeros.
      expect(output.cartesian).not.toBeNull();
      if (condition === "missing_seed" || condition === "wrong_frame") {
        expect(output.joint).toBeNull(); expect(output.unavailable.joint).not.toBeNull();
      } else {
        const row = rowAt(output.joint?.series.predicted);
        expect(row.slice(0, 7)).toEqual(Array(7).fill(null));
        expect(row[7]).toBe(41);
        expect(row.slice(8, 15).every((v) => typeof v === "number")).toBe(true);
        expect(output.issues.length).toBeGreaterThan(0);
      }
    });
  }

  test("isolates prediction anchors and streams while reusing chronological overlapping GT", () => {
    // Given one observed anchor, an unseeded next anchor, overlapping conflicting chunk GT and scored GT.
    const input = cartesianInput();
    if (input.seed?.kind !== "manual" || input.profile === null) throw new Error("Manual profile fixture required");
    const positions = input.seed.positions;
    input.seed = { kind: "observed", unit: "rad", samples: [{ frame: 10, positions }] };
    const first = input.series.predicted[0], second = input.series.predicted[1];
    if (first === undefined || second === undefined) throw new Error("Missing fixture rows");
    input.chunks = [
      { frame: 10, predicted: [first, second, first], target: [second, first, first], valid: [true, true, false] },
      { frame: 11, predicted: [first, first], target: [first, second], valid: [true, true] },
    ];
    const before = structuredClone(input);
    // When solving the complete request.
    const output = derivePrediction(input);
    // Then first-step/anchor predictions cannot borrow the GT or preceding chunk seed.
    expect(rowAt(output.joint?.series.predicted, 1).slice(0, 7)).toEqual(Array(7).fill(null));
    expect(rowAt(output.joint?.chunks[1]?.predicted).slice(0, 7)).toEqual(Array(7).fill(null));
    expect(rowAt(output.joint?.chunks[0]?.predicted, 1).slice(0, 7).every((v) => v !== null)).toBe(true);
    expect(rowAt(output.joint?.chunks[0]?.target, 1)).toEqual(rowAt(output.joint?.series.target, 1));
    expect(rowAt(output.joint?.chunks[1]?.target)).toEqual(rowAt(output.joint?.series.target, 1));
    expect(rowAt(output.joint?.chunks[0]?.target)).toEqual(rowAt(output.joint?.series.target));
    expect(rowAt(output.joint?.chunks[0]?.predicted, 2)).toEqual([...Array(7).fill(null), 41, ...Array(7).fill(null), 82]);
    expect(output.joint?.chunks.map((chunk) => ({ frame: chunk.frame, valid: chunk.valid })))
      .toEqual(input.chunks.map((chunk) => ({ frame: chunk.frame, valid: chunk.valid })));
    expect(input).toEqual(before);
  });

  test("uses preceding prediction success within each chunk but never a GT solution", () => {
    // Given redundant joints with different target actions and nonzero manual branch seed.
    const input = cartesianInput();
    if (input.profile === null || input.seed?.kind !== "manual") throw new Error("Manual profile fixture required");
    const first = input.series.predicted[0], second = input.series.predicted[1];
    if (first === undefined || second === undefined) throw new Error("Missing fixture rows");
    input.chunks = [{ frame: 20, predicted: [first, second], target: [second, first], valid: [true, true] }];
    const target = (angle: number) => poseFromTransform(originTransform({
      xyz: [0.2 * Math.cos(angle), 0.2 * Math.sin(angle), 0.1], rpy: [0, 0, angle],
    }));
    const start = solveInverse(input.profile.leftChain, target(0.28), input.seed.positions.slice(0, 7));
    if (start.kind !== "ready") throw new Error(start.reason);
    const next = solveInverse(input.profile.leftChain, target(0.42), start.joints);
    if (next.kind !== "ready") throw new Error(next.reason);
    // When deriving the stream.
    const output = derivePrediction(input);
    // Then its continuation matches explicitly seeded solver calls, independent of targets.
    rowAt(output.joint?.chunks[0]?.predicted, 1).slice(0, 7).forEach((value, i) => {
      expect(value).not.toBeNull();
      expect(value ?? NaN).toBeCloseTo(valueAt(next.joints, i), 14);
    });
  });

  test("rejects malformed mappings and nonfinite runtime seeds at the schema boundary", () => {
    // Given invalid requests that cannot satisfy the public admission contract.
    const input = jointInput(), cart = cartesianInput();
    // When crossing the parse boundary.
    // Then malformed inputs throw rather than generating an apparently successful result.
    for (const invalid of [
      { ...input, source: { ...input.source, left: { joints: Array(7).fill(0), gripper: null } } },
      { ...input, chunks: [{ ...input.chunks[0], valid: [] }] },
      { ...cart, seed: { kind: "manual", unit: "rad", positions: Array(14).fill(NaN) } },
    ]) expect(() => derivePrediction(invalid)).toThrow();
  });
});

const replySchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("ready"), data: predictionResultSchema }),
  z.object({ kind: z.literal("error"), reason: z.string() }),
]);

for (const invalid of [false, true]) test(`real built prediction Worker posts ${invalid ? "error" : "ready"}`, async () => {
  // Given the real browser bundle, with bounded event subscriptions before posting.
  const asset = await buildPredictionWorkerAsset(), url = URL.createObjectURL(asset);
  const worker = new Worker(url, { type: "module" });
  try {
    const reply = new Promise<unknown>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Worker reply deadline")), 5000);
      worker.onmessage = (event: MessageEvent<unknown>) => { clearTimeout(timeout); resolve(event.data); };
      worker.onerror = (event) => { clearTimeout(timeout); reject(new Error(event.message)); };
    });
    const input = invalid ? {} : cartesianInput(true);
    // When sending one complete request.
    worker.postMessage(input);
    const output = replySchema.parse(await reply);
    // Then the actual Worker returns the agreed result or admission error.
    expect(output.kind).toBe(invalid ? "error" : "ready");
    if (output.kind === "ready") expect(output.data).toEqual(derivePrediction(input));
  } finally { worker.terminate(); URL.revokeObjectURL(url); }
}, 10000);
