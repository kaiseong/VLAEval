import { useEffect, useState } from "react";
import { episodeDataSchema, episodeSamplesSchema, maximumSamplesPage } from "../../contracts";
import type { EpisodeData, Result, ResultSummary } from "../../contracts";
import { api, errorMessage } from "../api";

/** One episode as the result views expect it: the run's aggregates plus only that episode's arrays. */
export function episodeResult(summary: ResultSummary, data: EpisodeData, samples: Result["samples"]): Result {
  const {
    episodes: _episodes, episodeChunkMetrics: _metrics, errorRange: _range, comparison: _comparison, jointObservations, ...aggregates
  } = summary;
  return {
    ...aggregates,
    traces: data.trace ? [data.trace] : [],
    samples,
    ...(jointObservations ? { jointObservations: { ...jointObservations, samples: data.observations ?? [] } } : {}),
  };
}

export type EpisodeLoad =
  | { readonly kind: "loading"; readonly loaded: number; readonly total: number | null; readonly startedAt: number }
  | { readonly kind: "ready"; readonly result: Result }
  | { readonly kind: "error"; readonly message: string };

/** Fetches the episode's trace and observations, then its saved chunks page by page. */
export async function loadEpisode(jobId: string, summary: ResultSummary, episode: number, signal: AbortSignal,
  onProgress: (loaded: number, total: number) => void): Promise<Result> {
  const base = `/api/jobs/${jobId}/episodes/${episode}`;
  const data = episodeDataSchema.parse(await api.get(base, { signal }).json());
  const samples: Result["samples"] = [];
  onProgress(0, data.samples);
  while (samples.length < data.samples) {
    const page = episodeSamplesSchema.parse(await api.get(`${base}/samples`, {
      signal, searchParams: { offset: samples.length, limit: maximumSamplesPage },
    }).json());
    if (page.episode !== episode || page.total !== data.samples || page.offset !== samples.length || !page.samples.length)
      throw new Error("저장된 실행이 바뀌어 EP 데이터를 이어 받을 수 없습니다. 다시 불러오세요.");
    for (const sample of page.samples) samples.push(sample);
    onProgress(samples.length, data.samples);
  }
  return episodeResult(summary, data, samples);
}

// The last episodes opened, so returning to one does not download its chunks (up to ~40 MB) again.
const recent = new Map<string, Result>();
export function rememberEpisode(jobId: string, episode: number, result: Result) {
  const key = `${jobId}:${episode}`;
  recent.delete(key);
  recent.set(key, result);
  for (const oldest of recent.keys()) {
    if (recent.size <= 3) break;
    recent.delete(oldest);
  }
}

const empty = (summary: ResultSummary) =>
  episodeResult(summary, { episode: -1, trace: null, observations: null, samples: 0 }, []);

/** Loads one episode of a stored run; `attempt` retries after an error. A run without episodes needs no request. */
export function useEpisodeResult(jobId: string, summary: ResultSummary, episode: number, attempt: number): EpisodeLoad {
  const key = `${jobId}:${episode}`;
  const known = (): EpisodeLoad | null => {
    if (!summary.episodes.some((item) => item.episode === episode)) return { kind: "ready", result: empty(summary) };
    const hit = recent.get(key);
    return hit ? { kind: "ready", result: hit } : null;
  };
  const [state, setState] = useState<{ readonly key: string; readonly attempt: number; readonly load: EpisodeLoad }>(
    () => ({ key, attempt, load: known() ?? { kind: "loading", loaded: 0, total: null, startedAt: performance.now() } }));
  useEffect(() => {
    const ready = known();
    if (ready) {
      setState({ key, attempt, load: ready });
      return;
    }
    const controller = new AbortController();
    const startedAt = performance.now();
    const update = (load: EpisodeLoad) => {
      if (!controller.signal.aborted) setState({ key, attempt, load });
    };
    update({ kind: "loading", loaded: 0, total: null, startedAt });
    loadEpisode(jobId, summary, episode, controller.signal, (loaded, total) => update({ kind: "loading", loaded, total, startedAt }))
      .then((result) => {
        rememberEpisode(jobId, episode, result);
        update({ kind: "ready", result });
      }, async (cause: unknown) => update({ kind: "error", message: await errorMessage(cause) }));
    return () => controller.abort();
  }, [key, attempt, summary]);
  if (state.key === key && state.attempt === attempt) return state.load;
  return known() ?? { kind: "loading", loaded: 0, total: null, startedAt: performance.now() };
}
