import React from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { FKSettings, declaredFKRequest, initialFKSettings } from "../../../src/client/results/FKSettings";
import { FKPanel } from "../../../src/client/results/FKPanel";
import { OverviewGrid } from "../../../src/client/results/OverviewGrid";
import { FkController } from "../../../src/client/analysis/fk-controller";
import { compiledProfileSchema } from "../../../src/kinematics/contracts";
import { deriveForward } from "../../../src/kinematics/forward";
import { buildFkView, fkPoseSeries } from "../../../src/client/analysis/fk-view";
import { rotationError } from "../../../src/kinematics/math";
import { currentFkExport, fkJsonExport, fkCsvExport, rawJsonExport, rawTraceCsv } from "../../../src/client/analysis/exports";
import { fixtureSnapshot } from "./index.mjs";
import "../../../src/client/styles.css";

export async function mount(element, props = {}) {
  const snapshot = fixtureSnapshot("fk-certified");
  const job = snapshot.jobs[0], template = snapshot.fkRequest;
  const result = job.result, trace = result.traces[0];
  const rawBefore = { json: rawJsonExport(result), csv: rawTraceCsv(result) };
  let profiles, profile = null;
  if (props.live) {
    const response = await fetch("/api/kinematics/profiles");
    if (!response.ok) throw new Error(`Catalog HTTP ${response.status}`);
    profiles = (await response.json()).profiles;
  } else profiles = [template.profile];
  const state = { settings: { ...initialFKSettings }, fk: { status: "unavailable", reason: "FK is off" },
    sourceFrame: 0, window: { startFrame: 0, endFrame: 2 }, episode: 3, events: [], request: null };
  const root = createRoot(element);
  const held = [];
  let holdNext = false;
  const controller = new FkController((next) => { state.fk = next; render(); }, () => {
    const worker = new Worker("/assets/fk.worker.js", { type: "module" });
    if (!holdNext) return worker;
    holdNext = false;
    // Hold only actual production Worker messages; retain the old callback to probe generation rejection.
    const adapter = { onmessage: null, onerror: null, onmessageerror: null,
      postMessage(command, transfer) { const deliver = adapter.onmessage; worker.postMessage(command, transfer);
        worker.onmessage = (event) => {
          if (event.data.kind !== "view" || event.data.serial !== 0) { deliver?.(event); return; }
          held.push(() => deliver?.(event)); state.events.push({ action: "held-worker-result", generation: command.request.generation }); signal();
        }; },
      terminate() { worker.terminate(); } };
    worker.onerror = (event) => adapter.onerror?.(event);
    worker.onmessageerror = (event) => adapter.onmessageerror?.(event);
    return adapter;
  });
  let sequence = 0;
  function signal() { document.dispatchEvent(new CustomEvent("fk-showcase-change", { detail: ++sequence })); }
  function select() {
    const selection = { sourceFrame: state.sourceFrame, window: state.window };
    if (props.live) controller.select(selection);
    else if (state.fk.status === "ready" && state.completed) state.fk = { ...state.fk,
      view: buildFkView(fkPoseSeries(state.completed, result.fps), selection),
      selected: state.completed.samples.find(sample => sample.frame === state.sourceFrame) ?? null };
    render();
  }
  let selection = 0;
  async function change(settings) {
    const token = ++selection;
    state.settings = settings;
    controller.invalidate("FK declaration changed");
    render();
    try {
      profile = null;
      if (settings.profileHash) {
        profile = props.live ? compiledProfileSchema.parse(await fetch(`/api/kinematics/profiles/${settings.profileHash}`).then((r) => {
          if (!r.ok) throw new Error(`Profile HTTP ${r.status}`);
          return r.json();
        })) : template.profile;
      }
      if (token !== selection) return;
      const source = { ...template, episode: state.episode };
      const admission = declaredFKRequest(settings, profile, source);
      if (admission.kind === "unavailable") controller.invalidate(admission.reason);
      else {
        state.request = admission.request;
        if (props.live) controller.start(admission.request, { sourceFrame: state.sourceFrame, window: state.window });
        else {
          state.completed = deriveForward({ ...admission.request, generation: 1 });
          const { samples, ...metadata } = state.completed;
          state.fk = { status: "ready", result: { ...metadata, frameCount: samples.length,
            firstFrame: samples[0]?.frame ?? null, lastFrame: samples.at(-1)?.frame ?? null },
            view: buildFkView(fkPoseSeries(state.completed, result.fps), { sourceFrame: state.sourceFrame, window: state.window }),
            selected: samples.find(sample => sample.frame === state.sourceFrame) ?? null };
          render();
        }
      }
    } catch (error) {
      if (token === selection) controller.invalidate(error instanceof Error ? error.message : String(error));
    }
  }
  function render() {
    flushSync(() => root.render(React.createElement("main", { "data-qa-showcase": "fk", style: { padding: "var(--s3)", minWidth: 0 } },
      React.createElement("h1", null, "FK component showcase"),
      React.createElement("p", null, props.live ? "QA: actual catalog API and production Worker; synthetic recorded actions." : "QA: synthetic component data, not integrated result acceptance."),
      React.createElement(FKSettings, { value: state.settings, profiles, onChange: change }),
      React.createElement("div", { className: "fk-showcase-actions" },
        React.createElement("button", { "data-fk-zoom": true, onClick() {
          state.window = { startFrame: 1, endFrame: 2 };
          select();
        } }, "Zoom frame window"),
        React.createElement("button", { "data-fk-episode": true, onClick() { state.episode++; change(state.settings); } }, "Switch episode"),
        React.createElement("button", { "data-fk-hold": true, onClick() { holdNext = true; change(state.settings); } }, "Hold next Worker result"),
        React.createElement("button", { "data-fk-release": true, onClick() { held.splice(0).forEach((release) => release()); signal(); } }, "Release old Worker results"),
        React.createElement("button", { "data-fk-numeric": "yaw", onClick() {
          const request = structuredClone(template);
          request.episode = state.episode;
          request.jointUnit = "deg";
          request.frames = [0, 1, 2].map((frame) => ({ frame, predicted: Array(16).fill(0), target: Array(16).fill(0) }));
          request.frames[0].predicted[0] = 179;
          request.frames[0].target[0] = -179;
          request.frames[1].predicted[0] = -179;
          request.frames[1].target[0] = 179;
          // 0.1m shoulder-relative X at zero; pi rotation yields a 0.2m position error.
          for (const side of ["right", "left"]) request.profile[`${side}Chain`].at(-1).origin.xyz = [0.1, 0, 0];
          profile = request.profile;
          state.request = request;
          state.sourceFrame = 0;
          controller.start(request, { sourceFrame: state.sourceFrame, window: state.window });
        } }, "Probe yaw wrap and SI conversion"),
        React.createElement("button", { "data-fk-numeric": "singular", onClick() {
          const request = structuredClone(template);
          request.episode = state.episode;
          request.jointUnit = "deg";
          for (const side of ["right", "left"]) request.profile[`${side}Chain`][0].axis = [0, 1, 0];
          request.frames = [0, 1, 2].map((frame) => ({ frame, predicted: Array(16).fill(0), target: Array(16).fill(0) }));
          request.frames[0].predicted[0] = 90;
          profile = request.profile;
          state.request = request;
          state.sourceFrame = 0;
          controller.start(request, { sourceFrame: state.sourceFrame, window: state.window });
        } }, "Probe Euler singularity"),
        ...["missing-root", "digest", "mapping", "unknown-profile"].map((failure) => React.createElement("button", {
          key: failure, "data-fk-invalid": failure, onClick() {
            if (failure === "unknown-profile") { change({ ...state.settings, profileHash: "f".repeat(64) }); return; }
            const invalidProfile = structuredClone(profile);
            const source = structuredClone(template);
            if (failure === "missing-root") invalidProfile.rootLink = "";
            if (failure === "digest") invalidProfile.profileHash = "f".repeat(64);
            if (failure === "mapping") source.jointMapping = [];
            const admission = declaredFKRequest(state.settings, invalidProfile, source);
            if (admission.kind !== "unavailable") throw new Error("Invalid probe admitted");
            controller.invalidate(admission.reason);
          },
        }, `Probe ${failure}`)),
        React.createElement("button", { "data-fk-export": true, disabled: state.fk.status !== "ready", async onClick() {
          if (props.live) {
            const json = await currentFkExport(controller, "json"), csv = await currentFkExport(controller, "csv");
            if (!json || !csv) throw new Error("No matching derivation");
            state.exports = { json: { ...json, content: await json.content.text() }, csv: { ...csv, content: await csv.content.text() } };
            signal(); return;
          }
          const completed = state.completed;
          if (!completed || !profile) throw new Error("No matching derivation");
          const input = { identity: completed, completed, context: { profile, sourceJobId: job.id, sourceEpisode: state.episode } };
          state.exports = { json: fkJsonExport(input), csv: fkCsvExport(input) };
          signal();
        } }, "Prepare derived export")),
      React.createElement(FKPanel, { state: state.fk, frames: state.request?.frames.map(sample => sample.frame) ?? [],
        fps: result.fps, sourceFrame: state.sourceFrame, window: state.window, onFrameSelect(frame) {
          state.sourceFrame = frame; select();
        } }),
      React.createElement(OverviewGrid, { actionNames: result.actionNames, series: { ...trace, fps: result.fps },
        sourceFrame: state.sourceFrame, window: state.window, onFrameSelect(frame) { state.sourceFrame = frame; select(); }, onDetailOpen() {} }))));
    signal();
  }
  element.addEventListener("click", (event) => state.events.push({ action: "click", trusted: event.isTrusted }));
  element.addEventListener("keydown", (event) => state.events.push({ action: "key", key: event.key, trusted: event.isTrusted }));
  window.__FK_QA__ = { state, profiles, rawBefore, rawNow: () => ({ json: rawJsonExport(result), csv: rawTraceCsv(result) }),
    async complete() {
      const artifact = await currentFkExport(controller, "json");
      if (!artifact) throw new Error("No current complete result");
      return JSON.parse(await artifact.content.text());
    },
    async quaternionSignError() {
      if (state.fk.status !== "ready") throw new Error("Not ready");
      const completed = props.live ? await this.complete() : state.completed;
      const q = completed.samples[0].arms.right.pose.predicted.quaternionXyzw;
      return rotationError(q, q.map((value) => -value));
    },
    controller, holdCount: () => held.length,
    unmount() { controller.dispose(); root.unmount(); delete window.__FK_QA__; } };
  render();
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  return [
    { name: "actual-controlled-settings-default-off", passed: !element.querySelector("[data-fk-enable]").checked && !element.querySelector("[data-fk-channel]") },
    { name: "raw-sixteen-joint-channels-still-usable", passed: element.querySelectorAll(".overview-panel").length === 16 },
    { name: "no-horizontal-overflow", passed: document.documentElement.scrollWidth <= innerWidth },
  ];
}
