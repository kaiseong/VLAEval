import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createChannelLayout } from "../../src/client/analysis/channel-layout";
import { OverviewGrid, overviewChannels, drawnChunks } from "../../src/client/results/OverviewGrid";
import type { OverviewGridProps } from "../../src/client/results/OverviewGrid";

const names = [
  ...Array.from({ length: 7 }, (_, i) => `right_arm_${i}`),
  ...Array.from({ length: 7 }, (_, i) => `left_arm_${i}`),
  "right_gripper_0", "left_gripper_0",
];
const canonical = [
  ...Array.from({ length: 7 }, (_, i) => `left_arm_${i}`), "left_gripper_0",
  ...Array.from({ length: 7 }, (_, i) => `right_arm_${i}`), "right_gripper_0",
];
const series = { frames: [0, 3, 9], predicted: [[0, 1], [2, 3], [10, 5]], target: [[0, 1], [0, 1], [0, 1]], fps: 30 };
function markup(overrides: Partial<OverviewGridProps> = {}) {
  return renderToStaticMarkup(createElement(OverviewGrid, {
    actionNames: ["action_0", "action_1"], series, sourceFrame: 3,
    window: { startFrame: 0, endFrame: 9 },
    onFrameSelect: () => { throw new Error("Static render cannot select"); },
    onDetailOpen: () => { throw new Error("Static render cannot open detail"); },
    ...overrides,
  }));
}

test("canonical display order preserves every source index under all cyclic permutations", () => {
  for (let shift = 0; shift < names.length; shift += 1) {
    const permuted = [...names.slice(shift), ...names.slice(0, shift)].reverse();
    const layout = createChannelLayout(permuted);
    const before = structuredClone(layout);
    const panels = overviewChannels(layout);
    expect(panels.map((p) => p.channelName)).toEqual(canonical);
    expect(panels.map((p) => p.sourceIndex)).toEqual(canonical.map((name) => permuted.indexOf(name)));
    expect(layout).toEqual(before);
  }
});

test("generic unknown duplicate and near-match channels remain visible in source order", () => {
  for (const input of [["x", "y"], names.map((_, i) => `action_${i}`), [...names.slice(0, 15), names[0] ?? ""], ["right_arm_0 ", "left_arm_0"]]) {
    const panels = overviewChannels(createChannelLayout(input));
    expect(panels.map((p) => p.channelName)).toEqual(input);
    expect(panels.map((p) => p.sourceIndex)).toEqual(input.map((_, i) => i));
    expect(panels.every((p) => p.side === "generic")).toBe(true);
    const rendered = markup({ actionNames: input, series: { frames: [0], predicted: [input.map(() => 1)], target: [input.map(() => 0)], fps: 30 } });
    expect((rendered.match(/class="overview-panel"/g) ?? []).length).toBe(input.length);
    expect(rendered).toContain('data-layout="generic"');
  }
});

test("panel metrics use complete first-step raw data even when zoom excludes the largest error", () => {
  const before = structuredClone(series);
  const rendered = markup({ window: { startFrame: 0, endFrame: 3 } });
  const metrics = [...rendered.matchAll(/data-mae="([^"]+)" data-rmse="([^"]+)"/g)].map((match) => [Number(match[1]), Number(match[2])]);
  expect(metrics[0]?.[0]).toBe(4);
  expect(metrics[0]?.[1]).toBeCloseTo(Math.sqrt(104 / 3));
  expect(metrics[1]?.[0]).toBe(2);
  expect(metrics[1]?.[1]).toBeCloseTo(Math.sqrt(20 / 3));
  expect(series).toEqual(before);
});

test("reordered names render the corresponding raw channel values and statistics", () => {
  const inputNames = names.slice().reverse();
  const rendered = markup({ actionNames: inputNames, series: {
    frames: [0], predicted: [inputNames.map((_, i) => i + 1)], target: [inputNames.map(() => 0)], fps: 30,
  }, sourceFrame: 0, window: { startFrame: 0, endFrame: 0 } });
  const firstPanel = rendered.split('class="overview-panel"')[1];
  expect(firstPanel).toContain('data-channel-name="left_arm_0" data-source-index="8"');
  expect(firstPanel).toContain('data-mae="9" data-rmse="9"');
});

test("every plot receives the same controlled frame and window with only one legend", () => {
  const rendered = markup({ sourceFrame: 9, window: { startFrame: 3, endFrame: 9 } });
  expect((rendered.match(/data-source-frame="9" data-window-start="3" data-window-end="9"/g) ?? []).length).toBe(2);
  expect((rendered.match(/class="overview__legend"/g) ?? []).length).toBe(1);
  expect(rendered).not.toContain('class="trace-plot__legend"');
  expect((rendered.match(/data-qa-detail=/g) ?? []).length).toBe(2);
});

test("empty malformed and dimension-mismatched traces never fabricate panel scores", () => {
  for (const input of [
    { frames: [], predicted: [], target: [], fps: 30 },
    { ...series, frames: [0, 3, 3] },
    { ...series, predicted: [[0], [1], [2]] },
    { frames: [0], predicted: [[1]], target: [[0]], fps: 30 },
  ]) {
    const rendered = markup({ series: input });
    expect((rendered.match(/data-mae="unavailable"/g) ?? []).length).toBe(2);
    expect(rendered).not.toContain("<svg");
    expect(rendered).toContain('role="status"');
  }
});

test("RB-Y1 panels split into a left-arm column and a right-arm column", () => {
  const rendered = markup({ actionNames: names, series: { frames: [0], predicted: [names.map(() => 1)], target: [names.map(() => 0)], fps: 30 },
    sourceFrame: 0, window: { startFrame: 0, endFrame: 0 } });
  const [left, right] = rendered.split('data-arm="right"');
  expect(left).toContain('data-arm="left"');
  expect((left?.match(/data-side="left"/g) ?? []).length).toBe(8);
  expect(left).not.toContain('data-side="right"');
  expect((right?.match(/data-side="right"/g) ?? []).length).toBe(8);
});

test("predicted chunks are drawn per anchor over GT and replace the first-step line", () => {
  const chunks = [0, 3, 9].map((frame) => ({ frame, predicted: [[frame, 1], [frame + 1, 2], [frame + 2, 3]],
    target: [[0, 1], [0, 1], [0, 1]], valid: [true, true, false] }));
  const rendered = markup({ chunks, sourceFrame: 3 });
  expect((rendered.match(/data-overlay="chunk-/g) ?? []).length).toBe(6);
  expect((rendered.match(/data-overlay="gt"/g) ?? []).length).toBe(2);
  expect((rendered.match(/trace-plot__overlay--emphasized/g) ?? []).length).toBe(2);
  expect(rendered).toContain("H=3");
  const firstPanel = rendered.split('class="overview-panel"')[1] ?? "";
  expect(firstPanel).not.toMatch(/class="trace-plot__predicted"><g/);
  expect(firstPanel).toContain('data-mae="4"');
});

test("compact legend stays fixed while visible trajectories retain color and selection", () => {
  const chunks = [9, 0, 3].map((frame) => ({
    frame, predicted: [[frame, 1], [frame + 1, 2]],
    target: [[0, 1], [0, 1]], valid: [true, true],
  }));
  const rendered = markup({ chunks, sourceFrame: 9, window: { startFrame: 3, endFrame: 10 } });
  expect([...rendered.matchAll(/data-legend="([^"]+)"/g)].map((entry) => entry[1])).toEqual(["gt", "predicted"]);
  const firstPanel = rendered.split('class="overview-panel"')[1] ?? "";
  for (const [frame, color, selected] of [[3, "hsl(110 75% 45%)", false], [9, "hsl(0 75% 45%)", true]] as const) {
    const path = firstPanel.match(new RegExp(`data-overlay="chunk-${frame}"[^>]*>`));
    expect(path).not.toBeNull();
    expect(path?.[0]).toContain(`stroke="${color}"`);
    expect(path?.[0].includes("trace-plot__overlay--emphasized")).toBe(selected);
  }
});

test("zoom retains chunks whose horizon overlaps the window before its first scored anchor", () => {
  const chunks = [0, 10, 30].map((frame) => ({
    frame, predicted: Array.from({ length: 20 }, () => [1]), target: Array.from({ length: 20 }, () => [2]),
    valid: Array.from({ length: 20 }, () => true),
  }));
  const result = drawnChunks(chunks, { startFrame: 15, endFrame: 20 }, 0);
  expect(result.kept.map(({ chunk }) => chunk.frame)).toEqual([0, 10]);
});

test("detail draws every full valid chunk rather than the overview subset or first steps", () => {
  const chunks = Array.from({ length: 60 }, (_, frame) => ({
    frame, predicted: [[frame, 1], [frame + 1, 2], [frame + 2, 3], [frame + 3, 4]],
    target: [[0, 1], [0, 1], [0, 1], [0, 1]], valid: [true, true, true, false],
  }));
  const rendered = markup({ chunks, detailDimension: 1, sourceFrame: 3, window: { startFrame: 0, endFrame: 61 } });
  expect((rendered.match(/class="trajectory-detail-panel"/g) ?? []).length).toBe(1);
  expect(rendered).toContain('data-channel-name="action_1" data-source-index="1"');
  expect(rendered).toContain('class="trace-plot trace-plot--detail"');
  const paths = [...rendered.matchAll(/data-overlay="chunk-(\d+)"[^>]* d="([^"]+)"/g)];
  expect(paths.map((path) => Number(path[1]))).toEqual(Array.from({ length: 60 }, (_, i) => i));
  for (const path of paths) expect(path[2]?.match(/[ML]/g)).toHaveLength(3);
  expect(rendered).toContain('data-overlay="gt"');
  expect(rendered).not.toContain('class="trace-plot__predicted"><g');
  expect(rendered).not.toContain('class="trace-plot__legend"');
});

test("single-point tails and isolated valid chunk steps remain visible in detail", () => {
  const rendered = markup({ detailDimension: 0, chunks: [
    { frame: 0, predicted: [[1], [2], [3]], target: [[0], [0], [0]], valid: [true, false, true] },
    { frame: 9, predicted: [[4], [5]], target: [[0], [0]], valid: [true, false] },
  ] });
  const points = [...rendered.matchAll(/data-overlay-point="(chunk-\d+)" data-source-frame="(\d+)"/g)];
  expect(points.map((point) => [point[1], Number(point[2])])).toEqual([["chunk-0", 0], ["chunk-0", 2], ["chunk-9", 9]]);
});

test("a single selected chunk retains its color across overview and detail", () => {
  const chunks = [0, 3, 9].map((frame) => ({
    frame, predicted: [[1, 2], [2, 3]], target: [[0, 0], [0, 0]], valid: [true, true],
  }));
  for (const detailDimension of [undefined, 0]) {
    const rendered = markup({ chunks, chunkOrigin: 3, ...(detailDimension === undefined ? {} : { detailDimension }) });
    expect(rendered).toContain('data-overlay="chunk-3" fill="none" stroke="hsl(110 75% 45%)"');
    expect(rendered).not.toContain('data-overlay="chunk-0"');
    expect(rendered).not.toContain('data-overlay="chunk-9"');
    expect(rendered).toContain('data-overlay="gt"');
  }
});
