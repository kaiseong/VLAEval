"""Selected-frame diagnostics, transported as source on Python stdin.

Importing this module uses only the standard library. The runner appends an
explicit runtime_main(request, worker_source, adapter_source) invocation.
"""
from __future__ import annotations

import ast
import base64
import copy
import ctypes
import dataclasses
import hashlib
import io
import json
import math
import os
from pathlib import Path
import signal
import subprocess
import sys
import time
import types
from typing import Final

PREFIX: Final = "VLAEVAL_DIAGNOSTIC "
ADAPTER_SCHEMA: Final = "vlaeval.attention_diagnostics/2"
ADAPTER_VERSION: Final = "1.2.0"
PYTORCH_ADAPTER_VERSION: Final = "2.0.0"


class DiagnosticError(RuntimeError):
    """A failure with a transport-visible category."""

    def __init__(self, message: str, code: str = "failed") -> None:
        super().__init__(message)
        self.code = code


def emit(event) -> None:
    print(PREFIX + json.dumps(event, allow_nan=False, separators=(",", ":")), flush=True)


def progress(stage: str, message: str) -> None:
    emit({"type": "progress", "message": message, "status": "preflight" if stage == "preflight" else "running"})


def clean_json(value):
    """Preserve metadata structure, replacing nonfinite unresolved values by null."""
    match value:
        case dict():
            return {key: clean_json(item) for key, item in value.items()}
        case list() | tuple():
            return [clean_json(item) for item in value]
        case float():
            return value if math.isfinite(value) else None
        case _:
            return value


def install_lifecycle() -> None:
    """Own an isolated process group and terminate it on cancellation/SSH death."""
    parent = os.getppid()
    if os.getpgrp() != os.getpid():
        os.setpgid(0, 0)

    def terminate(signum, _frame) -> None:
        # SIGKILL also reaps native/XLA helpers which cannot service Python signals.
        os.killpg(os.getpgrp(), signal.SIGKILL)

    signal.signal(signal.SIGTERM, terminate)
    signal.signal(signal.SIGINT, terminate)
    signal.signal(signal.SIGHUP, terminate)
    signal.pthread_sigmask(signal.SIG_UNBLOCK, {signal.SIGTERM, signal.SIGINT, signal.SIGHUP})
    if sys.platform.startswith("linux"):
        libc = ctypes.CDLL(None, use_errno=True)
        if libc.prctl(1, signal.SIGTERM, 0, 0, 0) != 0:
            raise DiagnosticError(f"Cannot install parent-death signal: errno {ctypes.get_errno()}")
        if os.getppid() != parent or parent == 1:
            terminate(signal.SIGTERM, None)


def gpu_preflight(minimum_free_mib: int = 20480) -> int:
    """Fail closed before executing any source that could import JAX."""
    minimum = max(20480, minimum_free_mib)
    try:
        result = subprocess.run(
            ["nvidia-smi", "--query-gpu=index,uuid,memory.free", "--format=csv,noheader,nounits"],
            capture_output=True, text=True, timeout=20, check=True,
        )
        rows = [tuple(part.strip() for part in line.split(",")) for line in result.stdout.splitlines() if line.strip()]
        visible = os.environ.get("CUDA_VISIBLE_DEVICES")
        if visible is not None:
            selectors = visible.split(",")
            rows = [row for row in rows if any(row[0] == s.strip() or row[1].startswith(s.strip())
                                               for s in selectors if s.strip() and s.strip() != "-1")]
        free = min(int(row[2]) for row in rows)
    except (OSError, subprocess.SubprocessError, ValueError, IndexError) as exc:
        raise DiagnosticError(f"Cannot establish available GPU memory: {exc}", "blocked") from exc
    if free < minimum:
        raise DiagnosticError(f"GPU has {free} MiB free; diagnostics require >= {minimum} MiB.", "blocked")
    return free


def exec_module(source: str, name: str):
    """Register exec-loaded modules (dataclasses require sys.modules membership)."""
    module = types.ModuleType(name)
    sys.modules[name] = module
    exec(compile(source, name + ".py", "exec"), module.__dict__)
    return module


def worker_runtime(worker_source: str):
    """Extract the shipped RUNTIME_SOURCE without executing the outer worker."""
    tree = ast.parse(worker_source)
    for node in tree.body:
        if isinstance(node, ast.AnnAssign) and isinstance(node.target, ast.Name) and node.target.id == "RUNTIME_SOURCE":
            worker_source = ast.literal_eval(node.value)
            break
    return exec_module(worker_source, "vlaeval_diagnostic_worker_runtime")


def differences(actions, reference, names, valid=None, units=None, scope="chunk"):
    """Compare output-space channels; the saved GT mask never controls queries."""
    import numpy as np

    if reference is None:
        return []
    actions = np.asarray(actions, dtype=np.float64)
    reference = np.asarray(reference, dtype=np.float64)
    if scope == "trace_row":
        actions = actions[:1]
        if reference.ndim == 1:
            reference = reference[None, :]
        if valid is not None:
            valid = np.asarray(valid)[:1]
    if actions.ndim != 2 or reference.shape != actions.shape or len(names) != actions.shape[1]:
        raise DiagnosticError("Action names and reference actions must match diagnostic action shape.")
    mask = np.ones(actions.shape[0], bool) if valid is None else np.asarray(valid)
    if mask.shape != (actions.shape[0],) or mask.dtype.kind != "b":
        raise DiagnosticError("savedValid must be a boolean mask covering the action horizon.")
    if not mask.any():
        return []
    if not np.isfinite(actions[mask]).all() or not np.isfinite(reference[mask]).all():
        raise DiagnosticError("Compared actions must be finite.")
    delta = np.abs(actions[mask] - reference[mask]).max(axis=0)
    return [{"channel": name, "unit": (units or {}).get(name, "native/unknown"),
             "maxAbsolute": float(delta[i]), "atol": None, "rtol": None, "exceededCount": None}
            for i, name in enumerate(names)]


def preprocessing(camera):
    """Compose the measured resize and flips, in image-edge coordinates."""
    if not camera["geometry_resolved"] or camera["transform"] is None:
        return None
    transform = camera["transform"]
    height, width = transform["model_input_hw"]
    sy, sx = transform["scale_hw"]
    oy, ox = transform["offset_hw"]
    rh, rw = transform["resized_hw"]
    flags = transform["flips"]
    # Probe transposition changes which source axis maps to model x/y.
    oh, ow = transform["original_hw"]
    a, b, c, d = (0, rh / ow, rw / oh, 0) if flags["transposed"] else (sx, 0, 0, sy)
    if flags["horizontal"]:
        a, c = -a, -c
    if flags["vertical"]:
        b, d = -b, -d
    return {"inputWidth": width, "inputHeight": height,
            "sourceToInput": [a, b, c, d, ox + (rw if flags["horizontal"] else 0),
                              oy + (rh if flags["vertical"] else 0)],
            "contentRect": [ox, oy, rw, rh]}


def image_role(camera, raw_images, request):
    key, model_key = camera["dataset_key"], camera["model_key"]
    # Explicitly known pi05 mappings; unfamiliar keys require caller evidence.
    roles = {"base_0_rgb": "front", "left_wrist_0_rgb": "left_wrist",
             "right_wrist_0_rgb": "right_wrist"}
    role = request.get("imageRoles", {}).get(key, roles.get(model_key))
    if key is None or key not in raw_images or role not in {"front", "left_wrist", "right_wrist"}:
        raise DiagnosticError(f"Unresolved image source/role: dataset={key}, model={model_key}", "unsupported")
    return role


def original_image(camera, raw_images, request):
    """Encode the actual decoded RGB frame, never the resized model input."""
    import numpy as np
    from PIL import Image

    key, model_key = camera["dataset_key"], camera["model_key"]
    role = image_role(camera, raw_images, request)
    value = raw_images[key]
    if isinstance(value, bytes):
        with Image.open(io.BytesIO(value)) as image:
            if image.mode != "RGB" or image.format not in {"PNG", "JPEG"}:
                raise DiagnosticError("Original encoded image must be RGB PNG/JPEG.")
            width, height = image.size
            mime = "image/png" if image.format == "PNG" else "image/jpeg"
        payload = value
    else:
        rgb = np.asarray(value)
        if rgb.ndim != 3:
            raise DiagnosticError("Original RGB image must have three dimensions.")
        if rgb.shape[0] == 3 and rgb.shape[-1] != 3:
            rgb = rgb.transpose(1, 2, 0)
        if rgb.shape[-1] != 3:
            raise DiagnosticError("Original image must have exactly three RGB channels.")
        if rgb.dtype.kind == "f":
            if not np.isfinite(rgb).all() or rgb.min() < 0 or rgb.max() > 1:
                raise DiagnosticError("Decoded floating RGB must be finite in [0, 1].")
            rgb = np.rint(rgb * 255).astype(np.uint8)
        if rgb.dtype != np.uint8:
            raise DiagnosticError("Decoded RGB must be uint8 or floating [0, 1].")
        height, width = rgb.shape[:2]
        stream = io.BytesIO()
        Image.fromarray(rgb).save(stream, format="PNG")
        payload, mime = stream.getvalue(), "image/png"
    return {"role": role, "datasetKey": key, "modelKey": model_key, "width": width, "height": height,
            "timestampSeconds": float(request.get("timestampSeconds", 0)),
            "sha256": hashlib.sha256(payload).hexdigest(), "mime": mime,
            "dataBase64": base64.b64encode(payload).decode(),
            "geometryResolved": bool(camera["geometry_resolved"]),
            "preprocessing": preprocessing(camera)}


def build_packet(arrays, metadata, observation, raw_images, request):
    """Bridge adapter arrays/metadata and original observations to packet schema 2."""
    import numpy as np

    if metadata["schema_version"] != ADAPTER_SCHEMA:
        raise DiagnosticError("Unsupported adapter metadata schema.", "unsupported")
    dist = np.asarray(arrays["key_attention"])
    if dist.ndim != 4 or dist.shape[2] != 2 or not np.isfinite(dist).all() or (dist < 0).any() or (dist > 1).any():
        raise DiagnosticError("Attention must be finite nonnegative float32 probabilities.")
    steps, layers, _, keys = dist.shape
    if steps != request["numSteps"] or layers != metadata["axes"]["layer"]["size"]:
        raise DiagnosticError("Returned step/layer axes differ from the requested complete capture.")
    if not np.allclose(dist.astype(np.float64).sum(-1), 1, atol=2e-5, rtol=0):
        raise DiagnosticError("Attention distributions must sum to one.")
    roles = metadata["token_layout"]["roles"]
    key_roles = np.asarray(arrays["key_role"])
    if key_roles.shape != (keys,) or (key_roles < 0).any() or (key_roles >= len(roles)).any():
        raise DiagnosticError("Key roles must partition all keys.")
    groups = []
    for index, role in enumerate(roles):
        indices = np.flatnonzero(key_roles == index).tolist()
        if not indices:
            continue
        image = role.startswith("camera:")
        group = {"id": role, "kind": "image" if image else role if role in {
            "instruction", "state", "action", "padding", "other"} else "other", "keyIndices": indices}
        if image:
            group["modelKey"] = role.split(":", 1)[1]
        groups.append(group)
    horizon = metadata["axes"]["query_group"]["horizon"]
    ranges = np.asarray(arrays["query_groups"])
    if (ranges.shape != (2, 2) or ranges.dtype.kind not in "iu"
            or not 0 < int(ranges[0, 1]) < horizon
            or ranges.tolist() != [[0, int(ranges[0, 1])], [int(ranges[0, 1]), horizon]]):
        raise DiagnosticError("Query ranges must partition the returned horizon.")
    flow = np.asarray(arrays["flow_t"])
    if flow.shape != (steps,) or not np.isfinite(flow).all():
        raise DiagnosticError("Flow times must identify every returned denoise step.")
    query_offset = metadata["token_layout"]["suffix"]["len"] - horizon
    query_groups = [{"id": name, "horizonIndices": list(range(int(a), int(b))),
                     "queryRows": list(range(query_offset + int(a), query_offset + int(b)))}
                    for name, (a, b) in zip(("early", "late"), ranges, strict=True)]
    cameras, images = [], []
    for ci, camera in enumerate(metadata["cameras"]):
        gh, gw = camera["grid_hw"]
        start, end = camera["token_range"]
        if end - start != gh * gw or not 0 <= start < end <= keys:
            raise DiagnosticError("Camera token range differs from patch grid.")
        fraction = np.asarray(arrays["patch_valid_fraction"])[ci].reshape(-1)
        resolved = camera["geometry_resolved"] and np.isfinite(fraction).all()
        cameras.append({"modelKey": camera["model_key"], "gridWidth": gw, "gridHeight": gh,
                        "patchKeyIndices": list(range(start, end)),
                        "patchValidFraction": fraction.tolist() if resolved else None})
        images.append(original_image(camera, raw_images, request))
    slices = []
    for step in range(steps):
        for layer in range(layers):
            for qi, name in enumerate(("early", "late")):
                row = dist[step, layer, qi]
                maps = []
                for ci, camera in enumerate(cameras):
                    values = row[camera["patchKeyIndices"]]
                    fraction = camera["patchValidFraction"]
                    letterbox = None if fraction is None else float(values[np.asarray(fraction) == 0].astype(np.float64).sum())
                    maps.append({"modelKey": camera["modelKey"],
                                 "valuesF32LE": base64.b64encode(values.astype("<f4").tobytes()).decode(),
                                 "letterboxMass": letterbox})
                top = np.argsort(-row, kind="stable")[:8]
                slices.append({"stepIndex": step, "layer": layer, "queryGroup": name,
                               "masses": [{"groupId": g["id"], "value": float(row[g["keyIndices"]].astype(np.float64).sum())} for g in groups],
                               "maps": maps,
                               "sinkCandidates": [{"keyIndex": int(k), "label": roles[int(key_roles[k])],
                                                   "mass": float(row[k])} for k in top]})
    digest = hashlib.sha256()
    def hash_input(value):
        if isinstance(value, dict):
            for key in sorted(value):
                digest.update(key.encode())
                hash_input(value[key])
        else:
            array = np.asarray(value)
            digest.update(str(array.dtype).encode() + repr(array.shape).encode() + array.tobytes())
    hash_input(observation)
    timing = metadata.get("timing", {})
    memory = metadata.get("memory", {})
    after = memory.get("device_after") or {}
    compiled = memory.get("compiled_memory_analysis") or {}
    def ms(key):
        value = timing.get(key)
        return None if value is None else value * 1000
    packet = {
        "schemaVersion": 2,
        "identity": {key: request[key] for key in ("jobId", "episode", "frame", "dataset", "config", "checkpoint", "seed", "numSteps")},
        "provenance": {"kind": "captured", "adapterRevision": metadata["run_identity"]["adapter"]["version"],
                       "adapterSchema": ADAPTER_SCHEMA, "backend": request.get("backend", "jax"), "dtype": str(dist.dtype),
                       "compiled": request.get("backend", "jax") == "jax", "inputDigest": digest.hexdigest(),
                       "noiseDigest": metadata.get("reproduction", {}).get("noise_sha256")},
        "images": images,
        "attention": {"kind": "action_to_image", "layers": list(range(layers)),
                      "steps": [{"index": i, "flowTime": float(t)} for i, t in enumerate(arrays["flow_t"])],
                      "headReduction": "mean", "headCount": metadata["axes"]["layer"]["num_heads"],
                      "horizon": horizon, "queryGroups": query_groups, "keyCount": keys,
                      "keyGroups": groups, "cameras": cameras, "slices": slices,
                      "sinkMethod": "Top eight keys per slice, stable descending raw attention; candidates, not causal attribution."},
        "projection": None, "adapterMetadata": metadata,
        "actionDifferences": differences(arrays["actions"], request.get("savedActions"), request["actionNames"],
                                         request.get("savedValid"), request.get("actionUnits"),
                                         request.get("savedActionsScope", "chunk")),
        "sameProcessDifferences": differences(arrays["actions"], arrays.get("reference_actions"),
                                              request["actionNames"], units=request.get("actionUnits")),
        "timing": {"compileMs": ms("compile_s"), "warmupMs": None, "inferenceMs": ms("execute_s"),
                   "extractionMs": ms("extraction_s"), "peakGpuBytes": after.get("peak_bytes_in_use"),
                   "prepareMs": ms("prepare_s"), "referenceInferenceMs": request.get("referenceInferenceMs", ms("reference_infer_s")),
                   "totalMs": request.get("totalMs", ms("total_s")), "hostTransferBytes": timing.get("host_transfer_bytes"),
                   "compiledTempBytes": compiled.get("temp_size_in_bytes")},
    }
    archive = io.BytesIO()
    np.savez_compressed(archive, **arrays)
    archive_bytes = archive.getvalue()
    packet["adapterArrays"] = {"encoding": "npz-base64", "sha256": hashlib.sha256(archive_bytes).hexdigest(),
                               "dataBase64": base64.b64encode(archive_bytes).decode()}
    return clean_json(packet)


class _Captured(Exception):
    """Exit score_frames once its own loader/repack/noise reaches selected infer."""


def capture_selected(runtime, adapter, dataset, policy, data, model, request, metadata, adapter_sha):
    """Reuse score_frames itself, including its exact repack and noise contract."""
    import numpy as np

    episode, frame = request["episode"], request["frame"]
    offset = 0
    for item in metadata["episodes"]:
        if item["index"] == episode:
            if not 0 <= frame < item["length"]:
                raise DiagnosticError("Selected frame is outside the episode.")
            selection = [(offset + frame, episode, frame, item["length"])]
            break
        offset += item["length"]
    else:
        raise DiagnosticError("Selected episode is absent from the dataset.")
    raw = {}
    packet = None

    class DatasetCapture:
        meta = dataset.meta

        def __getitem__(self, index):
            value = dataset[index]
            raw.update({key: np.asarray(value) if hasattr(value, "numpy") else copy.deepcopy(value)
                        for key, value in value.items()})
            return value

    class PolicyCapture:
        def infer(self, observation, *, noise):
            nonlocal packet
            progress("reference", "Running ordinary policy.infer first in this process.")
            started = time.perf_counter()
            normal = np.asarray(policy.infer(copy.deepcopy(observation), noise=noise.copy())["actions"]).copy()
            reference_ms = (time.perf_counter() - started) * 1000
            progress("attention", "Collecting all denoise steps and transformer layers.")
            result = adapter.collect_action_image_attention(
                policy, copy.deepcopy(observation), noise=noise.copy(), num_steps=request["numSteps"],
                input_key_map=adapter.dataset_key_map_from_repack(data.repack_transforms),
                reference_actions=normal,
                run_info={"config_name": request["config"], "checkpoint": request["checkpoint"],
                          "dataset": request["dataset"], "episode": episode, "frame": frame,
                          "seed": request["seed"], "adapter_sha256": adapter_sha},
            )
            context = {**request, "timestampSeconds": float(np.asarray(raw.get("timestamp", frame / dataset.meta.fps))),
                       "referenceInferenceMs": reference_ms}
            packet = build_packet(result["arrays"], result["metadata"], observation, raw, context)
            raise _Captured()

    original_selection = runtime.select_frames
    runtime.select_frames = lambda _episodes, _request: selection
    try:
        runtime.score_frames(DatasetCapture(), PolicyCapture(), data, model, request, metadata["episodes"])
    except _Captured:
        return packet
    finally:
        runtime.select_frames = original_selection
    raise DiagnosticError("Selected frame did not reach inference.")


def thumbnail_image(camera, raw_images, request, long_side=320, quality=75):
    """JPEG thumbnail of the raw frame the model saw; geometry is rescaled to thumbnail pixels."""
    import numpy as np
    from PIL import Image

    key, model_key = camera["dataset_key"], camera["model_key"]
    role = image_role(camera, raw_images, request)
    value = raw_images[key]
    if isinstance(value, bytes):
        with Image.open(io.BytesIO(value)) as decoded:
            if decoded.mode != "RGB":
                raise DiagnosticError("Original encoded image must be RGB.")
            image = decoded.copy()
    else:
        rgb = np.asarray(value)
        if rgb.ndim == 3 and rgb.shape[0] == 3 and rgb.shape[-1] != 3:
            rgb = rgb.transpose(1, 2, 0)
        if rgb.ndim != 3 or rgb.shape[-1] != 3:
            raise DiagnosticError("Original image must be a three-channel RGB array.")
        if rgb.dtype.kind == "f":
            if not np.isfinite(rgb).all() or rgb.min() < 0 or rgb.max() > 1:
                raise DiagnosticError("Decoded floating RGB must be finite in [0, 1].")
            rgb = np.rint(rgb * 255).astype(np.uint8)
        if rgb.dtype != np.uint8:
            raise DiagnosticError("Decoded RGB must be uint8 or floating [0, 1].")
        image = Image.fromarray(np.ascontiguousarray(rgb))
    width, height = image.size
    scale = min(1.0, long_side / max(width, height))
    size = (max(1, round(width * scale)), max(1, round(height * scale)))
    if size != (width, height):
        image = image.resize(size, Image.Resampling.BILINEAR)
    stream = io.BytesIO()
    image.save(stream, format="JPEG", quality=quality)
    payload = stream.getvalue()
    geometry = preprocessing(camera)
    if geometry is not None:
        # Thumbnail pixel u maps to source pixel u * width / thumb_width; fold that into the affine.
        sx, sy = width / size[0], height / size[1]
        a, b, c, d, e, f = geometry["sourceToInput"]
        geometry = {**geometry, "sourceToInput": [a * sx, b * sx, c * sy, d * sy, e, f]}
    return {"role": role, "datasetKey": key, "modelKey": model_key, "width": size[0], "height": size[1],
            "timestampSeconds": float(request.get("timestampSeconds", 0)),
            "sha256": hashlib.sha256(payload).hexdigest(), "mime": "image/jpeg",
            "dataBase64": base64.b64encode(payload).decode(),
            "geometryResolved": bool(camera["geometry_resolved"]) and geometry is not None,
            "preprocessing": geometry}


def reduce_attention(arrays, metadata, num_steps):
    """Last denoise step, query-count-weighted over both groups: (layer mean, per-layer [L, keys], roles)."""
    import numpy as np

    if metadata["schema_version"] != ADAPTER_SCHEMA:
        raise DiagnosticError("Unsupported adapter metadata schema.", "unsupported")
    dist = np.asarray(arrays["key_attention"])
    if dist.ndim != 4 or dist.shape[2] != 2 or not np.isfinite(dist).all() or (dist < 0).any() or (dist > 1).any():
        raise DiagnosticError("Attention must be finite nonnegative float32 probabilities.")
    steps, layers, _, keys = dist.shape
    if steps != num_steps or layers != metadata["axes"]["layer"]["size"]:
        raise DiagnosticError("Returned step/layer axes differ from the requested complete capture.")
    horizon = metadata["axes"]["query_group"]["horizon"]
    ranges = np.asarray(arrays["query_groups"])
    if (ranges.shape != (2, 2) or ranges.dtype.kind not in "iu"
            or not 0 < int(ranges[0, 1]) < horizon
            or ranges.tolist() != [[0, int(ranges[0, 1])], [int(ranges[0, 1]), horizon]]):
        raise DiagnosticError("Query ranges must partition the returned horizon.")
    counts = (ranges[:, 1] - ranges[:, 0]).astype(np.float64)
    per_layer = (dist[-1].astype(np.float64) * counts[None, :, None]).sum(axis=1) / counts.sum()
    vector = per_layer.mean(axis=0)
    if not np.isclose(vector.sum(), 1, atol=2e-5, rtol=0):
        raise DiagnosticError("Attention distributions must sum to one.")
    roles = metadata["token_layout"]["roles"]
    key_roles = np.asarray(arrays["key_role"])
    if key_roles.shape != (keys,) or (key_roles < 0).any() or (key_roles >= len(roles)).any():
        raise DiagnosticError("Key roles must partition all keys.")
    return vector, per_layer, key_roles


def video_layout(arrays, metadata, key_roles, raw_images, request):
    """Key groups and camera grids, fixed for the whole episode."""
    import numpy as np

    roles = metadata["token_layout"]["roles"]
    groups = []
    for index, role in enumerate(roles):
        indices = np.flatnonzero(key_roles == index)
        if not indices.size:
            continue
        image = role.startswith("camera:")
        group = {"id": role, "kind": "image" if image else role if role in {
            "instruction", "state", "action", "padding", "special", "other"} else "other"}
        if image:
            group["modelKey"] = role.split(":", 1)[1]
        groups.append((group, indices))
    cameras = []
    keys = key_roles.shape[0]
    for ci, camera in enumerate(metadata["cameras"]):
        gh, gw = camera["grid_hw"]
        start, end = camera["token_range"]
        if end - start != gh * gw or not 0 <= start < end <= keys:
            raise DiagnosticError("Camera token range differs from patch grid.")
        fraction = np.asarray(arrays["patch_valid_fraction"])[ci].reshape(-1)
        resolved = bool(camera["geometry_resolved"]) and fraction.shape == (gh * gw,) and np.isfinite(fraction).all()
        cameras.append(({"role": image_role(camera, raw_images, request), "modelKey": camera["model_key"],
                         "datasetKey": camera["dataset_key"], "gridWidth": gw, "gridHeight": gh,
                         "patchValidFraction": fraction.astype(np.float64).tolist() if resolved else None},
                        (start, end), camera))
    return {"keys": keys, "roles": list(roles), "groups": groups, "cameras": cameras}


def video_frame(vector, per_layer, layout, raw_images, request):
    """One playback frame: group masses, per-camera float32 mean and float16 per-layer maps, thumbnails."""
    import numpy as np

    masses = []
    for group, indices in layout["groups"]:
        value = float(vector[indices].sum())
        if value > 1 + 1e-5:
            raise DiagnosticError("Group attention mass exceeds one.")
        masses.append({"groupId": group["id"], "value": min(1.0, value)})
    maps, images = [], []
    for camera, (start, end), source in layout["cameras"]:
        values = vector[start:end].astype("<f4")
        fraction = camera["patchValidFraction"]
        letterbox = None if fraction is None else min(1.0, float(vector[start:end][np.asarray(fraction) == 0].sum()))
        layers = np.ascontiguousarray(per_layer[:, start:end]).astype("<f2")
        maps.append({"modelKey": camera["modelKey"], "valuesF32LE": base64.b64encode(values.tobytes()).decode(),
                     "layersF16LE": base64.b64encode(layers.tobytes()).decode(),
                     "letterboxMass": letterbox})
        images.append(thumbnail_image(source, raw_images, request))
    return {"frame": request["frame"], "timestampSeconds": float(request["timestampSeconds"]),
            "masses": masses, "maps": maps, "images": images}


def capture_video(runtime, adapter, dataset, policy, data, model, request, metadata, adapter_sha):
    """Drive score_frames over frames 0, stride, 2*stride, ... with attention collection as inference."""
    import numpy as np

    episode, stride = request["episode"], request["stride"]
    item = next((entry for entry in metadata["episodes"] if entry["index"] == episode), None)
    if item is None:
        raise DiagnosticError("Selected episode is absent from the dataset.")
    length = int(item["length"])
    total = len(range(0, length, stride))
    fps = float(dataset.meta.fps)
    raw, frames, timings = {}, [], []
    state = {"frame": None, "layout": None, "last": None}
    key_map = adapter.dataset_key_map_from_repack(data.repack_transforms)

    class DatasetCapture:
        meta = dataset.meta

        def __getitem__(self, index):
            value = dataset[index]
            raw.clear()
            raw.update({key: np.asarray(item) if hasattr(item, "numpy") else copy.deepcopy(item)
                        for key, item in value.items()})
            state["frame"] = int(np.asarray(raw["frame_index"]))
            return value

    class PolicyCapture:
        def infer(self, observation, *, noise):
            frame = state["frame"]
            # score_frames warms up with a duplicate first call; reuse that frame's actions.
            if state["last"] is not None and state["last"][0] == frame:
                return {"actions": state["last"][1].copy()}
            started = time.perf_counter()
            result = adapter.collect_action_image_attention(
                policy, copy.deepcopy(observation), noise=noise.copy(), num_steps=request["numSteps"],
                input_key_map=key_map, compare_with_infer=False,
                run_info={"config_name": request["config"], "checkpoint": request["checkpoint"],
                          "dataset": request["dataset"], "episode": episode, "frame": frame,
                          "seed": request["seed"], "adapter_sha256": adapter_sha},
            )
            arrays, meta = result["arrays"], result["metadata"]
            vector, per_layer, key_roles = reduce_attention(arrays, meta, request["numSteps"])
            if state["layout"] is None:
                state["layout"] = video_layout(arrays, meta, key_roles, raw, request)
                state["revision"] = meta["run_identity"]["adapter"]["version"]
            elif state["layout"]["keys"] != key_roles.shape[0] or state["layout"]["roles"] != list(meta["token_layout"]["roles"]):
                raise DiagnosticError("Token layout changed within the episode.")
            timestamp = float(np.asarray(raw.get("timestamp", frame / fps)))
            state["layers"] = per_layer.shape[0]
            frames.append(video_frame(vector, per_layer, state["layout"], raw,
                                      {**request, "frame": frame, "timestampSeconds": timestamp}))
            timings.append((time.perf_counter() - started) * 1000)
            if len(frames) % 10 == 0 or len(frames) == total:
                emit({"type": "progress", "status": "running",
                      "message": f"attention video frame {len(frames)}/{total}"})
            actions = np.asarray(arrays["actions"]).copy()
            state["last"] = (frame, actions)
            return {"actions": actions.copy()}

    runtime.score_frames(DatasetCapture(), PolicyCapture(), data, model, request, metadata["episodes"])
    if len(frames) != total or state["layout"] is None:
        raise DiagnosticError(f"Attention video captured {len(frames)} of {total} frames.")
    layout = state["layout"]
    return clean_json({
        "schemaVersion": 1,
        "identity": {key: request[key] for key in ("jobId", "episode", "dataset", "config", "checkpoint", "seed", "numSteps")},
        "provenance": {"kind": "captured", "adapterRevision": state["revision"],
                       "adapterSchema": ADAPTER_SCHEMA, "backend": request.get("backend", "jax")},
        "selection": {"stepIndex": request["numSteps"] - 1, "layers": "all", "queries": "all", "stride": stride,
                      "layerCount": state["layers"]},
        "fps": fps, "episodeLength": length,
        "keyGroups": [group for group, _ in layout["groups"]],
        "cameras": [camera for camera, _, _ in layout["cameras"]],
        "frames": frames,
        "timing": {"totalMs": 0.0, "perFrameMs": float(sum(timings) / len(timings)), "frames": len(frames)},
    })


def prepare_policy(request, worker_source, adapter_source, overrides, purpose):
    """Shared setup: backend detection, SHA/version checks, GPU preflight, offline env, policy load."""
    checkpoint = Path(request["checkpoint"]).expanduser()
    if checkpoint.name in {"params", "model.safetensors"}:
        checkpoint = checkpoint.parent
    backend = "pytorch" if (checkpoint / "model.safetensors").is_file() else "jax"
    if request.get("backend", backend) != backend:
        raise DiagnosticError("Requested backend differs from the checkpoint format.")
    request["backend"] = backend
    if not adapter_source:
        raise DiagnosticError(f"No {backend} attention adapter is available.", "unsupported")
    adapter_sha = hashlib.sha256(adapter_source.encode("utf-8")).hexdigest()
    if request.get("adapterSha256") != adapter_sha:
        raise DiagnosticError("Adapter source SHA256 does not match request.adapterSha256.")
    progress("preflight", f"Checking >=20 GiB free GPU memory before importing {backend}.")
    gpu_preflight(request.get("minimumFreeMiB", 20480))
    sys.dont_write_bytecode = True
    os.environ["XLA_PYTHON_CLIENT_PREALLOCATE"] = "false"
    os.environ["HF_HUB_OFFLINE"] = "1"
    os.environ["HF_DATASETS_OFFLINE"] = "1"
    repo = Path(request["repo"]).expanduser()
    sys.path[:0] = [str(repo / "src"), str(repo / "packages/openpi-client/src")]
    runtime = worker_runtime(worker_source)
    from openpi.shared import download
    download.maybe_download = runtime.local_asset
    from openpi.training import config
    from openpi.policies.policy_config import create_trained_policy
    selected = config.get_config(request["config"])
    if backend == "pytorch" and getattr(selected.model, "pytorch_compile_mode", None) is not None:
        # Attention capture replaces eager_attention_forward; a compiled graph would bypass it.
        selected = dataclasses.replace(selected, model=dataclasses.replace(selected.model, pytorch_compile_mode=None))
    data = selected.data.create(selected.assets_dirs, selected.model)
    if data.rlds_data_dir or len(data.action_sequence_keys) != 1:
        raise DiagnosticError("Requires one LeRobot action sequence, not RLDS.", "unsupported")
    if selected.model.action_horizon > 256 or selected.model.action_dim > 256:
        raise DiagnosticError("Model exceeds evaluator horizon/action dimension caps.", "unsupported")
    outer = exec_module(worker_source, "vlaeval_diagnostic_outer") if "RUNTIME_SOURCE" in worker_source else None
    root_path = Path(request["dataset"]).expanduser()
    with (root_path / "meta/info.json").open(encoding="utf-8") as stream:
        version = json.load(stream)["codebase_version"]
    if version == "v3.0":
        metadata = runtime.v3_metadata(root_path)[0]
    elif outer is not None:
        metadata = outer.episode_metadata(str(root_path))
    else:
        metadata = request.get("metadata")
    if metadata is None:
        raise DiagnosticError("Raw RUNTIME_SOURCE transport requires request.metadata.")
    evaluation = {**request, "operation": "evaluate", "episodes": [request["episode"]],
                  "metadata": metadata, **overrides}
    adapter = exec_module(adapter_source, "attention_adapter")
    # Patch releases of the same schema (1.2.x) are output-compatible; the exact
    # version and source SHA are still recorded in the packet provenance.
    expected = PYTORCH_ADAPTER_VERSION if backend == "pytorch" else ADAPTER_VERSION
    if (adapter.SCHEMA_VERSION != ADAPTER_SCHEMA or getattr(adapter, "BACKEND", "jax") != backend
            or str(adapter.ADAPTER_VERSION).split(".")[:2] != request.get("adapterVersion", expected).split(".")[:2]):
        raise DiagnosticError("Unsupported adapter version/schema.", "unsupported")
    dataset = runtime.load_dataset(evaluation, data, selected.model.action_horizon)
    root = runtime.checkpoint_root(str(checkpoint))
    progress("policy", f"Loading {backend} policy for {purpose}.")
    policy = create_trained_policy(selected, root, sample_kwargs={"num_steps": request["numSteps"]})
    return (runtime, adapter, dataset, policy, data, selected.model, evaluation, metadata, adapter_sha)


def guarded(body) -> int:
    """Install the lifecycle, run body, and map failures to one terminal error event."""
    try:
        install_lifecycle()
        emit({"type": "started", "pid": os.getpid()})
        body()
        return 0
    except DiagnosticError as exc:
        emit({"type": "error", "message": str(exc), "status": exc.code})
        return 1
    except NotImplementedError as exc:
        emit({"type": "error", "message": str(exc), "status": "unsupported"})
        return 1
    except (OSError, ValueError, TypeError, KeyError, AttributeError, ImportError, RuntimeError) as exc:
        emit({"type": "error", "message": f"{type(exc).__name__}: {exc}", "status": "failed"})
        return 1


def validate_request(request, required, bounds):
    for key in required:
        if key not in request:
            raise DiagnosticError(f"Missing request field: {key}")
    for key, minimum, maximum in bounds:
        if type(request[key]) is not int or not minimum <= request[key] <= maximum:
            raise DiagnosticError(f"Invalid {key}.")


def runtime_main(request: dict, worker_source: str, adapter_source: str) -> int:
    """Run in the selected repo's Python process; emit one terminal event."""
    started = time.perf_counter()

    def body():
        validate_request(request, ("jobId", "episode", "frame", "repo", "dataset", "config", "checkpoint",
                                   "seed", "numSteps", "actionNames", "savedActions", "savedValid"),
                         (("episode", 0, 1000000), ("frame", 0, 1000000),
                          ("seed", 0, 2147483647), ("numSteps", 1, 100)))
        prepared = prepare_policy(request, worker_source, adapter_source,
                                  {"maxSamples": 1, "stride": 1}, "selected-frame diagnostics")
        packet = capture_selected(*prepared)
        packet["timing"]["totalMs"] = (time.perf_counter() - started) * 1000
        emit({"type": "result", "packet": packet})

    return guarded(body)


def runtime_video_main(request: dict, worker_source: str, adapter_source: str) -> int:
    """Attention for every third frame of one episode in one JAX process; emits one video event."""
    started = time.perf_counter()

    def body():
        validate_request(request, ("jobId", "episode", "repo", "dataset", "config", "checkpoint",
                                   "seed", "numSteps"),
                         (("episode", 0, 1000000), ("seed", 0, 2147483647), ("numSteps", 1, 100)))
        if request.get("stride", 3) != 3:
            raise DiagnosticError("Attention video stride is fixed at 3.")
        prepared = prepare_policy(request, worker_source, adapter_source,
                                  {"maxSamples": 0, "stride": 3}, "episode attention video")
        video = capture_video(*prepared)
        video["timing"]["totalMs"] = (time.perf_counter() - started) * 1000
        emit({"type": "video", "video": video})

    return guarded(body)
