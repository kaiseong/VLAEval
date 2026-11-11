import { describe, expect, test } from "bun:test";
import { brushWindow, isZoomed, panWindow, wheelPixels } from "../../src/client/charts/time-zoom";
import { drawnChunks } from "../../src/client/results/OverviewGrid";

const full = { startFrame: 0, endFrame: 1000 };

describe("time zoom", () => {
  test("brush snaps outward to whole frames and stays inside the full window", () => {
    expect(brushWindow(120.4, 80.6, full)).toEqual({ startFrame: 80, endFrame: 121 });
    expect(brushWindow(-50, 30.2, full)).toEqual({ startFrame: 0, endFrame: 31 });
    expect(brushWindow(999.5, 999.6, full)).toEqual({ startFrame: 998, endFrame: 1000 });
    expect(brushWindow(Number.NaN, 3, full)).toBeNull();
  });
  test("pan keeps the span and clamps at both ends", () => {
    const w = { startFrame: 100, endFrame: 200 };
    expect(panWindow(w, full, 30.4)).toEqual({ startFrame: 130, endFrame: 230 });
    expect(panWindow(w, full, -500)).toEqual({ startFrame: 0, endFrame: 100 });
    expect(panWindow(w, full, 5000)).toEqual({ startFrame: 900, endFrame: 1000 });
    expect(panWindow(full, full, 10)).toBe(full);
    expect(isZoomed(w, full)).toBe(true);
    expect(isZoomed(full, full)).toBe(false);
  });
  test("wheel uses the dominant axis and scales lines", () => {
    expect(wheelPixels({ deltaX: 0, deltaY: 120, deltaMode: 0 }, 800)).toBe(120);
    expect(wheelPixels({ deltaX: -40, deltaY: 10, deltaMode: 0 }, 800)).toBe(-40);
    expect(wheelPixels({ deltaX: 0, deltaY: 3, deltaMode: 1 }, 800)).toBe(48);
  });
});

describe("chunk stride", () => {
  const chunk = (frame: number) => ({ frame, valid: [true, true], predicted: [[0], [0]], target: [[0], [0]] });
  const chunks = Array.from({ length: 12 }, (_, i) => chunk(i + 5)) as never[];
  const frames = (list: never[], sel: number, stride: number) =>
    drawnChunks(list, { startFrame: 0, endFrame: 100 }, sel, Infinity, stride).kept.map(({ chunk: c }) => (c as { frame: number }).frame);
  test("keeps every Nth inference by rank and always the selected one", () => {
    expect(frames(chunks, 8, 3)).toEqual([5, 8, 11, 14]);
    expect(frames(chunks, 9, 4)).toEqual([5, 9, 13]);
  });
  test("sparse inference frames still thin by inference count", () => {
    const sparse = Array.from({ length: 6 }, (_, i) => chunk(i * 3)) as never[];
    expect(frames(sparse, -1, 3)).toEqual([0, 9]);
  });
});
