import { expect, test } from "bun:test";
import { z } from "zod";
import { initialPredictionSettings, matchingColumns, declaredPredictionSeed, declaredPredictionSource } from "../../src/client/results/prediction-settings";
import { inspectOverviewFrame } from "../../src/client/results/overview-inspection";
import { derivePrediction } from "../../src/client/analysis/prediction";
import { predictionDataSchema, predictionRequestSchema } from "../../src/client/analysis/prediction-contracts";
import { predictionExport } from "../../src/client/analysis/prediction-export";
import { overviewDisplayChannels } from "../../src/client/results/overview-channels";
import { createChannelLayout } from "../../src/client/analysis/channel-layout";

const names = ["right", "left"].flatMap((side) => Array.from({ length: 7 }, (_, i) => `${side}_arm_${i}`));
const canonical = ["left", "right"].flatMap((side) => [...Array.from({ length: 7 }, (_, i) => `${side}_arm_${i}`), `${side}_gripper_0`]);

test("recognized joint names provide exact mapping without inferring units, semantics or a seed", () => {
  const value = initialPredictionSettings(names);
  expect(value.kind).toBe("joint");
  expect(value.left).toEqual([7, 8, 9, 10, 11, 12, 13]);
  expect(value.right).toEqual([0, 1, 2, 3, 4, 5, 6]);
  expect(value.unit).toBe("unknown");
  expect(value.representation).toBe("unknown");
  expect(declaredPredictionSeed(value, [])).toBeNull();
  expect(initialPredictionSettings(["x", "y"]).kind).toBe("unknown");
});

test("Cartesian mapping honors named columns and requires explicit rotation and units", () => {
  const actionNames = ["right", "left"].flatMap((side) => ["x", "y", "z", "rx", "ry", "rz"].map((axis) => `${side}_${axis}`));
  const value = { ...initialPredictionSettings(actionNames), kind: "cartesian" as const, ...matchingColumns(actionNames, "cartesian", "rpy_xyz") };
  expect(declaredPredictionSource(value).source).toBeNull();
  const ready = declaredPredictionSource({ ...value, positionUnit: "m", orientation: "rpy_xyz", angleUnit: "rad" });
  expect(ready.source?.kind).toBe("cartesian");
  if (ready.source?.kind !== "cartesian") throw new Error("Expected Cartesian declaration");
  expect(ready.source.left.position).toEqual([6, 7, 8]);
  expect(ready.source.right.rotation).toEqual([3, 4, 5]);
  expect(ready.source.referenceFrame).toBe("unknown");
});

test("manual and observed seeds stay explicit and never substitute missing values", () => {
  const value = initialPredictionSettings(names);
  const manual = { ...value, seedKind: "manual" as const, seedUnit: "rad" as const,
    leftSeed: "0, 1, 2, 3, 4, 5, 6", rightSeed: "7 8 9 10 11 12 13" };
  expect(declaredPredictionSeed(manual, [])).toEqual({ kind: "manual", unit: "rad", positions: Array.from({ length: 14 }, (_, i) => i) });
  expect(declaredPredictionSeed({ ...manual, leftSeed: "0,1" }, [])).toBeNull();
  const observations = [{ frame: 19, positions: Array<number>(14).fill(0.2) }];
  expect(declaredPredictionSeed({ ...value, seedKind: "observed" }, observations)).toBeNull();
  expect(declaredPredictionSeed({ ...value, seedKind: "observed", seedUnit: "deg" }, observations))
    .toEqual({ kind: "observed", unit: "deg", samples: observations });
});

test("single-chunk inspection filters values without changing the global color identity", () => {
  const chunks = [0, 1, 2].map((frame) => ({ frame, predicted: [[frame], [frame + 1], [frame + 2]],
    target: [[0], [0], [0]], valid: [true, true, true] }));
  const input = { frame: 2, dimension: 0, series: { frames: [0], predicted: [[0]], target: [[0]], fps: 30 },
    chunks, drawnFrames: new Set([1]) };
  const all = inspectOverviewFrame(input);
  const single = inspectOverviewFrame({ ...input, origin: 1 });
  expect(single.predictions).toEqual(all.predictions.filter((prediction) => prediction.origin === 1));
  expect(single.predictions[0]?.color).toBe("hsl(110 75% 45%)");
});

test("coordinate exports preserve full chunks, provenance, masks and missing grippers", () => {
  const value = initialPredictionSettings(names);
  const source = declaredPredictionSource({ ...value, unit: "deg" }).source;
  const request = predictionRequestSchema.parse({
    actionNames: names, source, profile: null, seed: null,
    series: { frames: [4], predicted: [names.map((_, i) => i)], target: [names.map(() => 0)], fps: 30 },
    chunks: [{ frame: 4, predicted: [names.map(() => 1), names.map(() => 2)], target: [names.map(() => 0), names.map(() => 0)], valid: [true, false] }],
  });
  const result = derivePrediction(request);
  const channels = overviewDisplayChannels(createChannelLayout(canonical), false)
    .map((channel) => ({ ...channel, unit: channel.kind === "gripper" ? "native / unknown" : "deg" }));
  const input = { jobId: "job", episode: 2, coordinate: "joint" as const, request, result, channels };
  const json = predictionExport({ ...input, format: "json" });
  const data = predictionDataSchema.extend({ provenance: z.string(), actionNames: z.array(z.string()) })
    .parse(JSON.parse(json?.content ?? "{}"));
  expect(data.provenance).toBe("source");
  expect(data.actionNames).toEqual(names);
  expect(data.chunks).toHaveLength(1);
  expect(data.chunks[0]?.valid).toEqual([true, false]);
  expect(data.series.predicted[0]?.[7]).toBeNull();
  const csv = predictionExport({ ...input, format: "csv" })?.content.split("\n") ?? [];
  expect(csv).toHaveLength(4);
  expect(csv[0]).toContain('"source_valid"');
  expect(csv[3]).toContain('"chunk","4","1","5"');
  expect(csv[3]).toContain('"false"');
  expect(predictionExport({ ...input, coordinate: "cartesian", format: "json" })).toBeNull();
});
