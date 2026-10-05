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

test("fractional window end excludes the next source frame and its extreme", () => {
  // Given a finite window whose end lies between two integer source frames.
  const input = { frames: [0, 1, 2], predicted: [0, 1, 100], target: [0, 1, 100], fps: 30 };
  const selectedWindow = { startFrame: 0, endFrame: 1.5 };
  // When the native chart derives its visible geometry and numerical domain.
  const geometry = ready(layout(input, { window: selectedWindow }));
  // Then neither the out-of-window point nor its extreme influences the chart.
  expect(geometry.visible.frames).toEqual([0, 1]);
  expect([geometry.min, geometry.max]).toEqual([0, 1]);
  expect(geometry.paths.predicted.flat().map((point) => point.frame)).toEqual([0, 1]);
  expect(geometry.x(1)).toBeCloseTo(geometry.left + (geometry.right - geometry.left) / 1.5);
  expect(selectedWindow).toEqual({ startFrame: 0, endFrame: 1.5 });
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

test("numeric axis notation stays bounded without zeroing tiny or extreme raw values", () => {
  // Given: genuine finite values, including the singularity-sized negative tick.
  for (const value of [-7.7214e-15, 1e-320, -1e308, 1e308, -126.1, 0, 179]) {
    const input = { frames: [3], predicted: [value], target: [value], fps: 30 };
    const original = structuredClone(input);
    // When: the production component renders an axis and a raw inspector.
    const rendered = markup({ series: input, window: { startFrame: 3, endFrame: 3 }, detail: true });
    const ticks = [...rendered.matchAll(/<text x="[^"]+" y="[^"]+" text-anchor="end">([^<]+)<\/text>/g)]
      .map((match) => match[1] ?? "");
    // Then: axis labels are finite compact numbers; inspection keeps its own precision.
    expect(ticks).toHaveLength(1);
    const tick = ticks[0] ?? "";
    expect(tick.length).toBeLessThanOrEqual(9);
    expect(Number.isFinite(Number(tick))).toBe(true);
    if (value !== 0) {
      expect(Number(tick)).not.toBe(0);
      expect(Math.abs(Number(tick) / value - 1)).toBeLessThan(0.02);
    }
    expect(rendered).toContain(`Prediction ${value.toLocaleString("en-US", { maximumSignificantDigits: 5 })}`);
    expect(input).toEqual(original);
  }
});

test("late narrow windows retain distinct readable absolute time ticks", () => {
  // Given: the parent's late-window reproduction, in both chart presentations.
  const input = { frames: [99980, 99990, 99999], predicted: [0, 1, 2], target: [0, 1, 2], fps: 30 };
  const original = structuredClone(input);
  const lateWindow = { startFrame: 99980, endFrame: 99999 };
  const expectedSeconds = [99980 / 30, 99989.5 / 30, 99999 / 30];
  for (const compact of [false, true]) {
    // When: the actual TracePlot renders the controlled source-frame window.
    const rendered = markup({ series: input, window: lateWindow, sourceFrame: 99990, compact });
    const ticks = [...rendered.matchAll(/<text x="([^"]+)" y="(?:124|304)" text-anchor="([^"]+)">([^<]+)<\/text>/g)];
    // Then: all positions remain distinct and accurate relative to tick spacing.
    expect(ticks).toHaveLength(3);
    const labels = ticks.map((tick) => tick[3] ?? "");
    expect(new Set(labels).size).toBe(3);
    labels.forEach((label, index) => {
      expect(label.length).toBeLessThanOrEqual(9);
      expect(Math.abs(Number(label) - (expectedSeconds[index] ?? NaN))).toBeLessThan(0.01);
    });
    expect(ticks.map((tick) => tick[2])).toEqual(["start", "middle", "end"]);
    expect(ticks.map((tick) => Number(tick[1]))).toEqual([88, 216, 344]);
    expect(rendered).toContain('data-source-frame="99990"');
    expect(rendered).toContain("3333.000 s");
    expect(input).toEqual(original);
  }
});
