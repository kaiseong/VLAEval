import type { CompiledProfile } from "./contracts";
import {
  axisRotation, KinematicsError, multiplyTransforms, originTransform, poseFromTransform,
  type Pose, type Quaternion, type Vector3,
} from "./math";

type PreparedJoint = {
  readonly origin: Float64Array;
  readonly axis: Vector3 | null;
};
export type JacobianColumn = readonly [number, number, number, number, number, number];

// Checked indexing keeps matrix dimensions explicit without assertions or zero fill.
export function numberAt(values: ArrayLike<number>, index: number): number {
  const value = values[index];
  if (value === undefined || !Number.isFinite(value)) throw new KinematicsError("nonfinite");
  return value;
}

export function prepareInverseChain(chain: CompiledProfile["leftChain"]): readonly PreparedJoint[] {
  return chain.map((joint) => ({
    origin: originTransform(joint.origin),
    axis: joint.type === "fixed" ? null : joint.axis,
  }));
}

/** Spatial geometric Jacobian, columns in revolute order, rows [linear; angular].
 * Internal numerical surface exposed for finite-difference verification.
 */
export function evaluateInverseChain(chain: readonly PreparedJoint[], joints: readonly number[]) {
  let transform = originTransform({ xyz: [0, 0, 0], rpy: [0, 0, 0] });
  const frames: { readonly position: Vector3; readonly axis: Vector3 }[] = [];
  for (const joint of chain) {
    transform = multiplyTransforms(transform, joint.origin);
    if (joint.axis === null) continue;
    const norm = Math.hypot(...joint.axis);
    const [x, y, z] = joint.axis;
    const axis: Vector3 = [
      (numberAt(transform, 0) * x + numberAt(transform, 1) * y + numberAt(transform, 2) * z) / norm,
      (numberAt(transform, 4) * x + numberAt(transform, 5) * y + numberAt(transform, 6) * z) / norm,
      (numberAt(transform, 8) * x + numberAt(transform, 9) * y + numberAt(transform, 10) * z) / norm,
    ];
    frames.push({ position: [numberAt(transform, 3), numberAt(transform, 7), numberAt(transform, 11)], axis });
    transform = multiplyTransforms(transform, axisRotation(joint.axis, numberAt(joints, frames.length - 1)));
  }
  const pose = poseFromTransform(transform);
  const columns = frames.map(({ position: [x, y, z], axis: [a, b, c] }): JacobianColumn => {
    const dx = pose.translationM[0] - x, dy = pose.translationM[1] - y, dz = pose.translationM[2] - z;
    return [b * dz - c * dy, c * dx - a * dz, a * dy - b * dx, a, b, c];
  });
  return { pose, columns };
}

export type IkTarget = {
  readonly translationM: Vector3;
  readonly quaternionXyzw: Quaternion;
};

/** Shortest SO(3) logarithm in the root frame; stable at zero and pi. */
export function inverseResidual(current: Pose, target: IkTarget): JacobianColumn {
  const [x, y, z, w] = current.quaternionXyzw, [a, b, c, d] = target.quaternionXyzw;
  // target * conjugate(current), matching the spatial angular Jacobian.
  const vx = w * a - d * x + c * y - b * z;
  const vy = w * b - d * y + a * z - c * x;
  const vz = w * c - d * z + b * x - a * y;
  const scalar = w * d + x * a + y * b + z * c;
  const length = Math.hypot(vx, vy, vz);
  // At exactly pi either axis is valid; choose one independent of quaternion sign.
  const sign = Math.abs(scalar) < 1e-15
    ? (([vx, vy, vz].find((v) => Math.abs(v) > 1e-15) ?? 0) < 0 ? -1 : 1)
    : (scalar < 0 ? -1 : 1);
  const scale = length === 0 ? 0 : sign * 2 * Math.atan2(length, Math.abs(scalar)) / length;
  return [
    target.translationM[0] - current.translationM[0],
    target.translationM[1] - current.translationM[1],
    target.translationM[2] - current.translationM[2],
    vx * scale, vy * scale, vz * scale,
  ];
}

/** J^T (J J^T + lambda^2 I)^-1 e, using a six-row Cholesky solve. */
export function dampedStep(columns: readonly JacobianColumn[], error: JacobianColumn, damping: number): number[] {
  const lower = new Float64Array(36);
  for (let row = 0; row < 6; row++) for (let col = 0; col <= row; col++) {
    let value = row === col ? damping * damping : 0;
    for (const column of columns) value += numberAt(column, row) * numberAt(column, col);
    for (let k = 0; k < col; k++) value -= numberAt(lower, row * 6 + k) * numberAt(lower, col * 6 + k);
    lower[row * 6 + col] = row === col ? Math.sqrt(value) : value / numberAt(lower, col * 6 + col);
  }
  const solution = new Float64Array(6);
  for (let row = 0; row < 6; row++) {
    let value = numberAt(error, row);
    for (let k = 0; k < row; k++) value -= numberAt(lower, row * 6 + k) * numberAt(solution, k);
    solution[row] = value / numberAt(lower, row * 6 + row);
  }
  for (let row = 5; row >= 0; row--) {
    let value = numberAt(solution, row);
    for (let k = row + 1; k < 6; k++) value -= numberAt(lower, k * 6 + row) * numberAt(solution, k);
    solution[row] = value / numberAt(lower, row * 6 + row);
  }
  return columns.map((column) => column.reduce((sum, value, index) => sum + value * numberAt(solution, index), 0));
}
