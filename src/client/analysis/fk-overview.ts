import { z } from "zod";
import { fkRequestSchema, type FkResult } from "../../kinematics/contracts";
import { deriveForward } from "../../kinematics/forward";

const finite = z.number().finite();
const frame = finite.int().nonnegative();
const fps = finite.positive();
const rawRow = z.array(finite).length(16);
const overviewRow = z.array(finite.nullable()).length(14);

function alignedRows(
  rows: { readonly predicted: readonly unknown[]; readonly target: readonly unknown[]; readonly valid: readonly boolean[] },
  context: z.RefinementCtx,
) {
  if (rows.predicted.length !== rows.target.length || rows.predicted.length !== rows.valid.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Chunk rows and mask must have matching lengths" });
  }
}

export const fkOverviewInputSchema = z.object({
  request: fkRequestSchema,
  fps,
  chunks: z.array(z.object({
    frame, predicted: z.array(rawRow), target: z.array(rawRow), valid: z.array(z.boolean()),
  }).superRefine(alignedRows)),
});

export const fkOverviewDataSchema = z.object({
  series: z.object({
    frames: z.array(frame), predicted: z.array(overviewRow), target: z.array(overviewRow), fps,
  }).superRefine((series, context) => {
    if (series.frames.length !== series.predicted.length || series.frames.length !== series.target.length) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "Series frames and rows must have matching lengths" });
    }
  }),
  chunks: z.array(z.object({
    frame, predicted: z.array(overviewRow), target: z.array(overviewRow), valid: z.array(z.boolean()),
  }).superRefine(alignedRows)),
});
export type FkOverviewData = z.infer<typeof fkOverviewDataSchema>;

/** Display-only projection; scientific first-step samples and exports remain separate. */
export function deriveFkOverview(input: unknown): FkOverviewData {
  const { request, fps: inputFps, chunks } = fkOverviewInputSchema.parse(input);
  // A single FK pass prepares each chain once for the trace and every stored chunk.
  // Chunk-local frame IDs are internal; output anchors and masks are kept verbatim.
  const result = deriveForward({
    ...request,
    frames: request.frames.concat(chunks.flatMap((chunk) => chunk.predicted.map((predicted, index) => {
      const target = chunk.target[index];
      if (target === undefined) throw new RangeError("Missing admitted chunk target");
      return { frame: index, predicted, target };
    }))),
  });
  const grippers = {
    left: request.actionNames.indexOf("left_gripper_0"),
    right: request.actionNames.indexOf("right_gripper_0"),
  };
  const project = (sample: FkResult["samples"][number], source: "predicted" | "target", valid = true) =>
    (["left", "right"] as const).flatMap((side) => {
      const pose = sample.arms[side].pose[source];
      const xyz = [0, 1, 2].map((axis) => {
        const meters = pose.translationM?.[axis];
        const mm = meters === undefined ? null : meters * 1000;
        return valid && mm !== null && Number.isFinite(mm) ? mm : null;
      });
      return [...xyz, ...pose.rpyDeg.map((value) => valid ? value : null),
        sample.source[source][grippers[side]] ?? null];
    });
  const trace = result.samples.slice(0, request.frames.length);
  let offset = trace.length;
  return {
    series: {
      frames: trace.map((sample) => sample.frame),
      predicted: trace.map((sample) => project(sample, "predicted")),
      target: trace.map((sample) => project(sample, "target")),
      fps: inputFps,
    },
    chunks: chunks.map((chunk) => {
      const samples = result.samples.slice(offset, offset + chunk.predicted.length);
      offset += samples.length;
      return {
        frame: chunk.frame,
        predicted: samples.map((sample, index) => project(sample, "predicted", chunk.valid[index] === true)),
        target: samples.map((sample, index) => project(sample, "target", chunk.valid[index] === true)),
        valid: chunk.valid,
      };
    }),
  };
}
