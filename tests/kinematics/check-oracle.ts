import { readFile } from "node:fs/promises";
import { z } from "zod";
import type { CompiledProfile } from "../../src/kinematics/contracts";
import { ProfileCatalog } from "../../src/kinematics/catalog";
import { forwardChain } from "../../src/kinematics/forward";
import type { Pose } from "../../src/kinematics/math";

const finite = z.number().finite();
const row = z.tuple([finite, finite, finite, finite]);
const matrix = z.tuple([row, row, row, row]);
type Matrix = z.infer<typeof matrix>;
const scenarioSchema = z.object({
  id: z.string().min(1),
  kind: z.enum(["zero", "single-joint", "asymmetric", "torso"]),
  jointsRadians: z.record(z.string(), finite),
  torsoRadians: z.record(z.string(), finite),
  absoluteMatrices: z.object({ right: matrix, left: matrix }).strict(),
}).strict();
const goldenSchema = z.object({
  schemaVersion: z.literal(1),
  seed: z.number().int(),
  sdkVersion: z.string().min(1),
  units: z.object({ joints: z.literal("rad"), translation: z.literal("m") }).strict(),
  profiles: z.array(z.object({
    model: z.enum(["RBY1_A", "RBY1_M"]),
    revision: z.enum(["v1.1", "v1.2"]),
    sourcePath: z.string().min(1),
    urdfSha256: z.string().regex(/^[a-f0-9]{64}$/),
    rootLink: z.literal("link_torso_5"),
    tips: z.object({ right: z.literal("ee_right"), left: z.literal("ee_left") }).strict(),
    sdkRobotClass: z.string().min(1),
    scenarios: z.array(scenarioSchema),
  }).strict()).length(4),
}).strict();

type Mutation = "none" | "swapped-joint" | "swapped-arm" | "wrong-tool-offset";

function parseArgs(args: readonly string[]): Readonly<{ path: string; mutation: Mutation }> {
  const path = args[0];
  if (path === undefined) throw new Error("Usage: bun tests/kinematics/check-oracle.ts <golden.json> [--mutation <kind>]");
  const flag = args[1];
  const value = args[2];
  if (flag === undefined) return { path, mutation: "none" };
  if (flag !== "--mutation" || value === undefined) {
    throw new Error(`Invalid checker arguments: ${args.slice(1).join(" ")}`);
  }
  switch (value) {
    case "swapped-joint": return { path, mutation: value };
    case "swapped-arm": return { path, mutation: value };
    case "wrong-tool-offset": return { path, mutation: value };
    default: throw new Error(`Invalid comparison mutation: ${value}`);
  }
}

function matrixFromPose(pose: Pose): Matrix {
  const [x, y, z, w] = pose.quaternionXyzw;
  const [tx, ty, tz] = pose.translationM;
  return [
    [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w), tx],
    [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w), ty],
    [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y), tz],
    [0, 0, 0, 1],
  ];
}

function errors(expected: Matrix, actual: Matrix): Readonly<{ translationM: number; orientationRad: number }> {
  const dx = actual[0][3] - expected[0][3];
  const dy = actual[1][3] - expected[1][3];
  const dz = actual[2][3] - expected[2][3];
  const r00 = expected[0][0] * actual[0][0] + expected[1][0] * actual[1][0] + expected[2][0] * actual[2][0];
  const r01 = expected[0][0] * actual[0][1] + expected[1][0] * actual[1][1] + expected[2][0] * actual[2][1];
  const r02 = expected[0][0] * actual[0][2] + expected[1][0] * actual[1][2] + expected[2][0] * actual[2][2];
  const r10 = expected[0][1] * actual[0][0] + expected[1][1] * actual[1][0] + expected[2][1] * actual[2][0];
  const r11 = expected[0][1] * actual[0][1] + expected[1][1] * actual[1][1] + expected[2][1] * actual[2][1];
  const r12 = expected[0][1] * actual[0][2] + expected[1][1] * actual[1][2] + expected[2][1] * actual[2][2];
  const r20 = expected[0][2] * actual[0][0] + expected[1][2] * actual[1][0] + expected[2][2] * actual[2][0];
  const r21 = expected[0][2] * actual[0][1] + expected[1][2] * actual[1][1] + expected[2][2] * actual[2][1];
  const r22 = expected[0][2] * actual[0][2] + expected[1][2] * actual[1][2] + expected[2][2] * actual[2][2];
  const trace = r00 + r11 + r22;
  const sineVector = [r21 - r12, r02 - r20, r10 - r01];
  const cosine = Math.max(-1, Math.min(1, (trace - 1) / 2));
  const orientationRad = Math.atan2(Math.hypot(...sineVector) / 2, cosine);
  return { translationM: Math.hypot(dx, dy, dz), orientationRad };
}

function offsetTool(chain: CompiledProfile["rightChain"], name: string): CompiledProfile["rightChain"] {
  return chain.map((joint) => {
    if (joint.type !== "fixed" || joint.name !== name) return joint;
    const [x, y, z] = joint.origin.xyz;
    return { ...joint, origin: { ...joint.origin, xyz: [x, y, z + 0.01] as const } };
  });
}

function verifyScenario(
  profile: CompiledProfile,
  scenario: z.infer<typeof scenarioSchema>,
  mutation: Mutation,
): Readonly<{ comparisons: number; worstTranslationM: number; worstOrientationRad: number }> {
  const joints = new Map(Object.entries(scenario.jointsRadians));
  if (mutation === "swapped-joint") {
    const first = joints.get("right_arm_0");
    const second = joints.get("right_arm_1");
    if (first === undefined || second === undefined) throw new Error("Oracle scenario omits right-arm joints");
    joints.set("right_arm_0", second);
    joints.set("right_arm_1", first);
  }
  const rightChain = mutation === "wrong-tool-offset" ? offsetTool(profile.rightChain, "tool_right") : profile.rightChain;
  const leftChain = mutation === "wrong-tool-offset" ? offsetTool(profile.leftChain, "tool_left") : profile.leftChain;
  const product = {
    right: matrixFromPose(forwardChain(rightChain, joints)),
    left: matrixFromPose(forwardChain(leftChain, joints)),
  };
  let worstTranslationM = 0;
  let worstOrientationRad = 0;
  for (const side of ["right", "left"] as const) {
    const expectedSide = mutation === "swapped-arm" ? (side === "right" ? "left" : "right") : side;
    const delta = errors(scenario.absoluteMatrices[expectedSide], product[side]);
    worstTranslationM = Math.max(worstTranslationM, delta.translationM);
    worstOrientationRad = Math.max(worstOrientationRad, delta.orientationRad);
    if (delta.translationM > 1e-6 || delta.orientationRad > 1e-6) {
      throw new Error(
        `${profile.model} ${profile.revision} ${scenario.id} ${side}: ` +
        `translation=${delta.translationM}m orientation=${delta.orientationRad}rad`,
      );
    }
  }
  return { comparisons: 2, worstTranslationM, worstOrientationRad };
}

async function main(): Promise<void> {
  const { path, mutation } = parseArgs(process.argv.slice(2));
  const json: unknown = JSON.parse(await readFile(path, "utf8"));
  const golden = goldenSchema.parse(json);
  if (golden.seed !== 20261004 || golden.sdkVersion !== "0.10.0") {
    throw new Error(`Unexpected oracle seed/SDK: ${golden.seed}/${golden.sdkVersion}`);
  }
  const catalog = new ProfileCatalog();
  const listing = await catalog.list();
  if (listing.profiles.length !== 4) {
    throw new Error(`Expected exactly four offered profiles; got ${listing.profiles.length}`);
  }
  const offeredIdentities = new Set(listing.profiles.map((profile) => `${profile.model}/${profile.revision}`));
  const expectedIdentities = new Set(["RBY1_A/v1.1", "RBY1_A/v1.2", "RBY1_M/v1.1", "RBY1_M/v1.2"]);
  if (offeredIdentities.size !== expectedIdentities.size ||
      [...expectedIdentities].some((identity) => !offeredIdentities.has(identity))) {
    throw new Error(`Unexpected offered profile identities: ${[...offeredIdentities].join(", ")}`);
  }
  const goldenByDigest = new Map(golden.profiles.map((profile) => [profile.urdfSha256, profile]));
  if (goldenByDigest.size !== 4) throw new Error("Golden data contains duplicate source digests");
  let comparisons = 0;
  let worstTranslationM = 0;
  let worstOrientationRad = 0;
  for (const offered of listing.profiles) {
    const source = goldenByDigest.get(offered.urdfSha256);
    if (source === undefined || source.model !== offered.model || source.revision !== offered.revision ||
        source.sourcePath !== offered.sourcePath || source.rootLink !== "link_torso_5" ||
        source.tips.right !== "ee_right" || source.tips.left !== "ee_left") {
      throw new Error(`SDK oracle identity does not match catalog profile ${offered.model} ${offered.revision}`);
    }
    const profile = await catalog.get(offered.id);
    const kinds = source.scenarios.reduce<Record<string, number>>((counts, scenario) => {
      counts[scenario.kind] = (counts[scenario.kind] ?? 0) + 1;
      return counts;
    }, {});
    if (source.scenarios.length !== 47 || kinds["zero"] !== 1 || kinds["single-joint"] !== 14 ||
        kinds["asymmetric"] !== 30 || kinds["torso"] !== 2) {
      throw new Error(`Incomplete numeric cases for ${offered.model} ${offered.revision}: ${JSON.stringify(kinds)}`);
    }
    const armJoints = [
      ...Array.from({ length: 7 }, (_, index) => `right_arm_${index}`),
      ...Array.from({ length: 7 }, (_, index) => `left_arm_${index}`),
    ];
    const zero = source.scenarios.find((scenario) => scenario.kind === "zero");
    const singles = source.scenarios.filter((scenario) => scenario.kind === "single-joint");
    const asymmetric = source.scenarios.filter((scenario) => scenario.kind === "asymmetric");
    const torso = source.scenarios.filter((scenario) => scenario.kind === "torso");
    if (zero === undefined || Object.keys(zero.jointsRadians).length !== 14 ||
        armJoints.some((joint) => zero.jointsRadians[joint] !== 0)) {
      throw new Error(`Zero scenario is not the all-zero 14-joint vector: ${offered.model} ${offered.revision}`);
    }
    const movedJoints = new Set<string>();
    for (const scenario of singles) {
      const moved = armJoints.filter((joint) => scenario.jointsRadians[joint] === 0.1);
      const selectedJoint = moved[0];
      if (moved.length !== 1 || selectedJoint === undefined ||
          Object.keys(scenario.jointsRadians).length !== 14 ||
          armJoints.some((joint) => scenario.jointsRadians[joint] !== (joint === selectedJoint ? 0.1 : 0))) {
        throw new Error(`Invalid individual +0.1-rad joint case: ${scenario.id}`);
      }
      movedJoints.add(selectedJoint);
    }
    if (movedJoints.size !== 14) throw new Error("Individual joint cases do not cover all fourteen arm joints");
    const asymmetricVectors = new Set<string>();
    for (const scenario of asymmetric) {
      const values = armJoints.map((joint) => scenario.jointsRadians[joint]);
      if (Object.keys(scenario.jointsRadians).length !== 14 ||
          values.some((value) => value === undefined) || new Set(values).size !== 14) {
        throw new Error(`Asymmetric vector is incomplete or symmetric: ${scenario.id}`);
      }
      asymmetricVectors.add(JSON.stringify(values));
    }
    if (asymmetricVectors.size !== 30) throw new Error("Asymmetric vectors are not thirty unique configurations");
    const torsoJoints = Array.from({ length: 6 }, (_, index) => `torso_${index}`);
    const torsoConfigurations = new Set<string>();
    for (const scenario of torso) {
      const values = torsoJoints.map((joint) => scenario.torsoRadians[joint]);
      if (Object.keys(scenario.torsoRadians).length !== 6 ||
          values.some((value) => value === undefined || value === 0)) {
        throw new Error(`Torso configuration is incomplete or all-zero: ${scenario.id}`);
      }
      torsoConfigurations.add(JSON.stringify(values));
    }
    if (torsoConfigurations.size !== 2) throw new Error("Torso scenarios do not contain two distinct configurations");
    for (const scenario of source.scenarios) {
      const result = verifyScenario(profile, scenario, mutation);
      comparisons += result.comparisons;
      worstTranslationM = Math.max(worstTranslationM, result.worstTranslationM);
      worstOrientationRad = Math.max(worstOrientationRad, result.worstOrientationRad);
    }
  }
  console.log(JSON.stringify({
    verdict: "PASS",
    mutation,
    profiles: listing.profiles.length,
    scenariosPerProfile: 47,
    absoluteMatrixComparisons: comparisons,
    tolerance: { translationM: 1e-6, orientationRad: 1e-6 },
    worstObserved: { translationM: worstTranslationM, orientationRad: worstOrientationRad },
  }, null, 2));
}

await main();
