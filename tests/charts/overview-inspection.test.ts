import { expect, test } from "bun:test";
import { inspectOverviewFrame } from "../../src/client/results/overview-inspection";
import type { OverviewChunk } from "../../src/client/results/overview-inspection";

const series = { frames: [0, 3, 9], predicted: [[10, 20], [30, 40], [50, 60]],
  target: [[1, 2], [3, 4], [5, 6]], fps: 30 };
const chunks: readonly OverviewChunk[] = [
  { frame: 3, predicted: [[30, 40], [31, 41], [32, 42]], target: [[3, 4], [7, 8], [9, 10]], valid: [true, true, false] },
  { frame: 0, predicted: [[10, 20], [11, 21], [12, 22], [13, 23], [14, 24]],
    target: [[1, 2], [2, 3], [3, 4], [4, 5], [7, 8]], valid: [true, true, false, true, true] },
];

test("inspection uses exact overlapping horizon rows and includes undrawn origins", () => {
  const before = structuredClone(chunks);
  const result = inspectOverviewFrame({ frame: 4, dimension: 1, series, chunks, drawnFrames: new Set([3]) });
  expect(result.target).toBe(8);
  expect(result.predictions).toEqual([
    { origin: 0, step: 4, horizon: 5, value: 24, color: "hsl(220 75% 45%)", drawn: false },
    { origin: 3, step: 1, horizon: 3, value: 41, color: "hsl(0 75% 45%)", drawn: true },
  ]);
  expect(chunks).toEqual(before);
});

test("invalid masked rows, missing steps and irregular trace gaps are not interpolated", () => {
  for (const frame of [2, 5, 6, 100]) {
    const result = inspectOverviewFrame({ frame, dimension: 0, series, chunks, drawnFrames: new Set() });
    expect(result).toEqual({ target: null, firstStep: null, predictions: [] });
  }
});

test("scored GT takes precedence over overlapping chunk references", () => {
  const result = inspectOverviewFrame({ frame: 3, dimension: 1, series, chunks, drawnFrames: new Set([0, 3]) });
  expect(result.target).toBe(4);
  expect(result.predictions.map((prediction) => prediction.value)).toEqual([23, 40]);
});

test("inspection includes more predictions than the display cap without losing precision", () => {
  const many = Array.from({ length: 60 }, (_, frame) => ({
    frame, predicted: Array.from({ length: 61 }, () => [0.12345678901234567]),
    target: Array.from({ length: 61 }, () => [0]), valid: Array.from({ length: 61 }, () => true),
  }));
  const result = inspectOverviewFrame({ frame: 60, dimension: 0, series, chunks: many, drawnFrames: new Set([0]) });
  expect(result.predictions).toHaveLength(60);
  expect(result.predictions[59]).toEqual({
    origin: 59, step: 1, horizon: 61, value: 0.12345678901234567, color: "hsl(0 75% 45%)", drawn: false,
  });
});

test("legacy traces expose only exact first-step values", () => {
  expect(inspectOverviewFrame({ frame: 3, dimension: 1, series, chunks: [], drawnFrames: new Set() }))
    .toEqual({ target: 4, firstStep: 40, predictions: [] });
  expect(inspectOverviewFrame({ frame: 4, dimension: 1, series, chunks: [], drawnFrames: new Set() }))
    .toEqual({ target: null, firstStep: null, predictions: [] });
});
