import { readFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";
import type { CompiledProfile } from "../../src/kinematics/contracts";
import { forwardChain } from "../../src/kinematics/forward";
import { solveInverse, type IkResult } from "../../src/kinematics/inverse";
import { evaluateInverseChain, prepareInverseChain } from "../../src/kinematics/inverse-math";
import { rotationError, type Pose } from "../../src/kinematics/math";
import { compileUrdfProfile } from "../../src/kinematics/urdf";

type Chain = CompiledProfile["leftChain"];
// Position limits from rby1-pose-studio/assets/models/rby1m/urdf/model_v1.2.urdf.
// Supplied in test XML only: old FK fixtures deliberately have no limits.
function profile(model = "m") {
  const xml = readFileSync(new URL(`../fixtures/urdf/rby1${model}-v1.2.urdf`, import.meta.url), "utf8");
  const bounded = xml.replace(/<joint name="(right|left)_arm_(\d)" type="revolute">/g, (tag, side: string, index: string) => {
    const lower = index === "1" && side === "left" ? -0.017453293
      : index === "3" ? -2.617993878 : index === "5" ? -1.570796327 : index === "6" ? -2.705260340 : -3.141592654;
    const upper = (index === "1" && side === "right") || index === "3" ? 0.017453293
      : index === "5" ? 1.919862177 : index === "6" ? 2.705260340 : 3.141592654;
    return `${tag}<limit lower="${lower}" upper="${upper}" />`;
  });
  return compileUrdfProfile(bounded, { sourcePath: "bounded-fixture", model, revision: "v1.2" });
}
const profiles = [profile("a"), profile("m")];
const fixture = profiles[1];
if (fixture === undefined) throw new Error("Missing fixture");
const right = fixture.rightChain;
const seed = [-0.6, -0.4, 0.25, -1.1, -0.3, 0.5, 0.2];
function fk(chain: Chain, joints: readonly number[]): Pose {
  return forwardChain(chain, new Map(chain.filter((joint) => joint.type === "revolute")
    .map((joint, index) => {
      const value = joints[index];
      if (value === undefined) throw new Error("Incomplete test joints");
      return [joint.name, value];
    })));
}
function assertSolved(chain: Chain, target: Pose, result: IkResult) {
  if (result.kind !== "ready") throw new Error(`IK unavailable: ${result.reason}`);
  const pose = fk(chain, result.joints);
  const dp = Math.hypot(...pose.translationM.map((value, i) => value - (target.translationM[i] ?? NaN)));
  const dr = rotationError(pose.quaternionXyzw, target.quaternionXyzw);
  expect(dp).toBeLessThanOrEqual(1e-4);
  expect(dr).toBeLessThanOrEqual(1e-3);
  expect(result.positionErrorM).toBeCloseTo(dp, 13);
  expect(result.orientationErrorRad).toBeCloseTo(dr, 13);
  expect(result.joints).toHaveLength(7);
  expect(Number.isInteger(result.iterations)).toBe(true);
  expect(result.iterations).toBeLessThanOrEqual(160);
  chain.filter((joint) => joint.type === "revolute").forEach((joint, i) => {
    if (joint.limit === undefined) throw new Error("Test needs limits");
    expect(result.joints[i]).toBeGreaterThanOrEqual(joint.limit.lower);
    expect(result.joints[i]).toBeLessThanOrEqual(joint.limit.upper);
  });
}

describe("bounded seeded offline IK", () => {
  for (const model of profiles) for (const side of ["right", "left"] as const) {
    test(`solves nonzero FK targets with distinct seeds for ${model.model} ${side}`, () => {
      // Given varying reachable nonzero poses, not joint-vector equality.
      const chain = model[`${side}Chain`], direction = side === "right" ? -1 : 1;
      for (let i = 0; i < 12; i++) {
        const q = [-0.8 + i * 0.1, direction * (0.25 + i * 0.04), 0.3 * Math.sin(i),
          -0.7 - i * 0.08, -0.4 + i * 0.05, 0.4 + i * 0.04, -0.5 + i * 0.08];
        const start = q.map((value, j) => value + 0.15 * Math.cos(i + j));
        const target = fk(chain, q);
        // When solving from another configuration, then independent FK agrees.
        assertSolved(chain, target, solveInverse(chain, target, start));
      }
    });
  }

  test("matches finite-difference FK Jacobians with rotated fixed intermediate and tool offsets", () => {
    for (const side of ["right", "left"] as const) {
      // Given asymmetric arms and an additional nontrivial fixed transform.
      const chain = structuredClone(fixture[`${side}Chain`]);
      const second = chain[1];
      if (second === undefined) throw new Error("Missing joint");
      chain.splice(1, 0, { name: "mount", type: "fixed", parentLink: second.parentLink,
        childLink: "mount_link", origin: { xyz: [0.02, -0.01, 0.03], rpy: [0.2, -0.1, 0.3] } });
      second.parentLink = "mount_link";
      const q = seed.map((v, i) => i === 1 && side === "left" ? -v : v);
      // When evaluating the analytic Jacobian, compare every column with central differences.
      const state = evaluateInverseChain(prepareInverseChain(chain), q), h = 1e-6;
      state.columns.forEach((column, j) => {
        const plus = fk(chain, q.map((v, i) => v + (i === j ? h : 0)));
        const minus = fk(chain, q.map((v, i) => v - (i === j ? h : 0)));
        for (let row = 0; row < 3; row++) {
          expect(column[row]).toBeCloseTo(((plus.translationM[row] ?? NaN) - (minus.translationM[row] ?? NaN)) / (2 * h), 7);
        }
        const [a, b, c, d] = plus.quaternionXyzw, [x, y, z, w] = minus.quaternionXyzw;
        const sign = a * x + b * y + c * z + d * w < 0 ? -1 : 1;
        const angular = [w * a - d * x + c * y - b * z, w * b - d * y + a * z - c * x, w * c - d * z + b * x - a * y];
        angular.forEach((value, row) => expect(column[row + 3]).toBeCloseTo(sign * value / h, 7));
      });
      const target = fk(chain, q.map((v) => v + 0.08));
      assertSolved(chain, target, solveInverse(chain, target, q));
    }
  });

  test("converges from singular straight-arm seeds on both arms", () => {
    // Given a straight wrist with coincident axes and near-limit shoulders.
    for (const side of ["right", "left"] as const) {
      const chain = fixture[`${side}Chain`];
      const target = fk(chain, [-0.4, side === "right" ? -0.3 : 0.3, 0.2, -0.8, -0.2, 0.4, 0.3]);
      // When starting at the singular configuration, then damping remains finite.
      assertSolved(chain, target, solveInverse(chain, target, [0, 0, 0, 0, 0, 0, 0]));
    }
  });

  for (const angle of [Math.PI - 1e-7, Math.PI, Math.PI + 1e-7]) {
    test(`solves a wrist rotation near pi (${angle}) without Euler errors`, () => {
      // Given a half-turn target with a valid nonzero seed.
      const start = seed.map((v, i) => i === 6 ? -1.6 : v);
      const target = fk(right, start.map((v, i) => i === 6 ? v + angle : v));
      // When the rotation logarithm is near pi, then FK still certifies the solution.
      assertSolved(right, target, solveInverse(right, target, start));
    });
  }

  test("respects inclusive joint limits at the requested boundary pose", () => {
    const q = seed.map((v, i) => i === 6 ? 2.705260340 : v), target = fk(right, q);
    assertSolved(right, target, solveInverse(right, target, q.map((v, i) => i === 6 ? v - 0.1 : v)));
  });

  test("rejects best-effort residuals even just outside either success threshold", () => {
    // Given all seven joints locked, only the seed pose is feasible.
    const locked = right.map((joint, i) => joint.type === "fixed" ? joint
      : { ...joint, limit: { lower: seed[i] ?? NaN, upper: seed[i] ?? NaN } });
    const pose = fk(locked, seed);
    const rotated = fk(right, seed.map((v, i) => i === 6 ? v + 0.0011 : v));
    for (const target of [rotated, { ...pose, translationM: [pose.translationM[0] + 0.00011, pose.translationM[1], pose.translationM[2]] as const }]) {
      const result = solveInverse(locked, target, seed);
      expect(result.kind).toBe("unavailable");
      expect("joints" in result).toBe(false);
    }
    assertSolved(locked, pose, solveInverse(locked, pose, seed));
  });

  test("rejects an unreachable distant target without returning approximate joints", () => {
    const result = solveInverse(right, { translationM: [10, -10, 10], quaternionXyzw: [0, 0, 0, 1] }, seed);
    expect(result.kind).toBe("unavailable");
    expect("joints" in result).toBe(false);
  });

  test("rejects missing bounds and out-of-bounds seeds even at their exact FK pose", () => {
    const missing = right.map((joint) => {
      if (joint.type === "fixed") return joint;
      const { limit: _limit, ...legacy } = joint;
      return legacy;
    });
    expect(solveInverse(missing, fk(right, seed), seed).kind).toBe("unavailable");
    const outside = seed.map((v, i) => i === 1 ? 0.1 : v);
    expect(solveInverse(right, fk(right, outside), outside).kind).toBe("unavailable");
  });

  test("rejects malformed runtime seeds targets and bounds honestly", () => {
    const target = fk(right, seed);
    const badSeeds: readonly unknown[] = [null, [], seed.slice(1), [...seed, 0], seed.map((v, i) => i === 0 ? NaN : v), Array(7), "0000000"];
    for (const bad of badSeeds) expect(Reflect.apply(solveInverse, undefined, [right, target, bad])).toMatchObject({ kind: "unavailable" });
    const badTargets: readonly unknown[] = [null, {}, { ...target, translationM: [0, 1] },
      { ...target, translationM: [Infinity, 0, 0] }, { ...target, quaternionXyzw: [0, 0, 0, 0] },
      { ...target, quaternionXyzw: [0, 0, 0, 2] }, { ...target, quaternionXyzw: [NaN, 0, 0, 1] }];
    for (const bad of badTargets) expect(Reflect.apply(solveInverse, undefined, [right, bad, seed])).toMatchObject({ kind: "unavailable" });
    for (const limit of [{ lower: 1, upper: -1 }, { lower: -Infinity, upper: 1 }]) {
      const chain = right.map((j) => j.type === "fixed" ? j : { ...j, limit });
      expect(solveInverse(chain, target, seed).kind).toBe("unavailable");
    }
  });

  test("is deterministic and preserves chain seed and target without implicit restarts", () => {
    const chain = structuredClone(right), start = [...seed], target = fk(chain, seed.map((v) => v + 0.1));
    const before = structuredClone({ chain, start, target });
    const first = solveInverse(chain, target, start);
    assertSolved(chain, target, first);
    expect(solveInverse(chain, target, start)).toEqual(first);
    expect({ chain, start, target }).toEqual(before);
    const exact = solveInverse(chain, fk(chain, start), start);
    expect(exact).toMatchObject({ kind: "ready", joints: start, iterations: 0 });
  });

  test("treats quaternion antipodes as the same target", () => {
    const target = fk(right, seed.map((v) => v + 0.1)), [x, y, z, w] = target.quaternionXyzw;
    const positive = solveInverse(right, target, seed);
    const negative = solveInverse(right, { ...target, quaternionXyzw: [-x, -y, -z, -w] }, seed);
    assertSolved(right, target, positive);
    expect(negative).toEqual(positive);
  });
});
