import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import index from "../../index.html";
import type { Job } from "../../src/contracts";
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

test("narrow visible Y intervals retain distinct faithful numeric labels", () => {
  // Given: the actual left gripper interval, a narrow negative joint and scaled extremes.
  for (const [min, max] of [
    [1, 1.0023191526575088],
    [-1.832595705986023, -1.8220442723474304],
    [1e-12, 1.0023191526575088e-12],
    [1e300, 1.0023191526575088e300],
    [-1e300, -0.9976808473424912e300],
    [1, 1.0000000023191526],
    [-1.0000000023191526, -1],
  ] as const) {
    const input = { frames: [0, 1, 2], predicted: [max, min, max], target: [min, min, min], fps: 30 };
    const original = structuredClone(input);
    for (const compact of [false, true]) {
      // When: the real component renders the finite visible interval.
      const rendered = markup({ series: input, window: { startFrame: 0, endFrame: 2 }, compact });
      const ticks = [...rendered.matchAll(/<g><line class="trace-plot__grid"[^>]+><\/line><text[^>]+>([^<]+)<\/text><\/g>/g)]
        .map((match) => match[1] ?? "");
      // Then: each label represents its own tick within a tenth of the tick interval.
      expect(ticks).toHaveLength(3);
      expect(new Set(ticks).size).toBe(3);
      ticks.forEach((tick, index) => {
        const expected = min * (1 - index / 2) + max * (index / 2);
        expect(Number.isFinite(Number(tick))).toBe(true);
        const offset = Number(rendered.match(/data-axis-offset="([^"]+)"/)?.[1] ?? 0);
        const factor = Number(rendered.match(/data-axis-scale="([^"]+)"/)?.[1] ?? 1);
        expect(Math.abs((offset + Number(tick) * factor - expected) / (max - min))).toBeLessThan(0.05);
        expect(tick.length).toBeLessThanOrEqual(12);
      });
      expect(input).toEqual(original);
    }
  }
});

test("closer signed intervals keep their rendered ticks inside readable real App plots", async () => {
  // Given: the independent verifier's exact +/-1 ranges in an isolated fixture job.
  const { fixtureJob }: { fixtureJob: (name: string) => Job } = await import(new URL("../fixtures/redesign/index.mjs", import.meta.url).href);
  const { startHarness }: { startHarness: (options: { baseURL: string; viewport: string; theme: string }) => Promise<{
    openPage: () => Promise<{ evaluate: (script: string) => Promise<unknown>; cdp: (method: string, params: Record<string, unknown>) => Promise<unknown> }>;
    close: () => Promise<unknown>;
  }> } = await import(new URL("../e2e/harness.mjs", import.meta.url).href);
  const job = fixtureJob("rby1-16");
  if (!job.result) throw new Error("Completed chart fixture required");
  for (const trace of job.result.traces) {
    for (const rows of [trace.predicted, trace.target]) rows.forEach((row, i) => {
      row[0] = rows === trace.predicted && i % 2 === 0 ? 1.0000000023191526 : 1;
      row[15] = rows === trace.predicted && i % 2 === 0 ? -1 : -1.0000000023191526;
    });
  }
  const original = JSON.stringify(job);
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, routes: { "/": index }, fetch(request) {
    const path = new URL(request.url).pathname;
    return path === "/api/jobs" ? Response.json([job])
      : path === `/api/jobs/${job.id}` ? Response.json(job) : new Response("Not found", { status: 404 });
  } });
  const harness = await startHarness({ baseURL: server.url.href, viewport: "390x844", theme: "system" });
  try {
    const page = await harness.openPage();
    await page.evaluate('document.documentElement.dataset.theme="dark"');
    for (const dimension of [0, 15]) for (const detail of [false, true]) {
      // When: the current production App presents a compact or detail chart.
      if (detail) {
        const point: { x: number; y: number } = JSON.parse(String(await page.evaluate(`JSON.stringify((()=>{
          const el=document.querySelector('[data-qa-detail="${dimension}"]');el.scrollIntoView({block:'center'});
          const box=el.getBoundingClientRect();
          window.__labelSignal=new Promise((resolve,reject)=>{
            const observer=new MutationObserver(()=>{if(document.querySelector('.detail-panel svg')){observer.disconnect();clearTimeout(timer);resolve(true)}});
            observer.observe(document.documentElement,{subtree:true,childList:true});
            const timer=setTimeout(()=>{observer.disconnect();reject(Error('Detail event deadline'))},5000);
          });
          return {x:box.x+box.width/2,y:box.y+box.height/2};
        })())`)));
        for (const type of ["mousePressed", "mouseReleased"]) await page.cdp("Input.dispatchMouseEvent", { type, ...point, button: "left", clickCount: 1 });
        await page.evaluate("window.__labelSignal");
      }
      const selector = detail ? ".detail-panel .trace-plot" : `[data-source-index="${dimension}"] .trace-plot`;
      await page.evaluate("document.fonts.ready");
      await page.evaluate("new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))");
      const bounds: { contained: boolean; readable: boolean; distinct: boolean } = JSON.parse(String(await page.evaluate(`JSON.stringify((()=>{
        const plot=document.querySelector(${JSON.stringify(selector)}),svg=plot.querySelector('svg');plot.scrollIntoView({block:'center'});
        const box=svg.getBoundingClientRect(),matrix=svg.getScreenCTM(),ticks=[...svg.querySelectorAll('g > .trace-plot__grid + text')];
        return {contained:ticks.every(t=>{const b=t.getBoundingClientRect();return b.left>=box.left-1&&b.right<=box.right+1}),
          readable:ticks.every(t=>parseFloat(getComputedStyle(t).fontSize)*Math.hypot(matrix.a,matrix.b)>=13.9),
          distinct:new Set(ticks.map(t=>t.textContent)).size===3};
      })())`)));
      // Then: actual pixels retain the complete leading/sign glyphs at readable type.
      expect(bounds).toEqual({ contained: true, readable: true, distinct: true });
      if (detail) {
        await page.evaluate(`(()=>{
          window.__labelSignal=new Promise((resolve,reject)=>{
            const observer=new MutationObserver(()=>{if(document.querySelector('[data-source-index="15"] svg')){observer.disconnect();clearTimeout(timer);resolve(true)}});
            observer.observe(document.documentElement,{subtree:true,childList:true});
            const timer=setTimeout(()=>{observer.disconnect();reject(Error('Overview event deadline'))},5000);
          });document.querySelector('[data-close-detail]').click();
        })()`);
        await page.evaluate("window.__labelSignal");
      }
    }
    expect(JSON.stringify(job)).toBe(original);
  } finally {
    expect(await harness.close()).toEqual({ browserOpen: false, serverOpen: false, tempStoreExists: false, cleanupErrors: [] });
    server.stop(true);
  }
}, 30_000);
