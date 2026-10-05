import { resultSchema } from "../../contracts";
import { fkResultSchema } from "../../kinematics/contracts";
import type { FkResult } from "../../kinematics/contracts";

type Result = typeof resultSchema._output;
type FkIdentity = Pick<FkResult, "schemaVersion" | "jobId" | "episode" | "profileHash" | "jointUnit" | "representation" | "convention" | "generation">;
type FkExportContext = {
  readonly profile: {
    readonly profileHash: string;
    readonly sourcePath: string;
    readonly model: string;
    readonly revision: string;
    readonly urdfSha256: string;
    readonly rootLink: string;
    readonly tips: { readonly right: string; readonly left: string };
  };
  readonly sourceJobId: string;
  readonly sourceEpisode: number;
};

export type FkExportRequest = {
  readonly identity: FkIdentity;
  readonly completed: unknown;
  readonly context: FkExportContext;
};

export type ExportArtifact = { readonly filename: string; readonly content: string; readonly mediaType: string };

export function rawJsonExport(result: Result): string {
  return JSON.stringify(result, null, 2);
}

function csvCell(value: string | number | boolean): string {
  return `"${String(value).replaceAll('"', '""')}"`;
}

export function rawTraceCsv(result: Result): string {
  const rows = ["episode,frame,time_seconds,dimension,action,predicted,target,error"];
  for (const trace of result.traces) {
    trace.frames.forEach((frame, index) => {
      const predicted = trace.predicted[index] ?? [];
      const target = trace.target[index] ?? [];
      for (let dimension = 0; dimension < Math.max(predicted.length, target.length); dimension += 1) {
        const prediction = predicted[dimension];
        const truth = target[dimension];
        rows.push([
          trace.episode, frame, frame / result.fps, dimension,
          result.actionNames[dimension] ?? `action_${dimension}`, prediction ?? "",
          truth ?? "", prediction == null || truth == null ? "" : prediction - truth,
        ].map(csvCell).join(","));
      }
    });
  }
  return "\ufeff" + rows.join("\r\n");
}

function matchesIdentity(result: FkResult, identity: FkIdentity): boolean {
  return result.jobId === identity.jobId &&
    result.episode === identity.episode &&
    result.profileHash === identity.profileHash &&
    result.jointUnit === identity.jointUnit &&
    result.representation === identity.representation &&
    result.convention.kind === identity.convention.kind &&
    result.convention.nominalSignZeroConfirmed === identity.convention.nominalSignZeroConfirmed &&
    result.convention.source === identity.convention.source &&
    result.generation === identity.generation;
}

function admissibleFkResult(request: FkExportRequest): FkResult | null {
  if (!request.completed || typeof request.completed !== "object") return null;
  const parsed = fkResultSchema.safeParse(request.completed);
  if (!parsed.success) return null;
  const result = parsed.data;
  if (result.schemaVersion !== request.identity.schemaVersion) return null;
  if (!matchesIdentity(result, request.identity) ||
      result.jobId !== request.context.sourceJobId ||
      result.episode !== request.context.sourceEpisode ||
      result.profileHash !== request.context.profile.profileHash ||
      result.profile.model !== request.context.profile.model ||
      result.profile.revision !== request.context.profile.revision ||
      result.profile.urdfSha256 !== request.context.profile.urdfSha256 ||
      result.profile.rootLink !== request.context.profile.rootLink ||
      result.profile.tips.right !== request.context.profile.tips.right ||
      result.profile.tips.left !== request.context.profile.tips.left) return null;
  return result;
}

export function fkJsonExport(request: FkExportRequest): ExportArtifact | null {
  const result = admissibleFkResult(request);
  if (!result) return null;
  const document = {
    schemaVersion: result.schemaVersion,
    source: {
      jobId: result.jobId,
      episode: result.episode,
      frames: result.samples.map((sample) => sample.frame),
    },
    profile: {
      profileHash: result.profileHash,
      model: result.profile.model,
      revision: result.profile.revision,
      urdfSha256: result.profile.urdfSha256,
      rootLink: result.profile.rootLink,
      tips: result.profile.tips,
      sourcePath: request.context.profile.sourcePath,
    },
    declaration: {
      jointUnit: result.jointUnit,
      representation: result.representation,
      convention: result.convention,
      generation: result.generation,
      actionNames: result.actionNames,
      jointMapping: result.jointMapping,
      sourceUnits: { translation: "m", orientation: "quaternion_xyzw", displayPosition: "mm", displayOrientation: "deg" },
      rpyConvention: "R=Rz(yaw)Ry(pitch)Rx(roll)",
      orientationErrorUnit: "rad",
    },
    validPairCounts: {
      right: {
        translation: result.summaries.right.translationM.count,
        orientation: result.summaries.right.orientationRad.count,
      },
      left: {
        translation: result.summaries.left.translationM.count,
        orientation: result.summaries.left.orientationRad.count,
      },
    },
    samples: result.samples,
    summaries: result.summaries,
  };
  return {
    filename: `vlaeval-${result.jobId}-ep${result.episode}.fk.json`,
    content: JSON.stringify(document, null, 2),
    mediaType: "application/json;charset=utf-8",
  };
}

export function fkCsvExport(request: FkExportRequest): ExportArtifact | null {
  const result = admissibleFkResult(request);
  if (!result) return null;
  const rows = ["job_id,episode,frame,schema_version,profile_hash,model,revision,urdf_sha256,root_link,right_tip,left_tip,joint_unit,representation,convention,right_translation_valid_pair_count,right_orientation_valid_pair_count,left_translation_valid_pair_count,left_orientation_valid_pair_count,side,valid,reasons,predicted_translation_m,target_translation_m,predicted_quaternion_xyzw,target_quaternion_xyzw,translation_error_m,orientation_error_rad"];
  for (const sample of result.samples) {
    for (const side of ["right", "left"] as const) {
      const arm = sample.arms[side];
      rows.push([
        result.jobId, result.episode, sample.frame, result.schemaVersion, result.profileHash, result.profile.model,
        result.profile.revision, result.profile.urdfSha256, result.profile.rootLink,
        result.profile.tips.right, result.profile.tips.left, result.jointUnit,
        result.representation,
        `${result.convention.kind}:${result.convention.source}:${result.convention.nominalSignZeroConfirmed}`,
        result.summaries.right.translationM.count,
        result.summaries.right.orientationRad.count,
        result.summaries.left.translationM.count,
        result.summaries.left.orientationRad.count,
        side, arm.valid, arm.reasons.join(";"),
        JSON.stringify(arm.pose.predicted.translationM), JSON.stringify(arm.pose.target.translationM),
        JSON.stringify(arm.pose.predicted.quaternionXyzw), JSON.stringify(arm.pose.target.quaternionXyzw),
        arm.errors.translationM ?? "", arm.errors.orientationRad ?? "",
      ].map(csvCell).join(","));
    }
  }
  return {
    filename: `vlaeval-${result.jobId}-ep${result.episode}.fk.csv`,
    content: "\ufeff" + rows.join("\r\n"),
    mediaType: "text/csv;charset=utf-8",
  };
}
