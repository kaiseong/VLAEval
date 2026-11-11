import { expect, test } from "bun:test";
import { comparisonDifferences, isCompletedEvaluation } from "../../src/client/analysis/run-comparison";
import { evaluationFixture } from "../evaluation-fixture";

test("different model identities and errors can share the same evaluation conditions", () => {
  const base = evaluationFixture(1), other = evaluationFixture(2, 2);
  if (!isCompletedEvaluation(base) || !isCompletedEvaluation(other)) throw new Error("Completed fixtures required");
  expect(comparisonDifferences(base, other)).toEqual([]);
});

test("scope mismatch and incomplete retained data are reported without replacing values", () => {
  const base = evaluationFixture(1), other = evaluationFixture(2, 2);
  if (!isCompletedEvaluation(base) || !isCompletedEvaluation(other)) throw new Error("Completed fixtures required");
  other.result.dataset = "/different";
  other.result.samples = [];
  other.result.fps = 60;
  other.result.numSteps = 20;
  const original = structuredClone(other);
  expect(comparisonDifferences(base, other)).toEqual(["dataset", "fps", "coverage_unknown", "inference_steps"]);
  expect(other).toEqual(original);
});

test("equal counts do not conceal different frame identities or masks", () => {
  const base = evaluationFixture(1), other = evaluationFixture(2);
  if (!isCompletedEvaluation(base) || !isCompletedEvaluation(other)) throw new Error("Completed fixtures required");
  const trace = other.result.traces[0], sample = other.result.samples[0];
  if (!trace || !sample) throw new Error("Fixture rows required");
  trace.frames = [0, 2];
  sample.valid = [false, true];
  expect(comparisonDifferences(base, other)).toEqual(["scored_frames", "valid_masks"]);
});
