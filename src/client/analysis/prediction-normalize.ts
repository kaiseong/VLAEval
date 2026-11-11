import { KinematicsError, originTransform, poseFromTransform, type Pose } from "../../kinematics/math";
import type { PredictionSource } from "./prediction-contracts";

export type Side = "left" | "right";
export type Issue = (reason: string) => void;
export type CartesianSource = Extract<PredictionSource, { kind: "cartesian" }>;
export type TargetPose = Pick<Pose, "translationM" | "quaternionXyzw">;

export function finiteComponent(value: number, issue: Issue): number | null {
  if (Number.isFinite(value)) return value;
  issue("nonfinite_component");
  return null;
}

export function sourceValue(row: readonly number[], index: number): number {
  const value = row[index];
  if (value === undefined) throw new RangeError("Missing admitted source component");
  return value;
}

export function gripper(row: readonly number[], source: PredictionSource, side: Side): number | null {
  const index = source[side].gripper;
  return index === null ? null : sourceValue(row, index);
}

/** Fixed XYZ RPY uses Rz(yaw) Ry(pitch) Rx(roll), the trusted FK convention. */
export function cartesianArm(row: readonly number[], source: CartesianSource, side: Side, issue: Issue) {
  const mapping = source[side];
  const component = (indices: readonly number[], i: number) => {
    const index = indices[i];
    if (index === undefined) throw new RangeError("Missing admitted orientation mapping");
    return sourceValue(row, index);
  };
  const xyz = (i: number) => component(mapping.position, i) * (source.positionUnit === "mm" ? 0.001 : 1);
  const translationM: [number, number, number] = [xyz(0), xyz(1), xyz(2)];
  const positionMm = [0, 1, 2].map((i) =>
    finiteComponent(component(mapping.position, i) * (source.positionUnit === "m" ? 1000 : 1), issue));
  let rotation: Pose | null = null;
  try {
    switch (source.orientation.kind) {
      case "rpy_xyz": {
        const factor = source.orientation.unit === "deg" ? Math.PI / 180 : 1;
        rotation = poseFromTransform(originTransform({
          xyz: [0, 0, 0],
          rpy: [component(mapping.rotation, 0) * factor, component(mapping.rotation, 1) * factor,
            component(mapping.rotation, 2) * factor],
        }));
        break;
      }
      case "quaternion_xyzw": {
        const x = component(mapping.rotation, 0), y = component(mapping.rotation, 1);
        const z = component(mapping.rotation, 2), w = component(mapping.rotation, 3);
        const norm = Math.hypot(x, y, z, w);
        if (Math.abs(norm - 1) > 1e-6) throw new KinematicsError("invalid_rotation");
        // Only normalize already-unit quaternion roundoff, never repair invalid input.
        const a = x / norm, b = y / norm, c = z / norm, d = w / norm;
        rotation = poseFromTransform(new Float64Array([
          1 - 2 * (b * b + c * c), 2 * (a * b - c * d), 2 * (a * c + b * d), 0,
          2 * (a * b + c * d), 1 - 2 * (a * a + c * c), 2 * (b * c - a * d), 0,
          2 * (a * c - b * d), 2 * (b * c + a * d), 1 - 2 * (a * a + b * b), 0,
          0, 0, 0, 1,
        ]));
        break;
      }
      default: { const exhaustive: never = source.orientation; return exhaustive; }
    }
  } catch (error) {
    if (!(error instanceof KinematicsError)) throw error;
    issue(error.reason);
  }
  const rpyFactor = source.orientation.kind === "rpy_xyz" && source.orientation.unit === "rad"
    ? 180 / Math.PI : 1;
  const rpyDeg = source.orientation.kind === "rpy_xyz"
    ? [0, 1, 2].map((i) => finiteComponent(component(mapping.rotation, i)
      * rpyFactor, issue))
    : rotation?.rpyDeg ?? [null, null, null];
  if (source.orientation.kind === "quaternion_xyzw"
    && rotation && rpyDeg.some((value) => value === null)) issue("singular_rpy");
  const pose: TargetPose | null = rotation && translationM.every(Number.isFinite)
    ? { translationM, quaternionXyzw: rotation.quaternionXyzw } : null;
  return { display: [...positionMm, ...rpyDeg, gripper(row, source, side)], pose };
}
