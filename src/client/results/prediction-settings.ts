import { predictionSeedSchema, predictionSourceSchema } from "../analysis/prediction-contracts";
import type { PredictionSeed, PredictionSource } from "../analysis/prediction-contracts";

export type PredictionSettingsValue = {
  readonly kind: "unknown" | "joint" | "cartesian";
  readonly unit: "unknown" | "rad" | "deg";
  readonly representation: "unknown" | "absolute" | "delta" | "velocity";
  readonly positionUnit: "" | "m" | "mm";
  readonly orientation: "" | "rpy_xyz" | "quaternion_xyzw";
  readonly angleUnit: "" | "rad" | "deg";
  readonly referenceFrame: string;
  readonly left: readonly (number | null)[];
  readonly right: readonly (number | null)[];
  readonly leftGripper: number | null;
  readonly rightGripper: number | null;
  readonly profileHash: string;
  readonly confirmed: boolean;
  readonly seedKind: "manual" | "observed";
  readonly seedUnit: "" | "rad" | "deg";
  readonly leftSeed: string;
  readonly rightSeed: string;
};

/** Names establish column identity only, never angular units or absolute/delta semantics. */
export function matchingColumns(names: readonly string[], kind: PredictionSettingsValue["kind"], orientation: PredictionSettingsValue["orientation"]) {
  const find = (name: string) => {
    const index = names.indexOf(name);
    return index >= 0 && names.lastIndexOf(name) === index ? index : null;
  };
  const axes = kind === "cartesian"
    ? ["x", "y", "z", ...(orientation === "quaternion_xyzw" ? ["qx", "qy", "qz", "qw"] : ["rx", "ry", "rz"])]
    : Array.from({ length: 7 }, (_, index) => `arm_${index}`);
  return {
    left: axes.map((axis) => find(`left_${axis}`)), right: axes.map((axis) => find(`right_${axis}`)),
    leftGripper: find("left_gripper_0") ?? find("left_gripper"),
    rightGripper: find("right_gripper_0") ?? find("right_gripper"),
  };
}

export function initialPredictionSettings(names: readonly string[], observations?: { readonly unit: "rad" | "deg" | null; readonly samples: readonly unknown[] }): PredictionSettingsValue {
  const mapping = matchingColumns(names, "joint", "");
  return {
    kind: [...mapping.left, ...mapping.right].every((index) => index !== null) ? "joint" : "unknown",
    ...mapping, unit: "unknown", representation: "unknown", positionUnit: "", orientation: "", angleUnit: "",
    referenceFrame: "unknown", profileHash: "", confirmed: false, seedKind: observations?.samples.length ? "observed" : "manual",
    seedUnit: observations?.unit ?? "", leftSeed: "", rightSeed: "",
  };
}

export function declaredPredictionSource(value: PredictionSettingsValue): { source: PredictionSource | null; error: string } {
  let raw: unknown;
  switch (value.kind) {
    case "unknown": return { source: null, error: "원본 데이터의 Joint / Cartesian 형식을 선택하세요." };
    case "joint":
      raw = { kind: "joint", unit: value.unit, representation: value.representation,
        nominalSignZeroConfirmed: value.confirmed,
        left: { joints: value.left, gripper: value.leftGripper }, right: { joints: value.right, gripper: value.rightGripper } };
      break;
    case "cartesian":
      raw = { kind: "cartesian", positionUnit: value.positionUnit,
        orientation: value.orientation === "quaternion_xyzw" ? { kind: value.orientation }
          : { kind: value.orientation, unit: value.angleUnit },
        referenceFrame: value.referenceFrame, representation: value.representation, nominalSignZeroConfirmed: value.confirmed,
        left: { position: value.left.slice(0, 3), rotation: value.left.slice(3), gripper: value.leftGripper },
        right: { position: value.right.slice(0, 3), rotation: value.right.slice(3), gripper: value.rightGripper } };
      break;
    default: { const exhaustive: never = value.kind; return exhaustive; }
  }
  const parsed = predictionSourceSchema.safeParse(raw);
  return parsed.success ? { source: parsed.data, error: "" }
    : { source: null, error: "원본 채널 연결과 단위·회전 표현을 모두 지정하세요." };
}

export function declaredPredictionSeed(value: PredictionSettingsValue, observations: readonly { readonly frame: number; readonly positions: readonly number[] }[]): PredictionSeed | null {
  const parse = (text: string) => text.trim() ? text.trim().split(/[\s,]+/).map(Number) : [];
  const raw = value.seedKind === "manual"
    ? { kind: "manual", unit: value.seedUnit, positions: [...parse(value.leftSeed), ...parse(value.rightSeed)] }
    : { kind: "observed", unit: value.seedUnit, samples: observations };
  if (value.seedKind === "manual" && (parse(value.leftSeed).length !== 7 || parse(value.rightSeed).length !== 7)) return null;
  if (value.seedKind === "observed" && observations.length === 0) return null;
  const parsed = predictionSeedSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}
