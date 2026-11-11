"""Local CPU fixtures for selected raw rows; no OpenPi/model imports."""
import base64
import builtins
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import select
import signal
import subprocess
import sys
from types import ModuleType, SimpleNamespace

import numpy as np
from PIL import Image
import pyarrow as pa
import pyarrow.parquet as pq
import pytest

ROOT = Path(__file__).resolve().parents[1]
SOURCE = (ROOT / "worker.py").read_text()
SPEC = importlib.util.spec_from_file_location("projection_worker", ROOT / "projection_worker.py")
reader = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(reader)
KEY = "observation.images.front"


@pytest.fixture
def fixture(tmp_path, monkeypatch):
    root = tmp_path / "dataset"
    (root / "meta").mkdir(parents=True)
    info = {"codebase_version": "v2.1", "fps": 10, "total_episodes": 2,
            "features": {
                KEY: {"dtype": "video", "shape": [3, 2, 4]},
                "action": {"dtype": "float32", "shape": [2], "names": ["right", "left"]},
                "observation.state": {"dtype": "float32", "shape": [2], "names": ["j1", "j0"]},
                "observation.head": {"dtype": "float32", "shape": [1], "names": None},
            }, "calibration": {"fx": 20, "api_key": "must-not-escape"},
            "robot_type": "rby1", "access_token": "must-not-escape"}
    (root / "meta/info.json").write_text(json.dumps(info))
    episodes = [{"episode_index": 0, "length": 2}, {"episode_index": 1, "length": 3}]
    (root / "meta/episodes.jsonl").write_text("".join(json.dumps(ep) + "\n" for ep in episodes))
    pixels = np.arange(24, dtype=np.uint8).reshape(2, 4, 3)
    calls = []
    rows = []
    for episode, length in [(0, 2), (1, 3)]:
        for frame in range(length):
            rows.append({"index": len(rows), "episode_index": episode, "frame_index": frame,
                         "timestamp": frame / 10, "action": [100 * episode + frame, .25],
                         "observation.state": [frame, 10], "observation.head": [0.75],
                         "matrix": [[1, 2]], "text": "skip", "flags": [True]})
    # Fake only pinned LeRobot I/O; shipped load_dataset and metadata execute.
    module = ModuleType("lerobot.common.datasets.lerobot_dataset")
    module.LeRobotDatasetMetadata = lambda *args, **kwargs: SimpleNamespace(fps=10)

    class Dataset:
        def __init__(self, *args, **kwargs):
            calls.append(kwargs)
            assert kwargs["episodes"] is None
            assert kwargs["delta_timestamps"] == {}
            assert kwargs["download_videos"] is False

        def __getitem__(self, index):
            calls.append(index)
            return {**rows[index], KEY: pixels.transpose(2, 0, 1).astype(np.float32) / 255}

    module.LeRobotDataset = Dataset
    for name in ("lerobot", "lerobot.common", "lerobot.common.datasets"):
        package = ModuleType(name)
        package.__path__ = []
        monkeypatch.setitem(sys.modules, name, package)
    monkeypatch.setitem(sys.modules, module.__name__, module)
    imports = builtins.__import__

    def guarded(name, *args, **kwargs):
        if name.split(".")[0] in {"openpi", "jax", "flax"}:
            pytest.fail(f"Model/config import attempted: {name}")
        return imports(name, *args, **kwargs)

    monkeypatch.setattr(builtins, "__import__", guarded)
    monkeypatch.setattr(sys, "path", sys.path.copy())
    request = {"repo": str(tmp_path / "repo"), "dataset": str(root),
               "episode": 1, "frame": 2, "datasetKey": KEY}
    return root, request, info, pixels, calls, rows


def test_frame_when_second_episode_uses_global_offset_without_mutation(fixture):
    # Given
    root, request, info, pixels, calls, _ = fixture
    before = {p.relative_to(root): (p.read_bytes(), p.stat().st_mtime_ns)
              for p in root.rglob("*") if p.is_file()}
    # When
    result = reader.read_frame(request, SOURCE)
    # Then
    assert calls[-1] == 4
    assert (result["episode"], result["frame"], result["timestampSeconds"], result["fps"]) == (1, 2, .2, 10)
    assert result["vectors"]["action"] == {"names": ["right", "left"], "values": [102, .25]}
    assert result["vectors"]["observation.state"]["names"] == ["j1", "j0"]
    assert result["vectors"]["observation.head"] == {"names": None, "values": [.75]}
    assert not {"matrix", "flags", "text"} & result["vectors"].keys()
    image = result["image"]
    payload = base64.b64decode(image["dataBase64"])
    assert image["width"] == 4 and image["height"] == 2 and image["mime"] == "image/png"
    assert image["sha256"] == hashlib.sha256(payload).hexdigest()
    with Image.open(io.BytesIO(payload)) as decoded:
        np.testing.assert_array_equal(decoded, pixels)
    assert result["info"]["calibration"] == {"fx": 20}
    assert "access_token" not in result["info"]
    assert os.environ["CUDA_VISIBLE_DEVICES"] == ""
    assert os.environ["HF_HUB_OFFLINE"] == os.environ["HF_DATASETS_OFFLINE"] == "1"
    assert {p.relative_to(root): (p.read_bytes(), p.stat().st_mtime_ns)
            for p in root.rglob("*") if p.is_file()} == before


@pytest.mark.parametrize("update", [{"frame": -1}, {"frame": 3}, {"episode": 8}, {"frame": True}])
def test_frame_when_invalid_rejected_before_dataset_access(fixture, update):
    # Given
    _, request, _, _, calls, _ = fixture
    # When / Then
    with pytest.raises(reader.ProjectionError):
        reader.read_frame({**request, **update}, SOURCE)
    assert calls == []


@pytest.mark.parametrize("field,value", [("timestamp", .8), ("episode_index", 0), ("frame_index", 0)])
def test_frame_when_row_identity_or_timestamp_disagrees(fixture, field, value):
    # Given
    _, request, _, _, _, rows = fixture
    rows[4][field] = value
    # When / Then
    with pytest.raises(reader.ProjectionError):
        reader.read_frame(request, SOURCE)


def test_frame_when_feature_names_have_wrong_width(fixture):
    # Given
    root, request, info, _, _, _ = fixture
    info["features"]["action"]["names"] = ["wrong"]
    (root / "meta/info.json").write_text(json.dumps(info))
    # When / Then
    with pytest.raises(reader.ProjectionError):
        reader.read_frame(request, SOURCE)


def test_v3_when_sparse_episode_spans_files_preserves_raw_values_and_video_offset(fixture, monkeypatch):
    # Given: global parquet indices need not equal cumulative episode lengths.
    root, request, info, pixels, _, rows = fixture
    info.update(codebase_version="v3.0")
    (root / "meta/info.json").write_text(json.dumps(info))
    records = [
        {"episode_index": 0, "length": 2, "tasks": [], "dataset_from_index": 20, "dataset_to_index": 22,
         "data/chunk_index": 0, "data/file_index": 0,
         f"videos/{KEY}/chunk_index": 0, f"videos/{KEY}/file_index": 0,
         f"videos/{KEY}/from_timestamp": 0.0},
        {"episode_index": 5, "length": 3, "tasks": [], "dataset_from_index": 40, "dataset_to_index": 43,
         "data/chunk_index": 0, "data/file_index": 1,
         f"videos/{KEY}/chunk_index": 0, f"videos/{KEY}/file_index": 0,
         f"videos/{KEY}/from_timestamp": 5.5},
    ]
    for relative, subset in [("meta/episodes/chunk-000/file-000.parquet", records),
                             ("data/chunk-000/file-000.parquet", [{**row, "index": 20 + i} for i, row in enumerate(rows[:2])]),
                             ("data/chunk-000/file-001.parquet", [{**rows[2], "index": 40, "episode_index": 5}]),
                             ("data/chunk-001/file-000.parquet", [{**row, "index": 41 + i, "episode_index": 5}
                                                                 for i, row in enumerate(rows[3:])])]:
        path = root / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        pq.write_table(pa.Table.from_pylist(subset), path)
    path = root / f"videos/{KEY}/chunk-000/file-000.mp4"
    path.parent.mkdir(parents=True)
    path.touch()
    decoded = []
    video = ModuleType("lerobot.common.datasets.video_utils")

    def decode(path, timestamps, tolerance, backend):
        decoded.append((path, timestamps, tolerance, backend))
        return [pixels.transpose(2, 0, 1).astype(np.float32) / 255]

    video.decode_video_frames = decode
    monkeypatch.setitem(sys.modules, video.__name__, video)
    # When
    result = reader.read_frame({**request, "episode": 5}, SOURCE)
    # Then
    assert decoded == [(path, [5.7], 1e-3, "pyav")]
    assert result["vectors"]["action"]["values"] == [102, .25]
    assert result["timestampSeconds"] == .2
    assert result["image"]["width"] == 4


def test_modules_when_no_literal_payload_fails_without_executing_source():
    # Given / When / Then
    with pytest.raises(reader.ProjectionError):
        reader.worker_modules("raise AssertionError('must not execute')")


def test_lifecycle_when_ssh_parent_dies_kills_decoder_group():
    # Given: fork models the SSH parent; pipe readiness is the exact installed state.
    source = (ROOT / "projection_worker.py").read_text()
    program = f"""
import os, sys, signal
pid = os.fork()
if pid:
    print("PARENT", os.getpid(), flush=True)
    signal.pause()
else:
    ns = {{"__name__": "lifecycle_test"}}
    exec(compile({source!r}, "projection_worker.py", "exec"), ns)
    ns["install_lifecycle"]()
    helper = os.fork()
    if helper == 0:
        signal.pause()
    print("READY", os.getpid(), helper, flush=True)
    signal.pause()
"""
    process = subprocess.Popen([sys.executable, "-u", "-c", program],
                               stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    group = None
    try:
        assert select.select([process.stdout], [], [], 5)[0]
        assert process.stdout.readline().startswith(b"PARENT")
        assert select.select([process.stdout], [], [], 5)[0]
        ready = process.stdout.readline().split()
        assert ready[0] == b"READY"
        group = int(ready[1])
        # When: loss of the actual parent must close the inherited stdout pipe.
        process.kill()
        process.wait(timeout=5)
        assert select.select([process.stdout], [], [], 5)[0]
        # Then: both worker and helper have exited; neither keeps the pipe open.
        assert process.stdout.read() == b""
    finally:
        if group is not None:
            try:
                os.killpg(group, signal.SIGKILL)
            except ProcessLookupError:
                pass
        if process.poll() is None:
            process.kill()
        process.wait(timeout=5)
        process.stdout.close()
        process.stderr.close()
