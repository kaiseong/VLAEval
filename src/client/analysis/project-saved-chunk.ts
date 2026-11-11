import type { Job } from "../../contracts";
import type { DiagnosticPacket } from "../../diagnostic-contracts";
import type { CompiledProfile } from "../../kinematics/contracts";
import { projectTrajectory } from "../../kinematics/projection";
import { derivePrediction } from "./prediction";
import { predictionRequestSchema } from "./prediction-contracts";

export function projectSavedChunk(result: NonNullable<Job["result"]>, packet: DiagnosticPacket, profile: CompiledProfile | null) {
  const input = packet.projection;
  if (!input) return { kind: "unavailable", reason: "camera_projection_input_missing" } as const;
  if (input.source.kind === "joint" && (!profile || profile.profileHash !== input.profileHash))
    return { kind: "unavailable", reason: "matching_robot_profile_required" } as const;
  const chunk = result.samples.find((sample) => sample.episode === packet.identity.episode && sample.frame === packet.identity.frame);
  if (!chunk) return { kind: "unavailable", reason: "saved_full_chunk_missing" } as const;
  const parsed = predictionRequestSchema.safeParse({
    actionNames: result.actionNames, source: input.source, profile, seed: null,
    series: { frames: [], predicted: [], target: [], fps: result.fps },
    chunks: [{ frame: chunk.frame, predicted: chunk.predicted, target: chunk.target, valid: chunk.valid }],
  });
  if (!parsed.success) return { kind: "unavailable", reason: parsed.error.issues.map((item) => item.message).join("; ") } as const;
  const derived = derivePrediction(parsed.data);
  const cartesian = derived.cartesian?.chunks[0];
  if (!cartesian) return { kind: "unavailable", reason: derived.unavailable.cartesian ?? "cartesian_conversion_failed" } as const;
  const points = (rows: readonly (readonly (number | null)[])[], offset: number) => rows.map((row): [number, number, number] | null => {
    const x = row[offset], y = row[offset + 1], z = row[offset + 2];
    return x == null || y == null || z == null ? null : [x / 1000, y / 1000, z / 1000];
  });
  return { kind: "ready", trajectories: (["left", "right"] as const).flatMap((side, i) =>
    (["predicted", "target"] as const).map((source) => ({
      side, source, points: projectTrajectory(points(cartesian[source], i * 7), cartesian.valid, input.camera),
    }))) } as const;
}
