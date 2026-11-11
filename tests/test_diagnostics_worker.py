"""CPU-only diagnostics bridge regressions, including the shipped JAX buffers."""
import base64
import copy
import hashlib
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
from types import SimpleNamespace

import numpy as np
import pytest

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("diagnostics_worker", ROOT / "diagnostics_worker.py")
bridge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bridge)


@pytest.fixture
def capture():
    arrays = {
        "key_attention": np.full((1, 2, 2, 7), 1 / 7, dtype=np.float32),
        "query_groups": np.array([[0, 1], [1, 3]], np.int32),
        "key_role": np.array([0, 0, 1, 2, 3, 3, 3]),
        "flow_t": np.array([1], np.float32),
        "patch_valid_fraction": np.array([[[1, 0]]], np.float32),
        "actions": np.array([[1., 2], [3, 4], [5, 6]]),
        "reference_actions": np.array([[1., 2], [3, 4], [5, 6]]),
    }
    metadata = {
        "schema_version": bridge.ADAPTER_SCHEMA,
        "axes": {"layer": {"size": 2, "num_heads": 8}, "query_group": {"horizon": 3}},
        "token_layout": {"roles": ["camera:base_0_rgb", "instruction", "padding", "action"],
                         "suffix": {"len": 3}},
        "run_identity": {"adapter": {"version": "1.2.0"}},
        "cameras": [{"dataset_key": "observation.images.front", "model_key": "base_0_rgb",
                     "grid_hw": [1, 2], "token_range": [0, 2], "geometry_resolved": True,
                     "transform": {"model_input_hw": [4, 8], "scale_hw": [2, 2],
                                   "original_hw": [2, 4], "offset_hw": [0, 0], "resized_hw": [4, 8],
                                   "flips": {"horizontal": False, "vertical": False, "transposed": False}}}],
        "timing": {"prepare_s": 0.2, "compile_s": 1, "host_transfer_bytes": 128},
    }
    raw = {"observation.images.front": np.zeros((2, 4, 3), np.uint8)}
    request = {"jobId": "998a89b3-b5bd-43c9-933e-be290900e9ab", "episode": 2, "frame": 2,
               "repo": "/repo", "dataset": "/data", "config": "config", "checkpoint": "/checkpoint",
               "seed": 7, "numSteps": 1, "actionNames": ["joint", "gripper"],
               "savedActions": [[2, 5], [100, 100], [100, 100]], "savedValid": [True, False, False]}
    return arrays, metadata, raw, request


def test_packet_when_tail_mask_keeps_returned_odd_horizon_groups(capture):
    # Given
    arrays, meta, raw, request = capture
    # When
    packet = bridge.build_packet(arrays, meta, {"state": np.array([1, 2])}, raw, request)
    # Then
    assert packet["attention"]["queryGroups"][1]["horizonIndices"] == [1, 2]
    assert [d["maxAbsolute"] for d in packet["actionDifferences"]] == [1, 3]
    assert [d["maxAbsolute"] for d in packet["sameProcessDifferences"]] == [0, 0]
    assert all(d["unit"] == "native/unknown" for d in packet["actionDifferences"])
    assert packet["projection"] is None
    assert packet["timing"]["prepareMs"] == 200
    assert packet["attention"]["keyGroups"][2]["kind"] == "padding"


@pytest.mark.parametrize("backend,compiled", [("jax", True), ("pytorch", False)])
def test_packet_provenance_records_backend_and_compilation(capture, backend, compiled):
    # Given a capture from the given backend (PyTorch diagnostics run eager)
    arrays, meta, raw, request = capture
    request["backend"] = backend
    # When
    packet = bridge.build_packet(arrays, meta, {}, raw, request)
    # Then
    assert packet["provenance"]["backend"] == backend
    assert packet["provenance"]["compiled"] is compiled


def test_packet_when_unresolved_geometry_retains_nulls_and_metadata(capture):
    # Given
    arrays, meta, raw, request = capture
    meta["cameras"][0].update(geometry_resolved=False, transform=None)
    meta["unresolved"] = [float("nan"), float("inf")]
    arrays["patch_valid_fraction"][:] = np.nan
    # When
    packet = bridge.build_packet(arrays, meta, {}, raw, request)
    # Then
    assert packet["images"][0]["preprocessing"] is None
    assert packet["images"][0]["geometryResolved"] is False
    assert packet["attention"]["cameras"][0]["patchValidFraction"] is None
    assert packet["attention"]["slices"][0]["maps"][0]["letterboxMass"] is None
    assert packet["adapterMetadata"]["unresolved"] == [None, None]
    json.dumps(packet, allow_nan=False)


@pytest.mark.parametrize("invalid", [-1e-12, float("nan"), float("inf"), 1.1])
def test_packet_when_invalid_probability_rejected(capture, invalid):
    # Given
    arrays, meta, raw, request = capture
    arrays["key_attention"][0, 0, 0, 0] = invalid
    # When / Then
    with pytest.raises(bridge.DiagnosticError):
        bridge.build_packet(arrays, meta, {}, raw, request)


def test_packet_when_float32_values_preserve_exact_bits(capture):
    # Given
    arrays, meta, raw, request = capture
    # When
    packet = bridge.build_packet(arrays, meta, {}, raw, request)
    # Then
    encoded = packet["attention"]["slices"][0]["maps"][0]
    restored = np.frombuffer(base64.b64decode(encoded["valuesF32LE"]), dtype="<f4")
    np.testing.assert_array_equal(restored, arrays["key_attention"][0, 0, 0, :2])
    assert encoded["letterboxMass"] == float(restored[1])
    image = packet["images"][0]
    assert image["sha256"] == hashlib.sha256(base64.b64decode(image["dataBase64"])).hexdigest()
    assert image["width"] == 4 and image["height"] == 2


@pytest.mark.parametrize("shape", [(2, 4, 4), (2, 4, 1)])
def test_images_when_non_rgb_channels_rejected(capture, shape):
    # Given
    arrays, meta, raw, request = capture
    raw["observation.images.front"] = np.zeros(shape, np.uint8)
    # When / Then
    with pytest.raises(bridge.DiagnosticError):
        bridge.build_packet(arrays, meta, {}, raw, request)


def test_packet_when_channel_names_mismatch_rejected(capture):
    # Given
    arrays, meta, raw, request = capture
    request["actionNames"] = ["only_one"]
    # When / Then
    with pytest.raises(bridge.DiagnosticError):
        bridge.build_packet(arrays, meta, {}, raw, request)


def test_runtime_when_low_memory_executes_no_model_sources(capture, monkeypatch, capsys):
    # Given
    _, _, _, request = capture
    source = "raise AssertionError('model source executed')"
    request["adapterSha256"] = hashlib.sha256(source.encode()).hexdigest()
    monkeypatch.setattr(bridge, "install_lifecycle", lambda: None)
    monkeypatch.setattr(bridge.subprocess, "run",
                        lambda *args, **kwargs: SimpleNamespace(stdout="0, GPU-test, 20479\n"))
    # When
    code = bridge.runtime_main(request, source, source)
    # Then
    assert code == 1
    events = [json.loads(line.removeprefix(bridge.PREFIX)) for line in capsys.readouterr().out.splitlines()]
    assert events[-1]["status"] == "blocked"


def test_runtime_when_pytorch_adapter_missing_unsupported_before_preflight(capture, monkeypatch, capsys, tmp_path):
    # Given a PyTorch checkpoint but no PyTorch adapter source
    request = capture[3]
    (tmp_path / "model.safetensors").write_bytes(b"")
    request["checkpoint"] = str(tmp_path)
    monkeypatch.setattr(bridge, "install_lifecycle", lambda: None)
    def forbidden(*args):
        pytest.fail("GPU preflight must not run")
    monkeypatch.setattr(bridge, "gpu_preflight", forbidden)
    # When
    code = bridge.runtime_main(request, "", "")
    # Then
    assert code == 1
    assert json.loads(capsys.readouterr().out.splitlines()[-1].removeprefix(bridge.PREFIX))["status"] == "unsupported"


def test_runtime_when_sha_mismatch_rejected(capture, monkeypatch, capsys):
    # Given
    request = capture[3]
    request["adapterSha256"] = "0" * 64
    monkeypatch.setattr(bridge, "install_lifecycle", lambda: None)
    # When
    code = bridge.runtime_main(request, "", "bad bytes")
    # Then
    assert code == 1
    assert json.loads(capsys.readouterr().out.splitlines()[-1].removeprefix(bridge.PREFIX))["status"] == "failed"


def test_preflight_when_visible_gpu_meets_floor(monkeypatch):
    # Given
    monkeypatch.setenv("CUDA_VISIBLE_DEVICES", "1")
    monkeypatch.setattr(bridge.subprocess, "run",
                        lambda *args, **kwargs: SimpleNamespace(stdout="0, GPU-zero, 1\n1, GPU-one, 20480\n"))
    # When
    free = bridge.gpu_preflight(1)
    # Then
    assert free == 20480


def test_worker_source_when_full_source_extracts_without_running_entry():
    # Given
    with (ROOT / "worker.py").open() as stream:
        source = stream.read()
    # When
    runtime = bridge.worker_runtime(source)
    # Then
    assert callable(runtime.score_frames)
    assert callable(runtime.load_dataset)
    assert callable(runtime.local_asset)


def test_source_when_stdin_without_invocation_is_inert():
    # Given
    with (ROOT / "diagnostics_worker.py").open() as stream:
        source = stream.read()
    source += "\nassert 'jax' not in sys.modules\n"
    # When
    result = subprocess.run([sys.executable, "-u", "-"], input=source, text=True, capture_output=True, timeout=10)
    # Then
    assert result.returncode == 0, result.stderr
    assert result.stdout == ""


def test_packet_when_real_saved_sample_retains_every_slice():
    # Given
    directory = ROOT.parent / "vlaeval-attention/out"
    if not (directory / "sample_output.npz").exists():
        pytest.skip("Shipped adapter sample not installed.")
    with (directory / "sample_output.json").open() as stream:
        meta = json.load(stream)["metadata"]
    with np.load(directory / "sample_output.npz", allow_pickle=False) as archive:
        arrays = {key: archive[key] for key in archive.files}
    raw = {camera["dataset_key"]: np.zeros((camera["original"]["height"], camera["original"]["width"], 3), np.uint8)
           for camera in meta["cameras"]}
    request = {"jobId": "998a89b3-b5bd-43c9-933e-be290900e9ab", "episode": 0, "frame": 0,
               "dataset": "/sample", "config": "sample", "checkpoint": "/sample", "seed": 0, "numSteps": 10,
               "actionNames": [f"action_{i}" for i in range(arrays["actions"].shape[1])],
               "savedActions": arrays["actions"], "savedValid": None}
    # When
    packet = bridge.build_packet(arrays, meta, {}, raw, request)
    # Then
    assert len(packet["attention"]["slices"]) == 10 * 18 * 2
    assert len(packet["images"]) == 3
    assert packet["provenance"]["adapterRevision"].split(".")[:2] == ["1", "2"]
    assert all(d["maxAbsolute"] == 0 for d in packet["actionDifferences"])
    json.dumps(packet, allow_nan=False)


def test_capture_when_real_worker_repack_runs_normal_inference_first(capture, monkeypatch):
    # Given: actual worker score_frames and real OpenPi transforms, no model.
    from openpi import transforms
    arrays, meta, raw, request = capture
    with (ROOT / "worker.py").open() as stream:
        runtime = bridge.worker_runtime(stream.read())
    order = []
    class Dataset:
        meta = SimpleNamespace(tasks={0: "task"}, features={}, fps=10)
        def __getitem__(self, index):
            assert index == 4  # first episode length 2 + selected frame 2
            return {**raw, "episode_index": 2, "frame_index": 2, "task_index": 0,
                    "state": np.array([1, 2]), "action": np.ones((3, 2)),
                    "action_is_pad": np.array([False, True, True])}
    class Policy:
        def infer(self, observation, *, noise):
            order.append("normal")
            assert "actions" not in observation
            assert observation["prompt"] == "task"
            expected = np.random.default_rng(np.random.SeedSequence([7, 2, 2])).standard_normal((3, 2)).astype(np.float32)
            np.testing.assert_array_equal(noise, expected)
            return {"actions": arrays["actions"]}
    def collect(policy, observation, **kwargs):
        order.append("diagnostic")
        np.testing.assert_array_equal(kwargs["reference_actions"], arrays["actions"])
        assert kwargs["num_steps"] == 1
        assert kwargs["run_info"]["adapter_sha256"] == "test-sha"
        return {"arrays": arrays, "metadata": meta}
    adapter = SimpleNamespace(collect_action_image_attention=collect, dataset_key_map_from_repack=lambda group: {})
    data = SimpleNamespace(repack_transforms=transforms.Group(inputs=[
        transforms.RepackTransform({"state": "state", "actions": "action", "prompt": "prompt"})]),
        data_transforms=transforms.Group(), action_sequence_keys=("action",), prompt_from_task=True)
    model = SimpleNamespace(action_horizon=3, action_dim=2)
    metadata = {"episodes": [{"index": 0, "length": 2}, {"index": 2, "length": 3}]}
    request.update(maxSamples=1, stride=1)
    # When
    packet = bridge.capture_selected(runtime, adapter, Dataset(), Policy(), data, model, request, metadata, "test-sha")
    # Then
    assert order == ["normal", "diagnostic"]
    assert packet["identity"]["frame"] == 2
    assert packet["attention"]["queryGroups"][1]["horizonIndices"] == [1, 2]


def test_packet_when_trace_row_compares_only_stored_first_row(capture):
    # Given
    arrays, meta, raw, request = capture
    request.update(savedActionsScope="trace_row", savedActions=[2, 5], savedValid=[True])
    # When
    packet = bridge.build_packet(arrays, meta, {}, raw, request)
    # Then
    assert [d["maxAbsolute"] for d in packet["actionDifferences"]] == [1, 3]
    assert packet["attention"]["queryGroups"][1]["horizonIndices"] == [1, 2]


def test_preprocessing_when_transposed_and_flipped_composes_source_axes(capture):
    # Given
    camera = capture[1]["cameras"][0]
    camera["transform"].update(original_hw=[2, 4], resized_hw=[8, 4],
                               model_input_hw=[8, 4], scale_hw=[4, 1])
    camera["transform"]["flips"].update(transposed=True, horizontal=True, vertical=True)
    # When
    transform = bridge.preprocessing(camera)
    # Then
    assert transform["sourceToInput"] == [0, -2, -2, 0, 4, 8]


def test_lifecycle_when_linux_installs_parent_death_and_handlers(monkeypatch):
    # Given: fake only the OS boundary; no signals are sent by this test.
    calls = []
    monkeypatch.setattr(bridge.os, "getppid", lambda: 42)
    monkeypatch.setattr(bridge.os, "getpgrp", lambda: 100)
    monkeypatch.setattr(bridge.os, "getpid", lambda: 101)
    monkeypatch.setattr(bridge.os, "setpgid", lambda *args: calls.append(("setpgid", args)))
    monkeypatch.setattr(bridge.signal, "signal", lambda *args: calls.append(("handler", args)))
    monkeypatch.setattr(bridge.signal, "pthread_sigmask", lambda *args: calls.append(("unblock", args)))
    monkeypatch.setattr(bridge.ctypes, "CDLL",
                        lambda *args, **kwargs: SimpleNamespace(prctl=lambda *args: calls.append(("prctl", args)) or 0))
    # When
    bridge.install_lifecycle()
    # Then
    assert calls[0] == ("setpgid", (0, 0))
    assert len([call for call in calls if call[0] == "handler"]) == 3
    assert ("prctl", (1, bridge.signal.SIGTERM, 0, 0, 0)) in calls



def video_capture_inputs(capture, length=7):
    arrays, meta, raw, request = capture
    arrays = {**arrays, "key_attention": np.stack([np.full((2, 2, 7), 1 / 7, np.float32),
                                                    np.tile(np.array([0.4, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1], np.float32), (2, 2, 1))])}
    request = {key: value for key, value in request.items() if key not in ("frame", "actionNames", "savedActions", "savedValid")}
    request.update(numSteps=2, stride=3, maxSamples=0, episodes=[2])
    return arrays, meta, raw, request


def test_reduction_when_last_step_layer_mean_and_query_count_weighting():
    # Given: two steps, two layers, query groups of 1 and 2 rows.
    dist = np.zeros((2, 2, 2, 4), np.float32)
    dist[0] = 0.25
    dist[1, 0, 0] = [1, 0, 0, 0]
    dist[1, 1, 0] = [0, 1, 0, 0]
    dist[1, 0, 1] = [0, 0, 1, 0]
    dist[1, 1, 1] = [0, 0, 0, 1]
    arrays = {"key_attention": dist, "query_groups": np.array([[0, 1], [1, 3]], np.int32),
              "key_role": np.array([0, 0, 1, 1])}
    meta = {"schema_version": bridge.ADAPTER_SCHEMA, "axes": {"layer": {"size": 2}, "query_group": {"horizon": 3}},
            "token_layout": {"roles": ["camera:base_0_rgb", "instruction"]}}
    # When
    vector, per_layer, roles = bridge.reduce_attention(arrays, meta, 2)
    # Then: early group mean [.5,.5,0,0] weight 1, late [0,0,.5,.5] weight 2.
    np.testing.assert_allclose(vector, [1 / 6, 1 / 6, 1 / 3, 1 / 3])
    # Per layer, query weighting only: layer 0 = (e0 + 2*e2)/3, layer 1 = (e1 + 2*e3)/3.
    np.testing.assert_allclose(per_layer, [[1 / 3, 0, 2 / 3, 0], [0, 1 / 3, 0, 2 / 3]])
    np.testing.assert_allclose(per_layer.mean(axis=0), vector)
    assert roles.tolist() == [0, 0, 1, 1]


def test_reduction_when_steps_differ_from_request_rejected():
    # Given
    arrays = {"key_attention": np.full((1, 1, 2, 2), 0.5, np.float32),
              "query_groups": np.array([[0, 1], [1, 2]], np.int32), "key_role": np.array([0, 0])}
    meta = {"schema_version": bridge.ADAPTER_SCHEMA, "axes": {"layer": {"size": 1}, "query_group": {"horizon": 2}},
            "token_layout": {"roles": ["instruction"]}}
    # When / Then
    with pytest.raises(bridge.DiagnosticError):
        bridge.reduce_attention(arrays, meta, 2)


@pytest.mark.parametrize("resolved", [True, False])
def test_video_frame_when_letterbox_follows_geometry(capture, resolved):
    # Given
    arrays, meta, raw, request = capture
    if not resolved:
        meta["cameras"][0].update(geometry_resolved=False, transform=None)
    roles = np.array([0, 0, 1, 2, 3, 3, 3])
    vector = np.array([0.3, 0.2, 0.1, 0.1, 0.1, 0.1, 0.1])
    per_layer = np.stack([vector * 0.5 + 0.05, vector * 1.5 - 0.05])
    layout = bridge.video_layout(arrays, meta, roles, raw, request)
    # When
    frame = bridge.video_frame(vector, per_layer, layout, raw, {**request, "frame": 3, "timestampSeconds": 0.3})
    # Then
    restored = np.frombuffer(base64.b64decode(frame["maps"][0]["valuesF32LE"]), dtype="<f4")
    np.testing.assert_array_equal(restored, np.array([0.3, 0.2], np.float32))
    layers = np.frombuffer(base64.b64decode(frame["maps"][0]["layersF16LE"]), dtype="<f2").reshape(2, 2)
    np.testing.assert_array_equal(layers, per_layer[:, 0:2].astype(np.float16))
    assert frame["maps"][0]["letterboxMass"] == (pytest.approx(0.2) if resolved else None)
    assert layout["cameras"][0][0]["patchValidFraction"] == ([1.0, 0.0] if resolved else None)
    assert [m["groupId"] for m in frame["masses"]] == ["camera:base_0_rgb", "instruction", "padding", "action"]
    assert sum(m["value"] for m in frame["masses"]) == pytest.approx(1)
    assert frame["images"][0]["preprocessing"] is (None if not resolved else frame["images"][0]["preprocessing"])


def test_thumbnail_when_downscaled_affine_maps_thumbnail_pixels_to_model_input():
    # Given: 640x480 source letterboxed into 224x224 (resized 224x168, offset y=28).
    camera = {"dataset_key": "observation.images.front", "model_key": "base_0_rgb", "geometry_resolved": True,
              "transform": {"model_input_hw": [224, 224], "scale_hw": [0.35, 0.35], "offset_hw": [28, 0],
                            "resized_hw": [168, 224], "original_hw": [480, 640],
                            "flips": {"horizontal": False, "vertical": False, "transposed": False}}}
    raw = {"observation.images.front": np.full((480, 640, 3), 128, np.uint8)}
    # When
    image = bridge.thumbnail_image(camera, raw, {"timestampSeconds": 1.5})
    # Then
    assert (image["width"], image["height"], image["mime"]) == (320, 240, "image/jpeg")
    payload = base64.b64decode(image["dataBase64"])
    assert payload[:3] == b"\xff\xd8\xff"
    assert image["sha256"] == hashlib.sha256(payload).hexdigest()
    a, b, c, d, e, f = image["preprocessing"]["sourceToInput"]
    assert (a * 320 + c * 240 + e, b * 320 + d * 240 + f) == pytest.approx((224, 196))
    assert image["preprocessing"]["contentRect"] == [0, 28, 224, 168]
    assert image["geometryResolved"] is True


def test_thumbnail_when_small_source_is_not_upscaled(capture):
    # Given
    _, meta, raw, request = capture
    # When
    image = bridge.thumbnail_image(meta["cameras"][0], raw, request)
    # Then
    assert (image["width"], image["height"]) == (4, 2)
    assert image["preprocessing"]["sourceToInput"] == bridge.preprocessing(meta["cameras"][0])["sourceToInput"]


def test_capture_video_when_real_score_frames_collects_every_third_frame_once(capture, capsys):
    # Given: actual worker score_frames and OpenPi transforms, no model.
    from openpi import transforms
    arrays, meta, raw, request = video_capture_inputs(capture)
    with (ROOT / "worker.py").open() as stream:
        runtime = bridge.worker_runtime(stream.read())
    collected = []
    class Dataset:
        meta = SimpleNamespace(tasks={0: "task"}, features={}, fps=10)
        def __getitem__(self, index):
            frame = index - 2
            return {**raw, "episode_index": 2, "frame_index": frame, "task_index": 0,
                    "state": np.array([1, 2]), "action": np.ones((3, 2)),
                    "action_is_pad": np.arange(3) >= 7 - frame}
    def collect(policy, observation, **kwargs):
        collected.append(kwargs["run_info"]["frame"])
        assert kwargs["compare_with_infer"] is False and "reference_actions" not in kwargs
        return {"arrays": arrays, "metadata": meta}
    adapter = SimpleNamespace(collect_action_image_attention=collect, dataset_key_map_from_repack=lambda group: {})
    data = SimpleNamespace(repack_transforms=transforms.Group(inputs=[
        transforms.RepackTransform({"state": "state", "actions": "action", "prompt": "prompt"})]),
        data_transforms=transforms.Group(), action_sequence_keys=("action",), prompt_from_task=True)
    model = SimpleNamespace(action_horizon=3, action_dim=2)
    metadata = {"episodes": [{"index": 0, "length": 2}, {"index": 2, "length": 7}]}
    policy = SimpleNamespace(infer=lambda *args, **kwargs: pytest.fail("ordinary infer must not run"))
    # When
    video = bridge.capture_video(runtime, adapter, Dataset(), policy, data, model, request, metadata, "sha")
    # Then
    assert collected == [0, 3, 6]
    assert [f["frame"] for f in video["frames"]] == [0, 3, 6]
    assert [f["timestampSeconds"] for f in video["frames"]] == pytest.approx([0, 0.3, 0.6])
    assert video["selection"] == {"stepIndex": 1, "layers": "all", "queries": "all", "stride": 3, "layerCount": 2}
    assert all("layersF16LE" in m for f in video["frames"] for m in f["maps"])
    assert (video["episodeLength"], video["fps"], video["timing"]["frames"]) == (7, 10.0, 3)
    assert video["cameras"][0]["role"] == "front"
    np.testing.assert_allclose(np.frombuffer(base64.b64decode(video["frames"][0]["maps"][0]["valuesF32LE"]), "<f4"),
                               [0.4, 0.1])
    messages = [json.loads(line.removeprefix(bridge.PREFIX))["message"]
                for line in capsys.readouterr().out.splitlines() if line.startswith(bridge.PREFIX)]
    assert messages == ["attention video frame 3/3"]
    json.dumps(video, allow_nan=False)


def test_runtime_video_when_low_memory_executes_no_model_sources(capture, monkeypatch, capsys):
    # Given
    request = video_capture_inputs(capture)[3]
    source = "raise AssertionError('model source executed')"
    request["adapterSha256"] = hashlib.sha256(source.encode()).hexdigest()
    monkeypatch.setattr(bridge, "install_lifecycle", lambda: None)
    monkeypatch.setattr(bridge.subprocess, "run",
                        lambda *args, **kwargs: SimpleNamespace(stdout="0, GPU-test, 20479\n"))
    # When
    code = bridge.runtime_video_main(request, source, source)
    # Then
    assert code == 1
    events = [json.loads(line.removeprefix(bridge.PREFIX)) for line in capsys.readouterr().out.splitlines()]
    assert events[0]["type"] == "started"
    assert events[-1]["status"] == "blocked"


def test_runtime_when_requested_backend_differs_from_checkpoint_fails(capture, monkeypatch, capsys):
    # Given a JAX-format checkpoint path but a PyTorch backend request
    request = capture[3]
    request["backend"] = "pytorch"
    monkeypatch.setattr(bridge, "install_lifecycle", lambda: None)
    monkeypatch.setattr(bridge, "gpu_preflight", lambda *args: pytest.fail("GPU preflight must not run"))
    # When
    code = bridge.runtime_main(request, "", "adapter")
    # Then
    assert code == 1
    assert json.loads(capsys.readouterr().out.splitlines()[-1].removeprefix(bridge.PREFIX))["status"] == "failed"


def test_runtime_video_when_pytorch_adapter_missing_unsupported_before_preflight(capture, monkeypatch, capsys, tmp_path):
    # Given a PyTorch checkpoint but no PyTorch adapter source
    request = video_capture_inputs(capture)[3]
    (tmp_path / "model.safetensors").write_bytes(b"")
    request["checkpoint"] = str(tmp_path)
    monkeypatch.setattr(bridge, "install_lifecycle", lambda: None)
    monkeypatch.setattr(bridge, "gpu_preflight", lambda *args: pytest.fail("GPU preflight must not run"))
    # When
    code = bridge.runtime_video_main(request, "", "")
    # Then
    assert code == 1
    assert json.loads(capsys.readouterr().out.splitlines()[-1].removeprefix(bridge.PREFIX))["status"] == "unsupported"
