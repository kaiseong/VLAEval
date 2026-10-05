import { expect, test } from "bun:test";
import { resultFixture } from "../result-fixture";
import { fkResultSchema, type FkResult } from "../../src/kinematics/contracts";
import {
  fkCsvExport,
  fkJsonExport,
  rawJsonExport,
  rawTraceCsv,
  type FkExportRequest,
} from "../../src/client/analysis/exports";

const jobId = "c9a7752e-74ba-4052-9ec1-ecbc8306d975";
const profileHash = "a".repeat(64);
const convention = {
  kind: "nominal_sign_zero",
  nominalSignZeroConfirmed: true,
  source: "user_declared",
} as const;

function completedFk(): FkResult {
  const pose = {
    translationM: [0.1, 0.2, 0.3],
    quaternionXyzw: [0, 0, 0, 1],
    rpyDeg: [0, 0, 0],
  } as const;
  const arm = {
    pose: { predicted: pose, target: pose },
    errors: { translationM: 0, orientationRad: 0 },
    valid: true,
    reasons: [],
  } as const;
  const names = [
    ...Array.from({ length: 7 }, (_, index) => `right_arm_${index}`),
    ...Array.from({ length: 7 }, (_, index) => `left_arm_${index}`),
    "right_gripper_0", "left_gripper_0",
  ];
  return fkResultSchema.parse({
    schemaVersion: 1,
    jobId,
    episode: 3,
    profileHash,
    jointUnit: "rad",
    representation: "absolute_joint_position",
    convention,
    generation: 4,
    profile: {
      model: "RBY1A",
      revision: "v1.2",
      urdfSha256: "b".repeat(64),
      rootLink: "link_torso_5",
      tips: { right: "ee_right", left: "ee_left" },
    },
    actionNames: names,
    jointMapping: names.slice(0, 14).map((name, sourceIndex) => ({
      jointName: name, channelName: name, sourceIndex,
    })),
    samples: [
      {
        frame: 2,
        source: { predicted: Array(16).fill(0), target: Array(16).fill(0) },
        arms: { right: arm, left: arm },
      },
      {
        frame: 9,
        source: { predicted: Array(16).fill(1), target: Array(16).fill(0) },
        arms: {
          right: { ...arm, valid: false, reasons: ["predicted:nonfinite"], errors: { translationM: null, orientationRad: null },
            pose: { predicted: { translationM: null, quaternionXyzw: null, rpyDeg: [null, null, null] }, target: pose } },
          left: arm,
        },
      },
    ],
    summaries: {
      right: {
        translationM: { mean: 0, rms: 0, count: 1 },
        orientationRad: { mean: 0, rms: 0, count: 1 },
      },
      left: {
        translationM: { mean: 0, rms: 0, count: 2 },
        orientationRad: { mean: 0, rms: 0, count: 2 },
      },
    },
  });
}

function exportRequest(completed: unknown = completedFk()): FkExportRequest {
  return {
    completed,
    identity: {
      schemaVersion: 1, jobId, episode: 3, profileHash, jointUnit: "rad",
      representation: "absolute_joint_position", convention, generation: 4,
    },
    context: {
      sourceJobId: jobId,
      sourceEpisode: 3,
      profile: {
        profileHash,
        sourcePath: "/profiles/rby1a.urdf",
        model: "RBY1A",
        revision: "v1.2",
        urdfSha256: "b".repeat(64),
        rootLink: "link_torso_5",
        tips: { right: "ee_right", left: "ee_left" },
      },
    },
  };
}

function parseCsv(input: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let index = input.startsWith("\ufeff") ? 1 : 0; index < input.length; index += 1) {
    const character = input[index];
    if (character === '"') {
      if (quoted && input[index + 1] === '"') {
        cell += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (character === "," && !quoted) {
      row.push(cell);
      cell = "";
    } else if (character === "\r" && input[index + 1] === "\n" && !quoted) {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
      index += 1;
    } else {
      cell += character;
    }
  }
  row.push(cell);
  rows.push(row);
  return rows;
}

test("raw JSON and all-frame CSV retain the original export semantics", () => {
  const original = structuredClone(resultFixture);
  const expectedRows = [
    "episode,frame,time_seconds,dimension,action,predicted,target,error",
    '"3","0","0","0","right_arm_0","0.1","0","0.1"',
    '"3","0","0","1","left_arm_0","0.9","1","-0.09999999999999998"',
    '"3","1","0.03333333333333333","0","right_arm_0","0.6","0.5","0.09999999999999998"',
    '"3","1","0.03333333333333333","1","left_arm_0","0.4","0.5","-0.09999999999999998"',
    '"3","2","0.06666666666666667","0","right_arm_0","1.1","1","0.10000000000000009"',
    '"3","2","0.06666666666666667","1","left_arm_0","-0.1","0","-0.1"',
  ];

  expect(JSON.parse(rawJsonExport(resultFixture))).toEqual(original);
  expect(rawTraceCsv(resultFixture)).toBe(`\ufeff${expectedRows.join("\r\n")}`);
  expect(resultFixture).toEqual(original);
});

test("FK JSON and CSV identify the source and retain full nullable samples", () => {
  const before = structuredClone(resultFixture);
  const request = exportRequest();
  const json = fkJsonExport(request);
  const csv = fkCsvExport(request);

  expect(json?.filename).toBe(`vlaeval-${jobId}-ep3.fk.json`);
  expect(csv?.filename).toBe(`vlaeval-${jobId}-ep3.fk.csv`);
  const document = JSON.parse(json?.content ?? "null") as {
    readonly schemaVersion: number;
    readonly source: { readonly jobId: string; readonly episode: number; readonly frames: readonly number[] };
    readonly profile: { readonly profileHash: string; readonly model: string; readonly revision: string; readonly urdfSha256: string; readonly rootLink: string; readonly tips: unknown; readonly sourcePath: string };
    readonly declaration: { readonly sourceUnits: unknown; readonly jointMapping: readonly { readonly sourceIndex: number }[] };
    readonly validPairCounts: { readonly right: { readonly translation: number } };
    readonly samples: readonly { readonly frame: number; readonly arms: { readonly right: { readonly valid: boolean; readonly reasons: readonly string[]; readonly pose: { readonly predicted: { readonly translationM: unknown } } } } }[];
  };
  expect(document.schemaVersion).toBe(1);
  expect(document.source).toEqual({ jobId, episode: 3, frames: [2, 9] });
  expect(document.profile).toEqual({
    profileHash, model: "RBY1A", revision: "v1.2", urdfSha256: "b".repeat(64),
    rootLink: "link_torso_5", tips: { right: "ee_right", left: "ee_left" },
    sourcePath: "/profiles/rby1a.urdf",
  });
  expect(document.declaration.sourceUnits).toEqual({
    translation: "m", orientation: "quaternion_xyzw", displayPosition: "mm",
    displayOrientation: "deg",
  });
  expect(document.declaration.jointMapping).toHaveLength(14);
  expect(document.validPairCounts.right.translation).toBe(1);
  expect(document.samples[1]?.arms.right).toMatchObject({
    valid: false, reasons: ["predicted:nonfinite"], pose: { predicted: { translationM: null } },
  });
  expect(csv?.content).toContain('"2"');
  expect(csv?.content).toContain('"9"');
  expect(csv?.content).toContain('"predicted:nonfinite"');
  expect(csv?.content).toContain('"right"');
  expect(csv?.content).toContain('"left"');
  expect(resultFixture).toEqual(before);
});

test("missing, stale, mismatched, and unsupported FK refuse only derived exports", () => {
  const request = exportRequest();
  const staleGeneration = { ...completedFk(), generation: 3 };
  const wrongSource = { ...completedFk(), jobId: "b5d8a67b-014f-4c8d-b017-12f76f0e7d4f" };
  const unsupportedSchema = { ...completedFk(), schemaVersion: 2 };

  expect(fkJsonExport(exportRequest(null))).toBeNull();
  expect(fkCsvExport(exportRequest({ ...completedFk(), generation: 3 }))).toBeNull();
  expect(fkJsonExport(exportRequest(staleGeneration))).toBeNull();
  expect(fkCsvExport(exportRequest(wrongSource))).toBeNull();
  expect(fkJsonExport(exportRequest(unsupportedSchema))).toBeNull();
  expect(rawJsonExport(resultFixture)).toBe(JSON.stringify(resultFixture, null, 2));
  expect(rawTraceCsv(resultFixture)).toContain('"3","2"');
});

test("FK derivation must match the requested and source profile identity", () => {
  const request = exportRequest();

  expect(fkJsonExport({
    ...request,
    context: { ...request.context, sourceEpisode: 2 },
  })).toBeNull();
  expect(fkCsvExport({
    ...request,
    context: { ...request.context, profile: { ...request.context.profile, profileHash: "c".repeat(64) } },
  })).toBeNull();
});

test("FK CSV parsed rows include schema and distinct per-arm valid-pair counts", () => {
  const result = completedFk();
  const rows = parseCsv(fkCsvExport(exportRequest(result))?.content ?? "");
  const header = rows[0] ?? [];
  const column = (name: string) => header.indexOf(name);

  expect(header[column("schema_version")]).toBe("schema_version");
  expect(rows.slice(1).every((row) => row[column("schema_version")] === "1")).toBe(true);
  expect(rows.slice(1).filter((row) => row[column("side")] === "right").every((row) =>
    row[column("right_translation_valid_pair_count")] === "1" &&
    row[column("right_orientation_valid_pair_count")] === "1")).toBe(true);
  expect(rows.slice(1).filter((row) => row[column("side")] === "left").every((row) =>
    row[column("left_translation_valid_pair_count")] === "2" &&
    row[column("left_orientation_valid_pair_count")] === "2")).toBe(true);
  expect(rows.slice(1).map((row) => row[column("frame")])).toEqual(["2", "2", "9", "9"]);
});

test("FK CSV parsed rows represent zero valid pairs without fabricated values", () => {
  const result = completedFk();
  for (const sample of result.samples) {
    for (const side of ["right", "left"] as const) {
      sample.arms[side] = {
        valid: false,
        reasons: ["pair:invalid"],
        pose: {
          predicted: { translationM: null, quaternionXyzw: null, rpyDeg: [null, null, null] },
          target: { translationM: null, quaternionXyzw: null, rpyDeg: [null, null, null] },
        },
        errors: { translationM: null, orientationRad: null },
      };
    }
  }
  result.summaries.right.translationM = { mean: null, rms: null, count: 0 };
  result.summaries.right.orientationRad = { mean: null, rms: null, count: 0 };
  result.summaries.left.translationM = { mean: null, rms: null, count: 0 };
  result.summaries.left.orientationRad = { mean: null, rms: null, count: 0 };
  const rows = parseCsv(fkCsvExport(exportRequest(result))?.content ?? "");
  const header = rows[0] ?? [];
  const column = (name: string) => header.indexOf(name);

  expect(rows.slice(1).every((row) => row[column("schema_version")] === "1")).toBe(true);
  expect(rows.slice(1).every((row) =>
    row[column("right_translation_valid_pair_count")] === "0" &&
    row[column("right_orientation_valid_pair_count")] === "0" &&
    row[column("left_translation_valid_pair_count")] === "0" &&
    row[column("left_orientation_valid_pair_count")] === "0")).toBe(true);
  expect(rows.slice(1).every((row) =>
    row[column("valid")] === "false" &&
    row[column("reasons")] === "pair:invalid" &&
    row[column("predicted_translation_m")] === "null" &&
    row[column("target_translation_m")] === "null" &&
    row[column("translation_error_m")] === "" &&
    row[column("orientation_error_rad")] === "")).toBe(true);
});
