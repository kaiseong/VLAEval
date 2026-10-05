import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import index from "../../../index.html";
import { createApi } from "../../../src/api";
import { JobStore, isTerminal } from "../../../src/jobs";
import { fixtureJob } from "../../fixtures/redesign/index.mjs";
import { configsSchema, episodesSchema, discoverySchema } from "../../../src/contracts";

const timeout = 10_000;
function bounded(promise, label) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Timed out: ${label}`)), timeout);
  })]).finally(() => clearTimeout(timer));
}

// Observe React commits before triggering each state transition.
async function arm(page, expression) {
  await page.evaluate(`(()=>{window.__lifecycleSignal=new Promise((resolve,reject)=>{
    const test=()=>(${expression});if(test())return resolve(true);
    const observer=new MutationObserver(()=>{if(test()){observer.disconnect();clearTimeout(timer);resolve(true)}});
    observer.observe(document.documentElement,{subtree:true,childList:true,attributes:true,characterData:true});
    const timer=setTimeout(()=>{observer.disconnect();reject(new Error(${JSON.stringify(`Lifecycle DOM signal timed out: ${expression}`)}))},${timeout});
  });return true})()`);
}
async function settled(page) { await page.evaluate("window.__lifecycleSignal"); }
async function click(page, selector) {
  await page.evaluate(`(()=>{const target=document.querySelector(${JSON.stringify(selector)});
    target.scrollIntoView({block:"center",behavior:"instant"});
    target.addEventListener("click",event=>{window.__lifecycleTrustedClick=event.isTrusted},{once:true});
    return true})()`);
  await page.click(selector);
  if (await page.evaluate("window.__lifecycleTrustedClick") !== true) throw new Error(`Untrusted click: ${selector}`);
}
async function key(page, key, code = key) {
  const virtual = { Home: 36, ArrowDown: 40, Enter: 13, Escape: 27, Tab: 9 }[key];
  await page.cdp("Input.dispatchKeyEvent", { type: "keyDown", key, code, windowsVirtualKeyCode: virtual, nativeVirtualKeyCode: virtual });
  if (key === "Enter") await page.cdp("Input.dispatchKeyEvent", { type: "char", key, code, text: "\r", unmodifiedText: "\r", windowsVirtualKeyCode: 13 });
  await page.cdp("Input.dispatchKeyEvent", { type: "keyUp", key, code, windowsVirtualKeyCode: virtual, nativeVirtualKeyCode: virtual });
}
async function choose(page, selector, position) {
  await click(page, selector);
  await key(page, "Home");
  for (let i = 0; i < position; i += 1) await key(page, "ArrowDown");
  await key(page, "Enter");
  await key(page, "Escape");
}
async function chooseJob(page, id) {
  const position = await page.evaluate(`[...document.querySelector('#history').options].findIndex(option=>option.value===${JSON.stringify(id)})`);
  if (position < 0) throw new Error(`History option not found: ${id}`);
  await choose(page, "#history", position);
}
async function fill(page, selector, value) {
  await click(page, selector);
  await page.cdp("Input.dispatchKeyEvent", { type: "keyDown", key: "a", code: "KeyA", modifiers: 2 });
  await page.cdp("Input.dispatchKeyEvent", { type: "keyUp", key: "a", code: "KeyA", modifiers: 2 });
  await page.cdp("Input.insertText", { text: value });
}
function terminal(store, id) {
  if (isTerminal(store.get(id))) return Promise.resolve(structuredClone(store.get(id)));
  let dispose;
  return bounded(new Promise((resolve) => {
    dispose = store.subscribe(id, (job) => {
      if (isTerminal(job)) resolve(structuredClone(job));
    });
  }), `store terminal ${id}`).finally(() => dispose());
}

export async function runScenario({ args, outputPath, startHarness }) {
  const assertions = [];
  const actions = [];
  const wire = [];
  const sse = [];
  const cancellations = [];
  const controls = [];
  const harnesses = [];
  const fixture = fixtureJob("rby1-16");
  const directory = await mkdtemp(join(tmpdir(), "vlaeval-lifecycle-"));
  let runnerStarted;
  let streamSubscribed;
  let historyReplay = null;
  let historyFails = false;
  let server;
  let store;
  const deliveries = new Map();
  const checkValue = (name, passed, detail) => {
    assertions.push({ name, passed: passed === true, detail: structuredClone(detail) });
    console.log(`LIFECYCLE ${name} ${passed}`);
    if (passed !== true) throw new Error(`Assertion failed: ${name}`);
  };
  const check = async (page, name, expression) => checkValue(name, await page.evaluate(expression), expression);
  const capture = async (page, name) => {
    await page.evaluate("(()=>{document.querySelector('main').scrollTo(0,0);window.scrollTo(0,0)})()");
    await page.evaluate("new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))");
    const geometry = JSON.parse(await page.evaluate("JSON.stringify({width:innerWidth,height:innerHeight,theme:document.documentElement.dataset.theme})"));
    const shot = await page.cdp("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
    const bytes = Buffer.from(shot.data, "base64");
    if (bytes.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a" || bytes.readUInt32BE(16) !== geometry.width || bytes.readUInt32BE(20) !== geometry.height) {
      throw new Error(`Invalid physical viewport capture: ${name}`);
    }
    const path = `${outputPath}/${name}.png`;
    await Bun.write(path, bytes);
    actions.push({ action: "screenshot", path, ...geometry });
  };
  const open = async () => {
    // Apply requested themes with the actual app control, not external-harness CSS.
    const harness = await startHarness({ baseURL: server.url.href, theme: "system" });
    harnesses.push(harness);
    return harness.openPage();
  };
  const http = async (path, body) => {
    const response = await fetch(new URL(path, server.url), {
      ...(body ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(timeout),
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`Actual API ${path}: HTTP ${response.status}: ${text}`);
    return { text, data: JSON.parse(text) };
  };
  const start = async (request) => {
    const started = Promise.withResolvers();
    runnerStarted = started.resolve;
    const { data } = await http("/api/jobs", request);
    const control = await bounded(started.promise, "injected runner entry");
    control.id = data.id;
    return { id: data.id, control };
  };
  const acknowledge = async (run) => {
    const finished = terminal(store, run.id);
    run.control.emit({ type: "cancelled" });
    run.control.finish.resolve();
    const job = await finished;
    checkValue(`terminal-after-worker-ack-${run.id}`, job.status === "cancelled", job);
    const snapshot = await http(`/api/jobs/${run.id}`);
    checkValue(`persisted-cancelled-after-ack-${run.id}`, snapshot.data.status === "cancelled", snapshot.data);
  };
  try {
    // Only the remote runner and cancellation transport are injected.
    // JobStore owns IDs, state, locking, persistence and worker acknowledgement.
    store = new JobStore(directory, async (request, emit) => {
      const control = {
        request, emit, finish: Promise.withResolvers(), cancelObserved: Promise.withResolvers(),
        pid: 42000 + controls.length,
      };
      controls.push(control);
      emit({ type: "started", pid: control.pid });
      runnerStarted(control);
      await control.finish.promise;
    }, async (host, pid) => {
      const control = controls.find((item) => item.pid === pid);
      if (!control) throw new Error(`Unknown controlled cancellation PID: ${pid}`);
      cancellations.push({ id: control.id, host, pid });
      control.cancelObserved.resolve();
      // Sending the cancellation signal is deliberately NOT worker acknowledgement.
    });
    await store.initialize();
    const api = createApi(store);
    server = Bun.serve({
      hostname: "127.0.0.1", port: 0, idleTimeout: 0, routes: { "/": index },
      async fetch(request) {
        const path = new URL(request.url).pathname;
        const requestBody = request.method === "POST" ? await request.clone().text() : null;
        let response;
        let transport = "production-api";
        // External I/O fixtures never replace job-domain routes.
        if (path === "/api/configs") {
          response = Response.json(configsSchema.parse({ revision: "lifecycle", configs: [
            { name: "qa_fixture", repoId: null, actionDim: 16, actionHorizon: 1 },
          ] }));
          transport = "external-config-fixture";
        } else if (path === "/api/episodes") {
          response = Response.json(episodesSchema.parse({ fps: 30, version: "v2.1",
            episodes: [{ index: 3, length: 10, tasks: ["선택 보존 확인"] }] }));
          transport = "external-metadata-fixture";
        } else if (path === "/api/discover") {
          response = Response.json(discoverySchema.parse({ repositories: [], checkpoints: [], datasets: [], warnings: [] }));
          transport = "external-discovery-fixture";
        } else if (request.method === "GET" && path === "/api/jobs" && historyFails) {
          response = Response.json({ error: "intentional history failure" }, { status: 503 });
          transport = "deliberate-http-failure";
        } else if (request.method === "GET" && path === "/api/jobs" && historyReplay !== null) {
          response = new Response(historyReplay, { headers: { "content-type": "application/json" } });
          transport = "captured-production-history-replay";
        } else {
          response = await api(request);
        }
        if (response.headers.get("content-type")?.includes("text/event-stream")) {
          const id = path.split("/")[3];
          // Tee native production bytes into evidence. A TransformStream permits
          // replay of a captured old delivery without inventing another job model.
          const stream = response.body.pipeThrough(new TransformStream({
            transform(chunk, controller) {
              const text = new TextDecoder().decode(chunk);
              sse.push({ id, path, text, transport: "production-eventStream" });
              deliveries.set(id, controller);
              controller.enqueue(chunk);
              streamSubscribed?.(id);
            },
            flush() { deliveries.delete(id); },
          }));
          wire.push({ method: request.method, path, requestBody, status: response.status, headers: Object.fromEntries(response.headers), transport });
          return new Response(stream, { status: response.status, headers: response.headers });
        }
        const text = await response.clone().text();
        wire.push({ method: request.method, path, requestBody, status: response.status, headers: Object.fromEntries(response.headers), text, transport });
        return response;
      },
    });
    actions.push({ action: "production-api-store", url: server.url.href, directory, injectedRemoteOnly: true });

    // Empty history is the actual initialized empty store, not a fake GET array.
    const empty = await open();
    await arm(empty, "document.body.innerText.includes('저장된 실행이 없습니다.')"); await settled(empty);
    await check(empty, "empty-history-defaults-preparation", "!document.querySelector('#prepare').hidden && document.querySelector('#results').hidden");
    await capture(empty, "empty-preparation");

    // Seed through actual HTTP start, worker result, terminal persistence, then
    // prove a new JobStore can restore the completed result from that directory.
    const seed = await start(fixture.request);
    const seedTerminal = terminal(store, seed.id);
    seed.control.emit({ type: "result", result: fixture.result });
    seed.control.finish.resolve();
    const saved = await seedTerminal;
    const restored = new JobStore(directory);
    await restored.initialize();
    checkValue("saved-result-restored-from-production-persistence", restored.get(saved.id).status === "completed" && JSON.stringify(restored.get(saved.id).result) === JSON.stringify(fixture.result), saved.id);

    const page = await open();
    await arm(page, `document.querySelector('#history').value===${JSON.stringify(saved.id)}`); await settled(page);
    if (args.theme === "light" || args.theme === "dark") {
      await arm(page, `document.documentElement.dataset.theme===${JSON.stringify(args.theme)}`);
      await choose(page, '.rail-footer select', args.theme === "light" ? 1 : 2); await settled(page);
    }
    await check(page, "saved-result-defaults-analysis", "document.querySelector('#prepare').hidden && !document.querySelector('#results').hidden");
    await page.evaluate(`(()=>{window.__lifecycleEvents=[];const Native=window.EventSource;
      window.EventSource=class extends Native {
        constructor(url){super(url);this.addEventListener("message",event=>{
          window.__lifecycleEvents.push(JSON.parse(event.data));
          window.__lifecycleMessageResolve?.(event.data);
        })}
      };return true})()`);
    await capture(page, "saved-analysis");
    await arm(page, "!document.querySelector('#prepare').hidden");
    await click(page, '.workspace-nav button:first-child'); await settled(page);
    await click(page, '#connection summary');
    await arm(page, "document.body.innerText.includes('탐색 완료')");
    await click(page, '#connection button'); await settled(page);
    await arm(page, "document.querySelector('#prepare select').options.length===2");
    await click(page, '#prepare .preparation-grid section:first-child button'); await settled(page);
    await choose(page, '#prepare select', 1);
    await fill(page, 'input[list="checkpoints"]', "/qa/chosen-checkpoint");
    await fill(page, 'input[list="datasets"]', "/qa/chosen-dataset");
    await arm(page, "document.querySelector('.episode-row')!==null");
    await click(page, '#prepare .preparation-grid section:nth-child(2) button'); await settled(page);
    await click(page, '.episode-row input');
    await check(page, "explicit-episode-selected", "document.querySelector('.episode-row input').checked");
    await click(page, '.workspace-nav button:last-child');
    await click(page, '.workspace-nav button:first-child');
    await check(page, "switching-preserves-preparation", "document.querySelector('input[list=\"checkpoints\"]').value==='/qa/chosen-checkpoint' && document.querySelector('input[list=\"datasets\"]').value==='/qa/chosen-dataset' && document.querySelector('.episode-row input').checked");
    await capture(page, "preparation-preserved");

    const live = await start({ ...fixture.request, config: "live_job" });
    live.control.emit({ type: "progress", completed: 1, total: 10, message: "frame one" });
    const subscribed = Promise.withResolvers();
    streamSubscribed = (id) => { if (id === live.id) subscribed.resolve(); };
    await arm(page, "document.querySelector('.run-progress')!==null");
    await click(page, '.workspace-header > button'); await settled(page);
    await bounded(subscribed.promise, "native production SSE subscription");
    await check(page, "preparation-lock-and-cancel", "document.querySelector('.preparation').disabled && !document.querySelector('.run-progress button').disabled");
    await capture(page, "active-preparation");
    await arm(page, "!document.querySelector('#results').hidden");
    await chooseJob(page, live.id); await settled(page);
    await chooseJob(page, saved.id);
    await check(page, "history-keeps-active-cancel", `document.querySelector('#history').value===${JSON.stringify(saved.id)} && document.querySelector('.run-progress').innerText.includes('live_job')`);
    await capture(page, "active-analysis");

    await arm(page, "document.querySelector('progress').value===2");
    live.control.emit({ type: "progress", completed: 2, total: 10, message: "frame two" }); await settled(page);
    const staleHistory = (await http("/api/jobs")).text;
    const staleSse = sse.findLast((entry) => entry.id === live.id && JSON.parse(entry.text.slice(6)).progress.completed === 2);
    if (!staleSse) throw new Error("Native store SSE progress-two record was not captured");
    await arm(page, "document.querySelector('progress').value===7");
    live.control.emit({ type: "progress", completed: 7, total: 10, message: "frame seven" }); await settled(page);
    await page.evaluate(`(()=>{window.__lifecycleMessage=new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>reject(new Error("Captured stale SSE not delivered")),${timeout});
      window.__lifecycleMessageResolve=data=>{if(JSON.parse(data).progress.completed===2){clearTimeout(timer);resolve(data)}};
    });return true})()`);
    deliveries.get(live.id).enqueue(new TextEncoder().encode(staleSse.text));
    actions.push({ action: "replay-captured-sse", original: staleSse, unchangedBytes: true });
    await page.evaluate("window.__lifecycleMessage");
    await page.evaluate("new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))");
    await check(page, "stale-sse-keeps-progress", "document.querySelector('progress').value===7 && window.__lifecycleEvents.at(-1).progress.completed===2");

    historyReplay = staleHistory;
    await arm(page, "document.querySelector('.workspace-header > button').disabled");
    await click(page, '.workspace-header > button'); await settled(page);
    await arm(page, "!document.querySelector('.workspace-header > button').disabled"); await settled(page);
    historyReplay = null;
    await check(page, "stale-history-keeps-progress", "document.querySelector('progress').value===7");

    await arm(page, "document.querySelector('.run-progress').innerText.includes('원격 worker 종료 확인')");
    await click(page, '.run-progress button'); await settled(page);
    await bounded(live.control.cancelObserved.promise, "actual analysis cancel adapter");
    const pending = (await http(`/api/jobs/${live.id}`)).data;
    await check(page, "analysis-pending-cancel-before-worker-ack", "document.querySelector('.run-progress')!==null && document.querySelector('.preparation').disabled");
    checkValue("analysis-cancel-response-stays-running", pending.status === "running" && pending.progress.message.includes("종료 확인"), pending);
    const conflict = await fetch(new URL("/api/jobs", server.url), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(fixture.request), signal: AbortSignal.timeout(timeout) });
    checkValue("actual-store-lock-before-worker-ack", conflict.status === 409, await conflict.text());
    await capture(page, "analysis-pending-cancel");
    await arm(page, "document.querySelector('.run-progress')===null");
    await acknowledge(live); await settled(page);
    checkValue("cancel-target-is-live-not-displayed", cancellations.length === 1 && cancellations[0].id === live.id && cancellations[0].pid === live.control.pid && store.get(saved.id).status === "completed", cancellations);

    // Re-deliver immutable bytes from the real pre-cancel HTTP history.
    historyReplay = staleHistory;
    await arm(page, "document.querySelector('.workspace-header > button').disabled");
    await click(page, '.workspace-header > button'); await settled(page);
    await arm(page, "!document.querySelector('.workspace-header > button').disabled"); await settled(page);
    historyReplay = null;
    await check(page, "stale-terminal-history-does-not-revive", "document.querySelector('.run-progress')===null");
    historyFails = true;
    await arm(page, "document.body.innerText.includes('기록을 읽지 못했습니다')");
    await click(page, '.workspace-header > button'); await settled(page);
    await capture(page, "history-error");
    historyFails = false;
    await arm(page, "!document.body.innerText.includes('기록을 읽지 못했습니다') && !document.querySelector('.workspace-header > button').disabled");
    await click(page, '.workspace-header > button'); await settled(page);
    await check(page, "failed-history-recovers", "!document.querySelector('.workspace-header > button').disabled");

    // Second workspace gets a distinct actual store-created run, never revival
    // of a previously cancelled mutable fixture record.
    const preparationRun = await start({ ...fixture.request, config: "live_job" });
    preparationRun.control.emit({ type: "progress", completed: 1, total: 10, message: "second live run" });
    const preparationPage = await open();
    await arm(preparationPage, "document.querySelector('.run-progress')!==null"); await settled(preparationPage);
    await arm(preparationPage, "!document.querySelector('#prepare').hidden");
    await click(preparationPage, '.workspace-nav button:first-child'); await settled(preparationPage);
    await check(preparationPage, "preparation-cancel-is-enabled", "!document.querySelector('.run-progress button').disabled && !document.querySelector('#prepare').hidden");
    await capture(preparationPage, "preparation-cancel-ready");
    await arm(preparationPage, "document.querySelector('.run-progress').innerText.includes('원격 worker 종료 확인')");
    await click(preparationPage, '.run-progress button'); await settled(preparationPage);
    await bounded(preparationRun.control.cancelObserved.promise, "actual preparation cancel adapter");
    const preparationPending = (await http(`/api/jobs/${preparationRun.id}`)).data;
    checkValue("preparation-cancel-response-stays-running", preparationPending.status === "running", preparationPending);
    await check(preparationPage, "preparation-pending-cancel-before-worker-ack", "document.querySelector('.preparation').disabled && document.querySelector('.run-progress')!==null");
    await capture(preparationPage, "preparation-pending-cancel");
    await arm(preparationPage, "document.querySelector('.run-progress')===null");
    await acknowledge(preparationRun); await settled(preparationPage);
    checkValue("preparation-cancel-target-is-live", cancellations.length === 2 && cancellations[1].id === preparationRun.id && cancellations[1].pid === preparationRun.control.pid && store.get(saved.id).status === "completed", cancellations);

    // All original shell matrix and keyboard assertions remain.
    for (const viewport of ["1440x1000", "390x844"]) {
      const [width, height] = viewport.split("x").map(Number);
      await page.cdp("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: width < 500 });
      for (const theme of ["light", "dark"]) {
        await arm(page, `document.documentElement.dataset.theme===${JSON.stringify(theme)}`);
        await choose(page, '.rail-footer select', theme === "light" ? 1 : 2); await settled(page);
        await arm(page, "!document.querySelector('#results').hidden");
        await click(page, '.workspace-nav button:last-child'); await settled(page);
        await check(page, `analysis-no-overflow-${viewport}-${theme}`, "document.documentElement.scrollWidth<=innerWidth && document.querySelector('#prepare').hidden");
        await capture(page, `analysis-${viewport}-${theme}`);
        await page.evaluate("(()=>{const main=document.querySelector('main');main.scrollTop=main.scrollHeight;window.scrollTo(0,document.body.scrollHeight)})()");
        await page.evaluate("new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))");
        const path = `${outputPath}/analysis-end-${viewport}-${theme}.png`;
        await Bun.write(path, await page.screenshot()); actions.push({ action: "screenshot", path });
        await arm(page, "!document.querySelector('#prepare').hidden");
        await click(page, '.workspace-nav button:first-child'); await settled(page);
        await capture(page, `preparation-${viewport}-${theme}`);
        await check(page, `preparation-no-overflow-${viewport}-${theme}`, "document.documentElement.scrollWidth<=innerWidth");
      }
    }
    await click(page, '.workspace-nav button:first-child');
    await key(page, "Tab");
    await check(page, "keyboard-focuses-analysis-navigation", "document.activeElement===document.querySelector('.workspace-nav button:last-child') && document.activeElement.matches(':focus-visible')");
    await arm(page, "document.querySelector('#prepare').hidden && !document.querySelector('#results').hidden");
    await key(page, "Enter"); await settled(page);
    await check(page, "keyboard-opens-analysis", "document.querySelector('#prepare').hidden && !document.querySelector('#results').hidden");
    await capture(page, "keyboard-analysis-focus");
    actions.push({ action: "http-wire", requests: wire });
    actions.push({ action: "production-sse-wire", records: sse });
    actions.push({ action: "cancel-adapter", calls: cancellations });
    return { assertions, actions };
  } finally {
    // Stop only this scenario's browsers, pending controlled runners and store.
    const cleanups = await Promise.all(harnesses.map((harness) => harness.close()));
    if (store) {
      for (const control of controls) {
        if (control.id && !isTerminal(store.get(control.id))) {
          const finished = terminal(store, control.id);
          control.emit({ type: "cancelled" });
          control.finish.resolve();
          await finished;
        }
      }
    }
    const url = server?.url.href;
    const port = server?.port;
    server?.stop(true);
    await rm(directory, { recursive: true, force: true });
    let storeAbsent = false;
    try { await stat(directory); } catch (error) { if (error.code !== "ENOENT") throw error; storeAbsent = true; }
    let portRefused = false;
    if (url) {
      try { await fetch(url, { signal: AbortSignal.timeout(timeout) }); }
      catch (error) { if (!(error instanceof Error)) throw error; portRefused = true; }
    }
    await Bun.write(`${outputPath}/production-wire.json`, JSON.stringify({ wire, sse, cancellations, actions, assertions }, null, 2));
    const cleanup = { url, port, directory, storeAbsent, portRefused, harnesses: cleanups, sharedResourcesTouched: false };
    await Bun.write(`${outputPath}/scenario-cleanup.json`, JSON.stringify(cleanup, null, 2));
    if (!storeAbsent || (url && !portRefused) || cleanups.some((item) => item.browserOpen || item.serverOpen || item.tempStoreExists || item.cleanupErrors.length)) {
      throw new Error(`Lifecycle cleanup failed: ${JSON.stringify(cleanup)}`);
    }
  }
}
