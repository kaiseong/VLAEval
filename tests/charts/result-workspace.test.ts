import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { jobSchema } from "../../src/contracts";
import { Results } from "../../src/client/Results";
import { initialWorkspaceSelection, ResultWorkspace } from "../../src/client/results/ResultWorkspace";

function fixtureJob(name: "rby1-16" | "irregular-frames" | "scalar-padding") {
  const scalar = name === "scalar-padding";
  const frames = scalar ? [0, 1] : name === "irregular-frames" ? [0, 3, 9] : [0, 1, 2];
  const actionNames = scalar ? ["action_0"] : [
    ...Array.from({ length: 7 }, (_, i) => `right_arm_${i}`),
    ...Array.from({ length: 7 }, (_, i) => `left_arm_${i}`), "right_gripper_0", "left_gripper_0",
  ];
  const predicted = frames.map((_, i) => actionNames.map(() => scalar ? i * 2 : 0.1));
  const target = frames.map(() => actionNames.map(() => 0));
  return jobSchema.parse({
    id: "00000000-0000-4000-8000-000000000017", status: "completed", createdAt: "2026-10-05T00:00:00.000Z",
    request: { host: "qa@localhost", repo: "/qa", config: "qa_fixture", checkpoint: "/qa/checkpoint",
      dataset: "/qa/dataset", episodes: [3], maxSamples: 0, stride: 1, seed: 0, numSteps: 10 },
    progress: { completed: frames.length, total: frames.length, message: "Fixture" }, logs: [], error: null,
    result: {
      config: "qa_fixture", checkpoint: "/qa/checkpoint", dataset: "/qa/dataset", seed: 0, numSteps: 10,
      framesEvaluated: frames.length, validSteps: scalar ? 3 : frames.length, actionNames, fps: 30,
      mae: scalar ? 4 : 0.1, rmse: scalar ? Math.sqrt(104 / 3) : 0.1,
      firstStepMae: scalar ? 1 : 0.1, firstStepRmse: scalar ? Math.sqrt(2) : 0.1,
      perEpisode: [{ episode: 3, framesEvaluated: frames.length, mae: scalar ? 1 : 0.1, rmse: scalar ? Math.sqrt(2) : 0.1 }],
      perDimension: actionNames.map((name) => ({ name, mae: scalar ? 4 : 0.1, rmse: scalar ? Math.sqrt(104 / 3) : 0.1 })),
      perHorizon: [], traces: [{ episode: 3, frames, predicted, target }], samples: [],
      latencyMs: { median: 20, p95: 22 }, warnings: [],
    },
  });
}

test("initial selection retains original irregular frames rather than row indices", () => {
  const job = jobSchema.parse(fixtureJob("irregular-frames"));
  if (!job.result) throw new Error("Fixture missing result");
  const selection = initialWorkspaceSelection(job.id, 3, job.result);
  expect(selection).toEqual({
    jobId: job.id, episode: 3, sourceFrame: 0, window: { startFrame: 0, endFrame: 9 },
    chunkOrigin: 0, chunkHorizon: 0, dimension: 0,
  });
});

test("same episode in a different run initializes all selection fields from new frames", () => {
  const job = jobSchema.parse(fixtureJob("irregular-frames"));
  if (!job.result) throw new Error("Fixture missing result");
  const result = { ...job.result, traces: [{ ...job.result.traces[0], episode: 3, frames: [12, 18], predicted: [[1], [2]], target: [[0], [0]] }] };
  const selection = initialWorkspaceSelection("new-job", 3, result);
  expect(selection.sourceFrame).toBe(12);
  expect(selection.window).toEqual({ startFrame: 12, endFrame: 18 });
  expect(selection.chunkOrigin).toBe(12);
  expect(selection.chunkHorizon).toBe(0);
  expect(selection.dimension).toBe(0);
});

test("missing episode initializes explicit unavailable cursor without borrowing another trace", () => {
  const job = jobSchema.parse(fixtureJob("irregular-frames"));
  if (!job.result) throw new Error("Fixture missing result");
  expect(initialWorkspaceSelection(job.id, 99, job.result).sourceFrame).toBeNull();
});

test("default workspace mounts all sixteen real channel sliders with one selection", () => {
  const job = jobSchema.parse(fixtureJob("rby1-16"));
  const html = renderToStaticMarkup(createElement(Results, { job }));
  expect((html.match(/class="overview-panel"/g) ?? []).length).toBe(16);
  expect((html.match(/role="slider"/g) ?? []).length).toBe(16);
  const plots = html.match(/<figure[^>]*>/g) ?? [];
  expect(plots.filter((tag) => tag.includes('data-source-frame="0" data-window-start="0" data-window-end="2"')).length).toBe(16);
  expect(html).toContain('data-view="overview"');
  expect(html).not.toContain('data-fk-channel=');
  expect(html).toContain('data-export="json"');
  expect(html).toContain('data-export="csv"');
  expect(html).not.toContain('<details class="result-provenance" open');
});

test("first-step panel statistics do not use run chunk metrics", () => {
  const job = jobSchema.parse(fixtureJob("scalar-padding"));
  if (!job.result) throw new Error("Fixture missing result");
  const before = structuredClone(job.result);
  const html = renderToStaticMarkup(createElement(ResultWorkspace, { job, result: job.result }));
  const panel = html.match(/data-mae="([^"]+)" data-rmse="([^"]+)"/);
  expect(Number(panel?.[1])).toBe(1);
  expect(Number(panel?.[2])).toBe(Math.sqrt(2));
  expect(job.result.mae).toBe(4);
  expect(job.result).toEqual(before);
});

test("job errors stay outside collapsed provenance", () => {
  const job = jobSchema.parse(fixtureJob("rby1-16"));
  const html = renderToStaticMarkup(createElement(Results, { job: { ...job, error: "saved result error" } }));
  expect(html.indexOf('role="alert"')).toBeGreaterThan(0);
  expect(html.indexOf('role="alert"')).toBeLessThan(html.indexOf('<details'));
});
