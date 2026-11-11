# JAX diagnostic execution

Pre-release now launches a selected saved frame explicitly. Capture defaults OFF;
switching frames, layers, denoise steps, query groups or display modes never runs
inference. Supported adapter: sibling `VLA/vlaeval-attention/attention_adapter.py`
1.2.0, schema `vlaeval.attention_diagnostics/2`. Adapter source is read at launch,
compressed and transported with its SHA256 in the diagnostic script, not imported
into ordinary evaluation.

## HTTP lifecycle

- POST `/api/jobs/{id}/diagnostics/run`, body `{episode, frame}` -> 202 run state.
- GET same path with episode/frame query -> current state, initially `idle`.
- GET same path plus `/events`, with episode/frame query -> SSE initial state and
  exact transitions; terminal state closes the stream.
- POST same path plus `/cancel`, body `{runId}` -> cancellation state.

States: idle, preflight, running, completed, failed, blocked, unsupported,
cancelling, cancelled. Completion requires remote exit and successful artifact
publication. Cancellation is not reported complete until process exit. The
selected run cannot be deleted while diagnostics owns its reservation. Ordinary
evaluation and diagnostics share one store-level reservation; no simultaneous
scoring/diagnostic GPU workload is launched by VLAEval.

Only the configured `VLAEVAL_DIAGNOSTIC_HOST` is eligible; the default is
`rtx6000@192.168.0.3`. Other stored hosts return unsupported. This prevents a
history entry from silently dispatching diagnostics to a local/training machine.

## Remote process

`src/diagnostic-runner.ts` sends an stdin script to the saved OpenPi environment.
Request, evaluator and adapter sources are compressed/encoded on stdin, not
large argv strings. `diagnostics_worker.py` imports no JAX at module load.
It installs process-group/parent-death cleanup, detects the checkpoint format
(`model.safetensors` = PyTorch, run with `VLAEVAL_PYTORCH_PYTHON`, default
`~/kgs/venvs/pi05_cu128/bin/python`, torch.compile disabled, adapter
`attention_adapter_pytorch.py`), and requires
at least 20 GiB actual free memory before JAX/model loading. This floor includes
model load/workspace margin; the adapter's ~190 MiB compiled temp analysis is
not a sufficient standalone memory budget.

Data loading, task prompt, repack and seeded noise reuse the existing evaluator's
RUNTIME_SOURCE and score_frames preparation. One ordinary policy.infer runs first
in this short-lived process; its result is passed as the adapter reference.
Saved evaluation actions are compared separately, respecting GT availability
only for those saved-action comparisons. The same-process diagnostic comparison
uses all model output rows.

The process exits after one frame to release JAX executable caches. It does not
kill or resize vLLM/DatasetUI services. OpenPi's existing dependency import may
rewrite a numpydantic stub with unchanged contents in its environment; this is
not a claim of a filesystem-write-free dependency environment. Training hosts
and checkouts are not modified.

## Packet v2 changes

The receiver accepts versions 1 and 2. v2 preserves float32 maps (`valuesF32LE`),
original adapter metadata (`adapterMetadata`) and compressed original numeric
arrays (`adapterArrays`, NPZ base64 + SHA256). Original RGB is encoded from the
same decoded dataset observation, with actual dataset/model key mapping.

- `images[].preprocessing` can be null. `geometryResolved=false` disables
  original-image attention overlay, but raw RGB and model-token grid remain
  available. Unknown geometry/letterbox values remain null, not zero.
- Camera `patchValidFraction` is geometric support, not a within-patch causal
  attention measurement. `maps[].letterboxMass` is raw mass on pure-padding keys.
- Model-token view includes letterbox regions and has a pure-padding hiding
  switch. The switch changes rendering only; mass totals stay unrenormalized.
- UI shows letterbox share of ALL keys and of that CAMERA separately.
- Query groups use adapter-returned horizon ranges, including odd horizons.
  GT padding is not invalid model attention: those masks are separate.
- `sameProcessDifferences` and saved `actionDifferences` are distinct. No blanket
  bit-identity promise or invented universal tolerance.
- Extra timing fields distinguish preparation, reference inference, total wall
  time, host transfer, and compiled temp bytes. Allocator peak is process-wide.

Model projection remains an independent camera-calibration input. Attention
capture does not invent or infer missing extrinsic/head-pose calibration.
Unsupported: text-query capture, head-specific or arm-specific maps.
