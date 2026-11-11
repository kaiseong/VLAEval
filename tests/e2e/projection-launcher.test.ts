import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import index from "../../index.html";
import { JobStore } from "../../src/jobs";
import { createApi } from "../../src/api";
import { jimtofFrontCalibration } from "../../src/projection-calibration";
import { diagnosticFixture } from "../diagnostic-fixture";

type Page = { readonly evaluate: (script: string) => Promise<unknown> };
type Harness = { readonly openPage: () => Promise<Page>; readonly close: () => Promise<unknown> };
const { startHarness }: {
  startHarness: (options: { baseURL: string; viewport: string; theme: string }) => Promise<Harness>;
} = await import(new URL("./harness.mjs", import.meta.url).href);
async function state(page: Page, predicate: string, action = "") {
  await page.evaluate(`new Promise((resolve,reject)=>{
    const observer=new MutationObserver(check);
    const timer=setTimeout(()=>{observer.disconnect();reject(Error("Projection UI deadline"))},8000);
    function check(){if(${predicate}){observer.disconnect();clearTimeout(timer);resolve(true)}}
    observer.observe(document.body,{subtree:true,childList:true,attributes:true,characterData:true});
    ${action}
    check();
  })`);
}

test.each([...jimtofFrontCalibration.bindings])("explicit CPU frame load for $label displays saved bilateral paths without starting attention inference", async (binding) => {
  // Given a saved result and a projection-only frame response.
  const directory = await mkdtemp(join(tmpdir(), "vlaeval-projection-ui-"));
  const { job, packet } = diagnosticFixture();
  if (!job.result) throw new Error("Result required");
  job.result.dataset = binding.dataset;
  job.request.dataset = job.result.dataset; packet.identity.dataset = job.result.dataset;
  packet.attention = null; packet.schemaVersion = 2;
  for (const image of packet.images) { image.geometryResolved = false; image.preprocessing = null; }
  await Bun.write(join(directory, `${job.id}.json`), JSON.stringify(job));
  const store = new JobStore(directory, undefined, undefined, true);
  await store.initialize();
  const api = createApi(store);
  let captures = 0, inferences = 0;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, routes: { "/": index },
    async fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === `/api/jobs/${job.id}/projection` && request.method === "POST") {
        captures++; expect(await request.json()).toEqual({ episode: 3, frame: 0 });
        await store.saveDiagnostic(job.id, packet); return Response.json(packet);
      }
      if (path.endsWith("/diagnostics/run") && request.method === "POST") {
        inferences++;
        return Response.json({ runId: crypto.randomUUID(), jobId: job.id, episode: 3, frame: 0, status: "preflight", message: "fake" }, { status: 202 });
      }
      return api(request);
    } });
  const harness = await startHarness({ baseURL: server.url.href, viewport: "390x844", theme: "light" });
  try {
    const page = await harness.openPage();
    await state(page, `!!document.querySelector('[data-view-tab="prerelease"]')`);
    await state(page, `document.querySelector('[data-projection-load]')?.disabled===false`,
      `document.querySelector('[data-view-tab="prerelease"]').click();`);
    expect(captures).toBe(0); expect(inferences).toBe(0);
    expect(await page.evaluate(`document.querySelector('[data-projection-binding]').dataset.projectionBinding`)).toBe(binding.dataset);
    // When the explicit CPU action is triggered.
    await state(page, `document.querySelectorAll('[data-projected-side]').length===4`,
      `document.querySelector('[data-projection-load]').click();`);
    // Then the original RGB has paths even with no preprocessing or attention.
    expect(captures).toBe(1); expect(inferences).toBe(0);
    expect(await page.evaluate(`document.querySelector('[data-diagnostic-image-mode]').value`)).toBe("original");
    expect(await page.evaluate(`document.documentElement.scrollWidth<=innerWidth`)).toBe(true);
    // A projection-only frame explains the missing attention and starts a diagnostic only on explicit click.
    expect(await page.evaluate(`!!document.querySelector('[data-attention-missing]')`)).toBe(true);
    expect(inferences).toBe(0);
    await state(page, `document.querySelector('[data-diagnostic-run-status]')?.dataset.diagnosticRunStatus==="preflight"`,
      `document.querySelector('[data-attention-missing] [data-quick-diagnostic]').click();`);
    expect(inferences).toBe(1);
    // Same UI must distinguish successfully computed off-image paths from a failed capture.
    if (!packet.projection) throw new Error("Projection fixture required");
    packet.projection.camera.cx = 10000;
    await store.saveDiagnostic(job.id, packet);
    await state(page, `Number(document.querySelector('[data-projection-empty]')?.dataset.outsideImage)===16`,
      `document.querySelector('[data-diagnostic-refresh]').click();`);
  } finally { await harness.close(); server.stop(true); await rm(directory, { recursive: true, force: true }); }
}, 20000);
