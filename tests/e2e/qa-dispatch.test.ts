import { copyFile, mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, test } from "bun:test";

const dispatchAPI = await import(new URL("./qa.mjs", import.meta.url).href) as {
  componentDefaults: Record<string, { entry: string; fixture: string }>;
  scenarioModules: Record<string, string>;
  parseQaArgs: (argv: string[]) => Map<string, string>;
  resolveDispatch: (args: Map<string, string>) => {
    kind: string;
    testCase: string;
    fixture?: string;
    componentEntry?: string;
    defaultedEntry?: boolean;
    modulePath?: string;
  };
};
const repoRoot = resolve(import.meta.dirname, "../..");

function args(...values: string[]) {
  return dispatchAPI.parseQaArgs(values);
}

describe("QA scenario command dispatch", () => {
  test("maps every published case to its owning scenario module", () => {
    const routes: Record<string, string[]> = {
      "tests/e2e/scenarios/profile-api.mjs": ["profile-api"],
      "tests/e2e/scenarios/lifecycle.mjs": ["lifecycle"],
      "tests/e2e/scenarios/fk.mjs": ["fk-gate", "fk-values", "fk-export"],
      "tests/e2e/scenarios/synchronize.mjs": ["synchronize", "scopes"],
      "tests/e2e/scenarios/horizons.mjs": ["horizons"],
      "tests/e2e/scenarios/performance.mjs": ["long-trace"],
      "tests/e2e/scenarios/results.mjs": ["overview", "legacy", "states", "mobile-keyboard", "functional-matrix"],
      "tests/e2e/scenarios/real-data.mjs": ["archived-live", "real-smoke", "all"],
    };
    for (const [modulePath, cases] of Object.entries(routes)) {
      for (const testCase of cases) {
        const command = args("--case", testCase, "--out", "capture");
        if (!["functional-matrix", "archived-live", "real-smoke", "all"].includes(testCase)) {
          command.set("fixture", "owner-fixture");
        }
        if (testCase === "archived-live") {
          command.set("base-url", "http://127.0.0.1:4310");
          command.set("run-id", "archived-run");
        }
        const resolved = dispatchAPI.resolveDispatch(command);
        expect(resolved).toMatchObject({ kind: "scenario", testCase, modulePath });
        expect(dispatchAPI.scenarioModules[testCase]).toBe(modulePath);
      }
    }
  });

  test("accepts fixture-less matrix and all commands plus external archive URL", () => {
    expect(dispatchAPI.resolveDispatch(args("--case", "all", "--out", "all")).kind).toBe("scenario");
    expect(dispatchAPI.resolveDispatch(args("--case", "functional-matrix", "--out", "matrix")).modulePath)
      .toBe("tests/e2e/scenarios/results.mjs");
    expect(dispatchAPI.resolveDispatch(args(
      "--case", "archived-live",
      "--base-url", "http://127.0.0.1:4310",
      "--run-id", "archived-run",
      "--out", "archive",
    )).modulePath).toBe("tests/e2e/scenarios/real-data.mjs");
    expect(() => dispatchAPI.resolveDispatch(args("--case", "archived-live", "--out", "archive")))
      .toThrow("--base-url <URL> and --run-id <id>");
  });

  test("resolves producer-owned component defaults and preserves explicit override", () => {
    const expected: Record<string, { entry: string; fixture: string }> = {
      "chart-primitive": { entry: "tests/fixtures/redesign/chart-primitive.mjs", fixture: "rby1-16" },
      "overview-component": { entry: "tests/fixtures/redesign/overview-component.mjs", fixture: "rby1-16" },
      "fk-component": { entry: "tests/fixtures/redesign/fk-component.mjs", fixture: "fk-certified" },
    };
    for (const [testCase, component] of Object.entries(expected)) {
      expect(dispatchAPI.componentDefaults[testCase]).toEqual(component);
      expect(dispatchAPI.resolveDispatch(args("--case", testCase, "--out", "component")))
        .toMatchObject({ kind: "component", fixture: component.fixture, componentEntry: component.entry, defaultedEntry: true });
      expect(dispatchAPI.resolveDispatch(args(
        "--case", testCase, "--fixture", component.fixture,
        "--component-entry", "tests/fixtures/redesign/component-mount.mjs",
        "--out", "component-override",
      )).componentEntry).toBe("tests/fixtures/redesign/component-mount.mjs");
    }
  });

  test("routes missing owner modules to explicit nonzero failures with cleanup", async () => {
    const testRoot = await mkdtemp(join(tmpdir(), "vlaeval-task32-dispatch-"));
    try {
      const isolatedRoot = join(testRoot, "missing-owner-controls");
      await createCliSandbox(isolatedRoot);
      const cases: Array<{ testCase: string; modulePath: string; extra: string[] }> = [
        { testCase: "profile-api", modulePath: "tests/e2e/scenarios/profile-api.mjs", extra: ["--fixture", "profile-root"] },
        { testCase: "lifecycle", modulePath: "tests/e2e/scenarios/lifecycle.mjs", extra: ["--fixture", "lifecycle"] },
        { testCase: "fk-gate", modulePath: "tests/e2e/scenarios/fk.mjs", extra: ["--fixture", "fk-certified"] },
        { testCase: "synchronize", modulePath: "tests/e2e/scenarios/synchronize.mjs", extra: ["--fixture", "irregular-frames"] },
        { testCase: "horizons", modulePath: "tests/e2e/scenarios/horizons.mjs", extra: ["--fixture", "horizon-boundaries"] },
        { testCase: "long-trace", modulePath: "tests/e2e/scenarios/performance.mjs", extra: ["--fixture", "rby1-16x100000"] },
        { testCase: "overview", modulePath: "tests/e2e/scenarios/results.mjs", extra: ["--fixture", "rby1-16"] },
        { testCase: "functional-matrix", modulePath: "tests/e2e/scenarios/results.mjs", extra: [] },
        { testCase: "all", modulePath: "tests/e2e/scenarios/real-data.mjs", extra: [] },
        {
          testCase: "archived-live",
          modulePath: "tests/e2e/scenarios/real-data.mjs",
          extra: ["--base-url", "http://127.0.0.1:4310", "--run-id", "archived-run"],
        },
      ];
      for (const [index, item] of cases.entries()) {
        const output = join(testRoot, `case-${index}`);
        const result = await runCli([
          "--case", item.testCase, ...item.extra, "--out", output,
        ], 15_000, isolatedRoot);
        expect(result.exitCode).toBe(1);
        expect(result.stdout + result.stderr).toContain(`Scenario module for "${item.testCase}" is not implemented: ${item.modulePath}`);
        const cleanup = JSON.parse(await Bun.file(join(output, "cleanup.json")).text());
        expect(cleanup).toEqual({
          browserOpen: false,
          serverOpen: false,
          tempStoreExists: false,
          cleanupErrors: [],
        });
      }
    } finally {
      await rm(testRoot, { recursive: true, force: true });
    }
  });

  test("missing default component entry stays isolated while present controls succeed", async () => {
    const testRoot = await mkdtemp(join(tmpdir(), "vlaeval-task32-component-"));
    try {
      const isolatedRoot = join(testRoot, "missing-default-controls");
      await createCliSandbox(isolatedRoot);
      for (const [index, [testCase, component]] of Object.entries(dispatchAPI.componentDefaults).entries()) {
        const expectedEntry = component.entry;
        const output = join(testRoot, `output-${index}`);
        const result = await runCli(["--case", testCase, "--out", output], 15_000, isolatedRoot);
        expect(result.exitCode).toBe(1);
        expect(result.stdout + result.stderr).toContain(`Default component entry is missing: ${expectedEntry}`);
        expect(JSON.parse(await Bun.file(join(output, "cleanup.json")).text())).toEqual({
          browserOpen: false,
          serverOpen: false,
          tempStoreExists: false,
          cleanupErrors: [],
        });
      }

      const presentRoot = join(testRoot, "present-controls");
      await createCliSandbox(presentRoot);
      await mkdir(join(presentRoot, "tests/e2e/scenarios"), { recursive: true });
      await writeFile(join(presentRoot, "tests/e2e/scenarios/profile-api.mjs"), [
        "export async function runScenario(context) {",
        "  return { assertions: [{ name: 'isolated-present-owner-control', passed: context.args.case === 'profile-api' && context.args.fixture === 'profile-root', detail: 'test-owned positive dispatch control' }] };",
        "}",
        "",
      ].join("\n"));
      await writeFile(join(presentRoot, "tests/fixtures/redesign/chart-primitive.mjs"),
        `export { mount } from ${JSON.stringify(join(repoRoot, "tests/fixtures/redesign/component-mount.mjs"))};\n`);

      const ownerOutput = join(testRoot, "present-owner-output");
      const ownerResult = await runCli(["--case", "profile-api", "--fixture", "profile-root", "--out", ownerOutput], 15_000, presentRoot);
      expect(ownerResult.exitCode).toBe(0);
      expect(JSON.parse(await Bun.file(join(ownerOutput, "assertions.json")).text()))
        .toContainEqual(expect.objectContaining({ name: "isolated-present-owner-control", passed: true }));
      expect(JSON.parse(await Bun.file(join(ownerOutput, "cleanup.json")).text())).toEqual({
        browserOpen: false,
        serverOpen: false,
        tempStoreExists: false,
        cleanupErrors: [],
      });

      const componentOutput = join(testRoot, "present-component-output");
      const componentResult = await runCli(["--case", "chart-primitive", "--theme", "light", "--out", componentOutput], 15_000, presentRoot);
      if (componentResult.exitCode !== 0) {
        throw new Error(`Present component control failed with exit ${componentResult.exitCode}\n${componentResult.stdout}\n${componentResult.stderr}`);
      }
      expect(componentResult.exitCode).toBe(0);
      expect(JSON.parse(await Bun.file(join(componentOutput, "assertions.json")).text()))
        .toContainEqual(expect.objectContaining({ name: "production-section-component-mounted", passed: true }));
      expect(JSON.parse(await Bun.file(join(componentOutput, "cleanup.json")).text())).toMatchObject({
        browserOpen: false,
        serverOpen: false,
        tempStoreExists: false,
        cleanupErrors: [],
      });
    } finally {
      await rm(testRoot, { recursive: true, force: true });
    }
  }, 15_000);

  test("component mount must finish with nonempty assertions before success", async () => {
    const evidenceRoot = resolve(repoRoot, ".omo/evidence/redesign/task-36/producer");
    await mkdir(evidenceRoot, { recursive: true });
    const testRoot = await mkdtemp(join(evidenceRoot, "mount-test-"));
    try {
      const entry = join(testRoot, "pending-mount.mjs");
      const output = join(testRoot, "output");
      await writeFile(entry, [
        "export async function mount(element) {",
        "  element.textContent = 'Visible before asynchronous assertion completion';",
        "  await new Promise(() => {});",
        "  return [{ name: 'never-completes', passed: true }];",
        "}",
        "",
      ].join("\n"));
      const result = await runCli([
        "--case", "component-mount",
        "--fixture", "legacy-run",
        "--component-entry", entry,
        "--out", output,
      ], 20_000);
      expect(result.exitCode).toBe(1);
      expect(result.stdout + result.stderr).toContain("component mount assertions timed out");
      const cleanup = JSON.parse(await Bun.file(join(output, "cleanup.json")).text());
      expect(cleanup).toMatchObject({
        browserOpen: false,
        serverOpen: false,
        tempStoreExists: false,
        cleanupErrors: [],
      });
      const report = JSON.parse(await Bun.file(join(output, "stdout.log")).text());
      expect(report.assertions).toEqual([]);
      expect(report.error).toContain("component mount assertions timed out");
      const emptyEntry = join(testRoot, "empty-mount.mjs");
      const emptyOutput = join(testRoot, "empty-output");
      await writeFile(emptyEntry, [
        "export async function mount(element) {",
        "  element.textContent = 'Mount completed without assertions';",
        "  return [];",
        "}",
        "",
      ].join("\n"));
      const emptyResult = await runCli([
        "--case", "component-mount",
        "--fixture", "legacy-run",
        "--component-entry", emptyEntry,
        "--out", emptyOutput,
      ]);
      expect(emptyResult.exitCode).toBe(1);
      expect(emptyResult.stdout + emptyResult.stderr).toContain("Component mount must return a nonempty array of machine-readable assertions");
      expect(JSON.parse(await Bun.file(join(emptyOutput, "cleanup.json")).text())).toMatchObject({
        browserOpen: false,
        serverOpen: false,
        tempStoreExists: false,
        cleanupErrors: [],
      });
    } finally {
      await rm(testRoot, { recursive: true, force: true });
    }
  }, 20_000);
});

async function createCliSandbox(sandboxRoot: string) {
  await mkdir(join(sandboxRoot, "tests/e2e"), { recursive: true });
  await mkdir(join(sandboxRoot, "tests/fixtures/redesign"), { recursive: true });
  await copyFile(join(repoRoot, "tests/e2e/qa.mjs"), join(sandboxRoot, "tests/e2e/qa.mjs"));
  await copyFile(join(repoRoot, "tests/e2e/harness.mjs"), join(sandboxRoot, "tests/e2e/harness.mjs"));
  await symlink(join(repoRoot, "index.html"), join(sandboxRoot, "index.html"));
  await symlink(join(repoRoot, "src"), join(sandboxRoot, "src"), "dir");
  await symlink(join(repoRoot, "node_modules"), join(sandboxRoot, "node_modules"), "dir");
  await symlink(
    join(repoRoot, "tests/fixtures/redesign/index.mjs"),
    join(sandboxRoot, "tests/fixtures/redesign/index.mjs"),
  );
}

async function runCli(args: string[], timeoutMs = 15_000, cwd = repoRoot) {
  const child = Bun.spawn(["bun", "tests/e2e/qa.mjs", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = new Response(child.stdout).text();
  const stderr = new Response(child.stderr).text();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const exitCode = await Promise.race([
    child.exited,
    new Promise<number>((_, reject) => {
      timeout = setTimeout(() => {
        child.kill();
        reject(new Error(`QA command exceeded ${timeoutMs}ms: ${args.join(" ")}`));
      }, timeoutMs);
    }),
  ]).finally(() => {
    if (timeout) clearTimeout(timeout);
  });
  return { exitCode, stdout: await stdout, stderr: await stderr };
}
