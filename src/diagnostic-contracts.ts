import { z } from "zod";
import { predictionSourceSchema } from "./client/analysis/prediction-contracts";
import { validateCameraProjection } from "./kinematics/projection";

const finite = z.number().finite();
const index = z.number().int().nonnegative().max(1_000_000);
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const key = z.string().min(1).max(200);
const base64 = z.string().max(8 * 1024 * 1024).regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/);
const rect = z.tuple([finite, finite, finite.positive(), finite.positive()]);

export const diagnosticImageSchema = z.object({
  role: z.enum(["front", "left_wrist", "right_wrist"]),
  datasetKey: key, modelKey: key,
  width: z.number().int().positive().max(8192), height: z.number().int().positive().max(8192),
  timestampSeconds: finite.nonnegative(), sha256,
  mime: z.enum(["image/png", "image/jpeg"]), dataBase64: base64,
  geometryResolved: z.boolean().optional(),
  preprocessing: z.object({
    inputWidth: z.number().int().positive().max(4096), inputHeight: z.number().int().positive().max(4096),
    // CSS affine convention: x'=a*x+c*y+e, y'=b*x+d*y+f.
    sourceToInput: z.tuple([finite, finite, finite, finite, finite, finite]),
    contentRect: rect,
  }).strict().nullable(),
}).strict().superRefine((image, ctx) => {
  if (image.geometryResolved === true && !image.preprocessing || image.geometryResolved === false && image.preprocessing)
    ctx.addIssue({ code: "custom", message: "Resolved geometry and preprocessing must agree" });
  if (!image.preprocessing) return;
  const [a, b, c, d] = image.preprocessing.sourceToInput;
  if (Math.abs(a * d - b * c) < 1e-12) ctx.addIssue({ code: "custom", message: "Image transform must be invertible" });
  const [x, y, w, h] = image.preprocessing.contentRect;
  if (x < 0 || y < 0 || x + w > image.preprocessing.inputWidth || y + h > image.preprocessing.inputHeight)
    ctx.addIssue({ code: "custom", message: "Content rectangle must fit model input" });
});

const keyGroupSchema = z.object({
  id: key, kind: z.enum(["image", "instruction", "state", "padding", "action", "special", "other"]),
  modelKey: key.optional(), keyIndices: z.array(index).min(1).max(4096),
}).strict();
const attentionSchema = z.object({
  kind: z.literal("action_to_image"),
  layers: z.array(index).min(1).max(128),
  steps: z.array(z.object({ index, flowTime: finite }).strict()).min(1).max(100),
  headReduction: z.literal("mean"), headCount: z.number().int().positive().max(256),
  horizon: z.number().int().positive().max(256),
  queryGroups: z.array(z.object({
    id: z.enum(["early", "late"]),
    horizonIndices: z.array(index).max(256),
    queryRows: z.array(index).max(256),
  }).strict()).length(2),
  keyCount: z.number().int().positive().max(4096),
  keyGroups: z.array(keyGroupSchema).min(1).max(32),
  cameras: z.array(z.object({
    modelKey: key, gridWidth: z.number().int().positive().max(64), gridHeight: z.number().int().positive().max(64),
    patchKeyIndices: z.array(index).min(1).max(4096),
    patchValidFraction: z.array(finite.min(0).max(1)).max(4096).nullable().optional(),
  }).strict()).min(1).max(3),
  slices: z.array(z.object({
    stepIndex: index, layer: index, queryGroup: z.enum(["early", "late"]),
    masses: z.array(z.object({ groupId: key, value: finite.min(0).max(1) }).strict()).min(1).max(32),
    maps: z.array(z.object({
      modelKey: key, valuesF16LE: base64.optional(), valuesF32LE: base64.optional(),
      letterboxMass: finite.min(0).max(1).nullable().optional(),
    }).strict().refine((map) => (map.valuesF16LE === undefined) !== (map.valuesF32LE === undefined),
      "Provide exactly one binary map encoding")).min(1).max(3),
    sinkCandidates: z.array(z.object({
      keyIndex: index, label: z.string().max(200), mass: finite.min(0).max(1),
    }).strict()).max(16),
  }).strict()).min(1).max(25_600),
  sinkMethod: z.string().min(1).max(500),
}).strict();

export const projectionInputSchema = z.object({
  modelKey: key,
  referenceFrame: z.literal("link_torso_5"),
  calibrationId: key, calibrationHash: sha256,
  poseEvidence: z.object({
    kind: z.enum(["recorded", "declared_fixed"]),
    description: z.string().min(1).max(1000),
  }).strict(),
  assumption: z.literal("anchor_reference_fixed"),
  profileHash: sha256.nullable(),
  source: predictionSourceSchema,
  camera: z.object({
    width: z.number().int().positive(), height: z.number().int().positive(),
    fx: finite.positive(), fy: finite.positive(), cx: finite, cy: finite,
    distortion: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("none") }).strict(),
      z.object({ kind: z.literal("brown_conrady"), coefficients: z.tuple([finite, finite, finite, finite, finite]) }).strict(),
    ]),
    cameraFromReference: z.array(finite).length(16),
  }).strict(),
}).strict().superRefine((input, ctx) => {
  const reason = validateCameraProjection(input.camera);
  if (reason) ctx.addIssue({ code: "custom", message: reason });
  if (input.source.representation !== "absolute" || !input.source.nominalSignZeroConfirmed)
    ctx.addIssue({ code: "custom", message: "Projection requires confirmed absolute source coordinates" });
  if (input.source.kind === "joint" && (input.source.unit === "unknown" || input.profileHash === null))
    ctx.addIssue({ code: "custom", message: "Joint projection requires a profile and explicit unit" });
  if (input.source.kind === "cartesian" && input.source.referenceFrame !== input.referenceFrame)
    ctx.addIssue({ code: "custom", message: "Cartesian source must use the declared projection reference" });
});

export const diagnosticPacketSchema = z.object({
  schemaVersion: z.union([z.literal(1), z.literal(2)]),
  identity: z.object({
    jobId: z.string().uuid(), episode: index, frame: index,
    dataset: z.string().min(1), config: key, checkpoint: z.string().min(1),
    seed: z.number().int().min(0).max(2147483647), numSteps: z.number().int().min(1).max(100),
  }).strict(),
  provenance: z.object({
    kind: z.enum(["captured", "synthetic"]),
    adapterRevision: key, backend: z.enum(["jax", "pytorch", "none"]),
    dtype: key, compiled: z.boolean(),
    inputDigest: sha256, noiseDigest: sha256.nullable(),
    adapterSchema: z.literal("vlaeval.attention_diagnostics/2").optional(),
  }).strict(),
  images: z.array(diagnosticImageSchema).min(1).max(3),
  attention: attentionSchema.nullable(),
  projection: projectionInputSchema.nullable(),
  actionDifferences: z.array(z.object({
    channel: key, unit: key, maxAbsolute: finite.nonnegative(),
    atol: finite.nonnegative().nullable(), rtol: finite.nonnegative().nullable(),
    exceededCount: index.nullable(),
  }).strict()).max(256),
  sameProcessDifferences: z.array(z.object({
    channel: key, unit: key, maxAbsolute: finite.nonnegative(),
    atol: finite.nonnegative().nullable(), rtol: finite.nonnegative().nullable(),
    exceededCount: index.nullable(),
  }).strict()).max(256).optional(),
  adapterMetadata: z.record(z.unknown()).optional(),
  adapterArrays: z.object({
    encoding: z.literal("npz-base64"), sha256, dataBase64: base64,
  }).strict().optional(),
  timing: z.object({
    compileMs: finite.nonnegative().nullable(), warmupMs: finite.nonnegative().nullable(),
    inferenceMs: finite.nonnegative().nullable(), extractionMs: finite.nonnegative().nullable(),
    peakGpuBytes: finite.nonnegative().nullable(),
    prepareMs: finite.nonnegative().nullable().optional(),
    referenceInferenceMs: finite.nonnegative().nullable().optional(),
    totalMs: finite.nonnegative().nullable().optional(),
    hostTransferBytes: finite.nonnegative().nullable().optional(),
    compiledTempBytes: finite.nonnegative().nullable().optional(),
  }).strict(),
}).strict().superRefine((packet, ctx) => {
  const issue = (message: string) => ctx.addIssue({ code: "custom", message });
  const unique = (values: readonly (string | number)[]) => new Set(values).size === values.length;
  if (!unique(packet.images.map((item) => item.modelKey)) || !unique(packet.images.map((item) => item.role)))
    issue("Image roles and model keys must be unique");
  if (packet.projection) {
    const image = packet.images.find((item) => item.modelKey === packet.projection?.modelKey);
    if (!image || image.role !== "front" || image.width !== packet.projection.camera.width
      || image.height !== packet.projection.camera.height) issue("Projection must match the original front image dimensions");
  }
  const attention = packet.attention;
  if (!attention) return;
  if (attention.steps.length !== packet.identity.numSteps || attention.steps.some((step, i) => step.index !== i))
    issue("Attention must retain every requested denoise step in execution order");
  if (!unique(attention.layers) || attention.layers.some((layer, i) => layer !== i))
    issue("Attention layers must contain the complete zero-based sequence");
  if (!unique(attention.queryGroups.map((group) => group.id))) issue("Query group IDs must be unique");
  const horizonIndices = attention.queryGroups.flatMap((group) => group.horizonIndices);
  const queryRows = attention.queryGroups.flatMap((group) => group.queryRows);
  if (!queryRows.length) issue("Action attention requires at least one model query");
  if (!unique(horizonIndices) || !unique(queryRows) || horizonIndices.some((h) => h >= attention.horizon))
    issue("Query groups must be disjoint and inside the horizon");
  for (const group of attention.queryGroups) {
    if (group.queryRows.length !== group.horizonIndices.length) issue("Query rows must identify every included horizon token");
    if (group.horizonIndices.some((h, i) => i > 0 && h <= (group.horizonIndices[i - 1] ?? -1)))
      issue("Query group horizon indices must be increasing");
  }
  const keyIndices = attention.keyGroups.flatMap((group) => group.keyIndices);
  if (!unique(attention.keyGroups.map((group) => group.id)) || !unique(keyIndices)
    || keyIndices.length !== attention.keyCount || keyIndices.some((k) => k >= attention.keyCount))
    issue("Key groups must partition all attention keys exactly once");
  if (!unique(attention.cameras.map((camera) => camera.modelKey))) issue("Attention camera keys must be unique");
  for (const group of attention.keyGroups) {
    if (group.kind === "image" && !attention.cameras.some((camera) => camera.modelKey === group.modelKey))
      issue("Every image key group must name a retained attention camera");
    if (group.kind !== "image" && group.modelKey !== undefined)
      issue("Only image key groups may carry a camera model key");
  }
  for (const camera of attention.cameras) {
    if (!packet.images.some((image) => image.modelKey === camera.modelKey)) issue("Attention camera must have an original image");
    const imageKeys = new Set(attention.keyGroups.filter((group) => group.kind === "image" && group.modelKey === camera.modelKey)
      .flatMap((group) => group.keyIndices));
    if (camera.patchKeyIndices.length !== camera.gridWidth * camera.gridHeight
      || !unique(camera.patchKeyIndices) || camera.patchKeyIndices.some((k) => !imageKeys.has(k)))
      issue("Patch indices must match the grid and actual camera key group");
    if (camera.patchValidFraction && camera.patchValidFraction.length !== camera.patchKeyIndices.length)
      issue("Patch geometry fractions must match grid size");
  }
  const identities = attention.slices.map((slice) => `${slice.stepIndex}:${slice.layer}:${slice.queryGroup}`);
  if (!unique(identities) || identities.length !== attention.steps.length * attention.layers.length * 2)
    issue("Attention slices must cover all steps, layers and both query groups");
  for (const slice of attention.slices) {
    const group = attention.queryGroups.find((item) => item.id === slice.queryGroup);
    if (slice.stepIndex >= attention.steps.length || !attention.layers.includes(slice.layer) || !group)
      issue("Slice identity is outside the declared attention axes");
    if (!unique(slice.masses.map((mass) => mass.groupId)) || slice.masses.length !== attention.keyGroups.length
      || slice.masses.some((mass) => !attention.keyGroups.some((item) => item.id === mass.groupId)))
      issue("Each slice must retain the complete key-group mass partition");
    const mass = slice.masses.reduce((sum, item) => sum + item.value, 0);
    if (Math.abs(mass - (group?.queryRows.length ? 1 : 0)) > 0.003) issue("Raw attention group masses must sum to one (zero for empty query groups)");
    if (!unique(slice.maps.map((map) => map.modelKey)) || slice.maps.length !== attention.cameras.length)
      issue("Every slice must retain every camera map");
    for (const map of slice.maps) {
      const camera = attention.cameras.find((item) => item.modelKey === map.modelKey);
      const encoded = map.valuesF32LE ?? map.valuesF16LE ?? "";
      const padding = encoded.endsWith("==") ? 2 : encoded.endsWith("=") ? 1 : 0;
      if (!camera || encoded.length / 4 * 3 - padding !== camera.gridWidth * camera.gridHeight * (map.valuesF32LE ? 4 : 2))
        issue("Binary image map byte length must match its grid");
    }
    if (slice.sinkCandidates.some((sink) => sink.keyIndex >= attention.keyCount))
      issue("Sink candidate key must belong to the attention key space");
    if (!group?.queryRows.length && slice.sinkCandidates.length)
      issue("Empty query groups cannot report sink candidates");
  }
});

export type DiagnosticPacket = z.infer<typeof diagnosticPacketSchema>;
export type DiagnosticImage = z.infer<typeof diagnosticImageSchema>;
export type ProjectionInput = z.infer<typeof projectionInputSchema>;
export const maximumDiagnosticBytes = 16 * 1024 * 1024;
