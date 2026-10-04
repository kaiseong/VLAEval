import type { z } from "zod";
import { resultSchema } from "../src/contracts";

/** Synthetic numeric fixture for integration tests, never served by the app. */
export const resultFixture: z.infer<typeof resultSchema> = resultSchema.parse({
  config: "qa_fixture", checkpoint: "/qa/checkpoint", dataset: "/qa/dataset",
  seed: 0, numSteps: 10, framesEvaluated: 3, validSteps: 3, fps: 30,
  actionNames: ["right_arm_0", "left_arm_0"],
  mae: 0.1, rmse: 0.1, firstStepMae: 0.1, firstStepRmse: 0.1,
  latencyMs: { median: 20, p95: 22 },
  perDimension: [
    { name: "right_arm_0", mae: 0.1, rmse: 0.1 },
    { name: "left_arm_0", mae: 0.1, rmse: 0.1 },
  ],
  perHorizon: [{ step: 0, count: 3, mae: 0.1, rmse: 0.1 }],
  perEpisode: [{ episode: 3, framesEvaluated: 3, mae: 0.1, rmse: 0.1 }],
  traces: [{
    episode: 3, frames: [0, 1, 2],
    predicted: [[0.1, 0.9], [0.6, 0.4], [1.1, -0.1]],
    target: [[0, 1], [0.5, 0.5], [1, 0]],
  }],
  samples: [{
    episode: 3, frame: 0, prompt: "Synthetic QA fixture, not a trained model result",
    predicted: [[0.1, 0.9]], target: [[0, 1]], valid: [true],
  }],
  warnings: ["Synthetic QA fixture. Not an actual model evaluation."],
});
