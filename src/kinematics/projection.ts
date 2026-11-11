export type CameraProjection = {
  readonly width: number;
  readonly height: number;
  readonly fx: number;
  readonly fy: number;
  readonly cx: number;
  readonly cy: number;
  readonly distortion:
    | { readonly kind: "none" }
    | { readonly kind: "brown_conrady"; readonly coefficients: readonly [number, number, number, number, number] };
  /** Row-major rigid transform on column vectors: reference meters -> optical +x right, +y down, +z forward. */
  readonly cameraFromReference: readonly number[];
};

export type PointProjection =
  | { readonly kind: "visible"; readonly u: number; readonly v: number; readonly depthM: number }
  | { readonly kind: "unavailable"; readonly reason: "nonfinite_point" | "behind_camera" | "outside_image" | "invalid_projection" };

export type TrajectoryProjection = PointProjection
  | { readonly kind: "gap"; readonly reason: "missing_point" | "masked" };

/**
 * Numeric validation after the caller's schema parse. No calibration repair.
 * Rotation dot products and determinant use absolute tolerance 1e-8, as in math.ts.
 * The homogeneous last row must be exactly [0, 0, 0, 1].
 */
export function validateCameraProjection(camera: CameraProjection): string | null {
  if (!Number.isInteger(camera.width) || camera.width <= 0 ||
      !Number.isInteger(camera.height) || camera.height <= 0) return "invalid_dimensions";
  if (![camera.fx, camera.fy, camera.cx, camera.cy].every(Number.isFinite) ||
      camera.fx <= 0 || camera.fy <= 0) return "invalid_intrinsics";
  switch (camera.distortion.kind) {
    case "none": break;
    case "brown_conrady":
      if (camera.distortion.coefficients.length !== 5 ||
          !camera.distortion.coefficients.every(Number.isFinite)) return "invalid_distortion";
      break;
    default: {
      const exhaustive: never = camera.distortion;
      return exhaustive;
    }
  }
  const m = camera.cameraFromReference;
  if (m.length !== 16 || !Array.from(m).every(Number.isFinite)) return "invalid_transform";
  const [a, b, c, , d, e, f, , g, h, i] = m;
  if (a === undefined || b === undefined || c === undefined ||
      d === undefined || e === undefined || f === undefined ||
      g === undefined || h === undefined || i === undefined) return "invalid_transform";
  const checks = [
    a * a + d * d + g * g - 1, b * b + e * e + h * h - 1, c * c + f * f + i * i - 1,
    a * b + d * e + g * h, a * c + d * f + g * i, b * c + e * f + h * i,
    a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g) - 1,
  ];
  if (checks.some((value) => !Number.isFinite(value) || Math.abs(value) > 1e-8) ||
      m[12] !== 0 || m[13] !== 0 || m[14] !== 0 || m[15] !== 1) return "invalid_transform";
  return null;
}

/**
 * Caller validates the camera once before projection. Pixels stay subpixel:
 * visible iff 0 <= u < width and 0 <= v < height (no rounding or clipping).
 * Brown-Conrady coefficient order is [k1, k2, p1, p2, k3].
 */
export function projectPoint(point: readonly [number, number, number], camera: CameraProjection): PointProjection {
  if (!point.every(Number.isFinite)) return { kind: "unavailable", reason: "nonfinite_point" };
  const [px, py, pz] = point;
  const [a, b, c, tx, d, e, f, ty, g, h, i, tz] = camera.cameraFromReference;
  if (a === undefined || b === undefined || c === undefined || tx === undefined ||
      d === undefined || e === undefined || f === undefined || ty === undefined ||
      g === undefined || h === undefined || i === undefined || tz === undefined) {
    return { kind: "unavailable", reason: "invalid_projection" };
  }
  const xM = a * px + b * py + c * pz + tx;
  const yM = d * px + e * py + f * pz + ty;
  const depthM = g * px + h * py + i * pz + tz;
  if (![xM, yM, depthM].every(Number.isFinite)) return { kind: "unavailable", reason: "invalid_projection" };
  if (depthM <= 0) return { kind: "unavailable", reason: "behind_camera" };
  const x = xM / depthM, y = yM / depthM;
  if (![x, y].every(Number.isFinite)) return { kind: "unavailable", reason: "invalid_projection" };
  let xd = x, yd = y;
  switch (camera.distortion.kind) {
    case "none": break;
    case "brown_conrady": {
      const [k1, k2, p1, p2, k3] = camera.distortion.coefficients;
      const r2 = x * x + y * y;
      const radial = 1 + k1 * r2 + k2 * r2 * r2 + k3 * r2 * r2 * r2;
      xd = x * radial + 2 * p1 * x * y + p2 * (r2 + 2 * x * x);
      yd = y * radial + p1 * (r2 + 2 * y * y) + 2 * p2 * x * y;
      break;
    }
    default: {
      const exhaustive: never = camera.distortion;
      return exhaustive;
    }
  }
  const u = camera.fx * xd + camera.cx, v = camera.fy * yd + camera.cy;
  if (![u, v].every(Number.isFinite)) return { kind: "unavailable", reason: "invalid_projection" };
  if (u < 0 || u >= camera.width || v < 0 || v >= camera.height) {
    return { kind: "unavailable", reason: "outside_image" };
  }
  return { kind: "visible", u, v, depthM };
}

/**
 * One result per input row in original order; gap/unavailable rows are never
 * removed, interpolated, or bridged. A missing validity entry is masked.
 * Null takes precedence over the mask; surplus validity entries are ignored.
 */
export function projectTrajectory(
  points: readonly (readonly [number, number, number] | null)[],
  valid: readonly boolean[],
  camera: CameraProjection,
): TrajectoryProjection[] {
  return points.map((point, index) => {
    if (point === null) return { kind: "gap", reason: "missing_point" };
    if (valid[index] !== true) return { kind: "gap", reason: "masked" };
    return projectPoint(point, camera);
  });
}
