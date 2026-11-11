# Attention adapter bridge

`diagnostics_worker.py` is standard-library-only at import and intentionally has
no `__main__` invocation. Run a fresh SSH stdin process using the selected
repository's `.venv/bin/python -u -`. Do not run inside the evaluator process.

The TypeScript runner sends this file's source, followed by a loader that decodes
three zlib-compressed, base64 constants: request JSON, exact `worker.py` source,
and exact UTF-8 `attention_adapter.py` source. SHA256-verify the adapter bytes
before decoding; set `request.adapterSha256` to the verified digest. Append:

```python
raise SystemExit(runtime_main(request, worker_source, adapter_source))
```

There are **no payload argv arguments**, avoiding Linux's individual argument
size limit. `runtime_main` accepts an already-decoded request dictionary.
`worker_source` can also be the extracted `RUNTIME_SOURCE`; that variant needs
`request.metadata` for v2 datasets. Full `worker.py` source supports both v2/v3.
The worker is exec-loaded under non-main module names, so neither entry point runs.
Cancellation targets the isolated process group, not the ordinary evaluator.
The runtime installs Linux `PR_SET_PDEATHSIG(SIGTERM)`, checks parent identity
after registration, and handles TERM/INT/HUP by killing its whole process group.
Python signal delivery can be deferred during a native call; the SSH runner
must retain process-group TERM/KILL escalation for a bounded cancellation.

Required request fields: `jobId`, `episode`, `frame`, `repo`, `dataset`, `config`,
`checkpoint`, `seed`, `numSteps`, `actionNames`, `savedActions`,
`savedValid`, `savedActionsScope` (`chunk` or `trace_row`), and `adapterSha256`. `savedActions` is the stored
evaluated horizon-by-channel output, not ground truth. A `trace_row` compares only
the first output action; a `chunk` compares the complete stored chunk. `savedValid` is a boolean
horizon mask used only for that comparison. Optional fields:
`minimumFreeMiB` (default and floor 20480), `adapterVersion` (default `1.2.0`),
`backend`, `imageRoles` (dataset key to front/left_wrist/right_wrist), and
`actionUnits` (channel name to explicitly known unit).

Memory preflight uses visible GPUs from `nvidia-smi`, failing closed if unknown
or below 20 GiB, before executing worker/adapter sources or importing OpenPi/JAX.
PyTorch checkpoints use `attention_adapter_pytorch.py` and the PyTorch interpreter;
without that adapter they are reported unsupported before model loading. No global training config
is changed. Assets are local-only using the shipped worker's `local_asset`.

The selected frame uses the shipped `load_dataset` and **actual `score_frames`**
for raw data, task prompt, repack, output-space ground truth transformations and
noise. A dataset observer retains the original decoded RGB frame, and an
inference observer exits scoring after one ordinary `policy.infer` call followed
by `collect_action_image_attention(reference_actions=normal_actions)`.
`numSteps` is passed to both policy creation and diagnostics. All query ranges
come from adapter output, regardless of the saved ground-truth validity mask.

Events are newline-delimited `VLAEVAL_DIAGNOSTIC ` plus strict JSON:
`{type:"started",pid}`, `{type:"progress",message,status:"preflight"|"running"}`,
`{type:"result",packet}`, or
`{type:"error",message,status:"blocked"|"unsupported"|"failed"}`.
Return code is zero only for a result. Other stdout is not a protocol event.

`build_packet(arrays, metadata, observation, raw_images, request)` is the CPU-only
bridge API. It emits schema 2, float32 little-endian base64 maps, nullable
unresolved preprocessing/patch fractions/letterbox mass, preserved
`adapterMetadata`, separate `sameProcessDifferences` and saved-run
`actionDifferences`, and null projection (no calibration supplied).
Nonfinite metadata becomes null, never zero. No unit is inferred from channel
names: the default is `native/unknown`. Known pi05 model camera keys are mapped
explicitly; unknown mappings fail unsupported unless `imageRoles` supplies them.

Original encoded RGB PNG/JPEG bytes are retained when supplied. Dataset-decoded
CHW/HWC RGB arrays are losslessly encoded as PNG, with SHA256 of the emitted
bytes and original dimensions; these are not resized model-input images.
Measured resolved geometry composes resize, transpose and flips in image-edge
coordinates. Source metadata remains available for pixel-center conventions.

CPU verification:

```sh
PYTHONDONTWRITEBYTECODE=1 python -m pytest -q tests/test_diagnostics_worker.py
```

The sample regression reads sibling `vlaeval-attention/out/sample_output.npz`
and JSON if available. It tests saved adapter buffers, not a GPU execution.
