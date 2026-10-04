import { access, mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { startHarness } from "./harness.mjs";

export const componentDefaults = Object.freeze({
  "chart-primitive": {
    entry: "tests/fixtures/redesign/chart-primitive.mjs",
    fixture: "rby1-16",
  },
  "overview-component": {
    entry: "tests/fixtures/redesign/overview-component.mjs",
    fixture: "rby1-16",
  },
  "fk-component": {
    entry: "tests/fixtures/redesign/fk-component.mjs",
    fixture: "fk-certified",
  },
});

export const scenarioModules = Object.freeze({
  "profile-api": "tests/e2e/scenarios/profile-api.mjs",
  lifecycle: "tests/e2e/scenarios/lifecycle.mjs",
  "fk-gate": "tests/e2e/scenarios/fk.mjs",
  "fk-values": "tests/e2e/scenarios/fk.mjs",
  "fk-export": "tests/e2e/scenarios/fk.mjs",
  synchronize: "tests/e2e/scenarios/synchronize.mjs",
  scopes: "tests/e2e/scenarios/synchronize.mjs",
  horizons: "tests/e2e/scenarios/horizons.mjs",
  "long-trace": "tests/e2e/scenarios/performance.mjs",
  overview: "tests/e2e/scenarios/results.mjs",
  legacy: "tests/e2e/scenarios/results.mjs",
  states: "tests/e2e/scenarios/results.mjs",
  "mobile-keyboard": "tests/e2e/scenarios/results.mjs",
  "functional-matrix": "tests/e2e/scenarios/results.mjs",
  "archived-live": "tests/e2e/scenarios/real-data.mjs",
  "real-smoke": "tests/e2e/scenarios/real-data.mjs",
  all: "tests/e2e/scenarios/real-data.mjs",
});

const componentCases = new Set(["component-mount", ...Object.keys(componentDefaults)]);
const builtinCases = new Set([
  "harness-smoke",
  "harness-intentional-failure",
  "primitives-existing",
  "transport-smoke",
  "fixture-contract",
]);
const fixtureOptionalCases = new Set(["functional-matrix", "archived-live", "real-smoke", "all"]);
const supportedCases = new Set([
  ...builtinCases,
  ...componentCases,
  ...Object.keys(scenarioModules),
]);

export function parseQaArgs(argv) {
  const args = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!key?.startsWith("--")) throw new Error(`Unexpected argument "${key}"`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${key}`);
    args.set(key.slice(2), value);
    index += 1;
  }
  return args;
}

export function resolveDispatch(args) {
  const testCase = args.get("case");
  if (!testCase) throw new Error("Usage: bun tests/e2e/qa.mjs --case <name> --out <directory>");
  if (!args.has("out")) throw new Error("Missing required --out <directory>");
  if (!supportedCases.has(testCase)) {
    throw new Error(`Unimplemented case "${testCase}". Implement its scenario before invoking it.`);
  }
  const component = componentDefaults[testCase];
  const fixture = args.get("fixture") ?? component?.fixture;
  if (!fixture && !fixtureOptionalCases.has(testCase)) {
    throw new Error(`Case "${testCase}" requires --fixture <name>.`);
  }
  const theme = args.get("theme") ?? "system";
  if (!["system", "light", "dark"].includes(theme)) {
    throw new Error(`Unsupported theme "${theme}"; expected system, light, or dark.`);
  }
  if (testCase === "transport-smoke" && !args.has("transport")) {
    throw new Error("transport-smoke requires --transport malformed-json|bare-nan|schema-error");
  }
  if (testCase === "archived-live" && (!args.has("base-url") || !args.has("run-id"))) {
    throw new Error("archived-live requires --base-url <URL> and --run-id <id>.");
  }
  if (testCase === "component-mount" && !args.has("component-entry")) {
    throw new Error("component-mount requires --component-entry <worktree module>.");
  }

  if (component || componentCases.has(testCase)) {
    return {
      kind: "component",
      testCase,
      fixture: fixture ?? component?.fixture,
      componentEntry: args.get("component-entry") ?? component?.entry,
      defaultedEntry: !args.has("component-entry"),
    };
  }
  if (scenarioModules[testCase]) {
    return { kind: "scenario", testCase, modulePath: scenarioModules[testCase] };
  }
  return { kind: "builtin", testCase };
}

function recordAssertion(assertions, name, passed, detail) {
  assertions.push({ name, passed, detail });
  if (!passed) throw new Error(`Assertion failed: ${name}: ${detail}`);
}

async function trustedClick(page, selector) {
  const clickId = `qa-click-${trustedClick.sequence += 1}`;
  const target = JSON.parse(await page.evaluate(`JSON.stringify((()=>{const selector=${JSON.stringify(selector)};const clickId=${JSON.stringify(clickId)};const element=document.querySelector(selector);if(!element)throw new Error("Missing interaction target: "+selector);element.scrollIntoView({behavior:"instant",block:"center",inline:"center"});const rect=element.getBoundingClientRect();const x=rect.left+rect.width/2;const y=rect.top+rect.height/2;const visible=rect.width>0&&rect.height>0&&rect.right>0&&rect.bottom>0&&rect.left<innerWidth&&rect.top<innerHeight;if(!visible)throw new Error("Interaction target is outside the viewport after scrolling: "+JSON.stringify({selector,rect:{x:rect.x,y:rect.y,width:rect.width,height:rect.height},viewport:{width:innerWidth,height:innerHeight}}));const hit=document.elementFromPoint(x,y);if(!hit||(hit!==element&&!element.contains(hit)))throw new Error("Interaction target failed center hit testing: "+JSON.stringify({selector,hit:hit?.outerHTML??null}));window.__VLAEVAL_QA_LAST_TRUSTED_CLICK__=null;element.addEventListener("click",event=>{window.__VLAEVAL_QA_LAST_TRUSTED_CLICK__={clickId,selector,isTrusted:event.isTrusted,currentTargetMatches:event.currentTarget===element}},{once:true});return {x,y,text:element.innerText,selector,clickId,hitTarget:hit.tagName}})())`));
  await page.cdp("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x: target.x,
    y: target.y,
    button: "left",
    clickCount: 1,
  });
  await page.cdp("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x: target.x,
    y: target.y,
    button: "left",
    clickCount: 1,
  });
  const event = JSON.parse(await page.evaluate("JSON.stringify(window.__VLAEVAL_QA_LAST_TRUSTED_CLICK__ ?? null)"));
  if (
    event?.clickId !== clickId
    || event.selector !== selector
    || event.isTrusted !== true
    || event.currentTargetMatches !== true
  ) {
    throw new Error(`Trusted click was not attributed to the current target: ${JSON.stringify({ expectedClickId: clickId, selector, event })}`);
  }
  return { ...target, event };
}
trustedClick.sequence = 0;

function validateScenarioAssertions(assertions) {
  if (!Array.isArray(assertions) || assertions.length === 0) {
    throw new Error("Scenario module must return a nonempty assertions array.");
  }
  for (const assertion of assertions) {
    if (
      !assertion
      || typeof assertion.name !== "string"
      || assertion.name.trim().length === 0
      || typeof assertion.passed !== "boolean"
    ) {
      throw new Error("Scenario assertions must contain {name: nonempty string, passed: boolean, detail?}.");
    }
  }
}

function combineCleanup(cleanups) {
  return {
    browserOpen: cleanups.some((cleanup) => cleanup.browserOpen),
    serverOpen: cleanups.some((cleanup) => cleanup.serverOpen),
    tempStoreExists: cleanups.some((cleanup) => cleanup.tempStoreExists),
    cleanupErrors: cleanups.flatMap((cleanup) => cleanup.cleanupErrors),
  };
}

export async function runQA(argv = process.argv.slice(2)) {
  const args = parseQaArgs(argv);
  const dispatch = resolveDispatch(args);
  const output = resolve(args.get("out"));
  await mkdir(output, { recursive: true });
  const viewport = args.get("viewport") ?? "1440x1000";
  const theme = args.get("theme") ?? "system";
  const componentProps = args.has("component-props") ? JSON.parse(args.get("component-props")) : {};
  const actions = [];
  const assertions = [];
  const ownedHarnesses = [];
  let failure;
  let cleanup = { browserOpen: false, serverOpen: false, tempStoreExists: false, cleanupErrors: [] };

  const createHarness = async (options = {}) => {
    const harness = await startHarness({
      fixture: dispatch.fixture ?? args.get("fixture"),
      transport: args.get("transport"),
      viewport,
      theme,
      ...(args.has("base-url") ? { baseURL: args.get("base-url") } : {}),
      ...options,
    });
    ownedHarnesses.push(harness);
    return harness;
  };

  try {
    if (dispatch.kind === "scenario") {
      const repoRoot = resolve(import.meta.dirname, "../..");
      const modulePath = resolve(repoRoot, dispatch.modulePath);
      try {
        await access(modulePath);
      } catch {
        throw new Error(`Scenario module for "${dispatch.testCase}" is not implemented: ${dispatch.modulePath}`);
      }
      const scenario = await import(pathToFileURL(modulePath).href);
      if (typeof scenario.runScenario !== "function") {
        throw new Error(`Scenario module "${dispatch.modulePath}" must export runScenario(context).`);
      }
      const result = await scenario.runScenario({
        args: Object.fromEntries(args),
        outputPath: output,
        startHarness: createHarness,
      });
      validateScenarioAssertions(result?.assertions);
      for (const assertion of result.assertions) {
        assertions.push(assertion);
      }
      actions.push(...(Array.isArray(result.actions) ? result.actions : []));
      if (assertions.some((assertion) => !assertion.passed)) {
        throw new Error(`Scenario "${dispatch.testCase}" returned one or more failed assertions.`);
      }
    } else {
      let harness;
      if (dispatch.kind === "component") {
        const repoRoot = resolve(import.meta.dirname, "../..");
        const componentEntry = resolve(repoRoot, dispatch.componentEntry);
        try {
          await access(componentEntry);
        } catch {
          throw new Error(`Default component entry is missing: ${dispatch.componentEntry}`);
        }
        harness = await createHarness({ componentEntry });
      } else {
        harness = await createHarness();
      }
      actions.push({ action: "server-start", url: harness.url, fixture: dispatch.fixture ?? args.get("fixture") ?? null });
      const page = await harness.openPage({
        mount: dispatch.kind === "component",
        componentProps,
      });
      actions.push({
        action: "browser-navigate",
        url: dispatch.kind === "component" ? `${harness.url}__qa/mount` : harness.url,
      });

      const themeState = await page.evaluate("JSON.stringify({requested:document.documentElement.dataset.theme,colorScheme:getComputedStyle(document.documentElement).colorScheme,bodyBackground:getComputedStyle(document.body).backgroundColor})");
      const parsedThemeState = JSON.parse(themeState);
      recordAssertion(
        assertions,
        "requested-theme-applied",
        theme === "system" || parsedThemeState.requested === theme,
        JSON.stringify(parsedThemeState),
      );
      const body = await page.evaluate("document.body.innerText");
      if (dispatch.kind === "component") {
        const downstream = await page.evaluate("JSON.stringify(window.__VLAEVAL_QA_ASSERTIONS__ ?? null)");
        if (downstream === "null") throw new Error("Component mount completed without machine-readable assertions.");
        const evidence = JSON.parse(downstream);
        validateScenarioAssertions(evidence);
        for (const assertion of evidence) {
          recordAssertion(assertions, assertion.name, assertion.passed, assertion.detail ?? "");
        }
        recordAssertion(assertions, "component-root-rendered", body.trim().length > 0, body.slice(0, 500));
      } else if (dispatch.testCase === "harness-intentional-failure") {
        recordAssertion(assertions, "intentional-failure", false, "Requested deliberate assertion failure to prove finally cleanup.");
      } else if (dispatch.testCase === "transport-smoke") {
        recordAssertion(assertions, "transport-error-rendered", body.includes("요청을 완료하지 못했습니다"), body.slice(0, 1000));
        recordAssertion(assertions, "transport-does-not-render-fixture", !body.includes("qa_fixture"), "Deliberate invalid transport is distinct from valid fixture data.");
      } else if (dispatch.testCase === "fixture-contract") {
        const payload = JSON.parse(await page.evaluate(`fetch("/__qa/fixtures/${dispatch.fixture}").then((response)=>{if(!response.ok)throw new Error("Fixture request failed: "+response.status);return response.json()}).then(JSON.stringify)`));
        recordAssertion(assertions, "fixture-job-is-schema-valid", payload.jobs[0]?.result?.actionNames?.length === 16, `job count ${payload.jobs.length}; action count ${payload.jobs[0]?.result?.actionNames?.length}`);
        recordAssertion(assertions, "fk-provenance-is-complete", payload.fkRequest?.profile?.rootLink === "link_torso_5" && payload.fkRequest.profile.tips.right === "ee_right" && payload.fkRequest.jointMapping.length === 14, "Captured compiled profile, user declaration and full joint mapping.");
      } else {
        recordAssertion(assertions, "production-react-entry-rendered", body.includes("에피소드 평가"), body.slice(0, 1000));
        recordAssertion(assertions, "fixture-history-rendered", body.includes("qa_fixture"), "Rendered app contains deterministic fixture result.");
        if (dispatch.testCase === "primitives-existing") {
          recordAssertion(assertions, "production-fields-mounted", body.includes("대상 호스트"), "Existing application preparation field is present.");
          const resultsTarget = await trustedClick(page, 'nav a[href="#results"]');
          const resultsState = await page.evaluate("location.hash");
          recordAssertion(assertions, "trusted-results-navigation-click", resultsState === "#results" && resultsTarget.event.isTrusted, JSON.stringify({ hash: resultsState, target: resultsTarget }));
          actions.push({ action: "trusted-click", selector: 'nav a[href="#results"]', target: resultsTarget });
          const historyTarget = await trustedClick(page, 'nav a[href="#history"]');
          const historyState = await page.evaluate("location.hash");
          recordAssertion(assertions, "trusted-history-navigation-click", historyState === "#history" && historyTarget.event.isTrusted, JSON.stringify({ hash: historyState, target: historyTarget }));
          actions.push({ action: "trusted-click", selector: 'nav a[href="#history"]', target: historyTarget });
          const rowTarget = await trustedClick(page, ".history-row");
          const selectionState = JSON.parse(await page.evaluate("JSON.stringify({selected:document.querySelector('.history-row')?.getAttribute('aria-pressed'),resultVisible:document.querySelector('#results')?.innerText.includes('qa_fixture')})"));
          recordAssertion(assertions, "trusted-history-result-selection", selectionState.selected === "true" && selectionState.resultVisible && rowTarget.event.isTrusted, JSON.stringify({ ...selectionState, target: rowTarget }));
          actions.push({ action: "trusted-click", selector: ".history-row", target: rowTarget });
        }
      }
      const screenshot = await page.screenshot();
      await Bun.write(`${output}/page.png`, screenshot);
      actions.push({ action: "screenshot", path: `${output}/page.png` });
    }
  } catch (error) {
    failure = error instanceof Error ? error : new Error(String(error));
  } finally {
    const cleanups = await Promise.all(ownedHarnesses.map((harness) => harness.close()));
    cleanup = combineCleanup(cleanups);
    actions.push({ action: "http-responses", responses: ownedHarnesses.flatMap((harness) => harness.requests) });
    actions.push({ action: "cleanup", ...cleanup });
    await writeFile(`${output}/actions.json`, `${JSON.stringify(actions, null, 2)}\n`);
    await writeFile(`${output}/assertions.json`, `${JSON.stringify(assertions, null, 2)}\n`);
    await writeFile(`${output}/cleanup.json`, `${JSON.stringify(cleanup, null, 2)}\n`);
  }

  const cleanupPassed = !cleanup.browserOpen && !cleanup.serverOpen && !cleanup.tempStoreExists && cleanup.cleanupErrors.length === 0;
  if (!cleanupPassed) failure ??= new Error(`Owned resource cleanup failed: ${JSON.stringify(cleanup)}`);
  const report = {
    case: dispatch.testCase,
    fixture: dispatch.fixture ?? args.get("fixture") ?? null,
    output,
    assertions,
    cleanup,
    error: failure?.message ?? null,
  };
  await writeFile(`${output}/stdout.log`, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
  if (failure) {
    console.error(failure.stack ?? failure.message);
    return 1;
  }
  return 0;
}

if (import.meta.main) {
  try {
    process.exitCode = await runQA();
  } catch (error) {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exitCode = 1;
  }
}
