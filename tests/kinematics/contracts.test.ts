import { describe, expect, test } from "bun:test";
import { resultSchema } from "../../src/contracts";
import { compiledProfileSchema, fkDeclarationSchema, fkRequestSchema, fkResultSchema, type CompiledProfile } from "../../src/kinematics/contracts";
import { resultFixture } from "../result-fixture";

const rightNames = Array.from({ length: 7 }, (_, index) => `right_arm_${index}`);
const leftNames = Array.from({ length: 7 }, (_, index) => `left_arm_${index}`);
const profileHash = "a".repeat(64);
const origin: CompiledProfile["rightChain"][number]["origin"] = { xyz: [0, 0, 0], rpy: [0, 0, 0] };
const chain = (side: "right" | "left"): CompiledProfile["rightChain"] => [
  ...Array.from({ length: 7 }, (_, index): CompiledProfile["rightChain"][number] => ({
    name: `${side}_arm_${index}`, type: "revolute" as const, origin, axis: [1, 0, 0],
    parentLink: index === 0 ? "link_torso_5" : `link_${side}_arm_${index - 1}`,
    childLink: `link_${side}_arm_${index}`,
  })),
  { name: `tool_${side}`, type: "fixed" as const, parentLink: `link_${side}_arm_6`,
    childLink: `ee_${side}`, origin: { xyz: [0, 0, -0.1261], rpy: [0, 0, 0] } },
];
const actionNames = [...rightNames, ...leftNames, "right_gripper_0", "left_gripper_0"];

const profile = {
  schemaVersion: 1,
  profileHash,
  sourcePath: "/synthetic/rby1/arm.urdf",
  model: "synthetic-rby1",
  revision: "test-revision",
  urdfSha256: "b".repeat(64),
  rootLink: "link_torso_5",
  tips: { right: "ee_right", left: "ee_left" },
  rightChain: chain("right"),
  leftChain: chain("left"),
};

const declaration = {
  representation: "absolute_joint_position",
  jointUnit: "rad",
  convention: { kind: "nominal_sign_zero", nominalSignZeroConfirmed: true, source: "user_declared" },
};

const request = {
  schemaVersion: 1,
  jobId: "c9a7752e-74ba-4052-9ec1-ecbc8306d975",
  episode: 4,
  profileHash,
  jointUnit: "rad",
  representation: "absolute_joint_position",
  convention: declaration.convention,
  generation: 12,
  profile,
  actionNames,
  jointMapping: [...rightNames, ...leftNames].map((name, sourceIndex) => ({
    jointName: name,
    channelName: name,
    sourceIndex,
  })),
  frames: [{ frame: 0, predicted: Array(16).fill(0), target: Array(16).fill(0.1) }],
};

const rightPredictedPose = { translationM: [0.1, 0.2, 0.3], quaternionXyzw: [0, 0, 0, 1], rpyDeg: [10, 20, 30] };
const rightTargetPose = { translationM: [0.11, 0.2, 0.3], quaternionXyzw: [0, 0, 0.1, Math.sqrt(0.99)], rpyDeg: [10, 20, 41.478] };
const leftPredictedPose = { translationM: [-0.1, 0.4, 0.5], quaternionXyzw: [0, 0, 0.2, Math.sqrt(0.96)], rpyDeg: [-15, 25, -35] };
const leftTargetPose = { translationM: [-0.12, 0.4, 0.5], quaternionXyzw: [0, 0, 0.3, Math.sqrt(0.91)], rpyDeg: [-15, 25, 36] };
const source = { predicted: Array(16).fill(0), target: Array(16).fill(0.1) };
const resultIdentity = {
  schemaVersion: request.schemaVersion,
  jobId: request.jobId,
  episode: request.episode,
  profileHash: request.profileHash,
  jointUnit: request.jointUnit,
  representation: request.representation,
  convention: request.convention,
  generation: request.generation,
};
const unavailablePose = { translationM: null, quaternionXyzw: null, rpyDeg: [null, null, null] };
const derivedResult = {
  ...resultIdentity,
  profile: {
    model: profile.model,
    revision: profile.revision,
    urdfSha256: profile.urdfSha256,
    rootLink: profile.rootLink,
    tips: profile.tips,
  },
  actionNames,
  jointMapping: request.jointMapping,
  samples: [{
    frame: 9,
    source,
    arms: {
      right: { pose: { predicted: rightPredictedPose, target: rightTargetPose }, errors: { translationM: 0.01, orientationRad: 0.2 }, valid: true, reasons: [] },
      left: { pose: { predicted: leftPredictedPose, target: leftTargetPose }, errors: { translationM: 0.02, orientationRad: 0.3 }, valid: true, reasons: [] },
    },
  }],
  summaries: {
    right: {
      translationM: { mean: 0.01, rms: 0.01, count: 1 },
      orientationRad: { mean: 0.2, rms: 0.2, count: 1 },
    },
    left: {
      translationM: { mean: 0.02, rms: 0.02, count: 1 },
      orientationRad: { mean: 0.3, rms: 0.3, count: 1 },
    },
  },
};
const frame = derivedResult.samples[0];
if (!frame) throw new Error("Derived fixture must include a source frame");

describe("versioned FK contracts", () => {
  test("parses a complete named seven-joint compiled profile", () => {
    // Given the ordered source joints, when parsed, then fixed origins survive.
    const parsed = compiledProfileSchema.parse(profile);
    expect(parsed.rightChain.slice(0, 7).map((joint) => joint.name)).toEqual(rightNames);
    expect(parsed.leftChain.slice(0, 7).map((joint) => joint.name)).toEqual(leftNames);
    expect(parsed.rightChain.at(-1)).toEqual(chain("right").at(-1));
    expect(parsed.leftChain.at(-1)).toEqual(chain("left").at(-1));
  });

  test("requires explicit absolute-position units and convention admission", () => {
    expect(fkDeclarationSchema.parse(declaration).jointUnit).toBe("rad");
    expect(fkDeclarationSchema.parse({ ...declaration, jointUnit: "deg" }).jointUnit).toBe("deg");
    for (const representation of ["unknown", "delta", "velocity"]) {
      expect(fkDeclarationSchema.safeParse({ ...declaration, representation }).success).toBe(false);
    }
    expect(fkDeclarationSchema.safeParse({
      ...declaration,
      convention: { ...declaration.convention, nominalSignZeroConfirmed: false },
    }).success).toBe(false);
  });

  test("rejects unsupported versions, missing fields, and duplicate joint mappings", () => {
    expect(compiledProfileSchema.safeParse({ ...profile, schemaVersion: 2 }).success).toBe(false);
    const { revision: _revision, ...missingRevision } = profile;
    expect(compiledProfileSchema.safeParse(missingRevision).success).toBe(false);
    expect(compiledProfileSchema.safeParse({
      ...profile,
      rightChain: profile.rightChain.map((joint, index) => (
        index === 0 ? { ...joint, axis: [0, 0, 0] } : joint
      )),
    }).success).toBe(false);
    const duplicateMapping = request.jointMapping.map((mapping, index) => (
      index === 13 ? { ...mapping, sourceIndex: 0 } : mapping
    ));
    expect(fkRequestSchema.safeParse({ ...request, jointMapping: duplicateMapping }).success).toBe(false);
    expect(fkRequestSchema.safeParse({ ...request, profileHash: "c".repeat(64) }).success).toBe(false);
    expect(fkRequestSchema.safeParse({ ...request, jobId: "not-a-job-id" }).success).toBe(false);
  });

  test("round-trips both-arm SI poses, quaternions, and result provenance", () => {
    const parsed = fkResultSchema.parse(derivedResult);
    expect(JSON.stringify(parsed)).toBe(JSON.stringify(derivedResult));
    expect(parsed.samples[0]?.arms.right.pose.predicted.translationM).not.toEqual(parsed.samples[0]?.arms.left.pose.predicted.translationM);
    expect(parsed.summaries.right.translationM).not.toEqual(parsed.summaries.left.translationM);
  });

  test("rejects valid arms with unavailable poses or errors", () => {
    const rightArm = frame.arms.right;
    const noPose = { ...rightArm, pose: { predicted: unavailablePose, target: unavailablePose } };
    expect(fkResultSchema.safeParse({ ...derivedResult, samples: [{ ...frame, arms: { right: noPose, left: rightArm } }] }).success).toBe(false);
    expect(fkResultSchema.safeParse({
      ...derivedResult,
      samples: [{ ...frame, arms: { right: { ...rightArm, errors: { ...rightArm.errors, orientationRad: null } }, left: rightArm } }],
    }).success).toBe(false);
  });

  test("requires reasons for unavailable arms and null summaries at zero count", () => {
    const unavailableArm = {
      pose: { predicted: unavailablePose, target: unavailablePose },
      errors: { translationM: null, orientationRad: null },
      valid: false,
      reasons: ["Synthetic unavailable pair"],
    };
    const emptySummaries = {
      translationM: { mean: null, rms: null, count: 0 },
      orientationRad: { mean: null, rms: null, count: 0 },
    };
    const unavailableResult = {
      ...derivedResult,
      samples: [{ ...frame, arms: { right: unavailableArm, left: unavailableArm } }],
      summaries: { right: emptySummaries, left: emptySummaries },
    };
    const parsed = fkResultSchema.parse(unavailableResult);
    expect(parsed.samples[0]?.arms.right.valid).toBe(false);
    expect(parsed.samples[0]?.source).toEqual(source);
    expect(fkResultSchema.safeParse({ ...unavailableResult,
      samples: [{ ...frame, arms: { right: { ...unavailableArm, reasons: [] }, left: unavailableArm } }],
    }).success).toBe(false);
    expect(fkResultSchema.safeParse({
      ...unavailableResult,
      summaries: {
        ...unavailableResult.summaries,
        right: { ...emptySummaries, translationM: { mean: 0, rms: 0, count: 0 } },
      },
    }).success).toBe(false);
  });

  test("accepts singular display Euler components without invalidating SI pose errors", () => {
    const predicted = { ...frame.arms.right.pose.predicted, rpyDeg: [null, 90, null] };
    const right = { ...frame.arms.right, pose: { ...frame.arms.right.pose, predicted } };
    const parsed = fkResultSchema.parse({
      ...derivedResult,
      samples: [{ ...frame, arms: { ...frame.arms, right } }],
    });
    expect(parsed.samples[0]?.arms.right.valid).toBe(true);
    expect(parsed.samples[0]?.arms.right.pose.predicted.rpyDeg).toEqual([null, 90, null]);
    expect(parsed.samples[0]?.arms.right.pose.predicted.quaternionXyzw).toEqual([0, 0, 0, 1]);
    expect(parsed.samples[0]?.arms.right.errors.orientationRad).toBe(0.2);
  });

  test("rejects non-unit quaternions and unsupported result versions", () => {
    const predicted = { ...frame.arms.right.pose.predicted, quaternionXyzw: [0, 0, 0, 2] };
    const right = { ...frame.arms.right, pose: { ...frame.arms.right.pose, predicted } };
    expect(fkResultSchema.safeParse({ ...derivedResult, schemaVersion: 2 }).success).toBe(false);
    expect(fkResultSchema.safeParse({
      ...derivedResult,
      samples: [{ ...frame, arms: { ...frame.arms, right } }],
    }).success).toBe(false);
    expect(fkResultSchema.safeParse({
      ...derivedResult,
      samples: [{ ...frame, source: { predicted: [Number.NaN], target: [] } }],
    }).success).toBe(false);
  });

  test("leaves an archived legacy result structurally unchanged", () => {
    const source = JSON.stringify(resultFixture);
    const parsed = resultSchema.parse(JSON.parse(source));
    expect(JSON.stringify(parsed)).toBe(source);
  });

  test("rejects malformed ordered chains when topology or source identity is lost", () => {
    // Given a valid chain, when one edge/name changes, then admission fails.
    const rightChain = profile.rightChain;
    for (const invalid of [
      rightChain.slice(0, 7), [...rightChain].reverse(),
      rightChain.map((joint, i) => i === 3 ? { ...joint, parentLink: "disconnected" } : joint),
      rightChain.map((joint, i) => i === 3 ? { ...joint, childLink: "link_torso_5" } : joint),
      rightChain.map((joint, i) => i === 3 ? { ...joint, name: "right_arm_2" } : joint),
      rightChain.map((joint, i) => i === 7 ? { ...joint, parentLink: "ee_right", childLink: "tool_right" } : joint),
      rightChain.map((joint, i) => i === 7 ? { ...joint, name: "tcp_right" } : joint),
    ]) expect(compiledProfileSchema.safeParse({ ...profile, rightChain: invalid }).success).toBe(false);
  });

  test("retains raw16 when named arm mappings occupy original indices14 and15", () => {
    // Given grippers moved to0/1, when admitted, then arm indices retain raw coordinates.
    const names = [...actionNames.slice(14), ...actionNames.slice(2, 14), ...actionNames.slice(0, 2)];
    const jointMapping = request.jointMapping.map((mapping) => ({ ...mapping, sourceIndex: names.indexOf(mapping.channelName) }));
    const raw = { predicted: Array.from({ length: 16 }, (_, i) => i + 100), target: Array.from({ length: 16 }, (_, i) => i + 200) };
    const parsed = fkRequestSchema.parse({ ...request, actionNames: names, jointMapping, frames: [{ frame: 9, ...raw }] });
    expect(parsed.jointMapping.slice(0, 2).map((mapping) => mapping.sourceIndex)).toEqual([14, 15]);
    expect(parsed.frames[0]).toEqual({ frame: 9, ...raw });
    expect(fkResultSchema.parse({ ...derivedResult, actionNames: names, jointMapping, samples: [{ ...frame, source: raw }] }).samples[0]?.source).toEqual(raw);
    for (const invalid of [
      { ...request, actionNames: names },
      { ...request, frames: [{ frame: 9, predicted: raw.predicted.slice(0, 14), target: raw.target }] },
      { ...request, actionNames: actionNames.map((name, i) => i === 15 ? "right_gripper_0" : name) },
      { ...request, jointMapping: request.jointMapping.map((mapping, i) => i === 0 ? { ...mapping, jointName: "right_gripper_0", channelName: "right_gripper_0", sourceIndex: 14 } : mapping) },
    ]) expect(fkRequestSchema.safeParse(invalid).success).toBe(false);
    expect(fkResultSchema.safeParse({ ...derivedResult, actionNames: names }).success).toBe(false);
  });

  test("rejects partial null summaries when count is positive or zero", () => {
    // Given each possible null pairing, when parsed, then only count-consistent pairs pass.
    for (const count of [0, 1]) for (const metric of [{ mean: null, rms: 0, count }, { mean: 0, rms: null, count }]) {
      expect(fkResultSchema.safeParse({ ...derivedResult, summaries: {
        ...derivedResult.summaries, right: { ...derivedResult.summaries.right, translationM: metric },
      } }).success).toBe(false);
    }
  });
});
