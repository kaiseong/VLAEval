import { fkRequestSchema, type CompiledProfile, type FkResult } from "./contracts";
import { axisRotation, KinematicsError, multiplyTransforms, originTransform, poseFromTransform, rotationError, type Pose } from "./math";

type Arm = FkResult["samples"][number]["arms"]["right"];
type DerivedPose = Arm["pose"]["predicted"];
type PreparedJoint = {
  readonly name: string;
  readonly origin: Float64Array;
  readonly axis: readonly [number, number, number] | null;
};
const unavailablePose = (): DerivedPose => ({ translationM: null, quaternionXyzw: null, rpyDeg: [null, null, null] });

function prepareChain(chain: CompiledProfile["rightChain"]): PreparedJoint[] {
  return chain.map((joint) => {
    switch (joint.type) {
      case "revolute": return { name: joint.name, origin: originTransform(joint.origin), axis: joint.axis };
      case "fixed": return { name: joint.name, origin: originTransform(joint.origin), axis: null };
      default: {
        const exhaustive: never = joint;
        return exhaustive;
      }
    }
  });
}

function evaluateChain(chain: readonly PreparedJoint[], radians: ReadonlyMap<string, number>): Pose {
  let transform = originTransform({ xyz: [0, 0, 0], rpy: [0, 0, 0] });
  for (const joint of chain) {
    transform = multiplyTransforms(transform, joint.origin);
    if (joint.axis !== null) {
      const value = radians.get(joint.name);
      if (value === undefined) throw new KinematicsError("missing_joint");
      transform = multiplyTransforms(transform, axisRotation(joint.axis, value));
    }
  }
  return poseFromTransform(transform);
}

/** Joint values are radians keyed by exact names; all fixed joints remain in order. */
export function forwardChain(chain: CompiledProfile["rightChain"], radians: ReadonlyMap<string, number>): Pose {
  return evaluateChain(prepareChain(chain), radians);
}

function deriveArm(chain: readonly PreparedJoint[], predicted: ReadonlyMap<string, number>, target: ReadonlyMap<string, number>): Arm {
  const reasons: string[] = [];
  const compute = (values: ReadonlyMap<string, number>, label: string): DerivedPose => {
    try {
      return evaluateChain(chain, values);
    } catch (error) {
      if (!(error instanceof KinematicsError)) throw error;
      reasons.push(`${label}:${error.reason}`);
      return unavailablePose();
    }
  };
  const pose = { predicted: compute(predicted, "predicted"), target: compute(target, "target") };
  const p = pose.predicted, t = pose.target;
  if (p.translationM === null || t.translationM === null || p.quaternionXyzw === null || t.quaternionXyzw === null) {
    return { pose, errors: { translationM: null, orientationRad: null }, valid: false, reasons };
  }
  const [px, py, pz] = p.translationM, [tx, ty, tz] = t.translationM;
  const translationM = Math.hypot(px - tx, py - ty, pz - tz);
  const orientationRad = rotationError(p.quaternionXyzw, t.quaternionXyzw);
  if (!Number.isFinite(translationM)) {
    return { pose, errors: { translationM: null, orientationRad: null }, valid: false, reasons: ["pair:nonfinite"] };
  }
  return { pose, errors: { translationM, orientationRad }, valid: true, reasons };
}

function summarize(arms: readonly Arm[]): FkResult["summaries"]["right"] {
  const metric = (key: keyof Arm["errors"]) => {
    let count = 0, mean = 0, rms = 0;
    for (const arm of arms) {
      const value = arm.errors[key];
      if (value === null) continue;
      count++;
      mean += (value - mean) / count;
      rms = Math.hypot(rms * Math.sqrt((count - 1) / count), value / Math.sqrt(count));
    }
    return { mean: count === 0 ? null : mean, rms: count === 0 ? null : rms, count };
  };
  return { translationM: metric("translationM"), orientationRad: metric("orientationRad") };
}

/** Admission rejects malformed raw data; only numerical derivation failures become nullable pairs. */
export function deriveForward(input: unknown): FkResult {
  const request = fkRequestSchema.parse(input);
  const { profile, frames, ...identity } = request;
  const right = prepareChain(profile.rightChain), left = prepareChain(profile.leftChain);
  const factor = request.jointUnit === "deg" ? Math.PI / 180 : 1;
  const radians = (row: readonly number[]) => new Map(request.jointMapping.map((mapping): [string, number] => {
    const value = row[mapping.sourceIndex];
    if (value === undefined) throw new KinematicsError("missing_joint");
    return [mapping.jointName, value * factor];
  }));
  const samples = frames.map(({ frame, predicted, target }) => {
    const p = radians(predicted), t = radians(target);
    return { frame, source: { predicted, target }, arms: { right: deriveArm(right, p, t), left: deriveArm(left, p, t) } };
  });
  return {
    ...identity,
    profile: { model: profile.model, revision: profile.revision, urdfSha256: profile.urdfSha256,
      rootLink: profile.rootLink, tips: profile.tips },
    samples,
    summaries: { right: summarize(samples.map((sample) => sample.arms.right)), left: summarize(samples.map((sample) => sample.arms.left)) },
  };
}

export function translationMm(pose: DerivedPose): [number, number, number] | null {
  if (pose.translationM === null) return null;
  const [x, y, z] = pose.translationM;
  const values: [number, number, number] = [x * 1000, y * 1000, z * 1000];
  return values.every(Number.isFinite) ? values : null;
}

export type AnglePoint = { readonly frame: number; readonly value: number | null };
/** Display geometry only: retain original points and never connect a wrap or unavailable interval. */
export function splitAngleWraps(points: readonly AnglePoint[]): AnglePoint[][] {
  const segments: AnglePoint[][] = [];
  let segment: AnglePoint[] = [];
  let previous: number | null = null;
  for (const point of points) {
    if (point.value === null || !Number.isFinite(point.value)) {
      segment = [];
      previous = null;
      continue;
    }
    if (previous !== null && Math.abs(point.value - previous) > 180) segment = [];
    if (segment.length === 0) segments.push(segment);
    segment.push(point);
    previous = point.value;
  }
  return segments;
}
