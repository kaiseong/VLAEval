import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import index from "../../../index.html";
import { createApi } from "../../../src/api";
import { JobStore } from "../../../src/jobs";
import { ProfileCatalog } from "../../../src/kinematics/catalog";
import { buildFkWorkerAsset } from "../../../src/kinematics/worker-asset";
import { fixtureJob, fixtureJobs, transportResponse } from "../../fixtures/redesign/index.mjs";

const timeoutMs = 10_000;

function addAssertion(assertions, name, passed, detail = "") {
  assertions.push({ name, passed: passed === true, detail });
}

async function read(page, expression) {
  return JSON.parse(await page.evaluate(`JSON.stringify(${expression})`));
}

async function arm(page, expression, label = expression) {
  await page.evaluate(`(()=>{
    const predicate=()=>(${expression});
    window.__task21Signal=new Promise((resolve,reject)=>{
      let timer;
      const observer=new MutationObserver(()=>{
        if(!predicate())return;
        observer.disconnect();clearTimeout(timer);resolve(true);
      });
      if(predicate())return resolve(true);
      observer.observe(document.documentElement,{subtree:true,childList:true,attributes:true,characterData:true});
      timer=setTimeout(()=>{observer.disconnect();reject(new Error(${JSON.stringify(`Task21 state signal timed out: ${label}`)}))},${timeoutMs});
    });
    return true;
  })()`);
}

async function settled(page) {
  await page.evaluate("window.__task21Signal");
}

async function click(page, selector, actions) {
  const target = await read(page, `(()=>{
    const selector=${JSON.stringify(selector)},element=document.querySelector(selector);
    if(!element)throw new Error("Missing interaction target: "+selector);
    element.scrollIntoView({behavior:"instant",block:"center",inline:"center"});
    const rect=element.getBoundingClientRect(),x=rect.left+rect.width/2,y=rect.top+rect.height/2;
    const hit=document.elementFromPoint(x,y);
    if(rect.width<=0||rect.height<=0||!hit||(hit!==element&&!element.contains(hit)))
      throw new Error("Interaction target failed hit testing: "+JSON.stringify({selector,rect:rect.toJSON(),hit:hit?.outerHTML}));
    const clickId="task21-"+crypto.randomUUID();
    window.__task21Click=null;
    element.addEventListener("click",event=>window.__task21Click={clickId,isTrusted:event.isTrusted,selector},{once:true});
    return {x,y,clickId,text:element.innerText??element.value??"",selector};
  })()`);
  await page.cdp("Input.dispatchMouseEvent", {
    type: "mousePressed", x: target.x, y: target.y, button: "left", clickCount: 1,
  });
  await page.cdp("Input.dispatchMouseEvent", {
    type: "mouseReleased", x: target.x, y: target.y, button: "left", clickCount: 1,
  });
  const event = await read(page, "window.__task21Click");
  const trusted = event?.clickId === target.clickId && event.selector === selector && event.isTrusted === true;
  if (!trusted) throw new Error(`Click was not trusted for ${selector}: ${JSON.stringify(event)}`);
  actions.push({ action: "trusted-click", selector, target: { ...target, event } });
  return target;
}

async function key(page, name, actions) {
  const codes = {
    Tab: [9, "Tab"], Escape: [27, "Escape"], Enter: [13, "Enter"],
    Home: [36, "Home"], End: [35, "End"], ArrowDown: [40, "ArrowDown"],
    a: [65, "KeyA"],
  };
  const [virtual, code] = codes[name] ?? [];
  if (virtual === undefined) throw new Error(`Unsupported keyboard input: ${name}`);
  await page.cdp("Input.dispatchKeyEvent", {
    type: "keyDown", key: name, code, windowsVirtualKeyCode: virtual,
    ...(name === "a" ? { modifiers: 2 } : {}),
  });
  if (name === "Enter") {
    await page.cdp("Input.dispatchKeyEvent", {
      type: "char", key: name, code, text: "\r", windowsVirtualKeyCode: virtual,
    });
  }
  await page.cdp("Input.dispatchKeyEvent", {
    type: "keyUp", key: name, code, windowsVirtualKeyCode: virtual,
    ...(name === "a" ? { modifiers: 2 } : {}),
  });
  actions.push({ action: "keyboard", key: name });
}

async function choose(page, selector, optionIndex, expected, actions) {
  await arm(page, expected, `select ${selector}=${expected}`);
  await click(page, selector, actions);
  await key(page, "Home", actions);
  for (let i = 0; i < optionIndex; i += 1) await key(page, "ArrowDown", actions);
  await key(page, "Enter", actions);
  await settled(page);
}

async function setTheme(page, theme, actions) {
  const index = theme === "light" ? 1 : 2;
  await choose(page, ".rail-footer select", index,
    `document.documentElement.dataset.theme===${JSON.stringify(theme)}`, actions);
}

async function screenshot(page, outputPath, name, actions, assertions) {
  await page.evaluate("new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))");
  const geometry = await read(page, "({width:innerWidth,height:innerHeight,theme:document.documentElement.dataset.theme})");
  const encoded = await page.cdp("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
  const bytes = Buffer.from(encoded.data, "base64");
  const signature = bytes.subarray(0, 8).toString("hex");
  const dimensions = { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  addAssertion(assertions, `capture-${name}-png-signature-and-viewport`, signature === "89504e470d0a1a0a"
    && dimensions.width === geometry.width && dimensions.height === geometry.height, { signature, dimensions, geometry });
  const path = join(outputPath, `${name}.png`);
  await writeFile(path, bytes);
  actions.push({ action: "screenshot", path, ...geometry });
}

async function captureOverview(page, outputPath, label, actions, assertions) {
  await page.evaluate("(()=>{document.querySelector('main').scrollTo(0,0);window.scrollTo(0,0)})()");
  await screenshot(page, outputPath, `${label}-top`, actions, assertions);
  await page.evaluate("(()=>{const main=document.querySelector('main');main.scrollTop=main.scrollHeight;window.scrollTo(0,document.documentElement.scrollHeight)})()");
  await screenshot(page, outputPath, `${label}-end`, actions, assertions);
}

async function openFixture({ fixture, viewport, theme, startHarness }) {
  const harness = await startHarness({ fixture, viewport, theme });
  const page = await harness.openPage();
  return { harness, page };
}

async function overviewScenario(context) {
  const { args, outputPath, startHarness } = context;
  const assertions = [], actions = [];
  let harness;
  try {
    const viewport = args.viewport ?? "1440x1000";
    const theme = args.theme ?? "light";
    ({ harness, page: context.page } = await openFixture({ fixture: args.fixture, viewport, theme, startHarness }));
    const page = context.page;
    const expectedNames = await read(page, "[...document.querySelectorAll('.overview-panel')].map(panel=>panel.dataset.channelName)");
    const visibleLabels = await read(page, "[...document.querySelectorAll('.overview-panel button')].map(button=>button.innerText.replace(/\\s+/g,' ').trim())");
    const expectedPanelCount = 16;
    const geometry = await read(page, `(()=>{
      const grid=document.querySelector('.overview__grid').getBoundingClientRect();
      const panel=[...document.querySelectorAll('.overview-panel')].map(e=>({name:e.querySelector('button').innerText.trim(),...e.getBoundingClientRect().toJSON()}));
      return {grid:grid.toJSON(),panel,viewport:{width:innerWidth,height:innerHeight},
        documentWidth:document.documentElement.scrollWidth,mainWidth:document.querySelector('main').scrollWidth,
        preparationVisible:[...document.querySelectorAll('.preparation-grid')].some(e=>e.getClientRects().length>0),
        tabs:[...document.querySelectorAll('[data-view-tab]')].map(e=>({name:e.dataset.viewTab,...e.getBoundingClientRect().toJSON()})),
        toolbar:[...document.querySelectorAll('.result-toolbar button,.result-toolbar select')].map(e=>({name:e.innerText||e.getAttribute('aria-label')||e.value,...e.getBoundingClientRect().toJSON()}))};
    })()`);
    addAssertion(assertions, "overview-has-sixteen-unique-channel-plots",
      geometry.panel.length === expectedPanelCount && new Set(expectedNames).size === expectedPanelCount, expectedNames);
    addAssertion(assertions, "overview-includes-both-arms-and-grippers",
      ["right_arm_0", "right_arm_6", "left_arm_0", "left_arm_6", "right_gripper_0", "left_gripper_0"]
        .every(name => expectedNames.includes(name))
      && visibleLabels.includes("Right J0 ↗") && visibleLabels.includes("Left gripper ↗"),
      { channelNames: expectedNames, visibleLabels });
    addAssertion(assertions, "setup-hidden-from-analysis-canvas", !geometry.preparationVisible
      && await read(page, "!document.querySelector('#results').hidden"), geometry);
    addAssertion(assertions, "no-horizontal-overflow", geometry.documentWidth <= geometry.viewport.width
      && geometry.mainWidth <= geometry.viewport.width, geometry);
    addAssertion(assertions, "44px-toolbar-and-view-targets", geometry.tabs.every(item => item.width >= 44 && item.height >= 44)
      && geometry.toolbar.every(item => item.width >= 44 && item.height >= 44), { tabs: geometry.tabs, toolbar: geometry.toolbar });
    addAssertion(assertions, "1440-grid-fits-first-viewport",
      geometry.viewport.width !== 1440 || geometry.viewport.height !== 1000 || geometry.grid.bottom <= geometry.viewport.height, geometry);
    actions.push({ action: "inspect-overview-layout", geometry });
    await mkdir(outputPath, { recursive: true });
    await captureOverview(page, outputPath, `overview-${viewport}-${theme}`, actions, assertions);
  } finally {
    if (harness) await harness.close();
  }
  return { assertions, actions };
}

async function legacyScenario({ args, outputPath, startHarness }) {
  const assertions = [], actions = [];
  let harness;
  try {
    ({ harness, page: globalThis.__task21Page } = await openFixture({
      fixture: args.fixture ?? "legacy-run", viewport: args.viewport ?? "1440x1000",
      theme: args.theme ?? "light", startHarness,
    }));
    const page = globalThis.__task21Page;
    const source = fixtureJob(args.fixture ?? "legacy-run").result;
    const state = await read(page, `(()=>{
      const selectors={profile:document.querySelector('.fk-settings [data-fk-profile]')?.value??null,
        coverage:document.querySelector('.result-scores')?.innerText??'',
        panels:document.querySelectorAll('.overview-panel').length,
        overflow:document.documentElement.scrollWidth>innerWidth,
        savedTraceRows:document.querySelectorAll('.overview-panel').length};
      return selectors;
    })()`);
    addAssertion(assertions, "legacy-result-loads-without-profile-or-coverage", state.panels === 16
      && state.profile === null && !state.coverage.includes("coverage") && !state.overflow, state);
    await page.evaluate(`(()=>{
      const create=URL.createObjectURL.bind(URL);window.__task21Blobs=[];
      URL.createObjectURL=blob=>{window.__task21Blobs.push({type:blob.type,text:blob.text(),bytes:blob.arrayBuffer().then(b=>Array.from(new Uint8Array(b)))});return create(blob)};
      return true;
    })()`);
    await click(page, '[data-export="json"]', actions);
    const jsonText = await page.evaluate("window.__task21Blobs.at(-1).text");
    addAssertion(assertions, "legacy-raw-json-deep-equals-source",
      JSON.stringify(JSON.parse(jsonText)) === JSON.stringify(source), { bytes: jsonText.length });
    await click(page, '[data-export="csv"]', actions);
    const csv = Buffer.from(await page.evaluate("window.__task21Blobs.at(-1).bytes")).toString("utf8");
    const [header, ...lines] = csv.replace(/^\ufeff/, "").split("\r\n");
    const rows = lines.map(line => (line.match(/"(?:[^"]|"")*"/g) ?? [])
      .map(cell => cell.slice(1, -1).replaceAll('""', '"')));
    const expectedRows = source.traces.flatMap(trace => trace.frames.flatMap((frame, index) =>
      source.actionNames.map((name, dimension) => [
        trace.episode, frame, frame / source.fps, dimension, name,
        trace.predicted[index][dimension], trace.target[index][dimension],
        trace.predicted[index][dimension] - trace.target[index][dimension],
      ].map(String))));
    addAssertion(assertions, "legacy-raw-csv-retains-every-source-frame-and-dimension",
      header === "episode,frame,time_seconds,dimension,action,predicted,target,error"
      && rows.length === expectedRows.length
      && rows.every((row, index) => row.length === 8
        && row.every((value, column) => value === expectedRows[index][column])),
      { rows: rows.length, expectedRows: expectedRows.length });
    await arm(page, "document.querySelector('.result-workspace').dataset.view==='fk'", "legacy FK view opens");
    await click(page, '[data-view-tab="fk"]', actions);
    await settled(page);
    const fkState = await read(page, `({
      enabled:document.querySelector('[data-fk-enable]')?.checked??false,
      exportDisabled:document.querySelector('[data-export="fk-json"]')?.disabled??true,
      notice:document.querySelector('.fk-panel [role="status"]')?.textContent??''
    })`);
    addAssertion(assertions, "missing-legacy-FK-context-disables-only-derived-view",
      !fkState.enabled && fkState.exportDisabled && fkState.notice.includes("Raw joint"), fkState);
    await mkdir(outputPath, { recursive: true });
    await screenshot(page, outputPath, `legacy-${args.viewport ?? "1440x1000"}-${args.theme ?? "light"}`,
      actions, assertions);
  } finally {
    if (harness) await harness.close();
    delete globalThis.__task21Page;
  }
  return { assertions, actions };
}

async function emptyAndGenericStates({ outputPath, startHarness }) {
  const assertions = [], actions = [], harnesses = [];
  try {
    for (const [fixture, label] of [["malformed-and-empty", "empty"], ["generic-run", "generic"]]) {
      const harness = await startHarness({ fixture, viewport: "390x844", theme: "dark" });
      harnesses.push(harness);
      const page = await harness.openPage();
      if (fixture === "malformed-and-empty") {
        const empty = await read(page, `({
          message:document.body.innerText.includes('저장된 실행이 없습니다.'),
          historyOptions:document.querySelectorAll('#history option').length,
          error:document.querySelector('[role="alert"]')?.innerText??'',
          width:document.documentElement.scrollWidth,viewport:innerWidth
        })`);
        addAssertion(assertions, "valid-empty-history-explains-next-action", empty.message
          && empty.historyOptions === 1 && !empty.error && empty.width <= empty.viewport, empty);
      } else {
        const generic = await read(page, `({
          names:[...document.querySelectorAll('.overview-panel')].map(e=>e.dataset.channelName),
          layout:document.querySelector('.overview')?.dataset.layout??'missing',
          count:document.querySelectorAll('.overview-panel').length,
          width:document.documentElement.scrollWidth,viewport:innerWidth
        })`);
        addAssertion(assertions, "generic-action-grid-retains-every-channel-without-rby1-inference",
          generic.count === 2 && generic.layout === "generic" && generic.names.join(" ") === "action_0 action_1"
          && generic.width <= generic.viewport, generic);
      }
      await mkdir(outputPath, { recursive: true });
      await captureOverview(page, outputPath, `${label}-390x844-dark`, actions, assertions);
    }
  } finally {
    await Promise.all(harnesses.map(harness => harness.close()));
  }
  return { assertions, actions };
}

async function malformedRecoveryScenario({ outputPath, startHarness }) {
  const assertions = [], actions = [], http = [];
  let server, harness;
  let mode = "valid";
  const sourceJob = fixtureJobs("legacy-run")[0];
  server = Bun.serve({
    hostname: "127.0.0.1", port: 0, idleTimeout: 0, routes: { "/": index },
    async fetch(request) {
      const url = new URL(request.url);
      let response;
      if (url.pathname === "/__qa/transport-mode" && request.method === "POST") {
        const body = await request.json();
        mode = body.mode;
        response = Response.json({ mode });
      } else if (url.pathname === "/api/jobs" && request.method === "GET") {
        response = mode === "valid" ? Response.json([sourceJob]) : transportResponse(mode);
      } else if (url.pathname.startsWith("/api/jobs/") && request.method === "GET") {
        const id = url.pathname.split("/").at(-1);
        response = id === sourceJob.id ? Response.json(sourceJob) : Response.json({ error: "Not found" }, { status: 404 });
      } else {
        response = new Response("Not found", { status: 404 });
      }
      http.push({
        path: url.pathname, method: request.method, mode, status: response.status,
        headers: Object.fromEntries(response.headers), body: await response.clone().text(),
      });
      return response;
    },
  });
  try {
    harness = await startHarness({ baseURL: server.url.href, theme: "system", viewport: "390x844" });
    const page = await harness.openPage();
    await setTheme(page, "dark", actions);
    for (const invalid of ["malformed-json", "bare-nan", "schema-error"]) {
      const modeResponse = await page.evaluate(`fetch("/__qa/transport-mode",{method:"POST",headers:{"content-type":"application/json"},body:${JSON.stringify(JSON.stringify({ mode: invalid }))}}).then(response=>response.json())`);
      await arm(page, "document.querySelector('.workspace-header button[aria-label=\"기록 새로고침\"]')?.disabled===false", `refresh ready before ${invalid}`);
      await settled(page);
      await arm(page, "document.querySelector('.notice.error[role=\"alert\"]')!==null", `${invalid} surfaced in history`);
      await click(page, '.workspace-header button[aria-label="기록 새로고침"]', actions);
      await settled(page);
      const error = await read(page, `({
        alert:document.querySelector('.notice.error[role="alert"]')?.innerText??'',
        retained:document.querySelectorAll('.overview-panel').length,
        status:document.querySelector('.result-workspace')?.dataset.jobId??'',
        width:document.documentElement.scrollWidth,viewport:innerWidth
      })`);
      addAssertion(assertions, `${invalid}-transport-reports-error-without-crash-or-zero-result`,
        modeResponse.mode === invalid && error.alert.includes("기록을 읽지 못했습니다")
        && error.retained === 16 && error.status === sourceJob.id && error.width <= error.viewport, { modeResponse, error });
      actions.push({ action: "invalid-history-response", mode: invalid, http: http.at(-1) });
      await screenshot(page, outputPath, `${invalid}-error-390x844-dark`, actions, assertions);

      await page.evaluate(`fetch("/__qa/transport-mode",{method:"POST",headers:{"content-type":"application/json"},body:${JSON.stringify(JSON.stringify({ mode: "valid" }))}})`);
      await arm(page, "document.querySelector('.notice.error[role=\"alert\"]')===null && document.querySelectorAll('.overview-panel').length===16", `${invalid} recovery`);
      await click(page, '.workspace-header button[aria-label="기록 새로고침"]', actions);
      await settled(page);
      const recovered = await read(page, `({
        alert:document.querySelector('.notice.error[role="alert"]')?.innerText??'',
        selected:document.querySelector('#history').value,
        optionCount:document.querySelectorAll('#history option').length,
        panelCount:document.querySelectorAll('.overview-panel').length
      })`);
      addAssertion(assertions, `${invalid}-then-valid-history-recovers-current-result`,
        !recovered.alert && recovered.selected === sourceJob.id && recovered.optionCount >= 2 && recovered.panelCount === 16, recovered);
      actions.push({ action: "valid-history-restored", after: invalid, state: recovered });
    }
    await mkdir(outputPath, { recursive: true });
    await screenshot(page, outputPath, "recovery-390x844-dark", actions, assertions);
    await writeFile(join(outputPath, "http-responses.json"), `${JSON.stringify(http, null, 2)}\n`);
  } finally {
    if (harness) await harness.close();
    if (server) server.stop(true);
  }
  return { assertions, actions, metadata: { malformedTransportSeparateFromValidFixtures: true } };
}

async function mobileKeyboardScenario({ args, outputPath, startHarness }) {
  const assertions = [], actions = [];
  let harness;
  try {
    harness = await startHarness({
      fixture: "rby1-16", viewport: "390x844", theme: args.theme ?? "light",
    });
    const page = await harness.openPage();
    const dimensions = await read(page, `({
      width:innerWidth,height:innerHeight,documentWidth:document.documentElement.scrollWidth,
      panelCount:document.querySelectorAll('.overview-panel').length,
      panels:[...document.querySelectorAll('.overview-panel')].map(panel=>{
        const button=panel.querySelector('button'),rect=button.getBoundingClientRect();
        return {name:panel.dataset.channelName,label:button.innerText.trim(),height:rect.height,width:rect.width,scrollHeight:panel.scrollHeight};
      }),
      views:[...document.querySelectorAll('[data-view-tab]')].map(e=>e.dataset.viewTab)
    })`);
    addAssertion(assertions, "mobile-sixteen-panels-reachable-by-page-scroll", dimensions.panelCount === 16
      && dimensions.panels.length === 16 && dimensions.documentWidth <= dimensions.width
      && dimensions.panels.some(panel => panel.name.includes("left_gripper_0")), dimensions);
    addAssertion(assertions, "mobile-overview-touch-targets-at-least44px",
      dimensions.panels.every(panel => panel.height >= 44 && panel.width >= 44), dimensions.panels);
    addAssertion(assertions, "keyboard-view-tabs-have-visible-focus-and-reachability",
      dimensions.views.length === 5, dimensions.views);
    await mkdir(outputPath, { recursive: true });
    await captureOverview(page, outputPath, `mobile-390x844-${args.theme ?? "light"}`, actions, assertions);
    await page.evaluate("document.activeElement.blur()");
    const keyboard = [];
    for (let i = 0; i < 100; i += 1) {
      await key(page, "Tab", actions);
      const item = await read(page, `(()=>{
        const e=document.activeElement,r=e.getBoundingClientRect(),style=getComputedStyle(e);
        return {tag:e.tagName,id:e.id,view:e.dataset.viewTab,detail:e.dataset.qaDetail,
          width:r.width,height:r.height,focusVisible:e.matches(':focus-visible'),outline:style.outlineStyle};
      })()`);
      keyboard.push(item);
      if (keyboard.filter(value => value.tag === "SUMMARY").length) break;
    }
    const tabNames = ["overview", "detail", "chunks", "metrics", "fk"];
    const selectedChannels = new Set(keyboard.filter(item => item.detail !== undefined).map(item => item.detail));
    addAssertion(assertions, "keyboard-reaches-every-result-view",
      tabNames.every(name => keyboard.some(item => item.view === name)), keyboard);
    addAssertion(assertions, "keyboard-reaches-all-sixteen-channel-detail-buttons",
      selectedChannels.size === 16, [...selectedChannels]);
    addAssertion(assertions, "keyboard-focus-visible-on-view-tabs-and-channel-controls",
      keyboard.filter(item => item.view !== undefined || item.detail !== undefined)
        .every(item => item.focusVisible && item.width >= 44 && item.height >= 44), keyboard);
    const firstOpener = await read(page, `document.querySelector('[data-qa-detail="0"]')?.innerText??''`);
    await page.evaluate("document.querySelector('[data-qa-detail=\"0\"]').focus()");
    await arm(page, "document.querySelector('.result-workspace').dataset.view==='detail' && document.activeElement?.hasAttribute('data-close-detail')", "keyboard channel open");
    await key(page, "Enter", actions);
    await settled(page);
    addAssertion(assertions, "detail-has-keyboard-reachable-close",
      await read(page, `document.activeElement?.hasAttribute('data-close-detail')===true
        && document.activeElement.getBoundingClientRect().height>=44`), firstOpener);
    await arm(page, "document.querySelector('.result-workspace').dataset.view==='overview' && document.activeElement?.dataset.qaDetail==='0'", "escape closes detail");
    await key(page, "Escape", actions);
    await settled(page);
    addAssertion(assertions, "escape-closes-detail-and-returns-opener-focus",
      await read(page, `document.querySelector('.result-workspace').dataset.view==='overview'
        && document.activeElement?.dataset.qaDetail==='0'`), await read(page, "document.activeElement?.outerHTML??''"));
    const targets = await read(page, `[...document.querySelectorAll('.result-toolbar button,.result-toolbar select,.result-tabs button,.overview-panel button')].map(e=>({name:e.innerText||e.value||e.getAttribute('aria-label'),width:e.getBoundingClientRect().width,height:e.getBoundingClientRect().height}))`);
    addAssertion(assertions, "mobile-primary-controls-meet44px-target", targets.every(target => target.width >= 44 && target.height >= 44), targets);
    await screenshot(page, outputPath, `mobile-keyboard-detail-closed-${args.theme ?? "light"}`, actions, assertions);
  } finally {
    if (harness) await harness.close();
  }
  return { assertions, actions };
}

async function actualAppWorkerRace({ outputPath, startHarness }) {
  const assertions = [], actions = [], http = [];
  const temp = await mkdtemp("/tmp/task21-app-worker-race-");
  let server, harness;
  let stage = "initialization";
  const first = fixtureJob("rby1-16");
  const second = structuredClone(first);
  second.id = "00000000-0000-4000-8000-000000000021";
  second.createdAt = "2026-10-05T00:01:00.000Z";
  const trace = second.result.traces[0];
  trace.frames = trace.frames.map(frame => frame + 10);
  trace.predicted = trace.predicted.map(row => row.map(value => value + 3));
  trace.target = trace.target.map(row => row.map(value => value + 3));
  second.result.samples = [];
  const jobs = [first, second];
  const store = new JobStore(temp);
  await store.initialize();
  const api = createApi(store, new ProfileCatalog());
  const workerAsset = new Uint8Array(await (await buildFkWorkerAsset()).arrayBuffer());
  try {
    server = Bun.serve({
      hostname: "127.0.0.1", port: 0, idleTimeout: 0, routes: { "/": index },
      async fetch(request) {
        const url = new URL(request.url);
        let response;
        if (url.pathname === "/assets/fk.worker.js") response = new Response(workerAsset, { headers: { "content-type": "text/javascript" } });
        else if (url.pathname === "/api/jobs") response = Response.json(jobs);
        else if (url.pathname.startsWith("/api/jobs/")) {
          const job = jobs.find(item => item.id === url.pathname.split("/").at(-1));
          response = job ? Response.json(job) : Response.json({ error: "Not found" }, { status: 404 });
        } else response = await api(request);
        http.push({ path: url.pathname, method: request.method, status: response.status, headers: Object.fromEntries(response.headers), body: await response.clone().text() });
        return response;
      },
    });
    stage = "start actual App harness";
    harness = await startHarness({ baseURL: server.url.href, viewport: "1440x1000", theme: "system" });
    stage = "open actual App";
    const page = await harness.openPage();
    stage = "select actual App light theme";
    await setTheme(page, "light", actions);
    stage = "install Worker completion hold";
    await page.evaluate(`(()=>{
      const NativeWorker=window.Worker;
      window.__task21HeldWorkers=[];
      window.Worker=class extends NativeWorker {
        set onmessage(callback) {
          if(callback===null){super.onmessage=null;return}
          super.onmessage=async event=>{
            if(event.data.kind!=="view"||event.data.serial!==0){callback(event);return}
            try {
              // Inspect the actual full encoded export without admitting a full result
              // into the product controller. Count/bounds alone cannot prove middle IDs.
              const serial=900000+window.__task21HeldWorkers.length;
              const exported=await new Promise((resolve,reject)=>{
                let timer;
                const receive=reply=>{
                  if(reply.data.kind!=="export"||reply.data.serial!==serial)return;
                  this.removeEventListener("message",receive);clearTimeout(timer);
                  if(JSON.stringify(reply.data.identity)!==JSON.stringify(event.data.identity))
                    return reject(new Error("Held generation export identity mismatch"));
                  resolve(reply.data.content.text().then(JSON.parse));
                };
                this.addEventListener("message",receive);
                timer=setTimeout(()=>{this.removeEventListener("message",receive);reject(new Error("Held generation export deadline"))},${timeoutMs});
                this.postMessage({kind:"export",identity:event.data.identity,serial,format:"json"});
              });
              window.__task21HeldWorkers.push({callback,event,exported});
              document.dispatchEvent(new Event("task21-worker-held"));
            } catch(error) {
              window.__task21HeldError=String(error);
              document.dispatchEvent(new Event("task21-worker-held"));
            }
          };
        }
      };
      window.__task21ArmHeld=(count)=>{
        window.__task21HeldSignal=new Promise((resolve,reject)=>{
          let timer;
          const check=()=>{
            if(window.__task21HeldError){
              document.removeEventListener("task21-worker-held",check);clearTimeout(timer);reject(new Error(window.__task21HeldError));return;
            }
            if(window.__task21HeldWorkers.length<count)return;
            document.removeEventListener("task21-worker-held",check);clearTimeout(timer);resolve(true);
          };
          document.addEventListener("task21-worker-held",check);
          timer=setTimeout(()=>{document.removeEventListener("task21-worker-held",check);reject(new Error("Actual App Worker completion timed out"))},${timeoutMs});
          check();
        });
      };
      return true;
    })()`);

    async function configureAndHold(targetJobId, expectedFrames, nextCount) {
      stage = `wait for selected actual run ${targetJobId}`;
      await arm(page, "document.querySelector('.result-workspace')?.dataset.jobId===" + JSON.stringify(targetJobId), `selected App run ${targetJobId}`);
      if (await read(page, "document.querySelector('.result-workspace')?.dataset.jobId") !== targetJobId) {
        throw new Error(`Expected actual App to display ${targetJobId}`);
      }
      stage = `open FK for ${targetJobId}`;
      await arm(page, "document.querySelector('.result-workspace').dataset.view==='fk'", "FK view opens");
      await click(page, '[data-view-tab="fk"]', actions);
      await settled(page);
      stage = `wait for profiles for ${targetJobId}`;
      await arm(page, "document.querySelector('[data-fk-profile]')?.options.length>1", "actual local profile catalog loads");
      await page.evaluate("new Promise((resolve,reject)=>{const ready=()=>document.querySelector('[data-fk-profile]')?.options.length>1;if(ready())return resolve(true);const o=new MutationObserver(()=>{if(ready()){o.disconnect();resolve(true)}});o.observe(document.documentElement,{subtree:true,childList:true});setTimeout(()=>{o.disconnect();reject(new Error('Profile catalog did not render'))},10000)})");
      stage = `declare FK for ${targetJobId}`;
      await click(page, "[data-fk-enable]", actions);
      await choose(page, "[data-fk-profile]", 1, "document.querySelector('[data-fk-profile]').value!==''", actions);
      await choose(page, "[data-fk-unit]", 1, "document.querySelector('[data-fk-unit]').value==='rad'", actions);
      await choose(page, "[data-fk-representation]", 1, "document.querySelector('[data-fk-representation]').value==='absolute_joint_position'", actions);
      stage = `hold actual Worker ${nextCount} for ${targetJobId}`;
      await page.evaluate(`window.__task21ArmHeld(${nextCount})`);
      await click(page, "[data-fk-confirm]", actions);
      await page.evaluate("window.__task21HeldSignal");
      const held = await read(page, `window.__task21HeldWorkers.map(({event,exported})=>{
        const result=JSON.parse(event.data.payload).result;
        return {jobId:result.jobId,episode:result.episode,generation:result.generation,
          profileHash:result.profileHash,frameCount:result.frameCount,firstFrame:result.firstFrame,lastFrame:result.lastFrame,
          frames:exported.source.frames,exportJobId:exported.source.jobId,exportEpisode:exported.source.episode,
          exportGeneration:exported.declaration.generation,
          sampleFrames:exported.samples.map(sample=>sample.frame)};
      })`);
      const selected = held.at(-1);
      addAssertion(assertions, `actual-App-held-worker-${nextCount}-matches-selected-run-and-frames`,
        selected.jobId === targetJobId && selected.episode === 3 && selected.frameCount === expectedFrames.length
          && selected.firstFrame === expectedFrames[0] && selected.lastFrame === expectedFrames.at(-1)
          && selected.frames.join() === expectedFrames.join() && selected.sampleFrames.join() === expectedFrames.join()
          && selected.exportJobId === targetJobId && selected.exportEpisode === 3
          && selected.exportGeneration === selected.generation,
        { ...selected, fullFrameIdentityProvedByActualHeldGenerationExport: true });
      addAssertion(assertions, `actual-App-held-worker-${nextCount}-not-yet-published`,
        await read(page, "document.querySelectorAll('[data-fk-channel]').length===0 && document.querySelector('[data-export=\"fk-json\"]').disabled"), held);
      return selected;
    }

    const firstFrames = first.result.traces[0].frames;
    stage = "start first actual App derivation";
    const heldA = await configureAndHold(first.id, firstFrames, 1);
    stage = "select second actual App result";
    const optionB = await read(page, `[...document.querySelector('#history').options].findIndex(option=>option.value===${JSON.stringify(second.id)})`);
    await choose(page, "#history", optionB, `document.querySelector('.result-workspace')?.dataset.jobId===${JSON.stringify(second.id)}`, actions);
    await page.evaluate("new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))");
    const secondFrames = second.result.traces[0].frames;
    stage = "start second actual App derivation";
    const heldB = await configureAndHold(second.id, secondFrames, 2);
    stage = "deliver current Worker B before stale A";
    await arm(page, `Number(document.querySelector('.fk-panel')?.dataset.fkGeneration)===${heldB.generation}
      && document.querySelectorAll('[data-fk-channel]').length===12
      && document.querySelector('.result-workspace')?.dataset.jobId===${JSON.stringify(second.id)}`, "current B completion renders");
    await page.evaluate("window.__task21HeldWorkers[1].callback(window.__task21HeldWorkers[1].event)");
    let bPublished = true;
    try { await settled(page); } catch { bPublished = false; }
    const bState = await read(page, `({
      jobId:document.querySelector('.result-workspace').dataset.jobId,
      generation:Number(document.querySelector('.fk-panel').dataset.fkGeneration),
      channels:document.querySelectorAll('[data-fk-channel]').length,
      exportDisabled:document.querySelector('[data-export="fk-json"]').disabled,
      selectedFrames:[...document.querySelectorAll('[data-fk-channel] .trace-plot')].map(plot=>plot.dataset.sourceFrame)
    })`);
    actions.push({ action: "current-B-callback-result", bPublished, bState });
    addAssertion(assertions, "actual-App-B-completes-and-owns-visible-derived-state",
      bPublished && bState.jobId === second.id && bState.generation === heldB.generation
      && bState.channels === 12 && !bState.exportDisabled
      && bState.selectedFrames.every(frame => secondFrames.includes(Number(frame))), bState);
    await screenshot(page, outputPath, "actual-app-B-current-completion-1440x1000-light", actions, assertions);
    await page.evaluate("window.__task21HeldWorkers[0].callback(window.__task21HeldWorkers[0].event)");
    await page.evaluate("new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))");
    const afterA = await read(page, `({
      jobId:document.querySelector('.result-workspace').dataset.jobId,
      generation:Number(document.querySelector('.fk-panel').dataset.fkGeneration),
      channels:document.querySelectorAll('[data-fk-channel]').length,
      exportDisabled:document.querySelector('[data-export="fk-json"]').disabled
    })`);
    addAssertion(assertions, "actual-App-stale-A-after-current-B-cannot-overwrite-or-export",
      afterA.jobId === second.id && afterA.generation === heldB.generation
      && afterA.channels === 12 && !afterA.exportDisabled
      , { heldA, heldB, afterA });
    actions.push({ action: "release-current-B-before-stale-A", order: [heldB, heldA], afterA });
    await page.evaluate(`(()=>{
      const create=URL.createObjectURL.bind(URL);window.__task21FkExports=[];
      window.__task21ExportSignal=new Promise((resolve,reject)=>{
        const timer=setTimeout(()=>{URL.createObjectURL=create;reject(new Error('Actual task21 export Blob capture timed out'))},${timeoutMs});
        URL.createObjectURL=blob=>{clearTimeout(timer);URL.createObjectURL=create;window.__task21FkExports.push({type:blob.type,text:blob.text()});resolve(true);return create(blob)};
      });
      return true;
    })()`);
    await click(page, '[data-export="fk-json"]', actions);
    await page.evaluate("window.__task21ExportSignal");
    const exported = JSON.parse(await page.evaluate("window.__task21FkExports.at(-1).text"));
    addAssertion(assertions, "actual-App-FK-export-after-stale-A-keeps-current-B-identity-and-frames",
      exported.source.jobId === second.id && exported.source.episode === 3
      && exported.source.frames.join() === secondFrames.join()
      && exported.samples.map(sample => sample.frame).join() === secondFrames.join()
      && exported.profile.profileHash === heldB.profileHash
      && exported.declaration.generation === heldB.generation,
      { source: exported.source, profileHash: exported.profile.profileHash, generation: exported.declaration.generation });
    await writeFile(join(outputPath, "http-responses.json"), `${JSON.stringify(http, null, 2)}\n`);
  } catch (error) {
    await writeFile(join(outputPath, "scenario-error.json"), `${JSON.stringify({
      stage,
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : null,
      assertions, actions, http,
    }, null, 2)}\n`);
    throw error;
  } finally {
    const cleanup = harness ? await harness.close() : {
      browserOpen: false, serverOpen: false, tempStoreExists: false, cleanupErrors: [],
    };
    if (server) server.stop(true);
    await rm(temp, { recursive: true, force: true });
    await writeFile(join(outputPath, "owned-cleanup.json"), `${JSON.stringify(cleanup, null, 2)}\n`);
    if (cleanup.browserOpen || cleanup.serverOpen || cleanup.tempStoreExists || cleanup.cleanupErrors.length) {
      throw new Error(`Actual App Worker race cleanup failed: ${JSON.stringify(cleanup)}`);
    }
  }
  return { assertions, actions, metadata: { actualProductionApp: true, actualProfileCatalog: true, actualFkWorker: true, noIndependentApproval: true } };
}

async function functionalMatrix({ args, outputPath, startHarness }) {
  if (args["worker-race-only"] === "true") {
    const racePath = join(outputPath, "actual-app-worker-race");
    await mkdir(racePath, { recursive: true });
    const race = await actualAppWorkerRace({ outputPath: racePath, startHarness });
    await writeFile(join(racePath, "assertions.json"), `${JSON.stringify(race.assertions, null, 2)}\n`);
    return race;
  }
  const repoRoot = resolve(import.meta.dirname, "../../..");
  const matrix = [
    ["overview-1440-light", ["--case", "overview", "--fixture", "rby1-16", "--viewport", "1440x1000", "--theme", "light"]],
    ["overview-1440-dark", ["--case", "overview", "--fixture", "rby1-16", "--viewport", "1440x1000", "--theme", "dark"]],
    ["overview-390-light", ["--case", "overview", "--fixture", "rby1-16", "--viewport", "390x844", "--theme", "light"]],
    ["overview-390-dark", ["--case", "overview", "--fixture", "rby1-16", "--viewport", "390x844", "--theme", "dark"]],
    ["overview-1920-light", ["--case", "overview", "--fixture", "rby1-16", "--viewport", "1920x1080", "--theme", "light"]],
    ["Q02-synchronize", ["--case", "synchronize", "--fixture", "irregular-frames", "--viewport", "1440x1000", "--theme", "dark"]],
    ["Q03-scopes", ["--case", "scopes", "--fixture", "scalar-padding", "--viewport", "1440x1000", "--theme", "light"]],
    ["Q04-legacy", ["--case", "legacy", "--fixture", "legacy-run", "--viewport", "1440x1000", "--theme", "light"]],
    ["Q05-states", ["--case", "states", "--fixture", "malformed-and-empty", "--viewport", "390x844", "--theme", "dark"]],
    ["Q06-fk-gate", ["--case", "fk-gate", "--fixture", "rby1-16", "--viewport", "1440x1000", "--theme", "light"]],
    ["Q09-mobile-keyboard-light", ["--case", "mobile-keyboard", "--fixture", "rby1-16", "--viewport", "390x844", "--theme", "light"]],
    ["Q09-mobile-keyboard-dark", ["--case", "mobile-keyboard", "--fixture", "rby1-16", "--viewport", "390x844", "--theme", "dark"]],
    ["Q10-lifecycle", ["--case", "lifecycle", "--fixture", "lifecycle", "--viewport", "1440x1000", "--theme", "light"]],
    ["Q11-horizons", ["--case", "horizons", "--fixture", "horizon-boundaries", "--viewport", "1440x1000", "--theme", "light"]],
  ];
  const assertions = [], actions = [];
  await mkdir(outputPath, { recursive: true });
  for (const [name, args] of matrix) {
    const childOutput = join(outputPath, name);
    await mkdir(childOutput, { recursive: true });
    const cliArgs = ["tests/e2e/qa.mjs", ...args, "--out", childOutput];
    const child = spawn("bun", cliArgs, { cwd: repoRoot, stdio: ["ignore", "pipe", "pipe"] });
    const stdout = [], stderr = [];
    child.stdout.on("data", chunk => stdout.push(chunk));
    child.stderr.on("data", chunk => stderr.push(chunk));
    const exitCode = await new Promise((resolveExit, reject) => {
      child.once("error", reject);
      child.once("close", resolveExit);
    });
    const out = Buffer.concat(stdout).toString("utf8");
    const err = Buffer.concat(stderr).toString("utf8");
    await writeFile(join(childOutput, "functional-matrix-cli.log"),
      `${JSON.stringify({ command: `bun ${cliArgs.join(" ")}`, exitCode, stdout: out, stderr: err }, null, 2)}\n`);
    let childAssertions = [];
    let childCleanup = null;
    try { childAssertions = JSON.parse(await Bun.file(join(childOutput, "assertions.json")).text()); } catch {}
    try { childCleanup = JSON.parse(await Bun.file(join(childOutput, "cleanup.json")).text()); } catch {}
    const passed = exitCode === 0 && childAssertions.length > 0
      && childAssertions.every(item => item.passed === true)
      && childCleanup && !childCleanup.browserOpen && !childCleanup.serverOpen
      && !childCleanup.tempStoreExists && childCleanup.cleanupErrors.length === 0;
    addAssertion(assertions, `public-cli-${name}-passes-with-cleanup`,
      passed, { exitCode, assertionCount: childAssertions.length, failed: childAssertions.filter(item => !item.passed), cleanup: childCleanup, log: join(childOutput, "functional-matrix-cli.log") });
    actions.push({ action: "public-cli-case", name, command: `bun ${cliArgs.join(" ")}`,
      exitCode, output: childOutput, assertions: childAssertions.length, cleanup: childCleanup });
  }
  const racePath = join(outputPath, "actual-app-worker-race");
  await mkdir(racePath, { recursive: true });
  const race = await actualAppWorkerRace({ outputPath: racePath, startHarness });
  assertions.push(...race.assertions);
  actions.push(...race.actions);
  await writeFile(join(racePath, "assertions.json"), `${JSON.stringify(race.assertions, null, 2)}\n`);
  const output = { assertions, actions, metadata: { publicCliMatrix: matrix.map(([name]) => name),
    includedActualAppRace: true, independentApproval: false } };
  await writeFile(join(outputPath, "matrix.json"), `${JSON.stringify(output, null, 2)}\n`);
  return output;
}

export async function runScenario(context) {
  const testCase = context.args.case;
  switch (testCase) {
    case "overview": return overviewScenario(context);
    case "legacy": return legacyScenario(context);
    case "states": {
      const state = await emptyAndGenericStates(context);
      const recovery = await malformedRecoveryScenario(context);
      return { assertions: [...state.assertions, ...recovery.assertions], actions: [...state.actions, ...recovery.actions] };
    }
    case "mobile-keyboard": return mobileKeyboardScenario(context);
    case "functional-matrix": return functionalMatrix(context);
    default: throw new Error(`Unsupported results scenario: ${testCase}`);
  }
}
