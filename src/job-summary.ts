import { createHash } from "node:crypto";
import { z } from "zod";
import { maximumSamplesPage } from "./contracts";
import type { EpisodeData, EpisodeSamples, Job, JobSummary, Result, ResultSummary } from "./contracts";
import { getEpisodeChunkMetrics } from "./client/analysis/evaluation-results";
import { rawTraceCsv } from "./client/analysis/exports";
import { scoredFramesKey, validMasksKey } from "./client/analysis/run-comparison";
import { JobError } from "./jobs";

type Episode = {
  trace: Result["traces"][number] | null;
  readonly samples: Result["samples"];
  readonly observations: NonNullable<Result["jointObservations"]>["samples"] | null;
};

// A finished run's result is replaced, never edited in place, so both caches key on the result object.
const episodeCache = new WeakMap<Result, ReadonlyMap<number, Episode>>();
const summaryCache = new WeakMap<Result, ResultSummary>();

/** Per-episode views of the stored arrays, in the order the result lists episodes (traces, then chunks). */
function episodes(result: Result): ReadonlyMap<number, Episode> {
  const cached = episodeCache.get(result);
  if (cached) return cached;
  const observed = new Map<number, NonNullable<Result["jointObservations"]>["samples"]>();
  for (const sample of result.jointObservations?.samples ?? []) {
    const rows = observed.get(sample.episode);
    if (rows) rows.push(sample);
    else observed.set(sample.episode, [sample]);
  }
  const byEpisode = new Map<number, Episode>();
  const entry = (episode: number) => {
    let item = byEpisode.get(episode);
    if (!item) {
      item = { trace: null, samples: [], observations: result.jointObservations ? observed.get(episode) ?? [] : null };
      byEpisode.set(episode, item);
    }
    return item;
  };
  // The first trace of an episode is the one the result views always used (traces.find).
  for (const trace of result.traces) entry(trace.episode).trace ??= trace;
  for (const sample of result.samples) entry(sample.episode).samples.push(sample);
  episodeCache.set(result, byEpisode);
  return byEpisode;
}

const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

export function summarizeResult(result: Result): ResultSummary {
  const cached = summaryCache.get(result);
  if (cached) return cached;
  const { traces: _traces, samples, jointObservations, ...aggregates } = result;
  const summary: ResultSummary = {
    ...aggregates,
    ...(jointObservations ? { jointObservations: { names: jointObservations.names, unit: jointObservations.unit } } : {}),
    episodes: [...episodes(result)].map(([episode, item]) => ({
      episode, traceFrames: item.trace?.frames.length ?? 0, samples: item.samples.length,
      observations: item.observations?.length ?? 0,
    })),
    episodeChunkMetrics: [...getEpisodeChunkMetrics(result)],
    comparison: {
      scoredFrames: digest(scoredFramesKey(result)), validMasks: digest(validMasksKey(result)), samples: samples.length,
    },
  };
  summaryCache.set(result, summary);
  return summary;
}

export function summarizeJob(job: Job): JobSummary {
  return { ...job, result: job.result ? summarizeResult(job.result) : null };
}

function episode(result: Result, index: number): Episode {
  const item = episodes(result).get(index);
  if (!item) throw new JobError("이 실행에 저장되지 않은 EP입니다.", 404);
  return item;
}

export function episodeData(result: Result, index: number): EpisodeData {
  const item = episode(result, index);
  return { episode: index, trace: item.trace, observations: item.observations, samples: item.samples.length };
}

export function episodeSamples(result: Result, index: number, offset: number, limit: number): EpisodeSamples {
  const item = episode(result, index);
  return {
    episode: index, offset, total: item.samples.length,
    samples: item.samples.slice(offset, offset + Math.min(limit, maximumSamplesPage)),
  };
}

/** Same bytes as JSON.stringify(result), streamed so a 400 MB result never becomes one string. */
export function resultJsonStream(result: Result): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const parts = (function* () {
    let separator = "{";
    for (const [key, value] of Object.entries(result)) {
      if (value === undefined) continue;
      yield `${separator}${JSON.stringify(key)}:`;
      separator = ",";
      if (key !== "samples" || !Array.isArray(value)) {
        yield JSON.stringify(value);
        continue;
      }
      yield "[";
      for (let start = 0; start < value.length; start += 100)
        yield (start ? "," : "") + value.slice(start, start + 100).map((item) => JSON.stringify(item)).join(",");
      yield "]";
    }
    yield separator === "{" ? "{}" : "}";
  })();
  return new ReadableStream({
    pull(controller) {
      const next = parts.next();
      if (next.done) controller.close();
      else controller.enqueue(encoder.encode(next.value));
    },
  });
}

const uuid = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const jobRoute = new RegExp(`^/api/jobs/(${uuid})$`);
const episodeRoute = new RegExp(`^/api/jobs/(${uuid})/episodes/(0|[1-9][0-9]{0,8})(/samples)?$`);
const exportRoute = new RegExp(`^/api/jobs/(${uuid})/(result\\.json|traces\\.csv)$`);
const queryIndex = z.string().regex(/^(0|[1-9][0-9]{0,8})$/).transform(Number);

function stored(job: Job): Result {
  if (!job.result) throw new JobError("저장된 결과가 없는 실행입니다.", 404);
  return job.result;
}

function query(url: URL, name: string, fallback: number): number {
  const values = url.searchParams.getAll(name);
  if (values.length > 1) throw new JobError(`${name} query must be unambiguous`, 400);
  return values[0] === undefined ? fallback : queryIndex.parse(values[0]);
}

/**
 * GET routes that read stored runs: the summary list, one summary, one episode's per-frame data (chunks paged by
 * offset/limit) and the result/trace downloads. Null for every other path. The browser-test fixtures reuse it.
 */
export function readJobRoute(url: URL, jobs: { list(): Job[]; get(id: string): Job }): Response | null {
  const noStore = { "Cache-Control": "no-store" };
  if (url.pathname === "/api/jobs") return Response.json(jobs.list().map(summarizeJob), { headers: noStore });
  const job = jobRoute.exec(url.pathname);
  if (job?.[1]) return Response.json(summarizeJob(jobs.get(job[1])), { headers: noStore });
  const match = episodeRoute.exec(url.pathname);
  if (match?.[1] && match[2]) {
    const result = stored(jobs.get(match[1]));
    const index = Number(match[2]);
    if (!match[3]) return Response.json(episodeData(result, index), { headers: noStore });
    return Response.json(episodeSamples(result, index, query(url, "offset", 0), query(url, "limit", maximumSamplesPage)),
      { headers: noStore });
  }
  const download = exportRoute.exec(url.pathname);
  if (download?.[1] && download[2]) {
    const result = stored(jobs.get(download[1]));
    const json = download[2] === "result.json";
    return new Response(json ? resultJsonStream(result) : rawTraceCsv(result), {
      headers: {
        ...noStore,
        "Content-Type": json ? "application/json;charset=utf-8" : "text/csv;charset=utf-8",
        "Content-Disposition": `attachment; filename="vlaeval-${download[1]}.${json ? "json" : "csv"}"`,
      },
    });
  }
  return null;
}
