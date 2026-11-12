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
export const openpiCheckpointsRequestSchema = z.object({
  host: hostSchema,
  root: scanPathSchema.default("~/.cache/openpi/openpi-assets/checkpoints"),
});
export const datasetuiRequestSchema = z.object({
  host: hostSchema,
  datasetuiContainer: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/).max(128).default("datasetui-api-1"),
  datasetuiRoot: pathSchema.default("/mnt/datasetui-nas/DatasetUI"),
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
  /** Compute with the TensorRT engine in `<checkpoint>/engine/` (targets with `tensorrt` only), not the checkpoint runtime. */
  tensorrt: z.boolean().default(false),
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
export const checkpointCatalogSchema = discoverySchema.pick({ checkpoints: true, warnings: true });
export const datasetuiSchema = z.object({
  datasets: z.array(z.object({
    id: z.string(), path: pathSchema, name: z.string(), storageArea: z.enum(["raw", "derived"]),
    episodes: z.number().int().nonnegative().nullable(), frames: z.number().int().nonnegative().nullable(),
    fps: z.number().finite().nonnegative().nullable(), version: z.string().nullable(),
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
  jointObservations: z.object({
    names: z.array(z.string()).length(14).refine((names) =>
      names.every((name, index) => name === `${index < 7 ? "left" : "right"}_arm_${index % 7}`)),
    unit: z.enum(["rad", "deg"]).nullable(),
    samples: z.array(z.object({
      episode: z.number().int(), frame: z.number().int(),
      positions: z.array(z.number().finite()).length(14),
    })),
  }).optional(),
  perEpisode: z.array(z.object({
    episode: z.number().int(), framesEvaluated: z.number().int(), mae: metric, rmse: metric,
    mse: metric.optional(),
  })),
  // Full-horizon, valid-row-weighted metrics; perEpisode remains first-step only.
  perEpisodeChunks: z.array(z.object({
    episode: z.number().int(), framesEvaluated: z.number().int().nonnegative(),
    validSteps: z.number().int().positive(), mae: metric, mse: metric, rmse: metric,
  })).optional(),
  traces: z.array(z.object({
    episode: z.number().int(), frames: z.array(z.number().int()),
    predicted: z.array(z.array(z.number().finite())),
    target: z.array(z.array(z.number().finite())),
  })),
  perDimension: z.array(z.object({ name: z.string(), mae: metric, rmse: metric, mse: metric.optional() })),
  perHorizon: z.array(z.object({
    step: z.number().int(), count: z.number().int(), mae: metric.nullable(), rmse: metric.nullable(),
    mse: metric.nullable().optional(),
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
  mse: metric.optional(), firstStepMse: metric.optional(),
  latencyMs: z.object({ median: metric, p95: metric }),
  samples: z.array(z.object({
    episode: z.number().int(), frame: z.number().int(), prompt: z.string(),
    predicted: z.array(z.array(z.number().finite())),
    target: z.array(z.array(z.number().finite())), valid: z.array(z.boolean()),
  })),
  /** Engine file a TensorRT run used; absent for runs on the checkpoint's own runtime. */
  tensorrtEngine: z.string().optional(),
  warnings: z.array(z.string()),
});
export const progressSchema = z.object({
  completed: z.number().int(), total: z.number().int(), message: z.string(),
});
export const workerEventSchema = z.discriminatedUnion("type", [
  discoverySchema.extend({ type: z.literal("discovery") }),
  datasetuiSchema.extend({ type: z.literal("datasetui") }),
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
  /** Who started the run (name typed in the UI, peer IP); absent for runs recorded before LAN mode. */
  owner: z.object({ name: z.string().max(40), ip: z.string().max(64) }).optional(),
  progress: progressSchema,
  logs: z.array(z.string()),
  result: resultSchema.nullable(),
  error: z.string().nullable(),
});
export type Job = z.infer<typeof jobSchema>;
export type Result = NonNullable<Job["result"]>;
const jointObservationsSchema = resultSchema.shape.jointObservations.unwrap();
const errorRangeSchema = z.object({
  max: metric, p99: metric,
  at: z.object({ episode: z.number().int(), frame: z.number().int(), step: z.number().int(), dimension: z.string() }),
});
export type ErrorRange = z.infer<typeof errorRangeSchema>;
const traceSchema = resultSchema.shape.traces.element;
/**
 * What the job API sends for a run: every aggregate metric, without the per-frame arrays (traces, samples, joint
 * observations), which reach 400 MB for a stride-1 run. Those are fetched per episode (episodeDataSchema and
 * episodeSamplesSchema); the summary lists the episodes and carries the cross-episode values the browser used to
 * derive from them.
 */
export const resultSummarySchema = resultSchema.omit({ traces: true, samples: true, jointObservations: true }).extend({
  jointObservations: jointObservationsSchema.omit({ samples: true }).optional(),
  /** Episodes with a trace or saved chunks, in the order the run stored them. */
  episodes: z.array(z.object({
    episode: z.number().int(), traceFrames: z.number().int().nonnegative(),
    samples: z.number().int().nonnegative(), observations: z.number().int().nonnegative(),
  })),
  /** getEpisodeChunkMetrics on the full result. */
  episodeChunkMetrics: z.array(z.object({
    episode: z.number().int(), framesEvaluated: z.number().int(), validSteps: z.number().int().nullable(),
    mae: metric.nullable(), mse: metric.nullable(), rmse: metric.nullable(), reason: z.string().nullable(),
  })),
  /**
   * Largest and 99th-percentile (nearest rank) |predicted - target| over every valid chunk row and action dimension
   * (native units, like MAE), for the run and per episode; `at` is where the largest one occurs.
   */
  errorRange: z.object({
    overall: errorRangeSchema.nullable(),
    episodes: z.array(errorRangeSchema.extend({ episode: z.number().int() })),
  }),
  /** SHA-256 of the run-comparison keys (scored frames per episode, full-chunk valid masks) and the chunk count. */
  comparison: z.object({
    scoredFrames: z.string(), validMasks: z.string(), samples: z.number().int().nonnegative(),
  }),
});
export type ResultSummary = z.infer<typeof resultSummarySchema>;
export const jobSummarySchema = jobSchema.extend({ result: resultSummarySchema.nullable() });
export type JobSummary = z.infer<typeof jobSummarySchema>;
export const episodeDataSchema = z.object({
  episode: z.number().int(),
  trace: traceSchema.nullable(),
  /** Null when the run recorded no joint observations. */
  observations: jointObservationsSchema.shape.samples.nullable(),
  samples: z.number().int().nonnegative(),
});
export type EpisodeData = z.infer<typeof episodeDataSchema>;
export const maximumSamplesPage = 500;
export const episodeSamplesSchema = z.object({
  episode: z.number().int(), offset: z.number().int().nonnegative(), total: z.number().int().nonnegative(),
  samples: resultSchema.shape.samples.max(maximumSamplesPage),
});
export type EpisodeSamples = z.infer<typeof episodeSamplesSchema>;
export const jobStorageSchema = z.object({
  directory: pathSchema,
  totalBytes: z.number().int().nonnegative(),
  runs: z.array(z.object({
    id: z.string().uuid(),
    bytes: z.number().int().nonnegative().nullable(),
    deletable: z.boolean(),
  })),
});
export type JobStorage = z.infer<typeof jobStorageSchema>;
export const sessionSchema = z.object({ local: z.boolean(), ip: z.string(), lan: z.boolean() });
export type Session = z.infer<typeof sessionSchema>;
