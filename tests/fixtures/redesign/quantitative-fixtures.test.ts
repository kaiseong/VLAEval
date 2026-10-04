import { createHash } from "node:crypto";
import { expect, test } from "bun:test";
import type { z } from "zod";
import { jobSchema } from "../../../src/contracts";
import { fkRequestSchema } from "../../../src/kinematics/contracts";
type ParsedJob = z.infer<typeof jobSchema>;
type FixtureSnapshot = {
  fkRequest: unknown;
  quantitativeFacts: {
    episode: number;
    firstStepErrors: number[];
    retainedChunkErrors: Array<Array<number | null>>;
    chunkMae: number;
    chunkRmse: number;
    firstStepMae: number;
    firstStepRmse: number;
    validRowsByHorizon: number[];
  } | null;
  horizonCases: Array<{ episode: number; validRows: number; padding?: Array<{ frame: number; offset: number }> }>;
};
const fixtureApi = await import("./index.mjs" as string) as {
  fixtureJob(name: string): ParsedJob;
  fixtureJobs(name: string): ParsedJob[];
  fixtureNames: string[];
  fixtureSnapshot(name: string): FixtureSnapshot;
};
const { fixtureJob, fixtureJobs, fixtureNames, fixtureSnapshot } = fixtureApi;

function onlyJob(name: string) {
  const jobs = fixtureJobs(name);
  expect(jobs).toHaveLength(1);
  const job = jobs[0];
  if (!job) throw new Error(`Expected one job for fixture ${name}`);
  return jobSchema.parse(job);
}

function closeEnough(actual: number, expected: number) {
  expect(Math.abs(actual - expected)).toBeLessThan(1e-12);
}

function resultFor(job: ParsedJob) {
  if (!job.result) throw new Error(`Fixture ${job.id} has no result`);
  return job.result;
}

function deriveEpisodeCoverage(job: ParsedJob, episode: number) {
  const result = resultFor(job);
  const coverage = result.coverage;
  if (!coverage) throw new Error(`Fixture ${job.id} has no coverage`);
  const episodeCoverage = coverage.episodes.find((item) => item.episode === episode);
  if (!episodeCoverage) throw new Error(`Fixture ${job.id} has no episode ${episode} coverage`);
  const samples = result.samples.filter((sample) => sample.episode === episode);
  const trace = result.traces.find((item) => item.episode === episode);
  if (!trace) throw new Error(`Fixture ${job.id} has no episode ${episode} trace`);
  const horizon = coverage.horizon;
  const validRowsByHorizon = Array.from({ length: horizon }, (_, offset) =>
    samples.filter((sample) => sample.valid[offset] === true).length);
  const geometricFullAnchors = samples.filter((sample) =>
    sample.frame + horizon <= episodeCoverage.originalFrames).length;
  const fullyValidChunks = samples.filter((sample) =>
    sample.frame + horizon <= episodeCoverage.originalFrames &&
    sample.valid.every((valid) => valid)).length;
  return {
    episodeCoverage,
    samples,
    trace,
    derived: {
      originalFrames: trace.frames.length,
      scoredAnchors: samples.length,
      geometricFullAnchors,
      fullyValidChunks,
      geometricTailAnchors: samples.length - geometricFullAnchors,
      validRowsByHorizon,
      validRows: validRowsByHorizon.reduce((sum, count) => sum + count, 0),
    },
  };
}

test("every selectable fixture job parses with the production job schema", () => {
  let parsedJobs = 0;
  for (const name of fixtureNames) {
    for (const job of fixtureJobs(name)) {
      jobSchema.parse(job);
      parsedJobs += 1;
    }
  }
  expect(parsedJobs).toBeGreaterThan(0);
  fkRequestSchema.parse(fixtureSnapshot("fk-certified").fkRequest);
  expect(fixtureJob("legacy-run").result?.actionNames).toHaveLength(16);
  expect(fixtureJob("rby1-16").result?.actionNames).toHaveLength(16);
  expect(fixtureJob("fk-certified").result?.actionNames).toHaveLength(16);
});

test("scalar-padding scores raw first steps and only valid retained chunk values", () => {
  const result = resultFor(onlyJob("scalar-padding"));
  const errors = result.samples.flatMap((sample) =>
    sample.valid.flatMap((valid, offset) => valid
      ? [Math.abs((sample.predicted[offset]?.[0] ?? NaN) - (sample.target[offset]?.[0] ?? NaN))]
      : []));
  const chunkMae = errors.reduce((sum, error) => sum + error, 0) / errors.length;
  const chunkRmse = Math.sqrt(errors.reduce((sum, error) => sum + error * error, 0) / errors.length);
  const trace = result.traces[0];
  if (!trace) throw new Error("Scalar-padding fixture is missing its trace");
  const firstStepErrors = trace.predicted.map((row, index) =>
    Math.abs((row[0] ?? NaN) - (trace.target[index]?.[0] ?? NaN)));
  const firstStepMae = firstStepErrors.reduce((sum, error) => sum + error, 0) / firstStepErrors.length;
  const firstStepRmse = Math.sqrt(firstStepErrors.reduce((sum, error) => sum + error * error, 0) / firstStepErrors.length);

  expect(result.traces[0]?.frames).toEqual([0, 1]);
  expect(result.samples.map(({ episode, frame }) => [episode, frame])).toEqual([[3, 0], [3, 1]]);
  expect(errors).toEqual([0, 10, 2]);
  expect(result.perHorizon.map(({ count }) => count)).toEqual([2, 1, 0]);
  expect(chunkMae).toBe(4);
  closeEnough(chunkRmse, Math.sqrt(104 / 3));
  expect(result.mae).toBe(chunkMae);
  expect(result.rmse).toBe(chunkRmse);
  expect(firstStepErrors).toEqual([0, 2]);
  expect(firstStepMae).toBe(1);
  closeEnough(firstStepRmse, Math.sqrt(2));
  expect(result.firstStepMae).toBe(firstStepMae);
  expect(result.firstStepRmse).toBe(firstStepRmse);
  expect(result.perEpisode).toEqual([{
    episode: trace.episode,
    framesEvaluated: trace.frames.length,
    mae: firstStepMae,
    rmse: firstStepRmse,
  }]);
  expect(fixtureSnapshot("scalar-padding").quantitativeFacts).toEqual({
    episode: 3,
    firstStepErrors,
    retainedChunkErrors: [[0, 10, null], [2, null, null]],
    chunkMae,
    chunkRmse,
    firstStepMae,
    firstStepRmse,
    validRowsByHorizon: [2, 1, 0],
  });
});

test("horizon fixture masks independently reproduce per-episode coverage", () => {
  const job = onlyJob("horizon-boundaries");
  const result = resultFor(job);
  if (!result.coverage) throw new Error("Horizon boundary fixture is missing coverage");
  expect(result.coverage.horizon).toBe(40);
  expect(result.traces.map(({ episode, frames }) => [episode, frames.at(-1)])).toEqual([
    [100, 99], [40, 39], [10, 9], [1, 0],
  ]);

  const expected = new Map([
    [100, { frames: 100, scoredAnchors: 100, validRows: 3220 }],
    [40, { frames: 40, scoredAnchors: 40, validRows: 820 }],
    [10, { frames: 10, scoredAnchors: 10, validRows: 55 }],
    [1, { frames: 1, scoredAnchors: 1, validRows: 1 }],
  ]);
  const derivedEpisodes = [];
  for (const [episode, facts] of expected) {
    const { episodeCoverage, samples, trace, derived } = deriveEpisodeCoverage(job, episode);
    expect(trace.frames).toEqual(Array.from({ length: facts.frames }, (_, frame) => frame));
    expect(samples.map(({ frame }) => frame)).toEqual(trace.frames);
    expect(derived).toEqual({
      originalFrames: facts.frames,
      scoredAnchors: facts.scoredAnchors,
      geometricFullAnchors: Math.max(facts.frames - 40 + 1, 0),
      fullyValidChunks: Math.max(facts.frames - 40 + 1, 0),
      geometricTailAnchors: facts.frames - Math.max(facts.frames - 40 + 1, 0),
      validRowsByHorizon: Array.from({ length: 40 }, (_, offset) => Math.max(facts.frames - offset, 0)),
      validRows: facts.validRows,
    });
    expect(episodeCoverage).toEqual({ episode, ...derived });
    derivedEpisodes.push({ episode, ...derived });
  }
  const aggregateRowsByHorizon = Array.from({ length: 40 }, (_, offset) =>
    result.samples.filter((sample) => sample.valid[offset]).length);
  expect(result.coverage.validRowsByHorizon).toEqual(aggregateRowsByHorizon);
  expect(result.coverage.validRows).toBe(aggregateRowsByHorizon.reduce((sum, count) => sum + count, 0));
  expect(result.coverage.scoredAnchors).toBe(derivedEpisodes.reduce((sum, item) => sum + item.scoredAnchors, 0));
  expect(result.coverage.geometricFullAnchors).toBe(derivedEpisodes.reduce((sum, item) => sum + item.geometricFullAnchors, 0));
  expect(result.coverage.fullyValidChunks).toBe(derivedEpisodes.reduce((sum, item) => sum + item.fullyValidChunks, 0));
  expect(result.perHorizon.map(({ count }) => count)).toEqual(aggregateRowsByHorizon);
  expect(fixtureSnapshot("horizon-boundaries").horizonCases).toEqual(derivedEpisodes.map((item) => ({
    episode: item.episode,
    frames: item.originalFrames,
    horizon: 40,
    scoredAnchors: item.scoredAnchors,
    geometricFullAnchors: item.geometricFullAnchors,
    fullyValidChunks: item.fullyValidChunks,
    geometricTailAnchors: item.geometricTailAnchors,
    validRows: item.validRows,
    validRowsByHorizon: item.validRowsByHorizon,
  })));
});

test("interior padding and episode boundaries remain explicit and unbridged", () => {
  const interiorJob = onlyJob("horizon-interior-padding");
  const interior = deriveEpisodeCoverage(interiorJob, 30);
  expect(interior.trace.frames).toEqual([0, 1, 2]);
  expect(interior.samples.map(({ episode, frame }) => [episode, frame])).toEqual([[30, 0], [30, 1], [30, 2]]);
  expect(interior.derived).toEqual({
    originalFrames: 3,
    scoredAnchors: 3,
    geometricFullAnchors: 1,
    fullyValidChunks: 0,
    geometricTailAnchors: 2,
    validRowsByHorizon: [3, 1, 1],
    validRows: 5,
  });
  expect(interior.episodeCoverage).toEqual({ episode: 30, ...interior.derived });
  expect(resultFor(interiorJob).coverage?.validRowsByHorizon).toEqual([3, 1, 1]);
  expect(interior.samples[0]?.valid).toEqual([true, false, true]);
  expect(fixtureSnapshot("horizon-interior-padding").horizonCases[0]?.padding).toEqual([{ frame: 0, offset: 1 }]);

  const separateJob = onlyJob("horizon-multiple-episodes");
  const first = deriveEpisodeCoverage(separateJob, 31);
  const second = deriveEpisodeCoverage(separateJob, 32);
  expect(first.trace.frames).toEqual([0, 1, 2]);
  expect(second.trace.frames).toEqual([0, 1]);
  expect(first.samples.map(({ episode, frame }) => [episode, frame])).toEqual([[31, 0], [31, 1], [31, 2]]);
  expect(second.samples.map(({ episode, frame }) => [episode, frame])).toEqual([[32, 0], [32, 1]]);
  expect(first.derived.validRowsByHorizon).toEqual([3, 2, 1, 0]);
  expect(second.derived.validRowsByHorizon).toEqual([2, 1, 0, 0]);
  expect(first.derived.validRows + second.derived.validRows).toBe(9);
  expect(resultFor(separateJob).coverage?.validRowsByHorizon).toEqual([5, 3, 1, 0]);
  expect(fixtureSnapshot("horizon-multiple-episodes").horizonCases.map((item) => item.episode)).toEqual([31, 32]);
});

test("unrelated raw fixture payloads retain their established serialized values", () => {
  const protectedFixtures = ["legacy-run", "rby1-16", "fk-certified"];
  for (const name of protectedFixtures) {
    const digest = createHash("sha256").update(JSON.stringify(fixtureJobs(name))).digest("hex");
    expect(digest).toBe("107cc6b8f518890684a5893b1f32e5956a1252af8616f31d2512dd6ace2935f0");
  }
});

test("fixture builders return isolated job objects", () => {
  const first = fixtureJob("scalar-padding");
  const second = fixtureJob("scalar-padding");
  if (!first.result?.samples[0]?.predicted[0] || !second.result?.samples[0]?.predicted[0]) {
    throw new Error("Expected fresh scalar-padding chunk arrays");
  }
  first.result.samples[0].predicted[0][0] = -1;
  expect(first.result.samples[0].predicted[0][0]).toBe(-1);
  expect(second.result.samples[0].predicted[0][0]).toBe(0);
});
