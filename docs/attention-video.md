# Attention video

Per-episode playback of pi05 action-to-image attention for a completed, saved evaluation run. One short-lived JAX
process on the diagnostic host computes attention for frames `0, 3, 6, ...` of one episode and returns one compact
artifact. The backend does not run model inference on its own; computation starts only from an explicit
`POST .../run`.

## What is computed

For every selected frame the worker reuses `worker.py`'s `score_frames` (same dataset loading, repack, prompt and the
deterministic noise rule `SeedSequence([seed, episode, frame])`). Its policy wrapper calls
`attention_adapter.collect_action_image_attention(..., compare_with_infer=False)` once per frame. No separate
ordinary `policy.infer` runs. The adapter's own output actions are returned to `score_frames`, so its bookkeeping
keeps working, and the duplicate warm-up call on the first frame reuses those actions.

Host-side reduction (`reduce_attention`):

1. Keep the last denoise step (`selection.stepIndex = numSteps - 1`).
2. Average over all transformer layers (the adapter already averages heads).
3. Combine the two action-query groups (early/late) weighted by their query counts. The result is one probability
   vector over all keys that sums to 1.

From that vector:

- Group masses (`frames[].masses`) sum the vector over each `key_role` group. Key-group kinds are `image`,
  `instruction`, `state`, `padding`, `action`, `special` and `other`.
- Camera maps (`frames[].maps[].valuesF32LE`) slice each camera's metadata `token_range`, stored as base64
  little-endian float32 per patch, row-major `gridHeight x gridWidth`.
- `letterboxMass` is the camera-map mass on patches whose `patch_valid_fraction == 0`. It is `null` when the geometry
  is unresolved; in that case `cameras[].patchValidFraction` is also `null`.

Thumbnails are JPEG (quality 75, long side at most 320 px, never upscaled), made from the same raw observation the
model saw. `width`/`height` are the thumbnail size. `preprocessing.sourceToInput` maps thumbnail pixels to model-input
pixels: the original affine's linear part is scaled by `originalWidth/thumbWidth` and `originalHeight/thumbHeight`.
`inputWidth`, `inputHeight` and `contentRect` stay in model-input coordinates, as with packets, because the shared
`diagnosticImageSchema` requires `contentRect` to fit the model input. `sha256` covers the JPEG bytes.

## Artifact

Contract: `src/attention-video-contracts.ts` (`attentionVideoSchema`, `AttentionVideo`, `maximumAttentionVideoBytes`
= 96 MiB). Stored as `{jobId}.attnvideo-{episode}.json` in the job directory. The file is written atomically through a
temporary file and rename, symlinks are refused, it is counted by `store.storage()`, and it is removed by
`store.delete()`.

Validation:

- The schema requires frames that are strictly increasing and below `episodeLength`.
- Each frame needs one map per camera holding `gridWidth*gridHeight` finite values in `[0, 1]`.
- Masses must form the complete key-group partition and sum to 1 (within 0.003).
- Images must match each camera's role and `datasetKey`.
- `selection.stepIndex` must be `numSteps - 1`, and `timing.frames` must equal `frames.length`.
- The store additionally checks that identity (dataset/config/checkpoint/seed/numSteps) matches the saved result, that
  JPEG/PNG magic bytes and SHA256 are correct, and that synthetic provenance appears only in opted-in test stores.

## Execution

`runtime_video_main(request, worker_source, adapter_source)` in `diagnostics_worker.py` shares the setup used by
selected-frame diagnostics (`prepare_policy`):

- Process-group lifecycle.
- PyTorch checkpoints without a PyTorch adapter are unsupported before the GPU preflight.
- Adapter source SHA256 and `major.minor` version checks.
- A preflight requiring at least 20 GiB of free GPU memory before JAX is imported.
- Offline Hugging Face environment.
- JAX policy load.

The worker emits `{"type":"progress","status":"running","message":"attention video frame k/N"}` every 10 frames and
for the last frame, then a single `{"type":"video","video": ...}` event. Errors use the same `failed` / `blocked` /
`unsupported` categories as `runtime_main`.

The TS runner (`src/diagnostic-runner.ts`) uses the same stdin script transport, host allow-list
(`VLAEVAL_DIAGNOSTIC_HOST`), PID tracking and cancel/kill path. A request with `mode: "video"` selects
`runtime_video_main`, and its stdout line bound is raised to `maximumAttentionVideoBytes`. `consumeLines` now scans only
newly received bytes for newlines, so a single line of tens of MiB is not rescanned quadratically.

`AttentionVideoRunManager` (`src/attention-video-runs.ts`) keys state by `(jobId, episode)` and takes the store's single
diagnostic GPU slot. While it holds the slot, ordinary evaluation, selected-frame diagnostics, another video,
deletion, and external publication for that run are all rejected with 409. Single-frame runs and evaluation exclude
video runs in the same way.

## API (local same-origin only)

| Method | Path | Result |
| --- | --- | --- |
| GET | `/api/jobs/:id/attention-video?episode=N` | artifact, or 404 if not computed |
| POST | `/api/jobs/:id/attention-video/run` body `{episode}` | 202 + run state |
| GET | `/api/jobs/:id/attention-video/run?episode=N` | run state (never starts work) |
| GET | `/api/jobs/:id/attention-video/run/events?episode=N` | SSE: initial state + transitions, closes on terminal |
| POST | `/api/jobs/:id/attention-video/run/cancel` body `{runId}` | run state (`cancelling` until the remote process exits) |

Run state: `{runId, jobId, episode, status, message}` with `status` one of `idle`, `preflight`, `running`, `completed`,
`failed`, `blocked`, `unsupported`, `cancelling`, `cancelled`.

## Size

With three 16x16 cameras, a frame holds about 4 KB of maps plus three thumbnails of roughly 15-25 KB each in base64.
A 600-frame episode (200 selected frames) therefore produces roughly 10-15 MB, well below the 96 MiB cap.
