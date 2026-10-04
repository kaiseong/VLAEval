import { describe, expect, test } from "bun:test";
import { compiledProfileSchema, fkRequestSchema, fkResultSchema, type CompiledProfile, type FkRequest } from "../../src/kinematics/contracts";
import { deriveForward, forwardChain, splitAngleWraps, translationMm } from "../../src/kinematics/forward";
import { axisRotation, originTransform, poseFromTransform, rotationError, KinematicsError } from "../../src/kinematics/math";

const names = [
  ...Array.from({ length: 7 }, (_, i) => `right_arm_${i}`),
  ...Array.from({ length: 7 }, (_, i) => `left_arm_${i}`),
  "right_gripper_0", "left_gripper_0",
];
const origin = { xyz: [0, 0, 0], rpy: [0, 0, 0] } satisfies CompiledProfile["rightChain"][number]["origin"];
function syntheticRequest(): FkRequest {
  const chain = (side: "right" | "left"): CompiledProfile["rightChain"] => [
    ...Array.from({ length: 7 }, (_, i): CompiledProfile["rightChain"][number] => ({
      name: `${side}_arm_${i}`, type: "revolute", origin, axis: [0, 0, 1],
      parentLink: i === 0 ? "link_torso_5" : `link_${side}_arm_${i - 1}`,
      childLink: `link_${side}_arm_${i}`,
    })),
    { name: `tool_${side}`, type: "fixed", parentLink: `link_${side}_arm_6`,
      childLink: `ee_${side}`, origin: { xyz: [0.1, 0, 0], rpy: [0, 0, 0] } },
  ];
  return fkRequestSchema.parse({
    schemaVersion: 1, jobId: "c9a7752e-74ba-4052-9ec1-ecbc8306d975", episode: 4,
    profileHash: "a".repeat(64), generation: 12, jointUnit: "rad", representation: "absolute_joint_position",
    convention: { kind: "nominal_sign_zero", nominalSignZeroConfirmed: true, source: "user_declared" },
    profile: { schemaVersion: 1, profileHash: "a".repeat(64), sourcePath: "/synthetic.urdf",
      urdfSha256: "b".repeat(64), model: "synthetic", revision: "test", rootLink: "link_torso_5",
      tips: { right: "ee_right", left: "ee_left" }, rightChain: chain("right"), leftChain: chain("left") },
    actionNames: names,
    jointMapping: names.slice(0, 14).map((name, sourceIndex) => ({ jointName: name, channelName: name, sourceIndex })),
    frames: [{ frame: 9, predicted: Array(16).fill(0), target: Array(16).fill(0) }],
  });
}
const yawPose = (angle: number) => poseFromTransform(originTransform({ xyz: [0, 0, 0], rpy: [0, 0, angle] }));
const quaternion = (angle: number) => {
  const q = yawPose(angle).quaternionXyzw;
  if (q === null) throw new Error("Test requires a valid quaternion");
  return q;
};

describe("forward kinematics", () => {
  test("composes origin before axis rotation and fixed offset", () => {
    // Given a translated, rotated origin followed by a local rotation and tool.
    const chain: CompiledProfile["rightChain"] = [
      { name: "joint", type: "revolute", parentLink: "root", childLink: "arm",
        origin: { xyz: [1, 2, 3], rpy: [0, 0, Math.PI / 2] }, axis: [1, 0, 0] },
      { name: "tool", type: "fixed", parentLink: "arm", childLink: "ee",
        origin: { xyz: [0, 1, 0], rpy: [0, 0, 0] } },
    ];
    // When rotating about local X, then the tool offset points along world Z.
    const pose = forwardChain(chain, new Map([["joint", Math.PI / 2]]));
    expect(pose.translationM[0]).toBeCloseTo(1, 12);
    expect(pose.translationM.slice(1)).toEqual([2, 4]);
    expect(pose.rpyDeg[0]).toBeCloseTo(90, 10);
    expect(pose.rpyDeg[2]).toBeCloseTo(90, 10);
  });

  test("uses RzRyRx and preserves Float64 storage", () => {
    const transform = originTransform({ xyz: [0.1, 0, 0], rpy: [Math.PI / 2, Math.PI / 2, Math.PI / 2] });
    const pose = poseFromTransform(transform);
    expect(transform).toBeInstanceOf(Float64Array);
    expect(translationMm(pose)).toEqual([100, 0, 0]);
    expect(pose.rpyDeg).toEqual([null, 90, null]);
    expect(rotationError(pose.quaternionXyzw ?? [0, 0, 0, 0], [0, Math.SQRT1_2, 0, Math.SQRT1_2])).toBeCloseTo(0, 12);
  });

  test("normalizes accepted unit-axis roundoff for Rodrigues", () => {
    const pose = poseFromTransform(axisRotation([0, 0.93969262, -0.34202014], Math.PI / 2));
    expect(Math.hypot(...(pose.quaternionXyzw ?? []))).toBeCloseTo(1, 12);
    expect(rotationError(pose.quaternionXyzw ?? [0, 0, 0, 0], [0, 0, 0, 1])).toBeCloseTo(Math.PI / 2, 12);
  });

  test("converts degrees once while preserving raw source and identity", () => {
    const request = syntheticRequest();
    const frames = [{ frame: 9, predicted: [90, ...Array(15).fill(0)], target: Array(16).fill(0) }];
    const result = deriveForward({ ...request, jointUnit: "deg", frames });
    const arm = result.samples[0]?.arms.right;
    expect(arm?.pose.predicted.translationM?.[0]).toBeCloseTo(0, 12);
    expect(arm?.pose.predicted.translationM?.[1]).toBeCloseTo(0.1, 12);
    expect(arm?.errors.orientationRad).toBeCloseTo(Math.PI / 2, 12);
    expect(arm?.errors.translationM).toBeCloseTo(Math.sqrt(0.02), 12);
    expect(result.samples[0]?.source).toEqual(frames[0] && { predicted: frames[0].predicted, target: frames[0].target });
    expect(result.generation).toBe(12);
    expect(result.episode).toBe(4);
    expect(fkResultSchema.safeParse(result).success).toBe(true);
  });

  test("uses original indices14/15 and excludes both permuted grippers", () => {
    const request = syntheticRequest();
    const actionNames = [...names.slice(14), ...names.slice(2, 14), ...names.slice(0, 2)];
    const jointMapping = request.jointMapping.map((m) => ({ ...m, sourceIndex: actionNames.indexOf(m.channelName) }));
    const row = Array.from({ length: 16 }, (_, i) => i === 14 ? Math.PI / 2 : 0);
    const result = deriveForward({ ...request, actionNames, jointMapping,
      frames: [{ frame: 3, predicted: row, target: Array(16).fill(0) }] });
    const changedGrippers = deriveForward({ ...request, actionNames, jointMapping,
      frames: [{ frame: 3, predicted: row.map((q, i) => i < 2 ? 1e9 : q), target: Array(16).fill(0) }] });
    expect(result.samples[0]?.arms.right.errors.orientationRad).toBeCloseTo(Math.PI / 2, 12);
    expect(changedGrippers.samples[0]?.arms).toEqual(result.samples[0]?.arms);
    expect(jointMapping.slice(0, 2).map((m) => m.sourceIndex)).toEqual([14, 15]);
  });

  test("computes separate full-trace means RMS and counts", () => {
    const request = syntheticRequest();
    const result = deriveForward({ ...request, frames: [0, 3].map((frame, i) => ({
      frame, predicted: [i * Math.PI, ...Array(15).fill(0)], target: Array(16).fill(0),
    })) });
    expect(result.summaries.right.orientationRad).toEqual({ mean: Math.PI / 2, rms: Math.PI / Math.SQRT2, count: 2 });
    expect(result.summaries.right.translationM.mean).toBeCloseTo(0.1, 12);
    expect(result.summaries.right.translationM.rms).toBeCloseTo(Math.sqrt(0.02), 12);
    expect(result.samples.map((sample) => sample.frame)).toEqual([0, 3]);
  });

  test("retains valid poses and SO3 at both pitch singularities", () => {
    for (const sign of [-1, 1]) {
      const pose = poseFromTransform(originTransform({ xyz: [0.1, 0.2, 0.3], rpy: [0.4, sign * Math.PI / 2, 0.7] }));
      expect(pose.rpyDeg).toEqual([null, sign * 90, null]);
      expect(pose.translationM).toEqual([0.1, 0.2, 0.3]);
      expect(rotationError(pose.quaternionXyzw ?? [0, 0, 0, 0], pose.quaternionXyzw ?? [0, 0, 0, 0])).toBeCloseTo(0, 12);
    }
  });

  test("flags only pitch values within the declared singular threshold", () => {
    const near = poseFromTransform(originTransform({ ...origin, rpy: [0.4, Math.PI / 2 - 5e-7, 0.7] }));
    const outside = poseFromTransform(originTransform({ ...origin, rpy: [0.4, Math.PI / 2 - 2e-6, 0.7] }));
    expect(near.rpyDeg[0]).toBeNull();
    expect(outside.rpyDeg[0]).toBeCloseTo(0.4 * 180 / Math.PI, 8);
    expect(outside.rpyDeg[2]).toBeCloseTo(0.7 * 180 / Math.PI, 8);
  });

  test("returns quaternion-sign invariant shortest angles including halfturns", () => {
    const q = quaternion(0.7);
    const opposite: [number, number, number, number] = [-q[0], -q[1], -q[2], -q[3]];
    expect(rotationError(q, opposite)).toBe(0);
    const norm = Math.sqrt(30);
    const general: [number, number, number, number] = [1 / norm, 2 / norm, 3 / norm, 4 / norm];
    expect(rotationError(general, general)).toBe(0);
    expect(rotationError(general, [-general[0], -general[1], -general[2], -general[3]])).toBe(0);
    expect(rotationError(quaternion(179 * Math.PI / 180), quaternion(-179 * Math.PI / 180))).toBeCloseTo(2 * Math.PI / 180, 12);
    for (const axis of [[1, 0, 0], [0, 1, 0], [0, 0, 1]] satisfies [number, number, number][]) {
      expect(rotationError(poseFromTransform(axisRotation(axis, Math.PI)).quaternionXyzw ?? [0, 0, 0, 0], [0, 0, 0, 1])).toBeCloseTo(Math.PI, 12);
    }
    expect(rotationError(quaternion(1e-10), quaternion(0))).toBeCloseTo(1e-10, 14);
  });

  test("splits wrapped angles and unavailable points without interpolation", () => {
    const points = [{ frame: 0, value: 179 }, { frame: 3, value: -179 }, { frame: 9, value: null }, { frame: 12, value: 10 }] as const;
    expect(splitAngleWraps(points)).toEqual([[points[0]], [points[1]], [points[3]]]);
  });

  test("rejects nonfinite and improper rotations rather than repairing them", () => {
    for (const matrix of [
      new Float64Array(16), new Float64Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, -1, 0, 0, 0, 0, 1]),
      new Float64Array([2, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]),
      originTransform({ ...origin, xyz: [Number.NaN, 0, 0] }),
    ]) expect(() => poseFromTransform(matrix)).toThrow(KinematicsError);
    expect(() => axisRotation([0, 0, 0], 1)).toThrow(KinematicsError);
    expect(() => axisRotation([0, 0, 1], Infinity)).toThrow(KinematicsError);
    expect(() => rotationError([0, 0, 0, 2], [0, 0, 0, 1])).toThrow(KinematicsError);
  });

  test("rejects missing joints, invalid raw16 and stale profile binding", () => {
    const request = syntheticRequest();
    expect(() => forwardChain(request.profile.rightChain, new Map())).toThrow(KinematicsError);
    for (const invalid of [
      { ...request, profileHash: "c".repeat(64) },
      { ...request, jointMapping: request.jointMapping.slice(1) },
      { ...request, frames: [{ frame: 0, predicted: Array(16).fill(NaN), target: Array(16).fill(0) }] },
      { ...request, frames: [{ frame: 0, predicted: Array(14).fill(0), target: Array(16).fill(0) }] },
    ]) expect(() => deriveForward(invalid)).toThrow();
  });

  test("returns null metrics reasons and zero counts for all failed pairs", () => {
    const request = syntheticRequest();
    const exploding = (chain: CompiledProfile["rightChain"]) => chain.map((joint) => ({
      ...joint, origin: { ...joint.origin, xyz: [1e308, 0, 0] satisfies [number, number, number] },
    }));
    const result = deriveForward({ ...request, profile: {
      ...request.profile, rightChain: exploding(request.profile.rightChain), leftChain: exploding(request.profile.leftChain),
    } });
    for (const side of ["right", "left"] as const) {
      expect(result.samples[0]?.arms[side].valid).toBe(false);
      expect(result.samples[0]?.arms[side].errors).toEqual({ translationM: null, orientationRad: null });
      expect(result.samples[0]?.arms[side].reasons.length).toBeGreaterThan(0);
      expect(result.summaries[side]).toEqual({
        translationM: { mean: null, rms: null, count: 0 }, orientationRad: { mean: null, rms: null, count: 0 },
      });
    }
    expect(fkResultSchema.safeParse(result).success).toBe(true);
    expect(deriveForward({ ...request, frames: [] }).summaries.right.translationM.mean).toBeNull();
  });

  test("counts only valid pairs when a finite input overflows one predicted pose", () => {
    const request = syntheticRequest();
    const chain = request.profile.rightChain.map((joint, i) => ({
      ...joint, origin: { ...joint.origin,
        xyz: (i === 0 || i === 7 ? [1e308, 0, 0] : [0, 0, 0]) satisfies [number, number, number] },
    }));
    const result = deriveForward({ ...request, profile: { ...request.profile, rightChain: chain },
      frames: [
        { frame: 0, predicted: Array(16).fill(0), target: [Math.PI, ...Array(15).fill(0)] },
        { frame: 9, predicted: [Math.PI, ...Array(15).fill(0)], target: [Math.PI, ...Array(15).fill(0)] },
      ] });
    expect(result.samples[0]?.arms.right.pose.predicted.translationM).toBeNull();
    expect(result.samples[0]?.arms.right.pose.target.translationM).not.toBeNull();
    expect(result.summaries.right.translationM.count).toBe(1);
    expect(result.summaries.right.translationM.mean).toBe(0);
    expect(result.summaries.left.translationM.count).toBe(2);
    expect(fkResultSchema.safeParse(result).success).toBe(true);
  });

  test("does not clamp commanded joint angles to a joint limit", () => {
    const request = syntheticRequest();
    const result = deriveForward({ ...request, jointUnit: "deg",
      frames: [{ frame: 0, predicted: [450, ...Array(15).fill(0)], target: Array(16).fill(0) }] });
    expect(result.samples[0]?.arms.right.pose.predicted.translationM?.[1]).toBeCloseTo(0.1, 12);
    expect(result.samples[0]?.source.predicted[0]).toBe(450);
  });

  test("matches recorded M v1.2 SDK zero poses with fixed tool offsets", () => {
    // Given the source-verified M descriptor (not a compiler/oracle substitute).
    const request = syntheticRequest();
    const modelChain = (side: "right" | "left") => request.profile[side === "right" ? "rightChain" : "leftChain"].map((joint, i) => {
      const xyz: [number, number, number] = i === 0 ? [0, side === "right" ? -0.22 : 0.22, side === "right" ? 0.080073451539 : 0.080073452]
        : i === 3 ? [0.031, 0, -0.276] : i === 4 ? [-0.031, 0, -0.256] : i === 7 ? [0, 0, -0.1261] : [0, 0, 0];
      return { ...joint, origin: { xyz, rpy: origin.rpy } };
    });
    const profile = compiledProfileSchema.parse({ ...request.profile, rightChain: modelChain("right"), leftChain: modelChain("left") });
    const result = deriveForward({ ...request, profile });
    expect(result.samples[0]?.arms.right.pose.predicted.translationM).toEqual([0, -0.22, -0.578026548461]);
    expect(result.samples[0]?.arms.left.pose.predicted.translationM?.[2]).toBeCloseTo(-0.5780265480000001, 12);
    expect(result.samples[0]?.arms.right.pose.predicted.quaternionXyzw).toEqual([0, 0, 0, 1]);
  });
});
