import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { jobSchema } from "../../src/contracts";
import { CoverageSummary } from "../../src/client/results/CoverageSummary";
import { ResultWorkspace } from "../../src/client/results/ResultWorkspace";
import { resultFixture } from "../result-fixture";

const boundaries = [
  { episode: 100, frames: 100, full: 61, tail: 39, valid: 61, rows: 3220, last: 99 },
  { episode: 40, frames: 40, full: 1, tail: 39, valid: 1, rows: 820, last: 39 },
  { episode: 10, frames: 10, full: 0, tail: 10, valid: 0, rows: 55, last: 9 },
  { episode: 1, frames: 1, full: 0, tail: 1, valid: 0, rows: 1, last: 0 },
] as const;

function renderCoverage(item: (typeof boundaries)[number]) {
  const result = {
    ...resultFixture,
    validSteps: item.rows,
    coverage: {
      horizon: 40,
      episodes: [{
        episode: item.episode,
        originalFrames: item.frames,
        scoredAnchors: item.frames,
        geometricFullAnchors: item.full,
        fullyValidChunks: item.valid,
        geometricTailAnchors: item.tail,
        validRows: item.rows,
        validRowsByHorizon: Array.from({ length: 40 }, (_, offset) => Math.max(item.frames - offset, 0)),
      }],
      scoredAnchors: item.frames,
      geometricFullAnchors: item.full,
      fullyValidChunks: item.valid,
      geometricTailAnchors: item.tail,
      validRows: item.rows,
      validRowsByHorizon: Array.from({ length: 40 }, (_, offset) => Math.max(item.frames - offset, 0)),
    },
  };
  return renderToStaticMarkup(createElement(CoverageSummary, {
    result,
    request: { stride: 1, maxSamples: 0 },
    episode: item.episode,
    frames: Array.from({ length: item.frames }, (_, frame) => frame),
  }));
}

for (const item of boundaries) {
  test(`coverage summary shows exact full and tail counts for N=${item.frames}, H=40`, () => {
    // Given: recorded worker coverage for this episode and every scored frame.
    // When: the Results workspace coverage summary renders.
    const html = renderCoverage(item);

    // Then: original length, both coverage scopes, and the last anchor stay exact.
    expect(html).toContain('data-coverage-known="recorded"');
    expect(html).toContain(`data-scored-anchors="${item.frames}"`);
    expect(html).toContain(`data-original-frames="${item.frames}"`);
    expect(html).toContain(`data-geometric-full="${item.full}"`);
    expect(html).toContain(`data-geometric-tail="${item.tail}"`);
    expect(html).toContain(`data-fully-valid="${item.valid}"`);
    expect(html).toContain(`data-valid-rows="${item.rows}"`);
    expect(html).toContain('data-coverage-scope="first-step"');
    expect(html).toContain('data-coverage-scope="future-chunk"');
    expect(html).toContain('data-warmup-excluded="true"');
    expect(html).toContain(`data-last-scored-frame="${item.last}"`);
    expect(html).toContain('data-subset="false"');
  });
}

test("coverage summary keeps geometric-full separate from interior mask validity", () => {
  // Given: one geometrically full chunk contains an interior invalid action row.
  const result = {
    ...resultFixture,
    validSteps: 5,
    coverage: {
      horizon: 3,
      episodes: [{
        episode: 30, originalFrames: 3, scoredAnchors: 3, geometricFullAnchors: 1,
        fullyValidChunks: 0, geometricTailAnchors: 2, validRows: 5, validRowsByHorizon: [3, 1, 1],
      }],
      scoredAnchors: 3, geometricFullAnchors: 1, fullyValidChunks: 0, geometricTailAnchors: 2,
      validRows: 5, validRowsByHorizon: [3, 1, 1],
    },
  };

  // When: the selected episode summary renders.
  const html = renderToStaticMarkup(createElement(CoverageSummary, {
    result, request: { stride: 1, maxSamples: 0 }, episode: 30, frames: [0, 1, 2],
  }));

  // Then: geometry, fully valid chunks and actual mask-valid rows remain distinct.
  expect(html).toContain('data-geometric-full="1"');
  expect(html).toContain('data-geometric-tail="2"');
  expect(html).toContain('data-fully-valid="0"');
  expect(html).toContain('data-valid-rows="5"');
});

test("legacy quick subsets keep original length and mask coverage unknown", () => {
  // Given: an old three-anchor trace has no additive coverage record.
  const result = { ...resultFixture, validSteps: 3 };

  // When: its saved request records a stride and maximum-sample subset.
  const html = renderToStaticMarkup(createElement(CoverageSummary, {
    result, request: { stride: 2, maxSamples: 3 }, episode: 3, frames: [0, 2, 4],
  }));

  // Then: the last source frame is shown without inferring a five-frame episode.
  expect(html).toContain('data-coverage-known="unknown"');
  expect(html).toContain('data-scored-anchors="3"');
  expect(html).toContain('data-original-frames="unknown"');
  expect(html).toContain('data-geometric-full="unknown"');
  expect(html).toContain('data-geometric-tail="unknown"');
  expect(html).toContain('data-fully-valid="unknown"');
  expect(html).toContain('data-valid-rows="unknown"');
  expect(html).toContain('data-original-length-known="false"');
  expect(html).toContain('data-mask-validity="unknown"');
  expect(html).toContain('data-subset-stride="2"');
  expect(html).toContain('data-subset-max-samples="3"');
  expect(html).toContain('data-last-scored-frame="4"');
  expect(html).not.toContain('data-original-frames="5"');
});

test("workspace uses recorded episode count when legacy display trace is missing", () => {
  // Given: a schema-valid legacy result with a recorded episode count but no trace or coverage.
  const job = jobSchema.parse({
    id: "00000000-0000-4000-8000-000000000019",
    status: "completed",
    createdAt: "2026-10-05T00:00:00.000Z",
    request: {
      host: "qa@localhost", repo: "/qa", config: "legacy", checkpoint: "/qa/checkpoint",
      dataset: "/qa/dataset", episodes: [3], maxSamples: 0, stride: 1, seed: 0, numSteps: 10,
    },
    progress: { completed: 3, total: 3, message: "Legacy fixture" },
    logs: [],
    result: {
      ...resultFixture,
      validSteps: 3,
      perEpisode: [{ episode: 3, framesEvaluated: 3, mae: 0.1, rmse: 0.1 }],
      traces: [],
      coverage: undefined,
    },
    error: null,
  });
  if (!job.result) throw new Error("Legacy result fixture is missing");

  // When: the actual Results workspace renders the selected legacy episode.
  const html = renderToStaticMarkup(createElement(ResultWorkspace, { job, result: job.result }));

  // Then: the recorded scored count wins, while original length and masks stay unknown.
  expect(html).toContain('data-scored-anchors="3"');
  expect(html).toContain('data-original-frames="unknown"');
  expect(html).toContain('data-original-length-known="false"');
  expect(html).toContain('data-mask-validity="unknown"');
  expect(html).toContain('data-last-scored-frame="unknown"');
});
