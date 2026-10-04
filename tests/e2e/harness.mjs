import { mkdtemp, rm, realpath } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import index from "../../index.html";
import { fixtureJob, fixtureJobs, fixtureNames, fixtureSnapshot, transportResponse } from "../fixtures/redesign/index.mjs";

const timeoutMs = 10_000;
const responseBodyLimit = 1_000_000;

function withTimeout(promise, label) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
    }),
  ]).finally(() => clearTimeout(timer));
}

function componentMountHtml(moduleURL, stylesheetURLs, theme) {
  const links = stylesheetURLs.map((url) => `<link rel="stylesheet" href="${url}">`).join("");
  return `<!doctype html><html data-theme="${theme}" style="color-scheme:${theme === "system" ? "light dark" : theme}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">${links}</head><body><div id="root"></div><script type="module">window.__VLAEVAL_QA_MOUNT_STATUS__="pending";window.__VLAEVAL_QA_MOUNT_PROMISE__=(async()=>{try{const expectedStylesheets=${JSON.stringify(stylesheetURLs)};await Promise.all([...document.querySelectorAll('link[rel="stylesheet"]')].map(link=>link.sheet?Promise.resolve():new Promise((resolve,reject)=>{link.addEventListener("load",resolve,{once:true});link.addEventListener("error",reject,{once:true})})));const mountModule=await import(${JSON.stringify(moduleURL)});const mount=mountModule.mount;if(typeof mount!=="function")throw new Error("Component entry must export mount(element, props)");const assertions=await mount(document.querySelector("#root"),JSON.parse(new URL(location.href).searchParams.get("props")||"{}"));if(!Array.isArray(assertions)||assertions.length===0)throw new Error("Component mount must return a nonempty array of machine-readable assertions");const loadedStylesheets=[...document.styleSheets].map(sheet=>sheet.href).filter(Boolean);window.__VLAEVAL_QA_ASSERTIONS__=[{name:"component-build-stylesheets-loaded",passed:expectedStylesheets.every(url=>loadedStylesheets.includes(new URL(url,location.href).href)),detail:JSON.stringify({expected:expectedStylesheets,loaded:loadedStylesheets})},...assertions];window.__VLAEVAL_QA_MOUNT_STATUS__="complete";return "complete"}catch(error){window.__VLAEVAL_QA_MOUNT_ERROR__=String(error);window.__VLAEVAL_QA_MOUNT_STATUS__="failed";return "failed"}})();</script></body></html>`;
}

export async function startHarness({ fixture, transport, componentEntry, viewport = "1440x1000", theme = "system", baseURL }) {
  if (!["system", "light", "dark"].includes(theme)) {
    throw new Error(`Unsupported theme "${theme}"; expected system, light, or dark.`);
  }
  if (!baseURL && !fixtureNames.includes(fixture)) {
    throw new Error(`Unsupported fixture "${fixture}". Available: ${fixtureNames.join(", ")}`);
  }
  if (baseURL && componentEntry) throw new Error("External base URLs cannot be combined with a component entry.");
  if (baseURL) {
    const externalURL = new URL(baseURL);
    if (externalURL.protocol !== "http:" && externalURL.protocol !== "https:") {
      throw new Error(`Unsupported external base URL protocol "${externalURL.protocol}".`);
    }
  }

  const componentAssets = new Map();
  let componentEntryURL;
  const componentStylesheetURLs = [];
  if (componentEntry) {
    const repoRoot = resolve(import.meta.dirname, "../..");
    const entryPath = resolve(componentEntry);
    const pathFromRoot = relative(repoRoot, entryPath);
    if (pathFromRoot.startsWith(`..${sep}`) || pathFromRoot === "..") {
      throw new Error("--component-entry must resolve inside the repository worktree");
    }
    const build = await Bun.build({ entrypoints: [entryPath], target: "browser", format: "esm", write: false });
    if (!build.success) throw new AggregateError(build.logs, "Could not bundle component entry");
    for (const output of build.outputs) {
      const outputName = output.path.replaceAll("\\", "/").replace(/^\.\//, "");
      if (!outputName || outputName.split("/").some((segment) => segment === ".." || segment === "")) {
        throw new Error(`Component build emitted an invalid asset path "${output.path}"`);
      }
      const assetURL = `/__qa/component-assets/${outputName.split("/").map(encodeURIComponent).join("/")}`;
      componentAssets.set(outputName, {
        body: new Uint8Array(await output.arrayBuffer()),
        contentType: output.type,
      });
      if (output.kind === "entry-point" && output.type.startsWith("text/javascript")) {
        componentEntryURL = assetURL;
      }
      if (output.type.startsWith("text/css")) componentStylesheetURLs.push(assetURL);
    }
    if (!componentEntryURL) throw new Error("Component build emitted no JavaScript entry point");
  }

  const tempStore = await mkdtemp(join(tmpdir(), "vlaeval-qa-runs-"));
  const [width, height] = viewport.split("x").map(Number);
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
    await rm(tempStore, { recursive: true, force: true });
    throw new Error(`Invalid viewport "${viewport}"; expected WIDTHxHEIGHT`);
  }
  let server;
  let browser;
  let cleanupErrors = [];
  const requests = [];
  async function captureResponse(request, response) {
    const body = await response.clone().text();
    requests.push({
      method: request.method,
      url: request.url,
      status: response.status,
      headers: Object.fromEntries(response.headers),
      body: body.length <= responseBodyLimit ? body : null,
      bodyBytes: Buffer.byteLength(body),
      bodySha256: createHash("sha256").update(body).digest("hex"),
      bodyTruncated: body.length > responseBodyLimit,
    });
    return response;
  }
  try {
    if (!baseURL) {
      server = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        idleTimeout: 0,
        routes: { "/": index },
        async fetch(request) {
          const url = new URL(request.url);
          if (url.pathname === "/api/jobs") {
            if (transport) return captureResponse(request, transportResponse(transport));
            return captureResponse(request, Response.json(fixtureJobs(fixture)));
          }
          if (url.pathname.startsWith("/api/jobs/")) {
            if (transport) return captureResponse(request, transportResponse(transport));
            const job = fixtureJob(fixture);
            return captureResponse(request, job.id === url.pathname.split("/").at(-1)
              ? Response.json(job)
              : Response.json({ error: "Not found" }, { status: 404 }));
          }
          if (url.pathname.startsWith("/__qa/fixtures/")) {
            const fixtureName = url.pathname.slice("/__qa/fixtures/".length);
            return captureResponse(request, fixtureNames.includes(fixtureName)
              ? Response.json(fixtureSnapshot(fixtureName))
              : Response.json({ error: "Unknown QA fixture" }, { status: 404 }));
          }
          if (url.pathname === "/__qa/mount") {
            if (!componentEntryURL) return new Response("Component mount is not configured", { status: 404 });
            return captureResponse(request, new Response(componentMountHtml(componentEntryURL, componentStylesheetURLs, theme), {
              headers: { "content-type": "text/html; charset=utf-8" },
            }));
          }
          if (url.pathname.startsWith("/__qa/component-assets/")) {
            const assetName = decodeURIComponent(url.pathname.slice("/__qa/component-assets/".length));
            const asset = componentAssets.get(assetName);
            return captureResponse(request, asset
              ? new Response(asset.body, { headers: { "content-type": asset.contentType } })
              : new Response("Not found", { status: 404 }));
          }
          return new Response("Not found", { status: 404 });
        },
      });
    }

    return {
      url: baseURL ?? server.url.href,
      requests,
      tempStore,
      async openPage({ mount = false, componentProps = {} } = {}) {
        browser = new Bun.WebView({ width, height, backend: "chrome" });
        await withTimeout(browser.navigate("about:blank"), "browser initialization");
        if (theme !== "system") {
          await browser.cdp("Page.addScriptToEvaluateOnNewDocument", {
            source: `document.documentElement.dataset.theme=${JSON.stringify(theme)};`,
          });
          await browser.cdp("Emulation.setEmulatedMedia", {
            features: [{ name: "prefers-color-scheme", value: theme }],
          });
        }
        const componentQuery = new URLSearchParams({ props: JSON.stringify(componentProps) });
        const pageURL = baseURL ?? (mount ? `${server.url.href}__qa/mount?${componentQuery}` : server.url.href);
        await withTimeout(browser.navigate(pageURL), "browser navigation");
        await browser.cdp("Emulation.setDeviceMetricsOverride", {
          width,
          height,
          deviceScaleFactor: 1,
          mobile: width < 500,
        });
        if (!mount) {
          const loaded = baseURL
            ? "document.readyState === 'complete'"
            : transport
            ? "document.body.innerText.includes('요청을 완료하지 못했습니다')"
            : fixture === "malformed-and-empty"
              ? "document.body.innerText.includes('저장된 실행이 없습니다.')"
              : "document.body.innerText.includes('qa_fixture')";
          await withTimeout(browser.evaluate(`new Promise((resolve,reject)=>{const ready=()=>document.querySelector("main h1")?.textContent==="에피소드 평가"&&(${loaded});if(ready())return resolve(true);const observer=new MutationObserver(()=>{if(ready()){observer.disconnect();resolve(true)}});observer.observe(document.documentElement,{childList:true,subtree:true,characterData:true});setTimeout(()=>{observer.disconnect();reject(new Error("Production React entry or requested fixture state did not render"))},${timeoutMs})})`), "React render");
          if (theme !== "system" && !baseURL) {
            await withTimeout(browser.evaluate(`new Promise((resolve,reject)=>{const theme=${JSON.stringify(theme)};const select=[...document.querySelectorAll(".rail-footer select")].find((item)=>[...item.options].some((option)=>option.value===theme));if(!select)return reject(new Error("Production theme selector was not rendered"));const root=document.documentElement;const applied=()=>root.dataset.theme===theme&&select.value===theme;const observer=new MutationObserver(()=>{if(applied()){observer.disconnect();resolve(true)}});observer.observe(root,{attributes:true,attributeFilter:["data-theme"]});select.value=theme;select.dispatchEvent(new Event("change",{bubbles:true}));if(applied()){observer.disconnect();resolve(true)}setTimeout(()=>{observer.disconnect();reject(new Error("Requested theme did not apply before capture"))},${timeoutMs})})`), "theme application");
          } else if (theme !== "system" && baseURL) {
            await browser.evaluate(`document.documentElement.dataset.theme=${JSON.stringify(theme)};`);
          }
        } else {
          const mountStatus = await withTimeout(browser.evaluate("window.__VLAEVAL_QA_MOUNT_PROMISE__"), "component mount assertions");
          if (mountStatus !== "complete") {
            const detail = await browser.evaluate("window.__VLAEVAL_QA_MOUNT_ERROR__ ?? 'component mount did not complete'");
            throw new Error(`Component mount failed: ${detail}`);
          }
          const assertionCount = await browser.evaluate("Array.isArray(window.__VLAEVAL_QA_ASSERTIONS__) ? window.__VLAEVAL_QA_ASSERTIONS__.length : 0");
          if (assertionCount < 1) throw new Error("Component mount completed without nonempty machine-readable assertions.");
        }
        return browser;
      },
      async close() {
        if (browser) {
          try { await browser.close(); } catch (error) { cleanupErrors.push(`browser: ${String(error)}`); }
          browser = undefined;
        }
        if (server) {
          try { server.stop(true); } catch (error) { cleanupErrors.push(`server: ${String(error)}`); }
          server = undefined;
        }
        try { await rm(tempStore, { recursive: true, force: true }); } catch (error) {
          cleanupErrors.push(`tempStore: ${String(error)}`);
        }
        const resources = {
          browserOpen: browser !== undefined,
          serverOpen: server !== undefined,
          tempStoreExists: false,
          cleanupErrors,
        };
        try { await realpath(tempStore); resources.tempStoreExists = true; } catch { /* absent is expected after rm */ }
        return resources;
      },
    };
  } catch (error) {
    if (browser) await browser.close();
    if (server) server.stop(true);
    await rm(tempStore, { recursive: true, force: true });
    throw error;
  }
}

