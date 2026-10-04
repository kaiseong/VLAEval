import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { startHarness } from "./harness.mjs";

const componentCases = new Set(["component-mount", "chart-primitive", "overview-component", "fk-component"]);
const supportedCases = new Set(["harness-smoke", "harness-intentional-failure", "primitives-existing", "transport-smoke", "fixture-contract", ...componentCases]);
const args = new Map();
for (let index = 2; index < process.argv.length; index += 1) {
  const key = process.argv[index];
  if (!key?.startsWith("--")) throw new Error(`Unexpected argument "${key}"`);
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`Missing value for ${key}`);
  args.set(key.slice(2), value);
  index += 1;
}

const testCase = args.get("case");
const fixture = args.get("fixture");
const outputPath = args.get("out");
if (!testCase || !fixture || !outputPath) {
  throw new Error("Usage: bun tests/e2e/qa.mjs --case <name> --fixture <name> --out <directory>");
}
if (!supportedCases.has(testCase)) {
  throw new Error(`Unimplemented case "${testCase}". Implement its scenario before invoking it.`);
}
if (componentCases.has(testCase) && !args.has("component-entry")) {
  throw new Error(`${testCase} requires --component-entry <worktree module>`);
}
if (testCase === "transport-smoke" && !args.has("transport")) {
  throw new Error("transport-smoke requires --transport malformed-json|bare-nan|schema-error");
}

const output = resolve(outputPath);
await mkdir(output, { recursive: true });
const viewport = args.get("viewport") ?? "1440x1000";
const componentProps = args.has("component-props") ? JSON.parse(args.get("component-props")) : {};
const actions = [];
const assertions = [];
let harness;
let page;
let failure;
let cleanup;

function recordAssertion(name, passed, detail) {
  assertions.push({ name, passed, detail });
  if (!passed) throw new Error(`Assertion failed: ${name}: ${detail}`);
}

try {
  harness = await startHarness({
    fixture,
    transport: args.get("transport"),
    componentEntry: args.get("component-entry"),
    viewport,
  });
  actions.push({ action: "server-start", url: harness.url, fixture });
  page = await harness.openPage({ mount: componentCases.has(testCase), componentProps });
  actions.push({ action: "browser-navigate", url: componentCases.has(testCase) ? `${harness.url}__qa/mount` : harness.url });
  const body = await page.evaluate("document.body.innerText");
  const screenshot = await page.screenshot();
  await Bun.write(`${output}/page.png`, screenshot);
  actions.push({ action: "screenshot", path: `${output}/page.png` });

  if (testCase === "harness-intentional-failure") {
    recordAssertion("intentional-failure", false, "Requested deliberate assertion failure to prove finally cleanup.");
  } else if (componentCases.has(testCase)) {
    recordAssertion("component-root-rendered", body.trim().length > 0, body.slice(0, 500));
    const downstream = await page.evaluate("JSON.stringify(window.__VLAEVAL_QA_ASSERTIONS__ ?? null)");
    if (downstream !== "null") {
      const evidence = JSON.parse(downstream);
      if (!Array.isArray(evidence)) throw new Error("Component mount must return an array of {name, passed, detail} assertions");
      for (const assertion of evidence) {
        recordAssertion(assertion.name, assertion.passed === true, assertion.detail ?? "");
      }
    }
  } else if (testCase === "transport-smoke") {
    recordAssertion("transport-error-rendered", body.includes("요청을 완료하지 못했습니다"), body.slice(0, 1000));
    recordAssertion("transport-does-not-render-fixture", !body.includes("qa_fixture"), "Deliberate invalid transport is distinct from valid fixture data.");
  } else if (testCase === "fixture-contract") {
    const payload = JSON.parse(await page.evaluate(`fetch("/__qa/fixtures/${fixture}").then((response)=>{if(!response.ok)throw new Error("Fixture request failed: "+response.status);return response.json()}).then(JSON.stringify)`));
    recordAssertion("fixture-job-is-schema-valid", payload.jobs[0]?.result?.actionNames?.length === 16, `job count ${payload.jobs.length}; action count ${payload.jobs[0]?.result?.actionNames?.length}`);
    recordAssertion("fk-provenance-is-complete", payload.fkRequest?.profile?.rootLink === "link_torso_5" && payload.fkRequest.profile.tips.right === "ee_right" && payload.fkRequest.jointMapping.length === 14, "Captured compiled profile, user declaration and full joint mapping.");
  } else {
    recordAssertion("production-react-entry-rendered", body.includes("에피소드 평가"), body.slice(0, 1000));
    recordAssertion("fixture-history-rendered", body.includes("qa_fixture"), "Rendered app contains deterministic fixture result.");
  }
  if (testCase === "primitives-existing") {
    recordAssertion("production-fields-mounted", body.includes("대상 호스트"), "Existing application preparation field is present.");
  }
} catch (error) {
  failure = error instanceof Error ? error : new Error(String(error));
} finally {
  cleanup = harness
    ? await harness.close()
    : { browserOpen: false, serverOpen: false, tempStoreExists: false, cleanupErrors: [] };
  actions.push({ action: "http-responses", responses: harness?.requests ?? [] });
  actions.push({ action: "cleanup", ...cleanup });
  await writeFile(`${output}/actions.json`, `${JSON.stringify(actions, null, 2)}\n`);
  await writeFile(`${output}/assertions.json`, `${JSON.stringify(assertions, null, 2)}\n`);
  await writeFile(`${output}/cleanup.json`, `${JSON.stringify(cleanup, null, 2)}\n`);
}

const cleanupPassed = !cleanup.browserOpen && !cleanup.serverOpen && !cleanup.tempStoreExists && cleanup.cleanupErrors.length === 0;
if (!cleanupPassed) failure ??= new Error(`Owned resource cleanup failed: ${JSON.stringify(cleanup)}`);
const report = { case: testCase, fixture, output, assertions, cleanup, error: failure?.message ?? null };
await writeFile(`${output}/stdout.log`, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));
if (failure) {
  console.error(failure.stack ?? failure.message);
  process.exitCode = 1;
}
