import { expect, test } from "bun:test";
import index from "../../index.html";
import { evaluationFixture } from "../evaluation-fixture";
import { fixtureJobResponse } from "../job-routes";

type Page = { readonly evaluate: (script: string) => Promise<unknown> };
type Harness = { readonly openPage: () => Promise<Page>; readonly close: () => Promise<unknown> };
const { startHarness }: {
  startHarness: (options: { baseURL: string; viewport: string; theme: string }) => Promise<Harness>;
} = await import(new URL("./harness.mjs", import.meta.url).href);

async function state(page: Page, predicate: string, action = "") {
  const script = `new Promise((resolve,reject)=>{
    const observer=new MutationObserver(check);
    const timer=setTimeout(()=>{observer.disconnect();reject(Error("Evaluation result deadline"))},8000);
    function check(){if(${predicate}){observer.disconnect();clearTimeout(timer);resolve(true)}}
    observer.observe(document.body,{subtree:true,childList:true,attributes:true,characterData:true});
    ${action}
    check();
  })`;
  try {
    await page.evaluate(script);
  } catch (cause) {
    throw new Error(`Failed browser state: ${predicate}\n${script}`, { cause });
  }
}

test("separate results tab compares full chunks across models and all episodes", async () => {
  // Given two completed model runs and a failed run that must not be offered.
  const base = evaluationFixture(1), other = evaluationFixture(2, 2), third = evaluationFixture(4);
  const failed = { ...evaluationFixture(3), status: "failed" as const, result: null };
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, routes: { "/": index },
    fetch(request) {
      const path = new URL(request.url).pathname;
      if (path.startsWith("/api/jobs")) return fixtureJobResponse(new URL(request.url), [base, other, third, failed]);
      if (path === "/api/kinematics/profiles") return Response.json({ profiles: [] });
      return new Response("Not found", { status: 404 });
    },
  });
  const harness = await startHarness({ baseURL: server.url.href, viewport: "390x844", theme: "dark" });
  try {
    const page = await harness.openPage();
    await state(page, `document.querySelector('#history option[value="${base.id}"]')`);
    // When the dedicated tab opens, it exposes only whole-chunk result scopes.
    await state(page, `document.querySelector('[data-evaluation-table="overall"]')`,
      `document.querySelector('[aria-controls="evaluation-results"]').click();`);
    expect(await page.evaluate(`document.querySelector('#results').hidden`)).toBe(true);
    expect(await page.evaluate(`document.querySelectorAll('[data-evaluation-base] option').length`)).toBe(3);
    expect(await page.evaluate(`Number(document.querySelector('[data-evaluation-table="overall"] [data-metric="mse"]').dataset.value)`)).toBe(13.2);
    expect(await page.evaluate(`Number(document.querySelector('[data-result-episode="3"] [data-metric="mse"]').dataset.value)`)).toBeCloseTo(14 / 3, 12);
    expect(await page.evaluate(`Number(document.querySelector('[data-result-episode="9"] [data-metric="mse"]').dataset.value)`)).toBe(26);
    // p99/max |error| over valid rows: EP 3 rows 1, 3, 2 (the invalid 100 is skipped); EP 9 rows 4, 6.
    const cell = (scope: string, metric: string) =>
      page.evaluate(`Number(document.querySelector('${scope} [data-metric="${metric}"]').dataset.value)`);
    expect([await cell('[data-evaluation-table="overall"]', "p99"), await cell('[data-evaluation-table="overall"]', "max")]).toEqual([6, 6]);
    expect([await cell('[data-result-episode="3"]', "p99"), await cell('[data-result-episode="3"]', "max")]).toEqual([3, 3]);
    expect(await page.evaluate(`document.querySelector('[data-evaluation-table="overall"] [data-run-device]').textContent`))
      .toBe("추론: qa@localhost");
    expect(await page.evaluate(`document.querySelector('[data-evaluation-base]').selectedOptions[0].text`))
      .toContain("추론 3프레임 · EP 2개 · ");
    expect(await page.evaluate(`document.querySelector('[data-evaluation-table="overall"] [data-metric="max"] small').textContent`))
      .toBe("EP 9 · frame 0 · step 1 · action_0");
    await state(page, `document.querySelectorAll('[data-evaluation-table="overall"] tbody tr').length===2`,
      `document.querySelector('.evaluation-compare').open=true;document.querySelector('[data-compare-run="${other.id}"]').click();`);
    expect(await page.evaluate(`document.querySelectorAll('[data-evaluation-table="episodes"] tbody tr').length`)).toBe(4);
    expect(await page.evaluate(`document.querySelector('[data-comparison-job]').dataset.comparisonStatus`)).toBe("matched");
    // A second comparison run joins the table (the checkbox state is read inside the event).
    await state(page, `document.querySelectorAll('[data-evaluation-table="overall"] tbody tr').length===3`,
      `document.querySelector('[data-compare-run="${third.id}"]').click();`);
    await state(page, `document.querySelectorAll('[data-evaluation-table="overall"] tbody tr').length===2`,
      `document.querySelector('[data-compare-run="${third.id}"]').click();`);
    expect(await page.evaluate(`Number(document.querySelector('[data-evaluation-table="overall"] [data-result-run="${other.id}"] [data-metric="mse"]').dataset.value)`)).toBe(52.8);
    expect(await page.evaluate(`document.documentElement.scrollWidth<=innerWidth`)).toBe(true);
    await state(page, `document.querySelector('[data-evaluation-base]').value==="${other.id}"`,
      `const select=document.querySelector('#history');select.value="${other.id}";select.dispatchEvent(new Event('change',{bubbles:true}));`);
    expect(await page.evaluate(`document.querySelector('#evaluation-results').hidden`)).toBe(false);
    // Then returning to analysis preserves its separate Prediction workspace.
    await state(page, `!document.querySelector('#results').hidden`,
      `document.querySelector('[aria-controls="results"]').click();`);
    expect(await page.evaluate(`document.querySelector('#evaluation-results').hidden`)).toBe(true);
    expect(await page.evaluate(`document.querySelectorAll('#results [data-evaluation-table]').length`)).toBe(0);
  } finally {
    await harness.close();
    server.stop(true);
  }
}, 25000);
