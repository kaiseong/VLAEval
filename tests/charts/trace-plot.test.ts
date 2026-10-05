import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { TracePlot, tracePlotGeometry } from "../../src/client/charts/TracePlot";
import type { TracePlotProps, TracePlotSeries } from "../../src/client/charts/TracePlot";

const series: TracePlotSeries = { frames: [0, 3, 9], predicted: [0, 2, 1], target: [1, 1, 2], fps: 30 };
const window = { startFrame: 0, endFrame: 9 };
function layout(input: TracePlotSeries = series, overrides: Partial<Parameters<typeof tracePlotGeometry>[0]> = {}) {
  return tracePlotGeometry({ series: input, window, yDomain: null, width: 360, height: 160, ...overrides });
}
function ready(result: ReturnType<typeof tracePlotGeometry>) {
  expect(result.kind).toBe("ready");
  if (result.kind !== "ready") throw new Error(`Expected ready, got ${result.kind}`);
  return result;
}
function markup(overrides: Partial<TracePlotProps> = {}) {
  return renderToStaticMarkup(createElement(TracePlot, {
    series, window, yDomain: null, sourceFrame: 3,
    labels: { title: "Joint 0", unit: "native / unknown" },
    onFrameSelect: () => { throw new Error("Render cannot select a frame"); },
    ...overrides,
  }));
}

test("irregular source frames determine time-aligned x coordinates and shared windows", () => {
  const original = structuredClone(series);
  const geometry = ready(layout());
  expect((geometry.x(3) - geometry.left) / (geometry.right - geometry.left)).toBeCloseTo(1 / 3);
  const zoom = ready(layout(series, { window: { startFrame: 3, endFrame: 9 } }));
  expect(zoom.visible.frames).toEqual([3, 9]);
  expect(zoom.x(3)).toBe(zoom.left);
  expect(zoom.x(9)).toBe(zoom.right);
  expect(series).toEqual(original);
});

test("empty, invalid domain and misaligned series never create geometry", () => {
  expect(layout({ frames: [], predicted: [], target: [], fps: 30 }).kind).toBe("empty");
  expect(layout(series, { yDomain: [NaN, 1] }).kind).toBe("invalid");
  expect(layout(series, { window: { startFrame: 9, endFrame: 3 } }).kind).toBe("invalid");
  expect(layout({ ...series, fps: 0 }).kind).toBe("invalid");
  expect(layout({ ...series, predicted: [0] }).kind).toBe("invalid");
  expect(layout({ ...series, frames: [0, 3, 3] }).kind).toBe("invalid");
  expect(layout(series, { window: { startFrame: 4, endFrame: 8 } }).kind).toBe("empty");
});

test("single-point constant data has a visible finite centered point", () => {
  const single = { frames: [3], predicted: [5], target: [5], fps: 30 };
  const geometry = ready(layout(single, { window: { startFrame: 3, endFrame: 3 } }));
  expect(geometry.x(3)).toBe((geometry.left + geometry.right) / 2);
  expect(geometry.y(5)).toBe((geometry.top + geometry.bottom) / 2);
  const rendered = markup({ series: single, window: { startFrame: 3, endFrame: 3 } });
  expect((rendered.match(/<circle /g) ?? []).length).toBe(2);
  expect(rendered).not.toMatch(/NaN|Infinity/);
});

test("derived null, NaN and angle wraps split paths rather than zero-fill or bridge", () => {
  const input = { frames: [0, 1, 2, 3, 4], predicted: [179, -179, null, 8, NaN], target: [1, 2, 3, null, 5], fps: 30 };
  const geometry = ready(layout(input, { wrapThreshold: 180 }));
  expect(geometry.paths.predicted.map((s) => s.map((v) => v.frame))).toEqual([[0], [1], [3]]);
  expect(geometry.paths.target.map((s) => s.map((v) => v.frame))).toEqual([[0, 1, 2], [4]]);
  expect(geometry.paths.predicted.flat().map((v) => v.value)).toEqual([179, -179, 8]);
  expect(markup({ series: input, wrapThreshold: 180 })).not.toMatch(/NaN|Infinity/);
});

test("extreme and tiny finite domains map to finite display coordinates", () => {
  for (const [min, max] of [[-1e308, 1e308], [1e-320, 2e-320], [0, 0]] as const) {
    const geometry = ready(layout({ frames: [0, 3, 9], predicted: [min, max, min], target: [max, min, max], fps: 30 }, { yDomain: [min, max] }));
    expect(Number.isFinite(geometry.y(min))).toBe(true);
    expect(Number.isFinite(geometry.y(max))).toBe(true);
    if (min !== max) {
      expect(geometry.y(min)).toBe(geometry.bottom);
      expect(geometry.y(max)).toBe(geometry.top);
    }
  }
});

test("raw selection is controlled, including missing frame rather than nearest replacement", () => {
  const selected = markup();
  expect(selected).toContain('data-source-frame="3"');
  expect(selected).toContain('aria-valuenow="3"');
  expect(selected).toContain("0.100 s");
  const absent = markup({ sourceFrame: 4 });
  expect(absent).toContain('data-selection-status="unavailable"');
  expect(absent).not.toContain('aria-valuenow=');
  expect(absent).not.toContain('class="trace-plot__cursor"');
  const reset = markup({ sourceFrame: null });
  expect(reset).toContain('data-source-frame="unavailable"');
});

test("shared sampler bounds both paths and marks unrenderable gap density", () => {
  const length = 100_000;
  const large = { frames: Array.from({ length }, (_, i) => i), predicted: Array.from({ length }, (_, i) => i % 2 ? null : 1), target: Array.from({ length }, () => 2), fps: 30 };
  const geometry = ready(layout(large, { window: { startFrame: 0, endFrame: length - 1 } }));
  expect(geometry.sampled.vertexCount).toBeLessThanOrEqual(4096);
  expect(geometry.sampled.unavailableBands.length).toBeGreaterThan(0);
  expect(geometry.paths.predicted.every((segment) => segment.length === 1)).toBe(true);
  expect(markup({ series: large, window: { startFrame: 0, endFrame: length - 1 } })).toContain('data-gap-density="unavailable"');
});

test("supplied geometry follows the same controlled window and domain", () => {
  const source = ready(layout());
  const zoom = ready(layout(series, { window: { startFrame: 3, endFrame: 9 }, yDomain: [-5, 5], geometry: source.sampled }));
  expect(zoom.paths.predicted.flat().map((v) => v.frame)).toEqual([3, 9]);
  expect(zoom.min).toBe(-5);
  expect(zoom.max).toBe(5);
});
