import { createHash } from "node:crypto";
import { cameraFromReference } from "./kinematics/camera-pose";
import { compileMountChain } from "./kinematics/urdf";
import { projectionInputSchema } from "./diagnostic-contracts";
import type { CompiledProfile } from "./kinematics/contracts";
import { JobError } from "./jobs";

/** Snapshot of DatasetUI's SHA-verified operational record, not a new physical calibration.
 * Collection: demos/JIMTOF/upc_backup_20261014/rby1-lerobot/
 * lerobot-robot-rby1/lerobot_robot_rby1/config_rby1.py READY_HEAD.
 * Its fixed head agrees with record.angles.head_deg; torso cancels in torso-relative FK.
 */
export const jimtofFrontCalibration = {
  id: "01339638-8aca-4c65-9cf7-eb22036fc9c5",
  recordSha256: "f1398d0f97fd3ca1e09c76af93dd4d57ed9b3f5088867e18264572570e81b982",
  urdfSha256: "a5659c63205e86a8d9fb29cfc1b9c3d0160e36cf45db6a37c97adfb8f4e1ce24",
  // Explicit source bindings share one rig calibration; never infer compatibility
  // from a JIMTOF name prefix, RGB dimensions or matching action column names.
  bindings: [
    {
      dataset: "/mnt/datasetui-nas/DatasetUI/derived/JIMTOF_1014_trim--12501198",
      label: "JIMTOF_1014 trim",
      provenance: "curation 12501198 ← merge bc6fbbe4 · absolute joint targets",
    },
    {
      dataset: "/mnt/datasetui-nas/DatasetUI/raw/hf/rainbowrobotics/JIMTOF_real_20261014_132034/revisions/8d3534c7602129ffd18794425546df39fa98c0ab",
      label: "JIMTOF 2026-10-14 13:20:34 원본 · 8d3534c7",
      provenance: "JIMTOF 수집 원본 → except 7c52dee0 → merge bc6fbbe4 → curation 12501198 · absolute joint targets",
    },
  ],
  datasetKey: "observation.images.front",
  label: "JIMTOF M v1.2 고속 그리퍼 · 운영 front 보정 01339638",
  description: "영상 정합 보정 · head [0°, 49°] 고정 설정(프레임별 측정값 아님) · 운영 renderer와 같은 평균 초점거리 pinhole 근사 · 렌즈 왜곡 미보정",
  width: 640, height: 480, fx: 390.557, fy: 390.009, cx: 319.882, cy: 242.324,
  mountFromOptical: [
    0.03271908282177614, -0.028342615125055152, 0.9990626395713008, 0.038,
    -0.9993123641786776, 0.0165176878864366, 0.03319585495974423, 0.0009375,
    -0.017443062200309434, -0.9994617862403541, -0.02778268212964464, 0.066,
    0, 0, 0, 1,
  ],
} as const;

export function jimtofProjection(
  xml: string, profile: CompiledProfile, actionNames: readonly string[], dataset: string,
) {
  const calibration = jimtofFrontCalibration;
  const binding = calibration.bindings.find((item) => item.dataset === dataset);
  if (!binding) throw new JobError("이 운영 보정의 로봇·수집 조건이 확인된 데이터셋이 아닙니다. 별도 보정 진단 JSON을 사용하세요.", 409);
  if (profile.urdfSha256 !== calibration.urdfSha256
    || createHash("sha256").update(xml).digest("hex") !== calibration.urdfSha256)
    throw new JobError("운영 보정과 고속 그리퍼 URDF 해시가 다릅니다.", 409);
  const index = (name: string) => {
    const column = actionNames.indexOf(name);
    if (column < 0 || actionNames.lastIndexOf(name) !== column) throw new JobError(`필수 관절 채널 누락/중복: ${name}`, 400);
    return column;
  };
  const mapping = (side: "left" | "right") => ({
    joints: Array.from({ length: 7 }, (_, i) => index(`${side}_arm_${i}`)),
    gripper: index(`${side}_gripper_0`),
  });
  const chain = compileMountChain(xml, "link_torso_5", "link_head_2");
  const transform = cameraFromReference(chain, new Map([["head_0", 0], ["head_1", 49 * Math.PI / 180]]),
    calibration.mountFromOptical);
  return projectionInputSchema.parse({
    modelKey: "base_0_rgb", referenceFrame: "link_torso_5",
    calibrationId: calibration.id, calibrationHash: calibration.recordSha256,
    poseEvidence: { kind: "declared_fixed", description: `${calibration.description} · 수집 연결: ${binding.label} · ${binding.provenance}` },
    assumption: "anchor_reference_fixed", profileHash: profile.profileHash,
    source: { kind: "joint", unit: "rad", representation: "absolute", nominalSignZeroConfirmed: true,
      left: mapping("left"), right: mapping("right") },
    camera: {
      width: calibration.width, height: calibration.height,
      fx: (calibration.fx + calibration.fy) / 2, fy: (calibration.fx + calibration.fy) / 2,
      cx: calibration.cx, cy: calibration.cy, distortion: { kind: "none" },
      cameraFromReference: Array.from(transform),
    },
  });
}
