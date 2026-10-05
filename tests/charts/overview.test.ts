import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createChannelLayout } from "../../src/client/analysis/channel-layout";
import { OverviewGrid, overviewChannels } from "../../src/client/results/OverviewGrid";
import type { OverviewGridProps } from "../../src/client/results/OverviewGrid";

const names = [
  ...Array.from({ length: 7 }, (_, i) => `right_arm_${i}`),
  ...Array.from({ length: 7 }, (_, i) => `left_arm_${i}`),
  "right_gripper_0", "left_gripper_0",
];
const canonical = [
  "right_arm_0", "right_arm_1", "left_arm_0", "left_arm_1",
  "right_arm_2", "right_arm_3", "left_arm_2", "left_arm_3",
  "right_arm_4", "right_arm_5", "left_arm_4", "left_arm_5",
  "right_arm_6", "right_gripper_0", "left_arm_6", "left_gripper_0",
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
  expect(firstPanel).toContain('data-channel-name="right_arm_0" data-source-index="15"');
  expect(firstPanel).toContain('data-mae="16" data-rmse="16"');
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
