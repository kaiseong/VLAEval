import { expect, test } from "bun:test";
import type { Job } from "../../src/contracts";
import { comparisonDifferences, isCompletedEvaluation } from "../../src/client/analysis/run-comparison";
import type { CompletedEvaluation } from "../../src/client/analysis/run-comparison";
import { summarizeJob } from "../../src/job-summary";
import { evaluationFixture } from "../evaluation-fixture";

// The comparison runs on the summaries the API sends, built from the stored (here: edited) full results.
function completed(job: Job): CompletedEvaluation {
  const summary = summarizeJob(job);
  if (!isCompletedEvaluation(summary)) throw new Error("Completed fixtures required");
  return summary;
}

test("different model identities and errors can share the same evaluation conditions", () => {
  expect(comparisonDifferences(completed(evaluationFixture(1)), completed(evaluationFixture(2, 2)))).toEqual([]);
});

test("scope mismatch and incomplete retained data are reported without replacing values", () => {
  const base = evaluationFixture(1), other = evaluationFixture(2, 2);
  if (!other.result) throw new Error("Completed fixtures required");
  other.result.dataset = "/different";
  other.result.samples = [];
  other.result.fps = 60;
  other.result.numSteps = 20;
  const summary = completed(other);
  const original = structuredClone(summary);
  expect(comparisonDifferences(completed(base), summary)).toEqual(["dataset", "fps", "coverage_unknown", "inference_steps"]);
  expect(summary).toEqual(original);
});

test("equal counts do not conceal different frame identities or masks", () => {
  const base = evaluationFixture(1), other = evaluationFixture(2);
  const trace = other.result?.traces[0], sample = other.result?.samples[0];
  if (!trace || !sample) throw new Error("Fixture rows required");
  trace.frames = [0, 2];
  sample.valid = [false, true];
  expect(comparisonDifferences(completed(base), completed(other))).toEqual(["scored_frames", "valid_masks"]);
});
