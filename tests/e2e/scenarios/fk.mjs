import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createApi } from "../../../src/api";
import { JobStore } from "../../../src/jobs";
import { ProfileCatalog } from "../../../src/kinematics/catalog";
import { buildFkWorkerAsset } from "../../../src/kinematics/worker-asset";

/** Source-stage real controller/API/Worker proof; does not certify future workspace integration. */
export async function runScenario({ args, outputPath, startHarness }) {
  const testCase = args.case;
  if (!["fk-gate", "fk-values", "fk-export"].includes(testCase)) throw new Error(`Unsupported FK case: ${testCase}`);
  const assertions = [], actions = [], http = [];
  const assert = (name, passed, detail) => {
    assertions.push({ name, passed, detail });
    if (!passed) throw new Error(`Assertion failed: ${name}: ${JSON.stringify(detail)}`);
  };
  let server, harness, page, temp;
  let cleanup = { serverOpen: false, browserOpen: false, tempStoreExists: false, cleanupErrors: [] };
  try {
    temp = await mkdtemp(join(tmpdir(), "task16-fk-"));
    const store = new JobStore(temp);
    await store.initialize();
    const api = createApi(store, new ProfileCatalog());
    const worker = new Uint8Array(await (await buildFkWorkerAsset()).arrayBuffer());
    const build = await Bun.build({ entrypoints: [resolve("tests/fixtures/redesign/fk-component.mjs")], target: "browser", format: "esm" });
    if (!build.success) throw new AggregateError(build.logs, "FK showcase bundle failed");
    const assets = new Map();
    let entry;
    const styles = [];
    for (const asset of build.outputs) {
      const url = `/showcase/${asset.path.split("/").at(-1)}`;
      assets.set(url, { bytes: new Uint8Array(await asset.arrayBuffer()), type: asset.type });
      if (asset.kind === "entry-point" && asset.type.startsWith("text/javascript")) entry = url;
      if (asset.type.startsWith("text/css")) styles.push(url);
    }
    if (!entry) throw new Error("Missing showcase JavaScript");
    const theme = args.theme ?? "light";
    const html = `<!doctype html><html data-theme="${theme}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>FK component QA</title>${styles.map((s) => `<link rel="stylesheet" href="${s}">`).join("")}</head><body><div id="root"></div><script type="module">import {mount} from "${entry}";window.__VLAEVAL_QA_MOUNT_PROMISE__=(async()=>{window.__VLAEVAL_QA_ASSERTIONS__=await mount(document.querySelector("#root"),{live:true});return "complete"})();</script></body></html>`;
    server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === "/") return new Response(html, { headers: { "content-type": "text/html" } });
      if (path === "/assets/fk.worker.js") return new Response(worker, { headers: { "content-type": "text/javascript" } });
      const asset = assets.get(path);
      if (asset) return new Response(asset.bytes, { headers: { "content-type": asset.type } });
      const response = await api(request);
      http.push({ path, status: response.status, body: await response.clone().text() });
      return response;
    } });
    actions.push({ action: "owned-production-api-worker-server", url: server.url.href });
    harness = await startHarness({ baseURL: server.url.href });
    page = await harness.openPage({ mount: true });
    async function read(expression) { return JSON.parse(await page.evaluate(`JSON.stringify(${expression})`)); }
    async function arm(expression) {
      await page.evaluate(`(()=>{const test=()=>(${expression});window.__FK_SIGNAL__=new Promise((resolve,reject)=>{let timer;const finish=()=>{if(!test())return;clearTimeout(timer);document.removeEventListener("fk-showcase-change",finish);resolve(true)};document.addEventListener("fk-showcase-change",finish);timer=setTimeout(()=>{document.removeEventListener("fk-showcase-change",finish);reject(new Error("FK exact state signal timed out"))},10000);finish()});return true})()`);
    }
    async function settled() { await page.evaluate("window.__FK_SIGNAL__"); }
    async function click(selector) {
      const target = await read(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)throw new Error("Missing target");e.scrollIntoView({block:"center"});const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`);
      await page.cdp("Input.dispatchMouseEvent", { type: "mousePressed", ...target, button: "left", clickCount: 1 });
      await page.cdp("Input.dispatchMouseEvent", { type: "mouseReleased", ...target, button: "left", clickCount: 1 });
      actions.push({ action: "trusted-click", selector, target });
    }
    async function key(key, code, virtual) {
      await page.cdp("Input.dispatchKeyEvent", { type: "keyDown", key, code, windowsVirtualKeyCode: virtual });
      await page.cdp("Input.dispatchKeyEvent", { type: "keyUp", key, code, windowsVirtualKeyCode: virtual });
    }
    async function choose(selector, index) {
      await click(selector);
      await key("Home", "Home", 36);
      for (let i = 0; i < index; i++) await key("ArrowDown", "ArrowDown", 40);
      await key("Enter", "Enter", 13);
    }
    async function shot(name) {
      await page.evaluate("new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))");
      const path = join(outputPath, `${name}.png`);
      await Bun.write(path, await page.screenshot());
      actions.push({ action: "screenshot", path });
    }
    await mkdir(outputPath, { recursive: true });
    assert("default-off-and-raw-joints-usable", await read(`!document.querySelector("[data-fk-enable]").checked && document.querySelectorAll(".overview-panel").length===16 && !document.querySelector("[data-fk-channel]")`));
    await shot("off");
    await click("[data-fk-enable]");
    await choose("[data-fk-profile]", 1);
    await choose("[data-fk-unit]", 1);
    await choose("[data-fk-representation]", 1);
    assert("not-ready-without-sign-zero-confirmation", await read(`window.__FK_QA__.state.fk.status==="unavailable"`));
    await arm(`window.__FK_QA__.state.fk.status==="ready"`);
    await click("[data-fk-confirm]");
    await settled();
    assert("twelve-production-worker-pose-channels", await read(`document.querySelectorAll("[data-fk-channel]").length===12 && window.__FK_QA__.state.fk.result.convention.source==="user_declared"`));
    assert("provenance-values-do-not-overlap-labels", await read(`[...document.querySelectorAll(".fk-provenance>div")].every(row=>{const t=row.querySelector("dt").getBoundingClientRect(),d=row.querySelector("dd").getBoundingClientRect();return d.left>=t.right || d.top>=t.bottom})`));
    assert("settings-touch-targets-at-least44", await read(`[...document.querySelectorAll(".fk-settings select,.fk-check")].every(e=>e.getBoundingClientRect().height>=44)`));
    await shot("ready");
    if (testCase === "fk-gate") {
      for (const [index, representation] of [[2, "delta"], [3, "velocity"], [4, "unknown"]]) {
        await arm(`window.__FK_QA__.state.settings.representation===${JSON.stringify(representation)} && window.__FK_QA__.state.fk.status==="unavailable"`);
        await choose("[data-fk-representation]", index); await settled();
        assert(`unsupported-${representation}-retains-joints`, await read(`document.querySelectorAll(".overview-panel").length===16 && !document.querySelector("[data-fk-channel]") && document.querySelector("[data-fk-export]").disabled`));
        await page.evaluate(`document.querySelector(".fk-panel").scrollIntoView({block:"center"})`);
        await shot(`unavailable-${representation}`);
      }
      await arm(`window.__FK_QA__.state.fk.status==="ready"`);
      await choose("[data-fk-representation]", 1); await settled();
      await arm(`window.__FK_QA__.holdCount()===1`);
      await click("[data-fk-hold]"); await settled();
      assert("pending-withholds-export", await read(`document.querySelector("[data-fk-export]").disabled`));
      await page.evaluate(`document.querySelector(".fk-panel").scrollIntoView({block:"center"})`);
      await shot("pending");
      await arm(`window.__FK_QA__.state.fk.status==="ready" && window.__FK_QA__.state.fk.result.episode===4`);
      await click("[data-fk-episode]"); await settled();
      const generation = await read("window.__FK_QA__.state.fk.result.generation");
      await click("[data-fk-release]");
      assert("stale_state-old-actual-worker-result-cannot-publish", await read(`window.__FK_QA__.state.fk.result.episode===4 && window.__FK_QA__.state.fk.result.generation===${generation}`));
      await shot("stale-rejected");
      for (const failure of ["missing-root", "digest", "mapping", "unknown-profile"]) {
        await arm(`window.__FK_QA__.state.fk.status==="unavailable"`);
        await click(`[data-fk-invalid="${failure}"]`); await settled();
        assert(`${failure}-unavailable-raw-joints-usable`, await read(`document.querySelectorAll(".overview-panel").length===16 && !document.querySelector("[data-fk-channel]") && document.querySelector("[data-fk-export]").disabled`));
        await shot(`unavailable-${failure}`);
        if (failure !== "unknown-profile") {
          await arm(`window.__FK_QA__.state.fk.status==="ready"`);
          await click("[data-fk-episode]"); await settled();
        }
      }
      assert("unknown-profile-actual-http404", http.some((response) => response.path.endsWith("f".repeat(64)) && response.status === 404));
      await arm(`window.__FK_QA__.state.fk.status==="ready"`);
      await choose("[data-fk-profile]", 1);
      await click("[data-fk-confirm]"); await settled();
    } else if (testCase === "fk-values") {
      await arm(`window.__FK_QA__.state.fk.status==="ready" && window.__FK_QA__.state.fk.result.jointUnit==="deg"`);
      await click('[data-fk-numeric="yaw"]'); await settled();
      const numerical = JSON.parse(await page.evaluate("window.__FK_QA__.complete().then(JSON.stringify)"));
      assert("actual-worker-179-minus179-two-degree-error", Math.abs(numerical.samples[0].arms.right.errors.orientationRad * 180 / Math.PI - 2) < 1e-9);
      assert("actual-worker-0.1m-displayed-100mm", Math.abs(numerical.samples[2].arms.right.pose.predicted.translationM[0]-.1)<1e-12);
      assert("production-quaternion-sign-equivalence", await page.evaluate("window.__FK_QA__.quaternionSignError().then(value=>Math.abs(value)<1e-12)"));
      assert("yaw-wrap-path-not-bridged", await read(`document.querySelector('[data-fk-channel="right-Yaw"] .trace-plot__target').children.length>=2`));
      await page.evaluate(`document.querySelector('[data-fk-channel="right-Yaw"]').scrollIntoView({block:"center"})`);
      await shot("yaw-wrap");
      await arm(`window.__FK_QA__.state.fk.status==="ready" && window.__FK_QA__.state.fk.selected?.arms.right.pose.predicted.rpyDeg[0]===null`);
      await click('[data-fk-numeric="singular"]'); await settled();
      assert("pitch90-RY-gap-position-SO3-valid", await read(`document.querySelector("[data-fk-singularity]")!==null && window.__FK_QA__.state.fk.selected.arms.right.valid && window.__FK_QA__.state.fk.selected.arms.right.pose.predicted.rpyDeg[2]===null`));
      await page.evaluate(`document.querySelector("[data-fk-singularity]").scrollIntoView({block:"start"})`);
      await shot("singular");
    } else {
      await arm("window.__FK_QA__.state.exports?.json&&window.__FK_QA__.state.exports?.csv");
      await click("[data-fk-export]"); await settled();
      const exports = await read("window.__FK_QA__.state.exports");
      const document = JSON.parse(exports.json.content);
      assert("production-exports-full-data-and-provenance", document.samples.length === 3 && document.source.frames.join(",") === "0,1,2" && document.declaration.convention.source === "user_declared" && exports.csv.content.includes("orientation_error_rad"));
      await writeFile(join(outputPath, "derived.json"), exports.json.content);
      await writeFile(join(outputPath, "derived.csv"), exports.csv.content);
    }
    await arm("window.__FK_QA__.state.fk.status==='ready'&&window.__FK_QA__.state.fk.view.window.startFrame===1");
    await click("[data-fk-zoom]"); await settled();
    await click('[data-fk-channel="right-X"] svg');
    await key("End", "End", 35);
    assert("trusted-keyboard-shared-frame-and-window", await read(`window.__FK_QA__.state.sourceFrame===2 && [...document.querySelectorAll(".trace-plot")].every(e=>e.dataset.sourceFrame==="2" && e.dataset.windowStart==="1")`));
    assert("raw-json-csv-and-grippers-unchanged", await read(`JSON.stringify(window.__FK_QA__.rawBefore)===JSON.stringify(window.__FK_QA__.rawNow()) && document.querySelectorAll('[data-kind="gripper"]').length===2`));
    assert("trusted-interaction-evidence", await read(`window.__FK_QA__.state.events.some(e=>e.action==="key"&&e.trusted) && window.__FK_QA__.state.events.some(e=>e.action==="click"&&e.trusted)`));
    assert("no-horizontal-overflow", await read("document.documentElement.scrollWidth<=innerWidth"));
    await shot("linked");
    await arm("window.__FK_QA__.state.fk.status==='ready'&&window.__FK_QA__.state.fk.selected?.frame===2");
    await settled();
    const selectedExport = JSON.parse(await page.evaluate("window.__FK_QA__.complete().then(JSON.stringify)"));
    const selectedSample = selectedExport.samples.find(sample => sample.frame === 2);
    const channelNames = await read(`[...document.querySelectorAll("[data-fk-channel]")].map(e=>e.dataset.fkChannel)`);
    for (const name of channelNames) {
      await click(`[data-fk-channel="${name}"] summary`);
      const shown = await read(`(()=>{
        const panel=document.querySelector(${JSON.stringify(`[data-fk-channel="${name}"]`)});
        const output=panel.querySelector('[data-fk-point]'),rect=output.getBoundingClientRect();
        return {open:panel.querySelector('details').open,visible:rect.width>0&&rect.height>0,
          predicted:panel.querySelector('[data-fk-predicted]').textContent,target:panel.querySelector('[data-fk-target]').textContent,
          touchHeight:panel.querySelector('summary').getBoundingClientRect().height};
      })()`);
      const [side, axis] = name.split("-");
      const dimension = ["X", "Y", "Z", "Roll", "Pitch", "Yaw"].indexOf(axis);
      const expected = path => {
        const pose = selectedSample.arms[side].pose[path];
        const value = dimension < 3 ? pose.translationM?.[dimension] ?? null : pose.rpyDeg[dimension - 3];
        return value === null ? "unavailable" : String(value * (dimension < 3 ? 1000 : 1));
      };
      assert(`exact-point-${name}-visible-and-matches-current-full-export`,
        shown.open && shown.visible && shown.touchHeight >= 44 && shown.predicted === expected("predicted") && shown.target === expected("target"), shown);
      await page.evaluate(`document.querySelector(${JSON.stringify(`[data-fk-channel="${name}"]`)}).scrollIntoView({block:"center"})`);
      await shot(`channel-${name}`);
    }
    await page.evaluate("scrollTo(0,document.documentElement.scrollHeight)");
    await shot("scroll-end");
    actions.push({ action: "production-http-responses", responses: http });
    await writeFile(join(outputPath, "http.json"), JSON.stringify(http, null, 2));
    return { assertions, actions };
  } finally {
    try {
      if (page) await page.evaluate("window.__FK_QA__?.unmount()");
    } finally {
      try {
        if (harness) cleanup = await harness.close();
      } finally {
        if (server) server.stop(true);
        if (temp) await rm(temp, { recursive: true, force: true });
        await mkdir(outputPath, { recursive: true });
        await writeFile(join(outputPath, "owned-cleanup.json"), JSON.stringify(cleanup, null, 2));
        await writeFile(join(outputPath, "scenario-assertions.json"), JSON.stringify(assertions, null, 2));
      }
    }
  }
}
