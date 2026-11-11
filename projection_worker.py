"""CPU-only, read-only selected-frame transport; importing executes no runtime."""
from __future__ import annotations

import ast
import base64
import ctypes
import hashlib
import io
import json
import math
import os
from pathlib import Path
import signal
import sys
import types
from typing import Final, TypedDict

PREFIX: Final = "VLAEVAL_PROJECTION "


class ProjectionError(RuntimeError):
    """Unsupported or inconsistent local frame data."""


class FrameRequest(TypedDict):
    repo: str
    dataset: str
    episode: int
    frame: int
    datasetKey: str


def exec_module(source: str, name: str) -> types.ModuleType:
    """Register separately compiled sources without executing CLI entrypoints."""
    module = types.ModuleType(name)
    sys.modules[name] = module
    exec(compile(source, name + ".py", "exec"), module.__dict__)
    return module


def worker_modules(source: str) -> tuple[types.ModuleType, types.ModuleType]:
    """Fail closed unless the outer worker contains a literal runtime payload."""
    for node in ast.parse(source).body:
        if isinstance(node, ast.AnnAssign) and isinstance(node.target, ast.Name) and node.target.id == "RUNTIME_SOURCE":
            runtime = ast.literal_eval(node.value)
            if not isinstance(runtime, str):
                break
            return (exec_module(source, "vlaeval_projection_outer"),
                    exec_module(runtime, "vlaeval_projection_runtime"))
    raise ProjectionError("Worker RUNTIME_SOURCE is missing or not a literal string.")


def install_lifecycle() -> None:
    """Kill the isolated group on SSH death, including native decoder helpers."""
    parent = os.getppid()
    if os.getpgrp() != os.getpid():
        os.setpgid(0, 0)

    def terminate(_signum, _frame) -> None:
        os.killpg(os.getpgrp(), signal.SIGKILL)

    for sig in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
        signal.signal(sig, terminate)
    signal.pthread_sigmask(signal.SIG_UNBLOCK, {signal.SIGTERM, signal.SIGINT, signal.SIGHUP})
    if ctypes.CDLL(None, use_errno=True).prctl(1, signal.SIGTERM, 0, 0, 0) != 0:
        raise ProjectionError("Cannot install projection parent-death signal.")
    if parent == 1 or os.getppid() != parent:
        terminate(signal.SIGTERM, None)


def safe_info(value):
    """Retain calibration/provenance structure while omitting credential fields."""
    if isinstance(value, dict):
        return {key: safe_info(item) for key, item in value.items()
                if not any(part in key.lower() for part in
                           ("secret", "token", "password", "credential", "api_key", "private_key"))}
    if isinstance(value, list):
        return [safe_info(item) for item in value]
    if isinstance(value, float) and not math.isfinite(value):
        raise ProjectionError("Nonfinite info.json metadata.")
    return value


def encode_image(value, feature):
    """Encode decoded RGB pixels losslessly, using declared shape for CHW/HWC."""
    import numpy as np
    from PIL import Image

    if isinstance(value, dict):
        if not isinstance(value.get("bytes"), bytes):
            raise ProjectionError("External image-path rows are unsupported.")
        value = value["bytes"]
    if isinstance(value, bytes):
        with Image.open(io.BytesIO(value)) as image:
            if image.mode != "RGB":
                raise ProjectionError("Encoded frame must be RGB.")
            rgb = np.asarray(image).copy()
    else:
        rgb = np.asarray(value)
        shape = feature.get("shape")
        names = feature.get("names")
        # Pinned LeRobot video decoders return CHW regardless of stored HWC shape.
        chw = names == ["channels", "height", "width"] or (
            rgb.ndim == 3 and rgb.shape[0] == 3 and rgb.shape[-1] != 3)
        if rgb.ndim == 3 and rgb.shape[0] == 3 and rgb.shape[-1] == 3:
            if names == ["height", "width", "channels"]:
                chw = False
            elif not chw:
                raise ProjectionError(f"Ambiguous RGB channel axis: {shape}; supply feature axis names.")
        if chw:
            rgb = rgb.transpose(1, 2, 0)
        if rgb.dtype.kind == "f":
            if not np.isfinite(rgb).all() or rgb.min() < 0 or rgb.max() > 1:
                raise ProjectionError("Floating RGB pixels must be finite in [0, 1].")
            rgb = np.rint(rgb * 255).astype(np.uint8)
    if rgb.ndim != 3 or rgb.shape[-1] != 3 or rgb.dtype != np.uint8:
        raise ProjectionError("Frame must decode to uint8 RGB.")
    stream = io.BytesIO()
    Image.fromarray(rgb).save(stream, format="PNG")
    payload = stream.getvalue()
    return {"width": int(rgb.shape[1]), "height": int(rgb.shape[0]), "mime": "image/png",
            "sha256": hashlib.sha256(payload).hexdigest(),
            "dataBase64": base64.b64encode(payload).decode("ascii")}


def read_frame(request: FrameRequest, worker_source: str):
    """Read one raw row with no policy, transforms, normalization, or horizon."""
    for key in ("episode", "frame"):
        if type(request[key]) is not int or request[key] < 0:
            raise ProjectionError(f"Invalid {key}.")
    if request["datasetKey"] != "observation.images.front":
        raise ProjectionError("Only observation.images.front is supported.")
    sys.dont_write_bytecode = True
    os.environ.update(CUDA_VISIBLE_DEVICES="", HF_HUB_OFFLINE="1", HF_DATASETS_OFFLINE="1")
    repo = Path(request["repo"]).expanduser()
    sys.path[:0] = [str(repo / "src"), str(repo / "packages/openpi-client/src")]
    outer, runtime = worker_modules(worker_source)
    root = Path(request["dataset"]).expanduser()
    with (root / "meta/info.json").open(encoding="utf-8") as stream:
        info = json.load(stream)
    version = info.get("codebase_version", "")
    records = None
    if version == "v3.0":
        metadata, records, _ = runtime.v3_metadata(root)
    elif version.startswith("v2."):
        metadata = outer.episode_metadata(str(root))
    else:
        raise ProjectionError(f"Unsupported LeRobot version: {version}")
    episode, frame = request["episode"], request["frame"]
    episodes = metadata["episodes"]
    selected = next((ep for ep in episodes if ep["index"] == episode), None)
    if selected is None or frame >= selected["length"]:
        raise ProjectionError("Selected episode/frame is outside local metadata.")
    key = request["datasetKey"]
    feature = info["features"].get(key)
    if not isinstance(feature, dict) or feature.get("dtype") not in {"video", "image"}:
        raise ProjectionError("Selected front RGB feature is absent or unsupported.")
    offset = sum(ep["length"] for ep in episodes if ep["index"] < episode)
    if records is not None:
        # Reuse the exact v3 row-bound reader, without tasks or action conversion.
        dataset = runtime.V3Dataset.__new__(runtime.V3Dataset)
        dataset.root = root
        dataset.records = {int(row["episode_index"]): row for row in records}
        dataset.files = sorted((root / "data").glob("chunk-*/file-*.parquet"))
        dataset.load_episode(episode)
        raw = dataset.rows[frame].copy()
        if feature["dtype"] == "video":
            from lerobot.common.datasets.video_utils import decode_video_frames

            record = dataset.records[episode]
            path = root / info.get("video_path", "videos/{video_key}/chunk-{chunk_index:03d}/file-{file_index:03d}.mp4").format(
                video_key=key, chunk_index=int(record[f"videos/{key}/chunk_index"]),
                file_index=int(record[f"videos/{key}/file_index"]))
            if not path.is_file():
                raise ProjectionError("Selected video is not provisioned locally.")
            timestamp = float(raw["timestamp"])
            raw[key] = decode_video_frames(path, [float(record[f"videos/{key}/from_timestamp"]) + timestamp],
                                           1e-3, backend="pyav")[0]
            feature = {**feature, "names": ["channels", "height", "width"]}
    else:
        dataset = runtime.load_dataset({**request, "metadata": metadata},
                                       types.SimpleNamespace(action_sequence_keys=()), 1)
        raw = dataset[offset + frame]
        # Pinned LeRobot returns decoded images as CHW tensors.
        feature = {**feature, "names": ["channels", "height", "width"]}
    import numpy as np

    for field, expected in (("episode_index", episode), ("frame_index", frame)):
        scalar = np.asarray(raw[field])
        if scalar.size != 1 or float(scalar.reshape(-1)[0]) != expected:
            raise ProjectionError(f"Selected row {field} does not match request.")
    timestamp = float(np.asarray(raw["timestamp"]).reshape(-1)[0])
    if not math.isfinite(timestamp) or abs(timestamp - frame / metadata["fps"]) > 1e-3:
        raise ProjectionError("Frame timestamp is not episode-local or inconsistent with fps.")
    vectors = {}
    for field, value in raw.items():
        if field == key:
            continue
        array = np.asarray(value)
        if array.ndim != 1 or array.dtype.kind not in "iuf":
            continue
        if not np.isfinite(array).all():
            raise ProjectionError(f"Nonfinite numeric vector: {field}")
        names = info["features"].get(field, {}).get("names")
        if names is not None and (not isinstance(names, list) or len(names) != array.size
                                  or not all(isinstance(name, str) for name in names)):
            raise ProjectionError(f"Feature names do not match vector: {field}")
        vectors[field] = {"names": names, "values": array.tolist()}
    return {"episode": episode, "frame": frame, "timestampSeconds": timestamp, "fps": metadata["fps"],
            "image": {"datasetKey": key, **encode_image(raw[key], feature)},
            "vectors": vectors, "info": safe_info(info)}


def runtime_main(request: FrameRequest, worker_source: str) -> int:
    """Emit a bounded-protocol result or actionable local-data failure."""
    try:
        install_lifecycle()
        print(PREFIX + json.dumps({"type": "started", "pid": os.getpid()}), flush=True)
        result = read_frame(request, worker_source)
        print(PREFIX + json.dumps({"type": "result", "observation": result}, allow_nan=False), flush=True)
        return 0
    except (OSError, ValueError, TypeError, KeyError, AttributeError, ImportError, RuntimeError) as exc:
        print(PREFIX + json.dumps({"type": "error", "message": f"{type(exc).__name__}: {exc}"}), flush=True)
        return 1
