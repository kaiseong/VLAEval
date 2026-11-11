import type { Job } from "../../contracts";

type Result = NonNullable<Job["result"]>;

export type EpisodeChunkMetrics = {
  readonly episode: number;
  readonly framesEvaluated: number;
  readonly validSteps: number | null;
  readonly mae: number | null;
  readonly mse: number | null;
  readonly rmse: number | null;
  readonly reason: string | null;
};

/** Full chunks only. Legacy first-step metrics never substitute for missing chunks. */
export function getEpisodeChunkMetrics(result: Result): readonly EpisodeChunkMetrics[] {
  // Group once so large runs do not rescan all samples for every episode.
  const episodes = new Map<number, {
    summaries: Result["perEpisode"];
    chunks: NonNullable<Result["perEpisodeChunks"]>;
    traces: Result["traces"];
    samples: Result["samples"];
    coverage: NonNullable<Result["coverage"]>["episodes"];
  }>();
  const group = (episode: number) => {
    let entry = episodes.get(episode);
    if (!entry) {
      entry = { summaries: [], chunks: [], traces: [], samples: [], coverage: [] };
      episodes.set(episode, entry);
    }
    return entry;
  };
  for (const item of result.perEpisode) group(item.episode).summaries.push(item);
  for (const item of result.perEpisodeChunks ?? []) group(item.episode).chunks.push(item);
  for (const item of result.traces) group(item.episode).traces.push(item);
  for (const item of result.samples) group(item.episode).samples.push(item);
  for (const item of result.coverage?.episodes ?? []) group(item.episode).coverage.push(item);

  return [...episodes].sort(([a], [b]) => a - b).map(([episode, entry]) => {
    const summary = entry.summaries[0];
    const trace = entry.traces[0];
    const coverage = entry.coverage[0];
    const stored = entry.chunks[0];
    const framesEvaluated = summary?.framesEvaluated ?? coverage?.scoredAnchors
      ?? trace?.frames.length ?? entry.samples.length;
    const unavailable = (reason: string): EpisodeChunkMetrics => ({
      episode, framesEvaluated, validSteps: null, mae: null, mse: null, rmse: null, reason,
    });
    if (result.perEpisodeChunks !== undefined) {
      if (entry.chunks.length !== 1 || !stored) return unavailable("missing_or_duplicate_chunk_metrics");
      return { ...stored, reason: null };
    }
    if (entry.summaries.length !== 1 || !summary || framesEvaluated <= 0) {
      return unavailable("missing_episode_frame_count");
    }
    if (entry.traces.length !== 1 || !trace || trace.frames.length !== framesEvaluated
      || entry.samples.length !== framesEvaluated) return unavailable("incomplete_anchors");
    const anchors = new Map(trace.frames.map((frame, index) => [frame, index]));
    if (anchors.size !== framesEvaluated) return unavailable("duplicate_trace_anchors");
    const horizon = result.coverage?.horizon ?? result.perHorizon.length;
    const width = result.actionNames.length;
    if (horizon <= 0 || width <= 0 || result.perHorizon.length !== horizon
      || result.perHorizon.some((row, index) => row.step !== index)) {
      return unavailable("unknown_chunk_shape");
    }
    if (result.coverage && (entry.coverage.length !== 1 || !coverage
      || coverage.scoredAnchors !== framesEvaluated
      || coverage.validRowsByHorizon.length !== horizon)) return unavailable("coverage_mismatch");

    const seen = new Set<number>();
    const counts = Array<number>(horizon).fill(0);
    let validSteps = 0, absolute = 0, square = 0;
    for (const sample of entry.samples) {
      const index = anchors.get(sample.frame);
      if (index === undefined || seen.has(sample.frame)) return unavailable("missing_or_duplicate_sample_anchors");
      seen.add(sample.frame);
      if (sample.predicted.length !== horizon || sample.target.length !== horizon
        || sample.valid.length !== horizon || sample.valid[0] !== true) {
        return unavailable("chunk_shape_or_mask_mismatch");
      }
      const firstPredicted = trace.predicted[index];
      const firstTarget = trace.target[index];
      if (firstPredicted?.length !== width || firstTarget?.length !== width
        || sample.predicted[0]?.some((value, dim) => value !== firstPredicted[dim])
        || sample.target[0]?.some((value, dim) => value !== firstTarget[dim])) {
        return unavailable("trace_anchor_mismatch");
      }
      for (let step = 0; step < horizon; step++) {
        const predicted = sample.predicted[step], target = sample.target[step];
        const valid = sample.valid[step];
        if (!predicted || !target || predicted.length !== width || target.length !== width
          || typeof valid !== "boolean") return unavailable("chunk_shape_or_mask_mismatch");
        if (valid && coverage && sample.frame + step >= coverage.originalFrames) {
          return unavailable("coverage_mask_mismatch");
        }
        if (!valid) continue;
        counts[step] = (counts[step] ?? 0) + 1;
        validSteps++;
        for (let dim = 0; dim < width; dim++) {
          const p = predicted[dim], t = target[dim];
          if (p === undefined || t === undefined || !Number.isFinite(p) || !Number.isFinite(t)) {
            return unavailable("nonfinite_chunk_values");
          }
          const error = p - t;
          absolute += Math.abs(error);
          square += error * error;
        }
      }
    }
    if (coverage && (validSteps !== coverage.validRows
      || counts.some((count, step) => count !== coverage.validRowsByHorizon[step]))) {
      return unavailable("coverage_mask_mismatch");
    }
    const mae = absolute / (validSteps * width), mse = square / (validSteps * width);
    if (!Number.isFinite(mae) || !Number.isFinite(mse)) return unavailable("nonfinite_chunk_metrics");
    return { episode, framesEvaluated, validSteps, mae, mse, rmse: Math.sqrt(mse), reason: null };
  });
}
