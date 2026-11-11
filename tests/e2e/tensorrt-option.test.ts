import { expect, test } from "bun:test";
import index from "../../index.html";
import { fixtureJobResponse } from "../job-routes";

type Page = { readonly evaluate: (script: string) => Promise<unknown> };
type Harness = { readonly openPage: () => Promise<Page>; readonly close: () => Promise<unknown> };
const { startHarness }: {
  startHarness: (options: { baseURL: string; viewport: string; theme: string }) => Promise<Harness>;
} = await import(new URL("./harness.mjs", import.meta.url).href);

async function state(page: Page, predicate: string, action = "") {
  const script = `new Promise((resolve,reject)=>{
    const observer=new MutationObserver(check);
    const timer=setTimeout(()=>{observer.disconnect();reject(Error("TensorRT option deadline"))},8000);
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

const choose = (selector: string, value: string) =>
  `const select=document.querySelector('${selector}');select.value="${value}";select.dispatchEvent(new Event('change',{bubbles:true}));`;
const target = "document.querySelector('#connection select')";
const launch = "document.querySelector('.launch-bar').textContent";

test("the TensorRT compute mode is offered only for Thor and is not carried to other targets", async () => {
  // Given the app with no stored runs.
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, routes: { "/": index }, fetch(request) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/jobs")) return fixtureJobResponse(url, []);
    if (url.pathname === "/api/kinematics/profiles") return Response.json({ profiles: [] });
    return new Response("Not found", { status: 404 });
  } });
  const harness = await startHarness({ baseURL: server.url.href, viewport: "1440x1000", theme: "system" });
  try {
    const page = await harness.openPage();
    await state(page, `${target} && !document.querySelector('#connection fieldset').disabled`);
    // When RTX6000 is the target, there is no compute choice.
    await state(page, `${target}.value==="rtx6000" && !document.querySelector('#compute-mode')`, choose("#connection select", "rtx6000"));
    // Then Thor offers it, defaulting to PyTorch, and TensorRT marks the launch summary.
    await state(page, `document.querySelector('#compute-mode')?.value==="pytorch"`, choose("#connection select", "thor"));
    expect(await page.evaluate(launch)).not.toContain("TensorRT");
    await state(page, `${launch}.includes("TensorRT")`, choose("#compute-mode", "tensorrt"));
    // And switching back to RTX6000 hides the choice and drops it from the request summary.
    await state(page, `!document.querySelector('#compute-mode') && !${launch}.includes("TensorRT")`,
      choose("#connection select", "rtx6000"));
  } finally {
    await harness.close();
    server.stop(true);
  }
}, 25000);
