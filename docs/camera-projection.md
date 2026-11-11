# Saved trajectory projection

Pre-release can load front RGB and project both saved action chunks without
executing a model. `POST /api/jobs/{id}/projection` with `{episode,frame}` uses the
saved host/repository/dataset and CPU-only LeRobot decoding. GET and changing a
display option never launch a model. The request owns the existing diagnostic
reservation until the reader exits and publication finishes. Cancel/frame change
aborts the reader; failures leave the previous artifact intact.

Projection attaches to the existing diagnostic sidecar without replacing attention
arrays, metadata or differences. Attention recapture likewise retains compatible
projection metadata. Projection-only packets contain original RGB, no attention,
backend `none`, and no inference timing. Storage accounting/deletion already own
the same canonical sidecar.

## Operational calibration and limitations

The server owns an explicit list of source bindings under the same rig
calibration, and the UI consumes that list rather than duplicating a single-path
restriction. Both the existing `derived/JIMTOF_1014_trim--12501198` and the source
`raw/hf/rainbowrobotics/JIMTOF_real_20261014_132034/revisions/8d3534c7602129ffd18794425546df39fa98c0ab`
(beneath `/mnt/datasetui-nas/DatasetUI`) are connected. The chosen source
provenance is displayed and retained in projection pose evidence.

Verified read-only through DatasetUI on 2026-10-15:
- Raw registry ID `0e047918-7a07-4633-9c46-e123b1eeefeb`, display name
  `JIMTOF_final_14`, exact revision path above, fingerprint
  `9cbc382ecb7c32273ff6f471b6648dd34fdabe93c88db91e2a22c1c2805ec022`.
- Curation job `7c52dee0-4b71-4273-90ec-e0852d66b600` consumes that raw ID
  and fingerprint, producing dataset `c8f61763-d747-4ba9-be45-3ccb1fa39413`.
- Merge `bc6fbbe4-039f-4d01-b815-3bd70308d042` includes that output;
  its EP19 maps to merged EP720 with length1137, before trim job12501198.
- The preserved JIMTOF collection configuration identifies front D405
  `315122271025`, 640x480 and fixed READY_HEAD `[0,49]` degrees.

This is inherited operational calibration, not a fresh physical measurement.
Different revisions, similarly named datasets and other rigs are not implicitly
accepted; they need their own verified binding or diagnostic packet. A matching
camera size/name is not evidence that the calibration applies.

Source: DatasetUI calibration `01339638-8aca-4c65-9cf7-eb22036fc9c5`,
SHA-verified record
`f1398d0f97fd3ca1e09c76af93dd4d57ed9b3f5088867e18264572570e81b982`.
Retrieved read-only from the RTX6000 DatasetUI API with profile
`5d234fbd-9beb-40da-a08b-70f7fcbe03ce`. It was fitted to another segmentation
dataset's video, not independently calibrated on all 799 target episodes.

The complete-precision front transform in `src/projection-calibration.ts` maps
optical coordinates into `link_head_2`. It uses the operational translation
`[0.038,0.0009375,0.066]`, not the rounded value from earlier notes.
Head-relative FK is composed with this transform, then inverted exactly once.

Robot source: `VLA/robot-masks/urdf/model_v1.2_high_speed_gripper.urdf`,
SHA256 `a5659c63205e86a8d9fb29cfc1b9c3d0160e36cf45db6a37c97adfb8f4e1ce24`.
Generic M v1.2 is not substituted. TCPs are `ee_left` and `ee_right`, whose fixed
flange offset is `[0,0,-0.1261]` meters. This is not the collection's optional EE
mode flange coordinate definition.

The current collection records arm/gripper states but no per-frame head/torso.
`READY_HEAD=[0,49]` degrees agrees with the fit's declared fixed head setting:
`demos/JIMTOF/upc_backup_20261014/rby1-lerobot/lerobot-robot-rby1/lerobot_robot_rby1/config_rby1.py`.
Thus pose evidence is explicitly `declared_fixed`, never `recorded`.
Arm and head share `link_torso_5`, so the common torso transform cancels.
The camera/torso are held at the anchor while the stored future chunk is drawn.

D405 front serial 315122271025 has fx=390.557, fy=390.009, cx=319.882,
cy=242.324 at 640x480. Its reported distortion model is Inverse Brown Conrady,
but coefficients were not retained. The operational renderer uses a pinhole
with mean focal length 390.283 and no distortion; this integration reproduces
that **approximation**, not a claim that physical distortion is zero.
Changing the physical head angle or rig requires new evidence/calibration.

## Source semantics

Current JIMTOF action is absolute joint targets in radians, right seven then
left seven plus grippers. Evidence is the collection leader's direct joint
output and command builder's joint-position dispatch, and trim provenance with
relative action disabled. Names establish mapping, not semantics on their own.
The runtime verifies current raw action/channel identity against the saved
anchor target before attaching its video.

Predicted solid paths and dashed GT paths are FK of saved target commands.
GT is not measured hand motion. Source validity masks, out-of-image points and
behind-camera points remain gaps; paths never interpolate across them.
If a computed chunk has no visible TCP points, the UI reports the out-of-image
count and other exclusions instead of presenting an unexplained empty overlay.
