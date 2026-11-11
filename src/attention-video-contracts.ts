import { z } from "zod";
import { diagnosticImageSchema } from "./diagnostic-contracts";
import { decodeHalfMap } from "./client/analysis/diagnostic-data";

const finite = z.number().finite();
const index = z.number().int().nonnegative().max(1_000_000);
const key = z.string().min(1).max(200);
const base64 = z.string().max(64 * 1024).regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/);

export const maximumAttentionVideoBytes = 96 * 1024 * 1024;

/** Little-endian float32 values; atob keeps this usable in the browser and in Bun. */
function decodeF32(encoded: string): Float32Array {
  const raw = atob(encoded);
  const view = new DataView(Uint8Array.from(raw, (value) => value.charCodeAt(0)).buffer);
  return Float32Array.from({ length: Math.floor(raw.length / 4) }, (_, i) => view.getFloat32(i * 4, true));
}

/**
 * One episode's last-denoise-step action->key attention, every `stride`th frame.
 * Both query groups are combined weighted by query count. `valuesF32LE` is the equal-weight
 * layer mean; when `selection.layerCount` is present, `layersF16LE` adds every layer
 * (row-major [layer, patch], binary16) for per-layer playback. Older artifacts omit both.
 */
export const attentionVideoSchema = z.object({
  schemaVersion: z.literal(1),
  identity: z.object({
    jobId: z.string().uuid(), episode: index,
    dataset: z.string().min(1), config: key, checkpoint: z.string().min(1),
    seed: z.number().int().min(0).max(2147483647), numSteps: z.number().int().min(1).max(100),
  }).strict(),
  provenance: z.object({
    kind: z.enum(["captured", "synthetic"]),
    adapterRevision: key,
    adapterSchema: z.literal("vlaeval.attention_diagnostics/2"),
    backend: z.enum(["jax", "pytorch"]),
  }).strict(),
  selection: z.object({
    stepIndex: z.number().int().nonnegative().max(99),
    layers: z.literal("all"), queries: z.literal("all"), stride: z.literal(3),
    layerCount: z.number().int().positive().max(128).optional(),
  }).strict(),
  fps: finite.positive(),
  episodeLength: z.number().int().positive().max(1_000_000),
  keyGroups: z.array(z.object({
    id: key, kind: z.enum(["image", "instruction", "state", "padding", "action", "special", "other"]),
    modelKey: key.optional(),
  }).strict()).min(1).max(32),
  cameras: z.array(z.object({
    role: z.enum(["front", "left_wrist", "right_wrist"]), modelKey: key, datasetKey: key,
    gridWidth: z.number().int().positive().max(64), gridHeight: z.number().int().positive().max(64),
    patchValidFraction: z.array(finite.min(0).max(1)).max(4096).nullable(),
  }).strict()).min(1).max(3),
  frames: z.array(z.object({
    frame: index, timestampSeconds: finite.nonnegative(),
    masses: z.array(z.object({ groupId: key, value: finite.min(0).max(1) }).strict()).min(1).max(32),
    maps: z.array(z.object({
      modelKey: key, valuesF32LE: base64, letterboxMass: finite.min(0).max(1).nullable(),
      layersF16LE: base64.optional(),
    }).strict()).min(1).max(3),
    images: z.array(diagnosticImageSchema).min(1).max(3),
  }).strict()).min(1).max(400_000),
  timing: z.object({
    totalMs: finite.nonnegative(), perFrameMs: finite.nonnegative(), frames: z.number().int().nonnegative(),
  }).strict(),
}).strict().superRefine((video, ctx) => {
  const issue = (message: string) => ctx.addIssue({ code: "custom", message });
  const unique = (values: readonly (string | number)[]) => new Set(values).size === values.length;
  if (video.selection.stepIndex !== video.identity.numSteps - 1) issue("Selection must use the last denoise step");
  if (!unique(video.keyGroups.map((group) => group.id))) issue("Key group IDs must be unique");
  if (!unique(video.cameras.map((camera) => camera.modelKey)) || !unique(video.cameras.map((camera) => camera.role)))
    issue("Camera roles and model keys must be unique");
  for (const group of video.keyGroups) {
    if (group.kind === "image" && !video.cameras.some((camera) => camera.modelKey === group.modelKey))
      issue("Every image key group must name a retained camera");
    if (group.kind !== "image" && group.modelKey !== undefined) issue("Only image key groups may carry a camera model key");
  }
  for (const camera of video.cameras) {
    if (camera.patchValidFraction && camera.patchValidFraction.length !== camera.gridWidth * camera.gridHeight)
      issue("Patch geometry fractions must match grid size");
  }
  if (video.timing.frames !== video.frames.length) issue("Timing frame count must match retained frames");
  let previous = -1;
  for (const frame of video.frames) {
    if (frame.frame <= previous || frame.frame >= video.episodeLength) {
      issue("Frames must be strictly increasing and inside the episode");
      return;
    }
    previous = frame.frame;
    if (!unique(frame.masses.map((mass) => mass.groupId)) || frame.masses.length !== video.keyGroups.length
      || frame.masses.some((mass) => !video.keyGroups.some((group) => group.id === mass.groupId)))
      issue(`Frame ${frame.frame} must retain the complete key-group mass partition`);
    if (Math.abs(frame.masses.reduce((sum, mass) => sum + mass.value, 0) - 1) > 0.003)
      issue(`Frame ${frame.frame} group masses must sum to one`);
    if (!unique(frame.maps.map((map) => map.modelKey)) || frame.maps.length !== video.cameras.length)
      issue(`Frame ${frame.frame} must retain one map per camera`);
    if (!unique(frame.images.map((image) => image.modelKey)) || !unique(frame.images.map((image) => image.role)))
      issue(`Frame ${frame.frame} image roles and model keys must be unique`);
    for (const camera of video.cameras) {
      const map = frame.maps.find((item) => item.modelKey === camera.modelKey);
      const image = frame.images.find((item) => item.modelKey === camera.modelKey);
      if (!image || image.role !== camera.role || image.datasetKey !== camera.datasetKey)
        issue(`Frame ${frame.frame} camera ${camera.modelKey} needs its matching image`);
      if (!map) { issue(`Frame ${frame.frame} camera ${camera.modelKey} is missing its map`); continue; }
      const values = decodeF32(map.valuesF32LE);
      if (values.length !== camera.gridWidth * camera.gridHeight
        || values.some((value) => !Number.isFinite(value) || value < 0 || value > 1))
        issue(`Frame ${frame.frame} camera ${camera.modelKey} map must hold one finite [0, 1] value per patch`);
      const layerCount = video.selection.layerCount;
      if ((layerCount === undefined) !== (map.layersF16LE === undefined))
        issue(`Frame ${frame.frame} camera ${camera.modelKey} per-layer maps must match selection.layerCount`);
      else if (layerCount !== undefined && map.layersF16LE !== undefined) {
        const layers = decodeHalfMap(map.layersF16LE);
        if (layers.length !== layerCount * camera.gridWidth * camera.gridHeight
          || layers.some((value) => !Number.isFinite(value) || value < 0 || value > 1))
          issue(`Frame ${frame.frame} camera ${camera.modelKey} per-layer maps must hold finite [0, 1] values per layer and patch`);
      }
      if ((camera.patchValidFraction === null) !== (map.letterboxMass === null))
        issue("Letterbox mass is defined exactly when patch geometry is resolved");
    }
  }
});

export type AttentionVideo = z.infer<typeof attentionVideoSchema>;

export const attentionVideoAnchorSchema = z.object({
  episode: z.number().int().nonnegative().max(1_000_000),
}).strict();

export const attentionVideoRunStateSchema = z.object({
  runId: z.string().uuid().nullable(),
  jobId: z.string().uuid(),
  episode: z.number().int().nonnegative().max(1_000_000),
  status: z.enum(["idle", "preflight", "running", "completed", "failed", "blocked", "unsupported", "cancelling", "cancelled"]),
  message: z.string(),
});
export type AttentionVideoRunState = z.infer<typeof attentionVideoRunStateSchema>;

export function attentionVideoRunTerminal(state: Pick<AttentionVideoRunState, "status">): boolean {
  return !["idle", "preflight", "running", "cancelling"].includes(state.status);
}
