import React from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { TracePlot } from "../../../src/client/charts/TracePlot";
import { fixtureJob } from "./index.mjs";
import "../../../src/client/styles.css";

export function mount(element) {
  const result = fixtureJob("irregular-frames").result;
  const trace = result.traces[0];
  const series = {
    frames: trace.frames,
    predicted: trace.predicted.map((row) => row[0]),
    target: trace.target.map((row) => row[0]),
    fps: result.fps,
  };
  const root = createRoot(element);
  const state = { sourceFrame: 0, window: { startFrame: 0, endFrame: 9 }, actions: [] };
  const onFrameSelect = (frame) => {
    state.sourceFrame = frame;
    state.actions.push({ action: "select-original-frame", frame, seconds: frame / series.fps });
    render();
    window.dispatchEvent(new CustomEvent("trace-plot-selection", { detail: { frame, seconds: frame / series.fps } }));
  };
  const panel = (key, title, input, options = {}) => React.createElement("section", {
    key, "data-qa-panel": key,
    style: { minWidth: 0, padding: "var(--s4)", border: "1px solid var(--line)", borderRadius: "var(--radius)", background: "var(--surface)" },
  }, React.createElement(TracePlot, {
    series: input, sourceFrame: state.sourceFrame, window: state.window,
    yDomain: null, labels: { title, unit: "native / unknown" }, onFrameSelect,
    compact: true, ...options,
  }));
  function render() {
    flushSync(() => root.render(React.createElement("main", {
      "data-qa-showcase": "chart-primitive",
      style: { padding: "var(--s4)", maxWidth: "100%", display: "grid", gap: "var(--s4)" },
    },
    React.createElement("header", null,
      React.createElement("h1", null, "Controlled trace plots"),
      React.createElement("p", null, "Prediction: solid · GT: dashed · source frame inspection"),
      React.createElement("p", { "data-qa-selection": true }, `Frame ${state.sourceFrame ?? "unavailable"} · ${state.sourceFrame === null ? "unavailable" : (state.sourceFrame / series.fps).toFixed(3)} s`),
      React.createElement("div", { style: { display: "flex", flexWrap: "wrap", gap: "var(--s2)", marginTop: "var(--s2)" } },
        React.createElement("button", { "data-qa-window": "zoom", onClick: () => { state.window = { startFrame: 3, endFrame: 9 }; render(); } }, "Window 3–9"),
        React.createElement("button", { "data-qa-window": "full", onClick: () => { state.window = { startFrame: 0, endFrame: 9 }; render(); } }, "Full window"),
        React.createElement("button", { "data-qa-reset": true, onClick: () => { state.sourceFrame = null; render(); } }, "Clear selection"))),
    panel("first", "Joint 0 · compact", series),
    panel("second", "Joint 0 · detail", series, { detail: true }),
    panel("single", "Single sample", { frames: [3], predicted: [5], target: [5], fps: 30 }),
    panel("empty", "Empty trace", { frames: [], predicted: [], target: [], fps: 30 }),
    panel("gaps", "Derived gaps", { frames: [0, 3, 6, 9], predicted: [1, null, 2, NaN], target: [null, 3, null, 4], fps: 30 }),
    panel("invalid", "Invalid domain", series, { yDomain: [NaN, 1] }),
    panel("wrap", "Angle wrap", { frames: [0, 3, 9], predicted: [179, -179, -178], target: [178, -178, -177], fps: 30 }, { wrapThreshold: 180, labels: { title: "Angle wrap", unit: "deg" } }))));
  }
  render();
  window.__TRACE_PLOT_QA__ = {
    state,
    setSelection(frame) { state.sourceFrame = frame; render(); },
    setWindow(startFrame, endFrame) { state.window = { startFrame, endFrame }; render(); },
    unmount() { root.unmount(); delete window.__TRACE_PLOT_QA__; },
  };
  element.addEventListener("click", (event) => state.actions.push({ action: "click", trusted: event.isTrusted, target: event.target.tagName }));
  element.addEventListener("keydown", (event) => state.actions.push({ action: "key", key: event.key, trusted: event.isTrusted }));
  const assertions = [];
  const assert = (name, passed, detail) => assertions.push({ name, passed, detail });
  const all = [...element.querySelectorAll(".trace-plot")];
  assert("actual-production-plots-mounted", all.length === 7, JSON.stringify({ plots: all.length }));
  assert("original-irregular-frame-fixture", JSON.stringify(series.frames) === "[0,3,9]" && series.fps === 30, JSON.stringify(series));
  assert("shared-initial-window", all.every((plot) => plot.dataset.windowStart === "0" && plot.dataset.windowEnd === "9"), JSON.stringify(all.map((plot) => plot.dataset)));
  assert("finite-rendered-paths", [...element.querySelectorAll("path")].every((path) => !/NaN|Infinity/.test(path.getAttribute("d"))), "All emitted path coordinates checked");
  assert("single-point-visible", element.querySelectorAll('[data-qa-panel="single"] circle').length === 2, "Two genuine point marks");
  assert("empty-state-visible", element.querySelector('[data-qa-panel="empty"]').textContent.includes("No valid samples"), "No zero line");
  assert("invalid-state-visible", element.querySelector('[data-qa-panel="invalid"]').textContent.includes("Invalid chart data"), "No invalid path");
  assert("derived-gap-not-bridged", [...element.querySelectorAll('[data-qa-panel="gaps"] path')].every((path) => !path.getAttribute("d").includes("L")), "Each separated valid sample is a singleton");
  assert("keyboard-source-control", element.querySelector('[data-qa-panel="first"] svg').getAttribute("role") === "slider", "Native focusable SVG slider");
  assert("ground-truth-dashed", getComputedStyle(element.querySelector(".trace-plot__target path")).strokeDasharray !== "none", "Production isolated chart CSS loaded");
  return assertions;
}
