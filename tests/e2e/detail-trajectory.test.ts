import { expect, test } from "bun:test";
import { z } from "zod";
import index from "../../index.html";
import { jobSchema } from "../../src/contracts";
import { fkRequestSchema } from "../../src/kinematics/contracts";
import { buildPredictionWorkerAsset } from "../../src/kinematics/worker-asset";

type Page = {
  evaluate: (script: string) => Promise<unknown>;
  cdp: (method: string, params: Record<string, unknown>) => Promise<unknown>;
};
type Harness = { openPage: () => Promise<Page>; close: () => Promise<unknown> };
const { startHarness }: {
  startHarness: (options: { baseURL: string; viewport: string; theme: string }) => Promise<Harness>;
} = await import(new URL("./harness.mjs", import.meta.url).href);
const { fixtureJob, fixtureSnapshot }: {
  fixtureJob: (name: string) => unknown;
  fixtureSnapshot: (name: string) => { readonly fkRequest: unknown };
} = await import(new URL("../fixtures/redesign/index.mjs", import.meta.url).href);

async function waitFor(page: Page, predicate: string) {
  await page.evaluate(`new Promise((resolve,reject)=>{
    const check=()=>{if(${predicate}){observer.disconnect();clearTimeout(timer);resolve(true)}};
    const observer=new MutationObserver(check);
    const timer=setTimeout(()=>{observer.disconnect();reject(Error("Detail state deadline"))},8000);
    observer.observe(document.body,{subtree:true,childList:true,attributes:true});check();
  })`);
}
async function click(page: Page, selector: string) {
  await page.evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});e.focus();e.click();return true})()`);
}
async function select(page: Page, selector: string, value: string) {
  await page.evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});e.value=${JSON.stringify(value)};e.dispatchEvent(new Event('change',{bubbles:true}));return true})()`);
}

for (const mode of ["joint", "fk"] as const) test(`${mode} detail keeps full chunks and returns to its originating panel`, async () => {
  const job = jobSchema.parse(fixtureJob("rby1-16"));
  if (!job.result) throw new Error("Completed fixture required");
  const result = job.result;
  result.samples = result.traces[0]?.frames.map((frame, index) => ({
    episode: result.traces[0]?.episode ?? 0, frame, prompt: "",
    predicted: Array.from({ length: 4 }, (_, h) => result.actionNames.map(() => 0.1 + index * 0.01 + h * 0.02)),
    target: Array.from({ length: 4 }, () => result.actionNames.map(() => 0)), valid: [true, true, true, true],
  })) ?? [];
  const profile = fkRequestSchema.parse(fixtureSnapshot("fk-certified").fkRequest).profile;
  const asset = await buildPredictionWorkerAsset();
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, routes: { "/": index }, fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/api/jobs") return Response.json([job]);
    if (path === `/api/jobs/${job.id}`) return Response.json(job);
    if (path === "/api/kinematics/profiles") return Response.json({ profiles: [profile] });
    if (path === `/api/kinematics/profiles/${profile.profileHash}`) return Response.json(profile);
    if (path === "/assets/prediction.worker.js") return new Response(asset, { headers: { "content-type": "text/javascript" } });
    return new Response("Not found", { status: 404 });
  } });
  const harness = await startHarness({ baseURL: server.url.href, viewport: "1440x1000", theme: "system" });
  try {
    const page = await harness.openPage();
    await waitFor(page, `document.querySelector('.prediction-workspace')?.dataset.predictionState==='ready'`);
    if (mode === "fk") {
      await click(page, '[data-coordinate-tab="cartesian"]');
      await waitFor(page, `document.querySelector('[data-prediction-profile]')?.options.length===2`);
      await select(page, "[data-prediction-profile]", profile.profileHash);
      await select(page, "[data-source-joint-unit]", "rad");
      await select(page, "[data-source-representation]", "absolute");
      await waitFor(page, `document.querySelector('[data-prediction-confirm]')?.disabled===false`);
      await click(page, "[data-prediction-confirm]");
      await click(page, "[data-apply-prediction]");
      await waitFor(page, `document.querySelector('[data-prediction-provenance]')?.dataset.predictionProvenance==='fk'`);
    }
    const coordinate = mode === "joint" ? "joint" : "cartesian";
    const name = mode === "joint" ? "left_arm_0" : "left_rx";
    await click(page, `[data-channel-name="${name}"] [data-qa-detail]`);
    await waitFor(page, `document.querySelector('.prediction-workspace')?.dataset.predictionDetail==='true' && !!document.querySelector('.trajectory-detail-panel')`);
    expect(await page.evaluate(`document.activeElement.hasAttribute('data-close-detail')`)).toBe(true);
    expect(await page.evaluate(`document.querySelectorAll('.trajectory-detail-panel').length`)).toBe(1);
    expect(await page.evaluate(`document.querySelector('.trajectory-detail-panel').dataset.channelName`)).toBe(mode === "joint" ? "left_arm_0" : "left_rx");
    expect(await page.evaluate(`document.querySelector('.detail-panel figure').dataset.unit`)).toBe(mode === "joint" ? "native / unknown" : "deg");
    expect(await page.evaluate(`document.querySelectorAll('.detail-panel [data-overlay^="chunk-"]').length`)).toBe(result.samples.length);
    expect(await page.evaluate(`document.querySelectorAll('.detail-panel [data-overlay="gt"]').length`)).toBe(1);
    expect(await page.evaluate(`document.querySelector('.detail-panel [data-overlay^="chunk-"]').getAttribute('d').match(/[ML]/g).length`)).toBe(4);
    expect(await page.evaluate(`document.querySelectorAll('.detail-panel .point-inspector').length`)).toBe(0);
    const hover = z.object({ x: z.number(), y: z.number() }).parse(await page.evaluate(`(()=>{
      const svg=document.querySelector('.detail-panel svg');svg.scrollIntoView({block:'center'});
      const lines=[...svg.querySelectorAll('.trace-plot__grid')],first=lines[0],last=lines.at(-1);
      const p=new DOMPoint((Number(first.getAttribute('x1'))+Number(first.getAttribute('x2')))/2,
        (Number(first.getAttribute('y1'))+Number(last.getAttribute('y1')))/2).matrixTransform(svg.getScreenCTM());
      return {x:p.x,y:p.y};
    })()`));
    await page.cdp("Input.dispatchMouseEvent", { type: "mouseMoved", ...hover });
    await waitFor(page, `!!document.querySelector('[data-overview-tooltip]')`);
    await click(page, "[data-overview-tooltip] button");
    expect(await page.evaluate(`document.activeElement===document.querySelector('.detail-panel svg')`)).toBe(true);
    const end = String(await page.evaluate(`document.getElementById('workspace-end').value`));
    await page.cdp("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape" });
    await waitFor(page, `document.querySelector('.prediction-workspace')?.dataset.predictionDetail==='false'`);
    expect(await page.evaluate(`document.activeElement.closest('article').dataset.channelName`)).toBe(name);
    expect(await page.evaluate(`document.activeElement.dataset.detailMode`)).toBe(coordinate);
    expect(await page.evaluate(`document.getElementById('workspace-end').value`)).toBe(end);
    await click(page, `[data-channel-name="${name}"] [data-qa-detail]`);
    await waitFor(page, `document.querySelector('.prediction-workspace')?.dataset.predictionDetail==='true' && !!document.querySelector('.trajectory-detail-panel')`);
    expect(await page.evaluate(`document.getElementById('dimension-select').value`)).toBe(name);
    const next = mode === "fk" ? "left_x" : "left_arm_1";
    await select(page, "#dimension-select", next);
    expect(await page.evaluate(`document.querySelector('.trajectory-detail-panel').dataset.channelName`)).toBe(mode === "fk" ? "left_x" : "left_arm_1");
    await click(page, "[data-close-detail]");
    await waitFor(page, `document.querySelector('.prediction-workspace')?.dataset.predictionDetail==='false'`);
    expect(await page.evaluate(`document.activeElement.closest('article').dataset.channelName`)).toBe(next);
  } finally {
    await harness.close();
    server.stop(true);
  }
}, 30000);
