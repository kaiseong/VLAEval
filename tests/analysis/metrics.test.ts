import { expect, test } from "bun:test";
import { metricMse, formatMetric } from "../../src/client/analysis/metrics";

test("stored MSE takes precedence and legacy MSE uses unrounded RMSE", () => {
  expect(metricMse(12.5, 3.535534)).toBe(12.5);
  expect(metricMse(undefined, Math.sqrt(12.5))).toBeCloseTo(12.5, 12);
  expect(metricMse(0, 0)).toBe(0);
});

test("missing and unrepresentable MSE stay unavailable", () => {
  expect(metricMse(null, 2)).toBeNull();
  expect(metricMse(undefined, null)).toBeNull();
  expect(metricMse(undefined, 1e200)).toBeNull();
});

test("small nonzero errors remain numerically visible", () => {
  expect(Number(formatMetric(1e-10))).toBe(1e-10);
  expect(Number(formatMetric(0))).toBe(0);
});
