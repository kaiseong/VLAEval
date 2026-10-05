import { expect, test } from "bun:test";
import { createElement, isValidElement } from "react";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { jobSchema } from "../../src/contracts";
import { selectTraceWindow } from "../../src/client/analysis/series";
import { DetailPanel } from "../../src/client/results/DetailPanel";
import type { DetailPanelProps, DetailPlotContext } from "../../src/client/results/DetailPanel";
import { ChunkPanel } from "../../src/client/results/ChunkPanel";
import type { ChunkPanelProps, ChunkPlotContext } from "../../src/client/results/ChunkPanel";
import { MetricTables } from "../../src/client/results/MetricTables";

// Parse the actual corrected Q03 source fixture, without duplicating its math.
const fixturePath = "../fixtures/redesign/index.mjs";
const fixtures: unknown = await import(fixturePath);
if (typeof fixtures !== "object" || fixtures === null
  || !("fixtureJob" in fixtures) || typeof fixtures.fixtureJob !== "function") {
  throw new Error("Fixture module must export fixtureJob");
}
const q03 = jobSchema.parse(fixtures.fixtureJob("scalar-padding")).result;
const generic = jobSchema.parse(fixtures.fixtureJob("generic-run")).result;
if (q03 === null || generic === null) throw new Error("Completed fixtures must contain results");

// Exact EP99 reproduction from task10/verification/mount.jsx.
const noChunksTrace = {
  episode: 99, frames: [0, 3, 9, 12, 15, 18],
  predicted: [[99], [100], [101], [102], [103], [104]],
  target: [[0], [0], [0], [0], [0], [0]],
};
const detailProps: DetailPanelProps = {
  result: { ...q03, traces: [...q03.traces, noChunksTrace] },
  selectedEpisode: 99, selectedDimension: 0, sourceFrame: 18,
  window: { startFrame: 9, endFrame: 18 },
  onEpisodeChange: () => {}, onDimensionChange: () => {},
  onSourceFrameChange: () => {}, onWindowChange: () => {},
  renderPlot: () => createElement("svg", { "data-plot": "detail" }),
};
const chunkProps: ChunkPanelProps = {
  result: q03, selectedEpisode: 3, selectedOriginFrame: 0,
  selectedHorizon: 1, selectedDimension: 0,
  onEpisodeChange: () => {}, onOriginFrameChange: () => {},
  onHorizonChange: () => {}, onDimensionChange: () => {},
  renderPlot: () => createElement("svg", { "data-plot": "chunk" }),
};

function nodes(node: unknown): readonly ReactElement<Record<string, unknown>>[] {
  if (Array.isArray(node)) return node.flatMap((child: unknown) => nodes(child));
  if (!isValidElement<Record<string, unknown>>(node)) return [];
  return [node, ...nodes(node.props.children)];
}

function changeControl(tree: unknown, id: string, value: number): void {
  const control = nodes(tree).find((node) => node.props.id === id);
  const handler = control?.props.onChange;
  if (typeof handler !== "function") throw new Error(`Missing change handler for ${id}`);
  handler({ target: { value: String(value), valueAsNumber: value } });
}

test("detail forwards the full trace and controlled context when episode has no retained chunk", () => {
  // Given the recorded six-frame episode and a narrow inclusive window.
  const contexts: DetailPlotContext[] = [];
  const props = { ...detailProps, renderPlot: (context: DetailPlotContext) => {
    contexts.push(context);
    return createElement("svg", { "data-plot": "detail" });
  } };
  // When the actual exported component renders.
  const markup = renderToStaticMarkup(createElement(DetailPanel, props));
  // Then the slot receives every raw row, including the final original frame.
  const context = contexts[0];
  expect(context?.series.frames).toEqual(noChunksTrace.frames);
  expect(context?.series.predicted).toEqual(noChunksTrace.predicted);
  expect(context?.series.target).toEqual(noChunksTrace.target);
  expect(context?.selectedEpisode).toBe(99);
  expect(context?.selectedDimension).toBe(0);
  expect(context?.sourceFrame).toBe(18);
  expect(context?.window).toEqual(props.window);
  expect(context?.onSourceFrameChange).toBe(props.onSourceFrameChange);
  expect(context?.onWindowChange).toBe(props.onWindowChange);
  if (context === undefined) throw new Error("Plot slot was not rendered");
  expect(selectTraceWindow(context.series, context.window).map((row) => row.frame)).toEqual([9, 12, 15, 18]);
  expect(markup).toContain('<svg data-plot="detail">');
  expect(markup).toContain('data-window-count="4"');
});

test("detail inspector uses original frame lookup when the frame is not an array index", () => {
  // Given source frame18 at raw row5.
  const props = detailProps;
  // When the actual inspector renders.
  const markup = renderToStaticMarkup(createElement(DetailPanel, props));
  // Then it exposes the exact raw values, not an empty slice at index18.
  expect(markup).toContain('data-source-frame="18"');
  expect(markup).toContain('<dd data-value="predicted">104</dd>');
  expect(markup).toContain('<dd data-value="target">0</dd>');
});

test("detail inspector is unavailable when an original frame is absent", () => {
  // Given a gap between original frames3 and9.
  const props = { ...detailProps, sourceFrame: 6 };
  // When the actual inspector renders.
  const markup = renderToStaticMarkup(createElement(DetailPanel, props));
  // Then no nearest row is substituted.
  expect(markup).toMatch(/<p role="status" data-source-frame="6">/);
  expect(markup).not.toContain('data-value="predicted"');
});

test("detail controls emit callbacks without changing their controlled values", () => {
  // Given distinct externally controlled values and callback receivers.
  const changes: unknown[] = [];
  const props: DetailPanelProps = { ...detailProps,
    onEpisodeChange: (value) => changes.push(value),
    onDimensionChange: (value) => changes.push(value),
    onSourceFrameChange: (value) => changes.push(value),
    onWindowChange: (value) => changes.push(value),
  };
  // When callbacks attached to the production control tree are dispatched.
  const tree = DetailPanel(props);
  changeControl(tree, "episode-select", 3);
  changeControl(tree, "dimension-select", 1);
  changeControl(tree, "source-frame", 9);
  changeControl(tree, "window-start", 3);
  changeControl(tree, "window-end", 15);
  // Then only the requested parent changes are emitted.
  expect(changes).toEqual([3, 1, 9, { startFrame: 3, endFrame: 18 }, { startFrame: 9, endFrame: 15 }]);
  expect(nodes(tree).find((node) => node.props.id === "source-frame")?.props.value).toBe(18);
});

test("detail renders the selected dimension when parent props change", () => {
  // Given the real two-dimensional fixture, with dimension1 selected.
  const props = { ...detailProps, result: generic, selectedEpisode: 3, selectedDimension: 1, sourceFrame: 0 };
  // When the production component renders those props.
  const markup = renderToStaticMarkup(createElement(DetailPanel, props));
  // Then its raw inspector uses the fixture's second channel.
  expect(markup).toContain(`<dd data-value="predicted">${generic.traces[0]?.predicted[0]?.[1]}</dd>`);
});

test("chunk forwards the exact retained identity and masks padded horizons", () => {
  // Given Q03's retained origin0 and valid horizon1.
  const contexts: ChunkPlotContext[] = [];
  const props = { ...chunkProps, renderPlot: (context: ChunkPlotContext) => {
    contexts.push(context);
    return createElement("svg", { "data-plot": "chunk" });
  } };
  // When the production component renders.
  const markup = renderToStaticMarkup(createElement(ChunkPanel, props));
  // Then it forwards that exact sample and exposes its selected raw value.
  const context = contexts[0];
  expect(context?.sample).toBe(q03.samples[0]);
  expect(context?.selectedEpisode).toBe(3);
  expect(context?.selectedOriginFrame).toBe(0);
  expect(context?.selectedHorizon).toBe(1);
  expect(context?.selectedDimension).toBe(0);
  expect(context?.onHorizonChange).toBe(props.onHorizonChange);
  expect(context?.points[2]).toEqual({ frame: 2, predicted: undefined, target: undefined });
  expect(markup).toContain('<dd data-value="predicted">10</dd>');
  expect(markup).toContain('data-origin-frame="0" data-horizon="1"');
});

for (const selection of [
  { selectedEpisode: 99 }, { selectedOriginFrame: 9 },
  { selectedHorizon: -1 }, { selectedHorizon: 3 }, { selectedHorizon: 0.5 },
  { selectedHorizon: 2 },
]) {
  test(`chunk is visibly unavailable without substitution when selection is ${JSON.stringify(selection)}`, () => {
    // Given a missing episode/origin, out-of-range, fractional or padded horizon.
    let plots = 0;
    const props = { ...chunkProps, ...selection, renderPlot: () => { plots += 1; return null; } };
    // When the production component renders the requested selection.
    const markup = renderToStaticMarkup(createElement(ChunkPanel, props));
    // Then unavailable is rendered and no other sample reaches the slot.
    expect(markup).toContain('data-availability="unavailable"');
    expect(markup).not.toContain('data-value="predicted"');
    expect(plots).toBe(0);
  });
}

test("chunk controls emit exact identities rather than local sample indexes", () => {
  // Given externally controlled selections and callback receivers.
  const changes: number[] = [];
  const props: ChunkPanelProps = { ...chunkProps,
    onEpisodeChange: (value) => changes.push(value), onOriginFrameChange: (value) => changes.push(value),
    onHorizonChange: (value) => changes.push(value), onDimensionChange: (value) => changes.push(value),
  };
  // When production control callbacks are dispatched.
  const tree = ChunkPanel(props);
  changeControl(tree, "chunk-episode", 99);
  changeControl(tree, "chunk-origin", 1);
  changeControl(tree, "chunk-horizon", 0);
  changeControl(tree, "chunk-dimension", 1);
  // Then each requested value reaches its parent unchanged.
  expect(changes).toEqual([99, 1, 0, 1]);
  expect(nodes(tree).find((node) => node.props.id === "chunk-origin")?.props.value).toBe(0);
});

for (const metricTab of ["episode", "dimension", "horizon"] as const) {
  test(`metric tables preserve source values and scope when tab is ${metricTab}`, () => {
    // Given the actual corrected Q03 fixture and selected scope.
    const props = { result: q03, metricTab, onMetricTabChange: () => {} };
    // When the production table renders.
    const markup = renderToStaticMarkup(createElement(MetricTables, props));
    // Then table cells retain existing scope-specific data, including count0/null errors.
    const rows = Array.from(markup.matchAll(/<tbody>([\s\S]*?)<\/tbody>/g))
      .flatMap((match) => Array.from((match[1] ?? "").matchAll(/<tr>([\s\S]*?)<\/tr>/g)))
      .map((match) => Array.from((match[1] ?? "").matchAll(/<t[hd][^>]*>([^<]*)<\/t[hd]>/g), (cell) => cell[1]));
    const display = (value: number | null) => value === null ? "—" : value.toLocaleString("ko-KR", { maximumFractionDigits: 6 });
    switch (metricTab) {
      case "episode":
        expect(rows).toEqual(q03.perEpisode.map((item) => [`EP ${item.episode}`, String(item.framesEvaluated), display(item.mae), display(item.rmse)]));
        expect(markup).toContain('data-metric-scope="episode-first-step"');
        break;
      case "dimension":
        expect(rows).toEqual(q03.perDimension.map((item) => [item.name, display(item.mae), display(item.rmse)]));
        expect(markup).toContain('data-metric-scope="run-chunk"');
        break;
      case "horizon":
        expect(rows).toEqual(q03.perHorizon.map((item) => [String(item.step), String(item.count), display(item.mae), display(item.rmse)]));
        expect(rows[2]).toEqual(["2", "0", "—", "—"]);
        break;
      default: {
        const exhaustive: never = metricTab;
        throw new Error(`Unexpected tab: ${exhaustive}`);
      }
    }
  });
}

test("metric tab buttons emit the requested scope when clicked", () => {
  // Given a controlled episode tab and callback receiver.
  const tabs: string[] = [];
  const tree = MetricTables({ result: q03, metricTab: "episode", onMetricTabChange: (tab) => tabs.push(tab) });
  // When each actual production button callback fires.
  for (const node of nodes(tree).filter((item) => item.type === "button")) {
    const handler = node.props.onClick;
    if (typeof handler !== "function") throw new Error("Missing tab handler");
    handler();
  }
  // Then scopes are emitted in rendered order.
  expect(tabs).toEqual(["episode", "dimension", "horizon"]);
});
