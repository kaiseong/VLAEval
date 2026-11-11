"""CPU regressions for raw, named joint observations at scored anchors."""
from types import SimpleNamespace

import numpy as np
import pytest

from test_worker import runtime, scoring_objects


JOINT_NAMES = [f"{side}_arm_{i}" for side in ("left", "right") for i in range(7)]
STATE_NAMES = ["torso_0", *reversed(JOINT_NAMES), "head_0", "left_gripper"]


@pytest.fixture
def joint_scoring(scoring_objects):
    dataset, policy, data, model, request, episodes = scoring_objects

    class ObservedDataset:
        def __init__(self):
            self.meta = SimpleNamespace(
                tasks=dataset.meta.tasks,
                features={**dataset.meta.features, "observation.state": {"names": STATE_NAMES, "unit": "rad"}},
            )
            self.rows = {i: np.arange(len(STATE_NAMES), dtype=float) + i * 1000 for i in range(6)}

        def __getitem__(self, index):
            raw = dataset[index]
            if index in self.rows:
                raw["observation.state"] = self.rows[index]
            return raw

    return ObservedDataset(), policy, data, model, request, episodes


def test_capture_when_columns_reordered_preserves_raw_values_before_transforms(joint_scoring):
    # Given
    from openpi import transforms

    dataset, policy, data, model, request, episodes = joint_scoring

    def change_state(raw):
        raw["observation.state"][:] = -999
        return raw

    data.repack_transforms = transforms.Group(
        inputs=[change_state, *data.repack_transforms.inputs],
        outputs=data.repack_transforms.outputs,
    )
    # When
    result = runtime["score_frames"](dataset, policy, data, model, request, episodes)
    # Then
    assert result["jointObservations"] == {
        "names": JOINT_NAMES,
        "unit": "rad",
        "samples": [
            {"episode": episode, "frame": frame, "positions": [index * 1000 + i for i in range(14, 0, -1)]}
            for index, episode, frame in [(0, 0, 0), (1, 0, 1), (3, 2, 0), (4, 2, 1), (5, 2, 2)]
        ],
    }
    assert result["firstStepMae"] == 0.75
    assert result["traces"][1]["target"][0] == [210, 0.25]


@pytest.mark.parametrize("unit", ["rad", "deg", None, "radians", "degrees", "RAD", "", ["rad"]])
def test_capture_when_unit_declared_copies_only_exact_recognized_units(joint_scoring, unit):
    # Given
    dataset, policy, data, model, request, episodes = joint_scoring
    feature = dataset.meta.features["observation.state"]
    feature.pop("unit")
    if unit is not None:
        feature["unit"] = unit
    # When
    result = runtime["score_frames"](dataset, policy, data, model, request, episodes)
    # Then
    assert result["jointObservations"]["unit"] == (unit if unit in ("rad", "deg") else None)
    assert result["jointObservations"]["samples"][0]["positions"] == list(range(14, 0, -1))


@pytest.mark.parametrize("feature", [
    None,
    {},
    {"names": None},
    {"names": {"joints": JOINT_NAMES}},
    {"names": tuple(JOINT_NAMES)},
    {"names": JOINT_NAMES[:-1]},
    {"names": [*JOINT_NAMES, JOINT_NAMES[0]]},
    {"names": [*JOINT_NAMES, None]},
    {"names": [name.upper() for name in JOINT_NAMES]},
])
def test_capture_when_metadata_invalid_omits_observations_without_changing_scoring(joint_scoring, feature):
    # Given
    dataset, policy, data, model, request, episodes = joint_scoring
    if feature is None:
        dataset.meta.features.pop("observation.state")
    else:
        dataset.meta.features["observation.state"] = feature
    # When
    result = runtime["score_frames"](dataset, policy, data, model, request, episodes)
    # Then
    assert "jointObservations" not in result
    assert result["framesEvaluated"] == 5
    assert result["validSteps"] == 9
    assert result["firstStepMae"] == 0.75


@pytest.mark.parametrize("row", [
    None, [np.nan] * 17, [np.inf] * 17, [-np.inf] * 17,
    np.zeros((1, 17)), np.zeros(16), np.zeros(18),
    [["ragged"], []], ["not numeric"] * 17,
    [np.nan, *range(16)],  # Invalid extra columns also invalidate the raw row.
])
def test_capture_when_rows_invalid_omits_observations_and_preserves_evaluation(joint_scoring, row):
    # Given
    dataset, policy, data, model, request, episodes = joint_scoring
    dataset.rows = dict.fromkeys(range(6), row)
    # When
    result = runtime["score_frames"](dataset, policy, data, model, request, episodes)
    # Then
    assert "jointObservations" not in result
    assert result["framesEvaluated"] == 5
    assert result["firstStepMae"] == 0.75


def test_capture_when_state_absent_does_not_substitute_actions_or_other_state(joint_scoring):
    # Given: the existing policy still receives valid "state" and "action" columns.
    dataset, policy, data, model, request, episodes = joint_scoring
    dataset.rows.clear()
    # When
    result = runtime["score_frames"](dataset, policy, data, model, request, episodes)
    # Then
    assert "jointObservations" not in result
    assert result["validSteps"] == 9


def test_capture_when_subset_has_missing_rows_keeps_episode_frame_alignment(joint_scoring):
    # Given
    dataset, policy, data, model, request, episodes = joint_scoring
    request.update(stride=2, maxSamples=3)
    dataset.rows.pop(0)
    dataset.rows[5][4] = np.nan
    # When
    result = runtime["score_frames"](dataset, policy, data, model, request, episodes)
    # Then
    assert [(sample["episode"], sample["frame"]) for sample in result["samples"]] == [(0, 0), (2, 0), (2, 2)]
    assert result["jointObservations"]["samples"] == [
        {"episode": 2, "frame": 0, "positions": list(range(3014, 3000, -1))},
    ]
