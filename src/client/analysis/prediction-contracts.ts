import { z } from "zod";
import { compiledProfileSchema } from "../../kinematics/contracts";

const finite = z.number().finite();
const index = z.number().int().nonnegative().safe();
const representation = z.enum(["absolute", "delta", "velocity", "unknown"]);
const unit = z.enum(["rad", "deg"]);
const jointArm = z.object({ joints: z.array(index).length(7), gripper: index.nullable() });
const cartesianArm = z.object({
  position: z.array(index).length(3), rotation: z.array(index).min(3).max(4), gripper: index.nullable(),
});

export const predictionSourceSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("joint"), unit: z.enum(["rad", "deg", "unknown"]),
    representation, nominalSignZeroConfirmed: z.boolean(),
    left: jointArm, right: jointArm,
  }),
  z.object({
    kind: z.literal("cartesian"), positionUnit: z.enum(["m", "mm"]),
    orientation: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("rpy_xyz"), unit }),
      z.object({ kind: z.literal("quaternion_xyzw") }),
    ]),
    referenceFrame: z.string().min(1), representation, nominalSignZeroConfirmed: z.boolean(),
    left: cartesianArm, right: cartesianArm,
  }),
]);
export type PredictionSource = z.infer<typeof predictionSourceSchema>;

export const predictionSeedSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("manual"), unit, positions: z.array(finite).length(14) }),
  z.object({
    kind: z.literal("observed"), unit,
    samples: z.array(z.object({ frame: index, positions: z.array(finite).length(14) })),
  }),
]);
export type PredictionSeed = z.infer<typeof predictionSeedSchema>;

const rawRow = z.array(finite);
export const predictionRequestSchema = z.object({
  actionNames: z.array(z.string()).min(1), source: predictionSourceSchema,
  profile: compiledProfileSchema.nullable(), seed: predictionSeedSchema.nullable(),
  series: z.object({
    frames: z.array(index), predicted: z.array(rawRow), target: z.array(rawRow), fps: finite.positive(),
  }),
  chunks: z.array(z.object({
    frame: index, predicted: z.array(rawRow), target: z.array(rawRow), valid: z.array(z.boolean()),
  })),
}).superRefine((input, context) => {
  const dimension = input.actionNames.length;
  const { source, series } = input;
  let columns: number[];
  switch (source.kind) {
    case "joint": columns = [...source.left.joints, ...source.right.joints]; break;
    case "cartesian": {
      columns = [...source.left.position, ...source.left.rotation, ...source.right.position, ...source.right.rotation];
      const size = source.orientation.kind === "rpy_xyz" ? 3 : 4;
      if (source.left.rotation.length !== size || source.right.rotation.length !== size)
        context.addIssue({ code: "custom", message: "Rotation mapping does not match the declared representation" });
      break;
    }
    default: { const exhaustive: never = source; return exhaustive; }
  }
  if (source.left.gripper !== null) columns.push(source.left.gripper);
  if (source.right.gripper !== null) columns.push(source.right.gripper);
  if (new Set(columns).size !== columns.length || columns.some((column) => column >= dimension))
    context.addIssue({ code: "custom", message: "Source columns must be distinct and within the action dimensions" });
  if (series.frames.length !== series.predicted.length || series.frames.length !== series.target.length
    || series.frames.some((frame, i) => i > 0 && frame <= (series.frames[i - 1] ?? -1)))
    context.addIssue({ code: "custom", message: "Trace rows must align with strictly increasing source frames" });
  for (const rows of [series, ...input.chunks]) {
    if (rows.predicted.length !== rows.target.length
      || [...rows.predicted, ...rows.target].some((row) => row.length !== dimension)
      || ("valid" in rows && rows.valid.length !== rows.predicted.length))
      context.addIssue({ code: "custom", message: "Action rows and masks must align with the source dimensions" });
  }
  if (new Set(input.chunks.map((chunk) => chunk.frame)).size !== input.chunks.length)
    context.addIssue({ code: "custom", message: "Chunk anchors must be unique within an episode" });
  if (input.seed?.kind === "observed"
    && new Set(input.seed.samples.map((sample) => sample.frame)).size !== input.seed.samples.length)
    context.addIssue({ code: "custom", message: "Observed seed frames must be unique" });
});
export type PredictionRequest = z.infer<typeof predictionRequestSchema>;

const displayRow = z.array(finite.nullable());
export const predictionDataSchema = z.object({
  series: z.object({ frames: z.array(index), predicted: z.array(displayRow), target: z.array(displayRow), fps: finite.positive() }),
  chunks: z.array(z.object({ frame: index, predicted: z.array(displayRow), target: z.array(displayRow), valid: z.array(z.boolean()) })),
});
export type PredictionData = z.infer<typeof predictionDataSchema>;

export const predictionResultSchema = z.object({
  joint: predictionDataSchema.nullable(), cartesian: predictionDataSchema.nullable(),
  provenance: z.object({ joint: z.enum(["source", "ik"]).nullable(), cartesian: z.enum(["source", "fk"]).nullable() }),
  unavailable: z.object({ joint: z.string().nullable(), cartesian: z.string().nullable() }),
  issues: z.array(z.object({ reason: z.string(), count: z.number().int().positive() })),
}).superRefine((result, context) => {
  for (const [mode, dimension] of [["joint", 16], ["cartesian", 14]] as const) {
    const data = result[mode];
    if (!data) continue;
    for (const rows of [data.series, ...data.chunks]) {
      if (rows.predicted.length !== rows.target.length
        || [...rows.predicted, ...rows.target].some((row) => row.length !== dimension)
        || ("valid" in rows && rows.valid.length !== rows.predicted.length)
        || ("frames" in rows && rows.frames.length !== rows.predicted.length))
        context.addIssue({ code: "custom", message: `Invalid ${mode} display shape` });
    }
  }
});
export type PredictionResult = z.infer<typeof predictionResultSchema>;
