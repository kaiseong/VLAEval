"""CPU-only behavior tests for the stdin execution unit."""
from __future__ import annotations

import base64
import ctypes
import importlib.util
import json
import os
from pathlib import Path
import signal
import select
import subprocess
import sys
from types import SimpleNamespace

import numpy as np
import pytest

WORKER = Path(__file__).resolve().parents[1] / "worker.py"
spec = importlib.util.spec_from_file_location("vlaeval_worker", WORKER)
worker = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = worker
spec.loader.exec_module(worker)
runtime = {"__name__": "worker_runtime_tests"}
exec(worker.RUNTIME_SOURCE, runtime)


def encoded(request):
    return base64.b64encode(json.dumps(request).encode()).decode()


def provision_dataset(root, lengths=(2, 1, 3), version="v2.1"):
    meta = root / "meta"
    meta.mkdir(parents=True)
    (meta / "info.json").write_text(json.dumps({
        "codebase_version": version, "fps": 10, "total_episodes": len(lengths),
        "total_frames": sum(lengths),
    }))
    (meta / "episodes.jsonl").write_text("".join(
        json.dumps({"episode_index": i, "length": length, "tasks": [f"task {i}"]}) + "\n"
        for i, length in enumerate(lengths)
    ))
    return root


def run_stdin(request):
    with WORKER.open() as stream:
        source = stream.read()
    result = subprocess.run([sys.executable, "-u", "-", encoded(request)],
                            input=source, text=True, capture_output=True, timeout=30)
    events = [json.loads(line.removeprefix("VLAEVAL "))
              for line in result.stdout.splitlines() if line.startswith("VLAEVAL ")]
    return result, events


def test_discovery_when_supplied_roots_contain_artifacts(tmp_path):
    # Given
    repo = tmp_path / "repo"
    marker = repo / "src/openpi/training/config.py"
    marker.parent.mkdir(parents=True)
    marker.touch()
    checkpoint = tmp_path / "checkpoints/100"
    checkpoint.mkdir(parents=True)
    (checkpoint / "model.safetensors").touch()
    jax = tmp_path / "checkpoints/200/params"
    jax.mkdir(parents=True)
    dataset = provision_dataset(tmp_path / "dataset")
    skipped = provision_dataset(tmp_path / ".venv/hidden")
    (tmp_path / "loop").symlink_to(tmp_path, target_is_directory=True)
    # When
    result, events = run_stdin({"operation": "discover", "roots": [str(tmp_path)]})
    # Then
    assert result.returncode == 0
    discovery = events[-1]
    assert discovery["type"] == "discovery"
    assert discovery["repositories"] == [{"path": str(repo), "python": str(repo / ".venv/bin/python")}]
    assert {(x["step"], x["format"]) for x in discovery["checkpoints"]} == {("100", "pytorch"), ("200", "jax")}
    assert [d["path"] for d in discovery["datasets"]] == [str(dataset)]
    assert str(skipped) not in [d["path"] for d in discovery["datasets"]]


def test_discovery_when_roots_empty_scans_nothing():
    # Given / When
    result = worker.discover(())
    # Then
    assert result["repositories"] == result["checkpoints"] == result["datasets"] == []


def test_discovery_when_generic_data_directory_contains_checkpoints(tmp_path):
    # Given
    checkpoint = tmp_path / "data/checkpoints/1"
    checkpoint.mkdir(parents=True)
    (checkpoint / "params").mkdir()
    # When
    result = worker.discover((str(tmp_path),))
    # Then
    assert result["checkpoints"] == [{"path": str(checkpoint), "step": "1", "format": "jax"}]


def test_discovery_when_fps_absent_emits_finite_default(tmp_path):
    # Given
    provision_dataset(tmp_path)
    (tmp_path / "meta/info.json").write_text(json.dumps({"total_frames": 2}))
    # When
    result = worker.discover((str(tmp_path),))
    # Then
    assert result["datasets"][0]["fps"] == 0
    assert len(result["warnings"]) == 1


def test_discovery_when_budget_exhausted_reports_partial(tmp_path, monkeypatch):
    # Given
    for i in range(8):
        (tmp_path / str(i)).mkdir()
    monkeypatch.setattr(worker, "SCAN_NODES", 3)
    # When
    result = worker.discover((str(tmp_path),))
    # Then
    assert len(result["warnings"]) == 1


def test_discovery_when_root_inaccessible_reports_warning(tmp_path, monkeypatch):
    # Given
    def denied(path):
        raise PermissionError(13, "denied", str(path))
    monkeypatch.setattr(worker.os, "scandir", denied)
    # When
    result = worker.discover((str(tmp_path),))
    # Then
    assert len(result["warnings"]) == 1
    assert result["datasets"] == []


def test_discovery_when_first_root_exhausted_still_inspects_second(tmp_path, monkeypatch):
    # Given
    wide = tmp_path / "wide"
    wide.mkdir()
    for i in range(10):
        (wide / str(i)).mkdir()
    checkpoint = tmp_path / "500"
    checkpoint.mkdir()
    (checkpoint / "params").mkdir()
    monkeypatch.setattr(worker, "SCAN_NODES", 3)
    # When
    result = worker.discover((str(wide), str(checkpoint)))
    # Then
    assert result["checkpoints"] == [{"path": str(checkpoint), "step": "500", "format": "jax"}]
    assert len(result["warnings"]) == 1


def test_episode_listing_when_v2_preserves_ids_and_lengths(tmp_path):
    # Given
    dataset = provision_dataset(tmp_path)
    # When
    result, events = run_stdin({"operation": "episodes", "dataset": str(dataset)})
    # Then
    assert result.returncode == 0
    assert events[0]["type"] == "started"
    assert events[-1] == {
        "type": "episodes", "episodes": [
            {"index": 0, "length": 2, "tasks": ["task 0"]},
            {"index": 1, "length": 1, "tasks": ["task 1"]},
            {"index": 2, "length": 3, "tasks": ["task 2"]},
        ], "fps": 10.0, "version": "v2.1",
    }


def test_episode_listing_when_v3_returns_error(tmp_path):
    # Given
    dataset = provision_dataset(tmp_path, version="v3.0")
    # When
    result, events = run_stdin({"operation": "episodes", "dataset": str(dataset)})
    # Then
    assert result.returncode == 1
    assert events[-1]["type"] == "error"


@pytest.mark.parametrize("field,value", [
    ("episodes", []), ("episodes", [True]), ("stride", 0), ("maxSamples", -1),
    ("repo", "relative"), ("seed", -1), ("numSteps", 0),
])
def test_request_when_invalid_rejects_at_boundary(field, value):
    # Given
    raw = {"operation": "evaluate", "repo": "/repo", "dataset": "/data",
           "checkpoint": "/checkpoint", "config": "test", "episodes": [2]}
    raw[field] = value
    # When / Then
    with pytest.raises(worker.WorkerError):
        worker.Request.decode(encoded(raw))


def test_request_when_defaults_cover_full_episodes():
    # Given
    raw = {"operation": "evaluate", "repo": "/repo", "dataset": "/data",
           "checkpoint": "/checkpoint", "config": "test", "episodes": [2, 0, 2]}
    # When
    parsed = worker.Request.decode(encoded(raw))
    # Then
    assert (parsed.max_samples, parsed.stride, parsed.seed, parsed.num_steps) == (0, 1, 0, 10)
    assert parsed.episodes == (2, 0)


def test_metrics_when_chunks_padded_weight_valid_rows():
    # Given
    metrics = runtime["Metrics"](3, ["joint", "gripper"])
    metrics.add(np.array([[1, 2], [3, 4], [99, 99]]), np.zeros((3, 2)), np.array([True, True, False]))
    metrics.add(np.array([[5, 6], [99, 99], [99, 99]]), np.zeros((3, 2)), np.array([True, False, False]))
    # When
    result = metrics.result()
    # Then
    assert result["validSteps"] == 3
    assert result["mae"] == 3.5
    assert result["rmse"] == pytest.approx(np.sqrt(91 / 6))
    assert result["firstStepMae"] == 3.5
    assert result["perDimension"][0]["mae"] == 3
    assert [h["count"] for h in result["perHorizon"]] == [2, 1, 0]
    assert result["perHorizon"][2]["mae"] is None


@pytest.mark.parametrize("prediction,valid", [
    (np.full((2, 2), np.nan), np.array([True, True])),
    (np.full((2, 2), np.inf), np.array([True, True])),
    (np.ones((1, 2)), np.array([True, True])),
    (np.ones((2, 2)), np.array([False, False])),
    (np.ones((2, 2)), np.array([1, 1])),
])
def test_metrics_when_invalid_rejects_prediction(prediction, valid):
    # Given
    metrics = runtime["Metrics"](2, ["a", "b"])
    # When / Then
    with pytest.raises(RuntimeError):
        metrics.add(prediction, np.zeros((2, 2)), valid)


@pytest.fixture
def scoring_objects():
    from openpi import transforms

    episodes = [{"index": 0, "length": 2}, {"index": 1, "length": 1}, {"index": 2, "length": 3}]

    class Dataset:
        meta = SimpleNamespace(tasks={0: "task"}, features={"action": {"names": ["joint", "gripper"]}})

        def __getitem__(self, index):
            offset = 0
            for ep in episodes:
                if index < offset + ep["length"]:
                    frame = index - offset
                    # Distinct absolute units catch accidental scoring in delta space.
                    state = np.array([10 + ep["index"] * 100 + frame, 0.25])
                    actions = np.stack([state + [min(i, ep["length"] - frame - 1), 0] for i in range(3)])
                    return {"episode_index": ep["index"], "frame_index": frame,
                            "state": state, "action": actions, "task_index": 0,
                            "action_is_pad": np.arange(3) >= ep["length"] - frame}
                offset += ep["length"]
            raise IndexError(index)

    class Policy:
        def __init__(self):
            self.noises = []

        def infer(self, observation, *, noise):
            assert "actions" not in observation and "action" not in observation
            self.noises.append(noise.copy())
            return {"actions": np.stack([observation["state"] + [1, 0.5] for _ in range(3)])}

    data = SimpleNamespace(
        repack_transforms=transforms.Group(inputs=[transforms.RepackTransform(
            {"state": "state", "actions": "action", "prompt": "prompt"})]),
        data_transforms=transforms.Group(inputs=[transforms.DeltaActions([True, False])],
                                         outputs=[transforms.AbsoluteActions([True, False])]),
        action_sequence_keys=("action",), prompt_from_task=True,
    )
    request = {"episodes": [0, 2], "stride": 1, "maxSamples": 0, "seed": 7}
    return Dataset(), Policy(), data, SimpleNamespace(action_horizon=3, action_dim=2), request, episodes


def test_scoring_when_selected_ids_noncontiguous_covers_full_traces(scoring_objects, capsys):
    # Given
    dataset, policy, data, model, request, episodes = scoring_objects
    # When
    result = runtime["score_frames"](dataset, policy, data, model, request, episodes)
    # Then
    assert result["framesEvaluated"] == 5
    assert result["validSteps"] == 9
    assert result["coverage"] == {
        "horizon": 3,
        "episodes": [
            {"episode": 0, "originalFrames": 2, "scoredAnchors": 2,
             "geometricFullAnchors": 0, "fullyValidChunks": 0,
             "geometricTailAnchors": 2, "validRows": 3, "validRowsByHorizon": [2, 1, 0]},
            {"episode": 2, "originalFrames": 3, "scoredAnchors": 3,
             "geometricFullAnchors": 1, "fullyValidChunks": 1,
             "geometricTailAnchors": 2, "validRows": 6, "validRowsByHorizon": [3, 2, 1]},
        ],
        "scoredAnchors": 5, "geometricFullAnchors": 1, "fullyValidChunks": 1,
        "geometricTailAnchors": 4, "validRows": 9, "validRowsByHorizon": [5, 3, 1],
    }
    assert [(t["episode"], t["frames"]) for t in result["traces"]] == [(0, [0, 1]), (2, [0, 1, 2])]
    assert result["traces"][1]["target"][0] == [210, 0.25]
    assert result["traces"][1]["predicted"][0] == [211, 0.75]
    assert result["mae"] == pytest.approx((6 + 4.5) / 18)
    assert result["firstStepMae"] == 0.75
    assert [(e["episode"], e["framesEvaluated"], e["mae"]) for e in result["perEpisode"]] == [(0, 2, 0.75), (2, 3, 0.75)]
    assert len(policy.noises) == 6  # One untimed warmup plus five frames.
    np.testing.assert_array_equal(policy.noises[0], policy.noises[1])
    events = [json.loads(line.removeprefix("VLAEVAL ")) for line in capsys.readouterr().out.splitlines()]
    assert events[-1]["completed"] == events[-1]["total"] == 5


def test_scoring_when_seed_repeated_preserves_noise(scoring_objects, capsys):
    # Given
    dataset, policy, data, model, request, episodes = scoring_objects
    runtime["score_frames"](dataset, policy, data, model, request, episodes)
    first = [noise.copy() for noise in policy.noises]
    policy.noises.clear()
    # When
    runtime["score_frames"](dataset, policy, data, model, request, episodes)
    # Then
    for old, new in zip(first, policy.noises, strict=True):
        np.testing.assert_array_equal(old, new)


def test_scoring_when_samples_capped_retains_all_traces(scoring_objects):
    # Given
    dataset, policy, data, model, request, episodes = scoring_objects
    episodes[0]["length"] = 6
    episodes[2]["length"] = 6
    # When
    result = runtime["score_frames"](dataset, policy, data, model, request, episodes)
    # Then
    assert len(result["samples"]) == 8
    assert result["framesEvaluated"] == sum(len(t["frames"]) for t in result["traces"]) == 12


def test_latency_when_warmup_runs_excludes_it(scoring_objects, monkeypatch):
    # Given
    dataset, policy, data, model, request, episodes = scoring_objects
    ticks = iter([0, .1, 1, 1.1, 2, 2.1, 3, 3.1, 4, 4.1])
    monkeypatch.setattr(runtime["time"], "perf_counter", lambda: next(ticks))
    # When
    result = runtime["score_frames"](dataset, policy, data, model, request, episodes)
    # Then
    assert result["latencyMs"]["median"] == pytest.approx(100)
    assert result["latencyMs"]["p95"] == pytest.approx(100)


def test_scoring_when_real_v2_dataset_selected_keeps_episode_boundaries(tmp_path, scoring_objects, monkeypatch):
    # Given: real v2 parquet and metadata, with a synthetic inference-only policy.
    import lerobot.common.datasets.lerobot_dataset as lerobot
    _, policy, data, model, request, episodes = scoring_objects
    root = tmp_path / "actual"
    features = {
        key: {"dtype": "float32", "shape": (2,), "names": ["joint", "gripper"]}
        for key in ("state", "action")
    }
    created = lerobot.LeRobotDataset.create("local/test", fps=10, root=root,
                                           features=features, robot_type="synthetic", use_videos=False)
    for ep in episodes:
        for frame in range(ep["length"]):
            state = np.array([10 + ep["index"] * 100 + frame, 0.25], dtype=np.float32)
            created.add_frame({"state": state.copy(), "action": state.copy(), "task": "task"})
        created.save_episode()
    request.update({"dataset": str(root), "metadata": worker.episode_metadata(str(root))})
    monkeypatch.setattr(lerobot, "snapshot_download", runtime["forbid_download"])
    monkeypatch.setattr(lerobot, "get_safe_version", runtime["forbid_download"])
    dataset = runtime["load_dataset"](request, data, model.action_horizon)
    # When
    result = runtime["score_frames"](dataset, policy, data, model, request, request["metadata"]["episodes"])
    # Then
    assert result["validSteps"] == 9
    assert result["traces"][1]["frames"] == [0, 1, 2]
    assert result["traces"][1]["target"] == [[210, .25], [211, .25], [212, .25]]
    assert result["samples"][-1]["valid"] == [True, False, False]


def test_selection_when_subset_requested_limits_explicitly():
    # Given
    episodes = [{"index": 0, "length": 4}, {"index": 1, "length": 3}]
    request = {"episodes": [1], "stride": 2, "maxSamples": 1}
    # When
    selected = runtime["select_frames"](episodes, request)
    # Then
    assert selected == [(4, 1, 0, 3)]


def test_selection_when_unknown_episode_fails():
    # Given
    request = {"episodes": [5], "stride": 1, "maxSamples": 0}
    # When / Then
    with pytest.raises(RuntimeError):
        runtime["select_frames"]([{"index": 0, "length": 2}], request)


@pytest.mark.parametrize("suffix", ["", "/params", "/model.safetensors"])
def test_checkpoint_when_weight_path_normalizes_root(tmp_path, suffix):
    # Given
    (tmp_path / "params").mkdir()
    (tmp_path / "model.safetensors").touch()
    # When
    root = runtime["checkpoint_root"](str(tmp_path) + suffix)
    # Then
    assert root == tmp_path


def test_assets_when_cached_uri_resolves_without_download(tmp_path, monkeypatch):
    # Given
    asset = tmp_path / "bucket/tokenizer"
    asset.parent.mkdir()
    asset.touch()
    monkeypatch.setenv("OPENPI_DATA_HOME", str(tmp_path))
    # When
    resolved = runtime["local_asset"]("gs://bucket/tokenizer")
    # Then
    assert resolved == asset


def test_assets_when_missing_prevents_network(tmp_path):
    # Given / When / Then
    with pytest.raises(FileNotFoundError):
        runtime["local_asset"](str(tmp_path / "missing"))


def test_configs_when_provisioned_uses_repo_interpreter(tmp_path):
    # Given
    repo = tmp_path / "repo"
    config = repo / "src/openpi/training/config.py"
    config.parent.mkdir(parents=True)
    config.write_text(
        "from types import SimpleNamespace as S\n"
        "_CONFIGS = [S(name='synthetic', data=S(repo_id='local/test'), "
        "model=S(action_dim=2, action_horizon=3))]\n"
    )
    download = repo / "src/openpi/shared/download.py"
    download.parent.mkdir()
    download.touch()
    python = repo / ".venv/bin/python"
    python.parent.mkdir(parents=True)
    python.symlink_to(sys.executable)
    # When
    result, events = run_stdin({"operation": "configs", "repo": str(repo)})
    # Then
    assert result.returncode == 0, result.stderr
    assert events[-1]["configs"] == [{"name": "synthetic", "repoId": "local/test", "actionDim": 2, "actionHorizon": 3}]
    assert isinstance(events[-1]["revision"], str)


def test_cancellation_when_started_emits_cancelled(tmp_path):
    # Given: FIFO supplies an exact blocking point without timing sleeps.
    root = tmp_path / "dataset"
    meta = root / "meta"
    meta.mkdir(parents=True)
    fifo = meta / "info.json"
    os.mkfifo(fifo)
    with WORKER.open() as stream:
        source = stream.read()
    with subprocess.Popen([sys.executable, "-u", "-", encoded({"operation": "episodes", "dataset": str(root)})],
                          stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True) as process:
        process.stdin.write(source)
        process.stdin.close()
        # When: started confirms handler installation before SIGTERM.
        started = json.loads(process.stdout.readline().removeprefix("VLAEVAL "))
        assert started["type"] == "started"
        process.send_signal(signal.SIGTERM)
        process.wait(timeout=10)
        remainder = process.stdout.read()
    # Then
    assert process.returncode == 130
    assert json.loads(remainder.removeprefix("VLAEVAL "))["type"] == "cancelled"


@pytest.mark.parametrize("termination", [signal.SIGTERM, signal.SIGKILL])
def test_inference_child_when_transport_terminated_exits(tmp_path, termination):
    # Given: config import announces the child PID before blocking on a FIFO.
    repo = tmp_path / "repo"
    fifo = tmp_path / "gate"
    os.mkfifo(fifo)
    config = repo / "src/openpi/training/config.py"
    config.parent.mkdir(parents=True)
    config.write_text(
        "import os\n"
        "print('TEST_CHILD ' + str(os.getpid()), flush=True)\n"
        f"with open({str(fifo)!r}) as gate:\n"
        "    gate.read()\n"
    )
    download = repo / "src/openpi/shared/download.py"
    download.parent.mkdir()
    download.touch()
    python = repo / ".venv/bin/python"
    python.parent.mkdir(parents=True)
    python.symlink_to(sys.executable)
    with WORKER.open() as stream:
        source = stream.read()
    with subprocess.Popen([sys.executable, "-u", "-", encoded({"operation": "configs", "repo": str(repo)})],
                          stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True) as process:
        process.stdin.write(source)
        process.stdin.close()
        started = json.loads(process.stdout.readline().removeprefix("VLAEVAL "))
        assert started["type"] == "started"
        child_line = process.stdout.readline()
        assert child_line.startswith("TEST_CHILD ")
        child_pid = int(child_line.split()[1])
        # This Python build omits os.pidfd_open; Linux x64 syscall 434 is
        # still available and gives an event-driven process-exit signal.
        pidfd = ctypes.CDLL(None, use_errno=True).syscall(434, child_pid, 0)
        try:
            assert pidfd >= 0, ctypes.get_errno()
            # When
            process.send_signal(termination)
            process.wait(timeout=10)
            # Then: pidfd readiness signals exit, including an unreaped orphan.
            assert select.select([pidfd], [], [], 10)[0] == [pidfd]
            if termination == signal.SIGTERM:
                event = json.loads(process.stdout.readline().removeprefix("VLAEVAL "))
                assert event["type"] == "cancelled"
        finally:
            if process.poll() is None:
                process.kill()
                process.wait(timeout=10)
            if pidfd >= 0:
                os.close(pidfd)
            try:
                os.kill(child_pid, signal.SIGKILL)
            except ProcessLookupError:
                assert process.returncode is not None


@pytest.fixture
def v3_root(tmp_path):
    import pyarrow as pa
    import pyarrow.parquet as pq
    root = tmp_path / "v3"
    (root / "meta").mkdir(parents=True)
    features = {
        "state": {"dtype": "float32", "shape": [2], "names": ["joint", "gripper"]},
        "action": {"dtype": "float32", "shape": [2], "names": ["joint", "gripper"]},
        "camera": {"dtype": "video", "shape": [3, 16, 16]},
    }
    (root / "meta/info.json").write_text(json.dumps({
        "codebase_version": "v3.0", "fps": 10, "total_episodes": 2,
        "total_frames": 5, "features": features,
        "video_path": "videos/{video_key}/chunk-{chunk_index:03d}/file-{file_index:03d}.mp4",
    }))
    # Task order deliberately disagrees with task_index. A named pandas index
    # is how the real v3 exporter represents task strings.
    tasks = pa.Table.from_pylist([
        {"task_index": 7, "instruction": "task seven"},
        {"task_index": 2, "instruction": "task two"},
    ]).replace_schema_metadata({b"pandas": json.dumps({"index_columns": ["instruction"]}).encode()})
    pq.write_table(tasks, root / "meta/tasks.parquet")
    records = [
        {"episode_index": 0, "length": 2, "tasks": ["task seven"], "dataset_from_index": 0,
         "dataset_to_index": 2, "data/chunk_index": 0, "data/file_index": 0,
         "videos/camera/chunk_index": 0, "videos/camera/file_index": 0,
         "videos/camera/from_timestamp": 1.0},
        {"episode_index": 5, "length": 3, "tasks": ["task two", "task seven"], "dataset_from_index": 2,
         "dataset_to_index": 5, "data/chunk_index": 0, "data/file_index": 1,
         "videos/camera/chunk_index": 0, "videos/camera/file_index": 0,
         "videos/camera/from_timestamp": 5.0},
    ]
    for i, record in enumerate(records):
        file = root / f"meta/episodes/chunk-{i:03d}/file-000.parquet"
        file.parent.mkdir(parents=True)
        pq.write_table(pa.Table.from_pylist([record]), file)
    rows = []
    for record in records:
        for frame in range(record["length"]):
            value = 10 + record["episode_index"] * 100 + frame
            rows.append({
                "index": len(rows), "episode_index": record["episode_index"], "frame_index": frame,
                "timestamp": frame / 10, "task_index": 7 if frame % 2 else 2,
                "state": [value, .25], "action": [value, .25],
            })
    for relative, subset in [
        ("data/chunk-000/file-000.parquet", rows[:2]),
        ("data/chunk-000/file-001.parquet", rows[2:3]),
        ("data/chunk-001/file-000.parquet", rows[3:]),
    ]:
        file = root / relative
        file.parent.mkdir(parents=True, exist_ok=True)
        pq.write_table(pa.Table.from_pylist(subset), file)
    video = root / "videos/camera/chunk-000/file-000.mp4"
    video.parent.mkdir(parents=True)
    video.touch()
    return root


def test_v3_metadata_when_multiple_chunks_returns_all_episodes(v3_root):
    # Given / When
    event, _, _ = runtime["v3_metadata"](v3_root)
    # Then
    assert event == {"type": "episodes", "fps": 10.0, "version": "v3.0", "episodes": [
        {"index": 0, "length": 2, "tasks": ["task seven"]},
        {"index": 5, "length": 3, "tasks": ["task two", "task seven"]},
    ]}


def test_v3_adapter_when_episode_spans_files_clamps_actions_and_maps_tasks(v3_root, scoring_objects, monkeypatch):
    # Given
    import lerobot.common.datasets.video_utils as video_utils
    calls = []
    def decode(path, timestamps, tolerance_s, backend):
        calls.append((path, timestamps, backend))
        return np.zeros((1, 3, 16, 16), dtype=np.float32)
    monkeypatch.setattr(video_utils, "decode_video_frames", decode)
    _, _, data, model, request, _ = scoring_objects
    request.update({"dataset": str(v3_root), "episodes": [5]})
    dataset = runtime["V3Dataset"](request, data, model.action_horizon)
    # When
    frame = dataset[3]
    # Then
    assert frame["task"] == "task seven"
    np.testing.assert_array_equal(frame["action"], [[511, .25], [512, .25], [512, .25]])
    np.testing.assert_array_equal(frame["action_is_pad"], [False, False, True])
    assert calls == [(v3_root / "videos/camera/chunk-000/file-000.mp4", [5.1], "pyav")]


def test_v3_scoring_when_noncontiguous_episode_selected_covers_trace(v3_root, scoring_objects, monkeypatch):
    # Given
    import lerobot.common.datasets.video_utils as video_utils
    monkeypatch.setattr(video_utils, "decode_video_frames",
                        lambda *args, **kwargs: np.zeros((1, 3, 16, 16), dtype=np.float32))
    _, policy, data, model, request, _ = scoring_objects
    request.update({"dataset": str(v3_root), "episodes": [5]})
    event = runtime["v3_metadata"](v3_root)[0]
    dataset = runtime["V3Dataset"](request, data, model.action_horizon)
    # When
    result = runtime["score_frames"](dataset, policy, data, model, request, event["episodes"])
    # Then
    assert result["framesEvaluated"] == 3
    assert result["validSteps"] == 6
    assert result["traces"] == [{
        "episode": 5, "frames": [0, 1, 2], "predicted": [[511, .75], [512, .75], [513, .75]],
        "target": [[510, .25], [511, .25], [512, .25]],
    }]
    assert [sample["prompt"] for sample in result["samples"]] == ["task two", "task seven", "task two"]


def test_v3_adapter_when_unselected_files_missing_reads_selected_only(v3_root, scoring_objects, monkeypatch):
    # Given
    import lerobot.common.datasets.video_utils as video_utils
    (v3_root / "data/chunk-000/file-000.parquet").unlink()
    monkeypatch.setattr(video_utils, "decode_video_frames",
                        lambda *args, **kwargs: np.zeros((1, 3, 16, 16), dtype=np.float32))
    _, _, data, model, request, _ = scoring_objects
    request.update({"dataset": str(v3_root), "episodes": [5]})
    dataset = runtime["V3Dataset"](request, data, model.action_horizon)
    # When
    frame = dataset[2]
    # Then
    assert frame["episode_index"] == 5


def test_v3_episode_operation_when_repo_supplied_uses_venv(v3_root, tmp_path):
    # Given
    repo = tmp_path / "repo"
    marker = repo / "src/openpi/training/config.py"
    marker.parent.mkdir(parents=True)
    marker.touch()
    # Link the entire provisioned environment, not just its executable: Python
    # locates pyarrow through the environment's own pyvenv.cfg/site-packages.
    (repo / ".venv").symlink_to(sys.prefix, target_is_directory=True)
    # When
    result, events = run_stdin({"operation": "episodes", "repo": str(repo), "dataset": str(v3_root)})
    # Then
    assert result.returncode == 0, result.stderr
    assert events[-1]["version"] == "v3.0"
    assert [ep["index"] for ep in events[-1]["episodes"]] == [0, 5]


def test_v3_video_when_shared_file_decodes_episode_offset(v3_root, scoring_objects):
    # Given: a real MP4, each frame carrying a different red intensity.
    import av
    video = v3_root / "videos/camera/chunk-000/file-000.mp4"
    with av.open(str(video), "w") as container:
        stream = container.add_stream("libx264", rate=10)
        stream.width = stream.height = 16
        stream.pix_fmt = "yuv420p"
        stream.options = {"crf": "0"}
        for i in range(60):
            pixels = np.zeros((16, 16, 3), dtype=np.uint8)
            pixels[:, :, 0] = i * 3
            frame = av.VideoFrame.from_ndarray(pixels, format="rgb24")
            for packet in stream.encode(frame):
                container.mux(packet)
        for packet in stream.encode():
            container.mux(packet)
    _, _, data, model, request, _ = scoring_objects
    request.update({"dataset": str(v3_root), "episodes": [5]})
    dataset = runtime["V3Dataset"](request, data, model.action_horizon)
    # When: episode 5 local frame 1 is global video frame 51, not frame 1.
    frame = dataset[3]
    # Then
    assert frame["camera"].shape == (3, 16, 16)
    assert frame["camera"][0].mean() == pytest.approx(153 / 255, abs=2 / 255)


def test_v3_adapter_when_selected_data_missing_rejects(v3_root, scoring_objects):
    # Given
    (v3_root / "data/chunk-001/file-000.parquet").unlink()
    _, _, data, model, request, _ = scoring_objects
    request.update({"dataset": str(v3_root), "episodes": [5]})
    dataset = runtime["V3Dataset"](request, data, model.action_horizon)
    # When / Then
    with pytest.raises(RuntimeError):
        dataset[2]
