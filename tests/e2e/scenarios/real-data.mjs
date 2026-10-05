import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createApi } from "../../../src/api.ts";
import { JobStore } from "../../../src/jobs.ts";

const repoRoot = resolve(import.meta.dirname, "../../..");
const archivedBaseURL = "http://127.0.0.1:4310";
const archivedRunId = "1f607d94-fb34-4cfb-96aa-cabe5a882a88";
const archivedTimeoutMs = 30_000;
const browserTimeoutMs = 60_000;
const inferenceTimeoutMs = 20 * 60_000;
const cancellationTimeoutMs = 60_000;
const terminalJobStatuses = new Set(["completed", "failed", "cancelled"]);
const formatScore = (value) => value.toLocaleString("ko-KR", { maximumFractionDigits: 6 });
const sha256 = (value) => createHash("sha256").update(value).digest("hex");

function assertion(assertions, name, passed, detail = "") {
  assertions.push({ name, passed: passed === true, detail });
}

function deepEqual(left, right) {
  if (Object.is(left, right)) return true;
  if (left === null || right === null || typeof left !== "object" || typeof right !== "object") return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right)
      && left.length === right.length && left.every((value, index) => deepEqual(value, right[index]));
  }
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return deepEqual(leftKeys, rightKeys)
    && leftKeys.every((key) => deepEqual(left[key], right[key]));
}

async function bounded(promise, label, timeoutMs = browserTimeoutMs) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs} ms`)), timeoutMs);
    }),
  ]).finally(() => clearTimeout(timer));
}

async function jsonRequest(url, actions, { method = "GET", body, timeoutMs = archivedTimeoutMs } = {}) {
  const options = {
    method,
    signal: AbortSignal.timeout(timeoutMs),
    ...(body === undefined ? {} : {
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  };
  try {
    const response = await fetch(url, options);
    const text = await response.text();
    const record = {
      action: "http-response",
      method,
      url: String(url),
      status: response.status,
      headers: Object.fromEntries(response.headers),
      body: text,
      bodySha256: sha256(text),
    };
    actions.push(record);
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error(`${method} ${url} returned non-JSON HTTP ${response.status}: ${text.slice(0, 500)}`);
    }
    return { response, data, text, record };
  } catch (error) {
    actions.push({ action: "http-error", method, url: String(url), error: String(error) });
    throw error;
  }
}

function observeTerminalJob(response, jobId, timeoutMs, onSnapshot = () => {}) {
  if (!response.ok || !response.body) {
    throw new Error(`Could not subscribe to job ${jobId} terminal SSE: HTTP ${response.status}`);
  }
  const reader = response.body.getReader();
  let resolveTerminal;
  let rejectTerminal;
  const terminal = new Promise((resolvePromise, rejectPromise) => {
    resolveTerminal = resolvePromise;
    rejectTerminal = rejectPromise;
  });
  const timeout = setTimeout(() => {
    void reader.cancel().catch(() => {});
    rejectTerminal(new Error(`Job ${jobId} terminal SSE timed out after ${timeoutMs} ms`));
  }, timeoutMs);
  void (async () => {
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) throw new Error(`Job ${jobId} SSE closed before terminal evidence`);
        buffer += decoder.decode(value, { stream: true });
        const blocks = buffer.split(/\r?\n\r?\n/);
        buffer = blocks.pop() ?? "";
        for (const block of blocks) {
          const data = block.split(/\r?\n/)
            .filter((line) => line.startsWith("data: "))
            .map((line) => line.slice(6))
            .join("\n");
          if (!data) continue;
          const snapshot = JSON.parse(data);
          if (snapshot.id !== jobId) continue;
          onSnapshot(snapshot);
          if (!terminalJobStatuses.has(snapshot.status)) continue;
          clearTimeout(timeout);
          resolveTerminal(snapshot);
          return;
        }
      }
    } catch (error) {
      clearTimeout(timeout);
      rejectTerminal(error);
    }
  })();
  return {
    terminal,
    async close() {
      clearTimeout(timeout);
      await reader.cancel().catch(() => {});
    },
  };
}

async function cancelActiveJobs({ prefix, listJobs, subscribe, cancel, actions, assertions }) {
  let listing;
  try {
    listing = await listJobs();
  } catch (error) {
    assertion(assertions, `${prefix}-owned-store-queried-before-teardown`, false, String(error));
    assertion(assertions, `${prefix}-active-jobs-terminal-before-teardown`, false, {
      error: String(error), cancellationAttempts: [],
    });
    return { queried: false, activeJobs: [], cancellationAttempts: [], success: false };
  }
  const listedJobs = listing.data;
  const queried = listing.response.status === 200 && Array.isArray(listedJobs);
  assertion(assertions, `${prefix}-owned-store-queried-before-teardown`, queried, {
    status: listing.response.status,
    jobCount: Array.isArray(listedJobs) ? listedJobs.length : null,
  });
  if (!queried) {
    assertion(assertions, `${prefix}-active-jobs-terminal-before-teardown`, false, {
      status: listing.response.status, data: listedJobs, cancellationAttempts: [],
    });
    return { queried: false, activeJobs: [], cancellationAttempts: [], success: false };
  }

  const activeJobs = listedJobs.filter((job) => job.status === "queued" || job.status === "running");
  actions.push({
    action: "owned-active-jobs-listed-before-local-teardown",
    activeJobs: activeJobs.map(({ id, status }) => ({ id, status })),
  });
  const cancellationAttempts = [];
  for (const job of activeJobs) {
    let subscription;
    const observedEvents = [];
    try {
      subscription = await subscribe(job.id, (snapshot) => {
        observedEvents.push({ id: snapshot.id, status: snapshot.status });
      });
      actions.push({
        action: "owned-job-terminal-sse-subscribed-before-cancel",
        jobId: job.id,
      });
      const cancelResponse = await cancel(job.id);
      const terminal = await bounded(
        subscription.terminal,
        `${prefix} job ${job.id} terminal cleanup`,
        cancellationTimeoutMs + 2_000,
      );
      const success = cancelResponse.response.status === 200
        && cancelResponse.data.id === job.id
        && terminal.id === job.id && terminalJobStatuses.has(terminal.status);
      const attempt = {
        jobId: job.id,
        statusBeforeCancel: job.status,
        cancelHttpStatus: cancelResponse.response.status,
        cancelResponseJobId: cancelResponse.data.id,
        cancelResponseStatus: cancelResponse.data.status,
        terminalStatus: terminal.status,
        terminalConfirmed: success,
        observedEvents,
      };
      cancellationAttempts.push(attempt);
      assertion(assertions, `${prefix}-job-${job.id}-cancel-terminal-confirmed`,
        success, attempt);
    } catch (error) {
      const attempt = {
        jobId: job.id,
        statusBeforeCancel: job.status,
        terminalConfirmed: false,
        observedEvents,
        error: String(error),
      };
      cancellationAttempts.push(attempt);
      assertion(assertions, `${prefix}-job-${job.id}-cancel-terminal-confirmed`, false, attempt);
    } finally {
      await subscription?.close();
    }
  }
  let finalListing;
  try { finalListing = await listJobs(); }
  catch (error) { finalListing = { response: { status: 0 }, data: null, error: String(error) }; }
  const remainingActiveJobs = Array.isArray(finalListing.data)
    ? finalListing.data.filter((job) => job.status === "queued" || job.status === "running")
    : null;
  const noActiveJobsRemain = finalListing.response.status === 200
    && Array.isArray(remainingActiveJobs) && remainingActiveJobs.length === 0;
  assertion(assertions, `${prefix}-owned-store-has-no-active-jobs-after-cleanup`,
    noActiveJobsRemain, {
      status: finalListing.response.status,
      remainingActiveJobs: remainingActiveJobs?.map(({ id, status }) => ({ id, status })) ?? null,
      error: finalListing.error,
    });
  const success = noActiveJobsRemain && cancellationAttempts.every((attempt) => attempt.terminalConfirmed);
  assertion(assertions, `${prefix}-active-jobs-terminal-before-teardown`,
    success, { activeJobs: activeJobs.map(({ id, status }) => ({ id, status })), cancellationAttempts });
  return {
    queried: true,
    activeJobs: activeJobs.map(({ id, status }) => ({ id, status })),
    cancellationAttempts,
    remainingActiveJobs,
    success,
  };
}

async function runPostSubmitCancellationProof(request, outputPath, actions, assertions) {
  const proofActions = [];
  const storeDirectory = await mkdtemp(join(tmpdir(), "vlaeval-task24-cancel-proof-"));
  const proofAssertionStart = assertions.length;
  let releaseRunner;
  let runnerStartedResolve;
  let runnerFinishedResolve;
  let runnerWasStarted = false;
  const cancelRequested = new Promise((resolvePromise) => { releaseRunner = resolvePromise; });
  const runnerStarted = new Promise((resolvePromise) => { runnerStartedResolve = resolvePromise; });
  const runnerFinished = new Promise((resolvePromise) => { runnerFinishedResolve = resolvePromise; });
  const cancelCalls = [];
  const runner = async (_request, emit) => {
    try {
      emit({ type: "started", pid: 4242 });
      runnerWasStarted = true;
      runnerStartedResolve(true);
      await cancelRequested;
      emit({ type: "cancelled" });
    } finally {
      runnerFinishedResolve(true);
    }
  };
  const store = new JobStore(storeDirectory, runner, async (host, pid) => {
    cancelCalls.push({ host, pid });
    releaseRunner(true);
  });
  const api = createApi(store);
  const localOrigin = "http://127.0.0.1:43101";
  const requestApi = async (path, { method = "GET", body } = {}) => {
    const response = await api(new Request(`${localOrigin}${path}`, {
      method,
      ...(body === undefined ? {} : {
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    }));
    return { response, data: await response.json() };
  };
  const adapter = {
    listJobs: () => requestApi("/api/jobs"),
    async subscribe(jobId, onSnapshot) {
      const controller = new AbortController();
      const response = await api(new Request(`${localOrigin}/api/jobs/${jobId}/events`, {
        signal: controller.signal,
      }));
      const observer = observeTerminalJob(response, jobId, cancellationTimeoutMs, onSnapshot);
      return {
        terminal: observer.terminal,
        async close() {
          await observer.close();
          controller.abort();
        },
      };
    },
    cancel: (jobId) => requestApi(`/api/jobs/${jobId}/cancel`, { method: "POST" }),
  };
  let proofJobId = "";
  let deliberateFailure = null;
  let cleanupResult = null;
  let terminalJob = null;
  let unsubscribeTerminal = null;
  let resolveStoreTerminal;
  const storeTerminal = new Promise((resolvePromise) => { resolveStoreTerminal = resolvePromise; });
  let storeRemoved = false;
  const cleanupActions = [];

  try {
    const submitted = await requestApi("/api/jobs", { method: "POST", body: request });
    proofJobId = submitted.data.id ?? "";
    assertion(assertions, "real-smoke-post-submit-cancel-proof-job-created",
      submitted.response.status === 201 && proofJobId.length > 0,
      { status: submitted.response.status, jobId: proofJobId || null });
    if (!proofJobId) throw new Error("The owned cancellation proof did not return a job ID.");
    await bounded(runnerStarted, "owned JobStore proof runner started", cancellationTimeoutMs);
    unsubscribeTerminal = store.subscribe(proofJobId, (snapshot) => {
      if (terminalJobStatuses.has(snapshot.status)) resolveStoreTerminal(snapshot);
    });
    proofActions.push({ action: "jobstore-terminal-subscriber-armed-before-failure-and-cancel", jobId: proofJobId });

    try {
      throw new Error("intentional post-submit failure; owned cleanup must cancel and confirm the job");
    } catch (error) {
      deliberateFailure = { name: "Task24InjectedPostSubmitFailure", message: error.message };
      proofActions.push({ action: "deliberate-post-submit-failure", jobId: proofJobId, ...deliberateFailure });
    }
    actions.push({ action: "owned-post-submit-cancellation-proof", jobId: proofJobId, deliberateFailure });

    cleanupResult = await cancelActiveJobs({
      prefix: "real-smoke-post-submit-proof",
      ...adapter,
      actions: cleanupActions,
      assertions,
    });
    terminalJob = await bounded(storeTerminal, "owned JobStore terminal event", cancellationTimeoutMs);
    const cancellationWasSent = cancelCalls.length === 1 && cancelCalls[0].pid === 4242;
    const proofPassed = deliberateFailure?.name === "Task24InjectedPostSubmitFailure"
      && cleanupResult.success && cancellationWasSent && terminalJob.status === "cancelled";
    assertion(assertions, "real-smoke-post-submit-failure-cancelled-and-terminal-confirmed",
      proofPassed,
      {
        jobId: proofJobId,
        deliberateFailure,
        activeJobCleanup: cleanupResult,
        cancelCalls,
        terminalStatus: terminalJob.status,
      });
  } catch (error) {
    proofActions.push({ action: "post-submit-cancellation-proof-error", jobId: proofJobId, error: String(error) });
    assertion(assertions, "real-smoke-post-submit-cancellation-proof-completed", false, String(error));
  } finally {
    if (proofJobId) {
      try {
        if (!cleanupResult?.success && !terminalJobStatuses.has(store.get(proofJobId).status)) {
          cleanupResult = await cancelActiveJobs({
            prefix: "real-smoke-post-submit-proof-fallback",
            ...adapter,
            actions: cleanupActions,
            assertions,
          });
        }
      } catch (error) {
        proofActions.push({ action: "post-submit-proof-fallback-cleanup-error", error: String(error) });
      }
    }
    releaseRunner(true);
    if (unsubscribeTerminal) {
      try {
        terminalJob = await bounded(storeTerminal, "owned JobStore fallback terminal event", cancellationTimeoutMs);
      } catch (error) {
        proofActions.push({ action: "proof-terminal-confirmation-error", error: String(error) });
      }
      unsubscribeTerminal();
      unsubscribeTerminal = null;
    }
    if (runnerWasStarted) {
      try { await bounded(runnerFinished, "owned cancellation proof runner exit", cancellationTimeoutMs); }
      catch (error) { proofActions.push({ action: "proof-runner-exit-error", error: String(error) }); }
    }
    try {
      await rm(storeDirectory, { recursive: true });
      await stat(storeDirectory);
    } catch (error) {
      storeRemoved = error.code === "ENOENT";
    }
    assertion(assertions, "real-smoke-post-submit-cancel-proof-store-removed",
      storeRemoved, { storeDirectory });
  }

  const proof = {
    proofType: "production createApi and JobStore boundary; controlled runner/cancel adapters; no remote worker",
    localOrigin,
    storeDirectory,
    storeRemoved,
    jobId: proofJobId || null,
    requestSha256: sha256(JSON.stringify(request)),
    deliberateFailure,
    activeJobCleanup: cleanupResult,
    cancellationCalls: cancelCalls,
    terminalStatus: terminalJob?.status ?? null,
    cleanupAssertions: assertions.slice(proofAssertionStart),
    cleanupActions,
    proofActions,
    passed: storeRemoved && deliberateFailure?.name === "Task24InjectedPostSubmitFailure"
      && cleanupResult?.success === true && cancelCalls.length === 1
      && terminalJob?.status === "cancelled",
  };
  await Bun.write(join(outputPath, "real-smoke-cancel-proof.json"), `${JSON.stringify(proof, null, 2)}\n`);
  actions.push({ action: "post-submit-cancellation-proof-evidence", path: join(outputPath, "real-smoke-cancel-proof.json"), passed: proof.passed });
  return proof;
}

function armScript(expression, label, timeoutMs = browserTimeoutMs) {
  return `(()=>{
    const predicate=()=>Boolean(${expression});
    window.__task24WaitSignal=new Promise((resolve,reject)=>{
      if(predicate())return resolve(true);
      let timer;
      const observer=new MutationObserver(()=>{
        if(!predicate())return;
        observer.disconnect();clearTimeout(timer);resolve(true);
      });
      observer.observe(document.documentElement,{subtree:true,childList:true,attributes:true,characterData:true});
      timer=setTimeout(()=>{
        observer.disconnect();
        reject(new Error(${JSON.stringify(`${label} timed out after ${timeoutMs} ms`)}));
      },${timeoutMs});
    });
    return true;
  })()`;
}

async function arm(page, expression, label, timeoutMs = browserTimeoutMs) {
  await page.evaluate(armScript(expression, label, timeoutMs));
}

async function settled(page, label, timeoutMs = browserTimeoutMs) {
  await bounded(page.evaluate("window.__task24WaitSignal"), label, timeoutMs);
}

async function waitFor(page, expression, label, timeoutMs = browserTimeoutMs) {
  await arm(page, expression, label, timeoutMs);
  await settled(page, label, timeoutMs);
}

async function readJson(page, expression) {
  return JSON.parse(await page.evaluate(`JSON.stringify(${expression})`));
}

async function nextPaint(page) {
  await page.evaluate("new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))");
}

async function trustedClick(page, selector, actions) {
  const clickId = `task24-${crypto.randomUUID()}`;
  const target = JSON.parse(await page.evaluate(`JSON.stringify((()=>{
    const selector=${JSON.stringify(selector)},clickId=${JSON.stringify(clickId)};
    const element=document.querySelector(selector);
    if(!element)throw new Error("Missing click target: "+selector);
    element.scrollIntoView({behavior:"instant",block:"center",inline:"center"});
    const rect=element.getBoundingClientRect(),x=rect.left+rect.width/2,y=rect.top+rect.height/2;
    const hit=document.elementFromPoint(x,y);
    if(rect.width<=0||rect.height<=0||!hit||(hit!==element&&!element.contains(hit)))
      throw new Error("Click target failed viewport/hit-test: "+JSON.stringify({selector,rect:rect.toJSON(),hit:hit?.outerHTML??null}));
    window.__task24LastClick=null;
    element.addEventListener("click",event=>{
      window.__task24LastClick={clickId,selector,isTrusted:event.isTrusted};
    },{once:true});
    return {clickId,selector,x,y,text:element.innerText??element.value??"",hit:hit.tagName};
  })())`));
  await page.cdp("Input.dispatchMouseEvent", {
    type: "mousePressed", x: target.x, y: target.y, button: "left", clickCount: 1,
  });
  await page.cdp("Input.dispatchMouseEvent", {
    type: "mouseReleased", x: target.x, y: target.y, button: "left", clickCount: 1,
  });
  const event = JSON.parse(await page.evaluate("JSON.stringify(window.__task24LastClick)"));
  if (event?.clickId !== clickId || event.selector !== selector || event.isTrusted !== true) {
    throw new Error(`Browser click was not trusted for ${selector}: ${JSON.stringify(event)}`);
  }
  actions.push({ action: "trusted-click", target: { ...target, event } });
  return target;
}

async function dispatchKey(page, key, actions) {
  const keyInfo = {
    Home: { code: "Home", virtual: 36 },
    End: { code: "End", virtual: 35 },
    ArrowDown: { code: "ArrowDown", virtual: 40 },
    Enter: { code: "Enter", virtual: 13 },
    Escape: { code: "Escape", virtual: 27 },
    Tab: { code: "Tab", virtual: 9 },
  }[key];
  if (!keyInfo) throw new Error(`Unsupported key: ${key}`);
  await page.cdp("Input.dispatchKeyEvent", {
    type: "keyDown", key, code: keyInfo.code,
    windowsVirtualKeyCode: keyInfo.virtual, nativeVirtualKeyCode: keyInfo.virtual,
  });
  if (key === "Enter") {
    await page.cdp("Input.dispatchKeyEvent", {
      type: "char", key, code: keyInfo.code, text: "\r", unmodifiedText: "\r",
      windowsVirtualKeyCode: keyInfo.virtual,
    });
  }
  await page.cdp("Input.dispatchKeyEvent", {
    type: "keyUp", key, code: keyInfo.code,
    windowsVirtualKeyCode: keyInfo.virtual, nativeVirtualKeyCode: keyInfo.virtual,
  });
  actions.push({ action: "keyboard", key });
}

async function selectValue(page, selector, value, actions) {
  const index = await page.evaluate(`(()=>{
    const element=document.querySelector(${JSON.stringify(selector)});
    if(!element)throw new Error("Missing select: "+${JSON.stringify(selector)});
    return [...element.options].findIndex(option=>option.value===${JSON.stringify(String(value))});
  })()`);
  if (index < 0) throw new Error(`Option ${JSON.stringify(value)} not found in ${selector}`);
  await arm(page,
    `document.querySelector(${JSON.stringify(selector)})?.value===${JSON.stringify(String(value))}`,
    `select ${selector} value`);
  await trustedClick(page, selector, actions);
  await dispatchKey(page, "Home", actions);
  for (let step = 0; step < index; step += 1) await dispatchKey(page, "ArrowDown", actions);
  await dispatchKey(page, "Enter", actions);
  await settled(page, `select ${selector} value`);
}

async function fillInput(page, selector, value, actions) {
  await trustedClick(page, selector, actions);
  await page.cdp("Input.dispatchKeyEvent", {
    type: "keyDown", key: "a", code: "KeyA", modifiers: 2,
    windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65,
  });
  await page.cdp("Input.dispatchKeyEvent", {
    type: "keyUp", key: "a", code: "KeyA", modifiers: 2,
    windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65,
  });
  await page.cdp("Input.insertText", { text: String(value) });
  const actual = await page.evaluate(`document.querySelector(${JSON.stringify(selector)})?.value`);
  if (actual !== String(value)) throw new Error(`Could not fill ${selector}: ${JSON.stringify(actual)}`);
  actions.push({ action: "fill", selector, value: String(value) });
}

async function capture(page, outputPath, name, actions, assertions) {
  await nextPaint(page);
  const geometry = await readJson(page, `({
    width:innerWidth,height:innerHeight,theme:document.documentElement.dataset.theme,
    scrollWidth:document.documentElement.scrollWidth,
    documentHeight:document.documentElement.scrollHeight
  })`);
  const response = await page.cdp("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
  const bytes = Buffer.from(response.data, "base64");
  const signature = bytes.subarray(0, 8).toString("hex");
  const dimensions = bytes.length >= 24
    ? { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) }
    : { width: 0, height: 0 };
  const path = join(outputPath, `${name}.png`);
  await Bun.write(path, bytes);
  assertion(assertions, `capture-${name}-is-full-viewport-png`,
    signature === "89504e470d0a1a0a" && dimensions.width === geometry.width && dimensions.height === geometry.height,
    { path, signature, dimensions, geometry });
  actions.push({ action: "screenshot", path, signature, dimensions, ...geometry });
}

async function installBlobRecorder(page) {
  await page.evaluate(`(()=>{
    const create=URL.createObjectURL.bind(URL);
    window.__task24Blobs=[];
    URL.createObjectURL=(blob)=>{
      const entry={type:blob.type,textPromise:blob.text()};
      window.__task24Blobs.push(entry);
      return create(blob);
    };
    return true;
  })()`);
}

async function clickAndReadBlob(page, selector, actions) {
  const current = await page.evaluate("window.__task24Blobs?.length??0");
  await trustedClick(page, selector, actions);
  await waitFor(page, `window.__task24Blobs?.length>${current}`, `export blob for ${selector}`);
  const blob = await readJson(page, `({
    type:window.__task24Blobs.at(-1).type,
    text:await window.__task24Blobs.at(-1).textPromise
  })`);
  actions.push({
    action: "download-captured",
    selector,
    blobIndex: current,
    type: blob.type,
    byteLength: Buffer.byteLength(blob.text),
  });
  return { ...blob, blobIndex: current };
}

function parseCsv(text) {
  const input = text.replace(/^\ufeff/, "");
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  for (let index = 0; index < input.length; index += 1) {
    const character = input[index];
    if (quoted) {
      if (character === '"' && input[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (character === '"') quoted = false;
      else field += character;
    } else if (character === '"' && field.length === 0) quoted = true;
    else if (character === ",") {
      row.push(field);
      field = "";
    } else if (character === "\n" || character === "\r") {
      if (character === "\r" && input[index + 1] === "\n") index += 1;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += character;
  }
  if (quoted) throw new Error("CSV ended inside a quoted cell");
  if (field.length || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

function expectedRawCsvRows(result) {
  const header = "episode,frame,time_seconds,dimension,action,predicted,target,error";
  const rows = [header.split(",")];
  for (const trace of result.traces) {
    trace.frames.forEach((frame, index) => {
      const predicted = trace.predicted[index] ?? [];
      const target = trace.target[index] ?? [];
      for (let dimension = 0; dimension < Math.max(predicted.length, target.length); dimension += 1) {
        const prediction = predicted[dimension];
        const truth = target[dimension];
        rows.push([
          String(trace.episode), String(frame), String(frame / result.fps), String(dimension),
          result.actionNames[dimension] ?? `action_${dimension}`,
          prediction == null ? "" : String(prediction),
          truth == null ? "" : String(truth),
          prediction == null || truth == null ? "" : String(prediction - truth),
        ]);
      }
    });
  }
  return rows;
}

function validateRawCsv(actualText, result) {
  const actual = parseCsv(actualText);
  const expected = expectedRawCsvRows(result);
  if (actual.length !== expected.length) return {
    passed: false, rows: actual.length - 1, expectedRows: expected.length - 1,
  };
  for (let row = 0; row < expected.length; row += 1) {
    if (actual[row].length !== expected[row].length) return {
      passed: false, row, actualColumns: actual[row].length, expectedColumns: expected[row].length,
    };
    for (let column = 0; column < expected[row].length; column += 1) {
      const left = actual[row][column], right = expected[row][column];
      if (row > 0 && column >= 2 && column !== 4 && left !== "" && right !== "") {
        if (!Number.isFinite(Number(left)) || Number(left) !== Number(right)) {
          return { passed: false, row, column, actual: left, expected: right };
        }
      } else if (left !== right) return { passed: false, row, column, actual: left, expected: right };
    }
  }
  return { passed: true, rows: actual.length - 1, sourceDimensions: result.actionNames.length };
}

function expectedScoreSnapshot(result) {
  return [
    ["첫 스텝 MAE", formatScore(result.firstStepMae)],
    ["첫 스텝 RMSE", formatScore(result.firstStepRmse)],
    ["전체 청크 MAE", formatScore(result.mae)],
    ["전체 청크 RMSE", formatScore(result.rmse)],
    ["Valid horizon rows", result.validSteps.toLocaleString("ko-KR")],
  ];
}

async function uiScoreSnapshot(page) {
  return readJson(page, `[...document.querySelectorAll(".result-scores > div")].map(element=>[
    element.querySelector("dt")?.innerText??"",
    element.querySelector("dd")?.innerText??""
  ])`);
}

async function exportAndVerify(page, result, actions, assertions, prefix) {
  await installBlobRecorder(page);
  const jsonBlob = await clickAndReadBlob(page, 'button[data-export="json"]', actions);
  let exportedJson = null;
  try { exportedJson = JSON.parse(jsonBlob.text); } catch {}
  assertion(assertions, `${prefix}-raw-json-exact-source`,
    deepEqual(exportedJson, result),
    { mediaType: jsonBlob.type, sha256: sha256(jsonBlob.text), sourceSha256: sha256(JSON.stringify(result)) });
  const csvBlob = await clickAndReadBlob(page, 'button[data-export="csv"]', actions);
  const csv = validateRawCsv(csvBlob.text, result);
  assertion(assertions, `${prefix}-raw-csv-every-frame-and-dimension-exact`, csv.passed, {
    mediaType: csvBlob.type, sha256: sha256(csvBlob.text), ...csv,
  });
  return { jsonSha256: sha256(jsonBlob.text), csvSha256: sha256(csvBlob.text), csv };
}

async function selectArchivedJob(page, jobId, actions) {
  await waitFor(page, `document.querySelector("#history")?.options.length>1`, "history jobs rendered");
  await selectValue(page, "#history", jobId, actions);
  await waitFor(page,
    `document.querySelector(".result-workspace")?.dataset.jobId===${JSON.stringify(jobId)}`,
    `result workspace for ${jobId}`);
}

async function inspectModes(page, result, jobId, baseURL, actions, assertions, prefix, httpRecords, afterMode = null) {
  const modes = ["overview", "detail", "chunks", "metrics", "fk"];
  const expectedScores = expectedScoreSnapshot(result);
  const baseline = await uiScoreSnapshot(page);
  assertion(assertions, `${prefix}-score-strip-matches-saved-result`,
    deepEqual(baseline, expectedScores), { expected: expectedScores, actual: baseline });
  for (const mode of modes) {
    await arm(page,
      `document.querySelector(".result-workspace")?.dataset.view===${JSON.stringify(mode)}`,
      `${prefix} view ${mode}`);
    await trustedClick(page, `[data-view-tab="${mode}"]`, actions);
    await settled(page, `${prefix} view ${mode}`);
    await nextPaint(page);
    const scores = await uiScoreSnapshot(page);
    const dom = await readJson(page, `({
      jobId:document.querySelector(".result-workspace")?.dataset.jobId??null,
      view:document.querySelector(".result-workspace")?.dataset.view??null,
      panels:document.querySelectorAll(".overview-panel").length,
      horizontalOverflow:document.documentElement.scrollWidth>innerWidth
    })`);
    assertion(assertions, `${prefix}-${mode}-preserves-scores-and-identity`,
      deepEqual(scores, baseline) && dom.jobId === jobId && dom.view === mode,
      { scores, baseline, dom });
    if (mode === "overview") {
      assertion(assertions, `${prefix}-${mode}-retains-sixteen-panels`,
        dom.panels === 16, dom);
    }
    assertion(assertions, `${prefix}-${mode}-no-page-horizontal-overflow`,
      !dom.horizontalOverflow, dom);
    await capture(page, actions.outputPath, `${prefix}-${mode}`, actions, assertions);
    if (mode === "overview") {
      await page.evaluate("(()=>{const main=document.querySelector('main');main.scrollTop=main.scrollHeight;window.scrollTo(0,document.body.scrollHeight)})()");
      await capture(page, actions.outputPath, `${prefix}-${mode}-end`, actions, assertions);
      await page.evaluate("(()=>{document.querySelector('main').scrollTop=0;window.scrollTo(0,0)})()");
    }
    const saved = await jsonRequest(`${baseURL}/api/jobs/${jobId}`, httpRecords);
    const persistedMatches = saved.data.status === "completed" && deepEqual(saved.data.result, result);
    assertion(assertions, `${prefix}-${mode}-persisted-run-data-unchanged`,
      persistedMatches, { status: saved.data.status, resultDeepEqual: deepEqual(saved.data.result, result) });
    if (afterMode) await afterMode({ mode, page, scores, dom });
  }
}

async function runArchivedLive({ args, outputPath, startHarness }) {
  const assertions = [];
  const actions = [];
  const httpRecords = [];
  const harnesses = [];
  const originalBaseURL = args["base-url"] ?? archivedBaseURL;
  let currentBaseURL = "";
  const jobId = args["run-id"] ?? archivedRunId;
  const archivedCursorProof = {
    jobId,
    selector: "#workspace-frame",
    trustedInputEvents: [],
    cases: [],
    expectedFrames: [1, 2, 0],
    actionCount: 0,
    pendingRuntimeReplay: true,
  };
  let storeDirectory = "";
  let server = null;
  let sourceJob = null;
  let sourceBody = "";
  const cleanupErrors = [];
  await mkdir(outputPath, { recursive: true });
  try {
    const jobResponse = await jsonRequest(`${originalBaseURL}/api/jobs/${jobId}`, httpRecords);
    const job = jobResponse.data;
    sourceJob = job;
    sourceBody = jobResponse.text;
    assertion(assertions, "archived-live-http-job-is-completed",
      job.id === jobId && job.status === "completed" && job.error === null && job.result !== null,
      { id: job.id, status: job.status, error: job.error });
    const result = job.result;
    assertion(assertions, "archived-live-result-has-sixteen-action-channels",
      result.actionNames.length === 16
      && result.traces.some((trace) => trace.episode === 0 && trace.frames.length > 0),
      { actionNames: result.actionNames, traces: result.traces.map((trace) => ({ episode: trace.episode, frames: trace.frames.length })) });
    const sourceEventsResponse = await fetch(`${originalBaseURL}/api/jobs/${jobId}/events`, {
      signal: AbortSignal.timeout(archivedTimeoutMs),
    });
    const sourceEventsBody = await sourceEventsResponse.text();
    const sourceEvents = [...sourceEventsBody.matchAll(/^data: (.+)$/gm)].map((match) => JSON.parse(match[1]));
    httpRecords.push({
      action: "original-read-only-http-event-stream",
      method: "GET",
      url: `${originalBaseURL}/api/jobs/${jobId}/events`,
      status: sourceEventsResponse.status,
      headers: Object.fromEntries(sourceEventsResponse.headers),
      body: sourceEventsBody,
      bodySha256: sha256(sourceEventsBody),
    });
    assertion(assertions, "archived-live-sse-emits-actual-completed-snapshot",
      sourceEventsResponse.status === 200 && sourceEvents.some((event) => event.id === jobId && event.status === "completed"),
      { status: sourceEventsResponse.status, eventCount: sourceEvents.length, finalStatus: sourceEvents.at(-1)?.status });
    assertion(assertions, "archived-live-original-metric-source-counts",
      Number.isFinite(result.firstStepMae) && Number.isFinite(result.firstStepRmse)
      && Number.isFinite(result.mae) && Number.isFinite(result.rmse)
      && result.validSteps >= 0 && result.actionNames.length === 16,
      { firstStepMae: result.firstStepMae, firstStepRmse: result.firstStepRmse, mae: result.mae, rmse: result.rmse, validSteps: result.validSteps });
    actions.push({
      action: "read-only-archived-run-source",
      originalBaseURL, jobId, request: job.request,
      originalRunsMutated: false,
    });

    storeDirectory = await mkdtemp(join(tmpdir(), "vlaeval-task24-archived-runs-"));
    const ownedRecordPath = join(storeDirectory, `${jobId}.json`);
    await Bun.write(ownedRecordPath, sourceBody);
    const copiedBody = await Bun.file(ownedRecordPath).text();
    assertion(assertions, "archived-record-is-byte-exact-copy-in-owned-store",
      copiedBody === sourceBody && sha256(copiedBody) === sha256(sourceBody),
      { ownedRecordPath, sourceSha256: sha256(sourceBody), ownedSha256: sha256(copiedBody) });
    server = await startDedicatedServer(storeDirectory, actions);
    currentBaseURL = server.url;
    assertion(assertions, "archived-current-app-uses-dedicated-ephemeral-server-and-store",
      new URL(currentBaseURL).hostname === "127.0.0.1"
        && new URL(currentBaseURL).port !== "4310"
        && storeDirectory.startsWith(tmpdir())
        && storeDirectory !== resolve(repoRoot, ".runs"),
      { currentBaseURL, storeDirectory, originalBaseURL });
    const seededJob = await jsonRequest(`${currentBaseURL}/api/jobs/${jobId}`, httpRecords);
    assertion(assertions, "current-worktree-server-restores-identical-archived-job",
      seededJob.response.status === 200 && deepEqual(seededJob.data, job),
      { status: seededJob.response.status, id: seededJob.data.id, exactJobEquality: deepEqual(seededJob.data, job) });
    const currentEventsResponse = await fetch(`${currentBaseURL}/api/jobs/${jobId}/events`, {
      signal: AbortSignal.timeout(archivedTimeoutMs),
    });
    const currentEventsBody = await currentEventsResponse.text();
    const currentEvents = [...currentEventsBody.matchAll(/^data: (.+)$/gm)].map((match) => JSON.parse(match[1]));
    httpRecords.push({
      action: "current-worktree-owned-server-event-stream",
      method: "GET",
      url: `${currentBaseURL}/api/jobs/${jobId}/events`,
      status: currentEventsResponse.status,
      headers: Object.fromEntries(currentEventsResponse.headers),
      body: currentEventsBody,
      bodySha256: sha256(currentEventsBody),
    });
    assertion(assertions, "current-worktree-event-stream-restores-completed-run",
      currentEventsResponse.status === 200
        && currentEvents.some((event) => event.id === jobId && event.status === "completed"),
      { status: currentEventsResponse.status, eventCount: currentEvents.length, finalStatus: currentEvents.at(-1)?.status });

    for (const [width, height] of [[1440, 1000], [390, 844]]) {
      const viewport = `${width}x${height}`;
      for (const theme of ["light", "dark"]) {
        const harness = await startHarness({ baseURL: currentBaseURL, viewport, theme: "system" });
        const entry = { harness, closed: false };
        harnesses.push(entry);
        try {
          const page = await harness.openPage();
          await waitFor(page, `document.querySelector("main h1")?.textContent==="에피소드 평가"`,
            `archived live app rendered ${viewport} ${theme}`);
          await selectArchivedJob(page, jobId, actions);
          await selectValue(page, ".rail-footer select", theme, actions);
          const current = await readJson(page, `({
            view:document.querySelector(".result-workspace")?.dataset.view??null,
            jobId:document.querySelector(".result-workspace")?.dataset.jobId??null,
            theme:document.documentElement.dataset.theme,
            viewport:{width:innerWidth,height:innerHeight},
            panels:document.querySelectorAll(".overview-panel").length,
            overflow:document.documentElement.scrollWidth>innerWidth
          })`);
          assertion(assertions, `archived-live-ui-${viewport}-${theme}-shows-target-with-no-overflow`,
            current.jobId === jobId && current.theme === theme
            && current.viewport.width === width && current.viewport.height === height
            && current.panels === 16 && !current.overflow, current);
          const inputTrust = await page.evaluate(`(()=>{
            if(!document.querySelector("#workspace-frame"))
              throw new Error("Missing public workspace source-frame input");
            window.__task24CursorInputEvents=[];
            document.addEventListener("input",event=>{
              const input=event.target;
              if(!(input instanceof HTMLInputElement)||input.id!=="workspace-frame")return;
              window.__task24CursorInputEvents.push({
                isTrusted:event.isTrusted,
                value:input.value,
                sourceFrame:Number(input.value)
              });
            },true);
            return true;
          })()`);
          if (!inputTrust) throw new Error("Could not observe public source-frame input events");
          const caseProof = { viewport, theme, actions: [] };
          archivedCursorProof.cases.push(caseProof);
          const trace = result.traces.find((item) => item.episode === 0);
          if (!trace) throw new Error("Archived source is missing episode 0 trace");
          for (const sourceFrame of archivedCursorProof.expectedFrames) {
            if (!trace.frames.includes(sourceFrame)) {
              throw new Error(`Archived episode 0 does not contain source frame ${sourceFrame}`);
            }
            await arm(page,
              `(()=>{
                const input=document.querySelector("#workspace-frame");
                const workspace=document.querySelector(".result-workspace");
                const plots=[...document.querySelectorAll(".overview-panel .trace-plot")];
                return input?.value===${JSON.stringify(String(sourceFrame))}
                  && workspace?.dataset.sourceFrame===${JSON.stringify(String(sourceFrame))}
                  && plots.length===16
                  && plots.every(plot=>plot.dataset.sourceFrame===${JSON.stringify(String(sourceFrame))}
                    && plot.querySelector(".trace-plot__cursor")?.dataset.sourceFrame===${JSON.stringify(String(sourceFrame))});
              })()`,
              `archived ${viewport} ${theme} public cursor frame ${sourceFrame}`);
            const inputCountBefore = await readJson(page, "window.__task24CursorInputEvents.length");
            await fillInput(page, "#workspace-frame", sourceFrame, actions);
            await settled(page, `archived ${viewport} ${theme} public cursor frame ${sourceFrame}`);
            const overview = await readJson(page, `(()=>{
              const workspace=document.querySelector(".result-workspace");
              const plots=[...document.querySelectorAll(".overview-panel .trace-plot")];
              const svgCursor=plot=>{
                const svg=plot.querySelector("svg"),cursor=plot.querySelector(".trace-plot__cursor");
                const grid=plot.querySelector(".trace-plot__grid");
                if(!svg||!cursor||!grid) return null;
                const expected=Number(grid.getAttribute("x1"))
                  +(Number(${JSON.stringify(sourceFrame)})-Number(plot.dataset.windowStart))
                    /(Number(plot.dataset.windowEnd)-Number(plot.dataset.windowStart))
                    *(Number(grid.getAttribute("x2"))-Number(grid.getAttribute("x1")));
                const actual=Number(cursor.getAttribute("x1"));
                const point=new DOMPoint(actual,0).matrixTransform(svg.getScreenCTM());
                const expectedPoint=new DOMPoint(expected,0).matrixTransform(svg.getScreenCTM());
                return {
                  frame:plot.dataset.sourceFrame,
                  cursorFrame:cursor.dataset.sourceFrame,
                  actualSvgX:actual,
                  expectedSvgX:expected,
                  actualScreenX:point.x,
                  expectedScreenX:expectedPoint.x,
                  errorPx:Math.abs(point.x-expectedPoint.x)
                };
              };
              return {
                sourceFrame:workspace?.dataset.sourceFrame??null,
                plotCount:plots.length,
                channels:[...document.querySelectorAll(".overview-panel")].map(panel=>[
                  panel.dataset.channelName,Number(panel.dataset.sourceIndex)
                ]),
                cursors:plots.map(svgCursor)
              };
            })()`);
            const channelNames = overview.channels.map(([name]) => name);
            const overviewPassed = overview.sourceFrame === String(sourceFrame)
              && overview.plotCount === 16
              && overview.channels.length === 16
              && new Set(channelNames).size === 16
              && overview.channels.every(([name, index]) => result.actionNames[index] === name)
              && overview.cursors.every((cursor) => cursor
                && cursor.frame === String(sourceFrame)
                && cursor.cursorFrame === String(sourceFrame)
                && Number.isFinite(cursor.errorPx) && cursor.errorPx <= 0.05);
            assertion(assertions,
              `archived-${viewport}-${theme}-public-cursor-frame-${sourceFrame}-overview-svg-exact`,
              overviewPassed, overview);

            await arm(page,
              `document.querySelector(".result-workspace")?.dataset.view==="detail"`,
              `archived ${viewport} ${theme} cursor detail view`);
            await trustedClick(page, '[data-view-tab="detail"]', actions);
            await settled(page, `archived ${viewport} ${theme} cursor detail view`);
            await arm(page,
              `document.querySelector(".point-inspector")?.dataset.sourceFrame===${JSON.stringify(String(sourceFrame))}
                && document.querySelector(".trace-plot__cursor")?.dataset.sourceFrame===${JSON.stringify(String(sourceFrame))}`,
              `archived ${viewport} ${theme} detail point ${sourceFrame}`);
            await settled(page, `archived ${viewport} ${theme} detail point ${sourceFrame}`);
            const rowIndex = trace.frames.indexOf(sourceFrame);
            const expectedPredicted = trace.predicted[rowIndex]?.[0];
            const expectedTarget = trace.target[rowIndex]?.[0];
            const point = await readJson(page, `(()=>{
              const inspector=document.querySelector(".point-inspector");
              const plot=document.querySelector(".trace-plot");
              const cursor=plot?.querySelector(".trace-plot__cursor");
              const grid=plot?.querySelector(".trace-plot__grid");
              const svg=plot?.querySelector("svg");
              const actualX=cursor?Number(cursor.getAttribute("x1")):NaN;
              const expectedX=grid?Number(grid.getAttribute("x1"))
                +(Number(${JSON.stringify(sourceFrame)})-Number(plot.dataset.windowStart))
                  /(Number(plot.dataset.windowEnd)-Number(plot.dataset.windowStart))
                  *(Number(grid.getAttribute("x2"))-Number(grid.getAttribute("x1"))):NaN;
              const matrix=svg?.getScreenCTM();
              const actualScreenX=matrix?new DOMPoint(actualX,0).matrixTransform(matrix).x:NaN;
              const expectedScreenX=matrix?new DOMPoint(expectedX,0).matrixTransform(matrix).x:NaN;
              const values=[...inspector.querySelectorAll("dd")].map(node=>node.textContent.trim());
              return {
                sourceFrame:inspector?.dataset.sourceFrame??null,
                frame:values[0]??null,time:values[1]??null,
                predicted:inspector?.querySelector('[data-value="predicted"]')?.textContent.trim()??null,
                target:inspector?.querySelector('[data-value="target"]')?.textContent.trim()??null,
                error:values[4]??null,
                plotFrame:plot?.dataset.sourceFrame??null,
                cursorFrame:cursor?.dataset.sourceFrame??null,
                actualSvgX:actualX,expectedSvgX:expectedX,
                errorPx:Math.abs(actualScreenX-expectedScreenX)
              };
            })()`);
            const pointPassed = point.sourceFrame === String(sourceFrame)
              && point.frame === String(sourceFrame)
              && point.predicted === String(expectedPredicted)
              && point.target === String(expectedTarget)
              && point.error === String(expectedPredicted - expectedTarget)
              && point.plotFrame === String(sourceFrame)
              && point.cursorFrame === String(sourceFrame)
              && Number.isFinite(point.errorPx) && point.errorPx <= 0.05;
            assertion(assertions,
              `archived-${viewport}-${theme}-public-cursor-frame-${sourceFrame}-detail-point-exact`,
              pointPassed, {
                ...point,
                expected: {
                  frame: sourceFrame,
                  predicted: expectedPredicted,
                  target: expectedTarget,
                  error: expectedPredicted - expectedTarget,
                },
              });
            const inputEvents = await readJson(page, "window.__task24CursorInputEvents");
            const latestInput = inputEvents.at(-1);
            const actionPassed = inputEvents.length === inputCountBefore + 1
              && latestInput?.isTrusted === true
              && latestInput.sourceFrame === sourceFrame
              && latestInput.value === String(sourceFrame);
            assertion(assertions,
              `archived-${viewport}-${theme}-public-cursor-frame-${sourceFrame}-trusted-input`,
              actionPassed, latestInput);
            const action = {
              selector: "#workspace-frame",
              event: "input",
              trusted: latestInput?.isTrusted === true,
              sourceFrame,
              inputValue: latestInput?.value ?? null,
              outcomes: {
                overviewGeometry: overviewPassed,
                exactPointValuesAndGeometry: pointPassed,
                trustedInputEvent: actionPassed,
              },
              passed: overviewPassed && pointPassed && actionPassed,
              overview,
              point,
            };
            caseProof.actions.push(action);
            archivedCursorProof.actionCount += 1;
            archivedCursorProof.trustedInputEvents.push(latestInput ?? null);
            actions.push({ action: "archived-public-cursor-input", viewport, theme, ...action });
            if (sourceFrame !== archivedCursorProof.expectedFrames.at(-1)) {
              await arm(page,
                `document.querySelector(".result-workspace")?.dataset.view==="overview"`,
                `archived ${viewport} ${theme} return to overview`);
              await trustedClick(page, '[data-view-tab="overview"]', actions);
              await settled(page, `archived ${viewport} ${theme} return to overview`);
            }
          }
          actions.outputPath = outputPath;
          const exportHashes = await exportAndVerify(page, result, actions, assertions,
            `archived-${viewport}-${theme}`);
          await inspectModes(page, result, jobId, currentBaseURL, actions, assertions,
            `archived-${viewport}-${theme}`, httpRecords);
          actions.push({ action: "raw-export-hashes", viewport, theme, ...exportHashes });
        } finally {
          const cleanup = await harness.close();
          entry.closed = true;
          assertion(assertions, `archived-live-browser-cleanup-${viewport}-${theme}`,
            !cleanup.browserOpen && !cleanup.serverOpen && !cleanup.tempStoreExists && cleanup.cleanupErrors.length === 0,
            cleanup);
          actions.push({ action: "browser-cleanup", viewport, theme, ...cleanup });
        }
      }
    }
  } catch (error) {
    assertion(assertions, "archived-live-scenario-completed", false, String(error));
    actions.push({ action: "scenario-error", scenario: "archived-live", error: String(error) });
  } finally {
    for (const entry of harnesses) {
      if (entry.closed) continue;
      try {
        const cleanup = await entry.harness.close();
        entry.closed = true;
        assertion(assertions, "archived-live-fallback-browser-cleanup",
          !cleanup.browserOpen && !cleanup.serverOpen && !cleanup.tempStoreExists && cleanup.cleanupErrors.length === 0,
          cleanup);
      } catch (error) {
        cleanupErrors.push(`browser cleanup: ${String(error)}`);
        assertion(assertions, "archived-live-fallback-browser-cleanup", false, String(error));
      }
    }
    let serverCleanup = { notStarted: server === null };
    if (server) {
      try {
        let exitCode = server.process.exitCode;
        if (exitCode === null) {
          server.process.kill("SIGTERM");
          try { exitCode = await bounded(server.process.exited, "archived dedicated server shutdown", 15_000); }
          catch {
            server.process.kill("SIGKILL");
            exitCode = await bounded(server.process.exited, "archived dedicated server forced shutdown", 10_000);
          }
        }
        await Promise.allSettled(server.pumps);
        let portRefused = false;
        try {
          const response = await fetch(currentBaseURL, { signal: AbortSignal.timeout(2_000) });
          await response.body?.cancel();
        } catch { portRefused = true; }
        serverCleanup = { exitCode, portRefused, url: currentBaseURL };
        assertion(assertions, "archived-current-app-server-stopped-and-port-closed",
          exitCode !== null && portRefused, serverCleanup);
      } catch (error) {
        cleanupErrors.push(`current app server cleanup: ${String(error)}`);
        serverCleanup = { error: String(error), url: currentBaseURL };
        assertion(assertions, "archived-current-app-server-stopped-and-port-closed", false, serverCleanup);
      }
    }
    let storeAbsent = storeDirectory === "";
    if (storeDirectory) {
      try {
        await rm(storeDirectory, { recursive: true, force: true });
        await stat(storeDirectory);
      } catch (error) {
        if (error.code === "ENOENT") storeAbsent = true;
        else cleanupErrors.push(`owned archived store cleanup: ${String(error)}`);
      }
    }
    assertion(assertions, "archived-owned-copy-store-removed", storeAbsent, { storeDirectory });
    let originalRecordUnchanged = false;
    try {
      const originalAfter = await jsonRequest(`${originalBaseURL}/api/jobs/${jobId}`, httpRecords);
      originalRecordUnchanged = deepEqual(originalAfter.data, sourceJob)
        && originalAfter.text === sourceBody;
      assertion(assertions, "original-4310-archived-job-remains-byte-identical",
        originalRecordUnchanged, { status: originalAfter.response.status, sha256: sha256(originalAfter.text) });
    } catch (error) {
      cleanupErrors.push(`read-only original recheck: ${String(error)}`);
      assertion(assertions, "original-4310-archived-job-remains-byte-identical", false, String(error));
    }
    await Bun.write(join(outputPath, "owned-cleanup.json"), `${JSON.stringify({
      browserOpen: harnesses.some((entry) => !entry.closed),
      serverOpen: serverCleanup.notStarted ? false : serverCleanup.exitCode === null || serverCleanup.error !== undefined,
      tempStoreExists: !storeAbsent,
      cleanupErrors,
      server: serverCleanup,
      storeDirectory,
      original4310Stopped: false,
      originalJobByteIdenticalAfterRun: originalRecordUnchanged,
      userRunsModified: false,
    }, null, 2)}\n`);
    await Bun.write(join(outputPath, "archived-http.json"), `${JSON.stringify(httpRecords, null, 2)}\n`);
    archivedCursorProof.pendingRuntimeReplay = false;
    archivedCursorProof.runtimeReplayCompleted = true;
    archivedCursorProof.cleanup = {
      browserOpen: harnesses.some((entry) => !entry.closed),
      serverOpen: serverCleanup.notStarted ? false : serverCleanup.exitCode === null || serverCleanup.error !== undefined,
      tempStoreExists: !storeAbsent,
      cleanupErrors,
      originalJobByteIdenticalAfterRun: originalRecordUnchanged,
      userRunsModified: false,
    };
    archivedCursorProof.complete = archivedCursorProof.actionCount === 12
      && archivedCursorProof.cases.length === 4
      && archivedCursorProof.cases.every((item) => item.actions.length === 3)
      && archivedCursorProof.cases.every((item) => item.actions.every((action) => action.passed === true
        && action.outcomes.overviewGeometry === true
        && action.outcomes.exactPointValuesAndGeometry === true
        && action.outcomes.trustedInputEvent === true))
      && archivedCursorProof.trustedInputEvents.every((event) => event?.isTrusted === true)
      && archivedCursorProof.cleanup.browserOpen === false
      && archivedCursorProof.cleanup.serverOpen === false
      && archivedCursorProof.cleanup.tempStoreExists === false
      && archivedCursorProof.cleanup.cleanupErrors.length === 0
      && archivedCursorProof.cleanup.originalJobByteIdenticalAfterRun === true;
    assertion(assertions, "archived-live-public-cursor-proof-has-twelve-trusted-actions-and-cleanup",
      archivedCursorProof.complete, archivedCursorProof);
    await Bun.write(join(outputPath, "archived-cursor-proof.json"),
      `${JSON.stringify(archivedCursorProof, null, 2)}\n`);
  }
  return { assertions, actions };
}

async function drainLines(stream, channel, log, onLine) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      pending += decoder.decode(value, { stream: true });
      let newline = pending.indexOf("\n");
      while (newline >= 0) {
        const line = pending.slice(0, newline).replace(/\r$/, "");
        pending = pending.slice(newline + 1);
        log.push({ channel, line });
        onLine(line);
        newline = pending.indexOf("\n");
      }
    }
    pending += decoder.decode();
    if (pending) {
      log.push({ channel, line: pending });
      onLine(pending);
    }
  } finally {
    reader.releaseLock();
  }
}

async function startDedicatedServer(storeDirectory, actions) {
  const log = [];
  let readyResolve, readyReject, baseURL = "";
  const ready = new Promise((resolveReady, rejectReady) => {
    readyResolve = resolveReady;
    readyReject = rejectReady;
  });
  const serverProcess = Bun.spawn([process.execPath, "src/server.ts"], {
    cwd: repoRoot,
    env: {
      ...process.env,
      NODE_ENV: "production",
      PORT: "0",
      VLAEVAL_RUNS_DIR: storeDirectory,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const detectReady = (line) => {
    const match = /^VLAEval ready at (https?:\/\/\S+)/.exec(line);
    if (!match || baseURL) return;
    baseURL = match[1].replace(/\/$/, "");
    readyResolve(baseURL);
  };
  const stdoutPump = drainLines(serverProcess.stdout, "stdout", log, detectReady);
  const stderrPump = drainLines(serverProcess.stderr, "stderr", log, detectReady);
  serverProcess.exited.then((code) => {
    if (!baseURL) readyReject(new Error(`Dedicated QA server exited before binding a port (${code}).`));
  });
  let url;
  try {
    url = await bounded(ready, "dedicated QA server readiness", browserTimeoutMs);
  } catch (error) {
    if (serverProcess.exitCode === null) serverProcess.kill("SIGTERM");
    try { await bounded(serverProcess.exited, "failed server startup shutdown", 10_000); }
    catch {
      serverProcess.kill("SIGKILL");
      await bounded(serverProcess.exited, "failed server startup forced shutdown", 10_000);
    }
    await Promise.allSettled([stdoutPump, stderrPump]);
    throw error;
  }
  actions.push({ action: "dedicated-server-ready", url, storeDirectory });
  return {
    process: serverProcess,
    url,
    log,
    pumps: [stdoutPump, stderrPump],
    async close() {
      let exitCode = serverProcess.exitCode;
      if (exitCode === null) {
        serverProcess.kill("SIGTERM");
        try { exitCode = await bounded(serverProcess.exited, "dedicated server shutdown", 15_000); }
        catch {
          serverProcess.kill("SIGKILL");
          exitCode = await bounded(serverProcess.exited, "dedicated server forced shutdown", 10_000);
        }
      }
      await Promise.allSettled([stdoutPump, stderrPump]);
      let portRefused = false;
      try {
        const response = await fetch(url, { signal: AbortSignal.timeout(2_000) });
        await response.body?.cancel();
      } catch {
        portRefused = true;
      }
      return { url, exitCode, portRefused, log };
    },
  };
}

async function runRealSmoke({ outputPath, startHarness }) {
  const assertions = [];
  const actions = [];
  const httpRecords = [];
  const harnesses = [];
  let storeDirectory = "";
  let server = null;
  let runId = "";
  let inferenceRequest = null;
  let completedRecord = null;
  const observedCleanups = [];
  const modeExportEvidence = [];
  let baselineExportEvidence = null;
  let ownedJobCleanup = { status: "not-run" };
  await mkdir(outputPath, { recursive: true });
  try {
    const archived = await jsonRequest(`${archivedBaseURL}/api/jobs/${archivedRunId}`, httpRecords);
    const sourceJob = archived.data;
    assertion(assertions, "real-smoke-readme-artifact-source-is-authorized-archived-run",
      sourceJob.id === archivedRunId && sourceJob.status === "completed"
      && sourceJob.request.host === "rtx6000@192.168.0.3"
      && sourceJob.request.repo === "/home/rtx6000/kgs/pi05_rby1"
      && sourceJob.request.config === "pi05_rby1_flower_0626"
      && sourceJob.request.checkpoint.includes("pi05_rby1_flower_0626")
      && sourceJob.request.dataset.includes("flowers_sorting_mirrored")
      && sourceJob.request.episodes.includes(0),
      {
        archivedRunId: sourceJob.id, status: sourceJob.status,
        host: sourceJob.request.host, repo: sourceJob.request.repo,
        config: sourceJob.request.config, checkpoint: sourceJob.request.checkpoint,
        dataset: sourceJob.request.dataset, episodes: sourceJob.request.episodes,
      });
    actions.push({
      action: "read-only-artifact-source",
      url: `${archivedBaseURL}/api/jobs/${archivedRunId}`,
      sourceJobId: sourceJob.id,
      request: sourceJob.request,
      sourceStoreMutated: false,
    });

    storeDirectory = await mkdtemp(join(tmpdir(), "vlaeval-task24-real-runs-"));
    server = await startDedicatedServer(storeDirectory, actions);
    assertion(assertions, "real-smoke-server-uses-private-port-and-store",
      new URL(server.url).port !== "4310"
      && storeDirectory !== resolve(repoRoot, ".runs")
      && storeDirectory.startsWith(tmpdir()),
      { serverUrl: server.url, storeDirectory, originalRuns: resolve(repoRoot, ".runs") });

    const { response: emptyResponse, data: emptyJobs } = await jsonRequest(`${server.url}/api/jobs`, httpRecords);
    assertion(assertions, "real-smoke-owned-store-starts-empty",
      emptyResponse.status === 200 && Array.isArray(emptyJobs) && emptyJobs.length === 0,
      { status: emptyResponse.status, jobs: emptyJobs.length });

    const harness = await startHarness({ baseURL: server.url, viewport: "1440x1000", theme: "system" });
    const harnessEntry = { harness, closed: false };
    harnesses.push(harnessEntry);
    const page = await harness.openPage();
    await waitFor(page, `document.querySelector("main h1")?.textContent==="에피소드 평가"`,
      "real-smoke application loaded");
    let connection = await readJson(page, `({
      host:document.querySelector(".connection input")?.value??"",
      repo:document.querySelector('input[list="repositories"]')?.value??""
    })`);
    if (connection.host !== sourceJob.request.host || connection.repo !== sourceJob.request.repo) {
      await trustedClick(page, "#connection summary", actions);
      await fillInput(page, ".connection input", sourceJob.request.host, actions);
      await fillInput(page, 'input[list="repositories"]', sourceJob.request.repo, actions);
      connection = await readJson(page, `({
        host:document.querySelector(".connection input")?.value??"",
        repo:document.querySelector('input[list="repositories"]')?.value??""
      })`);
    }
    assertion(assertions, "real-smoke-ui-defaults-match-readme-host-and-repository",
      connection.host === sourceJob.request.host && connection.repo === sourceJob.request.repo,
      connection);

    await arm(page,
      `[...document.querySelectorAll("#prepare .preparation-grid section:first-child select option")].some(option=>option.value===${JSON.stringify(sourceJob.request.config)})`,
      `real config ${sourceJob.request.config}`, 180_000);
    await trustedClick(page, "#prepare .preparation-grid section:first-child button", actions);
    await settled(page, `real config ${sourceJob.request.config}`, 180_000);
    await selectValue(page, "#prepare .preparation-grid section:first-child select", sourceJob.request.config, actions);
    await fillInput(page, 'input[list="checkpoints"]', sourceJob.request.checkpoint, actions);
    await fillInput(page, 'input[list="datasets"]', sourceJob.request.dataset, actions);
    await waitFor(page,
      `[...document.querySelectorAll("#prepare .preparation-grid section:nth-child(2) button")].some(button=>button.innerText.includes("메타데이터"))`,
      "read dataset metadata button");
    await arm(page,
      `[...document.querySelectorAll(".episode-row")].some(row=>row.innerText.includes("EP 0000"))`,
      "real episode zero metadata", 180_000);
    await trustedClick(page, "#prepare .preparation-grid section:nth-child(2) button", actions);
    await settled(page, "real episode zero metadata", 180_000);
    const episodeRow = await page.evaluate(`(()=>{
      const row=[...document.querySelectorAll(".episode-row")].find(item=>item.querySelector("strong")?.innerText.includes("EP 0000"));
      return row?{text:row.innerText,length:row.querySelector("small")?.innerText??""}:null;
    })()`);
    assertion(assertions, "real-smoke-episode-zero-present-in-real-metadata",
      episodeRow !== null && episodeRow.text.includes("EP 0000"), episodeRow);
    const episodeCheckbox = await page.evaluate(`(()=>{
      const row=[...document.querySelectorAll(".episode-row")].find(item=>item.querySelector("strong")?.innerText.includes("EP 0000"));
      return row?.querySelector("input[type=checkbox]")?.checked===true;
    })()`);
    if (!episodeCheckbox) {
      const rowIndex = await page.evaluate(`[...document.querySelectorAll(".episode-row")].findIndex(item=>item.querySelector("strong")?.innerText.includes("EP 0000"))`);
      await trustedClick(page, `.episode-row:nth-child(${rowIndex + 1}) input[type="checkbox"]`, actions);
    }

    await trustedClick(page, "#prepare details.advanced summary", actions);
    const optionValues = await page.evaluate(`JSON.stringify([...document.querySelectorAll("#prepare .options-grid input")].map(input=>input.value))`);
    const optionInputs = JSON.parse(optionValues);
    if (optionInputs.length !== 4) throw new Error(`Expected four advanced option fields, found ${optionInputs.length}`);
    for (const [label, value] of [
      ["프레임 간격 (stride)", "1"],
      ["최대 평가 프레임", "3"],
      ["시드", "0"],
      ["추론 스텝 수", "10"],
    ]) {
      const selector = await page.evaluate(`(()=>{
        const scope=document.querySelector("#prepare details.advanced .options-grid");
        const fields=[...scope.querySelectorAll(".field")];
        const field=fields.find(item=>item.children[0]?.textContent?.trim()===${JSON.stringify(label)});
        const input=field?.querySelector("input");
        if(!input)throw new Error("Missing current option Field for "+${JSON.stringify(label)});
        input.dataset.task24Option=${JSON.stringify(label)};
        return '#prepare details.advanced .options-grid input[data-task24-option='+JSON.stringify(${JSON.stringify(label)})+']';
      })()`);
      await fillInput(page, selector, value, actions);
    }

    await page.evaluate(`(()=>{
      window.__task24SseMessages=[];
      window.__task24SseResolve=null;
      window.__task24SsePromise=new Promise((resolve,reject)=>{
        window.__task24SseResolve=resolve;
        window.__task24SseTimer=setTimeout(()=>reject(new Error("Real inference terminal SSE timed out")),${inferenceTimeoutMs});
      });
      const NativeEventSource=window.EventSource;
      window.EventSource=class extends NativeEventSource {
        constructor(url,options){
          super(url,options);
          this.addEventListener("message",event=>{
            const job=JSON.parse(event.data);
            window.__task24SseMessages.push({
              id:job.id,status:job.status,completed:job.progress.completed,total:job.progress.total,
              message:job.progress.message
            });
            if(["completed","failed","cancelled"].includes(job.status)){
              clearTimeout(window.__task24SseTimer);
              window.__task24SseResolve(job);
            }
          });
        }
      };
      const nativeFetch=window.fetch.bind(window);
      window.__task24ApiCalls=[];
      window.__task24PostResolve=null;
      window.__task24PostPromise=new Promise(resolve=>{window.__task24PostResolve=resolve});
      window.fetch=async(input,init)=>{
        const url=typeof input==="string"?new URL(input,location.href):new URL(input.url);
        const method=(init?.method??input.method??"GET").toUpperCase();
        let requestBody=null;
        if(method==="POST"){
          if(typeof init?.body==="string")requestBody=init.body;
          else if(input instanceof Request)requestBody=await input.clone().text();
        }
        const response=await nativeFetch(input,init);
        let body=null;
        if(url.pathname==="/api/jobs"&&method==="POST"){
          body=await response.clone().text();
        }
        const call={method,path:url.pathname,status:response.status,requestBody,responseBody:body};
        window.__task24ApiCalls.push(call);
        if(url.pathname==="/api/jobs"&&method==="POST")window.__task24PostResolve(call);
        return response;
      };
      return true;
    })()`);
    await trustedClick(page, "#prepare .launch-bar button[type=submit]", actions);
    const post = await bounded(
      page.evaluate("window.__task24PostPromise"),
      "real run POST response",
      browserTimeoutMs,
    );
    if (post?.status === 201 && post.responseBody) {
      try { runId = JSON.parse(post.responseBody).id ?? ""; } catch {}
    }
    assertion(assertions, "real-smoke-run-id-captured-before-terminal-sse",
      post?.status === 201 && runId.length > 0,
      { postStatus: post?.status, jobId: runId || null });
    const terminalJob = await bounded(
      page.evaluate("window.__task24SsePromise"),
      "real run terminal SSE",
      inferenceTimeoutMs + 5_000,
    );
    assertion(assertions, "real-smoke-terminal-sse-matches-submitted-job",
      terminalJob.id === runId,
      { submittedJobId: runId, terminalJobId: terminalJob.id, terminalStatus: terminalJob.status });
    const uiApiCalls = await readJson(page, "window.__task24ApiCalls");
    actions.push({ action: "real-ui-api-calls", calls: uiApiCalls });
    if (post?.requestBody) {
      try { inferenceRequest = JSON.parse(post.requestBody); } catch {}
    }
    assertion(assertions, "real-smoke-run-triggered-through-production-ui-and-api",
      terminalJob.status === "completed" && post?.status === 201 && post.requestBody !== null,
      { jobId: runId, terminalStatus: terminalJob.status, postStatus: post?.status, request: inferenceRequest });
    assertion(assertions, "real-smoke-request-uses-readme-artifacts-and-three-frame-contract",
      inferenceRequest !== null
      && inferenceRequest.host === sourceJob.request.host
      && inferenceRequest.repo === sourceJob.request.repo
      && inferenceRequest.config === sourceJob.request.config
      && inferenceRequest.checkpoint === sourceJob.request.checkpoint
      && inferenceRequest.dataset === sourceJob.request.dataset
      && JSON.stringify(inferenceRequest.episodes) === JSON.stringify([0])
      && inferenceRequest.maxSamples === 3 && inferenceRequest.stride === 1
      && inferenceRequest.seed === 0 && inferenceRequest.numSteps === 10,
      inferenceRequest);
    const appReady = waitFor(page,
      `document.querySelector(".result-workspace")?.dataset.jobId===${JSON.stringify(runId)}`,
      "real inference results rendered in production UI", inferenceTimeoutMs);
    await appReady;

    const saved = await jsonRequest(`${server.url}/api/jobs/${runId}`, httpRecords);
    completedRecord = saved.data;
    const trace = completedRecord.result?.traces.find((item) => item.episode === 0);
    const coverage = completedRecord.result?.coverage?.episodes.find((item) => item.episode === 0);
    assertion(assertions, "real-smoke-job-persisted-as-completed-in-owned-store",
      saved.response.status === 200 && completedRecord.status === "completed"
      && completedRecord.error === null && completedRecord.result !== null,
      { status: saved.response.status, jobStatus: completedRecord.status, error: completedRecord.error });
    assertion(assertions, "real-smoke-three-first-step-rows-sixteen-dimensional",
      completedRecord.result.framesEvaluated === 3 && trace?.frames.length === 3
      && trace.predicted.length === 3 && trace.target.length === 3
      && completedRecord.result.actionNames.length === 16,
      { framesEvaluated: completedRecord.result.framesEvaluated, frames: trace?.frames, actionDimensions: completedRecord.result.actionNames.length });
    assertion(assertions, "real-smoke-exactly-120-valid-future-chunk-rows",
      completedRecord.result.validSteps === 120 && coverage?.validRows === 120
      && coverage?.scoredAnchors === 3 && coverage?.validRowsByHorizon?.reduce((sum, count) => sum + count, 0) === 120,
      { validSteps: completedRecord.result.validSteps, coverage, validRowsByHorizon: completedRecord.result.coverage?.validRowsByHorizon });
    assertion(assertions, "real-smoke-scores-are-finite-and-server-client-agree",
      Number.isFinite(completedRecord.result.firstStepMae)
      && Number.isFinite(completedRecord.result.firstStepRmse)
      && Number.isFinite(completedRecord.result.mae)
      && Number.isFinite(completedRecord.result.rmse)
      && deepEqual(terminalJob.result, completedRecord.result),
      {
        firstStepMae: completedRecord.result.firstStepMae,
        firstStepRmse: completedRecord.result.firstStepRmse,
        chunkMae: completedRecord.result.mae,
        chunkRmse: completedRecord.result.rmse,
        serverSseAndSnapshotMatch: deepEqual(terminalJob.result, completedRecord.result),
      });
    assertion(assertions, "real-smoke-actual-run-is-quick-subset-not-full-performance-claim",
      completedRecord.result.framesEvaluated === 3
      && completedRecord.request.maxSamples === 3
      && completedRecord.result.warnings.some((warning) => warning.toLowerCase().includes("quick subset")),
      { request: completedRecord.request, warnings: completedRecord.result.warnings });

    await installBlobRecorder(page);
    const rawJson = await clickAndReadBlob(page, 'button[data-export="json"]', actions);
    let parsedRaw = null;
    try { parsedRaw = JSON.parse(rawJson.text); } catch {}
    assertion(assertions, "real-smoke-original-json-export-exact",
      deepEqual(parsedRaw, completedRecord.result),
      { sha256: sha256(rawJson.text), mediaType: rawJson.type });
    const rawCsv = await clickAndReadBlob(page, 'button[data-export="csv"]', actions);
    const csvCheck = validateRawCsv(rawCsv.text, completedRecord.result);
    assertion(assertions, "real-smoke-original-csv-export-every-source-value-exact",
      csvCheck.passed, { sha256: sha256(rawCsv.text), mediaType: rawCsv.type, ...csvCheck });
    const exportHashes = { rawJsonSha256: sha256(rawJson.text), rawCsvSha256: sha256(rawCsv.text) };
    await mkdir(join(outputPath, "real-mode-exports"), { recursive: true });
    const sourceJsonPath = join(outputPath, "real-mode-exports", "source.json");
    const sourceCsvPath = join(outputPath, "real-mode-exports", "source.csv");
    await Bun.write(sourceJsonPath, rawJson.text);
    await Bun.write(sourceCsvPath, rawCsv.text);
    baselineExportEvidence = {
      jsonPath: sourceJsonPath,
      csvPath: sourceCsvPath,
      jsonBlobIndex: rawJson.blobIndex,
      csvBlobIndex: rawCsv.blobIndex,
      rawJsonSha256: exportHashes.rawJsonSha256,
      rawCsvSha256: exportHashes.rawCsvSha256,
      jsonByteLength: Buffer.byteLength(rawJson.text),
      csvByteLength: Buffer.byteLength(rawCsv.text),
    };
    const cancellationProof = await runPostSubmitCancellationProof(
      sourceJob.request, outputPath, actions, assertions,
    );
    assertion(assertions, "real-smoke-deterministic-post-submit-cancellation-proof-passed",
      cancellationProof.passed, {
        jobId: cancellationProof.jobId,
        terminalStatus: cancellationProof.terminalStatus,
        storeRemoved: cancellationProof.storeRemoved,
        proofPath: join(outputPath, "real-smoke-cancel-proof.json"),
      });

    for (const [width, height] of [[1440, 1000], [390, 844]]) {
      const viewport = `${width}x${height}`;
      await page.cdp("Emulation.setDeviceMetricsOverride", {
        width, height, deviceScaleFactor: 1, mobile: width < 500,
      });
      for (const theme of ["light", "dark"]) {
        await selectValue(page, ".rail-footer select", theme, actions);
        await arm(page, `document.querySelector(".result-workspace")?.dataset.view==="overview"`,
          `real-smoke ${viewport} ${theme} overview before layout capture`);
        await trustedClick(page, '[data-view-tab="overview"]', actions);
        await settled(page, `real-smoke ${viewport} ${theme} overview before layout capture`);
        const state = await readJson(page, `({
          width:innerWidth,height:innerHeight,theme:document.documentElement.dataset.theme,
          jobId:document.querySelector(".result-workspace")?.dataset.jobId??null,
          panels:document.querySelectorAll(".overview-panel").length,
          overflow:document.documentElement.scrollWidth>innerWidth
        })`);
        assertion(assertions, `real-smoke-${viewport}-${theme}-app-surface-current`,
          state.width === width && state.height === height && state.theme === theme
          && state.jobId === runId && state.panels === 16 && !state.overflow, state);
        actions.outputPath = outputPath;
        await inspectModes(page, completedRecord.result, runId, server.url,
          actions, assertions, `real-${viewport}-${theme}`, httpRecords, async ({ mode }) => {
            const freshJson = await clickAndReadBlob(page, 'button[data-export="json"]', actions);
            const freshCsv = await clickAndReadBlob(page, 'button[data-export="csv"]', actions);
            let parsedJson = null;
            try { parsedJson = JSON.parse(freshJson.text); } catch {}
            const csv = validateRawCsv(freshCsv.text, completedRecord.result);
            const newBlobIndices = freshJson.blobIndex > rawCsv.blobIndex
              && freshCsv.blobIndex > freshJson.blobIndex
              && !modeExportEvidence.some((item) =>
                item.jsonBlobIndex === freshJson.blobIndex || item.csvBlobIndex === freshCsv.blobIndex);
            const jsonValuesEqualSource = deepEqual(parsedJson, completedRecord.result);
            const csvValuesEqualSource = csv.passed;
            const jsonBytesEqualBaseline = freshJson.text === rawJson.text;
            const csvBytesEqualBaseline = freshCsv.text === rawCsv.text;
            const jsonPath = join(outputPath, "real-mode-exports", `${viewport}-${theme}-${mode}.json`);
            const csvPath = join(outputPath, "real-mode-exports", `${viewport}-${theme}-${mode}.csv`);
            await Bun.write(jsonPath, freshJson.text);
            await Bun.write(csvPath, freshCsv.text);
            const capture = {
              viewport,
              theme,
              mode,
              jsonBlobIndex: freshJson.blobIndex,
              csvBlobIndex: freshCsv.blobIndex,
              newBlobIndices,
              jsonPath,
              csvPath,
              jsonByteLength: Buffer.byteLength(freshJson.text),
              csvByteLength: Buffer.byteLength(freshCsv.text),
              rawJsonSha256: sha256(freshJson.text),
              rawCsvSha256: sha256(freshCsv.text),
              jsonValuesEqualSource,
              csvValuesEqualSource,
              jsonBytesEqualBaseline,
              csvBytesEqualBaseline,
              csv,
            };
            modeExportEvidence.push(capture);
            actions.push({ action: "fresh-mode-export-captured", ...capture });
            assertion(assertions, `real-smoke-${viewport}-${theme}-${mode}-fresh-json-export-matches-source`,
              newBlobIndices && jsonValuesEqualSource && jsonBytesEqualBaseline
              && freshJson.type === rawJson.type,
              capture);
            assertion(assertions, `real-smoke-${viewport}-${theme}-${mode}-fresh-csv-export-matches-source`,
              newBlobIndices && csvValuesEqualSource && csvBytesEqualBaseline
              && freshCsv.type === rawCsv.type,
              capture);
          });
        const currentServerRecord = await jsonRequest(`${server.url}/api/jobs/${runId}`, httpRecords);
        const cellExports = modeExportEvidence.filter((item) => item.viewport === viewport && item.theme === theme);
        const modeExportsMatchSource = cellExports.length === 5 && cellExports.every((item) =>
          item.newBlobIndices && item.jsonValuesEqualSource && item.csvValuesEqualSource
          && item.jsonBytesEqualBaseline && item.csvBytesEqualBaseline);
        assertion(assertions, `real-smoke-${viewport}-${theme}-scores-and-exports-unchanged`,
          deepEqual(currentServerRecord.data.result, completedRecord.result)
          && modeExportsMatchSource,
          {
            exportHashes,
            scores: expectedScoreSnapshot(currentServerRecord.data.result),
            modeExportCount: cellExports.length,
            modeExportsMatchSource,
          });
      }
    }
    assertion(assertions, "real-smoke-fresh-export-evidence-covers-all-modes",
      modeExportEvidence.length === 20 && modeExportEvidence.every((item) =>
        item.newBlobIndices && item.jsonValuesEqualSource && item.csvValuesEqualSource
        && item.jsonBytesEqualBaseline && item.csvBytesEqualBaseline),
      { captures: modeExportEvidence.length, expected: 20 });
    actions.push({
      action: "real-inference-outcome",
      sourceArchiveId: archivedRunId,
      jobId: runId,
      request: completedRecord.request,
      output: {
        framesEvaluated: completedRecord.result.framesEvaluated,
        actionDimensions: completedRecord.result.actionNames.length,
        firstStepMae: completedRecord.result.firstStepMae,
        firstStepRmse: completedRecord.result.firstStepRmse,
        chunkMae: completedRecord.result.mae,
        chunkRmse: completedRecord.result.rmse,
        validSteps: completedRecord.result.validSteps,
        rawExports: exportHashes,
      },
      sourceType: "actual remote inference; not a synthetic fixture",
    });
  } catch (error) {
    assertion(assertions, "real-smoke-scenario-completed", false, String(error));
    actions.push({ action: "scenario-error", scenario: "real-smoke", jobId: runId, error: String(error) });
  } finally {
    if (server && storeDirectory) {
      const storePath = resolve(storeDirectory);
      const temporaryRoot = `${resolve(tmpdir())}/`;
      const safeOwnedTarget = server.url !== archivedBaseURL
        && new URL(server.url).hostname === "127.0.0.1"
        && new URL(server.url).port !== "4310"
        && storePath.startsWith(temporaryRoot)
        && storePath !== resolve(repoRoot, ".runs");
      assertion(assertions, "real-smoke-finally-cancellation-target-is-owned-private-store",
        safeOwnedTarget, { serverUrl: server.url, storeDirectory });
      if (safeOwnedTarget) {
        try {
          ownedJobCleanup = await cancelActiveJobs({
            prefix: "real-smoke-finally",
            listJobs: () => jsonRequest(`${server.url}/api/jobs`, httpRecords, {
              timeoutMs: cancellationTimeoutMs,
            }),
            subscribe: async (jobId, onSnapshot) => {
              const response = await fetch(`${server.url}/api/jobs/${jobId}/events`, {
                signal: AbortSignal.timeout(cancellationTimeoutMs),
              });
              return observeTerminalJob(response, jobId, cancellationTimeoutMs, onSnapshot);
            },
            cancel: (jobId) => jsonRequest(`${server.url}/api/jobs/${jobId}/cancel`, httpRecords, {
              method: "POST",
              timeoutMs: cancellationTimeoutMs,
            }),
            actions,
            assertions,
          });
        } catch (error) {
          ownedJobCleanup = { status: "failed", error: String(error), activeJobs: [] };
          assertion(assertions, "real-smoke-finally-owned-active-job-cleanup", false, ownedJobCleanup);
        }
      } else {
        ownedJobCleanup = { status: "unsafe-target-refused", activeJobs: [] };
      }
    } else {
      ownedJobCleanup = { status: "server-not-started-no-owned-job-could-be-submitted", activeJobs: [] };
    }
    for (const entry of harnesses) {
      try {
        const cleanup = await entry.harness.close();
        entry.closed = true;
        observedCleanups.push({ kind: "browser-harness", cleanup });
        assertion(assertions, "real-smoke-browser-harness-cleanup",
          !cleanup.browserOpen && !cleanup.serverOpen && !cleanup.tempStoreExists && cleanup.cleanupErrors.length === 0,
          cleanup);
      } catch (error) {
        observedCleanups.push({ kind: "browser-harness", error: String(error) });
        assertion(assertions, "real-smoke-browser-harness-cleanup", false, String(error));
      }
    }
    let serverCleanup = { notStarted: true };
    if (server) {
      try {
        serverCleanup = await server.close();
        assertion(assertions, "real-smoke-owned-server-terminated-and-port-closed",
          serverCleanup.exitCode !== null && serverCleanup.portRefused, serverCleanup);
      } catch (error) {
        serverCleanup = { error: String(error) };
        assertion(assertions, "real-smoke-owned-server-terminated-and-port-closed", false, serverCleanup);
      }
    } else assertion(assertions, "real-smoke-owned-server-started", false, "Dedicated QA server was never ready.");

    let storeAbsent = !storeDirectory;
    if (storeDirectory) {
      try {
        await rm(storeDirectory, { recursive: true });
        await stat(storeDirectory);
      } catch (error) {
        if (error.code === "ENOENT") storeAbsent = true;
        else actions.push({ action: "store-cleanup-error", error: String(error) });
      }
    }
    assertion(assertions, "real-smoke-owned-store-removed", storeAbsent, { storeDirectory });
    const cleanup = {
      server: serverCleanup,
      storeDirectory,
      storeAbsent,
      ownedJobCleanup,
      browserHarnesses: observedCleanups,
      originalServer4310Stopped: false,
      originalRunsMutated: false,
      robotActivity: false,
    };
    await Bun.write(join(outputPath, "real-smoke-cleanup.json"), `${JSON.stringify(cleanup, null, 2)}\n`);
    await Bun.write(join(outputPath, "real-smoke-mode-exports.json"), `${JSON.stringify({
      baseline: baselineExportEvidence,
      captures: modeExportEvidence,
      expectedCaptures: 20,
      complete: modeExportEvidence.length === 20
        && modeExportEvidence.every((item) => item.newBlobIndices
          && item.jsonValuesEqualSource && item.csvValuesEqualSource
          && item.jsonBytesEqualBaseline && item.csvBytesEqualBaseline),
    }, null, 2)}\n`);
    await Bun.write(join(outputPath, "real-smoke-http.json"), `${JSON.stringify(httpRecords, null, 2)}\n`);
    await Bun.write(join(outputPath, "real-smoke-owned-server.log"),
      `${JSON.stringify(server?.log ?? [], null, 2)}\n`);
  }
  return { assertions, actions };
}

async function runProcess(argv, { cwd = repoRoot, timeoutMs = 10 * 60_000 } = {}) {
  const child = Bun.spawn(argv, { cwd, stdout: "pipe", stderr: "pipe" });
  const stdoutPromise = new Response(child.stdout).text();
  const stderrPromise = new Response(child.stderr).text();
  let timer;
  const completion = await Promise.race([
    child.exited.then((exitCode) => ({ exitCode })),
    new Promise((resolveCompletion) => {
      timer = setTimeout(() => resolveCompletion({ timedOut: true }), timeoutMs);
    }),
  ]);
  clearTimeout(timer);
  if (completion.timedOut) {
    child.kill("SIGTERM");
    try { await bounded(child.exited, "timed-out child shutdown", 15_000); }
    catch {
      child.kill("SIGKILL");
      await bounded(child.exited, "forced child shutdown", 10_000);
    }
  }
  const [stdout, stderr] = await Promise.all([stdoutPromise, stderrPromise]);
  return { ...completion, argv, stdout, stderr };
}

async function runSdkOracle(outputPath) {
  const golden = join(outputPath, "sdk-golden.json");
  const generator = await runProcess([
    "/home/kgs/miniforge3/bin/python3",
    "tests/kinematics/sdk_oracle.py",
    "--seed", "20261004",
    "--out", golden,
  ], { timeoutMs: 10 * 60_000 });
  await Bun.write(join(outputPath, "sdk-oracle-generator.stdout.log"), generator.stdout);
  await Bun.write(join(outputPath, "sdk-oracle-generator.stderr.log"), generator.stderr);
  const checker = generator.exitCode === 0 && !generator.timedOut
    ? await runProcess([process.execPath, "tests/kinematics/check-oracle.ts", golden], { timeoutMs: 10 * 60_000 })
    : { exitCode: null, timedOut: false, skipped: true, argv: [], stdout: "", stderr: "Generator did not exit 0." };
  await Bun.write(join(outputPath, "sdk-oracle-checker.stdout.log"), checker.stdout);
  await Bun.write(join(outputPath, "sdk-oracle-checker.stderr.log"), checker.stderr);
  return {
    generator: { exitCode: generator.exitCode ?? null, timedOut: generator.timedOut === true, command: generator.argv },
    checker: { exitCode: checker.exitCode ?? null, timedOut: checker.timedOut === true, skipped: checker.skipped === true, command: checker.argv },
    golden,
    passed: generator.exitCode === 0 && checker.exitCode === 0 && !generator.timedOut && !checker.timedOut,
  };
}

async function runAll({ args, outputPath }) {
  const assertions = [];
  const actions = [];
  const cases = [
    ["Q01-overview", ["--case", "overview", "--fixture", "rby1-16", "--viewport", "1440x1000", "--theme", "light"]],
    ["Q02-synchronize", ["--case", "synchronize", "--fixture", "irregular-frames", "--viewport", "1440x1000", "--theme", "dark"]],
    ["Q03-scopes", ["--case", "scopes", "--fixture", "scalar-padding", "--viewport", "1440x1000", "--theme", "light"]],
    ["Q04-legacy", ["--case", "legacy", "--fixture", "legacy-run", "--viewport", "1440x1000", "--theme", "light"]],
    ["Q05-states", ["--case", "states", "--fixture", "malformed-and-empty", "--viewport", "390x844", "--theme", "dark"]],
    ["Q06-fk-gate", ["--case", "fk-gate", "--fixture", "rby1-16", "--viewport", "1440x1000", "--theme", "light"]],
    ["Q07-fk-values", ["--case", "fk-values", "--fixture", "fk-certified", "--viewport", "1440x1000", "--theme", "dark"]],
    ["Q08-long-trace", ["--case", "long-trace", "--fixture", "rby1-16x100000", "--viewport", "1440x1000", "--theme", "light"]],
    ["Q09-mobile-light", ["--case", "mobile-keyboard", "--fixture", "rby1-16", "--viewport", "390x844", "--theme", "light"]],
    ["Q09-mobile-dark", ["--case", "mobile-keyboard", "--fixture", "rby1-16", "--viewport", "390x844", "--theme", "dark"]],
    ["Q10-lifecycle", ["--case", "lifecycle", "--fixture", "lifecycle", "--viewport", "1440x1000", "--theme", "light"]],
    ["Q11-horizons", ["--case", "horizons", "--fixture", "horizon-boundaries", "--viewport", "1440x1000", "--theme", "light"]],
    ["Q12-fk-export", ["--case", "fk-export", "--fixture", "fk-certified", "--viewport", "1440x1000", "--theme", "light"]],
    ["profile-api", ["--case", "profile-api", "--fixture", "profile-root"]],
    ["archived-live", ["--case", "archived-live", "--base-url", archivedBaseURL, "--run-id", archivedRunId]],
    ["real-smoke", ["--case", "real-smoke"]],
  ];
  const commandResults = [];
  await mkdir(outputPath, { recursive: true });
  const cli = resolve(repoRoot, "tests/e2e/qa.mjs");
  for (const [name, caseArgs] of cases) {
    const casePath = join(outputPath, name);
    await mkdir(casePath, { recursive: true });
    const argv = [process.execPath, cli, ...caseArgs, "--out", casePath];
    const timeoutMs = name === "real-smoke" ? inferenceTimeoutMs + 5 * 60_000
      : name === "Q08-long-trace" ? 15 * 60_000 : 10 * 60_000;
    const result = await runProcess(argv, { timeoutMs });
    await Bun.write(join(casePath, "all-case.stdout.log"), result.stdout);
    await Bun.write(join(casePath, "all-case.stderr.log"), result.stderr);
    let childAssertions = [];
    let childCleanup = null;
    let parseError = null;
    try { childAssertions = JSON.parse(await Bun.file(join(casePath, "assertions.json")).text()); }
    catch (error) { parseError = `assertions: ${String(error)}`; }
    try { childCleanup = JSON.parse(await Bun.file(join(casePath, "cleanup.json")).text()); }
    catch (error) { parseError = `${parseError ? `${parseError}; ` : ""}cleanup: ${String(error)}`; }
    const requiredSidecars = {
      "Q10-lifecycle": ["scenario-cleanup.json"],
      "profile-api": ["profile-cleanup.json"],
      "archived-live": ["owned-cleanup.json"],
      "real-smoke": ["real-smoke-cleanup.json"],
    }[name] ?? [];
    const sidecars = [];
    for (const sidecarName of requiredSidecars) {
      try {
        sidecars.push({
          name: sidecarName,
          value: JSON.parse(await Bun.file(join(casePath, sidecarName)).text()),
        });
      } catch (error) {
        sidecars.push({ name: sidecarName, error: String(error) });
      }
    }
    const cleanHarness = (value) => value
      && value.browserOpen === false && value.serverOpen === false
      && value.tempStoreExists === false
      && Array.isArray(value.cleanupErrors) && value.cleanupErrors.length === 0;
    const sidecarCleanupClear = sidecars.every(({ name: sidecarName, value, error }) => {
      if (error || !value) return false;
      if (sidecarName === "scenario-cleanup.json") {
        return value.storeAbsent === true && value.portRefused === true
          && value.sharedResourcesTouched === false
          && Array.isArray(value.harnesses) && value.harnesses.every(cleanHarness);
      }
      if (sidecarName === "real-smoke-cleanup.json") {
        return value.storeAbsent === true && value.server?.portRefused === true
          && value.server?.exitCode !== null && value.originalServer4310Stopped === false
          && value.originalRunsMutated === false && value.robotActivity === false
          && Array.isArray(value.browserHarnesses)
          && value.browserHarnesses.every((entry) => cleanHarness(entry.cleanup));
      }
      return cleanHarness(value);
    });
    const cleanupIsClear = childCleanup !== null
      && cleanHarness(childCleanup) && sidecarCleanupClear;
    const casePassed = result.exitCode === 0 && !result.timedOut && parseError === null
      && childAssertions.length > 0
      && childAssertions.every((item) => item && item.passed === true)
      && cleanupIsClear;
    assertion(assertions, `all-${name}-exit-assertions-and-cleanup`,
      casePassed, {
        command: ["bun", "tests/e2e/qa.mjs", ...caseArgs, "--out", casePath],
        exitCode: result.exitCode ?? null,
        timedOut: result.timedOut === true,
        assertionCount: childAssertions.length,
        failedAssertions: childAssertions.filter((item) => item?.passed !== true).map((item) => item?.name ?? "invalid"),
        cleanup: childCleanup,
        sidecars,
        parseError,
        stdoutPath: join(casePath, "all-case.stdout.log"),
        stderrPath: join(casePath, "all-case.stderr.log"),
      });
    for (const item of childAssertions) {
      assertion(assertions, `${name}/${item?.name ?? "unnamed"}`, item?.passed === true, item?.detail ?? "");
    }
    actions.push({
      action: "registered-case",
      name,
      command: ["bun", "tests/e2e/qa.mjs", ...caseArgs, "--out", casePath],
      exitCode: result.exitCode ?? null,
      timedOut: result.timedOut === true,
      assertionCount: childAssertions.length,
      cleanup: childCleanup,
      sidecars,
      outputPath: casePath,
    });
    commandResults.push({
      name, args: caseArgs, exitCode: result.exitCode ?? null,
      timedOut: result.timedOut === true, assertionCount: childAssertions.length,
      passed: casePassed, cleanupIsClear, parseError,
    });
  }
  const sdk = await runSdkOracle(outputPath);
  assertion(assertions, "all-sdk-oracle-generator-and-checker-pass", sdk.passed, sdk);
  actions.push({ action: "sdk-oracle", ...sdk });
  const result = { cases: commandResults, sdkOracle: sdk };
  await Bun.write(join(outputPath, "all-cases.json"), `${JSON.stringify(result, null, 2)}\n`);
  actions.push({ action: "all-cases-manifest", path: join(outputPath, "all-cases.json") });
  return { assertions, actions };
}

export async function runScenario(context) {
  switch (context.args.case) {
    case "archived-live": return runArchivedLive(context);
    case "real-smoke": return runRealSmoke(context);
    case "all": return runAll(context);
    default: throw new Error(`Unsupported real-data scenario: ${context.args.case}`);
  }
}
