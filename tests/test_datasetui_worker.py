"""Deterministic, CPU-only tests for read-only DatasetUI registry discovery."""
from __future__ import annotations

import base64
import importlib.util
import io
import json
from pathlib import Path
import subprocess
import sys
from types import SimpleNamespace
import urllib.error
import urllib.parse

import pytest

WORKER = Path(__file__).resolve().parents[1] / "worker.py"
spec = importlib.util.spec_from_file_location("datasetui_worker_tests", WORKER)
worker = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = worker
spec.loader.exec_module(worker)


def request(**fields):
    raw = {"operation": "datasetui", **fields}
    return worker.Request.decode(base64.b64encode(json.dumps(raw).encode()).decode())


def row(identifier="dataset", **fields):
    return {
        "id": identifier, "storage_area": "raw", "relative_path": identifier,
        "name": f"Dataset {identifier}", "codebase_version": "v3.0",
        "readiness": "ready", "available": True, "total_episodes": 3,
        "total_frames": 20, "fps": 10.5, **fields,
    }


def provision(root):
    (root / "meta").mkdir(parents=True)
    (root / "meta/info.json").write_text('{"codebase_version":"v3.0"}')
    return root


@pytest.fixture
def transport(monkeypatch, tmp_path):
    state = SimpleNamespace(
        mounts=[{"Type": "bind", "Source": str(tmp_path), "Destination": "/registry/raw"}],
        networks={"empty": {"IPAddress": ""}, "test": {"IPAddress": "172.23.0.8"}},
        pages={0: []}, commands=[], urls=[], running=True, failed_addresses=set(),
    )

    def inspect(command, **options):
        state.commands.append((command, options))
        output = (json.dumps(state.mounts) + "\n" + json.dumps(state.networks)
                  if state.running else "")
        return subprocess.CompletedProcess(command, 0, stdout=output, stderr="")

    class Opener:
        def open(self, url, *, timeout):
            state.urls.append((url, timeout))
            parsed = urllib.parse.urlparse(url)
            if parsed.hostname in state.failed_addresses:
                raise urllib.error.URLError("unreachable")
            query = urllib.parse.parse_qs(parsed.query)
            assert parsed.path == "/api/v1/datasets"
            assert query["readiness"] == ["ready"]
            assert query["include_missing"] == ["false"]
            assert query["limit"] == ["500"]
            return io.StringIO(json.dumps(state.pages[int(query["offset"][0])]))

    monkeypatch.setattr(worker.subprocess, "run", inspect)
    monkeypatch.setattr(worker.urllib.request, "build_opener", lambda *handlers: Opener())
    return state


def test_request_when_defaults_preserves_old_constructors():
    # Given / When
    parsed = request()
    old = worker.Request("discover", "", (), "", "", "", (), 0, 1, 0, 10)
    # Then
    assert parsed.datasetui_container == old.datasetui_container == "datasetui-api-1"
    assert parsed.datasetui_root == old.datasetui_root == "/mnt/datasetui-nas/DatasetUI"


def test_request_when_overrides_roundtrips():
    # Given
    parsed = request(datasetuiContainer="api.test-2", datasetuiRoot="/custom/registry")
    # When
    restored = worker.Request.decode(parsed.encoded())
    # Then
    assert restored == parsed


@pytest.mark.parametrize("fields", [
    {"datasetuiContainer": "-api"}, {"datasetuiContainer": "api;id"},
    {"datasetuiContainer": "api/name"}, {"datasetuiContainer": ""},
    {"datasetuiContainer": None}, {"datasetuiRoot": "relative"},
    {"datasetuiRoot": "/root/../secret"}, {"datasetuiRoot": None},
])
def test_request_when_invalid_rejects(fields):
    # Given / When / Then
    with pytest.raises(worker.WorkerError):
        request(**fields)


def test_listing_when_paginated_maps_all_rows(tmp_path, transport):
    # Given
    provision(tmp_path / "dataset")
    provision(tmp_path / "last")
    transport.pages = {0: [row(str(i), relative_path="dataset") for i in range(500)],
                       500: [row("last", total_episodes=None, total_frames=None, fps=None,
                                 codebase_version=None)]}
    # When
    result = worker.datasetui(request(datasetuiRoot="/registry"))
    # Then
    assert len(result["datasets"]) == 501
    assert result["warnings"] == []
    assert result["datasets"][-1] == {
        "id": "last", "path": str(tmp_path / "last"), "name": "Dataset last",
        "storageArea": "raw", "episodes": None, "frames": None, "fps": None, "version": None,
    }
    assert [urllib.parse.parse_qs(urllib.parse.urlparse(url).query)["offset"]
            for url, _ in transport.urls] == [["0"], ["500"]]
    assert all(timeout == 10 for _, timeout in transport.urls)


def test_listing_when_nested_mount_uses_longest_destination(tmp_path, transport):
    # Given
    nested = provision(tmp_path / "alternate")
    transport.mounts.append({"Type": "bind", "Source": str(nested),
                             "Destination": "/registry/derived/team/data"})
    transport.mounts.append({"Type": "bind", "Source": str(tmp_path / "wrong"),
                             "Destination": "/registry/derived"})
    transport.pages[0] = [row(storage_area="derived", relative_path="team/data")]
    # When
    result = worker.datasetui(request(datasetuiRoot="/registry"))
    # Then
    assert result["datasets"][0]["path"] == str(nested)
    assert result["datasets"][0]["storageArea"] == "derived"
    assert result["warnings"] == []


@pytest.mark.parametrize("relative", ["/absolute", "../escape", "a/../../escape", "a/../dataset",
                                     "\\escape", "a\0b"])
def test_listing_when_path_invalid_skips_with_warning(relative, transport):
    # Given
    transport.pages[0] = [row(relative_path=relative)]
    # When
    result = worker.datasetui(request(datasetuiRoot="/registry"))
    # Then
    assert result["datasets"] == []
    assert len(result["warnings"]) == 1


@pytest.mark.parametrize("fields", [
    {"available": False}, {"readiness": "incomplete"}, {"readiness": "unsupported"},
    {"codebase_version": "v9.0"}, {"storage_area": "other"},
    {"storage_area": "derived"}, {"relative_path": "missing"},
])
def test_listing_when_unusable_skips_without_fabricated_path(fields, transport):
    # Given
    transport.pages[0] = [row(**fields)]
    # When
    result = worker.datasetui(request(datasetuiRoot="/registry"))
    # Then
    assert result["datasets"] == []
    assert len(result["warnings"]) == 1
    assert "dataset" in result["warnings"][0]


@pytest.mark.parametrize("link_location", ["dataset", "meta", "info"])
def test_listing_when_symlink_escapes_rejects(tmp_path, transport, link_location):
    # Given
    outside = provision(tmp_path / "outside")
    if link_location == "dataset":
        (tmp_path / "dataset").symlink_to(outside, target_is_directory=True)
    else:
        dataset = tmp_path / "dataset"
        dataset.mkdir()
        if link_location == "meta":
            (dataset / "meta").symlink_to(outside / "meta", target_is_directory=True)
        else:
            (dataset / "meta").mkdir()
            (dataset / "meta/info.json").symlink_to(outside / "meta/info.json")
    transport.pages[0] = [row()]
    # When
    result = worker.datasetui(request(datasetuiRoot="/registry"))
    # Then
    assert result["datasets"] == []
    assert len(result["warnings"]) == 1


def test_listing_when_volume_overlay_never_uses_parent_bind(tmp_path, transport):
    # Given
    provision(tmp_path / "dataset")
    transport.mounts.append({"Type": "volume", "Source": "/volume",
                             "Destination": "/registry/raw/dataset"})
    transport.pages[0] = [row()]
    # When
    result = worker.datasetui(request(datasetuiRoot="/registry"))
    # Then
    assert result["datasets"] == []
    assert len(result["warnings"]) == 1


@pytest.mark.parametrize("contents", ["not json", "[]"])
def test_listing_when_metadata_invalid_skips(tmp_path, transport, contents):
    # Given
    provision(tmp_path / "dataset")
    (tmp_path / "dataset/meta/info.json").write_text(contents)
    transport.pages[0] = [row()]
    # When
    result = worker.datasetui(request(datasetuiRoot="/registry"))
    # Then
    assert result["datasets"] == []
    assert len(result["warnings"]) == 1


def test_listing_when_metadata_overlay_skips_stale_parent_file(tmp_path, transport):
    # Given
    provision(tmp_path / "dataset")
    transport.mounts.append({"Type": "bind", "Source": str(tmp_path / "missing-meta"),
                             "Destination": "/registry/raw/dataset/meta"})
    transport.pages[0] = [row()]
    # When
    result = worker.datasetui(request(datasetuiRoot="/registry"))
    # Then
    assert result["datasets"] == []
    assert len(result["warnings"]) == 1


def test_listing_when_first_network_unreachable_uses_available_ipv4(transport):
    # Given
    transport.networks = {"first": {"IPAddress": "172.23.0.7"},
                          "second": {"IPAddress": "172.23.0.9"}}
    transport.failed_addresses = {"172.23.0.7"}
    # When
    result = worker.datasetui(request(datasetuiRoot="/registry"))
    # Then
    assert result["warnings"] == []
    assert [urllib.parse.urlparse(url).hostname for url, _ in transport.urls] == [
        "172.23.0.7", "172.23.0.9"]


def test_listing_when_container_stopped_never_contacts_api(transport):
    # Given
    transport.running = False
    # When
    result = worker.datasetui(request())
    # Then
    assert result["datasets"] == []
    assert len(result["warnings"]) == 1
    assert transport.urls == []


def test_main_when_datasetui_dispatches_without_repo_or_secret_commands(transport, monkeypatch, capsys):
    # Given
    monkeypatch.setattr(worker, "parent_death_signal", lambda: None)
    monkeypatch.setattr(worker.signal, "signal", lambda *args: None)
    monkeypatch.setattr(sys, "argv", ["-", request().encoded()])
    # When
    exit_code = worker.main()
    # Then
    events = [json.loads(line.removeprefix(worker.PREFIX)) for line in capsys.readouterr().out.splitlines()]
    assert exit_code == 0
    assert [event["type"] for event in events] == ["started", "datasetui"]
    assert events[-1] == {"type": "datasetui", "datasets": [], "warnings": []}
    command, options = transport.commands[0]
    assert command == ["docker", "inspect", "--format",
                       "{{if .State.Running}}{{json .Mounts}}\n{{json .NetworkSettings.Networks}}{{end}}",
                       "datasetui-api-1"]
    assert options == {"capture_output": True, "text": True, "timeout": 10}
    assert len(transport.commands) == 1
