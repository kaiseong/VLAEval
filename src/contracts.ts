import { z } from "zod";

export const hostSchema = z.string().regex(
  /^[a-zA-Z0-9_][a-zA-Z0-9_.-]*@[a-zA-Z0-9][a-zA-Z0-9.-]*$/,
  "SSH 대상은 user@hostname 형식이어야 합니다.",
).max(200);
const pathSchema = z.string().min(1).max(4096).refine(
  (value) => value.startsWith("/") && !/[\u0000\r\n]/.test(value),
  "절대 경로를 입력하세요.",
);
const scanPathSchema = z.string().min(1).max(4096).refine(
  (value) => (value.startsWith("/") || value.startsWith("~/")) && !/[\u0000\r\n]/.test(value),
  "탐색 경로는 / 또는 ~/로 시작해야 합니다.",
);
export const connectionSchema = z.object({ host: hostSchema, repo: pathSchema });
export const discoverRequestSchema = z.object({
  host: hostSchema,
  roots: z.array(scanPathSchema).min(1).max(16),
});
export const jobRequestSchema = connectionSchema.extend({
  config: z.string().min(1).max(200),
  checkpoint: pathSchema,
  dataset: pathSchema,
  episodes: z.array(z.number().int().nonnegative()).min(1).max(10000),
  maxSamples: z.number().int().min(0).max(1000000).default(0),
  stride: z.number().int().min(1).max(100000).default(1),
  seed: z.number().int().min(0).max(2147483647).default(0),
  numSteps: z.number().int().min(1).max(100).default(10),
});
export type JobRequest = z.infer<typeof jobRequestSchema>;
const metric = z.number().finite().nonnegative();
export const discoverySchema = z.object({
  repositories: z.array(z.object({ path: z.string(), python: z.string() })),
  checkpoints: z.array(z.object({
    path: z.string(), format: z.string(), step: z.string().nullable(),
  })),
  datasets: z.array(z.object({
    path: z.string(), name: z.string(), episodes: z.number(), frames: z.number(),
    fps: z.number(), version: z.string(),
  })),
  warnings: z.array(z.string()),
});
export const configsSchema = z.object({
  configs: z.array(z.object({
    name: z.string(), repoId: z.string().nullable(),
    actionDim: z.number().int(), actionHorizon: z.number().int(),
  })),
  revision: z.string(),
});
export const episodesRequestSchema = connectionSchema.extend({ dataset: pathSchema });
export const episodesSchema = z.object({
  episodes: z.array(z.object({
    index: z.number().int().nonnegative(),
    length: z.number().int().nonnegative(),
    tasks: z.array(z.string()),
  })),
  fps: z.number().positive(),
  version: z.string(),
});
export const resultSchema = z.object({
  config: z.string(), checkpoint: z.string(), dataset: z.string(),
  seed: z.number(), numSteps: z.number(), framesEvaluated: z.number().int(),
  validSteps: z.number().int(), actionNames: z.array(z.string()), fps: z.number().positive(),
  perEpisode: z.array(z.object({
    episode: z.number().int(), framesEvaluated: z.number().int(), mae: metric, rmse: metric,
  })),
  traces: z.array(z.object({
    episode: z.number().int(), frames: z.array(z.number().int()),
    predicted: z.array(z.array(z.number().finite())),
    target: z.array(z.array(z.number().finite())),
  })),
  perDimension: z.array(z.object({ name: z.string(), mae: metric, rmse: metric })),
  perHorizon: z.array(z.object({
    step: z.number().int(), count: z.number().int(), mae: metric.nullable(), rmse: metric.nullable(),
  })),
  coverage: z.object({
    horizon: z.number().int(),
    episodes: z.array(z.object({
      episode: z.number().int(), originalFrames: z.number().int(), scoredAnchors: z.number().int(),
      geometricFullAnchors: z.number().int(), fullyValidChunks: z.number().int(),
      geometricTailAnchors: z.number().int(), validRows: z.number().int(),
      validRowsByHorizon: z.array(z.number().int()),
    })),
    scoredAnchors: z.number().int(), geometricFullAnchors: z.number().int(),
    fullyValidChunks: z.number().int(), geometricTailAnchors: z.number().int(),
    validRows: z.number().int(), validRowsByHorizon: z.array(z.number().int()),
  }).optional(),
  mae: metric, rmse: metric, firstStepMae: metric, firstStepRmse: metric,
  latencyMs: z.object({ median: metric, p95: metric }),
  samples: z.array(z.object({
    episode: z.number().int(), frame: z.number().int(), prompt: z.string(),
    predicted: z.array(z.array(z.number().finite())),
    target: z.array(z.array(z.number().finite())), valid: z.array(z.boolean()),
  })),
  warnings: z.array(z.string()),
});
export const progressSchema = z.object({
  completed: z.number().int(), total: z.number().int(), message: z.string(),
});
export const workerEventSchema = z.discriminatedUnion("type", [
  discoverySchema.extend({ type: z.literal("discovery") }),
  configsSchema.extend({ type: z.literal("configs") }),
  episodesSchema.extend({ type: z.literal("episodes") }),
  z.object({ type: z.literal("started"), pid: z.number().int().min(2) }),
  progressSchema.extend({ type: z.literal("progress") }),
  z.object({ type: z.literal("result"), result: resultSchema }),
  z.object({ type: z.literal("error"), message: z.string() }),
  z.object({ type: z.literal("cancelled") }),
]);
export type WorkerEvent = z.infer<typeof workerEventSchema>;
export const jobSchema = z.object({
  id: z.string().uuid(),
  status: z.enum(["queued", "running", "completed", "failed", "cancelled"]),
  createdAt: z.string(),
  request: jobRequestSchema,
  progress: progressSchema,
  logs: z.array(z.string()),
  result: resultSchema.nullable(),
  error: z.string().nullable(),
});
export type Job = z.infer<typeof jobSchema>;
