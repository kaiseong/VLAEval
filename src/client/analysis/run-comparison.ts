import type { JobSummary, Result } from "../../contracts";

export type CompletedEvaluation = JobSummary & { readonly result: NonNullable<JobSummary["result"]> };

export function isCompletedEvaluation(job: JobSummary): job is CompletedEvaluation {
  return job.status === "completed" && job.result !== null;
}

/** Scored anchors per episode; the job summary carries its SHA-256 as comparison.scoredFrames. */
export function scoredFramesKey(result: Result) {
  return result.traces.map((item) => ({ episode: item.episode, frames: item.frames })).sort((x, y) => x.episode - y.episode);
}

/** Full-chunk valid masks; the job summary carries its SHA-256 as comparison.validMasks. */
export function validMasksKey(result: Result) {
  return result.samples.map((item) => ({ episode: item.episode, frame: item.frame, valid: item.valid }))
    .sort((x, y) => x.episode - y.episode || x.frame - y.frame);
}

/** Compare evaluation conditions, not model identity or metric values. */
export function comparisonDifferences(base: CompletedEvaluation, other: CompletedEvaluation): readonly string[] {
  const differences: string[] = [];
  const a = base.result, b = other.result;
  const equal = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);
  if (a.dataset !== b.dataset) differences.push("dataset");
  if (!equal(a.actionNames, b.actionNames)) differences.push("action_channels");
  if (a.fps !== b.fps) differences.push("fps");
  const episodes = (job: CompletedEvaluation) => job.result.perEpisode.map((item) => item.episode).sort((x, y) => x - y);
  if (!equal(episodes(base), episodes(other))) differences.push("episodes");
  if (a.comparison.scoredFrames !== b.comparison.scoredFrames || a.framesEvaluated !== b.framesEvaluated)
    differences.push("scored_frames");
  const horizons = (job: CompletedEvaluation) => job.result.perHorizon
    .map((item) => [item.step, item.count]).sort((x, y) => (x[0] ?? 0) - (y[0] ?? 0));
  if (!equal(horizons(base), horizons(other)) || a.validSteps !== b.validSteps) differences.push("horizon_coverage");
  if (a.comparison.samples !== a.framesEvaluated || b.comparison.samples !== b.framesEvaluated)
    differences.push("coverage_unknown");
  else if (a.comparison.validMasks !== b.comparison.validMasks) differences.push("valid_masks");
  if (base.request.stride !== other.request.stride || base.request.maxSamples !== other.request.maxSamples) differences.push("sampling");
  if (a.seed !== b.seed) differences.push("seed");
  if (a.numSteps !== b.numSteps) differences.push("inference_steps");
  return differences;
}

export const comparisonDifferenceLabels: Readonly<Record<string, string>> = {
  dataset: "데이터셋", action_channels: "액션 채널/순서", fps: "FPS", episodes: "평가 EP",
  scored_frames: "평가 프레임", horizon_coverage: "청크 길이/유효 행", valid_masks: "유효 마스크",
  coverage_unknown: "저장 청크 부족으로 범위 일치 확인 불가", sampling: "샘플링 설정",
  seed: "시드", inference_steps: "추론 스텝 수",
};
