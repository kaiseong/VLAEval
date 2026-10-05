import { expect, test } from "bun:test";

type Page = {
  evaluate: (script: string) => Promise<unknown>;
  cdp: (method: string, params: Record<string, unknown>) => Promise<unknown>;
};
type Harness = { openPage: (options: { mount: boolean }) => Promise<Page>; close: () => Promise<unknown> };
const { startHarness }: {
  startHarness: (options: { fixture: string; componentEntry: string; viewport: string; theme: string }) => Promise<Harness>;
} = await import(new URL("./harness.mjs", import.meta.url).href);

for (const viewport of ["1440x1000", "390x844"]) {
  for (const kind of ["scaled", "unscaled"]) {
    test(`selects original dense frames at real ${kind} path vertices in ${viewport}`, async () => {
      // Given: the actual production component, independent of OverviewGrid.
      const harness = await startHarness({
        fixture: "rby1-16", componentEntry: `${import.meta.dirname}/../fixtures/redesign/scaled-chart.mjs`,
        viewport, theme: "light",
      });
      try {
        const page = await harness.openPage({ mount: true });
        const selector = `[data-qa-chart="${kind}"] svg`;
        await page.evaluate(`new Promise((resolve,reject)=>{
          const svg=document.querySelector(${JSON.stringify(selector)});
          const ready=()=>Math.abs(svg.viewBox.baseVal.width-svg.getBoundingClientRect().width)<0.1;
          let timer;
          const observer=new MutationObserver(()=>{if(ready()){observer.disconnect();clearTimeout(timer);resolve(true)}});
          observer.observe(svg,{attributes:true,attributeFilter:["viewBox"]});
          timer=setTimeout(()=>{observer.disconnect();reject(Error("SVG sizing incomplete"))},5000);
          if(ready()){observer.disconnect();clearTimeout(timer);resolve(true)}
        })`);
        const selections = [];
        for (const frame of [10, 50, 90]) {
          // When: use the real emitted vertex and browser CTM, not selection math.
          const point: { x: number; y: number } = JSON.parse(String(await page.evaluate(`JSON.stringify((()=>{
            const svg=document.querySelector(${JSON.stringify(selector)});
            svg.scrollIntoView({block:"center"});
            const vertices=[...svg.querySelector(".trace-plot__predicted path").getAttribute("d")
              .matchAll(/[ML]([^,\\s]+),([^\\s]+)/g)];
            if(vertices.length!==101)throw Error("Dense source vertices missing");
            const vertex=vertices[${frame}];
            const matrix=svg.getScreenCTM();
            if(!matrix)throw Error("Screen CTM missing");
            const point=new DOMPoint(Number(vertex[1]),Number(vertex[2])).matrixTransform(matrix);
            if(!svg.contains(document.elementFromPoint(point.x,point.y)))throw Error("Vertex not hit-testable");
            window.__POINTER_TRUSTED__=false;
            svg.addEventListener("click",e=>{window.__POINTER_TRUSTED__=e.isTrusted},{once:true});
            window.__POINTER_SIGNAL__=new Promise((resolve,reject)=>{
              const controller=new AbortController();
              const timer=setTimeout(()=>{controller.abort();reject(Error("Selection event missing"))},5000);
              window.addEventListener("scaled-chart-selection",e=>{
                clearTimeout(timer);controller.abort();resolve(e.detail);
              },{once:true,signal:controller.signal});
            });
            return {x:point.x,y:point.y};
          })())`)));
          for (const type of ["mousePressed", "mouseReleased"]) {
            await page.cdp("Input.dispatchMouseEvent", { type, ...point, button: "left", clickCount: 1 });
          }
          const actual = await page.evaluate("window.__POINTER_SIGNAL__");
          const trusted = await page.evaluate("window.__POINTER_TRUSTED__");
          const shared = await page.evaluate(`[...document.querySelectorAll(".trace-plot")].every(p=>p.dataset.sourceFrame===${JSON.stringify(String(frame))})`);
          selections.push({ expected: frame, actual, trusted, shared });
        }
        // Then: the original input frame IDs, not ordinals or retained samples.
        console.log(JSON.stringify({ viewport, kind, selections }));
        expect(selections).toEqual([10, 50, 90].map((frame) => ({ expected: frame, actual: frame, trusted: true, shared: true })));
        expect(await page.evaluate("window.__SCALED_CHART_QA__.rawUnchanged()")).toBe(true);
      } finally {
        const cleanup = await harness.close();
        console.log(JSON.stringify({ viewport, kind, cleanup }));
        expect(cleanup).toEqual({ browserOpen: false, serverOpen: false, tempStoreExists: false, cleanupErrors: [] });
      }
    }, 20_000);
  }
}
