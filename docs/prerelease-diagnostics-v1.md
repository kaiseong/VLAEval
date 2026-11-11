# Pre-release diagnostic receiver v1

This documents the original receiver contract. The receiver also accepts packet
v2 and a separate selected-frame JAX execution API now exists; see
`diagnostic-execution.md`. Ordinary evaluation is unchanged. Opening Pre-release,
changing frames, or selecting a layer never starts inference.

The machine-consumed source of truth is `src/diagnostic-contracts.ts`.
`tests/diagnostic-fixture.ts` builds a complete, explicitly synthetic example.
Production stores reject `provenance.kind: "synthetic"`; test stores must opt in.
Do not relabel synthetic data as captured data to import it into a normal run.

## Transport and ownership

- GET/PUT `/api/jobs/{uuid}/diagnostics?episode={integer}&frame={integer}`.
- GET returns a validated packet or 404 when not captured. PUT validates and
  atomically stores a complete replacement packet, returning the admitted packet.
- Only an existing completed run and a saved scored anchor are accepted. Packet
  `jobId`, episode/frame, config, dataset, checkpoint, seed and numSteps must match.
- Request bodies/artifacts are limited to 16 MiB. Same-origin restrictions apply.
- Files are local `{uuid}.diag-{episode}-{frame}.json` sidecars, not additions to
  evaluation metrics. Image SHA256 and MIME signatures are verified. The viewer
  also checks decoded natural dimensions before showing any overlay.
- Storage accounting includes sidecars. Deleting a run removes only that run's
  canonical sidecars and snapshot; concurrent publication/deletion is excluded.
- A JSON file can be imported through Pre-release. The file is subject to the
  same API validation; mismatched identities are not silently reassigned.

## Packet fields

All objects are strict. Unknown fields are rejected rather than silently dropped.

| Field | Contract |
|---|---|
| `schemaVersion` | `1` |
| `identity` | `jobId`, `episode`, `frame`, `dataset`, `config`, `checkpoint`, `seed`, `numSteps` |
| `provenance` | `kind: captured/synthetic`, `adapterRevision`, `backend: jax/pytorch/none`, `dtype`, `compiled`, SHA256 `inputDigest`, nullable SHA256 `noiseDigest` |
| `images` | Original image records below; unique role and model key |
| `attention` | Action-to-image capture below, or null if not captured |
| `projection` | Explicit camera/source input below, or null if unavailable |
| `actionDifferences` | Per output channel: `channel`, `unit`, `maxAbsolute`, nullable `atol`, `rtol`, `exceededCount` |
| `timing` | Nullable `compileMs`, `warmupMs`, `inferenceMs`, `extractionMs`, `peakGpuBytes`; null is unknown, not zero |

### Images

Each image contains `role` (`front`, `left_wrist`, `right_wrist`), actual
`datasetKey`/`modelKey`, original `width`/`height`, `timestampSeconds`, `sha256`,
`mime` (`image/png` or `image/jpeg`), and encoded image `dataBase64`.

`preprocessing` contains model `inputWidth`/`inputHeight`,
`sourceToInput: [a,b,c,d,e,f]`, and `contentRect: [x,y,width,height]`.
The affine convention is `x'=a*x+c*y+e, y'=b*x+d*y+f`. This includes resize,
rotation/flip, crop and padding placement. `contentRect` is the valid content
rectangle in model-input coordinates, excluding letterbox padding. The viewer
inverts this transform, clips the heatmap to content, and overlays original RGB.
Do not hardcode camera order, dataset/model key mapping or two rows of padding.
Non-affine image warps are not supported by this v1 overlay.

### Attention

`kind: action_to_image`; complete zero-based `layers`; all executed `steps` as
`{index,flowTime}` in order, with length equal to `identity.numSteps`.
`headReduction: mean`, actual `headCount`, actual `horizon`.

`queryGroups` contains exactly `early` and `late`, each with `horizonIndices` and
corresponding actual attention `queryRows`. Split at `ceil(horizon/2)`.
Groups are disjoint. Query rows describe model attention, not GT availability;
dataset GT padding must not remove model-generated action queries. v2 follows
the adapter's actual ranges rather than imposing a fixed half-split.
An empty group has no query rows and zero masses/maps, and is unavailable in UI.
The All view is weighted by group query counts, not an unweighted average.
Individual heads or arbitrary horizon intervals cannot be recovered from means.

`keyCount` and `keyGroups` partition every key exactly once. Each group has `id`,
`kind` (`image`, `instruction`, `state`, `action`, `special`, `other`) and
`keyIndices`; image groups also have `modelKey`. No 768/200/40 constants.

`cameras` has `{modelKey,gridWidth,gridHeight,patchKeyIndices}`. Patch indices are
row-major and refer to the actual camera's image-key group.

Every step/layer/query-group combination has one `slices` entry:

- `stepIndex`, `layer`, `queryGroup`.
- `masses: [{groupId,value}]`: unrenormalized softmax mass for every key group.
  Sum is approximately one (zero for empty queries), tolerance 0.003.
- `maps: [{modelKey,valuesF16LE}]`: one map per camera, row-major little-endian
  IEEE binary16 probabilities, base64 encoded. Byte length is grid cells times 2.
  Values must be finite in [0,1]; their sum cannot exceed camera mass. When image
  groups contain only patch keys, sums must agree within 0.003.
- `sinkCandidates: [{keyIndex,label,mass}]`: up to 16 concentration candidates.
  `sinkMethod` describes the method/threshold at attention root. A candidate is
  not proof that a token is meaningless. Layer/group-specific candidates remain
  separate in All view because truncated top-k sets cannot reconstruct exact pooled top-k.

All layers and denoise steps are retained. Initial UI chooses the last step,
an equal-weight average of all layers, all queries and Front. Individual layers
remain selectable. Raw maps, camera/role masses and letterbox mass use identical
layer/query weights before any display contrast. Query count is not multiplied
by layer count. The default contrast uses the selected camera's valid-region
P95 and square root; shared-maximum linear contrast remains optional. Raw masses
are never renormalized away. Deep image-token representations contain mixed context;
hotspots do not establish pixel-exclusive use, causality, or affordance.

Optional instruction-to-image capture is not part of this action-map v1 payload.
It needs a separate prefix-pass schema with exact instruction query rows before
integration, rather than duplicated denoise slices.

### Projection

Projection reads the saved action chunk; it does not accept invented TCP paths.
Provide `modelKey` for the original Front image,
`referenceFrame: link_torso_5`, `calibrationId`, `calibrationHash`,
`poseEvidence: {kind: recorded/declared_fixed,description}`,
`assumption: anchor_reference_fixed`, nullable `profileHash`, and `source`
using the existing explicit Prediction source declaration.

Joint input requires a matching catalog profile, known rad/deg units, absolute
positions and nominal sign/zero confirmation. Cartesian input requires explicit
units/orientation, absolute representation and matching reference frame.

`camera` contains original image dimensions, distinct fx/fy and cx/cy,
`cameraFromReference` (16 row-major rigid-transform entries, column vectors,
meters), and `distortion`:

- `{kind: none}` only for explicitly declared undistorted/pinhole imagery.
- `{kind: brown_conrady, coefficients: [k1,k2,p1,p2,k3]}` for the forward model.

Optical coordinates are +x right, +y down, +z forward. Inverse Brown-Conrady is
NOT equivalent and is not supported in v1. Missing coefficients must not be
replaced with zeros. Invalid rotations, nonfinite points, z <= 0, out-of-image
points and padded rows produce gaps, never joined across failures. Subpixel
coordinates are preserved; visible bounds are [0,width) x [0,height).

The camera/reference is fixed at the selected anchor for the whole chunk. The
UI states this assumption and shows pose evidence. GT means TCP targets from
stored GT actions, not measured future hand motion.

## Current integration boundary

The JAX adapter 1.2.0 is connected through a short-lived diagnostic process with
GPU-memory preflight and same-observation RGB extraction. Packet v2 adds float32,
nullable geometry, letterbox masses and original adapter arrays/metadata.
Text-query capture remains unsupported; PyTorch checkpoints use the PyTorch adapter (see diagnostic-execution.md). Existing local robot-masks
calibration/video metadata was not automatically associated with current
evaluations: its fit values/frame coverage differ and distortion coefficients
are missing. No real projection is claimed until matching evidence is supplied.
