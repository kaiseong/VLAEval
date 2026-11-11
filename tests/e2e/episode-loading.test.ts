import { expect, test } from "bun:test";
import index from "../../index.html";
import { jobSchema, resultSchema } from "../../src/contracts";
import { fixtureJobResponse } from "../job-routes";
import { resultFixture } from "../result-fixture";

type Page = { readonly evaluate: (script: string) => Promise<unknown> };
type Harness = { readonly openPage: () => Promise<Page>; readonly close: () => Promise<unknown> };
const { startHarness }: {
  startHarness: (options: { baseURL: string; viewport: string; theme: string }) => Promise<Harness>;
} = await import(new URL("./harness.mjs", import.meta.url).href);

async function state(page: Page, predicate: string, action = "") {
  const script = `new Promise((resolve,reject)=>{
    const observer=new MutationObserver(check);
    const timer=setTimeout(()=>{observer.disconnect();reject(Error("Episode loading deadline"))},8000);
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

const selectEpisode = (episode: number) =>
  `const select=document.querySelector('#workspace-episode');select.value="${episode}";select.dispatchEvent(new Event('change',{bubbles:true}));`;

test("a large episode loads page by page with progress and is reused when reopened", async () => {
  // Given a run whose EP 5 holds 1,201 two-step chunks (three pages) and whose EP 2 holds one.
  const frames = Array.from({ length: 1201 }, (_, index) => index);
  const chunk = (episode: number, frame: number) => ({
    episode, frame, prompt: "", predicted: [[frame, -frame], [frame, -frame]], target: [[0, 0], [0, 0]], valid: [true, true],
  });
  const result = resultSchema.parse({
    ...resultFixture, framesEvaluated: 1202, validSteps: 2404,
    perEpisode: [
      { episode: 5, framesEvaluated: 1201, mae: 0.1, rmse: 0.1 }, { episode: 2, framesEvaluated: 1, mae: 0.1, rmse: 0.1 },
    ],
    perHorizon: [{ step: 0, count: 1202, mae: 0.1, rmse: 0.1 }, { step: 1, count: 1202, mae: 0.1, rmse: 0.1 }],
    traces: [
      { episode: 5, frames, predicted: frames.map((frame) => [frame, -frame]), target: frames.map(() => [0, 0]) },
      { episode: 2, frames: [0], predicted: [[0, 0]], target: [[0, 0]] },
    ],
    samples: [...frames.map((frame) => chunk(5, frame)), chunk(2, 0)],
  });
  const job = jobSchema.parse({
    id: "00000000-0000-4000-8000-0000000000e5", status: "completed", createdAt: "2026-11-11T00:00:00.000Z",
    request: {
      host: "rtx6000@192.168.0.3", repo: "/models/openpi", config: "qa_fixture",
      checkpoint: "/qa/checkpoint", dataset: "/qa/dataset", episodes: [5, 2],
    },
    progress: { completed: 1, total: 1, message: "평가 완료" }, logs: [], result, error: null,
  });
  const pages: string[] = [];
  const secondPage = Promise.withResolvers<void>();
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, routes: { "/": index }, async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname.endsWith("/samples")) {
      pages.push(`${url.pathname.split("/").at(-2)}:${url.searchParams.get("offset")}`);
      if (url.searchParams.get("offset") === "500") await secondPage.promise;
    }
    if (url.pathname.startsWith("/api/jobs")) return fixtureJobResponse(url, [job]);
    if (url.pathname === "/api/kinematics/profiles") return Response.json({ profiles: [] });
    return new Response("Not found", { status: 404 });
  } });
  const harness = await startHarness({ baseURL: server.url.href, viewport: "1440x1000", theme: "system" });
  try {
    const page = await harness.openPage();
    // When EP 5 opens, the first page arrives while the second is held back.
    await state(page, `document.querySelector('[data-episode-load="loading"] progress')?.value===500`);
    const status = String(await page.evaluate(`document.querySelector('[data-episode-load="loading"]').textContent`));
    expect(status).toContain("500 / 1,201");
    expect(status).toContain("초 남음");
    // Then all three pages complete the episode: only the last chunk reaches frame 1201.
    secondPage.resolve();
    await state(page, `document.querySelector('.result-workspace[data-episode="5"][data-window-end="1201"]')
      && !document.querySelector('[data-episode-load]')`);
    expect(pages).toEqual(["5:0", "5:500", "5:1000"]);
    // And switching to EP 2 and back reuses the EP 5 already in the page.
    await state(page, `document.querySelector('.result-workspace[data-episode="2"]')`, selectEpisode(2));
    await state(page, `document.querySelector('.result-workspace[data-episode="5"][data-window-end="1201"]')`, selectEpisode(5));
    expect(pages).toEqual(["5:0", "5:500", "5:1000", "2:0"]);
  } finally {
    await harness.close();
    server.stop(true);
  }
}, 30000);
