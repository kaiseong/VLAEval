import React from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { OverviewGrid } from "../../../src/client/results/OverviewGrid";
import { TracePlot } from "../../../src/client/charts/TracePlot";
import { fixtureJob } from "./index.mjs";
import "../../../src/client/styles.css";

export async function mount(element, props = {}) {
  const result = props.fixture ? fixtureJob(props.fixture).result
    : (await fetch("/api/jobs").then((response) => {
      if (!response.ok) throw new Error(`Fixture request failed: ${response.status}`);
      return response.json();
    }))[0].result;
  const trace = result.traces[0];
  const sourceNames = result.actionNames;
  const indices = sourceNames.map((_, i) => i);
  if (props.permuted) indices.reverse();
  const actionNames = indices.map((i) => sourceNames[i]);
  if (props.unknown) actionNames.splice(0, actionNames.length, ...actionNames.map((_, i) => `action_${i}`));
  if (props.duplicate && actionNames.length > 1) actionNames[1] = actionNames[0];
  const series = {
    frames: trace.frames.slice(),
    predicted: trace.predicted.map((row) => indices.map((i) => row[i])),
    target: trace.target.map((row) => indices.map((i) => row[i])),
    fps: result.fps,
  };
  if (props.empty) { series.frames = []; series.predicted = []; series.target = []; }
  if (props.invalid) series.frames = series.frames.map(() => 0);
  const sourceSnapshot = JSON.stringify({ actionNames, series });
  const initialWindow = { startFrame: series.frames[0] ?? 0, endFrame: series.frames.at(-1) ?? 0 };
  const state = { sourceFrame: series.frames[0] ?? null, window: initialWindow, detail: null, actions: [] };
  const root = createRoot(element);
  function render() {
    flushSync(() => root.render(React.createElement("main", {
      "data-qa-showcase": "overview", style: { padding: "var(--s3)", minWidth: 0, maxWidth: "100%" },
    },
    React.createElement("div", { style: { display: "flex", flexWrap: "wrap", gap: "var(--s2)", marginBottom: "var(--s2)" } },
      React.createElement("button", { "data-qa-window": "zoom", onClick: () => { state.window = { startFrame: series.frames[1] ?? 0, endFrame: series.frames.at(-1) ?? 0 }; render(); } }, "Zoom window"),
      React.createElement("button", { "data-qa-window": "full", onClick: () => { state.window = initialWindow; render(); } }, "Full window"),
      React.createElement("button", { "data-qa-reset": true, onClick: () => { state.sourceFrame = null; state.detail = null; state.window = initialWindow; render(); } }, "Reset selection")),
    React.createElement(OverviewGrid, {
      actionNames, series, sourceFrame: state.sourceFrame, window: state.window,
      onFrameSelect(frame) { state.sourceFrame = frame; state.actions.push({ action: "frame", frame }); render(); },
      onDetailOpen(sourceIndex) { state.detail = sourceIndex; state.actions.push({ action: "detail", sourceIndex }); render(); },
    }),
    state.detail !== null && React.createElement("section", { "data-qa-detail-view": state.detail },
      React.createElement("h2", null, `Detail · ${actionNames[state.detail]}`),
      React.createElement(TracePlot, {
        series: { frames: series.frames, fps: series.fps, predicted: series.predicted.map((r) => r[state.detail]), target: series.target.map((r) => r[state.detail]) },
        sourceFrame: state.sourceFrame, window: state.window, yDomain: null,
        labels: { title: actionNames[state.detail], unit: "native / unknown" },
        onFrameSelect(frame) { state.sourceFrame = frame; render(); }, detail: true,
      })))));
  }
  render();
  window.__OVERVIEW_QA__ = {
    state, actionNames, series, sourceSnapshot,
    setSelection(frame) { state.sourceFrame = frame; render(); },
    setWindow(window) { state.window = window; render(); },
    unmount() { root.unmount(); delete window.__OVERVIEW_QA__; },
  };
  element.addEventListener("click", (e) => state.actions.push({ action: "click", trusted: e.isTrusted, target: e.target.tagName }));
  element.addEventListener("keydown", (e) => state.actions.push({ action: "key", key: e.key, trusted: e.isTrusted }));
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  const assertions = [];
  const assert = (name, passed, detail) => assertions.push({ name, passed, detail });
  const panels = [...element.querySelectorAll(".overview-panel")];
  const bounds = panels.map((p) => { const r = p.getBoundingClientRect(); return { name: p.dataset.channelName, sourceIndex: Number(p.dataset.sourceIndex), x: r.x, y: r.y, width: r.width, bottom: r.bottom }; });
  const expected = [
    "right_arm_0", "right_arm_1", "left_arm_0", "left_arm_1",
    "right_arm_2", "right_arm_3", "left_arm_2", "left_arm_3",
    "right_arm_4", "right_arm_5", "left_arm_4", "left_arm_5",
    "right_arm_6", "right_gripper_0", "left_arm_6", "left_gripper_0",
  ];
  const recognized = !props.unknown && !props.duplicate && sourceNames.length === 16 && expected.every((n) => actionNames.includes(n));
  assert("actual-production-overview-mounted", panels.length === actionNames.length, bounds);
  assert("all-original-source-indices-visible", new Set(bounds.map((b) => b.sourceIndex)).size === actionNames.length && bounds.every((b) => actionNames[b.sourceIndex] === b.name), bounds);
  assert("canonical-or-generic-order", JSON.stringify(bounds.map((b) => b.name)) === JSON.stringify(recognized ? expected : actionNames), bounds);
  assert("generic-has-no-invented-arm-groups", recognized || panels.every((p) => p.dataset.side === "generic"), panels.map((p) => p.dataset.side));
  const columns = new Set(bounds.map((b) => Math.round(b.x))).size;
  assert("requested-column-count", columns === Math.min(actionNames.length, innerWidth <= 760 ? 2 : 4), { columns, viewport: innerWidth });
  if (innerWidth > 760 && recognized) {
    assert("four-rows-sixteen-visible-together", new Set(bounds.map((b) => Math.round(b.y))).size === 4 && Math.max(...bounds.map((b) => b.bottom)) <= innerHeight, bounds);
  }
  assert("no-primary-horizontal-overflow", document.documentElement.scrollWidth <= innerWidth, { width: innerWidth, scrollWidth: document.documentElement.scrollWidth });
  assert("one-shared-legend", element.querySelectorAll(".overview__legend").length === 1 && element.querySelectorAll(".trace-plot__legend").length === 0, "Actual compact plots");
  assert("source-data-unchanged", JSON.stringify({ actionNames, series }) === sourceSnapshot, "Full raw trace byte-equivalent");
  assert("no-invalid-path-coordinates", [...element.querySelectorAll("path")].every((p) => !/NaN|Infinity/.test(p.getAttribute("d"))), "Every rendered path checked");
  const timeTicks = [...element.querySelectorAll(".overview-panel svg")].map((svg) => {
    const texts = [...svg.children].filter((child) => child.tagName === "text");
    return texts.slice(0, Math.max(0, texts.length - 2))
      .filter((tick) => getComputedStyle(tick).visibility !== "hidden")
      .map((tick) => tick.getBoundingClientRect().toJSON());
  });
  assert("visible-time-ticks-do-not-overlap", timeTicks.every((ticks) => ticks.every((tick, i) => i === 0 || tick.left >= ticks[i - 1].right)), timeTicks);
  if (props.empty || props.invalid) assert("unavailable-not-zero-filled", panels.every((p) => p.querySelector("[data-mae]").dataset.mae === "unavailable") && !element.querySelector(".overview svg"), element.textContent);
  return assertions;
}
