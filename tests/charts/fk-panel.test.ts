import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { declaredFKRequest, FKSettings, initialFKSettings } from "../../src/client/results/FKSettings";
import { FKPanel, fkPoseSeries } from "../../src/client/results/FKPanel";
import { deriveForward } from "../../src/kinematics/forward";
import { fkRequestSchema } from "../../src/kinematics/contracts";
import { tracePlotGeometry } from "../../src/client/charts/TracePlot";
import { buildFkView } from "../../src/client/analysis/fk-view";
const fixtureModule = "../fixtures/redesign/index.mjs";
const { fixtureSnapshot } = await import(fixtureModule);
const request = fkRequestSchema.parse(fixtureSnapshot("fk-certified").fkRequest);
const configured = { enabled: true, profileHash: request.profileHash, jointUnit: "rad",
  representation: "absolute_joint_position", nominalSignZeroConfirmed: true } as const;

test("FK admission stays off until every explicit declaration is supplied", () => {
  for (const value of [initialFKSettings, { ...configured, profileHash: "" }, { ...configured, jointUnit: "" as const },
    { ...configured, representation: "delta" as const }, { ...configured, representation: "velocity" as const },
    { ...configured, representation: "unknown" as const }, { ...configured, nominalSignZeroConfirmed: false }]) {
    const admitted = declaredFKRequest(value, request.profile, request);
    expect(admitted.kind).toBe("unavailable");
  }
  expect(declaredFKRequest(configured, request.profile, request).kind).toBe("ready");
});

test("unknown model data, missing root, digest and incompatible maps reject only FK", () => {
  for (const profile of [null, { ...request.profile, rootLink: "" }, { ...request.profile, schemaVersion: 2 },
    { ...request.profile, profileHash: "c".repeat(64) }]) {
    expect(declaredFKRequest(configured, profile, request).kind).toBe("unavailable");
  }
  expect(declaredFKRequest(configured, request.profile, { ...request, jointMapping: [] }).kind).toBe("unavailable");
  const raw = structuredClone(request.frames);
  declaredFKRequest(configured, request.profile, { ...request, actionNames: Array(16).fill("unknown") });
  expect(request.frames).toEqual(raw);
});

test("controlled settings render no silent selected profile or units", () => {
  const html = renderToStaticMarkup(createElement(FKSettings, { value: initialFKSettings, profiles: [request.profile], onChange: () => {} }));
  expect(html).not.toMatch(/checked=""/);
  expect(html.match(/<option value="" selected=""/g)?.length).toBe(3);
  expect(html.match(/disabled=""/g)?.length).toBe(4);
});

test("twelve pose channels convert display only and preserve singular components", () => {
  const result = deriveForward(request);
  const first = result.samples[0];
  if (!first) throw new Error("Missing fixture frame");
  first.arms.right.pose.predicted.translationM = [0.1, 0.2, 0.3];
  first.arms.right.pose.predicted.rpyDeg = [null, 90, null];
  const before = JSON.stringify(result);
  const channels = fkPoseSeries(result, 30);
  expect(channels).toHaveLength(12);
  expect(channels[0]?.series.predicted[0]).toBe(100);
  expect(channels[3]?.series.predicted[0]).toBeNull();
  expect(channels[4]?.series.predicted[0]).toBe(90);
  expect(JSON.stringify(result)).toBe(before);
});

test("pose panel keeps separate units counts and shared frame window", () => {
  const result = deriveForward(request);
  const { samples, ...metadata } = result;
  const selection = { sourceFrame: 1, window: { startFrame: 1, endFrame: 2 } };
  const html = renderToStaticMarkup(createElement(FKPanel, { state: { status: "ready",
    result: { ...metadata, frameCount: samples.length, firstFrame: 0, lastFrame: 2 },
    view: buildFkView(fkPoseSeries(result, 30), selection), selected: samples[1] ?? null },
    frames: samples.map((sample) => sample.frame), fps: 30,
    sourceFrame: 1, window: { startFrame: 1, endFrame: 2 }, onFrameSelect: () => {} }));
  expect(html.match(/data-fk-channel=/g)).toHaveLength(12);
  expect(html.match(/data-fk-error="translationM"/g)).toHaveLength(2);
  expect(html.match(/data-fk-error="orientationRad"/g)).toHaveLength(2);
  expect(html.match(/data-source-frame="1"/g)?.length).toBe(24);
  expect(html.match(/data-window-start="1"/g)).toHaveLength(12);
  expect(html).toContain('data-fk-generation="1"');
});

test("wraps and nullable yaw remain gaps while valid position remains plotted", () => {
  const result = deriveForward(request);
  result.samples.forEach((sample, index) => { sample.arms.right.pose.predicted.rpyDeg = [0, 0, [179, -179, null][index] ?? null]; });
  const channel = fkPoseSeries(result, 30).find((item) => item.side === "right" && item.axis === "Yaw");
  if (!channel) throw new Error("Missing yaw");
  const geometry = tracePlotGeometry({ series: channel.series, window: { startFrame: 0, endFrame: 2 },
    yDomain: null, width: 360, height: 160, wrapThreshold: 180 });
  expect(geometry.kind).toBe("ready");
  if (geometry.kind !== "ready") throw new Error("Missing geometry");
  expect(geometry.paths.predicted.map((segment) => segment.map((point) => point.frame))).toEqual([[0], [1]]);
  expect(fkPoseSeries(result, 30)[0]?.series.predicted.every((value) => value !== null)).toBe(true);
});

test("pending and unavailable states have no stale pose channels", () => {
  for (const state of [{ status: "pending", generation: 2 }, { status: "unavailable", reason: "profile mismatch" }] as const) {
    const html = renderToStaticMarkup(createElement(FKPanel, { state, frames: request.frames.map((sample) => sample.frame), fps: 30, sourceFrame: 1,
      window: { startFrame: 0, endFrame: 2 }, onFrameSelect: () => {} }));
    expect(html).not.toContain("data-fk-channel");
    expect(html).toContain('role="status"');
  }
});

test("scenario rejects unknown case rather than printing misleading success", async () => {
  const path = "../e2e/scenarios/fk.mjs";
  const { runScenario } = await import(path);
  await expect(runScenario({ args: { case: "unsupported" } })).rejects.toBeInstanceOf(Error);
});
