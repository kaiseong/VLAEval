import { jobSchema } from "../src/contracts";

/** Synthetic, intentionally unequal episode lengths and masked horizons. */
export function evaluationFixture(index: number, scale = 1) {
  const samples = [
    { episode: 3, frame: 0, predicted: [[scale], [3 * scale]], target: [[0], [0]], valid: [true, true], prompt: "" },
    { episode: 3, frame: 1, predicted: [[2 * scale], [100 * scale]], target: [[0], [0]], valid: [true, false], prompt: "" },
    { episode: 9, frame: 0, predicted: [[4 * scale], [6 * scale]], target: [[0], [0]], valid: [true, true], prompt: "" },
  ];
  return jobSchema.parse({
    id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    status: "completed", createdAt: "2026-10-15T00:00:00Z",
    request: { host: "qa@localhost", repo: "/qa", config: `model_${index}`, checkpoint: `/qa/model_${index}/100`,
      dataset: "/qa/dataset", episodes: [3, 9], maxSamples: 0, stride: 1, seed: 0, numSteps: 10 },
    progress: { completed: 3, total: 3, message: "Synthetic fixture" }, logs: [], error: null,
    result: {
      config: `model_${index}`, checkpoint: `/qa/model_${index}/100`, dataset: "/qa/dataset",
      seed: 0, numSteps: 10, fps: 30, framesEvaluated: 3, validSteps: 5, actionNames: ["action_0"],
      mae: 16 / 5 * scale, mse: 66 / 5 * scale ** 2, rmse: Math.sqrt(66 / 5) * scale,
      firstStepMae: 7 / 3 * scale, firstStepMse: 7 * scale ** 2, firstStepRmse: Math.sqrt(7) * scale,
      perEpisode: [
        { episode: 3, framesEvaluated: 2, mae: 1.5 * scale, mse: 2.5 * scale ** 2, rmse: Math.sqrt(2.5) * scale },
        { episode: 9, framesEvaluated: 1, mae: 4 * scale, mse: 16 * scale ** 2, rmse: 4 * scale },
      ],
      traces: [
        { episode: 3, frames: [0, 1], predicted: [[scale], [2 * scale]], target: [[0], [0]] },
        { episode: 9, frames: [0], predicted: [[4 * scale]], target: [[0]] },
      ],
      perDimension: [{ name: "action_0", mae: 16 / 5 * scale, mse: 66 / 5 * scale ** 2, rmse: Math.sqrt(66 / 5) * scale }],
      perHorizon: [
        { step: 0, count: 3, mae: 7 / 3 * scale, mse: 7 * scale ** 2, rmse: Math.sqrt(7) * scale },
        { step: 1, count: 2, mae: 4.5 * scale, mse: 22.5 * scale ** 2, rmse: Math.sqrt(22.5) * scale },
      ], samples, latencyMs: { median: 1, p95: 1 }, warnings: ["Synthetic numeric fixture, not model performance."],
    },
  });
}
