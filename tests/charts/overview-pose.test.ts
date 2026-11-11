import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { OverviewGrid } from "../../src/client/results/OverviewGrid";
import { overviewPoints, inspectOverviewFrame } from "../../src/client/results/overview-inspection";

const actionNames = [
  ...Array.from({ length: 7 }, (_, i) => `right_arm_${i}`),
  ...Array.from({ length: 7 }, (_, i) => `left_arm_${i}`), "right_gripper_0", "left_gripper_0",
];
const series = { frames: [0, 1, 2], fps: 30,
  predicted: Array.from({ length: 3 }, () => actionNames.map(() => 0.1)),
  target: Array.from({ length: 3 }, () => actionNames.map(() => 0)),
};
const pose = {
  series: { frames: [0, 1, 2], fps: 30,
    predicted: [[10, 20, 30, 179, 40, 50, 0.5, 60, 70, 80, 90, 10, 20, 0.7],
      [11, 21, 31, -179, 41, 51, 0.5, 61, 71, 81, 91, 11, 21, 0.7],
      [12, 22, 32, null, 42, null, 0.5, 62, 72, 82, 92, 12, 22, 0.7]],
    target: Array.from({ length: 3 }, () => Array.from({ length: 14 }, () => 0)),
  },
  chunks: [],
};

test("FK overview replaces joint panels with six pose axes and one native gripper per side", () => {
  const rendered = renderToStaticMarkup(createElement(OverviewGrid, {
    actionNames, series, pose, sourceFrame: 1, window: { startFrame: 0, endFrame: 2 },
    onFrameSelect: () => {}, onDetailOpen: () => {},
  }));
  const panels = [...rendered.matchAll(/data-channel-name="([^"]+)" data-source-index="(\d+)"/g)];
  expect(panels.map((panel) => panel[1])).toEqual(["left", "right"].flatMap((side) =>
    ["x", "y", "z", "rx", "ry", "rz", "gripper"].map((axis) => `${side}_${axis}`)));
  expect(panels.map((panel) => Number(panel[2]))).toEqual(Array.from({ length: 14 }, (_, i) => i));
  expect([...rendered.matchAll(/data-unit="([^"]+)"/g)].map((match) => match[1]))
    .toEqual(["mm", "mm", "mm", "deg", "deg", "deg", "native / unknown",
      "mm", "mm", "mm", "deg", "deg", "deg", "native / unknown"]);
  expect(rendered).not.toContain("data-mae=");
  expect([...rendered.matchAll(/data-qa-detail="(\d+)"/g)].map((match) => Number(match[1])))
    .toEqual(Array.from({ length: 14 }, (_, i) => i));
  expect(rendered).toContain('data-coordinate-mode="fk"');
});

test("pose tooltip uses transformed coordinates and preserves singular missing components", () => {
  const translation = inspectOverviewFrame({ frame: 2, dimension: 0, series: pose.series, chunks: [], drawnFrames: new Set() });
  const rotation = inspectOverviewFrame({ frame: 2, dimension: 3, series: pose.series, chunks: [], drawnFrames: new Set() });
  expect(translation.firstStep).toBe(12);
  expect(rotation.firstStep).toBeNull();
  expect(rotation.target).toBe(0);
});

test("nullable and wrap boundaries split overlay geometry without changing valid values", () => {
  const points = overviewPoints([
    { frame: 0, value: 179 }, { frame: 1, value: -179 }, { frame: 2, value: -178 },
    { frame: 3, value: null }, { frame: 4, value: 12 },
  ], 180);
  expect(points).toEqual([
    { frame: 0, value: 179, breakBefore: true },
    { frame: 1, value: -179, breakBefore: true },
    { frame: 2, value: -178, breakBefore: false },
    { frame: 4, value: 12, breakBefore: true },
  ]);
});

test("FK detail renders every derived rotation chunk with units and wrap gaps", () => {
  const chunks = Array.from({ length: 50 }, (_, frame) => ({
    frame, predicted: [179, -179, -178, null].map((rotation) =>
      Array.from({ length: 14 }, (_, i) => i === 3 ? rotation : i)),
    target: Array.from({ length: 4 }, () => Array<number>(14).fill(0)), valid: [true, true, true, true],
  }));
  const rendered = renderToStaticMarkup(createElement(OverviewGrid, {
    actionNames, series, pose: { ...pose, chunks }, detailDimension: 3, sourceFrame: 0,
    window: { startFrame: 0, endFrame: 52 }, onFrameSelect: () => {}, onDetailOpen: () => {},
  }));
  expect(rendered).toContain('data-channel-name="left_rx" data-source-index="3"');
  expect(rendered).toContain('data-unit="deg"');
  expect((rendered.match(/class="trajectory-detail-panel"/g) ?? []).length).toBe(1);
  const paths = [...rendered.matchAll(/data-overlay="chunk-\d+"[^>]* d="([^"]+)"/g)];
  expect(paths).toHaveLength(50);
  for (const path of paths) expect(path[1]?.match(/[ML]/g)).toEqual(["M", "M", "L"]);
  expect(rendered).not.toContain("data-qa-detail=");
});
