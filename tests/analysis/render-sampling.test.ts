import { expect, test } from "bun:test";
import { sampleRenderGeometry, MAX_RENDER_VERTICES } from "../../src/client/analysis/render-sampling";
import { createTraceSeries, findExactSourceFrame, firstStepStatistics } from "../../src/client/analysis/series";

function readyGeometry(input: Parameters<typeof sampleRenderGeometry>[0], options: Parameters<typeof sampleRenderGeometry>[1] = {}) {
  const result = sampleRenderGeometry(input, options);
  expect(result.kind).toBe("ready");
  if (result.kind !== "ready") throw new Error(`expected ready geometry, got ${result.kind}`);
  return result;
}

function vertices(segments: readonly (readonly { readonly index: number; readonly frame: number; readonly value: number }[])[]) {
  return segments.flatMap((segment) => segment);
}

test("100000-frame continuous traces retain endpoints and unioned extrema at several budgets", () => {
  const length = 100_000;
  const input = {
    frames: Array.from({ length }, (_, index) => index),
    predicted: Array.from({ length }, (_, index) => index === 12_345 ? 500 : Math.sin(index / 97)),
    target: Array.from({ length }, (_, index) => index === 87_654 ? -700 : Math.cos(index / 113)),
  };
  const original = structuredClone(input);

  for (const vertexBudget of [32, 512, MAX_RENDER_VERTICES]) {
    const geometry = readyGeometry(input, { vertexBudget });
    const pathVertices = [...vertices(geometry.predicted.segments), ...vertices(geometry.target.segments)];
    const sampledIndices = new Set(pathVertices.map(({ index }) => index));
    expect(geometry.vertexCount).toBe(pathVertices.length);
    expect(geometry.vertexCount).toBeLessThanOrEqual(vertexBudget);
    expect(geometry.bucketCount).toBeLessThanOrEqual(Math.floor(vertexBudget / 8));
    expect(sampledIndices.has(0)).toBe(true);
    expect(sampledIndices.has(length - 1)).toBe(true);
    expect(sampledIndices.has(12_345)).toBe(true);
    expect(sampledIndices.has(87_654)).toBe(true);
  }
  expect(input).toEqual(original);
});

test("one-frame spikes beside shared bucket edges survive display reduction", () => {
  const length = 1024;
  const frames = Array.from({ length }, (_, index) => index);
  const predicted = Array.from({ length }, () => 0);
  const target = Array.from({ length }, () => 0);
  predicted[127] = 99;
  target[128] = -99;

  const geometry = readyGeometry({ frames, predicted, target }, { vertexBudget: 64 });

  expect(vertices(geometry.predicted.segments)).toContainEqual({ index: 127, frame: 127, value: 99 });
  expect(vertices(geometry.target.segments)).toContainEqual({ index: 128, frame: 128, value: -99 });
  expect(geometry.vertexCount).toBeLessThanOrEqual(64);
});

test("shared x-domain bucket count follows available pixel width", () => {
  const length = 10_000;
  const input = {
    frames: Array.from({ length }, (_, index) => index * 3),
    predicted: Array.from({ length }, (_, index) => index),
    target: Array.from({ length }, (_, index) => -index),
  };
  const coarse = readyGeometry(input, { pixelWidth: 4 });
  const fine = readyGeometry(input, { pixelWidth: 16 });

  expect(coarse.bucketCount).toBe(4);
  expect(fine.bucketCount).toBe(16);
  expect(fine.vertexCount).toBeGreaterThan(coarse.vertexCount);
  expect(fine.vertexCount).toBeLessThanOrEqual(MAX_RENDER_VERTICES);
});

test("valid irregular frames stay one continuous segment through empty x buckets", () => {
  const geometry = readyGeometry({
    frames: [0, 3, 9],
    predicted: [1, 2, 3],
    target: [4, 5, 6],
  });

  expect(geometry.predicted.segments.map((segment) => segment.map(({ index }) => index))).toEqual([[0, 1, 2]]);
  expect(geometry.target.segments.map((segment) => segment.map(({ index }) => index))).toEqual([[0, 1, 2]]);
});

test("both paths retain the common per-bucket extrema union within the combined budget", () => {
  const geometry = readyGeometry({
    frames: [0, 1, 2, 3, 4, 5, 6, 7],
    predicted: [0, 1, 100, -100, 1, 1, 1, 0],
    target: [0, 1, 1, 1, 1, 200, -200, 0],
  }, { pixelWidth: 1, vertexBudget: 32 });
  const commonIndices = [0, 2, 3, 5, 6, 7];

  expect(geometry.predicted.segments.map((segment) => segment.map(({ index }) => index)))
    .toEqual([commonIndices]);
  expect(geometry.target.segments.map((segment) => segment.map(({ index }) => index)))
    .toEqual([commonIndices]);
  expect(geometry.sourceIndices).toEqual(commonIndices);
  expect(geometry.vertexCount).toBe(12);
  expect(geometry.vertexCount).toBeLessThanOrEqual(32);
});

test("invalid intervals remain separate source-index segments", () => {
  const frames = Array.from({ length: 32 }, (_, index) => index);
  const predicted = frames.map((frame) => frame < 2 || (frame >= 5 && frame < 8) ? frame : null);
  const target = frames.map(() => null);

  const geometry = readyGeometry({ frames, predicted, target }, { vertexBudget: 64 });

  expect(geometry.unavailableBands).toEqual([]);
  expect(geometry.predicted.segments.map((segment) => segment.map(({ index }) => index)))
    .toEqual([[0, 1], [5, 7]]);
  expect(geometry.vertexCount).toBe(4);
});

test("alternating valid and gap intervals use unavailable density bands within budget", () => {
  const length = 2048;
  const frames = Array.from({ length }, (_, index) => index);
  const predicted = frames.map((frame) => frame % 2 === 0 ? frame : null);
  const target = frames.map((frame) => frame % 2 === 1 ? -frame : null);

  const geometry = readyGeometry({ frames, predicted, target }, { vertexBudget: 64 });

  expect(geometry.unavailableBands.length).toBeGreaterThan(0);
  expect(geometry.unavailableBands.every((band) => band.kind === "gap_density_unavailable")).toBe(true);
  expect(geometry.vertexCount).toBeLessThanOrEqual(64);
  expect(geometry.predicted.segments).toEqual([]);
  expect(geometry.target.segments).toEqual([]);
});

test("unavailable middle buckets still split a continuous raw-valid path", () => {
  const frames = Array.from({ length: 90 }, (_, index) => index);
  const predicted = frames.map((frame) => frame === 40 ? 1000 : frame === 50 ? -1000 : frame);
  const target = frames.map((frame) => frame >= 30 && frame < 60 && frame % 2 === 0 ? frame : null);

  const geometry = readyGeometry({ frames, predicted, target }, { pixelWidth: 3, vertexBudget: 48 });

  expect(geometry.unavailableBands).toHaveLength(1);
  expect(geometry.unavailableBands[0]?.kind).toBe("gap_density_unavailable");
  expect(geometry.predicted.segments.map((segment) => segment.map(({ index }) => index)))
    .toEqual([[0, 29], [60, 89]]);
  expect(geometry.target.segments).toEqual([]);
  expect(geometry.vertexCount).toBeLessThanOrEqual(48);
});

test("declared angular wrap thresholds split only the wrapped path", () => {
  const frames = Array.from({ length: 12 }, (_, index) => index);
  const predicted = [170, 175, 179, -179, -175, -170, -165, -160, -155, -150, -145, -140];
  const target = frames.map((frame) => frame);

  const geometry = readyGeometry({ frames, predicted, target }, { vertexBudget: 64, wrapThreshold: 180 });
  const predictedIndexSegments = geometry.predicted.segments.map((segment) => segment.map(({ index }) => index));

  expect(predictedIndexSegments.some((segment) => segment.includes(2) && segment.includes(3))).toBe(false);
  expect(predictedIndexSegments.flat()).toContain(2);
  expect(predictedIndexSegments.flat()).toContain(3);
  expect(geometry.target.segments).toHaveLength(1);
  expect(vertices(geometry.target.segments).map(({ index }) => index)).toEqual([...geometry.sourceIndices]);
});

test("display reduction leaves raw cursor values, metrics, and serialized source unchanged", () => {
  const raw = {
    frames: [0, 3, 9, 12, 15, 18, 21, 24],
    predicted: [[1], [8], [-2], [4], [0], [2], [3], [1]],
    target: [[0], [0], [0], [0], [0], [0], [0], [0]],
    fps: 30,
  };
  const rawBefore = structuredClone(raw);
  const exportBefore = JSON.stringify(raw);
  const parsed = createTraceSeries(raw);
  const beforeMetrics = firstStepStatistics(parsed);
  expect(parsed.kind).toBe("ready");
  if (parsed.kind !== "ready") throw new Error("expected valid raw series");

  const geometry = readyGeometry({
    frames: parsed.series.frames,
    predicted: parsed.series.predicted.map((row) => row[0]),
    target: parsed.series.target.map((row) => row[0]),
  }, { vertexBudget: 8 });
  const cursor = findExactSourceFrame(parsed.series, 9);
  const rawAfter = JSON.stringify(raw);

  expect(geometry.vertexCount).toBeLessThan(parsed.series.frames.length * 2);
  expect(cursor).toEqual({ index: 2, frame: 9 });
  if (cursor === null) throw new Error("expected exact source-frame cursor");
  expect(parsed.series.rows[cursor.index]?.predicted[0]).toBe(-2);
  expect(firstStepStatistics(parsed)).toEqual(beforeMetrics);
  expect(raw).toEqual(rawBefore);
  expect(rawAfter).toBe(exportBefore);
});

test("invalid frames, misaligned paths, and invalid budgets return explicit failures", () => {
  expect(sampleRenderGeometry({ frames: [0, 0], predicted: [1, 2], target: [0, 0] }))
    .toEqual({ kind: "invalid", reason: "invalid_frames" });
  expect(sampleRenderGeometry({ frames: [0], predicted: [1, 2], target: [0] }))
    .toEqual({ kind: "invalid", reason: "misaligned_values" });
  expect(sampleRenderGeometry({ frames: [0], predicted: [1], target: [0] }, { vertexBudget: 0 }))
    .toEqual({ kind: "invalid", reason: "invalid_budget" });
  expect(sampleRenderGeometry({ frames: [0], predicted: [1], target: [0] }, { pixelWidth: 0 }))
    .toEqual({ kind: "invalid", reason: "invalid_pixel_width" });
  expect(sampleRenderGeometry({ frames: [0], predicted: [1], target: [0] }, { wrapThreshold: 0 }))
    .toEqual({ kind: "invalid", reason: "invalid_wrap_threshold" });
});
