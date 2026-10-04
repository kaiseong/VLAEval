"""Read-only OpenPi evaluator, transported as Python stdin source.

Run: python -u - BASE64_JSON_REQUEST < worker.py
Discovery and v2 episode listing require only the standard library.
V3 episode listing uses pyarrow in the specified repository's environment.
"""
# SIZE_OK: A single stdin-transported execution unit is the external contract.
from __future__ import annotations

import base64
import ctypes
from dataclasses import dataclass
import json
import math
import os
from pathlib import Path
import signal
import subprocess
import sys
from typing import Final, Literal, assert_never

sys.dont_write_bytecode = True
PREFIX: Final = "VLAEVAL "
SCAN_DEPTH: Final = 8
SCAN_NODES: Final = 10000
SKIP: Final = {".git", ".venv", "node_modules", "__pycache__", "videos", "video", "images"}
Operation = Literal["discover", "episodes", "configs", "evaluate"]


class WorkerError(Exception):
    """An actionable request or execution failure."""


@dataclass(frozen=True, slots=True)
class Request:
    operation: Operation
    repo: str
    roots: tuple[str, ...]
    dataset: str
    config: str
    checkpoint: str
    episodes: tuple[int, ...]
    max_samples: int
    stride: int
    seed: int
    num_steps: int

    @classmethod
    def decode(cls, encoded: str) -> Request:
        raw = json.loads(base64.b64decode(encoded, validate=True))
        if not isinstance(raw, dict):
            raise WorkerError("Request must be a JSON object.")
        operation = raw.get("operation")
        if operation not in {"discover", "episodes", "configs", "evaluate"}:
            raise WorkerError("operation must be discover, episodes, configs, or evaluate.")
        roots = raw.get("roots", [])
        episodes = raw.get("episodes", [])
        if not isinstance(roots, list) or not all(isinstance(x, str) for x in roots):
            raise WorkerError("roots must be a list of paths.")
        if not isinstance(episodes, list) or not all(type(x) is int and x >= 0 for x in episodes):
            raise WorkerError("episodes must be a list of nonnegative integer IDs.")
        values = {}
        for key, default, minimum in [
            ("maxSamples", 0, 0), ("stride", 1, 1), ("seed", 0, 0), ("numSteps", 10, 1),
        ]:
            value = raw.get(key, default)
            if type(value) is not int or value < minimum:
                raise WorkerError(f"{key} must be an integer >= {minimum}.")
            values[key] = value
        paths = {}
        for key in ("repo", "dataset", "checkpoint"):
            value = raw.get(key, "")
            if not isinstance(value, str):
                raise WorkerError(f"{key} must be a path string.")
            expanded = os.path.expanduser(value) if value else ""
            if expanded and not Path(expanded).is_absolute():
                raise WorkerError(f"{key} must be absolute (or start with ~).")
            paths[key] = expanded
        config = raw.get("config", "")
        if not isinstance(config, str):
            raise WorkerError("config must be a string.")
        if operation in {"configs", "evaluate"} and not paths["repo"]:
            raise WorkerError("An absolute OpenPi repo is required.")
        if operation in {"episodes", "evaluate"} and not paths["dataset"]:
            raise WorkerError("An absolute local LeRobot dataset is required.")
        if operation == "evaluate" and (not episodes or not config or not paths["checkpoint"]):
            raise WorkerError("Evaluation requires explicit nonempty episodes, config, and checkpoint.")
        return cls(operation, paths["repo"], tuple(roots), paths["dataset"], config,
                   paths["checkpoint"], tuple(dict.fromkeys(episodes)), values["maxSamples"],
                   values["stride"], values["seed"], values["numSteps"])

    def encoded(self) -> str:
        raw = {
            "operation": self.operation, "repo": self.repo, "dataset": self.dataset,
            "config": self.config, "checkpoint": self.checkpoint, "episodes": self.episodes,
            "maxSamples": self.max_samples, "stride": self.stride, "seed": self.seed,
            "numSteps": self.num_steps,
        }
        return base64.b64encode(json.dumps(raw).encode()).decode()


def emit(event) -> None:
    print(PREFIX + json.dumps(event, allow_nan=False, separators=(",", ":")), flush=True)


def read_json(path: Path):
    with path.open(encoding="utf-8") as stream:
        return json.load(stream)


def episode_metadata(dataset: str):
    root = Path(dataset)
    info = read_json(root / "meta/info.json")
    version = str(info.get("codebase_version", ""))
    if not version.startswith("v2."):
        raise WorkerError(f"Unsupported LeRobot {version!r}; provision a v2.x dataset with meta/episodes.jsonl.")
    fps = float(info["fps"])
    if not 0 < fps < float("inf"):
        raise WorkerError("Dataset fps must be finite and positive.")
    episodes = []
    with (root / "meta/episodes.jsonl").open(encoding="utf-8") as stream:
        for line in stream:
            row = json.loads(line)
            index, length, tasks = row["episode_index"], row["length"], row.get("tasks", [])
            if type(index) is not int or index < 0 or type(length) is not int or length <= 0:
                raise WorkerError("Invalid episode index or length in local metadata.")
            if not isinstance(tasks, list) or not all(isinstance(t, str) for t in tasks):
                raise WorkerError("Episode tasks must be strings.")
            episodes.append({"index": index, "length": length, "tasks": tasks})
    if len({ep["index"] for ep in episodes}) != len(episodes):
        raise WorkerError("Duplicate episode IDs in metadata.")
    return {"type": "episodes", "episodes": sorted(episodes, key=lambda ep: ep["index"]),
            "fps": fps, "version": version}


def discover(roots: tuple[str, ...]):
    result = {"type": "discovery", "repositories": [], "checkpoints": [], "datasets": [], "warnings": []}
    stack = [(Path(root).expanduser(), 0, i) for i, root in reversed(list(enumerate(roots)))]
    seen = set()
    budgets = [0] * len(roots)
    while stack:
        path, depth, root_index = stack.pop()
        if budgets[root_index] >= SCAN_NODES:
            continue
        budgets[root_index] += 1
        try:
            stat = path.stat()
            identity = (stat.st_dev, stat.st_ino)
            if (identity in seen and depth > 0) or not path.is_dir():
                continue
            seen.add(identity)
            path = path.resolve()
            if (path / "src/openpi/training/config.py").is_file():
                result["repositories"].append({"path": str(path), "python": str(path / ".venv/bin/python")})
            if (path / "model.safetensors").is_file() or (path / "params").is_dir():
                result["checkpoints"].append({
                    "path": str(path), "format": "pytorch" if (path / "model.safetensors").is_file() else "jax",
                    "step": path.name if path.name.isdecimal() else None,
                })
                continue
            if (path / "meta/info.json").is_file():
                info = read_json(path / "meta/info.json")
                fps = info.get("fps")
                if not isinstance(fps, (int, float)) or not math.isfinite(fps) or fps <= 0:
                    fps = 0
                    result["warnings"].append(f"{path}: missing or invalid fps; discovery reports 0.")
                result["datasets"].append({
                    "path": str(path), "name": path.name, "episodes": info.get("total_episodes", 0),
                    "frames": info.get("total_frames", 0), "fps": fps,
                    "version": info.get("codebase_version", ""),
                })
                continue
            if depth >= SCAN_DEPTH:
                result["warnings"].append(f"Discovery depth cap ({SCAN_DEPTH}) reached at {path}.")
                continue
            # Bound entries as well as visited directories, including wide flat roots.
            with os.scandir(path) as entries:
                for entry in entries:
                    budgets[root_index] += 1
                    if budgets[root_index] >= SCAN_NODES:
                        break
                    if entry.name not in SKIP and entry.is_dir(follow_symlinks=False):
                        stack.append((Path(entry.path), depth + 1, root_index))
        except (OSError, ValueError, KeyError, TypeError) as exc:
            result["warnings"].append(f"{path}: {exc}")
    for i, count in enumerate(budgets):
        if count >= SCAN_NODES:
            result["warnings"].append(f"{roots[i]}: discovery node cap ({SCAN_NODES}) reached; this root is partial.")
    for key in ("repositories", "checkpoints", "datasets"):
        result[key] = list({item["path"]: item for item in result[key]}.values())
    return result


# This separate interpreter payload avoids relying on __file__: stdin Python has
# no source file to re-execute. No temporary files or remote installation is needed.
RUNTIME_SOURCE: Final = r'''
import base64
import copy
import ctypes
import json
import os
from pathlib import Path
import subprocess
import sys
import signal
import time
import urllib.parse
from types import SimpleNamespace

sys.dont_write_bytecode = True
if __name__ == "__main__":
    # The transport owns this group; also die if it is killed without a handler.
    if sys.platform.startswith("linux"):
        if ctypes.CDLL(None).prctl(1, signal.SIGKILL, 0, 0, 0) != 0:
            raise RuntimeError("Cannot install inference parent-death signal.")
        if os.getppid() != int(sys.argv[2]):
            os._exit(130)
    signal.pthread_sigmask(signal.SIG_UNBLOCK, {signal.SIGTERM, signal.SIGINT})


def emit(event):
    print("VLAEVAL " + json.dumps(event, allow_nan=False, separators=(",", ":")), flush=True)


def local_asset(url, **kwargs):
    parsed = urllib.parse.urlparse(str(url))
    path = Path(url).expanduser() if not parsed.scheme else (
        Path(os.environ.get("OPENPI_DATA_HOME", "~/.cache/openpi")).expanduser()
        / parsed.netloc / parsed.path.strip("/")
    )
    if not path.exists():
        raise FileNotFoundError(f"Pre-provision OpenPi asset locally before evaluation: {url} (expected {path})")
    return path.resolve()


def forbid_download(*args, **kwargs):
    raise RuntimeError("Dataset is incomplete locally. Provision all v2 metadata, parquet files and videos; downloads are disabled.")


def checkpoint_root(value):
    path = Path(value)
    if path.name in {"model.safetensors", "params"}:
        path = path.parent
    if not path.is_dir() or not ((path / "model.safetensors").is_file() or (path / "params").is_dir()):
        raise RuntimeError("Checkpoint must contain model.safetensors or params/; select an individual trained step.")
    return path


def select_frames(episodes, request):
    selected = set(request["episodes"])
    missing = selected - {ep["index"] for ep in episodes}
    if missing:
        raise RuntimeError(f"Unknown episode IDs: {sorted(missing)}")
    offset = 0
    frames = []
    for ep in episodes:
        if ep["index"] in selected:
            for frame in range(0, ep["length"], request["stride"]):
                frames.append((offset + frame, ep["index"], frame, ep["length"]))
                if request["maxSamples"] and len(frames) >= request["maxSamples"]:
                    return frames
        offset += ep["length"]
    return frames


def parquet_module():
    try:
        import pyarrow.parquet as parquet
    except ImportError as exc:
        raise RuntimeError("LeRobot v3 reading requires pyarrow in the selected OpenPi .venv; provision that dependency before evaluation.") from exc
    return parquet


def v3_metadata(root):
    parquet = parquet_module()
    with (root / "meta/info.json").open() as stream:
        info = json.load(stream)
    if info.get("codebase_version") != "v3.0":
        raise RuntimeError("Only LeRobot v2.x and v3.0 are supported.")
    fps = float(info["fps"])
    if not 0 < fps < float("inf"):
        raise RuntimeError("Dataset fps must be finite and positive.")
    records = []
    files = sorted((root / "meta/episodes").glob("chunk-*/file-*.parquet"))
    if not files:
        raise RuntimeError("LeRobot v3 dataset has no local meta/episodes/chunk-*/file-*.parquet.")
    for path in files:
        records.extend(parquet.read_table(path).to_pylist())
    episodes = []
    for record in records:
        index, length = int(record["episode_index"]), int(record["length"])
        tasks = record.get("tasks") or []
        if index < 0 or length <= 0 or not isinstance(tasks, list) or not all(isinstance(t, str) for t in tasks):
            raise RuntimeError("Invalid LeRobot v3 episode metadata.")
        episodes.append({"index": index, "length": length, "tasks": tasks})
    if len({ep["index"] for ep in episodes}) != len(episodes):
        raise RuntimeError("Duplicate LeRobot v3 episode IDs.")
    if info.get("total_episodes") is not None and len(episodes) != int(info["total_episodes"]):
        raise RuntimeError("Local LeRobot v3 episode metadata is incomplete; provision all metadata chunks.")
    return {"type": "episodes", "episodes": sorted(episodes, key=lambda e: e["index"]),
            "fps": fps, "version": "v3.0"}, records, info


def v3_tasks(root):
    table = parquet_module().read_table(root / "meta/tasks.parquet")
    index_columns = []
    if table.schema.metadata and b"pandas" in table.schema.metadata:
        index_columns = json.loads(table.schema.metadata[b"pandas"]).get("index_columns", [])
    candidates = ["task", "__index_level_0__", *[key for key in index_columns if isinstance(key, str)]]
    tasks = {}
    for row in table.to_pylist():
        text = next((row[key] for key in candidates if isinstance(row.get(key), str)), None)
        if text is None:
            raise RuntimeError("Cannot read task strings in meta/tasks.parquet; expected task or a named pandas index.")
        index = int(row["task_index"])
        if index in tasks:
            raise RuntimeError("Duplicate task_index in meta/tasks.parquet.")
        tasks[index] = text
    return tasks


class V3Dataset:
    """Read-only selected-episode adapter with one episode's rows cached."""

    def __init__(self, request, data, horizon):
        self.root = Path(request["dataset"])
        metadata, records, self.info = v3_metadata(self.root)
        self.meta = SimpleNamespace(fps=metadata["fps"], features=self.info["features"], tasks=v3_tasks(self.root))
        self.records = {int(row["episode_index"]): row for row in records}
        self.keys = data.action_sequence_keys
        self.horizon = horizon
        self.spans = []
        offset = 0
        for episode in metadata["episodes"]:
            if episode["index"] in request["episodes"]:
                self.spans.append((offset, offset + episode["length"], episode["index"]))
            offset += episode["length"]
        self.files = sorted((self.root / "data").glob("chunk-*/file-*.parquet"))
        self.cached_episode = None
        self.rows = []
        self.video_keys = [key for key, feature in self.meta.features.items() if feature.get("dtype") == "video"]

    def load_episode(self, episode):
        record = self.records[episode]
        start, end = int(record["dataset_from_index"]), int(record["dataset_to_index"])
        length = int(record["length"])
        if end - start != length:
            raise RuntimeError("LeRobot v3 episode global row bounds do not match its length.")
        path = self.root / "data" / f'chunk-{int(record["data/chunk_index"]):03d}' / f'file-{int(record["data/file_index"]):03d}.parquet'
        if path not in self.files:
            raise FileNotFoundError(f"Pre-provision selected episode data: {path}")
        rows = []
        parquet = parquet_module()
        for file in self.files[self.files.index(path):]:
            table = parquet.read_table(file, filters=[
                ("index", ">=", start), ("index", "<", end), ("episode_index", "=", episode),
            ])
            rows.extend(table.to_pylist())
            if len(rows) >= length:
                break
        rows.sort(key=lambda row: int(row["index"]))
        if len(rows) != length or [int(row["index"]) for row in rows] != list(range(start, end)):
            raise RuntimeError(f"Episode {episode} data is incomplete locally or its row bounds are inconsistent.")
        if [int(row["frame_index"]) for row in rows] != list(range(length)):
            raise RuntimeError(f"Episode {episode} frame ordering is inconsistent.")
        self.rows = rows
        self.cached_episode = episode

    def __getitem__(self, index):
        import numpy as np
        span = next((span for span in self.spans if span[0] <= index < span[1]), None)
        if span is None:
            raise IndexError("Only explicitly selected episodes may be read.")
        offset, end, episode = span
        frame = index - offset
        if self.cached_episode != episode:
            self.load_episode(episode)
        raw = copy.deepcopy(self.rows[frame])
        for key, value in list(raw.items()):
            if isinstance(value, list):
                raw[key] = np.asarray(value, dtype=np.float32)
        for key in self.keys:
            indices = np.minimum(np.arange(self.horizon) + frame, len(self.rows) - 1)
            raw[key] = np.asarray([self.rows[int(i)][key] for i in indices], dtype=np.float32)
            raw[key + "_is_pad"] = np.arange(self.horizon) + frame >= len(self.rows)
        task_index = int(raw["task_index"])
        if task_index not in self.meta.tasks:
            raise RuntimeError(f"task_index {task_index} is absent from meta/tasks.parquet.")
        raw["task"] = self.meta.tasks[task_index]
        if self.video_keys:
            from lerobot.common.datasets.video_utils import decode_video_frames
            record = self.records[episode]
            local_time = float(raw.get("timestamp", frame / self.meta.fps))
            if abs(local_time - frame / self.meta.fps) > 1e-3:
                raise RuntimeError("LeRobot v3 frame timestamp is not episode-local or is inconsistent with fps.")
            for key in self.video_keys:
                chunk = int(record[f"videos/{key}/chunk_index"])
                file = int(record[f"videos/{key}/file_index"])
                path_template = self.info.get("video_path", "videos/{video_key}/chunk-{chunk_index:03d}/file-{file_index:03d}.mp4")
                path = self.root / path_template.format(video_key=key, chunk_index=chunk, file_index=file)
                if not path.is_file():
                    raise FileNotFoundError(f"Pre-provision selected episode video: {path}")
                timestamp = float(record[f"videos/{key}/from_timestamp"]) + local_time
                raw[key] = np.asarray(decode_video_frames(path, [timestamp], 1e-3, backend="pyav")[0])
        return raw


class Metrics:
    """Mutable sums retain valid-row weighting without retaining future chunks."""

    def __init__(self, horizon, names):
        import numpy as np
        self.names = names
        self.absolute = np.zeros((horizon, len(names)), dtype=np.float64)
        self.square = self.absolute.copy()
        self.counts = np.zeros(horizon, dtype=np.int64)

    def add(self, predicted, target, valid):
        import numpy as np
        predicted = np.asarray(predicted, dtype=np.float64)
        target = np.asarray(target, dtype=np.float64)
        valid = np.asarray(valid)
        if predicted.shape != self.absolute.shape or target.shape != predicted.shape:
            raise RuntimeError(f"Action shape mismatch: predicted {predicted.shape}, target {target.shape}, expected {self.absolute.shape}.")
        if valid.shape != (predicted.shape[0],) or valid.dtype != np.bool_ or not valid.any():
            raise RuntimeError("Expected a nonempty boolean validity mask matching the action horizon.")
        if not np.isfinite(predicted).all() or not np.isfinite(target).all():
            raise RuntimeError("Nonfinite predicted or target actions.")
        error = predicted - target
        self.absolute[valid] += np.abs(error[valid])
        self.square[valid] += error[valid] ** 2
        self.counts += valid
        return predicted, target

    def result(self):
        import numpy as np
        rows = int(self.counts.sum())
        width = len(self.names)
        if rows == 0:
            raise RuntimeError("No valid action rows were evaluated.")
        return {
            "validSteps": rows,
            "actionNames": self.names,
            "mae": float(self.absolute.sum() / (rows * width)),
            "rmse": float(np.sqrt(self.square.sum() / (rows * width))),
            "firstStepMae": float(self.absolute[0].sum() / (self.counts[0] * width)),
            "firstStepRmse": float(np.sqrt(self.square[0].sum() / (self.counts[0] * width))),
            "perDimension": [
                {"name": name, "mae": float(self.absolute[:, i].sum() / rows),
                 "rmse": float(np.sqrt(self.square[:, i].sum() / rows))}
                for i, name in enumerate(self.names)
            ],
            "perHorizon": [
                {"step": i, "count": int(count),
                 "mae": float(self.absolute[i].sum() / (count * width)) if count else None,
                 "rmse": float(np.sqrt(self.square[i].sum() / (count * width))) if count else None}
                for i, count in enumerate(self.counts)
            ],
        }


def score_frames(dataset, policy, data, model, request, episodes):
    import numpy as np
    from openpi import transforms
    repack = transforms.compose(data.repack_transforms.inputs)
    forward = transforms.compose(data.data_transforms.inputs)
    backward = transforms.compose(data.data_transforms.outputs)
    selection = select_frames(episodes, request)
    if not selection:
        raise RuntimeError("Selected episodes contain no frames.")
    metrics = None
    episode_metrics = {}
    traces = {}
    samples, latency = [], []
    warnings = [
        "Chunk metrics use all valid future rows; episode metrics and traces use first steps.",
        "Aggregate metrics combine native action dimensions; compare perDimension values when units differ.",
        "Future samples are capped at 8 chunks; first-step traces cover every evaluated frame.",
    ]
    if request["maxSamples"] or request["stride"] != 1:
        warnings.append("Quick subset enabled: maxSamples/stride limit whole-episode coverage.")
    for completed, (index, episode, frame, length) in enumerate(selection, 1):
        raw = dataset[index]
        raw = {key: np.asarray(value) if hasattr(value, "numpy") else value for key, value in raw.items()}
        if int(raw["episode_index"]) != episode or int(raw["frame_index"]) != frame:
            raise RuntimeError("Dataset frame ordering differs from episode metadata; refusing cross-episode scoring.")
        if data.prompt_from_task:
            raw = transforms.PromptFromLeRobotTask(dataset.meta.tasks)(raw)
        packed = repack(copy.deepcopy(raw))
        # Round-trip only data transforms: GT is scored in policy output space,
        # never normalized model space, preserving delta/absolute and robot units.
        canonical = backward(forward(copy.deepcopy(packed)))
        target = np.asarray(canonical["actions"]).copy()
        observation = copy.deepcopy(packed)
        observation.pop("actions", None)
        for key in data.action_sequence_keys:
            observation.pop(key, None)
        valid = np.arange(model.action_horizon) < length - frame
        for key in data.action_sequence_keys:
            padding = np.asarray(raw[key + "_is_pad"], dtype=bool)
            if padding.shape != valid.shape:
                raise RuntimeError("Dataset action padding mask does not match model horizon.")
            valid &= ~padding
        if not valid[0]:
            raise RuntimeError("Current action row cannot be padded.")
        noise = np.random.default_rng(np.random.SeedSequence([request["seed"], episode, frame])).standard_normal(
            (model.action_horizon, model.action_dim)
        ).astype(np.float32)
        if completed == 1:
            np.asarray(policy.infer(copy.deepcopy(observation), noise=noise.copy())["actions"]).copy()
        start = time.perf_counter()
        predicted = np.asarray(policy.infer(observation, noise=noise)["actions"]).copy()
        elapsed = (time.perf_counter() - start) * 1000
        if metrics is None:
            if target.ndim != 2 or target.shape[0] != model.action_horizon:
                raise RuntimeError("GT must be a horizon by action-dimension matrix.")
            feature = dataset.meta.features.get(data.action_sequence_keys[0], {})
            names = feature.get("names")
            if not isinstance(names, list) or len(names) != target.shape[1] or not all(isinstance(n, str) for n in names):
                names = [f"action_{i}" for i in range(target.shape[1])]
                warnings.append("Action names unavailable in output space; dimension indices are used.")
            metrics = Metrics(model.action_horizon, names)
        predicted, target = metrics.add(predicted, target, valid)
        latency.append(elapsed)
        if episode not in episode_metrics:
            episode_metrics[episode] = Metrics(1, metrics.names)
            traces[episode] = {"episode": episode, "frames": [], "predicted": [], "target": []}
        episode_metrics[episode].add(predicted[:1], target[:1], np.array([True]))
        trace = traces[episode]
        trace["frames"].append(frame)
        trace["predicted"].append(predicted[0].tolist())
        trace["target"].append(target[0].tolist())
        if len(samples) < 8:
            samples.append({"episode": episode, "frame": frame, "prompt": str(packed.get("prompt", raw.get("task", ""))),
                            "predicted": predicted.tolist(), "target": target.tolist(), "valid": valid.tolist()})
        emit({"type": "progress", "completed": completed, "total": len(selection),
              "message": f"Episode {episode}, frame {frame}"})
    result = metrics.result()
    result.update({
        "framesEvaluated": len(selection), "samples": samples, "warnings": warnings,
        "latencyMs": {"median": float(np.median(latency)), "p95": float(np.percentile(latency, 95))},
        "traces": list(traces.values()),
        "perEpisode": [{"episode": ep, "framesEvaluated": int(m.counts[0]),
                        "mae": m.result()["mae"], "rmse": m.result()["rmse"]}
                       for ep, m in episode_metrics.items()],
    })
    return result


def load_dataset(request, data, horizon):
    if request["metadata"]["version"] == "v3.0":
        return V3Dataset(request, data, horizon)
    try:
        import lerobot.common.datasets.lerobot_dataset as lerobot
    except ImportError as exc:
        raise RuntimeError("Install this OpenPi repo's pinned LeRobot v2 dependency exposing lerobot.common.datasets; v3 is unsupported.") from exc
    lerobot.snapshot_download = forbid_download
    lerobot.get_safe_version = forbid_download
    root = Path(request["dataset"])
    metadata = request["metadata"]
    # Load ALL episodes. Old v2 delta indexing uses original episode IDs.
    # Episode selection is external; contiguous metadata IDs are required.
    episodes = metadata["episodes"]
    if [ep["index"] for ep in episodes] != list(range(len(episodes))):
        raise RuntimeError("Old LeRobot v2 requires contiguous stored episode IDs. Provision a complete dataset; select noncontiguous IDs in the request.")
    meta = lerobot.LeRobotDatasetMetadata("local/evaluation", root=root)
    dataset = lerobot.LeRobotDataset(
        "local/evaluation", root=root, episodes=None, download_videos=False,
        delta_timestamps={key: [i / meta.fps for i in range(horizon)]
                          for key in data.action_sequence_keys},
    )
    if abs(meta.fps - metadata["fps"]) > 1e-9:
        raise RuntimeError("Dataset fps changed while evaluation was starting.")
    return dataset


def run(request):
    repo = Path(request["repo"])
    sys.path[:0] = [str(repo / "src"), str(repo / "packages/openpi-client/src")]
    os.environ["HF_HUB_OFFLINE"] = "1"
    os.environ["HF_DATASETS_OFFLINE"] = "1"
    if request["operation"] == "episodes":
        emit(v3_metadata(Path(request["dataset"]))[0])
        return
    if request["operation"] == "evaluate" and "metadata" not in request:
        request["metadata"] = v3_metadata(Path(request["dataset"]))[0]
    from openpi.shared import download
    download.maybe_download = local_asset
    from openpi.training import config
    if request["operation"] == "configs":
        revision = subprocess.run(["git", "-C", str(repo), "rev-parse", "HEAD"],
                                  capture_output=True, text=True, timeout=10)
        emit({"type": "configs", "revision": revision.stdout.strip() if revision.returncode == 0 else "",
              "configs": [{"name": c.name, "repoId": c.data.repo_id if isinstance(c.data.repo_id, str) else None,
                           "actionDim": int(c.model.action_dim), "actionHorizon": int(c.model.action_horizon)}
                          for c in config._CONFIGS]})
        return
    from openpi.policies.policy_config import create_trained_policy
    selected = config.get_config(request["config"])
    data = selected.data.create(selected.assets_dirs, selected.model)
    if data.rlds_data_dir or len(data.action_sequence_keys) != 1:
        raise RuntimeError("Evaluation supports one LeRobot action sequence, not RLDS or combined action keys.")
    if selected.model.action_horizon > 256 or selected.model.action_dim > 256:
        raise RuntimeError("Model exceeds evaluator safety caps: horizon <= 256 and actionDim <= 256.")
    dataset = load_dataset(request, data, selected.model.action_horizon)
    checkpoint = checkpoint_root(request["checkpoint"])
    policy = create_trained_policy(selected, checkpoint, sample_kwargs={"num_steps": request["numSteps"]})
    result = score_frames(dataset, policy, data, selected.model, request, request["metadata"]["episodes"])
    result.update({key: request[key] for key in ("config", "dataset", "seed", "numSteps")})
    result.update({"checkpoint": str(checkpoint), "fps": float(dataset.meta.fps)})
    emit({"type": "result", "result": result})


if __name__ == "__main__":
    try:
        run(json.loads(base64.b64decode(sys.argv[1])))
    except Exception as exc:
        emit({"type": "error", "message": f"{type(exc).__name__}: {exc}"})
        sys.exit(1)
'''


def parent_death_signal() -> None:
    """On Linux, SSH launcher death terminates the transport process."""
    if sys.platform.startswith("linux"):
        parent = os.getppid()
        libc = ctypes.CDLL(None, use_errno=True)
        if libc.prctl(1, signal.SIGTERM, 0, 0, 0) != 0:
            raise WorkerError(f"Cannot install Linux parent-death signal: errno {ctypes.get_errno()}.")
        if os.getppid() != parent:
            os.kill(os.getpid(), signal.SIGTERM)


def main() -> int:
    child = None

    def cancel(signum, frame) -> None:
        # Block repeated termination while synchronously reaping the group.
        signal.signal(signal.SIGTERM, signal.SIG_IGN)
        signal.signal(signal.SIGINT, signal.SIG_IGN)
        if child is not None:
            try:
                os.killpg(child.pid, signal.SIGKILL)
            except ProcessLookupError:
                # The child already exited; reap after Popen.wait unwinds.
                emit({"type": "cancelled"})
                raise SystemExit(130) from None
        try:
            emit({"type": "cancelled"})
        except BrokenPipeError:
            os._exit(130)
        raise SystemExit(130)

    signal.signal(signal.SIGTERM, cancel)
    signal.signal(signal.SIGINT, cancel)
    try:
        parent_death_signal()
        emit({"type": "started", "pid": os.getpid()})
        if len(sys.argv) != 2:
            raise WorkerError("Expected one base64 JSON request argument.")
        request = Request.decode(sys.argv[1])
        match request.operation:
            case "discover":
                emit(discover(request.roots))
            case "episodes" | "configs" | "evaluate":
                if request.operation == "episodes":
                    info = read_json(Path(request.dataset) / "meta/info.json")
                    if str(info.get("codebase_version", "")).startswith("v2."):
                        emit(episode_metadata(request.dataset))
                        return 0
                repo = Path(request.repo)
                python = repo / ".venv/bin/python"
                if not (repo / "src/openpi/training/config.py").is_file() or not python.is_file():
                    raise WorkerError("Select an OpenPi repo with src/openpi/training/config.py and a provisioned .venv/bin/python.")
                payload = json.loads(base64.b64decode(request.encoded()))
                if request.operation == "evaluate":
                    info = read_json(Path(request.dataset) / "meta/info.json")
                    if str(info.get("codebase_version", "")).startswith("v2."):
                        payload["metadata"] = episode_metadata(request.dataset)
                encoded = base64.b64encode(json.dumps(payload).encode()).decode()
                # Hold cancellation during spawn so the handler always owns a PID.
                blocked = signal.pthread_sigmask(signal.SIG_BLOCK, {signal.SIGTERM, signal.SIGINT})
                try:
                    child = subprocess.Popen([str(python), "-u", "-c", RUNTIME_SOURCE, encoded, str(os.getpid())],
                                             cwd=repo, start_new_session=True)
                finally:
                    signal.pthread_sigmask(signal.SIG_SETMASK, blocked)
                return child.wait()
            case unreachable:
                assert_never(unreachable)
        return 0
    except BrokenPipeError:
        cancel(signal.SIGTERM, None)
    except Exception as exc:  # NDJSON process boundary: report failures to the caller.
        emit({"type": "error", "message": f"{type(exc).__name__}: {exc}"})
        return 1
    finally:
        if child is not None:
            child.wait()
    return 130


if __name__ == "__main__":
    sys.exit(main())
