import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import index from "../../index.html";
import { JobStore } from "../../src/jobs";
import { createApi } from "../../src/api";
import { DiagnosticRunManager } from "../../src/diagnostic-runs";
import { diagnosticFixture } from "../diagnostic-fixture";
import { decodeAttentionMap } from "../../src/client/analysis/diagnostic-data";

type Page = { readonly evaluate: (script: string) => Promise<unknown> };
type Harness = { readonly openPage: () => Promise<Page>; readonly close: () => Promise<unknown> };
const { startHarness }: {
  startHarness: (options: { baseURL: string; viewport: string; theme: string }) => Promise<Harness>;
} = await import(new URL("./harness.mjs", import.meta.url).href);
async function state(page: Page, predicate: string, action = "") {
  await page.evaluate(`new Promise((resolve,reject)=>{
    const observer=new MutationObserver(check);
    const timer=setTimeout(()=>{observer.disconnect();reject(Error("Diagnostic launch deadline: "+${JSON.stringify(predicate)}))},8000);
    function check(){if(${predicate}){observer.disconnect();clearTimeout(timer);resolve(true)}}
    observer.observe(document.body,{subtree:true,childList:true,attributes:true,characterData:true});
    ${action}
    check();
  })`);
}

test("explicit launch receives SSE completion, displays letterbox, and cancellation releases the job", async () => {
  const directory = await mkdtemp(join(tmpdir(), "vlaeval-diagnostic-launch-"));
  const { job, packet } = diagnosticFixture();
  packet.schemaVersion = 2;
  const attention = packet.attention;
  if (!attention) throw new Error("Attention fixture required");
  for (const camera of attention.cameras) camera.patchValidFraction = Array.from({ length: 16 }, (_, i) => i < 4 ? 0 : 1);
  for (const slice of attention.slices) for (const map of slice.maps) {
    const values = decodeAttentionMap(map);
    const bytes = Buffer.alloc(values.length * 4);
    values.forEach((value, i) => bytes.writeFloatLE(value, i * 4));
    delete map.valuesF16LE;
    map.valuesF32LE = bytes.toString("base64");
    map.letterboxMass = Array.from(values.slice(0, 4)).reduce((sum, v) => sum + v, 0);
  }
  await Bun.write(join(directory, `${job.id}.json`), JSON.stringify(job));
  const store = new JobStore(directory, undefined, undefined, true);
  await store.initialize();
  let release = Promise.withResolvers<void>(), entered = Promise.withResolvers<void>();
  let runs = 0;
  const manager = new DiagnosticRunManager(store, async ({ signal }, emit) => {
    runs++;
    signal.addEventListener("abort", () => release.resolve(), { once: true });
    emit({ type: "progress", status: "running", message: "Synthetic bounded diagnostic" });
    entered.resolve();
    await release.promise;
    if (!signal.aborted) emit({ type: "result", packet });
  });
  const api = createApi(store, undefined, manager);
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, routes: { "/": index }, fetch(request) {
    if (new URL(request.url).pathname === "/api/kinematics/profiles") return Response.json({ profiles: [] });
    return api(request);
  } });
  const harness = await startHarness({ baseURL: server.url.href, viewport: "390x844", theme: "dark" });
  try {
    const page = await harness.openPage();
    await state(page, `!!document.querySelector('[data-view-tab="prerelease"]')`);
    await state(page, `document.querySelector('[data-diagnostic-run-status]')?.dataset.diagnosticRunStatus==="idle"`,
      `document.querySelector('[data-view-tab="prerelease"]').click();`);
    expect(runs).toBe(0);
    expect(await page.evaluate(`document.querySelector('[data-diagnostic-launch]').disabled`)).toBe(true);
    await state(page, `!document.querySelector('[data-diagnostic-launch]').disabled`,
      `document.querySelector('[data-diagnostic-enable]').click();`);
    await page.evaluate(`document.querySelector('[data-diagnostic-launch]').click()`);
    await entered.promise;
    await state(page, `document.querySelector('[data-diagnostic-run-status]')?.dataset.diagnosticRunStatus==="running"`);
    release.resolve();
    await state(page, `document.querySelector('.diagnostic-canvas')?.dataset.imageState==="ready"`);
    expect(runs).toBe(1);
    expect(await page.evaluate(`document.querySelectorAll('[data-letterbox-camera]').length`)).toBe(1);
    await state(page, `document.querySelector('[data-diagnostic-mask-letterbox]').disabled===false`,
      `const s=document.querySelector('[data-diagnostic-image-mode]');s.value="tokens";s.dispatchEvent(new Event('change',{bubbles:true}));`);
    await state(page, `document.querySelector('[data-attention-grid] rect').getAttribute('opacity')==="0"`,
      `document.querySelector('[data-diagnostic-mask-letterbox]').click();`);
    expect(runs).toBe(1);
    release = Promise.withResolvers<void>(); entered = Promise.withResolvers<void>();
    await page.evaluate(`document.querySelector('[data-diagnostic-launch]').click()`);
    await entered.promise;
    await state(page, `!document.querySelector('[data-diagnostic-cancel]').disabled`);
    await state(page, `document.querySelector('[data-diagnostic-run-status]')?.dataset.diagnosticRunStatus==="cancelled"`,
      `document.querySelector('[data-diagnostic-cancel]').click();`);
    expect((await store.storage()).runs[0]?.deletable).toBe(true);
    expect(await page.evaluate(`document.documentElement.scrollWidth<=innerWidth`)).toBe(true);
  } finally {
    release.resolve(); await harness.close(); server.stop(true); await rm(directory, { recursive: true, force: true });
  }
}, 30000);
