import { describe, expect, test } from "bun:test";
import { projectPoint, projectTrajectory, validateCameraProjection, type CameraProjection } from "../../src/kinematics/projection";

const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] as const;
const camera: CameraProjection = {
  width: 640, height: 480, fx: 200, fy: 300, cx: 320, cy: 240,
  distortion: { kind: "none" }, cameraFromReference: identity,
};

describe("camera validation", () => {
  test("accepts finite off-center intrinsics and rigid transforms", () => {
    // Given a 90-degree rotation about Z and arbitrary meter translation.
    const input: CameraProjection = { ...camera, cx: -10, cy: 900,
      cameraFromReference: [0, -1, 0, 1, 1, 0, 0, -2, 0, 0, 1, 3, 0, 0, 0, 1] };
    // When / Then: principal point need not lie in the image.
    expect(validateCameraProjection(input)).toBeNull();
  });

  test.each([
    { width: 0 }, { height: -1 }, { width: 1.5 }, { height: Infinity },
    { fx: 0 }, { fy: -1 }, { fx: Infinity }, { fy: NaN }, { cx: NaN }, { cy: Infinity },
  ])("rejects invalid dimensions or intrinsics %j", (patch) => {
    // Given a single invalid calibration scalar.
    const input = { ...camera, ...patch };
    // When / Then.
    expect(validateCameraProjection(input)).not.toBeNull();
  });

  test.each([
    [2, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], // scale
    [1, 0.1, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], // shear
    [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, -1, 0, 0, 0, 0, 1], // reflection
    [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0.01, 1],
    [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 2],
    [1, 0, 0, Infinity, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
    Array(16).fill(1e308), [], identity.slice(0, 15), [...identity, 0],
  ])("rejects nonrigid, nonfinite, or wrong-size matrix %#", (...matrix) => {
    // Given a matrix which cannot map rigid reference coordinates.
    const input = { ...camera, cameraFromReference: matrix };
    // When / Then.
    expect(validateCameraProjection(input)).not.toBeNull();
  });

  test("accepts rotation roundoff inside the tolerance", () => {
    // Given a column whose squared-norm error is below 1e-8.
    const matrix = [...identity];
    const input = { ...camera, cameraFromReference: matrix.map((v, i) => i === 0 ? 1 + 1e-10 : v) };
    // When / Then.
    expect(validateCameraProjection(input)).toBeNull();
  });

  test("rejects nonorthogonal columns with determinant one", () => {
    // Given a matrix with determinant one but compensating scale/shear.
    const input = { ...camera, cameraFromReference: [1, 1, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] };
    // When / Then.
    expect(validateCameraProjection(input)).not.toBeNull();
  });

  test.each([NaN, Infinity, -Infinity])("rejects nonfinite Brown-Conrady coefficient %s", (coefficient) => {
    // Given correctly shaped but nonfinite distortion.
    const input: CameraProjection = { ...camera,
      distortion: { kind: "brown_conrady", coefficients: [0, 0, coefficient, 0, 0] } };
    // When / Then.
    expect(validateCameraProjection(input)).not.toBeNull();
  });

  test("accepts all five signed Brown-Conrady coefficients", () => {
    // Given finite radial/tangential coefficients.
    const input: CameraProjection = { ...camera,
      distortion: { kind: "brown_conrady", coefficients: [0.1, -0.2, 0.01, -0.02, 0.03] } };
    // When / Then.
    expect(validateCameraProjection(input)).toBeNull();
  });
});

describe("point projection", () => {
  test("projects off-axis optical coordinates with unequal focal lengths", () => {
    // Given x/z=0.25 and y/z=-0.125 in optical camera coordinates.
    const point = [1, -0.5, 4] as const;
    // When.
    const result = projectPoint(point, camera);
    // Then.
    expect(result).toEqual({ kind: "visible", u: 370, v: 202.5, depthM: 4 });
  });

  test("applies reference-to-camera rotation then translation without inversion", () => {
    // Given Rz(90deg) plus [1,-2,3]: [2,3,1] maps to [-2,0,4].
    const input = { ...camera, cameraFromReference: [0, -1, 0, 1, 1, 0, 0, -2, 0, 0, 1, 3, 0, 0, 0, 1] };
    // When.
    const result = projectPoint([2, 3, 1], input);
    // Then.
    expect(result).toEqual({ kind: "visible", u: 220, v: 240, depthM: 4 });
  });

  test("uses all radial and tangential terms in Brown-Conrady order", () => {
    // Given x=.5, y=.25, r²=.3125; independently evaluated:
    // radial=1.01263427734375, xd=.492567138671875, yd=.2525335693359375.
    const input: CameraProjection = { ...camera,
      distortion: { kind: "brown_conrady", coefficients: [0.1, -0.2, 0.01, -0.02, 0.03] } };
    // When.
    const result = projectPoint([1, 0.5, 2], input);
    // Then.
    expect(result.kind).toBe("visible");
    if (result.kind !== "visible") throw new Error("Expected visible analytic point");
    expect(result.u).toBeCloseTo(418.513427734375, 10);
    expect(result.v).toBeCloseTo(315.76007080078125, 10);
    expect(result.depthM).toBe(2);
  });

  test.each([0, -1])("rejects transformed depth %s", (depth) => {
    // Given positive reference depth moved onto/behind the camera plane.
    const input = { ...camera, cameraFromReference: identity.map((v, i) => i === 11 ? depth - 1 : v) };
    // When / Then.
    expect(projectPoint([0, 0, 1], input)).toEqual({ kind: "unavailable", reason: "behind_camera" });
  });

  test.each([
    { point: [0, 0, 1], visible: true }, { point: [639.999, 479.999, 1], visible: true },
    { point: [640, 0, 1], visible: false }, { point: [0, 480, 1], visible: false },
    { point: [-0.001, 0, 1], visible: false }, { point: [0, -0.001, 1], visible: false },
  ] satisfies { point: [number, number, number]; visible: boolean }[])("uses half-open subpixel image bounds %#", ({ point, visible }) => {
    // Given unit intrinsics so meter coordinates at z=1 equal pixel coordinates.
    const input = { ...camera, fx: 1, fy: 1, cx: 0, cy: 0 };
    // When.
    const result = projectPoint(point, input);
    // Then.
    if (visible) expect(result).toEqual({ kind: "visible", u: point[0], v: point[1], depthM: 1 });
    else expect(result).toEqual({ kind: "unavailable", reason: "outside_image" });
  });

  test.each([NaN, Infinity, -Infinity])("rejects nonfinite point %s", (value) => {
    // Given a nonfinite reference coordinate.
    const point = [value, 0, 1] as const;
    // When / Then.
    expect(projectPoint(point, camera)).toEqual({ kind: "unavailable", reason: "nonfinite_point" });
  });

  test.each([
    { point: [1e308, 0, 1], camera },
    { point: [1, 0, Number.MIN_VALUE], camera },
    { point: [1e200, 0, 1], camera: { ...camera, distortion: { kind: "brown_conrady", coefficients: [1, 1, 1, 1, 1] } } },
    { point: [1e308, 0, 1], camera: { ...camera, cameraFromReference: identity.map((v, i) => i === 3 ? 1e308 : v) } },
  ] satisfies { point: [number, number, number]; camera: CameraProjection }[])("rejects numerical overflow %#", (input) => {
    // Given finite inputs overflowing transform, division, distortion, or intrinsics.
    const { point, camera: calibration } = input;
    // When / Then.
    expect(projectPoint(point, calibration)).toEqual({ kind: "unavailable", reason: "invalid_projection" });
  });
});

describe("trajectory projection", () => {
  test("retains row order and explicit gaps without bridging or mutating inputs", () => {
    // Given null, masked, behind-camera, and visible rows interleaved.
    const points = Object.freeze([[0, 0, 1], null, [1, 0, 2], [0, 0, -1], [0.5, 0, 2]] as const);
    const valid = Object.freeze([true, true, false, true, true]);
    // When.
    const result = projectTrajectory(points, valid, camera);
    // Then.
    expect(result).toEqual([
      { kind: "visible", u: 320, v: 240, depthM: 1 },
      { kind: "gap", reason: "missing_point" },
      { kind: "gap", reason: "masked" },
      { kind: "unavailable", reason: "behind_camera" },
      { kind: "visible", u: 370, v: 240, depthM: 2 },
    ]);
  });

  test("masks absent validity entries and preserves null precedence", () => {
    // Given fewer mask entries than points.
    const points = [null, [0, 0, 1]] as const;
    // When.
    const result = projectTrajectory(points, [false], camera);
    // Then.
    expect(result).toEqual([{ kind: "gap", reason: "missing_point" }, { kind: "gap", reason: "masked" }]);
  });

  test("preserves empty trajectories despite surplus mask entries", () => {
    // Given no source rows.
    const points = [] as const;
    // When / Then.
    expect(projectTrajectory(points, [true], camera)).toEqual([]);
  });
});
