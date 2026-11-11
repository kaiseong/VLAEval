import { expect, test } from "bun:test";
import { resultSchema } from "../src/contracts";
import { resultFixture } from "./result-fixture";

test("accepts legacy results without MSE fields", () => {
  // Given / When
  const result = resultSchema.parse(resultFixture);
  // Then
  expect(result.mse).toBeUndefined();
  expect(result.firstStepMse).toBeUndefined();
  expect(result.perEpisode[0]?.mse).toBeUndefined();
  expect(result.perDimension[0]?.mse).toBeUndefined();
  expect(result.perHorizon[0]?.mse).toBeUndefined();
  expect(result.perEpisodeChunks).toBeUndefined();
});

test("retains optional full chunk episode metrics", () => {
  // Given
  const perEpisodeChunks = [{ episode: 3, framesEvaluated: 3, validSteps: 5, mae: 2, mse: 9, rmse: 3 }];
  // When
  const result = resultSchema.parse({ ...resultFixture, perEpisodeChunks });
  // Then
  expect(result.perEpisodeChunks).toEqual(perEpisodeChunks);
});

test("rejects invalid full chunk counts and metrics", () => {
  // Given
  const chunk = { episode: 3, framesEvaluated: 3, validSteps: 5, mae: 2, mse: 9, rmse: 3 };
  const invalid = [
    { ...chunk, validSteps: -1 }, { ...chunk, validSteps: 0 }, { ...chunk, validSteps: 1.5 },
    { ...chunk, framesEvaluated: -1 }, { ...chunk, mse: null },
    { ...chunk, mse: -1 }, { ...chunk, mae: Number.NaN }, { ...chunk, rmse: Infinity },
  ];
  // When
  const parsed = invalid.map((item) => resultSchema.safeParse({ ...resultFixture, perEpisodeChunks: [item] }));
  // Then
  expect(parsed.every((item) => !item.success)).toBe(true);
});

test("retains MSE fields and nullable unscored horizons", () => {
  // Given
  const input = {
    ...resultFixture, mse: 0.25, firstStepMse: 0,
    perEpisode: resultFixture.perEpisode.map((episode) => ({ ...episode, mse: 0.5 })),
    perDimension: resultFixture.perDimension.map((dimension) => ({ ...dimension, mse: 0.75 })),
    perHorizon: [
      { step: 0, count: 3, mae: 0.1, rmse: 0.5, mse: 0.25 },
      { step: 1, count: 0, mae: null, rmse: null, mse: null },
    ],
  };
  // When
  const result = resultSchema.parse(input);
  // Then
  expect(result).toEqual(input);
});

for (const invalid of [-1, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, null]) {
  test(`rejects invalid MSE values ${String(invalid)} at every metric scope`, () => {
    // Given
    const inputs = [
      { ...resultFixture, mse: invalid },
      { ...resultFixture, firstStepMse: invalid },
      { ...resultFixture, perEpisode: resultFixture.perEpisode.map((item) => ({ ...item, mse: invalid })) },
      { ...resultFixture, perDimension: resultFixture.perDimension.map((item) => ({ ...item, mse: invalid })) },
      ...(invalid === null ? [] : [
        { ...resultFixture, perHorizon: resultFixture.perHorizon.map((item) => ({ ...item, mse: invalid })) },
      ]),
    ];
    // When
    const results = inputs.map((input) => resultSchema.safeParse(input));
    // Then
    expect(results.every((result) => !result.success)).toBe(true);
  });
}
