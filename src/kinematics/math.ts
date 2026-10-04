export type Vector3 = readonly [number, number, number];
export type Quaternion = readonly [number, number, number, number];
export type Pose = {
  readonly translationM: [number, number, number];
  readonly quaternionXyzw: [number, number, number, number];
  readonly rpyDeg: [number | null, number, number | null];
};

export class KinematicsError extends Error {
  constructor(readonly reason: "missing_joint" | "invalid_rotation" | "nonfinite") {
    super(reason);
    this.name = "KinematicsError";
  }
}

// Row-major homogeneous transforms, composed for column vectors.
function element(matrix: Float64Array, index: number): number {
  const value = matrix[index];
  if (value === undefined) throw new KinematicsError("invalid_rotation");
  return value;
}

export function multiplyTransforms(a: Float64Array, b: Float64Array): Float64Array {
  const out = new Float64Array(16);
  for (let row = 0; row < 4; row++) for (let col = 0; col < 4; col++) {
    let value = 0;
    for (let k = 0; k < 4; k++) value += element(a, row * 4 + k) * element(b, k * 4 + col);
    out[row * 4 + col] = value;
  }
  return out;
}

export function originTransform(origin: { readonly xyz: Vector3; readonly rpy: Vector3 }): Float64Array {
  const [roll, pitch, yaw] = origin.rpy;
  const [x, y, z] = origin.xyz;
  const cr = Math.cos(roll), sr = Math.sin(roll);
  const cp = Math.cos(pitch), sp = Math.sin(pitch);
  const cy = Math.cos(yaw), sy = Math.sin(yaw);
  return new Float64Array([
    cy * cp, cy * sp * sr - sy * cr, cy * sp * cr + sy * sr, x,
    sy * cp, sy * sp * sr + cy * cr, sy * sp * cr - cy * sr, y,
    -sp, cp * sr, cp * cr, z,
    0, 0, 0, 1,
  ]);
}

export function axisRotation(axis: Vector3, angleRad: number): Float64Array {
  if (!Number.isFinite(angleRad) || !axis.every(Number.isFinite)) throw new KinematicsError("nonfinite");
  const norm = Math.hypot(...axis);
  if (Math.abs(norm - 1) > 1e-6) throw new KinematicsError("invalid_rotation");
  // Normalize only admitted unit-axis floating-point roundoff, never joint values.
  const [x, y, z] = axis.map((value) => value / norm);
  if (x === undefined || y === undefined || z === undefined) throw new KinematicsError("invalid_rotation");
  const c = Math.cos(angleRad), s = Math.sin(angleRad), t = 1 - c;
  return new Float64Array([
    c + x * x * t, x * y * t - z * s, x * z * t + y * s, 0,
    y * x * t + z * s, c + y * y * t, y * z * t - x * s, 0,
    z * x * t - y * s, z * y * t + x * s, c + z * z * t, 0,
    0, 0, 0, 1,
  ]);
}

export function poseFromTransform(matrix: Float64Array): Pose {
  if (matrix.length !== 16) throw new KinematicsError("invalid_rotation");
  if (!matrix.every(Number.isFinite)) throw new KinematicsError("nonfinite");
  const a = element(matrix, 0), b = element(matrix, 1), c = element(matrix, 2);
  const d = element(matrix, 4), e = element(matrix, 5), f = element(matrix, 6);
  const g = element(matrix, 8), h = element(matrix, 9), i = element(matrix, 10);
  const determinant = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
  if (Math.abs(determinant - 1) > 1e-8 ||
      Math.abs(a * a + d * d + g * g - 1) > 1e-8 ||
      Math.abs(b * b + e * e + h * h - 1) > 1e-8 ||
      Math.abs(c * c + f * f + i * i - 1) > 1e-8 ||
      Math.abs(a * b + d * e + g * h) > 1e-8 ||
      Math.abs(a * c + d * f + g * i) > 1e-8 ||
      Math.abs(b * c + e * f + h * i) > 1e-8 ||
      element(matrix, 12) !== 0 || element(matrix, 13) !== 0 ||
      element(matrix, 14) !== 0 || element(matrix, 15) !== 1) {
    throw new KinematicsError("invalid_rotation");
  }
  // Largest component avoids trace cancellation at pi (including arbitrary axes).
  const candidates = [1 + a - e - i, 1 - a + e - i, 1 - a - e + i, 1 + a + e + i];
  const largest = Math.max(...candidates);
  const scale = 2 * Math.sqrt(largest);
  let q: [number, number, number, number];
  switch (candidates.indexOf(largest)) {
    case 0: q = [scale / 4, (b + d) / scale, (c + g) / scale, (h - f) / scale]; break;
    case 1: q = [(b + d) / scale, scale / 4, (f + h) / scale, (c - g) / scale]; break;
    case 2: q = [(c + g) / scale, (f + h) / scale, scale / 4, (d - b) / scale]; break;
    case 3: q = [(h - f) / scale, (c - g) / scale, (d - b) / scale, scale / 4]; break;
    default: throw new KinematicsError("invalid_rotation");
  }
  const norm = Math.hypot(...q);
  const cp = Math.hypot(a, d);
  const pitch = Math.atan2(-g, cp);
  const deg = 180 / Math.PI;
  return {
    translationM: [element(matrix, 3), element(matrix, 7), element(matrix, 11)],
    quaternionXyzw: [q[0] / norm, q[1] / norm, q[2] / norm, q[3] / norm],
    rpyDeg: [cp < 1e-6 ? null : Math.atan2(h, i) * deg, pitch * deg, cp < 1e-6 ? null : Math.atan2(d, a) * deg],
  };
}

export function rotationError(predicted: Quaternion, target: Quaternion): number {
  for (const q of [predicted, target]) {
    if (!q.every(Number.isFinite)) throw new KinematicsError("nonfinite");
    if (Math.abs(Math.hypot(...q) - 1) > 1e-6) throw new KinematicsError("invalid_rotation");
  }
  const [x, y, z, w] = predicted, [a, b, c, d] = target;
  // conjugate(predicted) * target; atan2 retains tiny angles without acos clamping.
  const vx = (w * a - x * d) + (z * b - y * c);
  const vy = (w * b - y * d) + (x * c - z * a);
  const vz = (w * c - z * d) + (y * a - x * b);
  const scalar = w * d + x * a + y * b + z * c;
  return 2 * Math.atan2(Math.hypot(vx, vy, vz), Math.abs(scalar));
}
