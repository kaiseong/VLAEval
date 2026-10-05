import React from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { TracePlot } from "../../../src/client/charts/TracePlot";
import "../../../src/client/styles.css";

export function mount(element) {
  const frames = Array.from({ length: 101 }, (_, index) => index);
  const series = { frames, predicted: frames.map((frame) => frame / 100), target: frames.map(() => 0), fps: 30 };
  const original = JSON.stringify(series);
  const root = createRoot(element);
  const state = { sourceFrame: 0, window: { startFrame: 0, endFrame: 100 } };
  function render() {
    flushSync(() => root.render(React.createElement("main", { style: { padding: "var(--s3)" } },
      React.createElement("style", null, ".scaled-chart--scaled svg { height:128px }"),
      ...["scaled", "unscaled"].map((kind) => React.createElement("section", {
        key: kind, className: `scaled-chart--${kind}`, "data-qa-chart": kind,
        style: { maxWidth: "350px", minWidth: 0 },
      }, React.createElement(TracePlot, {
        series, sourceFrame: state.sourceFrame, window: state.window, yDomain: null,
        compact: true, labels: { title: `${kind} dense101`, unit: "native / unknown" },
        onFrameSelect(frame) {
          state.sourceFrame = frame;
          render();
          window.dispatchEvent(new CustomEvent("scaled-chart-selection", { detail: frame }));
        },
      }))))));
  }
  render();
  window.__SCALED_CHART_QA__ = {
    setWindow(startFrame, endFrame) { state.window = { startFrame, endFrame }; render(); },
    setSelection(frame) { state.sourceFrame = frame; render(); },
    rawUnchanged() { return JSON.stringify(series) === original; },
  };
  return [{ name: "actual-independent-TracePlot-dense101", passed:
    element.querySelectorAll(".trace-plot").length === 2 && frames.length === 101 }];
}
