import { maximumSamplesPage } from "../src/contracts";
import type { Job, JobSummary, Result } from "../src/contracts";
import { JobError } from "../src/jobs";
import { episodeData, episodeSamples, readJobRoute, summarizeJob } from "../src/job-summary";
import { episodeResult, rememberEpisode } from "../src/client/results/episode-result";

/** Answers the job read API (summaries, episodes, downloads) for fixture runs exactly as the server does. */
export function fixtureJobResponse(url: URL, jobs: readonly Job[]): Response {
  try {
    return readJobRoute(url, {
      list: () => [...jobs],
      get: (id) => {
        const job = jobs.find((item) => item.id === id);
        if (!job) throw new JobError("평가 실행을 찾을 수 없습니다.", 404);
        return job;
      },
    }) ?? Response.json({ error: "Not found" }, { status: 404 });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : String(error) },
      { status: error instanceof JobError ? error.status : 400 });
  }
}

/**
 * The summary the API sends for `job`, with one episode (the first by default) already loaded as if the browser
 * had opened it, so server-rendered result views show it without fetching.
 */
export function openedRun(job: Job, episode?: number): JobSummary {
  const summary = summarizeJob(job);
  const index = episode ?? summary.result?.episodes[0]?.episode;
  if (job.result && summary.result && index !== undefined && summary.result.episodes.some((item) => item.episode === index)) {
    const data = episodeData(job.result, index);
    const samples: Result["samples"] = [];
    for (let offset = 0; offset < data.samples; offset += maximumSamplesPage)
      samples.push(...episodeSamples(job.result, index, offset, maximumSamplesPage).samples);
    rememberEpisode(job.id, index, episodeResult(summary.result, data, samples));
  }
  return summary;
}
