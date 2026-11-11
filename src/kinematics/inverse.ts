import { z } from "zod";
import { compiledProfileSchema, type CompiledProfile } from "./contracts";
import { forwardChain } from "./forward";
import { KinematicsError, rotationError } from "./math";
import {
  dampedStep, evaluateInverseChain, inverseResidual, numberAt, prepareInverseChain,
  type IkTarget, type JacobianColumn,
} from "./inverse-math";

export type IkResult =
  | { readonly kind: "ready"; readonly joints: readonly number[]; readonly positionErrorM: number;
      readonly orientationErrorRad: number; readonly iterations: number }
  | { readonly kind: "unavailable"; readonly reason: string };

const finite = z.number().finite();
const seedSchema = z.array(finite).length(7);
const targetSchema = z.object({
  translationM: z.tuple([finite, finite, finite]),
  quaternionXyzw: z.tuple([finite, finite, finite, finite])
    .refine((q) => Math.abs(Math.hypot(...q) - 1) <= 1e-6),
});
const profileShape = compiledProfileSchema.innerType().shape;
const chainSchema = z.union([profileShape.leftChain, profileShape.rightChain]);
const positionTolerance = 1e-4, orientationTolerance = 1e-3, maxIterations = 160;
const unavailable = (reason: string): IkResult => ({ kind: "unavailable", reason });
// Metres per radian only conditions the search, never the success thresholds.
const weighted = ([x, y, z, a, b, c]: JacobianColumn): JacobianColumn => [x, y, z, 0.3 * a, 0.3 * b, 0.3 * c];
const cost = (error: JacobianColumn) => Math.hypot(...weighted(error));

/**
 * Local, deterministic, seeded IK in link_torso_5, metres and radians.
 * Seed/output follow chain revolute order. Out-of-bounds seeds are rejected,
 * not clamped or wrapped; no alternate seeds, random restarts, or invented limits.
 * `ready` certifies fresh FK residuals and inclusive bounds, not joint identity,
 * global reachability, collision clearance, or a safe physical trajectory.
 * Failure to converge returns no best-effort joint vector.
 */
export function solveInverse(
  chain: CompiledProfile["leftChain"],
  target: { readonly translationM: readonly [number, number, number];
    readonly quaternionXyzw: readonly [number, number, number, number] },
  seed: readonly number[],
): IkResult {
  const admittedChain = chainSchema.safeParse(chain);
  const admittedTarget = targetSchema.safeParse(target), admittedSeed = seedSchema.safeParse(seed);
  if (!admittedChain.success) return unavailable("invalid_chain");
  if (!admittedTarget.success) return unavailable("invalid_target");
  if (!admittedSeed.success) return unavailable("invalid_seed");
  const bounded: { readonly name: string; readonly lower: number; readonly upper: number }[] = [];
  for (const joint of admittedChain.data) {
    switch (joint.type) {
      case "fixed": break;
      case "revolute":
        if (joint.limit === undefined) return unavailable(`missing_limits:${joint.name}`);
        bounded.push({ name: joint.name, ...joint.limit });
        break;
      default: {
        const exhaustive: never = joint;
        return exhaustive;
      }
    }
  }
  const inside = (values: readonly number[]) => bounded.every(({ lower, upper }, i) => {
    const value = values[i];
    return value !== undefined && Number.isFinite(value) && value >= lower && value <= upper;
  });
  if (!inside(admittedSeed.data)) return unavailable("seed_out_of_bounds");
  // Normalize only admitted quaternion roundoff, as FK does for unit axes.
  const [x, y, z, w] = admittedTarget.data.quaternionXyzw;
  const norm = Math.hypot(x, y, z, w);
  const goal: IkTarget = { translationM: admittedTarget.data.translationM, quaternionXyzw: [x / norm, y / norm, z / norm, w / norm] };
  const prepared = prepareInverseChain(admittedChain.data);
  let joints = admittedSeed.data;
  let damping = 0.01;
  try {
    for (let iterations = 0; iterations <= maxIterations; iterations++) {
      const current = evaluateInverseChain(prepared, joints);
      const error = inverseResidual(current.pose, goal);
      // Far translations need sustained damping: a near-undamped first step from
      // a straight arm can pin the elbow on its upper limit in the wrong basin.
      // Small horizon updates retain low damping, without changing the seed.
      // Do not over-damp pure wrist rotations, including half-turns.
      if (iterations === 0) damping = Math.max(0.01, Math.min(0.5, Math.hypot(error[0], error[1], error[2])));
      if (Math.hypot(error[0], error[1], error[2]) <= positionTolerance &&
          Math.hypot(error[3], error[4], error[5]) <= orientationTolerance) {
        // Independent production FK is the final authority, including fixed tools.
        const pose = forwardChain(admittedChain.data, new Map(bounded.map(({ name }, i) => [name, numberAt(joints, i)])));
        const positionErrorM = Math.hypot(...pose.translationM.map((value, i) => value - numberAt(goal.translationM, i)));
        const orientationErrorRad = rotationError(pose.quaternionXyzw, goal.quaternionXyzw);
        return inside(joints) && positionErrorM <= positionTolerance && orientationErrorRad <= orientationTolerance
          ? { kind: "ready", joints, positionErrorM, orientationErrorRad, iterations }
          : unavailable("residual_check_failed");
      }
      if (iterations === maxIterations) break;
      const columns = current.columns.map(weighted), residual = weighted(error);
      let accepted = false;
      for (let attempt = 0; attempt < 7 && !accepted; attempt++) {
        const active = bounded.map(() => true);
        let step = bounded.map(() => 0);
        // Remove outward-moving boundary joints and re-solve for the remaining DOFs.
        // Each pass removes at least one column; seven joints need at most eight.
        for (let pass = 0; pass <= 7; pass++) {
          step = dampedStep(columns.map((column, i) => active[i] ? column : [0, 0, 0, 0, 0, 0]), residual, damping);
          let blocked = false;
          bounded.forEach(({ lower, upper }, i) => {
            const value = numberAt(joints, i), delta = numberAt(step, i);
            if (active[i] && ((value <= lower + 1e-12 && delta < 0) || (value >= upper - 1e-12 && delta > 0))) {
              active[i] = false;
              blocked = true;
            }
          });
          if (!blocked) break;
        }
        const scale = Math.min(1, 0.25 / Math.max(...step.map(Math.abs)));
        for (let search = 0; search < 10; search++) {
          const alpha = scale * 2 ** -search;
          const candidate = bounded.map(({ lower, upper }, i) =>
            Math.max(lower, Math.min(upper, numberAt(joints, i) + alpha * numberAt(step, i))));
          const next = inverseResidual(evaluateInverseChain(prepared, candidate).pose, goal);
          if (cost(next) < cost(error)) {
            joints = candidate;
            damping = Math.max(1e-5, damping * 0.9);
            accepted = true;
            break;
          }
        }
        if (!accepted) damping = Math.min(10, damping * 4);
      }
      if (!accepted) return unavailable("stalled");
    }
    return unavailable("iteration_limit");
  } catch (error) {
    if (!(error instanceof KinematicsError)) throw error;
    return unavailable(`numerical_failure:${error.reason}`);
  }
}
