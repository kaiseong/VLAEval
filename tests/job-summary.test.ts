import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApi, eventStream } from "../src/api";
import {
  episodeDataSchema, episodeSamplesSchema, jobRequestSchema, jobSummarySchema, maximumSamplesPage, resultSchema,
} from "../src/contracts";
import type { Job, Result } from "../src/contracts";
import { getEpisodeChunkMetrics } from "../src/client/analysis/evaluation-results";
import { rawTraceCsv } from "../src/client/analysis/exports";
import { isTerminal, JobStore } from "../src/jobs";
import { episodeData, episodeSamples, errorRanges, resultJsonStream, summarizeResult } from "../src/job-summary";
import { resultFixture } from "./result-fixture";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

/** EP 5: 1,201 chunks (three pages) with joint observations; EP 2: a trace and an observation, no chunks. */
function largeResult(): Result {
  const frames = Array.from({ length: 1201 }, (_, index) => index);
  return resultSchema.parse({
    ...resultFixture,
    framesEvaluated: 1201,
    jointObservations: {
      names: Array.from({ length: 14 }, (_, index) => `${index < 7 ? "left" : "right"}_arm_${index % 7}`), unit: "rad",
      samples: [
        ...frames.map((frame) => ({ episode: 5, frame, positions: Array<number>(14).fill(frame / 1000) })),
        { episode: 2, frame: 0, positions: Array<number>(14).fill(0) },
      ],
    },
    perEpisode: [
      { episode: 5, framesEvaluated: 1201, mae: 0.1, rmse: 0.1 }, { episode: 2, framesEvaluated: 1, mae: 0.1, rmse: 0.1 },
    ],
    traces: [
      { episode: 5, frames, predicted: frames.map((frame) => [frame, -frame]), target: frames.map(() => [0, 0]) },
      { episode: 2, frames: [0], predicted: [[1, 1]], target: [[0, 0]] },
    ],
    samples: frames.map((frame) => ({
      episode: 5, frame, prompt: "", predicted: [[frame, -frame]], target: [[0, 0]], valid: [true],
    })),
  });
}

describe("job summaries", () => {
  test("keep every aggregate and replace the per-frame arrays with an episode index", () => {
    // Given a stored result whose chunks dominate its size.
    const result = largeResult();
    // When the API summarizes it.
    const summary = summarizeResult(result);
    // Then only traces, chunks and observation rows are left out; cross-episode values are precomputed.
    const { traces: _traces, samples: _samples, jointObservations, ...aggregates } = result;
    expect(summary).toMatchObject(aggregates);
    expect(Object.keys(summary)).not.toContain("samples");
    expect(Object.keys(summary)).not.toContain("traces");
    expect(summary.jointObservations).toEqual({ names: jointObservations?.names ?? [], unit: "rad" });
    expect(summary.episodes).toEqual([
      { episode: 5, traceFrames: 1201, samples: 1201, observations: 1201 },
      { episode: 2, traceFrames: 1, samples: 0, observations: 1 },
    ]);
    expect(summary.episodeChunkMetrics).toEqual([...getEpisodeChunkMetrics(result)]);
    expect(summary.comparison.samples).toBe(1201);
    expect(JSON.stringify(summary).length * 20).toBeLessThan(JSON.stringify(result).length);
  });

  test("episode pages rebuild that episode's stored arrays in order", () => {
    const result = largeResult();
    expect(episodeData(result, 5)).toEqual({
      episode: 5, trace: result.traces[0] ?? null, samples: 1201,
      observations: result.jointObservations?.samples.slice(0, 1201) ?? null,
    });
    // Oversized limits are capped to one page.
    const pages = [0, 500, 1000].map((offset) => episodeSamples(result, 5, offset, 10_000));
    expect(pages.map((page) => page.samples.length)).toEqual([maximumSamplesPage, maximumSamplesPage, 201]);
    expect(pages.flatMap((page) => page.samples)).toEqual(result.samples);
    expect(episodeData(result, 2)).toMatchObject({ samples: 0, observations: [{ episode: 2, frame: 0 }] });
    expect(() => episodeData(result, 9)).toThrow("저장되지 않은 EP");
  });

  test("error ranges cover valid rows of every step and dimension and locate the largest error", () => {
    const result = resultSchema.parse({
      ...resultFixture, actionNames: ["joint", "gripper"],
      samples: [
        { episode: 1, frame: 4, prompt: "", predicted: [[1, -2], [9, 0]], target: [[0.5, 0], [0, 0]], valid: [true, false] },
        { episode: 2, frame: 0, prompt: "", predicted: [[0, 0], [0, 7]], target: [[0, 0.25], [0, 0]], valid: [true, true] },
      ],
    });
    // The invalid row (9) is skipped; EP 2's largest error is step 1 of the gripper.
    expect(errorRanges(result)).toEqual({
      overall: { min: 0, max: 7, at: { episode: 2, frame: 0, step: 1, dimension: "gripper" } },
      episodes: [
        { episode: 1, min: 0.5, max: 2, at: { episode: 1, frame: 4, step: 0, dimension: "gripper" } },
        { episode: 2, min: 0, max: 7, at: { episode: 2, frame: 0, step: 1, dimension: "gripper" } },
      ],
    });
    expect(summarizeResult(result).errorRange).toEqual(errorRanges(result));
  });

  test("results without joint observations report null observations", () => {
    expect(episodeData(resultFixture, 3).observations).toBeNull();
    expect(summarizeResult(resultFixture).jointObservations).toBeUndefined();
  });

  test("the result download streams exactly JSON.stringify(result)", async () => {
    const result = largeResult();
    for (const value of [result, resultFixture, { ...resultFixture, coverage: undefined }])
      expect(await new Response(resultJsonStream(value)).text()).toBe(JSON.stringify(value));
  });
});

describe("job read API", () => {
  test("serves summaries, paged episode data and downloads instead of whole runs", async () => {
    // Given a completed run stored by the job store.
    const result = largeResult();
    const directory = await mkdtemp(join(tmpdir(), "vlaeval-summary-test-"));
    directories.push(directory);
    const store = new JobStore(directory, async (_request, emit) => emit({ type: "result", result }));
    await store.initialize();
    const request = jobRequestSchema.parse({
      host: "rtx6000@192.168.0.3", repo: "/models/openpi", config: "test",
      checkpoint: "/models/100", dataset: "/data/test", episodes: [5, 2],
    });
    const started = await store.start(request);
    const finished = Promise.withResolvers<Job>();
    const unsubscribe = store.subscribe(started.id, (job) => {
      if (isTerminal(job)) {
        unsubscribe();
        finished.resolve(job);
      }
    });
    expect((await finished.promise).status).toBe("completed");
    const api = createApi(store);
    const get = (path: string) => api(new Request(`http://127.0.0.1${path}`));
    const base = `/api/jobs/${started.id}`;

    // Then the list and the single-run routes send summaries.
    const listed = await (await get("/api/jobs")).text();
    expect(listed).not.toContain('"samples":[');
    expect(jobSummarySchema.array().parse(JSON.parse(listed))[0]?.result?.episodes.map((item) => item.episode)).toEqual([5, 2]);
    expect(jobSummarySchema.parse(await (await get(base)).json()).result?.comparison.samples).toBe(1201);

    // And one episode arrives as its trace plus pages of chunks.
    expect(episodeDataSchema.parse(await (await get(`${base}/episodes/5`)).json()).samples).toBe(1201);
    const last = episodeSamplesSchema.parse(await (await get(`${base}/episodes/5/samples?offset=1000`)).json());
    expect(last).toMatchObject({ episode: 5, offset: 1000, total: 1201 });
    expect(last.samples).toEqual(result.samples.slice(1000));
    expect((await get(`${base}/episodes/5/samples?offset=-1`)).status).toBe(400);
    expect((await get(`${base}/episodes/5/samples?offset=1&offset=2`)).status).toBe(400);
    expect((await get(`${base}/episodes/9`)).status).toBe(404);
    expect((await get("/api/jobs/00000000-0000-4000-8000-00000000000f/episodes/5")).status).toBe(404);

    // And the downloads carry the stored result and every trace.
    const json = await get(`${base}/result.json`);
    expect(json.headers.get("content-disposition")).toBe(`attachment; filename="vlaeval-${started.id}.json"`);
    expect(await json.text()).toBe(JSON.stringify(result));
    const csv = await get(`${base}/traces.csv`);
    expect(csv.headers.get("content-type")).toBe("text/csv;charset=utf-8");
    expect(await csv.text()).toBe(rawTraceCsv(result));

    // And live updates carry the summary too.
    const records = (await eventStream(new Request(`http://127.0.0.1${base}/events`), store, started.id).text())
      .trim().split("\n\n").map((line) => JSON.parse(line.slice(6)) as unknown);
    expect(jobSummarySchema.parse(records.at(-1)).result?.episodes.length).toBe(2);
    expect(JSON.stringify(records.at(-1))).not.toContain('"samples":[');
  });
});
