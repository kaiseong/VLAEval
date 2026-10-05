import { z } from "zod";
import { fkIdentitySchema, fkRequestSchema, fkResultSchema, type FkRequest } from "../../kinematics/contracts";

const frame = z.number().int().nonnegative().safe();
const finite = z.number().finite();
export const fkWindowSchema = z.object({ startFrame: finite, endFrame: finite })
  .refine((value) => value.startFrame <= value.endFrame);
const selectionSchema = z.object({ sourceFrame: frame.nullable(), window: fkWindowSchema });
const vertexSchema = z.object({ index: frame, frame, value: finite });
const pathSchema = z.object({ segments: z.array(z.array(vertexSchema).max(4096).readonly()).max(4096).readonly() });
const geometrySchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("empty") }),
  z.object({
    kind: z.literal("ready"), bucketCount: frame.max(256), vertexCount: frame.max(4096),
    sourceIndices: z.array(frame).max(4096).readonly(), predicted: pathSchema, target: pathSchema,
    unavailableBands: z.array(z.object({
      kind: z.literal("gap_density_unavailable"), startFrame: finite, endFrame: finite,
    })).max(256).readonly(),
  }),
]).superRefine((value, context) => {
  if (value.kind === "ready" && (
    [...value.predicted.segments, ...value.target.segments].reduce((sum, points) => sum + points.length, 0) !== value.vertexCount
  )) context.addIssue({ code: "custom", message: "Incorrect bounded vertex count" });
});
export const fkSampleSchema = fkResultSchema.innerType().shape.samples.element;
export const fkMetadataSchema = fkResultSchema.innerType().omit({ samples: true }).extend({
  frameCount: frame, firstFrame: frame.nullable(), lastFrame: frame.nullable(),
});
export const fkViewSchema = selectionSchema.extend({
  channels: z.array(z.object({
    side: z.enum(["right", "left"]), axis: z.enum(["X", "Y", "Z", "Roll", "Pitch", "Yaw"]),
    unit: z.enum(["mm", "deg"]), domain: z.tuple([finite, finite]).refine(([min, max]) => min <= max).nullable(), geometry: geometrySchema,
  })).length(12),
}).superRefine((view, context) => {
  const names = view.channels.map((channel) => `${channel.side}-${channel.axis}`);
  if (new Set(names).size !== 12 || view.channels.some((channel) =>
    channel.unit !== (["X", "Y", "Z"].includes(channel.axis) ? "mm" : "deg")))
    context.addIssue({ code: "custom", message: "Missing or incorrect pose channels" });
});
export const fkCommandSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("derive"), request: fkRequestSchema, source: z.instanceof(ArrayBuffer), selection: selectionSchema }),
  z.object({ kind: z.literal("view"), identity: fkIdentitySchema, serial: frame, selection: selectionSchema }),
  z.object({ kind: z.literal("point"), identity: fkIdentitySchema, serial: frame, sourceFrame: frame.nullable() }),
  z.object({ kind: z.literal("export"), identity: fkIdentitySchema, serial: frame, format: z.enum(["json", "csv"]) }),
]);
export const fkReplySchema = z.discriminatedUnion("kind", [
  // Encoded display payloads have a hard byte-independent character bound before JSON parsing.
  z.object({ kind: z.literal("view"), identity: fkIdentitySchema, serial: frame, payload: z.string().max(8 * 1024 * 1024) }),
  z.object({ kind: z.literal("point"), identity: fkIdentitySchema, serial: frame, sourceFrame: frame.nullable(), payload: z.string().max(64 * 1024) }),
  z.object({ kind: z.literal("export"), identity: fkIdentitySchema, serial: frame,
    format: z.enum(["json", "csv"]), filename: z.string().max(256), mediaType: z.string().max(128), content: z.instanceof(Blob) }),
  z.object({ kind: z.literal("error"), reason: z.string().max(4096) }),
]);
export const fkDisplaySchema = z.object({
  result: fkMetadataSchema, view: fkViewSchema, selected: fkSampleSchema.nullable(),
});
export type FkMetadata = z.infer<typeof fkMetadataSchema>;
export type FkView = z.infer<typeof fkViewSchema>;
export type FkSample = z.infer<typeof fkSampleSchema>;
export type FkCommand = z.infer<typeof fkCommandSchema>;
export type FkReply = z.infer<typeof fkReplySchema>;
export type FkSelection = z.infer<typeof selectionSchema>;
export type FkIdentity = z.infer<typeof fkIdentitySchema>;
export type FkDownload = Extract<FkReply, { kind: "export" }>;

/** Snapshot once into an exclusively transferred buffer: no full object graph clone. */
export function packFkFrames(frames: FkRequest["frames"]): ArrayBuffer {
  const buffer = new ArrayBuffer(frames.length * 33 * Float64Array.BYTES_PER_ELEMENT);
  const packed = new Float64Array(buffer);
  for (let index = 0; index < frames.length; index++) {
    const sample = frames[index];
    if (!sample || sample.predicted.length !== 16 || sample.target.length !== 16)
      throw new FkTransportError("FK source rows must have exactly sixteen values");
    const offset = index * 33;
    packed[offset] = sample.frame;
    packed.set(sample.predicted, offset + 1);
    packed.set(sample.target, offset + 17);
  }
  return buffer;
}

/** Restore the public request at the Worker boundary, before its full schema parse. */
export function unpackFkRequest(command: Extract<FkCommand, { kind: "derive" }>): FkRequest {
  if (command.source.byteLength % (33 * Float64Array.BYTES_PER_ELEMENT) !== 0 || command.request.frames.length !== 0)
    throw new FkTransportError("Invalid packed FK source");
  const values = new Float64Array(command.source);
  return fkRequestSchema.parse({ ...command.request, frames: Array.from({ length: values.length / 33 }, (_, index) => ({
    frame: values[index * 33], predicted: Array.from(values.subarray(index * 33 + 1, index * 33 + 17)),
    target: Array.from(values.subarray(index * 33 + 17, index * 33 + 33)),
  })) });
}

class FkTransportError extends Error {
  constructor(readonly reason: string) { super(reason); }
}

export function sameFkIdentity(left: FkIdentity, right: FkIdentity): boolean {
  return left.schemaVersion === right.schemaVersion && left.jobId === right.jobId &&
    left.episode === right.episode && left.generation === right.generation &&
    left.profileHash === right.profileHash && left.jointUnit === right.jointUnit &&
    left.representation === right.representation && left.convention.kind === right.convention.kind &&
    left.convention.source === right.convention.source &&
    left.convention.nominalSignZeroConfirmed === right.convention.nominalSignZeroConfirmed;
}

/** Runtime immutability for the bounded UI snapshot, not a readonly type assertion. */
export function freezeFk<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freezeFk(child);
    Object.freeze(value);
  }
  return value;
}
