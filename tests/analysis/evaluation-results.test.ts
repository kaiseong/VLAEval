import { expect, test } from "bun:test";
import { resultSchema } from "../../src/contracts";
import { getEpisodeChunkMetrics } from "../../src/client/analysis/evaluation-results";
import { resultFixture } from "../result-fixture";

function legacyResult() {
  const samples = [
    { episode: 2, frame: 4, prompt: "", predicted: [[1, 2], [3, 4], [999, 999]],
      target: [[0, 0], [0, 0], [0, 0]], valid: [true, true, false] },
    { episode: 2, frame: 7, prompt: "", predicted: [[5, 6], [999, 999], [999, 999]],
      target: [[0, 0], [0, 0], [0, 0]], valid: [true, false, false] },
    { episode: 9, frame: 0, prompt: "", predicted: [[10, 10], [999, 999], [999, 999]],
      target: [[0, 0], [0, 0], [0, 0]], valid: [true, false, false] },
  ];
  const episodes = [
    { episode: 2, originalFrames: 8, scoredAnchors: 2, geometricFullAnchors: 1,
      fullyValidChunks: 0, geometricTailAnchors: 1, validRows: 3, validRowsByHorizon: [2, 1, 0] },
    { episode: 9, originalFrames: 1, scoredAnchors: 1, geometricFullAnchors: 0,
      fullyValidChunks: 0, geometricTailAnchors: 1, validRows: 1, validRowsByHorizon: [1, 0, 0] },
  ];
  return resultSchema.parse({
    ...resultFixture, framesEvaluated: 3, validSteps: 4, samples,
    perEpisode: [{ episode: 2, framesEvaluated: 2, mae: 99, rmse: 99 },
      { episode: 9, framesEvaluated: 1, mae: 99, rmse: 99 }],
    traces: [2, 9].map((episode) => ({
      episode, frames: samples.filter((s) => s.episode === episode).map((s) => s.frame),
      predicted: samples.filter((s) => s.episode === episode).map((s) => s.predicted[0]),
      target: samples.filter((s) => s.episode === episode).map((s) => s.target[0]),
    })),
    perHorizon: [0, 1, 2].map((step) => ({ step, count: [3, 1, 0][step], mae: 0, rmse: 0 })),
    coverage: { horizon: 3, episodes, scoredAnchors: 3, geometricFullAnchors: 1,
      fullyValidChunks: 0, geometricTailAnchors: 2, validRows: 4, validRowsByHorizon: [3, 1, 0] },
  });
}

test("reconstructs complete legacy chunks with unequal episode lengths and invalid padded rows", () => {
  // Given
  const result = legacyResult();
  // When
  const metrics = getEpisodeChunkMetrics(result);
  // Then
  expect(metrics[0]).toEqual({ episode: 2, framesEvaluated: 2, validSteps: 3,
    mae: 3.5, mse: 91 / 6, rmse: Math.sqrt(91 / 6), reason: null });
  expect(metrics[1]).toEqual({ episode: 9, framesEvaluated: 1, validSteps: 1,
    mae: 10, mse: 100, rmse: 10, reason: null });
});

test("reconstructs complete legacy chunks without optional coverage", () => {
  // Given
  const { coverage, ...result } = legacyResult();
  // When
  const metrics = getEpisodeChunkMetrics(result);
  // Then
  expect(metrics.map((item) => item.mse)).toEqual([91 / 6, 100]);
});

test("prefers stored chunk metrics and leaves missing episodes unavailable", () => {
  // Given
  const result = legacyResult();
  result.samples = [];
  const stored = { episode: 2, framesEvaluated: 2, validSteps: 7, mae: 4, mse: 25, rmse: 5 };
  result.perEpisodeChunks = [stored];
  // When
  const metrics = getEpisodeChunkMetrics(result);
  // Then
  expect(metrics[0]).toEqual({ ...stored, reason: null });
  expect(metrics[1]?.mse).toBeNull();
  expect(metrics[1]?.reason).not.toBeNull();
});

const corruptions = {
  truncated: (r: ReturnType<typeof legacyResult>) => { r.samples.splice(0, 1); },
  duplicateSample: (r: ReturnType<typeof legacyResult>) => { if (r.samples[0]) r.samples[1] = r.samples[0]; },
  wrongAnchor: (r: ReturnType<typeof legacyResult>) => { if (r.samples[0]) r.samples[0].frame = 5; },
  duplicateTrace: (r: ReturnType<typeof legacyResult>) => { if (r.traces[0]) r.traces[0].frames = [4, 4]; },
  missingTrace: (r: ReturnType<typeof legacyResult>) => { r.traces.shift(); },
  missingSummary: (r: ReturnType<typeof legacyResult>) => { r.perEpisode.shift(); },
  maskLength: (r: ReturnType<typeof legacyResult>) => { r.samples[0]?.valid.pop(); },
  maskedFirst: (r: ReturnType<typeof legacyResult>) => { if (r.samples[0]) r.samples[0].valid[0] = false; },
  maskCounts: (r: ReturnType<typeof legacyResult>) => { if (r.samples[0]) r.samples[0].valid[1] = false; },
  validRows: (r: ReturnType<typeof legacyResult>) => { if (r.coverage?.episodes[0]) r.coverage.episodes[0].validRows++; },
  horizonCounts: (r: ReturnType<typeof legacyResult>) => {
    if (r.coverage?.episodes[0]) r.coverage.episodes[0].validRowsByHorizon = [2, 0, 1];
  },
  width: (r: ReturnType<typeof legacyResult>) => { r.samples[0]?.predicted[1]?.pop(); },
  horizon: (r: ReturnType<typeof legacyResult>) => { r.samples[0]?.target.pop(); },
  traceValues: (r: ReturnType<typeof legacyResult>) => { if (r.traces[0]?.predicted[0]) r.traces[0].predicted[0][0] = 500; },
};
for (const [name, corrupt] of Object.entries(corruptions)) {
  test(`leaves legacy metrics unavailable when ${name} prevents proof`, () => {
    // Given
    const result = legacyResult();
    // Avoid shared first-row references between synthetic samples and traces.
    const input = structuredClone(result);
    corrupt(input);
    // When
    const metrics = getEpisodeChunkMetrics(input);
    // Then
    expect(metrics.find((item) => item.episode === 2)).toMatchObject({
      validSteps: null, mae: null, mse: null, rmse: null,
    });
    expect(metrics.find((item) => item.episode === 2)?.reason).not.toBeNull();
    expect(metrics.find((item) => item.episode === 9)?.mse).toBe(100);
  });
}

test("enumerates episodes from every identity source even without metrics", () => {
  // Given
  const result = legacyResult();
  result.perEpisode = [{ episode: 1, framesEvaluated: 7, mae: 1, rmse: 1 }];
  result.traces = [{ episode: 3, frames: [10], predicted: [[0, 0]], target: [[0, 0]] }];
  result.samples = result.samples.filter((item) => item.episode === 9);
  if (result.coverage) result.coverage.episodes = result.coverage.episodes.filter((item) => item.episode === 2);
  // When
  const metrics = getEpisodeChunkMetrics(result);
  // Then
  expect(metrics.map((item) => item.episode)).toEqual([1, 2, 3, 9]);
  expect(metrics.every((item) => item.mse === null && item.reason !== null)).toBe(true);
});
