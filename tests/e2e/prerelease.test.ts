import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import index from "../../index.html";
import { JobStore } from "../../src/jobs";
import { createApi } from "../../src/api";
import { diagnosticFixture } from "../diagnostic-fixture";

type Page = { readonly evaluate: (script: string) => Promise<unknown> };
type Harness = { readonly openPage: () => Promise<Page>; readonly close: () => Promise<unknown> };
const { startHarness }: {
  startHarness: (options: { baseURL: string; viewport: string; theme: string }) => Promise<Harness>;
} = await import(new URL("./harness.mjs", import.meta.url).href);

async function state(page: Page, predicate: string, action = "") {
  await page.evaluate(`new Promise((resolve,reject)=>{
    const observer=new MutationObserver(check);
    const timer=setTimeout(()=>{observer.disconnect();reject(Error("Pre-release deadline: "+${JSON.stringify(predicate)}))},8000);
    function check(){if(${predicate}){observer.disconnect();clearTimeout(timer);resolve(true)}}
    observer.observe(document.body,{subtree:true,childList:true,attributes:true,characterData:true});
    ${action}
    check();
  })`);
}

for (const mismatch of [false, true]) test(`Pre-release ${mismatch ? "rejects actual image dimension mismatch" : "explores saved layers, steps, groups and projected trajectories without inference"}`, async () => {
  const directory = await mkdtemp(join(tmpdir(), "vlaeval-prerelease-"));
  const { job, packet } = diagnosticFixture();
  if (mismatch) {
    const image = packet.images[0];
    if (!image || !packet.projection) throw new Error("Image and projection required");
    image.width = 128; image.height = 96;
    packet.projection.camera.width = 128; packet.projection.camera.height = 96;
  }
  await Bun.write(join(directory, `${job.id}.json`), JSON.stringify(job));
  const store = new JobStore(directory, undefined, undefined, true);
  await store.initialize();
  await store.saveDiagnostic(job.id, packet);
  const api = createApi(store);
  const calls: string[] = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, routes: { "/": index },
    fetch(request) {
      const path = new URL(request.url).pathname;
      calls.push(`${request.method} ${path}`);
      if (path === "/api/kinematics/profiles") return Response.json({ profiles: [] });
      return api(request);
    },
  });
  const harness = await startHarness({ baseURL: server.url.href, viewport: "390x844", theme: "dark" });
  try {
    const page = await harness.openPage();
    await state(page, `!!document.querySelector('[data-view-tab="prerelease"]')`);
    await state(page, `document.querySelector('.diagnostic-canvas')?.dataset.imageState==="${mismatch ? "invalid" : "ready"}"`,
      `document.querySelector('[data-view-tab="prerelease"]').click();`);
    if (mismatch) {
      expect(await page.evaluate(`document.querySelectorAll('[data-diagnostic-overlay]').length`)).toBe(0);
      expect(await page.evaluate(`!!document.querySelector('.diagnostic-canvas [role="alert"]')`)).toBe(true);
      return;
    }
    expect(await page.evaluate(`document.querySelector('.diagnostic-result').dataset.attentionStep`)).toBe("1");
    expect(await page.evaluate(`document.querySelector('.diagnostic-result').dataset.attentionLayer`)).toBe("all");
    expect(await page.evaluate(`document.querySelectorAll('[data-attention-grid] rect').length`)).toBe(16);
    expect(await page.evaluate(`document.querySelectorAll('[data-projected-side]').length`)).toBe(4);
    expect(await page.evaluate(`document.querySelector('[data-projected-side="left"][data-projected-source="predicted"] path').getAttribute('d').startsWith('M20,24')`)).toBe(true);
    expect(await page.evaluate(`document.querySelector('[data-attention-grid]').parentElement.getAttribute('transform')`)).toBe("matrix(1 0 0 1 0 -8)");
    expect(await page.evaluate(`Number(document.querySelector('[data-attention-mass="front"]').dataset.value)`)).toBeCloseTo(0.5, 14);
    const requestsBefore = calls.length;
    expect(await page.evaluate(`document.querySelector('.diagnostic-result').dataset.attentionScale`)).toBe("camera");
    await state(page, `document.querySelector('.diagnostic-result').dataset.attentionScale==="shared"`,
      `const s=document.querySelector('[data-diagnostic-scale]');s.value="shared";s.dispatchEvent(new Event('change',{bubbles:true}));`);
    await state(page, `document.querySelectorAll('[data-attention-grid]').length===2`,
      `const s=document.querySelector('[data-diagnostic-image-mode]');s.value="compare";s.dispatchEvent(new Event('change',{bubbles:true}));`);
    await state(page, `document.querySelectorAll('[data-attention-selection="5"]').length===2`,
      `document.querySelector('[data-image-mode="tokens"] [data-attention-patch="5"]').dispatchEvent(new MouseEvent('click',{bubbles:true}));`);
    expect(await page.evaluate(`document.querySelector('[data-diagnostic-patch]').value`)).toBe("5");
    expect(await page.evaluate(`[...document.querySelectorAll('[data-attention-selection]')].map(e=>[e.getAttribute('x'),e.getAttribute('y')])`))
      .toEqual([["16", "16"], ["16", "16"]]);
    expect(await page.evaluate(`Number(document.querySelector('[data-attention-mass="front"]').dataset.value)`)).toBeCloseTo(0.5, 14);
    await state(page, `document.querySelector('.diagnostic-result').dataset.attentionLayer==="0"`,
      `const s=document.querySelector('[data-diagnostic-layer]');s.value="0";s.dispatchEvent(new Event('change',{bubbles:true}));`);
    await state(page, `document.querySelector('.diagnostic-result').dataset.attentionLayer==="all"`,
      `const s=document.querySelector('[data-diagnostic-layer]');s.value="all";s.dispatchEvent(new Event('change',{bubbles:true}));`);
    await state(page, `document.querySelector('.diagnostic-result').dataset.attentionStep==="0"`,
      `const s=document.querySelector('[data-diagnostic-step]');s.value="0";s.dispatchEvent(new Event('change',{bubbles:true}));`);
    await state(page, `document.querySelector('.diagnostic-result').dataset.attentionQuery==="early"`,
      `const s=document.querySelector('[data-diagnostic-query]');s.value="early";s.dispatchEvent(new Event('change',{bubbles:true}));`);
    expect(calls.length).toBe(requestsBefore);
    expect(await page.evaluate(`document.documentElement.scrollWidth<=innerWidth`)).toBe(true);
    await state(page, `document.querySelector('.prerelease')?.dataset.prereleaseFrame==="1"&&!document.querySelector('.diagnostic-result')`,
      `const e=document.querySelector('#workspace-frame');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,'1');e.dispatchEvent(new Event('input',{bubbles:true}));`);
    const imported = structuredClone(packet);
    imported.identity.frame = 1;
    const uploadScript = `const file=new File([${JSON.stringify(JSON.stringify(imported))}],"diagnostic.json",{type:"application/json"});
      const transfer=new DataTransfer();transfer.items.add(file);const input=document.querySelector('[data-diagnostic-import]');
      input.files=transfer.files;input.dispatchEvent(new Event('change',{bubbles:true}));`;
    await state(page, `document.querySelector('.diagnostic-canvas')?.dataset.imageState==="ready"`, uploadScript);
    expect((await store.getDiagnostic(job.id, 3, 1)).identity.frame).toBe(1);
    expect(calls.filter((call) => call.startsWith("PUT "))).toHaveLength(1);
    expect(calls.filter((call) => call.startsWith("POST "))).toEqual([]);
  } finally {
    await harness.close(); server.stop(true); await rm(directory, { recursive: true, force: true });
  }
}, 30000);
