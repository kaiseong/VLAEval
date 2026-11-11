import { forwardChain } from "../../kinematics/forward";
import { solveInverse } from "../../kinematics/inverse";
import { KinematicsError } from "../../kinematics/math";
import {
  predictionRequestSchema, predictionResultSchema,
  type PredictionData, type PredictionRequest, type PredictionResult,
} from "./prediction-contracts";
import { cartesianArm, finiteComponent, gripper, sourceValue, type Issue, type Side } from "./prediction-normalize";

const sides = ["left", "right"] as const;
type Row = (number | null)[];
type Previous = Record<Side, readonly number[] | null>;
const emptyPrevious = (): Previous => ({ left: null, right: null });

function mapData(request: PredictionRequest, convert: (row: number[], valid: boolean) => Row): PredictionData {
  return {
    series: { frames: request.series.frames, fps: request.series.fps,
      predicted: request.series.predicted.map((row) => convert(row, true)),
      target: request.series.target.map((row) => convert(row, true)) },
    chunks: request.chunks.map((chunk) => ({
      frame: chunk.frame, valid: chunk.valid,
      predicted: chunk.predicted.map((row, i) => convert(row, chunk.valid[i] === true)),
      target: chunk.target.map((row, i) => convert(row, chunk.valid[i] === true)),
    })),
  };
}

function conversionReason(request: PredictionRequest): string | null {
  if (request.source.representation !== "absolute") return "absolute_representation_required";
  if (request.profile === null) return "profile_required";
  if (!request.source.nominalSignZeroConfirmed) return "nominal_sign_zero_confirmation_required";
  switch (request.source.kind) {
    case "joint": return request.source.unit === "unknown" ? "joint_unit_required" : null;
    case "cartesian":
      if (request.source.referenceFrame !== "link_torso_5") return "reference_frame_link_torso_5_required";
      return request.seed === null ? "explicit_seed_required" : null;
    default: { const exhaustive: never = request.source; return exhaustive; }
  }
}

function deriveInverse(request: PredictionRequest, issue: Issue): PredictionData {
  const source = request.source, profile = request.profile;
  if (source.kind !== "cartesian" || profile === null) throw new RangeError("IK requires admitted Cartesian profile");
  const observations = new Map(request.seed?.kind === "observed"
    ? request.seed.samples.map((sample) => [sample.frame, sample.positions]) : []);
  const seedAt = (frame: number, side: Side): readonly number[] | null => {
    const seed = request.seed;
    if (seed === null) return null;
    let positions: readonly number[] | undefined;
    switch (seed.kind) {
      case "manual": positions = seed.positions; break;
      case "observed": positions = observations.get(frame); break;
      default: { const exhaustive: never = seed; return exhaustive; }
    }
    return positions?.slice(side === "left" ? 0 : 7, side === "left" ? 7 : 14)
      .map((value) => value * (seed.unit === "deg" ? Math.PI / 180 : 1)) ?? null;
  };
  const solveRow = (row: number[], valid: boolean, previous: Previous): Row =>
    sides.flatMap((side) => {
      const grip = gripper(row, source, side);
      if (!valid) return [...Array<null>(7).fill(null), grip];
      const seed = previous[side];
      if (seed === null) {
        issue(`missing_seed:${side}`);
        return [...Array<null>(7).fill(null), grip];
      }
      const { pose } = cartesianArm(row, source, side, () => {});
      if (pose === null) {
        issue(`invalid_target:${side}`);
        return [...Array<null>(7).fill(null), grip];
      }
      const solved = solveInverse(profile[`${side}Chain`], pose, seed);
      switch (solved.kind) {
        case "unavailable":
          issue(`${side}:${solved.reason}`);
          return [...Array<null>(7).fill(null), grip];
        case "ready":
          previous[side] = solved.joints;
          return [...solved.joints, grip];
        default: { const exhaustive: never = solved; return exhaustive; }
      }
    });

  // A single chronological GT branch. Scored trace rows win over valid chunk rows.
  const targets = new Map<number, number[]>();
  request.series.frames.forEach((frame, i) => {
    const row = request.series.target[i];
    if (row !== undefined) targets.set(frame, row);
  });
  for (const chunk of request.chunks) chunk.target.forEach((row, step) => {
    const frame = chunk.frame + step;
    if (chunk.valid[step] && !targets.has(frame)) targets.set(frame, row);
  });
  const reference = new Map<number, Row>();
  const previous = emptyPrevious();
  for (const [frame, row] of [...targets].sort(([a], [b]) => a - b)) {
    for (const side of sides) {
      // Observations may restart the reference at this frame; manual is only a start.
      const observed = request.seed?.kind === "observed" ? seedAt(frame, side) : null;
      previous[side] = observed ?? previous[side] ?? seedAt(frame, side);
    }
    reference.set(frame, solveRow(row, true, previous));
  }
  const targetRow = (row: number[], frame: number, valid: boolean): Row => sides.flatMap((side, i) => [
    ...(valid ? reference.get(frame)?.slice(i * 8, i * 8 + 7) ?? Array<null>(7).fill(null) : Array<null>(7).fill(null)),
    gripper(row, source, side),
  ]);
  const predictedRows = (rows: number[][], anchor: number, valid: readonly boolean[]) => {
    // No target actions or target solutions are ever used as prediction seeds.
    const state: Previous = { left: seedAt(anchor, "left"), right: seedAt(anchor, "right") };
    return rows.map((row, i) => solveRow(row, valid[i] === true, state));
  };
  const predictedTrace = emptyPrevious();
  return {
    series: { frames: request.series.frames, fps: request.series.fps,
      predicted: request.series.predicted.map((row, i) => {
        const frame = request.series.frames[i];
        if (frame === undefined) throw new RangeError("Missing admitted trace frame");
        for (const side of sides) predictedTrace[side] = request.seed?.kind === "observed"
          ? seedAt(frame, side) : predictedTrace[side] ?? seedAt(frame, side);
        return solveRow(row, true, predictedTrace);
      }),
      target: request.series.target.map((row, i) => {
        const frame = request.series.frames[i];
        if (frame === undefined) throw new RangeError("Missing admitted trace frame");
        return targetRow(row, frame, true);
      }) },
    chunks: request.chunks.map((chunk) => ({
      frame: chunk.frame, valid: chunk.valid,
      predicted: predictedRows(chunk.predicted, chunk.frame, chunk.valid),
      target: chunk.target.map((row, i) => targetRow(row, chunk.frame + i, chunk.valid[i] === true)),
    })),
  };
}

/** Canonical display: LEFT7/gripper RIGHT7/gripper native source units or IK radians.
 * Cartesian is mm/XYZ RPY degrees. Admission never infers units, signs, frames or seeds.
 */
export function derivePrediction(input: unknown): PredictionResult {
  const request = predictionRequestSchema.parse(input);
  // Accumulator only; the parsed request and all caller-owned inputs stay immutable.
  const counts = new Map<string, number>();
  const issue: Issue = (reason) => counts.set(reason, (counts.get(reason) ?? 0) + 1);
  const reason = conversionReason(request);
  let joint: PredictionData | null = null, cartesian: PredictionData | null = null;
  const provenance: PredictionResult["provenance"] = { joint: null, cartesian: null };
  const unavailable: PredictionResult["unavailable"] = { joint: null, cartesian: null };
  const source = request.source;
  switch (source.kind) {
    case "joint": {
      joint = mapData(request, (row) => sides.flatMap((side) => [
        ...source[side].joints.map((index) => sourceValue(row, index)),
        gripper(row, source, side),
      ]));
      provenance.joint = "source";
      unavailable.cartesian = reason;
      const profile = request.profile;
      if (reason === null && profile !== null) {
        cartesian = mapData(request, (row, valid) => sides.flatMap((side) => {
          const grip = gripper(row, source, side);
          if (!valid) return [...Array<null>(6).fill(null), grip];
          try {
            const radians = new Map(source[side].joints.map((index, i): [string, number] => [
              `${side}_arm_${i}`, sourceValue(row, index) * (source.unit === "deg" ? Math.PI / 180 : 1),
            ]));
            const pose = forwardChain(profile[`${side}Chain`], radians);
            if (pose.rpyDeg.some((value) => value === null)) issue("singular_rpy");
            return [...pose.translationM.map((value) => finiteComponent(value * 1000, issue)), ...pose.rpyDeg, grip];
          } catch (error) {
            if (!(error instanceof KinematicsError)) throw error;
            issue(error.reason);
            return [...Array<null>(6).fill(null), grip];
          }
        }));
        provenance.cartesian = "fk";
      }
      break;
    }
    case "cartesian":
      cartesian = mapData(request, (row) => sides.flatMap((side) => cartesianArm(row, source, side, issue).display));
      provenance.cartesian = "source";
      unavailable.joint = reason;
      if (reason === null) {
        joint = deriveInverse(request, issue);
        provenance.joint = "ik";
      }
      break;
    default: { const exhaustive: never = source; return exhaustive; }
  }
  return predictionResultSchema.parse({ joint, cartesian, provenance, unavailable,
    issues: [...counts].map(([reason, count]) => ({ reason, count })) });
}
