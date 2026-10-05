#!/usr/bin/env python3
# /// script
# requires-python = ">=3.13"
# dependencies = ["rby1-sdk==0.10.0"]
# ///
#
# Usage: /home/kgs/miniforge3/bin/python3 tests/kinematics/sdk_oracle.py \
#   --seed 20261004 --out .omo/evidence/redesign/sdk-golden.json
# This uses the already-installed offline SDK; it does not provision dependencies.

from __future__ import annotations

import argparse
import hashlib
import json
import random
from pathlib import Path

import numpy as np
import rby1_sdk

ASSET_ROOT = Path("/home/kgs/workspace/sdk-tools/rby1-pose-studio/assets/models")
PROFILE_FILES = (
    ("RBY1_A", "v1.1", "rby1a/urdf/model_v1.1.urdf"),
    ("RBY1_A", "v1.2", "rby1a/urdf/model_v1.2.urdf"),
    ("RBY1_M", "v1.1", "rby1m/urdf/model_v1.1.urdf"),
    ("RBY1_M", "v1.2", "rby1m/urdf/model_v1.2.urdf"),
)
ARM_JOINTS = tuple(f"{side}_arm_{index}" for side in ("right", "left") for index in range(7))
TORSO_JOINTS = tuple(f"torso_{index}" for index in range(6))
ROOT_LINK = "link_torso_5"
TIP_LINKS = {"right": "ee_right", "left": "ee_left"}


def scenarios(seed: int) -> list[dict[str, object]]:
    zero = {joint: 0.0 for joint in ARM_JOINTS}
    cases: list[dict[str, object]] = [
        {"id": "zero", "kind": "zero", "jointsRadians": zero, "torsoRadians": {}},
    ]
    for joint in ARM_JOINTS:
        cases.append({
            "id": f"joint-{joint}-plus-0.1",
            "kind": "single-joint",
            "jointsRadians": {**zero, joint: 0.1},
            "torsoRadians": {},
        })

    generator = random.Random(seed)
    asymmetric: list[dict[str, float]] = []
    for index in range(30):
        values = {joint: generator.uniform(-0.8, 0.8) for joint in ARM_JOINTS}
        asymmetric.append(values)
        cases.append({
            "id": f"asymmetric-{index:02d}",
            "kind": "asymmetric",
            "jointsRadians": values,
            "torsoRadians": {},
        })

    torso_configs = (
        (0.12, -0.23, 0.34, -0.45, 0.56, -0.67),
        (-0.31, 0.42, -0.53, 0.64, -0.75, 0.21),
    )
    for index, values in enumerate(torso_configs):
        cases.append({
            "id": f"torso-{index}",
            "kind": "torso",
            "jointsRadians": asymmetric[0],
            "torsoRadians": dict(zip(TORSO_JOINTS, values, strict=True)),
        })
    return cases


def make_robot(urdf_path: Path) -> tuple[object, list[str], list[str]]:
    configuration = rby1_sdk.dynamics.load_robot_from_urdf(str(urdf_path), "base")
    failures: list[str] = []
    for class_name in ("Robot_24", "Robot_26", "Robot_18"):
        robot_class = getattr(rby1_sdk.dynamics, class_name, None)
        if robot_class is None:
            continue
        try:
            robot = robot_class(configuration)
            return robot, list(robot.get_link_names()), list(robot.get_joint_names())
        except Exception as error:
            failures.append(f"{class_name}: {error}")
    raise RuntimeError(f"SDK could not construct a robot from {urdf_path}: {failures}")


def main() -> None:
    parser = argparse.ArgumentParser(description="Generate offline rby1_sdk absolute FK matrices.")
    parser.add_argument("--seed", required=True, type=int)
    parser.add_argument("--out", required=True, type=Path)
    parser.add_argument("--asset-root", type=Path, default=ASSET_ROOT)
    args = parser.parse_args()

    cases = scenarios(args.seed)
    profiles: list[dict[str, object]] = []
    for model, revision, relative_path in PROFILE_FILES:
        urdf_path = args.asset_root / relative_path
        if not urdf_path.is_file():
            raise FileNotFoundError(f"Required offline SDK asset is missing: {urdf_path}")
        source_bytes = urdf_path.read_bytes()
        digest = hashlib.sha256(source_bytes).hexdigest()
        robot, links, joint_names = make_robot(urdf_path)
        link_indices = {name: index for index, name in enumerate(links)}
        joint_indices = {name: index for index, name in enumerate(joint_names)}
        missing_links = {ROOT_LINK, *TIP_LINKS.values()} - link_indices.keys()
        missing_joints = set((*ARM_JOINTS, *TORSO_JOINTS)) - joint_indices.keys()
        if missing_links or missing_joints:
            raise RuntimeError(
                f"SDK model {model} {revision} lacks names: "
                f"links={sorted(missing_links)} joints={sorted(missing_joints)}"
            )
        state = robot.make_state(links, joint_names)
        profile_cases: list[dict[str, object]] = []
        for case in cases:
            positions = np.zeros(len(joint_names), dtype=np.float64)
            for joint, value in {**case["jointsRadians"], **case["torsoRadians"]}.items():
                positions[joint_indices[joint]] = value
            state.set_q(positions)
            robot.compute_forward_kinematics(state)
            poses = {
                side: robot.compute_transformation(
                    state, link_indices[ROOT_LINK], link_indices[tip]
                ).tolist()
                for side, tip in TIP_LINKS.items()
            }
            profile_cases.append({**case, "absoluteMatrices": poses})
        profiles.append({
            "model": model,
            "revision": revision,
            "sourcePath": str(urdf_path),
            "urdfSha256": digest,
            "rootLink": ROOT_LINK,
            "tips": TIP_LINKS,
            "sdkRobotClass": type(robot).__name__,
            "scenarios": profile_cases,
        })

    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps({
        "schemaVersion": 1,
        "seed": args.seed,
        "sdkVersion": rby1_sdk.__version__,
        "units": {"joints": "rad", "translation": "m"},
        "profiles": profiles,
    }, indent=2) + "\n")
    print(f"Generated {len(profiles)} profiles × {len(cases)} scenarios × 2 absolute SDK matrices")


if __name__ == "__main__":
    main()
