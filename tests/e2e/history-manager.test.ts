import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import index from "../../index.html";
import { createApi } from "../../src/api";
import { JobStore, isTerminal } from "../../src/jobs";
import { jobSchema, jobStorageSchema } from "../../src/contracts";
import { evaluationFixture } from "../evaluation-fixture";

type Page = { readonly evaluate: (script: string) => Promise<unknown> };
type Harness = { readonly openPage: () => Promise<Page>; readonly close: () => Promise<unknown> };
const { startHarness }: {
  startHarness: (options: { baseURL: string; viewport: string; theme: string }) => Promise<Harness>;
} = await import(new URL("./harness.mjs", import.meta.url).href);

async function state(page: Page, predicate: string, action = "") {
  await page.evaluate(`new Promise((resolve,reject)=>{
    const observer=new MutationObserver(check);
    const timer=setTimeout(()=>{observer.disconnect();reject(Error("History UI deadline: "+${JSON.stringify(predicate)}))},8000);
    function check(){if(${predicate}){observer.disconnect();clearTimeout(timer);resolve(true)}}
    observer.observe(document.body,{subtree:true,childList:true,attributes:true,characterData:true});
    ${action}
    check();
  })`);
}

test("confirmed cleanup removes disk/history/comparison, preserves failures and ignores stale refresh", async () => {
  // Given disposable real stored runs and a runner held open by an exact signal.
  const directory = await mkdtemp(join(tmpdir(), "vlaeval-history-ui-"));
  const base = evaluationFixture(701), other = evaluationFixture(702);
  const logSentinel = "JOB_LOG_SENTINEL_701";
  base.logs = [logSentinel];
  const basePath = join(directory, `${base.id}.json`), otherPath = join(directory, `${other.id}.json`);
  await Bun.write(basePath, JSON.stringify(base));
  await Bun.write(otherPath, JSON.stringify(other));
  const runner = Promise.withResolvers<void>();
  const store = new JobStore(directory, async () => runner.promise);
  await store.initialize();
  const active = await store.start(base.request);
  const finished = Promise.withResolvers<void>();
  const unsubscribe = store.subscribe(active.id, (job) => { if (isTerminal(job)) finished.resolve(); });
  const api = createApi(store);
  let holdHistory = false;
  const historyStarted = Promise.withResolvers<void>();
  const staleHistory = Promise.withResolvers<Response>();
  const deleteIds: string[] = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, routes: { "/": index },
    async fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === "/api/jobs" && request.method === "GET" && holdHistory) {
        historyStarted.resolve();
        return staleHistory.promise;
      }
      if (path === "/api/kinematics/profiles") return Response.json({ profiles: [] });
      if (request.method === "DELETE") {
        deleteIds.push(path.split("/").at(-1) ?? "");
        if (path.endsWith(other.id)) return Response.json({ error: "Synthetic filesystem failure" }, { status: 500 });
      }
      return api(request);
    },
  });
  const harness = await startHarness({ baseURL: server.url.href, viewport: "390x844", theme: "dark" });
  try {
    const before = jobStorageSchema.parse(await (await api(new Request(`${server.url}api/jobs/storage`))).json());
    const page = await harness.openPage();
    await state(page, `document.querySelector('#history option[value="${base.id}"]')`);
    await state(page, `!!document.querySelector('[data-evaluation-base]')`,
      `const s=document.querySelector('#history');s.value="${base.id}";s.dispatchEvent(new Event('change',{bubbles:true}));
       document.querySelector('[aria-controls="evaluation-results"]').click();`);
    expect(await page.evaluate(`document.querySelectorAll('.logs').length`)).toBe(0);
    expect(await page.evaluate(`document.body.textContent.includes(${JSON.stringify(logSentinel)})`)).toBe(false);
    expect(store.get(base.id).logs).toEqual([logSentinel]);
    expect(jobSchema.parse(JSON.parse(await Bun.file(basePath).text())).logs).toEqual([logSentinel]);
    await state(page, `document.querySelectorAll('[data-evaluation-table="overall"] tbody tr').length===2`,
      `document.querySelector('.evaluation-compare').open=true;document.querySelector('[data-compare-run="${other.id}"]').click();`);
    await state(page, `document.querySelector('[data-history-select="${base.id}"]')?.disabled===false`,
      `document.querySelector('[data-history-manager]').click();`);
    expect(await page.evaluate(`document.querySelector('[data-history-select="${active.id}"]').disabled`)).toBe(true);
    await state(page, `!document.querySelector('[data-history-delete]').disabled`,
      `document.querySelector('[data-history-select-all]').click();`);
    await state(page, `!!document.querySelector('[data-history-confirm-delete]')`,
      `document.querySelector('[data-history-delete]').click();`);
    expect(deleteIds).toEqual([]);
    expect(await page.evaluate(`document.activeElement.hasAttribute('data-history-cancel-delete')`)).toBe(true);
    await state(page, `!document.querySelector('[data-history-confirm-delete]')`,
      `document.querySelector('[data-history-cancel-delete]').click();`);
    expect(await Bun.file(basePath).exists()).toBe(true);

    // Arm a deliberately stale list response before confirming the destructive action.
    const oldJobs = JSON.stringify(store.list());
    holdHistory = true;
    await page.evaluate(`document.querySelector('[aria-label="기록 새로고침"]').click()`);
    await historyStarted.promise;
    await state(page, `!!document.querySelector('[data-history-confirm-delete]')`,
      `document.querySelector('[data-history-delete]').click();`);
    await state(page, `!!document.querySelector('[data-history-message]')&&!document.querySelector('[data-history-confirm-delete]')&&!document.querySelector('[data-history-close]').disabled`,
      `document.querySelector('[data-history-confirm-delete]').click();`);
    expect(await Bun.file(basePath).exists()).toBe(false);
    expect(await Bun.file(otherPath).exists()).toBe(true);
    expect(deleteIds.sort()).toEqual([base.id, other.id].sort());
    expect(await page.evaluate(`!!document.querySelector('.history-manager [role="alert"]')`)).toBe(true);
    const after = jobStorageSchema.parse(await (await api(new Request(`${server.url}api/jobs/storage`))).json());
    expect(after.totalBytes).toBe(before.totalBytes - (before.runs.find((item) => item.id === base.id)?.bytes ?? 0));
    // Then a late list cannot resurrect the deleted run, and comparisons drop it.
    holdHistory = false;
    staleHistory.resolve(new Response(oldJobs, { headers: { "content-type": "application/json" } }));
    await state(page, `!document.querySelector('[aria-label="기록 새로고침"]').disabled`);
    expect(await page.evaluate(`!!document.querySelector('#history option[value="${base.id}"]')`)).toBe(false);
    expect(await page.evaluate(`document.querySelectorAll('[data-evaluation-table="overall"] tbody tr').length`)).toBe(1);
    expect(await page.evaluate(`document.querySelector('[data-evaluation-table="overall"] tbody tr').dataset.resultRun`)).toBe(other.id);
    await state(page, `!document.querySelector('.history-manager').open`,
      `document.querySelector('[data-history-close]').click();`);
    expect(await page.evaluate(`document.activeElement.hasAttribute('data-history-manager')`)).toBe(true);
    expect(await page.evaluate(`document.documentElement.scrollWidth<=innerWidth`)).toBe(true);
    runner.resolve();
    await finished.promise;
    const restored = new JobStore(directory);
    await restored.initialize();
    expect(restored.list().some((job) => job.id === base.id)).toBe(false);
  } finally {
    holdHistory = false;
    staleHistory.resolve(Response.json(store.list()));
    runner.resolve();
    await finished.promise;
    unsubscribe();
    await harness.close();
    server.stop(true);
    await rm(directory, { recursive: true, force: true });
  }
}, 30000);
