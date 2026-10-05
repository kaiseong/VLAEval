import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { cpus, hostname, platform, release } from "node:os";
import { join, resolve } from "node:path";
import index from "../../../index.html";
import { jobSchema } from "../../../src/contracts";
import { sampleRenderGeometry } from "../../../src/client/analysis/render-sampling";
import { buildFkWorkerAsset } from "../../../src/kinematics/worker-asset";
import { deriveForward } from "../../../src/kinematics/forward";
import { fixtureJob, fixtureSnapshot } from "../../fixtures/redesign/index.mjs";

// allow: SIZE_OK — This existing acceptance scenario retains the parent-owned native
// geometry/export oracles alongside the new admission proof; task 44 scopes edits here.
const timeoutMs = 15_000;
const frameCount = 100_000;
const frameForSpike = (channel, path) => (path === "predicted" ? 2_113 : 2_317) + channel * 5_003;

function assertion(assertions, name, passed, detail) {
  assertions.push({ name, passed: passed === true, detail });
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function buildTraceCase(kind) {
  const job = fixtureJob("rby1-16x100000");
  const result = job.result;
  if (!result) throw new Error("The long-trace fixture has no result.");
  const trace = result.traces.find((item) => item.episode === 3);
  if (!trace || trace.frames.length !== frameCount || result.actionNames.length !== 16) {
    throw new Error(`Expected one 16-channel ${frameCount}-frame trace.`);
  }
  if (kind === "spikes") {
    for (let channel = 0; channel < result.actionNames.length; channel += 1) {
      const predictedFrame = frameForSpike(channel, "predicted");
      const targetFrame = frameForSpike(channel, "target");
      const sign = channel % 2 === 0 ? 1 : -1;
      const predicted = trace.predicted[predictedFrame];
      const target = trace.target[targetFrame];
      if (!predicted || !target) throw new Error(`Spike frame is missing for channel ${channel}.`);
      predicted[channel] += sign * 50_000;
      target[channel] -= sign * 40_000;
    }
  } else if (kind === "gaps") {
    for (let index = 0; index < trace.frames.length; index += 1) {
      const predicted = trace.predicted[index];
      const target = trace.target[index];
      if (!predicted || !target) throw new Error(`Alternating-gap frame ${index} is missing.`);
      const value = index % 2 === 0 ? 0 : Math.PI / 2;
      predicted[0] = value;
      target[0] = value;
      predicted[7] = value;
      target[7] = value;
      for (let dimension = 1; dimension < predicted.length; dimension += 1) {
        if (dimension !== 7) {
          predicted[dimension] = 0;
          target[dimension] = 0;
        }
      }
    }
  }
  const absoluteErrors = result.actionNames.map(() => 0);
  const squaredErrors = result.actionNames.map(() => 0);
  for (let index = 0; index < trace.frames.length; index += 1) {
    for (let dimension = 0; dimension < result.actionNames.length; dimension += 1) {
      const error = trace.predicted[index][dimension] - trace.target[index][dimension];
      absoluteErrors[dimension] += Math.abs(error);
      squaredErrors[dimension] += error * error;
    }
  }
  const count = trace.frames.length * result.actionNames.length;
  const mae = absoluteErrors.reduce((sum, value) => sum + value, 0) / count;
  const rmse = Math.sqrt(squaredErrors.reduce((sum, value) => sum + value, 0) / count);
  Object.assign(result, {
    mae, rmse, firstStepMae: mae, firstStepRmse: rmse,
    perEpisode: [{ episode: trace.episode, framesEvaluated: trace.frames.length, mae, rmse }],
    perDimension: result.actionNames.map((name, dimension) => ({
      name, mae: absoluteErrors[dimension] / trace.frames.length,
      rmse: Math.sqrt(squaredErrors[dimension] / trace.frames.length),
    })),
    perHorizon: [{ step: 0, count: trace.frames.length, mae, rmse }],
    samples: result.samples.map(sample => ({
      ...sample,
      predicted: [[...trace.predicted[sample.frame]]],
      target: [[...trace.target[sample.frame]]],
    })),
  });
  const identity = { continuous: 20, spikes: 21, gaps: 22 }[kind];
  job.id = `00000000-0000-4000-8000-${String(identity).padStart(12, "0")}`;
  job.createdAt = `2026-10-05T00:00:${String(identity).padStart(2, "0")}.000Z`;
  return job;
}

function buildGapProfile() {
  const request = fixtureSnapshot("fk-certified").fkRequest;
  if (!request) throw new Error("Certified Worker profile fixture is missing.");
  const profile = structuredClone(request.profile);
  profile.model = "synthetic-rby1-gap-probe";
  profile.revision = "task20-alternating-singularity";
  profile.rightChain[0].axis = [0, 1, 0];
  profile.leftChain[0].axis = [0, 1, 0];
  return profile;
}

async function read(page, expression) {
  return JSON.parse(await page.evaluate(`JSON.stringify(${expression})`));
}

async function arm(page, expression, label = expression, bound = timeoutMs) {
  await page.evaluate(`(()=>{
    const predicate=()=>(${expression});
    window.__task20Signal=new Promise((resolve,reject)=>{
      let timer;
      const observer=new MutationObserver(()=>{
        if(!predicate())return;
        observer.disconnect();clearTimeout(timer);resolve(true);
      });
      if(predicate())return resolve(true);
      observer.observe(document.documentElement,{subtree:true,childList:true,attributes:true,characterData:true});
      timer=setTimeout(()=>{
        observer.disconnect();
        reject(new Error(${JSON.stringify(`Task20 signal timed out: ${label}`)}));
      },${bound});
    });
    return true;
  })()`);
}

async function settled(page) {
  await page.evaluate("window.__task20Signal");
}

async function trustedClickAt(page, selector, point, actions, shouldScroll = true) {
  const target = await read(page, `(()=>{
    const selector=${JSON.stringify(selector)};
    const element=document.querySelector(selector);
    if(!element)throw new Error("Missing target: "+selector);
    if(${shouldScroll})element.scrollIntoView({behavior:"instant",block:"center",inline:"center"});
    const x=${JSON.stringify(point?.x ?? null)} ?? (element.getBoundingClientRect().left+element.getBoundingClientRect().width/2);
    const y=${JSON.stringify(point?.y ?? null)} ?? (element.getBoundingClientRect().top+element.getBoundingClientRect().height/2);
    const rect=element.getBoundingClientRect(),hit=document.elementFromPoint(x,y);
    if(rect.width<=0||rect.height<=0||!hit||(hit!==element&&!element.contains(hit)))
      throw new Error("Trusted target failed hit testing: "+JSON.stringify({selector,rect:rect.toJSON(),x,y,hit:hit?.outerHTML}));
    const clickId="task20-"+crypto.randomUUID();
    window.__task20Click=null;
    element.addEventListener("click",event=>{
      window.__task20Click={clickId,isTrusted:event.isTrusted,selector,currentTargetMatches:event.currentTarget===element};
    },{once:true});
    return {x,y,clickId,selector};
  })()`);
  await page.cdp("Input.dispatchMouseEvent", {
    type: "mousePressed", x: target.x, y: target.y, button: "left", clickCount: 1,
  });
  await page.cdp("Input.dispatchMouseEvent", {
    type: "mouseReleased", x: target.x, y: target.y, button: "left", clickCount: 1,
  });
  const event = await read(page, "window.__task20Click");
  const trusted = event?.clickId === target.clickId && event.selector === selector
    && event.isTrusted === true && event.currentTargetMatches === true;
  actions.push({ action: "trusted-click", ...target, event });
  if (!trusted) throw new Error(`Click was not attributed to the target: ${JSON.stringify({ selector, event })}`);
  return target;
}

const keyCodes = {
  Home: [36, "Home"], End: [35, "End"], ArrowDown: [40, "ArrowDown"],
  ArrowRight: [39, "ArrowRight"], Enter: [13, "Enter"], Tab: [9, "Tab"],
  a: [65, "KeyA"], Control: [17, "ControlLeft"], ArrowUp: [38, "ArrowUp"],
};

async function admissionTiming({ page, job, profile, actions, assertions, persist, admission }) {
  const samples = [];
  const trace = job.result.traces[0];
  for (let index = 0; index <= 30; index++) {
    // A fresh real generation each time: never replay a result or time post-ready input.
    await arm(page, "!document.querySelector('[data-fk-confirm]').checked&&!document.querySelector('[data-fk-channel]')");
    await trustedClickAt(page, "[data-fk-confirm]", null, actions);
    await settled(page);
    const previous = await read(page, "Number(document.querySelector('#workspace-frame').value)");
    const expected = previous + 1;
    const arrived = admission();
    await arm(page, "document.querySelector('.fk-panel')?.textContent.includes('Deriving')", "fresh large derivation pending");
    await trustedClickAt(page, "[data-fk-confirm]", null, actions);
    await settled(page);
    await trustedClickAt(page, "#workspace-frame", null, actions);
    await page.evaluate(`(()=>{
      window.__task44Key=null;
      document.querySelector('#workspace-frame').addEventListener('keydown',event=>{
        window.__task44Key={trusted:event.isTrusted,key:event.key,handlerAt:performance.timeOrigin+performance.now()};
      },{once:true});
      window.__task44Paint=new Promise((resolve,reject)=>{
        let timer;
        const inspect=()=>{
          const panels=[...document.querySelectorAll('[data-fk-channel]')];
          const generation=Number(document.querySelector('.fk-panel')?.dataset.fkGeneration);
          if(!window.__task44Key||panels.length!==12||generation!==window.__task44Arrival?.identity.generation)return;
          if(!panels.every(panel=>panel.dataset.selectedFrame==='${expected}'
            &&panel.querySelector('.trace-plot__cursor')?.dataset.sourceFrame==='${expected}'))return;
          observer.disconnect();clearTimeout(timer);
          requestAnimationFrame(()=>requestAnimationFrame(()=>{
            const points=panels.map(panel=>{
              const figure=panel.querySelector('.trace-plot'),svg=panel.querySelector('svg');
              const cursor=panel.querySelector('.trace-plot__cursor');
              const left=88,right=Math.max(left+1,svg.viewBox.baseVal.width-16);
              const start=Number(figure.dataset.windowStart),end=Number(figure.dataset.windowEnd);
              const expectedX=start===end?(left+right)/2:left+(${expected}-start)/(end-start)*(right-left);
              return {channel:panel.dataset.fkChannel,frame:Number(panel.dataset.selectedFrame),
                cursorFrame:Number(cursor.dataset.sourceFrame),x1:Number(cursor.getAttribute('x1')),x2:Number(cursor.getAttribute('x2')),
                expectedX,predicted:panel.querySelector('[data-fk-predicted]').textContent,
                target:panel.querySelector('[data-fk-target]').textContent};
            });
            resolve({key:window.__task44Key,arrival:window.__task44Arrival,generation,points,
              jobId:document.querySelector('.result-workspace').dataset.jobId,paintedAt:performance.timeOrigin+performance.now()});
          }));
        };
        const observer=new MutationObserver(inspect);
        observer.observe(document.documentElement,{subtree:true,attributes:true,childList:true,characterData:true});
        timer=setTimeout(()=>{observer.disconnect();reject(new Error('Queued admission cursor deadline'))},15000);
      });return true;
    })()`);
    const signal = await arrived;
    const sentAt = performance.now();
    const sentAtEpoch = performance.timeOrigin + sentAt;
    await trustedKey(page, "ArrowUp", actions);
    const observed = JSON.parse(await page.evaluate("window.__task44Paint.then(JSON.stringify)"));
    const completedAt = performance.now();
    // Independent exact point oracle from fixture input, not the received display payload.
    const template = fixtureSnapshot("fk-certified").fkRequest;
    const numeric = deriveForward({ ...template, jobId: job.id, episode: trace.episode, profile,
      profileHash: profile.profileHash, generation: observed.generation, jointUnit: "rad",
      frames: [{ frame: expected, predicted: trace.predicted[expected], target: trace.target[expected] }] }).samples[0];
    const pointsCorrect = observed.points.every(point => {
      const [side, axis] = point.channel.split("-");
      const dimension = ["X", "Y", "Z", "Roll", "Pitch", "Yaw"].indexOf(axis);
      const value = name => {
        const pose = numeric.arms[side].pose[name];
        const raw = dimension < 3 ? pose.translationM?.[dimension] ?? null : pose.rpyDeg[dimension - 3];
        return raw === null ? "unavailable" : String(raw * (dimension < 3 ? 1000 : 1));
      };
      return point.frame === expected && point.cursorFrame === expected
        && Math.abs(point.x1 - point.expectedX) < 1e-7 && Math.abs(point.x2 - point.expectedX) < 1e-7
        && point.predicted === value("predicted") && point.target === value("target");
    });
    const sample = { index, warmup: index === 0, expected, signal, sentAt, sentAtEpoch, completedAt,
      queuedBeforeHandlerMs: observed.key.handlerAt - sentAtEpoch,
      latencyMs: completedAt - sentAt, ...observed,
      passed: pointsCorrect && observed.points.length === 12 && observed.key.trusted && observed.key.key === "ArrowUp"
        && observed.jobId === job.id && signal.identity.generation === observed.generation
        && signal.identity.jobId === job.id && signal.identity.episode === trace.episode };
    samples.push(sample);
    assertion(assertions, `admission-${index}-trusted-current-cursors-and-exact-values`, sample.passed, sample);
    await persist("admission-attempts.json", JSON.stringify(samples, null, 2));
  }
  const measured = samples.filter(sample => !sample.warmup);
  const sorted = measured.map(sample => sample.latencyMs).sort((a, b) => a - b);
  const distribution = { samples, sorted, p95: sorted[Math.ceil(sorted.length * .95) - 1],
    method: "nearest rank; host monotonic send-before-CDP to current exact values plus double RAF returned; includes input queue time",
    warmup: 1, measured: measured.length, frameCount, actualProductionApp: true, nativeModuleWorker: true };
  await persist("admission-timings.json", JSON.stringify(distribution, null, 2));
  assertion(assertions, "thirty-warmed-real-admission-queued-input-p95-at-most-100ms",
    measured.length >= 30 && measured.every(sample => sample.passed) && distribution.p95 <= 100, distribution);
  // Full source evidence comes from an actual current export, never from a compact view.
  await page.evaluate(`(()=>{
    const create=URL.createObjectURL.bind(URL);
    window.__task44Export=new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{URL.createObjectURL=create;reject(new Error('Actual task44 export Blob capture timed out'))},${timeoutMs});
      URL.createObjectURL=blob=>{clearTimeout(timer);URL.createObjectURL=create;resolve(blob.text());return create(blob)};
    });return true;
  })()`);
  await trustedClickAt(page, '[data-export="fk-json"]', null, actions);
  const exportedText = await page.evaluate("window.__task44Export");
  const exported = JSON.parse(exportedText);
  const fullSourceMatches = exported.source.jobId === job.id && exported.source.episode === trace.episode
    && exported.declaration.generation === samples.at(-1).generation && exported.samples.length === frameCount
    && Object.values(exported.summaries).every(arm => Object.values(arm).every(metric =>
      metric.count === frameCount && metric.mean === 0 && metric.rms === 0))
    && exported.source.frames.length === frameCount && exported.samples.every((sample, i) =>
      sample.frame === trace.frames[i] && exported.source.frames[i] === trace.frames[i]
      && sample.source.predicted.every((value, d) => value === trace.predicted[i][d])
      && sample.source.target.every((value, d) => value === trace.target[i][d]));
  await persist("admission-current-full-source.fk.json", exportedText);
  assertion(assertions, "actual-current-encoded-export-retains-every-source-frame-and-value", fullSourceMatches,
    { sha256: sha256(exportedText), frames: exported.samples.length, generation: exported.declaration.generation,
      source: { jobId: exported.source.jobId, episode: exported.source.episode }, summaries: exported.summaries });
}

async function trustedKey(page, name, actions, modifiers = 0) {
  const [virtual, code] = keyCodes[name] ?? [];
  if (virtual === undefined) throw new Error(`Unsupported task20 key: ${name}`);
  await page.cdp("Input.dispatchKeyEvent", {
    type: "keyDown", key: name, code, windowsVirtualKeyCode: virtual, modifiers,
  });
  if (name === "Enter") {
    await page.cdp("Input.dispatchKeyEvent", {
      type: "char", key: name, code, text: "\r", windowsVirtualKeyCode: virtual, modifiers,
    });
  }
  await page.cdp("Input.dispatchKeyEvent", {
    type: "keyUp", key: name, code, windowsVirtualKeyCode: virtual, modifiers,
  });
  actions.push({ action: "trusted-key", key: name, modifiers });
}

async function choose(page, selector, value, actions) {
  const position = await read(page, `Array.from(document.querySelector(${JSON.stringify(selector)}).options)
    .findIndex(option=>option.value===${JSON.stringify(String(value))})`);
  if (position < 0) throw new Error(`Value ${value} is unavailable in ${selector}.`);
  await arm(page, `document.querySelector(${JSON.stringify(selector)}).value===${JSON.stringify(String(value))}`,
    `select ${selector}=${value}`);
  await trustedClickAt(page, selector, null, actions);
  await trustedKey(page, "Home", actions);
  for (let index = 0; index < position; index += 1) await trustedKey(page, "ArrowDown", actions);
  await trustedKey(page, "Tab", actions);
  await settled(page);
}

async function fillNumber(page, selector, value, expected, actions) {
  await arm(page, expected, `fill ${selector}=${value}`);
  await trustedClickAt(page, selector, null, actions);
  await page.cdp("Input.dispatchKeyEvent", {
    type: "keyDown", key: "Control", code: "ControlLeft", windowsVirtualKeyCode: 17,
  });
  await page.cdp("Input.dispatchKeyEvent", {
    type: "keyDown", key: "a", code: "KeyA", modifiers: 2, windowsVirtualKeyCode: 65,
  });
  await page.cdp("Input.dispatchKeyEvent", {
    type: "keyUp", key: "a", code: "KeyA", modifiers: 2, windowsVirtualKeyCode: 65,
  });
  await page.cdp("Input.dispatchKeyEvent", {
    type: "keyUp", key: "Control", code: "ControlLeft", windowsVirtualKeyCode: 17,
  });
  actions.push({ action: "trusted-keyboard-shortcut", key: "Control+A", selector });
  await page.cdp("Input.insertText", { text: String(value) });
  await trustedKey(page, "Enter", actions);
  await settled(page);
}

async function screenshot(page, name, width, height, actions, persist) {
  await page.evaluate("document.fonts.ready");
  await page.evaluate("new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))");
  const encoded = await page.cdp("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
  const bytes = Buffer.from(encoded.data, "base64");
  const signature = bytes.subarray(0, 8).toString("hex");
  const dimensions = { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  const path = await persist(`${name}.png`, bytes);
  const passed = signature === "89504e470d0a1a0a" && dimensions.width === width && dimensions.height === height;
  actions.push({ action: "screenshot", path, signature, ...dimensions });
  return { path, signature, ...dimensions, passed };
}

function spikeFrameList(channel) {
  return [frameForSpike(channel, "predicted"), frameForSpike(channel, "target")];
}

async function readPanelGeometry(page) {
  return read(page, `(()=>{
    const frameFor=(x,start,end,left,right)=>Math.round(start+(x-left)/(right-left)*(end-start));
    const panels=[...document.querySelectorAll('.overview-panel')].map(panel=>{
      const figure=panel.querySelector('.trace-plot'),svg=figure?.querySelector('svg');
      const width=svg?.viewBox.baseVal.width??0,left=88,right=Math.max(left+1,width-16);
      const start=Number(figure?.dataset.windowStart),end=Number(figure?.dataset.windowEnd);
      const paths={};
      for(const name of ['predicted','target']){
        const groups=[...panel.querySelectorAll('.trace-plot__'+name+' [data-source-frame-start]')];
        paths[name]=groups.map(group=>{
          const path=group.querySelector('path'),d=path?.getAttribute('d')??'';
          const points=[...d.matchAll(/[ML]\\s*(-?(?:\\d+\\.?\\d*|\\.\\d+)(?:e[+-]?\\d+)?),\\s*(-?(?:\\d+\\.?\\d*|\\.\\d+)(?:e[+-]?\\d+)?)/ig)]
            .map(match=>({x:Number(match[1]),y:Number(match[2]),frame:frameFor(Number(match[1]),start,end,left,right)}));
          return {start:Number(group.dataset.sourceFrameStart),end:Number(group.dataset.sourceFrameEnd),points};
        });
      }
      const points=[...paths.predicted,...paths.target].flatMap(segment=>segment.points);
      const count=points.length;
      const gapBands=panel.querySelectorAll('[data-gap-density="unavailable"]').length;
      const matrix=svg?.getScreenCTM();
      return {name:panel.dataset.channelName,index:Number(panel.dataset.sourceIndex),width,
        start,end,count,gapBands,paths,screenCTM:matrix?{a:matrix.a,b:matrix.b,c:matrix.c,d:matrix.d,e:matrix.e,f:matrix.f}:null};
    });
    return {panels,count:panels.length,maximumCombinedVertices:Math.max(0,...panels.map(panel=>panel.count)),
      bands:panels.reduce((sum,panel)=>sum+panel.gapBands,0)};
  })()`);
}

async function clickCoordinatesForFrame(page, frame) {
  return read(page, `(()=>{
    const figure=document.querySelector('.overview-panel[data-source-index="0"] .trace-plot');
    const svg=figure?.querySelector('svg');
    if(!svg)throw new Error("First overview SVG is missing");
    const matrix=svg.getScreenCTM();
    if(!matrix)throw new Error("SVG screen CTM is unavailable");
    const width=svg.viewBox.baseVal.width,left=88,right=Math.max(left+1,width-16);
    const start=Number(figure.dataset.windowStart),end=Number(figure.dataset.windowEnd);
    const seedFrame=${frame};
    const localX=left+(seedFrame-start)/(end-start)*(right-left),localY=80;
    const point=new DOMPoint(localX,localY).matrixTransform(matrix);
    const clickX=Math.round(point.x),clickY=Math.round(point.y);
    const screenXForFrame=frame=>new DOMPoint(
      left+(frame-start)/(end-start)*(right-left),localY
    ).matrixTransform(matrix).x;
    let low=Math.ceil(start),high=Math.floor(end);
    while(low<high) {
      const middle=Math.floor((low+high)/2);
      if(screenXForFrame(middle)<clickX)low=middle+1;else high=middle;
    }
    const earlier=low-1,later=low;
    const expectedFrame=earlier<Math.ceil(start)?later
      :later>Math.floor(end)||Math.abs(screenXForFrame(earlier)-clickX)<=Math.abs(screenXForFrame(later)-clickX)?earlier:later;
    return {x:clickX,y:clickY,localX,localY,seedFrame,expectedFrame,start,end,
      screenCTM:{a:matrix.a,b:matrix.b,c:matrix.c,d:matrix.d,e:matrix.e,f:matrix.f},
      viewBox:{width,height:svg.viewBox.baseVal.height},physical:svg.getBoundingClientRect().toJSON()};
  })()`);
}

async function subscribeRenderedFrame(page, frame) {
  await page.evaluate(`(()=>{
    if(!window.__task20CaptureListener){
      document.addEventListener('click',event=>{
        const target=event.target instanceof Element?event.target.closest('.overview-panel .trace-plot svg'):null;
        if(target&&window.__task20Pending) {
          window.__task20Pending.startedAt=performance.now();
          window.__task20Pending.trusted=event.isTrusted;
          window.__task20Pending.event={clientX:event.clientX,clientY:event.clientY,targetSVG:target===event.target};
        }
      },true);
      window.__task20CaptureListener=true;
    }
    const workspace=document.querySelector('.result-workspace');
    if(!workspace)throw new Error("Integrated result workspace is missing");
    const expected=${frame};
    const previous=Number(workspace.dataset.sourceFrame);
    if(Number(workspace.dataset.sourceFrame)===expected)throw new Error("Cursor target must differ from the current frame");
    window.__task20Pending={expected,previous,startedAt:null,trusted:false,event:null};
    const snapshot=()=>{
      const current=document.querySelector('.result-workspace');
      const plots=[...document.querySelectorAll('.overview-panel .trace-plot')];
      return {expected:window.__task20Pending?.expected,previous:window.__task20Pending?.previous,
        current:Number(current?.dataset.sourceFrame),panelFrames:plots.map(plot=>Number(plot.dataset.sourceFrame)),
        renderedCursors:plots.map(plot=>Number(plot.querySelector('.trace-plot__cursor')?.dataset.sourceFrame)),
        startedAt:window.__task20Pending?.startedAt,trusted:window.__task20Pending?.trusted,event:window.__task20Pending?.event};
    };
    window.__task20Signal=new Promise((resolve,reject)=>{
      let timer;
      const observer=new MutationObserver(()=>{
        const plots=[...document.querySelectorAll('.overview-panel .trace-plot')];
        const current=document.querySelector('.result-workspace');
        const actual=current?.dataset.sourceFrame;
        const ready=actual!==String(previous)&&plots.length===16
          &&plots.every(plot=>plot.dataset.sourceFrame===actual
            &&plot.querySelector('.trace-plot__cursor')?.dataset.sourceFrame===actual);
        if(!ready||window.__task20Pending.startedAt===null)return;
        observer.disconnect();clearTimeout(timer);
        requestAnimationFrame(()=>requestAnimationFrame(()=>{
          const elapsed=performance.now()-window.__task20Pending.startedAt;
          resolve({expected,previous,actual:Number(document.querySelector('.result-workspace').dataset.sourceFrame),
            panelFrames:plots.map(plot=>Number(plot.dataset.sourceFrame)),
            renderedCursors:plots.map(plot=>Number(plot.querySelector('.trace-plot__cursor')?.dataset.sourceFrame)),
            trusted:window.__task20Pending.trusted,event:window.__task20Pending.event,latencyMs:elapsed});
        }));
      });
      observer.observe(document.documentElement,{subtree:true,childList:true,attributes:true});
      timer=setTimeout(()=>{observer.disconnect();reject(new Error(
        "Rendered cursor did not settle before the 10000ms bound: "+JSON.stringify(snapshot())))},10000);
    });
  })()`);
}

async function measureCursor(page, frame, actions, assertions, index, warmup = false) {
  await page.evaluate("document.querySelector('.overview-panel[data-source-index=\"0\"] .trace-plot svg').scrollIntoView({behavior:'instant',block:'center',inline:'center'})");
  const point = await clickCoordinatesForFrame(page, frame);
  await subscribeRenderedFrame(page, point.expectedFrame);
  const target = await trustedClickAt(page,
    '.overview-panel[data-source-index="0"] .trace-plot svg', point, actions, false);
  const observation = JSON.parse(await page.evaluate("window.__task20Signal.then(value=>JSON.stringify(value))"));
  const passed = observation.expected === point.expectedFrame && observation.actual === point.expectedFrame
    && observation.event?.clientX === point.x && observation.event?.clientY === point.y
    && observation.trusted === true && observation.panelFrames.length === 16
      && observation.panelFrames.every((value) => value === point.expectedFrame)
    && observation.renderedCursors.length === 16
      && observation.renderedCursors.every((value) => value === point.expectedFrame);
  const sample = {
    index, warmup, seedFrame: frame, requestedFrame: point.expectedFrame,
    point, trustedClick: target.event,
    actualFrame: observation.actual, latencyMs: observation.latencyMs, passed,
  };
  actions.push({ action: warmup ? "cursor-warmup-observed" : "cursor-timing-sample", ...sample });
  assertion(assertions, `cursor-action-${index}-selects-and-renders-exact-original-frame`, passed, sample);
  await page.evaluate("window.__task20Pending=null");
  return sample;
}

async function installDownloadCapture(page) {
  await page.evaluate(`(()=>{
    const original=URL.createObjectURL.bind(URL);
    window.__task20Downloads=[];
    URL.createObjectURL=blob=>{
      const record={type:blob.type,size:blob.size,filename:null,digest:null};
      record.digestPromise=blob.arrayBuffer().then(buffer=>crypto.subtle.digest('SHA-256',buffer))
        .then(bytes=>{record.digest=[...new Uint8Array(bytes)].map(value=>value.toString(16).padStart(2,'0')).join('');return true});
      window.__task20Downloads.push(record);
      window.dispatchEvent(new Event('task20-download-blob'));
      return original(blob);
    };
    document.addEventListener('click',event=>{
      const anchor=event.target instanceof Element?event.target.closest('a[download]'):null;
      if(anchor&&window.__task20Downloads.length)window.__task20Downloads.at(-1).filename=anchor.download;
    },true);
  })()`);
}

async function captureExport(page, selector, actions) {
  const count = await read(page, "window.__task20Downloads.length");
  await page.evaluate(`(()=>{window.__task20DownloadSignal=new Promise(resolve=>
    window.addEventListener('task20-download-blob',resolve,{once:true}))})()`);
  await trustedClickAt(page, selector, null, actions);
  await page.evaluate("window.__task20DownloadSignal");
  const value = JSON.parse(await page.evaluate(`window.__task20Downloads[${count}].digestPromise.then(()=>{
    const {type,size,filename,digest}=window.__task20Downloads[${count}];
    return JSON.stringify({type,size,filename,digest});
  })`));
  actions.push({ action: "actual-raw-export-blob-captured", selector, ...value });
  return value;
}

async function enableAlternatingFkGaps(page, profile, actions) {
  await arm(page, "document.querySelector('.result-workspace')?.dataset.view==='fk'", "open FK view");
  await trustedClickAt(page, '[data-view-tab="fk"]', null, actions);
  await settled(page);
  await arm(page, "document.querySelector('[data-fk-profile]')?.options.length>1", "load explicit gap profile");
  await settled(page);
  await arm(page, "document.querySelector('[data-fk-enable]')?.checked===true", "enable optional FK");
  await trustedClickAt(page, "[data-fk-enable]", null, actions);
  await settled(page);
  await choose(page, "[data-fk-profile]", profile.profileHash, actions);
  await arm(page, "document.querySelector('[data-fk-confirm]')&&!document.querySelector('[data-fk-confirm]').disabled",
    "load selected compiled profile");
  await settled(page);
  await choose(page, "[data-fk-unit]", "rad", actions);
  await choose(page, "[data-fk-representation]", "absolute_joint_position", actions);
  const ready = `document.querySelector('.fk-panel[data-fk-generation]')!==null
    &&document.querySelectorAll('.fk-pose-grid article[data-fk-channel]').length===12
    &&[...document.querySelectorAll('[data-fk-error="orientationRad"]')].length===2
    &&[...document.querySelectorAll('[data-fk-error="orientationRad"]')].every(item=>item.dataset.count==='${frameCount}')`;
  await arm(page, ready, "actual full-trace FK Worker result reaches FKPanel", 180_000);
  await trustedClickAt(page, "[data-fk-confirm]", null, actions);
  await settled(page);
  return ready;
}

async function setLightTheme(page, actions) {
  const current = await read(page, "document.documentElement.dataset.theme");
  if (current !== "light") await choose(page, ".rail-footer select", "light", actions);
}

function rawDigests(result) {
  // Expected wire bytes come directly from the fixture, not the exporter under test.
  const csv = createHash("sha256").update("\ufeffepisode,frame,time_seconds,dimension,action,predicted,target,error");
  for (const trace of result.traces) {
    for (let index = 0; index < trace.frames.length; index += 1) {
      const frame = trace.frames[index];
      for (let dimension = 0; dimension < result.actionNames.length; dimension += 1) {
        const predicted = trace.predicted[index][dimension];
        const target = trace.target[index][dimension];
        const cells = [trace.episode, frame, frame / result.fps, dimension,
          result.actionNames[dimension], predicted, target, predicted - target];
        csv.update("\r\n" + cells.map(value => `"${String(value).replaceAll('"', '""')}"`).join(","));
      }
    }
  }
  return {
    json: sha256(JSON.stringify(result, null, 2)),
    csv: csv.digest("hex"),
  };
}

async function renderCase({
  kind, job, serverURL, startHarness, width, height, actions, assertions, cursorSamples,
  persist, requireCursor, gapProfile, admission, unsafeSampling = false,
}) {
  let harness;
  let stage = "start-owned-harness";
  try {
    harness = await startHarness({ baseURL: serverURL, viewport: `${width}x${height}`, theme: "system" });
    stage = "open-real-App-page";
    const page = await harness.openPage();
    stage = "wait-for-100000-frame-overview";
    await page.evaluate(`new Promise((resolve,reject)=>{
      const expected=${JSON.stringify(job.id)};
      const ready=()=>document.querySelector('.result-workspace')?.dataset.jobId===expected
        &&document.querySelectorAll('.overview-panel').length===16;
      if(ready())return resolve(true);
      const observer=new MutationObserver(()=>{if(ready()){observer.disconnect();clearTimeout(timer);resolve(true)}});
      observer.observe(document.documentElement,{subtree:true,childList:true,attributes:true});
      const timer=setTimeout(()=>{observer.disconnect();reject(new Error('The production App did not render the long trace'))},120000);
    })`);
    stage = "select-light-theme";
    await setLightTheme(page, actions);
    stage = "inspect-integrated-overview";
    const actualTheme = await read(page, "document.documentElement.dataset.theme");
    const actualData = await read(page, `({
      jobId:document.querySelector('.result-workspace')?.dataset.jobId,
      frameCount:Number(document.querySelector('.coverage-summary')?.dataset.scoredAnchors??${frameCount}),
      panelCount:document.querySelectorAll('.overview-panel').length,
      names:[...document.querySelectorAll('.overview-panel')].map(panel=>panel.dataset.channelName),
      sourceIndices:[...document.querySelectorAll('.overview-panel')].map(panel=>Number(panel.dataset.sourceIndex)),
      view:document.querySelector('.result-workspace')?.dataset.view,
      theme:document.documentElement.dataset.theme,
      viewport:{width:innerWidth,height:innerHeight},
      physicalFirstSvg:document.querySelector('.overview-panel .trace-plot svg')?.getBoundingClientRect().toJSON()
    })`);
    assertion(assertions, `${kind}-actual-production-App-loads-all-16-panels`,
      actualData.jobId === job.id && actualData.panelCount === 16
        && new Set(actualData.names).size === 16 && actualData.sourceIndices.length === 16
        && actualData.frameCount === frameCount
        && actualData.view === "overview" && actualTheme === "light",
      actualData);
    stage = "capture-overview";
    const shot = await screenshot(page, `${kind}-1440x1000-light`, width, height, actions, persist);
    assertion(assertions, `${kind}-screenshot-signature-and-viewport`, shot.passed, shot);
    stage = "count-rendered-geometry";
    const initialGeometry = await readPanelGeometry(page);
    assertion(assertions, `${kind}-actual-svg-geometry-within-combined-4096-budget`,
      initialGeometry.count === 16 && initialGeometry.maximumCombinedVertices <= 4096,
      initialGeometry);
    actions.push({ action: `${kind}-initial-rendered-geometry`, ...initialGeometry });
    if (kind === "continuous") {
      const endpoints = initialGeometry.panels.every((panel) =>
        panel.paths.predicted.length === 1 && panel.paths.target.length === 1
        && panel.paths.predicted[0].start === 0 && panel.paths.target[0].start === 0
        && panel.paths.predicted[0].end === frameCount - 1 && panel.paths.target[0].end === frameCount - 1);
      assertion(assertions, "continuous-paths-retain-both-original-endpoints-in-all-panels", endpoints,
        initialGeometry.panels.map(({ name, paths }) => ({ name, paths })));
    }
    if (kind === "spikes") {
      stage = "assert-rendered-spikes";
      const retained = initialGeometry.panels.every((panel) => {
        const channel = panel.index;
        const predicted = panel.paths.predicted.flatMap((segment) => segment.points.map((point) => point.frame));
        const target = panel.paths.target.flatMap((segment) => segment.points.map((point) => point.frame));
        return predicted.includes(frameForSpike(channel, "predicted"))
          && target.includes(frameForSpike(channel, "target"));
      });
      assertion(assertions, "both-prediction-and-target-spikes-retained-in-all-16-panels", retained,
        initialGeometry.panels.map((panel) => ({
          channel: panel.name,
          predictedSpike: frameForSpike(panel.index, "predicted"),
          targetSpike: frameForSpike(panel.index, "target"),
          predictedVertices: panel.paths.predicted.flatMap((segment) => segment.points.map((point) => point.frame)),
          targetVertices: panel.paths.target.flatMap((segment) => segment.points.map((point) => point.frame)),
        })));
    }
    stage = "read-pre-interaction-metrics";
    const metricsBefore = await read(page, `({
      panelStats:[...document.querySelectorAll('.overview-panel__stats')].map(element=>({...element.dataset})),
      scoreText:document.querySelector('.result-scores')?.innerText??''
    })`);
    const sourceDigests = rawDigests(job.result);
    const downloadBefore = [];
    if (kind === "spikes") {
      stage = "capture-raw-exports";
      await installDownloadCapture(page);
      downloadBefore.push(await captureExport(page, '[data-export="json"]', actions));
      downloadBefore.push(await captureExport(page, '[data-export="csv"]', actions));
      assertion(assertions, "pre-window-production-downloads-match-independent-full-source-digests",
        downloadBefore[0].digest === sourceDigests.json && downloadBefore[1].digest === sourceDigests.csv,
        { downloadBefore, sourceDigests });

      stage = "find-an-omitted-original-frame";
      const chartWidth = await read(page, "document.querySelector('.overview-panel[data-source-index=\"0\"] .trace-plot svg').viewBox.baseVal.width");
      const rawTrace = job.result.traces[0];
      if (!rawTrace) throw new Error("The source trace disappeared before detail inspection.");
      const sampled = sampleRenderGeometry({
        frames: rawTrace.frames,
        predicted: rawTrace.predicted.map((row) => row[0] ?? null),
        target: rawTrace.target.map((row) => row[0] ?? null),
      }, { pixelWidth: Math.max(1, Math.floor(chartWidth - 104)) });
      if (sampled.kind !== "ready") throw new Error(`Production sampler could not select omitted-frame proof: ${sampled.kind}`);
      const represented = new Set(sampled.sourceIndices.map((index) => rawTrace.frames[index]));
      const omittedFrame = Array.from({ length: frameCount - 2 }, (_, index) => index + 1)
        .find((frame) => !represented.has(frame));
      if (omittedFrame === undefined) throw new Error("No omitted original frame was found in the actual reduced overview geometry.");
      actions.push({ action: "select-omitted-frame-for-raw-inspection", omittedFrame,
        chartWidth, pixelWidth: Math.floor(chartWidth - 104), sampledIndexCount: sampled.sourceIndices.length });
      await arm(page, "document.querySelector('.result-workspace')?.dataset.view==='detail'", "open raw detail inspector");
      stage = "open-detail-inspector";
      await trustedClickAt(page, '[data-qa-detail="0"]', null, actions);
      await settled(page);
      await fillNumber(page, "#source-frame", omittedFrame,
        `document.querySelector('.point-inspector')?.dataset.sourceFrame==='${omittedFrame}'`, actions);
      const rawIndex = rawTrace.frames.indexOf(omittedFrame);
      const expectedPrediction = rawTrace.predicted[rawIndex]?.[0];
      const expectedTarget = rawTrace.target[rawIndex]?.[0];
      const inspected = await read(page, `(()=>{
        const inspector=document.querySelector('.point-inspector');
        return {frame:Number(inspector?.dataset.sourceFrame),
          predicted:Number(inspector?.querySelector('[data-value="predicted"]')?.textContent),
          target:Number(inspector?.querySelector('[data-value="target"]')?.textContent),
          panelCount:document.querySelectorAll('.overview-panel').length};
      })()`);
      assertion(assertions, "omitted-original-frame-detail-reads-exact-full-raw-values",
        rawIndex >= 0 && !represented.has(omittedFrame) && inspected.frame === omittedFrame
          && inspected.predicted === expectedPrediction && inspected.target === expectedTarget
          && inspected.panelCount === 0,
        { omittedFrame, rawIndex, expectedPrediction, expectedTarget, inspected });
      const detailShot = await screenshot(page, "omitted-frame-detail-1440x1000-light",
        width, height, actions, persist);
      assertion(assertions, "omitted-frame-detail-screenshot-captured", detailShot.passed, detailShot);
      await arm(page, "document.querySelector('.result-workspace')?.dataset.view==='overview'", "return to actual overview");
      await trustedClickAt(page, '[data-view-tab="overview"]', null, actions);
      await settled(page);
      await fillNumber(page, "#workspace-start", 1_000,
        "document.querySelector('.result-workspace')?.dataset.windowStart==='1000'", actions);
      await fillNumber(page, "#workspace-end", 99_000,
        "document.querySelector('.result-workspace')?.dataset.windowEnd==='99000'", actions);
    }

    stage = "run-cursor-warmup-and-samples";
    if (kind !== "gaps" && requireCursor) {
      const currentFrame = await read(page, "Number(document.querySelector('.result-workspace').dataset.sourceFrame)");
      const warmupFrame = currentFrame >= 1_000 && currentFrame <= 99_000 ? (currentFrame === 2_000 ? 2_001 : 2_000) : 2_000;
      await measureCursor(page, warmupFrame, actions, assertions, 0, true);
      if (requireCursor) {
        for (let index = 0; index < 30; index += 1) {
          const frame = 3_000 + index * 3_001;
          const sample = await measureCursor(page, frame, actions, assertions, index + 1, false);
          cursorSamples.push(sample);
        }
      }
    }
    stage = "compare-post-interaction-metrics";
    const metricsAfter = await read(page, `({
      panelStats:[...document.querySelectorAll('.overview-panel__stats')].map(element=>({...element.dataset})),
      scoreText:document.querySelector('.result-scores')?.innerText??''
    })`);
    assertion(assertions, `${kind}-full-data-panel-scores-invariant-to-cursor-and-window`,
      JSON.stringify(metricsBefore) === JSON.stringify(metricsAfter), { metricsBefore, metricsAfter });
    if (kind === "spikes") {
      stage = "compare-post-interaction-exports";
      const downloadAfter = [
        await captureExport(page, '[data-export="json"]', actions),
        await captureExport(page, '[data-export="csv"]', actions),
      ];
      assertion(assertions, "actual-full-raw-download-digests-invariant-to-window-and-cursor",
        JSON.stringify(downloadBefore.map((item) => item.digest)) === JSON.stringify(downloadAfter.map((item) => item.digest))
          && downloadAfter[0].digest === sourceDigests.json && downloadAfter[1].digest === sourceDigests.csv,
        { downloadBefore, downloadAfter, sourceDigests });
    }
    if (kind === "gaps") {
      stage = "derive-full-trace-through-real-FK-Worker";
      await page.evaluate(`(()=>{
        const NativeWorker=window.Worker;
        window.Worker=class extends NativeWorker {
          constructor(...args) { super(...args);
            this.addEventListener('message',event=>{
              if(event.data.kind!=='view'||event.data.serial!==0)return;
              if(${unsafeSampling}) {
                const display=JSON.parse(event.data.payload);
                for(const channel of display.view.channels.filter(c=>c.axis==='Roll'||c.axis==='Yaw')) {
                  channel.geometry={kind:'ready',bucketCount:1,vertexCount:4,sourceIndices:[0,99999],
                    predicted:{segments:[[{index:0,frame:0,value:0},{index:99999,frame:99999,value:0}]]},
                    target:{segments:[[{index:0,frame:0,value:0},{index:99999,frame:99999,value:0}]]},unavailableBands:[]};
                }
                event.data.payload=JSON.stringify(display);
              }
              window.__task44Arrival={identity:event.data.identity,nativeReceivedAt:performance.timeOrigin+performance.now()};
              fetch('/__qa/admission',{method:'POST',body:JSON.stringify(window.__task44Arrival)});
            });
          }
        };return true;
      })()`);
      await installDownloadCapture(page);
      const workerReadyPredicate = await enableAlternatingFkGaps(page, gapProfile, actions);
      stage = "measure-full-pipeline-at-thirty-real-admission-boundaries";
      await admissionTiming({ page, job, profile: gapProfile, actions, assertions, persist, admission });
      const state = await read(page, `(()=>{
        const channels=[...document.querySelectorAll('.fk-pose-grid article[data-fk-channel]')];
        const panels=channels.map(article=>{
          const figure=article.querySelector('.trace-plot');
          const paths=[...article.querySelectorAll('.trace-plot__predicted path,.trace-plot__target path')];
          const vertices=paths.reduce((sum,path)=>sum+(path.getAttribute('d').match(/[ML]/g)?.length??0),0);
          const segments=[...article.querySelectorAll('[data-source-frame-start]')].map(group=>({
            start:Number(group.dataset.sourceFrameStart),end:Number(group.dataset.sourceFrameEnd),
            vertices:[...group.querySelectorAll('path')].reduce((sum,path)=>sum+(path.getAttribute('d').match(/[ML]/g)?.length??0),0)
          }));
          return {channel:article.dataset.fkChannel,vertices,segments,
            bands:article.querySelectorAll('[data-gap-density="unavailable"]').length,
            notice:figure?.querySelector('.trace-plot__notice')?.textContent??''};
        });
        return {generation:document.querySelector('.fk-panel')?.dataset.fkGeneration,
          channels:channels.length,
          counts:[...document.querySelectorAll('[data-fk-error="orientationRad"]')].map(item=>Number(item.dataset.count)),
          bands:panels.reduce((sum,item)=>sum+item.bands,0),
          maximumCombinedVertices:Math.max(0,...panels.map(item=>item.vertices)),
          gapSegments:panels.filter(item=>/-Roll$|-Yaw$/.test(item.channel))
            .flatMap(item=>item.segments.map(segment=>({...segment,channel:item.channel}))),panels};
      })()`);
      const noFalseConnections = state.gapSegments.every((segment) => segment.vertices === 1
        && segment.start === segment.end);
      const gapPanels = state.panels.filter((panel) => /-(Roll|Yaw)$/.test(panel.channel));
      const bandsCoverEveryGapChannel = gapPanels.length === 4 && gapPanels.every((panel) => panel.bands > 0);
      assertion(assertions, "actual-App-Worker-admits-100000-finite-input-frames-to-12-FK-panels",
        state.channels === 12 && state.counts.length === 2 && state.counts.every((count) => count === frameCount),
        { workerReadyPredicate, ...state });
      assertion(assertions, "alternating-singularity-gaps-render-honest-bands-with-no-false-connections",
        bandsCoverEveryGapChannel && state.maximumCombinedVertices <= 4096
          && noFalseConnections,
        { bands: state.bands, maximumCombinedVertices: state.maximumCombinedVertices,
          bandsCoverEveryGapChannel, gapSegments: state.gapSegments,
          channels: state.panels.map(({ channel, bands, vertices }) => ({ channel, bands, vertices })) });
      actions.push({ action: "integrated-100000-frame-Worker-gap-geometry", ...state });
      const gapRawDownloads = [
        await captureExport(page, '[data-export="json"]', actions),
        await captureExport(page, '[data-export="csv"]', actions),
      ];
      assertion(assertions, "actual-finite-native-exports-remain-exact-after-derived-gap-Worker",
        gapRawDownloads[0].digest === sourceDigests.json && gapRawDownloads[1].digest === sourceDigests.csv,
        { gapRawDownloads, sourceDigests });
      await page.evaluate("(()=>{const main=document.querySelector('main');main.scrollTop=0;window.scrollTo(0,0)})()");
      const gapShot = await screenshot(page, "alternating-FK-gaps-1440x1000-light",
        width, height, actions, persist);
      assertion(assertions, "alternating-FK-gap-screenshot-captured", gapShot.passed, gapShot);
      await page.evaluate("(()=>{const main=document.querySelector('main');main.scrollTop=main.scrollHeight;window.scrollTo(0,document.documentElement.scrollHeight)})()");
      const gapEndShot = await screenshot(page, "alternating-FK-gaps-end-1440x1000-light",
        width, height, actions, persist);
      assertion(assertions, "alternating-FK-gap-end-screenshot-captured", gapEndShot.passed, gapEndShot);
      await arm(page, "document.querySelector('.result-workspace')?.dataset.view==='overview'",
        "return to 16-channel overview after FK gap proof");
      await trustedClickAt(page, '[data-view-tab="overview"]', null, actions);
      await settled(page);
      const currentFrame = await read(page, "Number(document.querySelector('.result-workspace').dataset.sourceFrame)");
      const warmupFrame = currentFrame === 2_000 ? 2_001 : 2_000;
      await measureCursor(page, warmupFrame, actions, assertions, 0, true);
      for (let index = 0; index < 30; index += 1) {
        const frame = 3_000 + index * 3_001;
        cursorSamples.push(await measureCursor(page, frame, actions, assertions, index + 1, false));
      }
      const postWorkerMetrics = await read(page, `({
        panelStats:[...document.querySelectorAll('.overview-panel__stats')].map(element=>({...element.dataset})),
        scoreText:document.querySelector('.result-scores')?.innerText??''
      })`);
      assertion(assertions, "post-Worker-cursor-input-retains-full-data-scores",
        JSON.stringify(metricsBefore) === JSON.stringify(postWorkerMetrics), { metricsBefore, postWorkerMetrics });
    }
    await page.evaluate("(()=>{const main=document.querySelector('main');main.scrollTop=0;window.scrollTo(0,0)})()");
    const endShot = await screenshot(page, `${kind}-final-1440x1000-light`, width, height, actions, persist);
    assertion(assertions, `${kind}-final-state-screenshot-captured`, endShot.passed, endShot);
    return {
      kind, jobId: job.id, sourceSHA256: sha256(JSON.stringify(job.result)),
      rawExportDigests: sourceDigests, initialGeometry, metricsBefore, metricsAfter,
    };
  } catch (error) {
    const detail = error instanceof Error ? error.stack ?? error.message : String(error);
    throw new Error(`Task20 renderCase "${kind}" stage "${stage}" failed: ${detail}`);
  } finally {
    if (harness) {
      const cleanup = await harness.close();
      actions.push({ action: `${kind}-harness-cleanup`, ...cleanup });
      if (cleanup.browserOpen || cleanup.serverOpen || cleanup.tempStoreExists || cleanup.cleanupErrors.length) {
        assertion(assertions, `${kind}-owned-browser-harness-cleanup`, false, cleanup);
      } else {
        assertion(assertions, `${kind}-owned-browser-harness-cleanup`, true, cleanup);
      }
    }
  }
}

function probeAlternatingGapGeometry() {
  const frames = Array.from({ length: frameCount }, (_, index) => index);
  const predicted = Array.from({ length: frameCount }, (_, index) => index % 2 === 0 ? index / 100 : null);
  const target = Array.from({ length: frameCount }, (_, index) => index % 2 === 1 ? -index / 100 : null);
  const geometry = sampleRenderGeometry({ frames, predicted, target }, { pixelWidth: 300 });
  if (geometry.kind !== "ready") return { passed: false, kind: geometry.kind, reason: geometry.kind === "invalid" ? geometry.reason : null };
  const paths = [geometry.predicted, geometry.target];
  const noFalseConnections = paths.every((path) => path.segments.every((segment) => segment.length === 1
    || segment.every((vertex, index) => index === 0 || vertex.index === (segment[index - 1]?.index ?? -2) + 1)));
  const passed = geometry.vertexCount <= 4096 && geometry.unavailableBands.length > 0 && noFalseConnections;
  return {
    passed, frameCount: frames.length, vertexCount: geometry.vertexCount,
    unavailableBands: geometry.unavailableBands, predictedSegments: geometry.predicted.segments.length,
    targetSegments: geometry.target.segments.length, noFalseConnections,
    sampleRawValues: [0, 1, 2, 3, 4].map((index) => ({ frame: index, predicted: predicted[index], target: target[index] })),
  };
}

async function showSchemaGapRejection({ serverURL, startHarness, actions, assertions, persist, setActiveJob }) {
  let harness;
  const compactJob = fixtureJob("rby1-16");
  const trace = compactJob.result?.traces[0];
  if (!trace) throw new Error("Compact gap-admission fixture has no raw trace.");
  const row = trace.predicted[1];
  if (!row) throw new Error("Compact gap-admission row is missing.");
  row[0] = null;
  const parsed = jobSchema.safeParse(compactJob);
  assertion(assertions, "current-production-result-schema-rejects-null-raw-trace-gap",
    !parsed.success && parsed.error.issues.some((issue) => issue.path.join(".").includes("predicted")),
    parsed.success ? "unexpectedly accepted null trace" : parsed.error.issues.slice(0, 4).map(({ path, message }) => ({ path, message })));
  // The server serves the deliberate invalid source as transport data. The actual App
  // must show its current read error; it must not silently fabricate a connected trace.
  setActiveJob(compactJob);
  const harnessServerURL = serverURL;
  harness = await startHarness({ baseURL: harnessServerURL, viewport: "1440x1000", theme: "system" });
  try {
    const page = await harness.openPage();
    await arm(page, `[...document.querySelectorAll('[role="alert"]')].some(item=>item.textContent.includes('기록을 읽지 못했습니다'))`,
      "invalid gap source produces visible App history error");
    await settled(page);
    const state = await read(page, `({
      alert:document.querySelector('[role="alert"]')?.innerText??'',
      panels:document.querySelectorAll('.overview-panel').length,
      historyError:document.querySelector('main')?.innerText.includes('기록을 읽지 못했습니다')??false
    })`);
    const surfaced = state.historyError && state.panels === 0;
    assertion(assertions, "actual-App-surfaces-gap-source-schema-error-not-false-continuity", surfaced, state);
    actions.push({ action: "actual-App-gap-schema-negative-state", state, responseJobId: compactJob.id });
    const shot = await screenshot(page, "alternating-gap-source-rejected-1440x1000-light",
      1440, 1000, actions, persist);
    assertion(assertions, "alternating-gap-schema-error-screenshot-captured", shot.passed, shot);
  } finally {
    const cleanup = await harness.close();
    actions.push({ action: "gap-negative-harness-cleanup", ...cleanup });
    assertion(assertions, "gap-negative-owned-browser-cleanup",
      !cleanup.browserOpen && !cleanup.serverOpen && !cleanup.tempStoreExists && cleanup.cleanupErrors.length === 0,
      cleanup);
  }
}

export async function runScenario({ args, outputPath, startHarness }) {
  if (args.case !== "long-trace" || args.fixture !== "rby1-16x100000") {
    throw new Error(`Unsupported performance scenario: ${args.case}/${args.fixture}`);
  }
  const viewport = args.viewport ?? "1440x1000";
  const [width, height] = viewport.split("x").map(Number);
  if (width !== 1440 || height !== 1000 || args.theme !== "light") {
    throw new Error("Q08 requires the named 1440x1000 light viewport.");
  }
  const assertions = [], actions = [], requests = [], cursorSamples = [], results = [];
  const repositoryRoot = resolve(".");
  const sourcePaths = [
    "tests/e2e/scenarios/performance.mjs", "tests/e2e/qa.mjs", "tests/e2e/harness.mjs",
    "tests/fixtures/redesign/index.mjs", "src/contracts.ts",
    "src/client/analysis/series.ts", "src/client/analysis/render-sampling.ts",
    "src/client/analysis/exports.ts", "src/client/analysis/fk.worker.ts",
    "src/client/analysis/fk-controller.ts", "src/client/charts/TracePlot.tsx",
    "src/client/analysis/fk-protocol.ts", "src/client/analysis/fk-view.ts", "src/client/results/FKPanel.tsx",
    "src/client/results/OverviewGrid.tsx", "src/client/results/ResultWorkspace.tsx",
    "src/kinematics/worker-asset.ts",
  ];
  const readSourceHashes = async () => Object.fromEntries(await Promise.all(sourcePaths.map(async (path) => [
    path, sha256(await readFile(resolve(repositoryRoot, path))),
  ])));
  const sourceHashesBefore = await readSourceHashes();
  await mkdir(outputPath, { recursive: true });
  const persist = async (name, value) => {
    const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
    const q08File = join(outputPath, name);
    await writeFile(q08File, bytes);
    return q08File;
  };
  let activeJob = buildTraceCase("continuous");
  let stage = "build-production-worker-asset";
  const gapProfile = buildGapProfile();
  const workerBuild = await buildFkWorkerAsset();
  const workerBytes = new Uint8Array(await workerBuild.arrayBuffer());
  let admissionListener = null;
  const admission = () => new Promise((resolve, reject) => {
    const deadline = setTimeout(() => { admissionListener = null; reject(new Error("Native large-result admission deadline")); }, 180000);
    admissionListener = value => { clearTimeout(deadline); admissionListener = null; resolve(value); };
  });
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0, idleTimeout: 0, routes: { "/": index },
    async fetch(request) {
      const url = new URL(request.url);
      let response;
      if (url.pathname === "/__qa/admission") {
        const value = await request.json();
        admissionListener?.({ ...value, hostReceivedAt: performance.now() });
        response = new Response("received");
      } else if (url.pathname === "/api/jobs") response = Response.json([activeJob]);
      else if (url.pathname === `/api/jobs/${activeJob.id}`) response = Response.json(activeJob);
      else if (url.pathname === "/assets/fk.worker.js") {
        response = new Response(workerBytes, { headers: { "content-type": "text/javascript" } });
      } else if (url.pathname === "/api/kinematics/profiles") {
        const { rightChain, leftChain, ...metadata } = gapProfile;
        response = Response.json({ profiles: [metadata] });
      } else if (url.pathname === `/api/kinematics/profiles/${gapProfile.profileHash}`) {
        response = Response.json(gapProfile);
      }
      else response = new Response("Not found", { status: 404 });
      requests.push({
        method: request.method, path: url.pathname, status: response.status,
        contentType: response.headers.get("content-type"),
      });
      return response;
    },
  });
  actions.push({ action: "owned-production-App-fixture-server", url: server.url.href, port: server.port,
    fixture: args.fixture, cases: ["continuous", "spikes", "alternating-gaps"] });
  let serverStopped = false;
  try {
    stage = "verify-production-worker-http-route";
    const asset = await fetch(new URL("/assets/fk.worker.js", server.url));
    const assetBytes = new Uint8Array(await asset.arrayBuffer());
    const workerAsset = {
      status: asset.status, contentType: asset.headers.get("content-type"),
      bytes: assetBytes.length, sha256: sha256(assetBytes),
    };
    assertion(assertions, "actual-production-FK-Worker-asset-served-from-owned-App-origin",
      asset.status === 200 && asset.headers.get("content-type")?.includes("javascript")
        && assetBytes.length === workerBytes.length && workerAsset.sha256 === sha256(workerBytes),
      workerAsset);

    const continuous = activeJob;
    stage = "render-continuous-App";
    const continuousResult = await renderCase({
      kind: "continuous", job: continuous, serverURL: server.url.href, startHarness,
      width, height, actions, assertions, cursorSamples, persist, requireCursor: false,
    });
    results.push(continuousResult);

    activeJob = buildTraceCase("spikes");
    stage = "render-spike-App";
    const spikeResult = await renderCase({
      kind: "spikes", job: activeJob, serverURL: server.url.href, startHarness,
      width, height, actions, assertions, cursorSamples, persist, requireCursor: false,
    });
    results.push(spikeResult);

    activeJob = buildTraceCase("gaps");
    const gapTrace = activeJob.result.traces[0];
    const exactGapInput = Boolean(gapTrace) && gapTrace.frames.length === frameCount
      && gapTrace.frames.every((frame, index) => frame === index)
      && [gapTrace.predicted, gapTrace.target].every((path) => path.every((row, index) =>
        row.every(Number.isFinite)
        && row[0] === (index % 2 === 0 ? 0 : Math.PI / 2)
        && row[7] === (index % 2 === 0 ? 0 : Math.PI / 2)
        && row.every((value, dimension) => dimension === 0 || dimension === 7 || value === 0)));
    assertion(assertions, "gap-profile-input-is-finite-q0-alternation-for-both-arms-and-other-joints-zero",
      exactGapInput, {
        frameCount: gapTrace?.frames.length,
        firstPredicted: gapTrace?.predicted.slice(0, 4),
        firstTarget: gapTrace?.target.slice(0, 4),
        profile: { model: gapProfile.model, rightFirstAxis: gapProfile.rightChain[0].axis, leftFirstAxis: gapProfile.leftChain[0].axis },
      });
    stage = "render-alternating-FK-gap-App";
    const gapResult = await renderCase({
      kind: "gaps", job: activeJob, serverURL: server.url.href, startHarness,
      width, height, actions, assertions, cursorSamples, persist, requireCursor: true, gapProfile,
      admission, unsafeSampling: args["simulate-unsafe-sampling"] === "true",
    });
    results.push(gapResult);
    const timingValues = cursorSamples.map((sample) => sample.latencyMs).sort((left, right) => left - right);
    const p95Index = Math.ceil(timingValues.length * 0.95) - 1;
    const p95 = timingValues[p95Index];
    const machine = {
      platform: platform(), release: release(), arch: process.arch,
      hostname: hostname(), cpu: cpus()[0]?.model ?? null, logicalCpus: cpus().length,
      bunVersion: Bun.version, viewport, theme: args.theme, warmupExcluded: true,
      workerResultAdmittedBeforeCursorActions: true,
      samples: cursorSamples.length, p95Method: "nearest-rank: sorted[ceil(0.95*n)-1]",
      p95Milliseconds: p95, sortedMilliseconds: timingValues,
    };
    assertion(assertions, "exactly-30-subscribed-trusted-actions-render-shared-frame-in-all-panels",
      cursorSamples.length === 30 && cursorSamples.every((sample) => sample.passed),
      { count: cursorSamples.length, samples: cursorSamples });
    assertion(assertions, "post-warmup-integrated-input-to-rendered-state-p95-at-most-100ms",
      cursorSamples.length === 30 && Number.isFinite(p95) && p95 <= 100, machine);
    await persist("timings.json", JSON.stringify({ machine, samples: cursorSamples }, null, 2));

    stage = "probe-production-sampler-alternating-gaps";
    const gapGeometry = probeAlternatingGapGeometry();
    assertion(assertions, "100000-frame-production-sampler-alternating-gaps-remain-bounded-and-honest",
      gapGeometry.passed, gapGeometry);
    await persist("alternating-gap-sampler.json", JSON.stringify(gapGeometry, null, 2));

    stage = "show-real-App-gap-admission-error";
    await showSchemaGapRejection({
      serverURL: server.url.href, startHarness, actions, assertions, persist,
      setActiveJob: (job) => { activeJob = job; },
    });
    const fkWorkerRequests = requests.filter((request) => request.path === "/assets/fk.worker.js");
    assertion(assertions, "actual-production-App-started-the-module-FK-Worker",
      fkWorkerRequests.length >= 2 && assertions.some((item) =>
        item.name === "actual-App-Worker-admits-100000-finite-input-frames-to-12-FK-panels" && item.passed),
      fkWorkerRequests);
    const gapPassed = assertions.some((item) =>
      item.name === "alternating-singularity-gaps-render-honest-bands-with-no-false-connections" && item.passed);
    assertion(assertions, "integrated-App-alternating-derived-gaps-have-honest-bands",
      results.some((result) => result.kind === "gaps") && gapPassed,
      { profile: gapProfile.model, finiteRawTrace: true, nullableDerivedRpy: true, fkWorkerRequests });
    await persist("http.json", JSON.stringify(requests, null, 2));
    const sourceHashesAfter = await readSourceHashes();
    const sourceStable = JSON.stringify(sourceHashesBefore) === JSON.stringify(sourceHashesAfter);
    assertion(assertions, "current-source-hashes-stable-for-all-captures", sourceStable,
      { before: sourceHashesBefore, after: sourceHashesAfter });
    await persist("source-hashes.json", JSON.stringify({
      method: "SHA256 over raw UTF-8 source bytes",
      before: sourceHashesBefore, after: sourceHashesAfter, stable: sourceStable,
    }, null, 2));
    await persist("producer-assertions.json", JSON.stringify(assertions, null, 2));
    await persist("producer-actions.json", JSON.stringify(actions, null, 2));
    await persist("scenario-evidence.json", JSON.stringify({
      assertions, actions, requests, results, cursorSamples, machine, workerAsset, gapGeometry,
      source: {
        task: 20, worktree: repositoryRoot, base: "b8a07c5659561f20b455e666544bafeaa8a57db4",
        task19Gate: "confirmed/admitted", noIndependentApproval: true,
      },
    }, null, 2));
    return {
      assertions, actions,
      metadata: {
        actualProductionApp: true, frameCount, actionChannels: 16,
        cases: ["continuous", "spikes", "alternating-gaps"],
        actualWorkerAsset: workerAsset, timing: machine,
        independentApprovalClaimed: false,
      },
    };
  } catch (error) {
    const detail = error instanceof Error ? error.stack ?? error.message : String(error);
    await persist("failure.json", JSON.stringify({ stage, error: detail }, null, 2));
    throw new Error(`Task20 stage "${stage}" failed: ${detail}`);
  } finally {
    const cleanupErrors = [];
    try {
      server.stop(true);
      serverStopped = true;
    } catch (error) {
      cleanupErrors.push(`fixtureServer.stop: ${String(error)}`);
    }
    const serverEndpointClosed = await fetch(server.url.href, { signal: AbortSignal.timeout(2_000) })
      .then(() => false, () => true);
    const harnessCleanups = actions.filter((item) =>
      typeof item.browserOpen === "boolean" || typeof item.serverOpen === "boolean"
      || typeof item.tempStoreExists === "boolean");
    const cleanup = {
      serverStopped,
      serverEndpointClosed,
      browserOpen: harnessCleanups.some((item) => item.browserOpen),
      serverOpen: harnessCleanups.some((item) => item.serverOpen),
      tempStoreExists: harnessCleanups.some((item) => item.tempStoreExists),
      cleanupErrors: [...cleanupErrors, ...harnessCleanups.flatMap((item) => item.cleanupErrors ?? [])],
    };
    assertion(assertions, "all-task-owned-browser-server-and-temp-stores-closed",
      cleanup.serverStopped && cleanup.serverEndpointClosed && !cleanup.browserOpen && !cleanup.serverOpen
        && !cleanup.tempStoreExists && cleanup.cleanupErrors.length === 0,
      cleanup);
    actions.push({ action: "task20-owned-resource-cleanup", ...cleanup });
    await persist("cleanup.json", JSON.stringify(cleanup, null, 2));
    await persist("producer-assertions.json", JSON.stringify(assertions, null, 2));
    await persist("producer-actions.json", JSON.stringify(actions, null, 2));
  }
}
