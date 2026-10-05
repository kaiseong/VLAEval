import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import index from "../../../index.html";
import { fixtureJob } from "../../fixtures/redesign/index.mjs";
import { jobSchema } from "../../../src/contracts";
import { createApi } from "../../../src/api";
import { JobStore } from "../../../src/jobs";
import { ProfileCatalog } from "../../../src/kinematics/catalog";
import { buildFkWorkerAsset } from "../../../src/kinematics/worker-asset";
import { rawTraceCsv } from "../../../src/client/analysis/exports";

// Runs the production App, not a component mount or a second workspace implementation.
export async function runScenario({ args, outputPath, startHarness }) {
  if (!["synchronize", "scopes"].includes(args.case)) throw new Error(`Unsupported synchronization case: ${args.case}`);
  const assertions = [], actions = [], http = [], cleanups = [];
  const checkValue = (name, passed, detail) => {
    assertions.push({ name, passed: passed === true, detail });
    if (passed !== true) throw new Error(`Assertion failed: ${name}: ${JSON.stringify(detail)}`);
  };
  let server, temp, harness, page;
  try {
    const first = jobSchema.parse(fixtureJob(args.fixture));
    if (!first.result) throw new Error("Selected fixture must have saved results");
    const second = structuredClone(first);
    second.id = "00000000-0000-4000-8000-000000000017";
    second.createdAt = "2026-10-05T00:00:00.000Z";
    const originalTrace = first.result.traces[0];
    if (!originalTrace) throw new Error("Selected fixture must have a trace");
    const shifted = {
      ...structuredClone(originalTrace), frames: originalTrace.frames.map((frame) => frame + 12),
      predicted: originalTrace.predicted.map((row) => row.map((value) => value + 2)),
    };
    second.result.traces = [shifted];
    second.result.samples = [];
    second.error = "QA saved-result error stays visible";
    // A second episode with different frames proves episode reset independently of run reset.
    first.result.traces.push({ ...structuredClone(originalTrace), episode: 4,
      frames: originalTrace.frames.map((frame) => frame + 30) });
    const jobs = [first, second];
    temp = await mkdtemp(join(tmpdir(), "task17-integration-"));
    const store = new JobStore(temp);
    await store.initialize();
    const api = createApi(store, new ProfileCatalog());
    const worker = new Uint8Array(await (await buildFkWorkerAsset()).arrayBuffer());
    server = Bun.serve({ hostname: "127.0.0.1", port: 0, idleTimeout: 0, routes: { "/": index },
      async fetch(request) {
        const path = new URL(request.url).pathname;
        let response;
        if (path === "/assets/fk.worker.js") response = new Response(worker, { headers: { "content-type": "text/javascript" } });
        else if (path === "/api/jobs") response = Response.json(jobs);
        else if (path.startsWith("/api/jobs/")) {
          const job = jobs.find((item) => item.id === path.split("/").at(-1));
          response = job ? Response.json(job) : Response.json({ error: "Not found" }, { status: 404 });
        } else response = await api(request);
        http.push({ path, method: request.method, status: response.status, headers: Object.fromEntries(response.headers), body: await response.clone().text() });
        return response;
      },
    });
    actions.push({ action: "owned-real-App-server", url: server.url.href, fixtureOnlyJobTransport: true, actualProfileAPIAndWorker: true });
    harness = await startHarness({ baseURL: server.url.href, theme: "system" });
    page = await harness.openPage();
    const read = async (expression) => JSON.parse(await page.evaluate(`JSON.stringify(${expression})`));
    const check = async (name, expression) => checkValue(name, await read(expression), expression);
    async function arm(expression) {
      await page.evaluate(`(()=>{window.__task17Signal=new Promise((resolve,reject)=>{let timer;const test=()=>(${expression});
        const observer=new MutationObserver(()=>{if(test()){observer.disconnect();clearTimeout(timer);resolve(true)}});
        if(test())return resolve(true);observer.observe(document.documentElement,{subtree:true,childList:true,attributes:true,characterData:true});
        timer=setTimeout(()=>{observer.disconnect();reject(new Error("Task17 state signal timed out: "+${JSON.stringify(expression)}))},10000);
      });return true})()`);
    }
    const settled = async () => page.evaluate("window.__task17Signal");
    async function click(selector) {
      await page.evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)throw new Error("Missing target "+${JSON.stringify(selector)});
        e.scrollIntoView({block:"center",behavior:"instant"});window.__task17Trusted=false;e.addEventListener("click",event=>window.__task17Trusted=event.isTrusted,{once:true});return true})()`);
      await page.click(selector);
      checkValue(`trusted-click-${selector}`, await page.evaluate("window.__task17Trusted") === true);
      actions.push({ action: "trusted-click", selector });
    }
    async function key(key, modifiers = 0) {
      const virtual = { Home: 36, ArrowDown: 40, ArrowRight: 39, End: 35, Enter: 13, Escape: 27, Tab: 9, a: 65 }[key];
      await page.cdp("Input.dispatchKeyEvent", { type: "keyDown", key, code: key === "a" ? "KeyA" : key, modifiers, windowsVirtualKeyCode: virtual });
      if (key === "Enter") await page.cdp("Input.dispatchKeyEvent", { type: "char", text: "\r", key, windowsVirtualKeyCode: 13 });
      await page.cdp("Input.dispatchKeyEvent", { type: "keyUp", key, code: key === "a" ? "KeyA" : key, modifiers, windowsVirtualKeyCode: virtual });
      actions.push({ action: "trusted-key", key, modifiers });
    }
    async function choose(selector, position, expression) {
      await arm(expression); await click(selector); await key("Home");
      for (let i = 0; i < position; i++) await key("ArrowDown");
      await key("Tab"); await settled();
    }
    async function fill(selector, value, expression) {
      await arm(expression); await click(selector); await key("a", 2);
      await page.cdp("Input.insertText", { text: String(value) }); await settled();
      actions.push({ action: "trusted-fill", selector, value });
    }
    async function view(name) {
      await arm(`document.querySelector('.result-workspace')?.dataset.view===${JSON.stringify(name)}`);
      await click(`[data-view-tab="${name}"]`); await settled();
    }
    async function shot(name, end = false) {
      await page.evaluate(`(()=>{const main=document.querySelector('main');main.scrollTo(0,${end ? "main.scrollHeight" : "0"});window.scrollTo(0,${end ? "document.documentElement.scrollHeight" : "0"});return true})()`);
      await page.evaluate("new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))");
      const geometry = await read("({width:innerWidth,height:innerHeight,theme:document.documentElement.dataset.theme})");
      const captured = await page.cdp("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
      const bytes = Buffer.from(captured.data, "base64");
      checkValue(`valid-png-${name}`, bytes.subarray(0, 8).toString("hex") === "89504e470d0a1a0a"
        && bytes.readUInt32BE(16) === geometry.width && bytes.readUInt32BE(20) === geometry.height, geometry);
      const path = join(outputPath, `${name}.png`);
      await writeFile(path, bytes);
      actions.push({ action: "screenshot", path, ...geometry });
    }
    async function checkAxis(name, expectedLabels) {
      await page.evaluate("document.fonts.ready");
      await page.evaluate("new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))");
      const panels = await read(`([...document.querySelectorAll('.overview-panel')].map(panel=>{
        const svg=panel.querySelector('svg'),box=svg.getBoundingClientRect().toJSON();
        const labels=[...svg.querySelectorAll('text')].map(text=>{
          const style=getComputedStyle(text),matrix=text.getScreenCTM();
          return {text:text.textContent,time:text.closest('.trace-plot__time-axis')!==null,
            visible:style.visibility==='visible'&&style.display!=='none',
            physicalFont:parseFloat(style.fontSize)*Math.hypot(matrix.a,matrix.b),
            ...text.getBoundingClientRect().toJSON()};
        });
        return {channel:panel.querySelector('button').textContent,box,panel:panel.getBoundingClientRect().toJSON(),labels,
          overlaps:labels.flatMap((a,i)=>labels.slice(i+1).filter(b=>a.time&&b.time&&
            a.left<b.right&&b.left<a.right&&a.top<b.bottom&&b.top<a.bottom).map(b=>[a.text,b.text]))};
      }))`);
      actions.push({ action: "production-axis-bounds", name, panels });
      checkValue(`${name}-time-ticks-nonoverlapping-inside-SVG-all-labels-readable-inside-panel`, panels.length === count
        && panels.every(panel => panel.overlaps.length === 0 && panel.labels.every(label =>
          label.visible && label.physicalFont >= 14 - 0.01
          && label.left >= (label.time ? panel.box : panel.panel).left - 0.01
          && label.right <= (label.time ? panel.box : panel.panel).right + 0.01
          && label.top >= (label.time ? panel.box : panel.panel).top - 0.01
          && label.bottom <= (label.time ? panel.box : panel.panel).bottom + 0.01)), panels);
      if (expectedLabels) checkValue(`${name}-exact-source-time-ticks`, panels.every(panel =>
        JSON.stringify(panel.labels.filter(label => label.time).map(label => label.text)) === JSON.stringify(expectedLabels)), panels);
    }
    await arm("document.querySelector('.result-workspace')?.dataset.view==='overview'");
    await settled();
    const theme = args.theme === "dark" ? "dark" : "light";
    await choose(".rail-footer select", theme === "dark" ? 2 : 1, `document.documentElement.dataset.theme===${JSON.stringify(theme)}`);
    const count = first.result.actionNames.length;
    await check("all-source-channels-in-real-App-overview", `document.querySelectorAll('.overview-panel').length===${count}`);
    await check("setup-not-on-analysis-canvas", `document.querySelector('#results').hidden===false && [...document.querySelectorAll('.preparation-grid')].every(e=>e.getClientRects().length===0)`);
    await check("default-collapsed-provenance", "!document.querySelector('.result-provenance').open");
    await check("no-primary-horizontal-overflow", "document.documentElement.scrollWidth<=innerWidth && document.querySelector('main').scrollWidth<=innerWidth");
    await check("episode-toolbar-label-control-and-exports-do-not-overlap", "(()=>{const label=document.querySelector('.result-toolbar>.field'),span=label.querySelector('span').getBoundingClientRect(),select=label.querySelector('select').getBoundingClientRect(),exports=document.querySelector('.result-toolbar>.cluster').getBoundingClientRect();return select.width>=44&&select.height>=44&&(select.left>=span.right || select.top>=span.bottom)&& (exports.top>=select.bottom || exports.left>=select.right)})()");
    const bounds = await read("({grid:document.querySelector('.overview__grid').getBoundingClientRect().toJSON(),main:document.querySelector('main').getBoundingClientRect().toJSON(),viewport:{width:innerWidth,height:innerHeight}})");
    await shot("overview-top"); await shot("overview-end", true);
    checkValue("integrated-overview-viewport-fit", bounds.viewport.width < 1000 || count !== 16 || bounds.grid.bottom <= bounds.viewport.height, bounds);
    await page.evaluate("document.querySelector('main').scrollTo(0,0)");
    await checkAxis("default-window", args.fixture === "rby1-16" ? ["0", "0.0333", "0.0667"]
      : args.fixture === "irregular-frames" ? ["0", "0.15", "0.3"] : undefined);
    const keyboard = [];
    for (let i = 0; i < count * 2 + 24; i++) {
      await key("Tab");
      const focused = await read("(()=>{const e=document.activeElement,r=e.getBoundingClientRect();return {tag:e.tagName,id:e.id,tab:e.dataset.viewTab,detail:e.dataset.qaDetail,role:e.getAttribute('role'),width:r.width,height:r.height,visible:getComputedStyle(e).outlineStyle!=='none'}})()");
      keyboard.push(focused);
      if (focused.tag === "SUMMARY") break;
    }
    checkValue("keyboard-reaches-all-explicit-views", ["overview", "detail", "chunks", "metrics", "fk"].every((name) => keyboard.some((item) => item.tab === name)), keyboard);
    checkValue("keyboard-reaches-shared-cursor-and-window", ["workspace-frame", "workspace-start", "workspace-end"].every((id) => keyboard.some((item) => item.id === id)), keyboard);
    checkValue("keyboard-reaches-every-channel-without-dropdown-switching", new Set(keyboard.filter((item) => item.detail !== undefined).map((item) => item.detail)).size === count, keyboard);
    checkValue("all-detail-openers-meet44px-and-focus-ring", keyboard.filter((item) => item.detail !== undefined).every((item) => item.height >= 44 && item.visible), keyboard);
    await shot("keyboard-overview-end", true);
    if (args.fixture === "rby1-16") {
      for (const frame of [1, 2, 0]) {
        await fill("#workspace-frame", frame, `document.querySelector('.result-workspace').dataset.sourceFrame==='${frame}'`);
        await check(`short-window-shares-exact-source-frame-${frame}`, `[...document.querySelectorAll('.overview-panel .trace-plot')].every(e=>e.dataset.sourceFrame==='${frame}'&&e.dataset.windowStart==='0'&&e.dataset.windowEnd==='2')`);
      }
    }

    // Instrument actual Blob creation without substituting bytes or download behavior.
    await page.evaluate(`(()=>{const create=URL.createObjectURL.bind(URL);window.__task17Blobs=[];URL.createObjectURL=blob=>{
      window.__task17Blobs.push({type:blob.type,promise:blob.text(),bytes:blob.arrayBuffer().then(b=>Array.from(new Uint8Array(b)))});
      window.dispatchEvent(new CustomEvent('task17-blob',{detail:window.__task17Blobs.length-1}));
      return create(blob)};return true})()`);
    async function captureDerived(selector) {
      await page.evaluate(`(()=>{
        window.__task17BlobSignal=new Promise((resolve,reject)=>{
          let timer;
          const captured=event=>{clearTimeout(timer);window.removeEventListener('task17-blob',captured);resolve(event.detail)};
          window.addEventListener('task17-blob',captured,{once:true});
          timer=setTimeout(()=>{window.removeEventListener('task17-blob',captured);reject(new Error('Actual derived Blob capture deadline'))},10000);
        });return true;
      })()`);
      await click(selector);
      const index = await page.evaluate("window.__task17BlobSignal");
      return page.evaluate(`window.__task17Blobs[${index}].promise`);
    }
    await click('[data-export="json"]');
    const json = await page.evaluate("window.__task17Blobs.at(-1).promise");
    checkValue("production-raw-json-preserves-source", JSON.stringify(JSON.parse(json)) === JSON.stringify(first.result));
    await click('[data-export="csv"]');
    const csv = Buffer.from(await page.evaluate("window.__task17Blobs.at(-1).bytes")).toString("utf8");
    checkValue("production-raw-csv-preserves-all-episodes-and-frames", csv === rawTraceCsv(first.result), { rows: csv.split("\r\n").length });
    if (args.case === "scopes") {
      await check("overview-first-step-not-chunk-MAE", "Number(document.querySelector('.overview-panel__stats').dataset.mae)===1");
      await check("overview-first-step-RMSE", "Number(document.querySelector('.overview-panel__stats').dataset.rmse)===Math.sqrt(2)");
      await view("metrics"); await shot("metrics-episode");
      await arm("document.querySelector('[data-metric-tab=\"dimension\"]')");
      await click('.metric-tabs button:nth-child(2)');
      await settled();
      const dimensionMetrics = await read("[...document.querySelectorAll('[data-metric-tab=\"dimension\"] tbody tr:first-child td')].map(cell=>Number(cell.textContent.replaceAll(',','')))");
      checkValue("chunk-dimension-MAE-four-and-RMSE", dimensionMetrics[0] === 4
        && Math.abs(dimensionMetrics[1] - Math.sqrt(104 / 3)) <= 0.000001, dimensionMetrics);
      await shot("metrics-dimension");
      await arm("document.querySelector('[data-metric-tab=\"horizon\"]')");
      await click('.metric-tabs button:nth-child(3)'); await settled();
      const rows = await read("[...document.querySelectorAll('[data-metric-tab=\"horizon\"] tbody tr')].map(r=>[...r.children].map(c=>c.textContent))");
      checkValue("horizon-valid-counts-and-null-tail", rows.map((r) => Number(r[1])).join() === "2,1,0" && rows[2][2] === "—" && rows[2][3] === "—", rows);
      await shot("metrics-horizon");
    } else if (args.fixture === "irregular-frames") {
      const stats = await read("[...document.querySelectorAll('.overview-panel__stats')].map(e=>({...e.dataset}))");
      await fill("#workspace-frame", 3, "document.querySelector('.result-workspace').dataset.sourceFrame==='3'");
      await fill("#workspace-start", 3, "document.querySelector('.result-workspace').dataset.windowStart==='3'");
      await check("all-overview-sliders-source-frame-three-window-three-nine", "[...document.querySelectorAll('.overview-panel .trace-plot')].every(e=>e.dataset.sourceFrame==='3'&&e.dataset.windowStart==='3'&&e.dataset.windowEnd==='9')");
      await check("source-frame-three-is-one-tenth-second", "document.querySelector('.workspace-cursor output').textContent.includes('0.1 s')");
      checkValue("full-episode-panel-statistics-invariant-to-zoom", JSON.stringify(stats) === JSON.stringify(await read("[...document.querySelectorAll('.overview-panel__stats')].map(e=>({...e.dataset}))")));
      await fill("#workspace-frame", 9, "document.querySelector('.result-workspace').dataset.sourceFrame==='9'");
      await checkAxis("irregular-window-three-nine", ["0.1", "0.2", "0.3"]);
      await shot("overview-shared-frame-nine");
    }

    await view("overview");
    await arm("document.querySelector('.result-workspace').dataset.view==='detail' && document.activeElement?.hasAttribute('data-close-detail')");
    await click('[data-qa-detail="0"]'); await settled();
    await check("detail-shares-source-frame-and-window", "(()=>{const w=document.querySelector('.result-workspace'),s=document.querySelector('.detail-panel .trace-plot');return s.dataset.sourceFrame===w.dataset.sourceFrame&&s.dataset.windowStart===w.dataset.windowStart&&s.dataset.windowEnd===w.dataset.windowEnd})()");
    if (count > 1) await choose("#dimension-select", 1, "document.querySelector('#dimension-select').value==='1'");
    await check("dimension-selection-does-not-close-detail", "document.querySelector('.result-workspace').dataset.view==='detail' && document.querySelector('.detail-panel')!==null");
    await shot("detail-top"); await shot("detail-end", true);
    await arm("document.querySelector('.result-workspace').dataset.view==='overview' && document.activeElement?.dataset.qaDetail==='0'");
    await key("Escape"); await settled();
    await check("detail-close-restores-opener-focus", "document.activeElement.dataset.qaDetail==='0'");

    const sourceBeforeChunks = await read("({...document.querySelector('.result-workspace').dataset})");
    await view("chunks");
    await check("retained-chunk-uses-separate-origin-horizon", `document.querySelector('#chunk-origin').value==='${originalTrace.frames[0]}' && document.querySelector('#chunk-horizon').value==='0' && document.querySelector('.chunk-panel [data-origin-frame]').dataset.originFrame==='${originalTrace.frames[0]}'`);
    await check("chunk-plot-uses-future-source-time-not-horizon-as-seconds", `document.querySelector('.chunk-panel .trace-plot').dataset.windowStart==='${originalTrace.frames[0]}'`);
    await shot("chunks-retained");
    if (args.case === "scopes") {
      await fill("#chunk-horizon", 1, "document.querySelector('.chunk-panel [data-horizon]')?.dataset.horizon==='1'");
      await check("retained-chunk-horizon-one-exact-raw-error-ten", "document.querySelector('.chunk-panel [data-value=\"predicted\"]').textContent==='10' && document.querySelector('.chunk-panel [data-value=\"target\"]').textContent==='0'");
      await shot("chunks-horizon-one");
    }
    await fill("#chunk-origin-frame", 987, "document.querySelector('[data-availability=\"unavailable\"]')?.textContent.includes('987')");
    await check("absent-origin-never-substitutes-retained-chunk", "!document.querySelector('.chunk-panel svg') && document.querySelector('#chunk-origin').value==='987'");
    await shot("chunks-unavailable");
    await view("overview");
    const sourceAfterChunks = await read("({...document.querySelector('.result-workspace').dataset})");
    checkValue("chunk-scope-does-not-change-timeline", sourceBeforeChunks.sourceFrame === sourceAfterChunks.sourceFrame
      && sourceBeforeChunks.windowStart === sourceAfterChunks.windowStart && sourceBeforeChunks.windowEnd === sourceAfterChunks.windowEnd);

    if (count === 16) {
      await view("fk");
      await arm("document.querySelector('[data-fk-profile]').options.length>1 || (!document.querySelector('[data-fk-profile]').disabled && document.querySelector('.fk-settings [role=\"status\"]'))");
      await check("FK-off-with-no-inferred-model-or-unit", "!document.querySelector('[data-fk-enable]').checked && document.querySelector('[data-fk-profile]').value==='' && document.querySelector('[data-fk-unit]').value===''");
      await click("[data-fk-enable]"); await settled();
      const catalogCount = await read("document.querySelector('[data-fk-profile]').options.length");
      checkValue("actual-local-profiles-available-for-integrated-proof", catalogCount > 1, { catalogCount });
      await choose("[data-fk-profile]", 1, "document.querySelector('[data-fk-profile]').value!==''");
      await choose("[data-fk-unit]", 1, "document.querySelector('[data-fk-unit]').value==='rad'");
      await choose("[data-fk-representation]", 1, "document.querySelector('[data-fk-representation]').value==='absolute_joint_position'");
      await check("FK-exports-disabled-before-confirmation", "document.querySelector('[data-export=\"fk-json\"]').disabled");
      await arm("document.querySelectorAll('[data-fk-channel]').length===12 && !document.querySelector('[data-export=\"fk-json\"]').disabled");
      await click("[data-fk-confirm]"); await settled();
      await check("FK-shares-original-source-frame-window", "(()=>{const w=document.querySelector('.result-workspace');return [...document.querySelectorAll('[data-fk-channel] .trace-plot')].every(s=>s.dataset.sourceFrame===w.dataset.sourceFrame&&s.dataset.windowStart===w.dataset.windowStart&&s.dataset.windowEnd===w.dataset.windowEnd)})()");
      await shot("fk-ready-top"); await shot("fk-ready-end", true);
      const derivedJson = JSON.parse(await captureDerived('[data-export="fk-json"]'));
      checkValue("actual-derived-export-matches-source-and-declaration", derivedJson.source.jobId === first.id
        && derivedJson.source.episode === originalTrace.episode && derivedJson.source.frames.join() === originalTrace.frames.join()
        && derivedJson.declaration.jointUnit === "rad" && derivedJson.profile.rootLink === "link_torso_5", derivedJson.source);
      const derivedCsv = await captureDerived('[data-export="fk-csv"]');
      checkValue("actual-derived-csv-separate-from-native", derivedCsv.includes("translation_error_m") && derivedCsv.includes(first.id) && !derivedCsv.startsWith("episode,frame,"));
      await arm("document.querySelectorAll('[data-fk-channel]').length===0 && document.querySelector('[data-export=\"fk-json\"]').disabled");
      await choose("[data-fk-representation]", 2, "document.querySelector('[data-fk-representation]').value==='delta'");
      await settled();
      await check("changed-declaration-disables-stale-FK-and-exports", "document.querySelector('[data-export=\"fk-csv\"]').disabled && document.querySelectorAll('[data-fk-channel]').length===0");
      await shot("fk-unavailable");
      // Hold a real production Worker completion, not a fabricated result. Then deliver
      // its captured callback after episode disposal to exercise stale-state rejection.
      await page.evaluate(`(()=>{
        const NativeWorker=window.Worker;window.__task17Held=[];
        window.Worker=class extends NativeWorker {
          set onmessage(callback) { super.onmessage=async event=>{
            if(!callback)return;
            if(event.data.kind!=='view'||event.data.serial!==0){callback(event);return}
            try {
              const serial=900000;
              const exported=await new Promise((resolve,reject)=>{
                let timer;
                const receive=reply=>{
                  if(reply.data.kind!=='export'||reply.data.serial!==serial)return;
                  this.removeEventListener('message',receive);clearTimeout(timer);
                  if(JSON.stringify(reply.data.identity)!==JSON.stringify(event.data.identity))
                    return reject(new Error('Held Worker export identity mismatch'));
                  resolve(reply.data.content.text().then(JSON.parse));
                };
                this.addEventListener('message',receive);
                timer=setTimeout(()=>{this.removeEventListener('message',receive);reject(new Error('Held Worker full export deadline'))},10000);
                this.postMessage({kind:'export',identity:event.data.identity,serial,format:'json'});
              });
              window.__task17Held.push({callback,event,exported});
              document.dispatchEvent(new Event('task17-held-worker'));
            } catch(error) {
              window.__task17HeldError=String(error);
              document.dispatchEvent(new Event('task17-held-worker'));
            }
          }; }
        };
        window.__task17HeldPromise=new Promise((resolve,reject)=>{
          const timer=setTimeout(()=>{document.removeEventListener('task17-held-worker',ready);reject(new Error('Real held Worker completion timed out'))},10000);
          function ready(){
            clearTimeout(timer);document.removeEventListener('task17-held-worker',ready);
            if(window.__task17HeldError)reject(new Error(window.__task17HeldError));else resolve(true);
          }
          document.addEventListener('task17-held-worker',ready);
        });return true})()`);
      await choose("[data-fk-representation]", 1, "document.querySelector('[data-fk-representation]').value==='absolute_joint_position'");
      await page.evaluate("window.__task17HeldPromise");
      await check("actual-held-Worker-result-is-pending-not-exportable", "window.__task17Held.length===1 && document.querySelector('[data-export=\"fk-json\"]').disabled && document.querySelectorAll('[data-fk-channel]').length===0");
    }

    await choose("#workspace-episode", 1, "document.querySelector('.result-workspace').dataset.episode==='4'");
    await check("episode-switch-atomically-resets-view-cursor-window", `(()=>{const w=document.querySelector('.result-workspace');return w.dataset.view==='overview'&&w.dataset.sourceFrame==='${originalTrace.frames[0]+30}'&&w.dataset.windowStart==='${originalTrace.frames[0]+30}'&&w.dataset.windowEnd==='${originalTrace.frames.at(-1)+30}'})()`);
    if (count === 16) {
      const held = await read(`window.__task17Held.map(({event,exported})=>{
        const result=JSON.parse(event.data.payload).result;
        return {jobId:result.jobId,episode:result.episode,generation:result.generation,frameCount:result.frameCount,
          frames:exported.source.frames,sampleFrames:exported.samples.map(sample=>sample.frame),
          exportJobId:exported.source.jobId,exportEpisode:exported.source.episode,exportGeneration:exported.declaration.generation};
      })`);
      checkValue("stale-state-is-real-production-worker-source", held.length === 1 && held[0].jobId === first.id
        && held[0].episode === originalTrace.episode && held[0].frames.join() === originalTrace.frames.join()
        && held[0].frameCount === originalTrace.frames.length && held[0].sampleFrames.join() === originalTrace.frames.join()
        && held[0].exportJobId === first.id && held[0].exportEpisode === originalTrace.episode
        && held[0].exportGeneration === held[0].generation, held);
      await page.evaluate("window.__task17Held.splice(0).forEach(({callback,event})=>callback(event))");
      await page.evaluate("new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))");
      await check("late-old-worker-cannot-revive-episode-state", "document.querySelector('.result-workspace').dataset.episode==='4' && document.querySelectorAll('[data-fk-channel]').length===0");
      actions.push({ action: "release-actual-obsolete-Worker-callback", held });
    }
    const runPosition = await read(`[...document.querySelector('#history').options].findIndex(option=>option.value===${JSON.stringify(second.id)})`);
    checkValue("new-run-present-in-real-history-options", runPosition >= 0, { runPosition });
    await choose("#history", runPosition, `document.querySelector('.result-workspace').dataset.jobId===${JSON.stringify(second.id)}`);
    await check("same-episode-different-run-atomic-identity-reset", `(()=>{const w=document.querySelector('.result-workspace');return w.dataset.episode==='${originalTrace.episode}'&&w.dataset.sourceFrame==='${shifted.frames[0]}'&&w.dataset.windowStart==='${shifted.frames[0]}'&&w.dataset.windowEnd==='${shifted.frames.at(-1)}'&&w.dataset.view==='overview'})()`);
    await check("saved-error-visible-outside-disclosure", "document.querySelector('.result-workspace>[role=\"alert\"]').textContent.includes('QA saved-result error') && !document.querySelector('.result-provenance').open");
    await shot("changed-run");
    await view("fk");
    await check("run-switch-has-no-stale-FK-declaration-or-export", "!document.querySelector('[data-fk-enable]').checked && document.querySelector('[data-fk-profile]').value==='' && document.querySelector('[data-export=\"fk-json\"]').disabled && document.querySelectorAll('[data-fk-channel]').length===0");
    await writeFile(join(outputPath, "http.json"), JSON.stringify(http, null, 2));
    return { assertions, actions, metadata: { realApp: true, jobs: jobs.map((job) => ({ id: job.id, frames: job.result.traces.map((trace) => ({ episode: trace.episode, frames: trace.frames })) })), noIndependentApproval: true } };
  } finally {
    if (harness) cleanups.push(await harness.close());
    if (server) server.stop(true);
    if (temp) await rm(temp, { recursive: true, force: true });
    await writeFile(join(outputPath, "owned-cleanup.json"), JSON.stringify({ browserOpen: false, serverOpen: false, tempStoreExists: false,
      cleanupErrors: cleanups.flatMap((item) => item.cleanupErrors) }, null, 2));
    await writeFile(join(outputPath, "scenario-evidence.json"), JSON.stringify({ assertions, actions, http }, null, 2));
  }
}
