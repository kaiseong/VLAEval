import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import index from "../../../index.html";
import { jobSchema } from "../../../src/contracts";
import { fixtureJob } from "../../fixtures/redesign/index.mjs";

const channels = fixtureJob("rby1-16").result.actionNames;
const keyCodes = { Home: 36, ArrowDown: 40, Tab: 9 };

function rby1CoverageJob(fixture) {
  const job = jobSchema.parse(fixtureJob(fixture));
  const result = job.result;
  if (!result) throw new Error(`Missing result for ${fixture}`);
  result.actionNames = channels;
  result.perDimension = channels.map((name) => ({ name, mae: 0, rmse: 0 }));
  result.traces = result.traces.map((trace) => ({
    ...trace,
    predicted: trace.frames.map(() => channels.map(() => 0)),
    target: trace.frames.map(() => channels.map(() => 0)),
  }));
  result.samples = result.samples.map((sample) => ({
    ...sample,
    predicted: sample.valid.map((valid) => channels.map(() => valid ? 0 : -1_000_000_000)),
    target: sample.valid.map((valid) => channels.map(() => valid ? 0 : 1_000_000_000)),
  }));
  return jobSchema.parse(job);
}

function legacySubsetJob() {
  const job = jobSchema.parse(fixtureJob("legacy-run"));
  const result = job.result;
  if (!result) throw new Error("Legacy fixture has no result");
  job.id = "00000000-0000-4000-8000-000000000019";
  job.request.stride = 2;
  job.request.maxSamples = 3;
  const frames = [0, 2, 4];
  result.framesEvaluated = frames.length;
  result.validSteps = frames.length;
  result.actionNames = channels;
  result.traces = [{
    episode: 3,
    frames,
    predicted: frames.map(() => channels.map(() => 0.1)),
    target: frames.map(() => channels.map(() => 0)),
  }];
  result.perEpisode = [{ episode: 3, framesEvaluated: frames.length, mae: 0.1, rmse: 0.1 }];
  result.perDimension = channels.map((name) => ({ name, mae: 0.1, rmse: 0.1 }));
  return jobSchema.parse(job);
}

function check(context, assertion) { context.assertions.push({ ...assertion, passed: assertion.passed === true }); if (assertion.passed !== true) throw new Error(`Assertion failed: ${assertion.name}: ${JSON.stringify(assertion.detail)}`); }

async function arm(context, expression) {
  await context.page.evaluate(`(()=>{window.__task19Signal=new Promise((resolve,reject)=>{
    const test=()=>(${expression});if(test())return resolve(true);
    const observer=new MutationObserver(()=>{if(test()){observer.disconnect();clearTimeout(timer);resolve(true)}});
    observer.observe(document.documentElement,{subtree:true,childList:true,attributes:true,characterData:true});
    const timer=setTimeout(()=>{observer.disconnect();reject(new Error("Task19 DOM signal timed out"))},10000);
  });return true})()`);
}

async function key(context, name) {
  const code = keyCodes[name] ?? (name === "ArrowDown" ? 40 : 13);
  await context.page.cdp("Input.dispatchKeyEvent", {
    type: "keyDown", key: name, code: name, windowsVirtualKeyCode: code, nativeVirtualKeyCode: code,
  });
  await context.page.cdp("Input.dispatchKeyEvent", {
    type: "keyUp", key: name, code: name, windowsVirtualKeyCode: code, nativeVirtualKeyCode: code,
  });
  context.actions.push({ action: "trusted-key", key: name });
}

async function click(context, selector) {
  await context.page.evaluate(`(()=>{const element=document.querySelector(${JSON.stringify(selector)});
    if(!element)throw new Error("Missing target "+${JSON.stringify(selector)});
    element.scrollIntoView({block:"center",behavior:"instant"});
    window.__task19Trusted=false;
    element.addEventListener("click",event=>window.__task19Trusted=event.isTrusted,{once:true});
    return true})()`);
  await context.page.click(selector);
  const trusted = await context.page.evaluate("window.__task19Trusted === true");
  if (!trusted) throw new Error(`Click was not trusted: ${selector}`);
  context.actions.push({ action: "click", selector, trusted });
}

async function selectValue(context, selection) {
  const { selector, value, expected } = selection;
  const position = await context.page.evaluate(`Array.from(document.querySelector(${JSON.stringify(selector)}).options)
    .findIndex(option=>option.value===${JSON.stringify(String(value))})`);
  if (position < 0) throw new Error(`Option ${value} missing from ${selector}`);
  await arm(context, expected);
  await click(context, selector);
  await key(context, "Home");
  for (let index = 0; index < position; index += 1) await key(context, "ArrowDown");
  await key(context, "Tab");
  await context.page.evaluate("window.__task19Signal");
}

async function selectLastFrame(context, value) {
  const selector = "#workspace-frame";
  await arm(context, `document.querySelector('.result-workspace')?.dataset.sourceFrame==='${value}'`);
  await click(context, selector);
  await context.page.cdp("Input.dispatchKeyEvent", {
    type: "keyDown", key: "Control", code: "ControlLeft", windowsVirtualKeyCode: 17,
    nativeVirtualKeyCode: 17,
  });
  await context.page.cdp("Input.dispatchKeyEvent", {
    type: "keyDown", key: "a", code: "KeyA", modifiers: 2, windowsVirtualKeyCode: 65,
    nativeVirtualKeyCode: 65,
  });
  await context.page.cdp("Input.dispatchKeyEvent", {
    type: "keyUp", key: "a", code: "KeyA", modifiers: 2, windowsVirtualKeyCode: 65,
    nativeVirtualKeyCode: 65,
  });
  await context.page.cdp("Input.dispatchKeyEvent", {
    type: "keyUp", key: "Control", code: "ControlLeft", windowsVirtualKeyCode: 17,
    nativeVirtualKeyCode: 17,
  });
  await context.page.cdp("Input.insertText", { text: String(value) });
  await key(context, "Enter");
  await context.page.evaluate("window.__task19Signal");
  const selected = await read(context, `document.querySelector('.result-workspace')?.dataset.sourceFrame`);
  check(context, { name: `last-scored-frame-${value}-is-selected-in-workspace`, passed: selected === String(value), detail: { selected, expected: value } });
  await context.page.evaluate("document.activeElement instanceof HTMLElement && document.activeElement.blur()");
  await screenshot(context, `coverage-last-frame-${value}-${context.width}x${context.height}-${context.theme}`);
}

async function read(context, expression) { return JSON.parse(await context.page.evaluate(`JSON.stringify(${expression})`)); }

async function screenshot(context, name, end = false) {
  const { page, outputPath, width, height, theme } = context;
  if (end) await page.evaluate("(()=>{const main=document.querySelector('main');main.scrollTo({top:main.scrollHeight,behavior:'instant'});window.scrollTo({top:document.documentElement.scrollHeight,behavior:'instant'});return new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))})()");
  await page.evaluate("document.fonts.ready");
  const capture = await page.cdp("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
  const bytes = Buffer.from(capture.data, "base64");
  const signature = bytes.subarray(0, 8).toString("hex");
  const dimensions = { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  const path = join(outputPath, `${name}.png`);
  await writeFile(path, bytes);
  check(context, { name: `screenshot-${name}-is-composited-at-requested-viewport`,
    passed: signature === "89504e470d0a1a0a" && dimensions.width === width && dimensions.height === height,
    detail: { path, signature, dimensions, theme } });
  context.actions.push({ action: "screenshot", path, ...dimensions, theme });
}

async function assertEpisode(context, expected) {
  if (expected.episode !== 100) await selectValue(context, { selector: "#workspace-episode", value: expected.episode,
    expected: `document.querySelector('.result-workspace')?.dataset.episode==='${expected.episode}'` });
  const observed = await read(context, `(()=>{const summary=document.querySelector('.coverage-summary');
    const plots=[...document.querySelectorAll('.overview-panel .trace-plot')];
    return {episode:Number(summary.dataset.coverageEpisode),known:summary.dataset.coverageKnown,
      scored:Number(summary.dataset.scoredAnchors),original:Number(summary.dataset.originalFrames),
      full:Number(summary.dataset.geometricFull),tail:Number(summary.dataset.geometricTail),
      valid:Number(summary.dataset.fullyValid),rows:Number(summary.dataset.validRows),
      last:Number(summary.dataset.lastScoredFrame),subset:summary.dataset.subset,
      panelCount:plots.length,plotMaxima:plots.map(plot=>Number(plot.querySelector('svg').getAttribute('aria-valuemax'))),
      pathEnds:plots.flatMap(plot=>[...plot.querySelectorAll('[data-source-frame-end]')].map(path=>Number(path.dataset.sourceFrameEnd)))}})()`);
  const matches = observed.episode === expected.episode && observed.known === "recorded"
    && observed.scored === expected.frames && observed.original === expected.frames
    && observed.full === expected.full && observed.tail === expected.tail
    && observed.valid === expected.valid && observed.rows === expected.rows
    && observed.last === expected.last && observed.subset === "false"
    && observed.panelCount === 16 && observed.plotMaxima.every((frame) => frame === expected.last)
    && observed.pathEnds.length === 32 && observed.pathEnds.every((frame) => frame === expected.last);
  check(context, { name: `episode-${expected.episode}-coverage-and-final-frame`, passed: matches, detail: observed });
  const visibleScopes = await context.page.evaluate(`(()=>{const summary=document.querySelector('.coverage-summary');
    const scopes=[...summary.querySelectorAll('[data-coverage-scope]')].map(item=>item.dataset.coverageScope);
    return scopes.join(',')==='first-step,future-chunk'&&summary.dataset.warmupExcluded==='true'})()`);
  check(context, { name: `episode-${expected.episode}-visible-scope-labels`, passed: visibleScopes, detail: expected });
  await selectLastFrame(context, expected.last);
}

export async function runScenario({ args, outputPath, startHarness }) {
  if (args.case !== "horizons") throw new Error(`Unsupported coverage case: ${args.case}`);
  const assertions = [], actions = [], requests = [], harnesses = [];
  const jobs = [rby1CoverageJob("horizon-boundaries"), rby1CoverageJob("horizon-interior-padding"),
    rby1CoverageJob("horizon-multiple-episodes"), legacySubsetJob()];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    idleTimeout: 0,
    routes: { "/": index },
    async fetch(request) {
      const path = new URL(request.url).pathname;
      const job = jobs.find((item) => path.endsWith(item.id));
      const response = path === "/api/jobs" ? Response.json(jobs)
        : path.startsWith("/api/jobs/") ? job ? Response.json(job) : Response.json({ error: "Not found" }, { status: 404 })
          : path === "/api/kinematics/profiles" ? Response.json({ profiles: [] })
            : new Response("Not found", { status: 404 });
      requests.push({ method: request.method, path, status: response.status });
      return response;
    },
  });
  const viewports = args.viewport ? [args.viewport] : ["1440x1000", "390x844"];
  const themes = args.theme && args.theme !== "system" ? [args.theme] : ["light", "dark"];
  try {
    for (const viewport of viewports) {
      const [width, height] = viewport.split("x").map(Number);
      if (!width || !height) throw new Error(`Invalid viewport ${viewport}`);
      for (const theme of themes) {
        const harness = await startHarness({ baseURL: server.url.href, viewport, theme: "system" });
        const owned = { harness, closed: false, cleanup: null };
        harnesses.push(owned);
        const page = await harness.openPage();
        const expectedFirst = jobs[0];
        if (!expectedFirst) throw new Error("Horizon fixtures are empty");
        await page.evaluate(`new Promise((resolve,reject)=>{const ready=()=>document.querySelector('.result-workspace')?.dataset.jobId===${JSON.stringify(expectedFirst.id)};
          if(ready())return resolve(true);const observer=new MutationObserver(()=>{if(ready()){observer.disconnect();resolve(true)}});
          observer.observe(document.documentElement,{subtree:true,childList:true,attributes:true});
          setTimeout(()=>{observer.disconnect();reject(new Error('Initial horizon result did not render'))},10000)})`);
        const context = { page, assertions, actions, outputPath, width, height, theme };
        await selectValue(context, { selector: ".rail-footer select", value: theme,
          expected: `document.documentElement.dataset.theme===${JSON.stringify(theme)}` });
        const pageLayout = await read(context, `({width:innerWidth,height:innerHeight,scrollWidth:document.documentElement.scrollWidth,
          mainWidth:document.querySelector('main').scrollWidth,gridBottom:document.querySelector('.overview__grid').getBoundingClientRect().bottom,
          panels:document.querySelectorAll('.overview-panel').length})`);
        await screenshot(context, `coverage-${width}x${height}-${theme}`);
        check(context, { name: `${viewport}-${theme}-layout-keeps-sixteen-panels-fit-and-no-overflow`,
          passed: pageLayout.panels === 16 && pageLayout.scrollWidth <= pageLayout.width && pageLayout.mainWidth <= pageLayout.width
            && (width < 1000 || pageLayout.gridBottom <= height), detail: pageLayout });
        await screenshot(context, `coverage-end-${width}x${height}-${theme}`, true);

        for (const expected of [
          { episode: 100, frames: 100, full: 61, tail: 39, valid: 61, rows: 3220, last: 99 },
          { episode: 40, frames: 40, full: 1, tail: 39, valid: 1, rows: 820, last: 39 },
          { episode: 10, frames: 10, full: 0, tail: 10, valid: 0, rows: 55, last: 9 },
          { episode: 1, frames: 1, full: 0, tail: 1, valid: 0, rows: 1, last: 0 },
        ]) await assertEpisode(context, expected);

        await selectValue(context, { selector: "#history", value: jobs[1]?.id,
          expected: `document.querySelector('.result-workspace')?.dataset.jobId===${JSON.stringify(jobs[1]?.id)}` });
        const interior = await read(context, `(()=>{const e=document.querySelector('.coverage-summary');return {
          full:e.dataset.geometricFull,valid:e.dataset.fullyValid,tail:e.dataset.geometricTail,rows:e.dataset.validRows,
          last:e.dataset.lastScoredFrame}})()`);
        check(context, { name: `${viewport}-${theme}-interior-mask-does-not-rewrite-geometric-tail`,
          passed: interior.full === "1" && interior.valid === "0" && interior.tail === "2" && interior.rows === "5" && interior.last === "2",
          detail: interior });
        await screenshot(context, `coverage-interior-${width}x${height}-${theme}`);

        await selectValue(context, { selector: "#history", value: jobs[2]?.id,
          expected: `document.querySelector('.result-workspace')?.dataset.jobId===${JSON.stringify(jobs[2]?.id)}` });
        await arm(context, "document.querySelector('.result-workspace')?.dataset.view==='metrics'");
        await click(context, '[data-view-tab="metrics"]');
        await context.page.evaluate("window.__task19Signal");
        await arm(context, 'document.querySelector(\'[data-metric-tab="horizon"]\')');
        await click(context, ".metric-tabs button:nth-child(3)");
        await context.page.evaluate("window.__task19Signal");
        const tableCounts = await read(context, `[...document.querySelectorAll('[data-metric-tab="horizon"] tbody tr')].map(row=>Number(row.children[1].textContent.replaceAll(',','')))`);
        check(context, { name: `${viewport}-${theme}-multi-episode-horizon-rows-do-not-bridge`,
          passed: tableCounts.join() === "5,3,1,0", detail: tableCounts });

        await selectValue(context, { selector: "#history", value: jobs[3]?.id,
          expected: `document.querySelector('.result-workspace')?.dataset.jobId===${JSON.stringify(jobs[3]?.id)}` });
        const legacy = await read(context, `(()=>{const e=document.querySelector('.coverage-summary');return {
          known:e.dataset.coverageKnown,scored:e.dataset.scoredAnchors,original:e.dataset.originalFrames,
          full:e.dataset.geometricFull,tail:e.dataset.geometricTail,valid:e.dataset.fullyValid,rows:e.dataset.validRows,
          last:e.dataset.lastScoredFrame,subset:e.dataset.subset,stride:e.dataset.subsetStride,
          maxSamples:e.dataset.subsetMaxSamples,originalKnown:e.dataset.originalLengthKnown,
          masks:e.dataset.maskValidity}})()`);
        const legacyPass = legacy.known === "unknown" && legacy.scored === "3" && legacy.original === "unknown"
          && legacy.full === "unknown" && legacy.tail === "unknown" && legacy.valid === "unknown"
          && legacy.rows === "unknown" && legacy.last === "4" && legacy.subset === "true"
          && legacy.stride === "2" && legacy.maxSamples === "3"
          && legacy.originalKnown === "false" && legacy.masks === "unknown";
        check(context, { name: `${viewport}-${theme}-legacy-three-frame-subset-remains-unknown`, passed: legacyPass, detail: legacy });
        const legacyLayout = await read(context, `(()=>{const grid=document.querySelector('.overview__grid');
          return {width:innerWidth,height:innerHeight,scrollWidth:document.documentElement.scrollWidth,
            mainWidth:document.querySelector('main').scrollWidth,gridBottom:grid.getBoundingClientRect().bottom,
            panelCount:grid.querySelectorAll('.overview-panel').length}})()`);
        const legacyLayoutPass = legacyLayout.panelCount === 16
          && legacyLayout.scrollWidth <= legacyLayout.width
          && legacyLayout.mainWidth <= legacyLayout.width
          && (width < 1000 || legacyLayout.gridBottom <= height);
        check(context, { name: `${viewport}-${theme}-selected-legacy-subset-layout-fits`, passed: legacyLayoutPass, detail: legacyLayout });
        await screenshot(context, `coverage-legacy-subset-${width}x${height}-${theme}`);
        owned.cleanup = await harness.close();
        owned.closed = true;
      }
    }
    await writeFile(join(outputPath, "http.json"), JSON.stringify(requests, null, 2));
    return { assertions, actions, metadata: { actualProductionApp: true, fixtureJobs: jobs.map(({ id }) => id) } };
  } finally {
    server.stop(true);
    for (const owned of harnesses) {
      if (!owned.closed) {
        owned.cleanup = await owned.harness.close();
        owned.closed = true;
      }
    }
    const cleanups = harnesses.flatMap((item) => item.cleanup ? [item.cleanup] : []);
    const cleanup = cleanups.flatMap((item) => item.cleanupErrors);
    await writeFile(join(outputPath, "owned-cleanup.json"), JSON.stringify({
      browserOpen: cleanups.some((item) => item.browserOpen),
      serverOpen: cleanups.some((item) => item.serverOpen),
      tempStoreExists: cleanups.some((item) => item.tempStoreExists),
      serverStopped: true,
      cleanupErrors: cleanup,
    }, null, 2));
    await writeFile(join(outputPath, "scenario-evidence.json"), JSON.stringify({ assertions, actions, requests }, null, 2));
  }
}
