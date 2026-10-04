import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { jobSchema } from "../src/contracts";
import { Results } from "../src/client/Results";
import { Field, Section } from "../src/client/ui/primitives";
import { resultFixture } from "./result-fixture";

test("shared presentation primitives preserve field labels and section structure", () => {
  const field = createElement(Field, {
    label: "데이터셋 경로",
    hint: "절대 경로",
    children: createElement("input", { value: "/data/run", readOnly: true }),
  });
  const markup = renderToStaticMarkup(createElement(Section, {
    title: "데이터셋",
    subtitle: "에피소드 메타데이터",
    number: "02",
    id: "dataset",
    children: field,
  }));

  expect(markup).toMatch(/<section class="panel" id="dataset">/);
  expect(markup).toMatch(/<header class="section-heading">[\s\S]*<span class="step-number">02<\/span>/);
  expect(markup).toMatch(/<label class="field"><span>[^<]+<\/span><input\b[^>]*><small>[^<]+<\/small><\/label>/);
});

test("result section renders through the shared primitive imports", () => {
  const job = jobSchema.parse({
    id: "b8191bcd-4cf1-418c-a3d9-5c94deed4045",
    status: "completed",
    createdAt: "2026-10-04T00:00:00Z",
    request: {
      host: "rtx6000@192.168.0.3",
      repo: "/models/openpi",
      config: "test",
      checkpoint: "/models/100",
      dataset: "/data/test",
      episodes: [3],
    },
    progress: { completed: 1, total: 1, message: "done" },
    logs: [],
    result: resultFixture,
    error: null,
  });
  const markup = renderToStaticMarkup(createElement(Results, { job }));

  expect(markup).toContain('class="result-stack"');
  expect(markup).toMatch(/<label class="field"><span>[^<]+<\/span><select\b/);
  expect(markup).toContain("0.1");
});

test("shared primitive and result entries do not include App", async () => {
  const build = await Bun.build({
    entrypoints: ["src/client/ui/primitives.tsx", "src/client/Results.tsx"],
    target: "browser",
    metafile: true,
  });
  expect(build.success).toBe(true);
  const inputs = Object.keys(build.metafile?.inputs ?? {});

  expect(inputs.some((path) => path.endsWith("/src/client/App.tsx"))).toBe(false);
});
