import { expect, test } from "bun:test";
import { z } from "zod";
import index from "../../index.html";

type Page = { evaluate: (script: string) => Promise<unknown> };
type Harness = { openPage: () => Promise<Page>; close: () => Promise<unknown> };
const { startHarness }: {
  startHarness: (options: { baseURL: string; viewport: string; theme: string }) => Promise<Harness>;
} = await import(new URL("./harness.mjs", import.meta.url).href);

function fixtureServer() {
  const calls: { path: string; host: string }[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0, routes: { "/": index },
    async fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === "/api/jobs") return Response.json([]);
      if (request.method !== "POST") return new Response("Not found", { status: 404 });
      const { host } = z.object({ host: z.string() }).parse(await request.json());
      calls.push({ path, host });
      if (path === "/api/openpi-checkpoints") return Response.json({
        checkpoints: [{ path: `/checkpoints/${host}/model`, format: "jax", step: "100" }], warnings: [],
      });
      if (path === "/api/datasetui") return Response.json({
        datasets: [{ id: "fixture", name: "DatasetUI fixture", storageArea: "raw",
          path: `/datasets/${host}/episode-set`, episodes: 2, frames: 120, fps: 30, version: "v3.0" }], warnings: [],
      });
      return new Response("Not found", { status: 404 });
    },
  });
  return { server, calls };
}

async function waitFor(page: Page, predicate: string) {
  return page.evaluate(`new Promise((resolve,reject)=>{
    const check=()=>{if(${predicate}){observer.disconnect();clearTimeout(timer);resolve(true)}};
    const observer=new MutationObserver(check);
    const timer=setTimeout(()=>{observer.disconnect();reject(Error("Catalog render deadline"))},5000);
    observer.observe(document.body,{subtree:true,childList:true,attributes:true});check();
  })`);
}

test("preparation loads both catalogs and selected paths reach the evaluation inputs", async () => {
  const { server, calls } = fixtureServer();
  const harness = await startHarness({ baseURL: server.url.href, viewport: "1440x1000", theme: "system" });
  try {
    const page = await harness.openPage();
    await waitFor(page, `document.querySelectorAll('[data-catalog-status="ready"]').length===2`);
    await page.evaluate(`(()=>{
      for(const kind of ['openpi','datasetui']){
        const select=document.querySelector('[data-artifact-select="'+kind+'"]');
        select.value=select.options[1].value;
        select.dispatchEvent(new Event('change',{bubbles:true}));
      }
      return true;
    })()`);
    expect(await page.evaluate(`document.querySelector('input[list="checkpoints"]').value`))
      .toBe("/checkpoints/rtx6000@192.168.0.3/model");
    expect(await page.evaluate(`document.querySelector('input[list="datasets"]').value`))
      .toBe("/datasets/rtx6000@192.168.0.3/episode-set");
    expect(calls.map((call) => call.path).sort()).toEqual(["/api/datasetui", "/api/openpi-checkpoints"]);
  } finally {
    await harness.close();
    server.stop(true);
  }
}, 20000);

test("changing hosts invalidates both catalogs and only explicit refresh loads the new host", async () => {
  const { server, calls } = fixtureServer();
  const harness = await startHarness({ baseURL: server.url.href, viewport: "390x844", theme: "system" });
  try {
    const page = await harness.openPage();
    await waitFor(page, `document.querySelectorAll('[data-catalog-status="ready"]').length===2`);
    await page.evaluate(`(()=>{
      const input=document.querySelector('#connection input');
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'changed@192.168.0.9');
      input.dispatchEvent(new Event('input',{bubbles:true}));return true;
    })()`);
    await waitFor(page, `document.querySelectorAll('[data-catalog-status="idle"]').length===2`);
    expect(calls).toHaveLength(2);
    expect(await page.evaluate(`document.querySelector('[data-artifact-select="openpi"]').disabled`)).toBe(true);
    expect(await page.evaluate(`document.querySelector('[data-artifact-select="datasetui"]').options.length`)).toBe(1);
    await page.evaluate(`document.querySelector('[data-artifact-kind="openpi"] button').click()`);
    await waitFor(page, `document.querySelector('[data-artifact-kind="openpi"]').dataset.catalogStatus==='ready'`);
    expect(calls.at(-1)).toEqual({ path: "/api/openpi-checkpoints", host: "changed@192.168.0.9" });
    expect(await page.evaluate(`document.querySelector('[data-artifact-select="openpi"]').options[1].value`))
      .toBe("/checkpoints/changed@192.168.0.9/model");
    expect(await page.evaluate(`document.querySelector('[data-artifact-kind="datasetui"]').dataset.catalogStatus`)).toBe("idle");
  } finally {
    await harness.close();
    server.stop(true);
  }
}, 20000);
