import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { deriveFkOverview, fkOverviewDataSchema, fkOverviewInputSchema } from "../src/client/analysis/fk-overview";
import { fkRequestSchema, type CompiledProfile, type FkRequest, type FkResult } from "../src/kinematics/contracts";
import { deriveForward } from "../src/kinematics/forward";
import { buildFkOverviewWorkerAsset } from "../src/kinematics/worker-asset";

function fixture() {
  const chain = (side: "left" | "right"): CompiledProfile["leftChain"] => [
    ...Array.from({ length: 7 }, (_, i): CompiledProfile["leftChain"][number] => ({
      name: `${side}_arm_${i}`, type: "revolute", axis: i === 1 ? [0, 1, 0] : [0, 0, 1],
      parentLink: i === 0 ? "link_torso_5" : `link_${side}_arm_${i - 1}`,
      childLink: `link_${side}_arm_${i}`, origin: { xyz: [0, 0, 0], rpy: [0, 0, 0] },
    })),
    { name: `tool_${side}`, type: "fixed", parentLink: `link_${side}_arm_6`,
      childLink: `ee_${side}`, origin: { xyz: side === "left" ? [0.1, 0.2, 0.3] : [0.4, 0.5, 0.6], rpy: [0, 0, 0] } },
  ];
  const actionNames = [
    ...Array.from({ length: 7 }, (_, i) => `right_arm_${i}`),
    ...Array.from({ length: 7 }, (_, i) => `left_arm_${i}`), "right_gripper_0", "left_gripper_0",
  ];
  const request: FkRequest = fkRequestSchema.parse({
    schemaVersion: 1, jobId: "c9a7752e-74ba-4052-9ec1-ecbc8306d975", episode: 4,
    profileHash: "a".repeat(64), generation: 12, jointUnit: "rad", representation: "absolute_joint_position",
    convention: { kind: "nominal_sign_zero", nominalSignZeroConfirmed: true, source: "user_declared" },
    profile: { schemaVersion: 1, profileHash: "a".repeat(64), sourcePath: "/synthetic.urdf",
      urdfSha256: "b".repeat(64), model: "synthetic", revision: "test", rootLink: "link_torso_5",
      tips: { right: "ee_right", left: "ee_left" }, rightChain: chain("right"), leftChain: chain("left") },
    actionNames, jointMapping: actionNames.slice(0, 14).map((name, sourceIndex) => ({
      jointName: name, channelName: name, sourceIndex,
    })),
    frames: [3, 11].map((frame, i) => ({
      frame, predicted: actionNames.map((_, j) => j < 14 ? (i + 1) * (j + 1) / 100 : 20 + j),
      target: actionNames.map((_, j) => j < 14 ? -(i + 1) * (j + 1) / 200 : 50 + j),
    })),
  });
  return {
    request, fps: 29.97,
    chunks: [3, 17, 80].map((frame, i) => ({
      frame,
      predicted: Array.from({ length: i + 1 }, (_, step) => actionNames.map((_, j) => j < 14 ? (step + 1) * (j + 1) / 20 : step + j)),
      target: Array.from({ length: i + 1 }, (_, step) => actionNames.map((_, j) => j < 14 ? -(step + 1) * (j + 1) / 30 : 90 + step + j)),
      valid: Array.from({ length: i + 1 }, (_, step) => step !== 1),
    })),
  };
}

function trustedRows(request: FkRequest, result: FkResult, source: "predicted" | "target") {
  return result.samples.map((sample) => (["left", "right"] as const).flatMap((side) => {
    const pose = sample.arms[side].pose[source];
    return [
      ...[0, 1, 2].map((axis) => {
        const value = pose.translationM?.[axis];
        return value === undefined || !Number.isFinite(value * 1000) ? null : value * 1000;
      }),
      ...pose.rpyDeg,
      sample.source[source][request.actionNames.indexOf(`${side}_gripper_0`)] ?? null,
    ];
  }));
}

describe("FK overview", () => {
  test("matches trusted FK for the trace and every chunk while retaining source identity", () => {
    // Given distinct trace/chunk rows, anchors, masks and native grippers.
    const input = fixture(), original = structuredClone(input);
    const trusted = deriveForward(input.request);
    // When deriving the overview.
    const output = deriveFkOverview(input);
    // Then the complete first-step projection and every chunk match independent FK calls.
    expect(output.series).toEqual({
      frames: [3, 11], fps: 29.97,
      predicted: trustedRows(input.request, trusted, "predicted"),
      target: trustedRows(input.request, trusted, "target"),
    });
    input.chunks.forEach((chunk, index) => {
      const derived = deriveForward({ ...input.request, frames: chunk.predicted.map((predicted, row) => ({
        frame: row, predicted, target: chunk.target[row],
      })) });
      const mask = (rows: (number | null)[][]) => rows.map((row, i) =>
        row.map((value, channel) => chunk.valid[i] || channel === 6 || channel === 13 ? value : null));
      expect(output.chunks[index]).toEqual({
        frame: chunk.frame, valid: chunk.valid,
        predicted: mask(trustedRows(input.request, derived, "predicted")),
        target: mask(trustedRows(input.request, derived, "target")),
      });
    });
    expect(input).toEqual(original);
    expect(fkOverviewDataSchema.safeParse(output).success).toBe(true);
  });

  test("keeps the same output when both action names and joint mappings are permuted", () => {
    // Given grippers at the front and right-arm joints at original gripper indices.
    const input = fixture(), names = input.request.actionNames;
    const order = [14, 15, ...Array.from({ length: 12 }, (_, i) => 13 - i), 0, 1];
    const actionNames = order.map((i) => names[i]);
    const reorder = (row: number[]) => order.map((i) => row[i]);
    const changed = {
      ...input,
      request: {
        ...input.request, actionNames,
        jointMapping: [...input.request.jointMapping].reverse().map((m) => ({
          ...m, sourceIndex: actionNames.indexOf(m.channelName),
        })),
        frames: input.request.frames.map((row) => ({ ...row, predicted: reorder(row.predicted), target: reorder(row.target) })),
      },
      chunks: input.chunks.map((chunk) => ({ ...chunk, predicted: chunk.predicted.map(reorder), target: chunk.target.map(reorder) })),
    };
    // When deriving the permuted input.
    const output = deriveFkOverview(changed);
    // Then channel semantics, grippers, and chunk rows are unchanged.
    expect(output).toEqual(deriveFkOverview(input));
  });

  test("converts degree joints once without converting native grippers", () => {
    // Given equivalent degree commands and unchanged native gripper values.
    const input = fixture();
    const degrees = (row: number[]) => row.map((value, index) => index < 14 ? value * 180 / Math.PI : value);
    const changed = {
      ...input,
      request: { ...input.request, jointUnit: "deg",
        frames: input.request.frames.map((row) => ({ ...row, predicted: degrees(row.predicted), target: degrees(row.target) })) },
      chunks: input.chunks.map((chunk) => ({ ...chunk, predicted: chunk.predicted.map(degrees), target: chunk.target.map(degrees) })),
    };
    // When deriving equivalent radian and degree inputs.
    const output = deriveFkOverview(changed), reference = deriveFkOverview(input);
    // Then each available value agrees without rounding native grippers.
    const rows = [output.series, ...output.chunks], expected = [reference.series, ...reference.chunks];
    rows.forEach((group, i) => {
      for (const source of ["predicted", "target"] as const) group[source].forEach((row, j) => row.forEach((value, k) => {
        const ref = expected[i]?.[source][j]?.[k];
        if (value === null) expect(ref).toBeNull();
        else { expect(typeof ref).toBe("number"); expect(value).toBeCloseTo(ref ?? NaN, 10); }
      }));
    });
  });

  test("preserves singular Euler components rather than inventing zeros", () => {
    // Given left pitch at its fixed-axis singularity, with distinct grippers.
    const input = fixture();
    const row = input.request.actionNames.map((name) => name === "left_arm_1" ? Math.PI / 2
      : name === "left_gripper_0" ? 7 : name === "right_gripper_0" ? 9 : 0);
    input.request.frames = [{ frame: 42, predicted: row, target: row }];
    input.chunks = [{ frame: 42, predicted: [row, row], target: [row, row], valid: [true, false] }];
    // When deriving the singular and masked rows.
    const output = deriveFkOverview(input);
    // Then translation/pitch/grippers survive, and unavailable arm channels stay null.
    expect(output.series.predicted[0]?.slice(3, 7)).toEqual([null, 90, null, 7]);
    expect(output.series.predicted[0]?.slice(7)).toEqual([400, 500, 600, 0, -0, 0, 9]);
    expect(output.chunks[0]?.predicted[0]).toEqual(output.series.predicted[0]);
    expect(output.chunks[0]?.predicted[1]).toEqual([...Array(6).fill(null), 7, ...Array(6).fill(null), 9]);
    expect(output.chunks[0]?.target[1]).toEqual(output.chunks[0]?.predicted[1]);
  });

  test("retains null failed poses independently of the other arm and source", () => {
    // Given an overflowing right predicted pose but a finite right target and left arm.
    const input = fixture();
    input.request.profile.rightChain = input.request.profile.rightChain.map((joint, i) => ({
      ...joint, origin: { ...joint.origin, xyz: i === 0 || i === 7 ? [1e308, 0, 0] : [0, 0, 0] },
    }));
    const predicted = Array<number>(16).fill(0), target = [Math.PI, ...Array<number>(15).fill(0)];
    input.request.frames = [{ frame: 0, predicted, target }];
    input.chunks = [{ frame: 19, predicted: [predicted], target: [target], valid: [true] }];
    // When deriving the admitted numerical failure.
    const output = deriveFkOverview(input);
    // Then only unavailable pose components are null, not the valid opposite arm.
    expect(output.series.predicted[0]?.slice(7, 13)).toEqual(Array(6).fill(null));
    expect(output.series.predicted[0]?.slice(0, 3)).toEqual([100, 200, 300]);
    expect(output.series.target[0]?.[11]).toBe(-0);
    expect(output.chunks[0]?.predicted[0]).toEqual(output.series.predicted[0]);
    expect(fkOverviewDataSchema.safeParse(output).success).toBe(true);
  });

  test("returns empty dimensions when trace and chunks are empty", () => {
    // Given an admitted empty trace and stored empty chunk.
    const input = fixture();
    input.request.frames = [];
    input.chunks = [{ frame: 27, predicted: [], target: [], valid: [] }];
    // When deriving the overview.
    const output = deriveFkOverview(input);
    // Then empty source identity is retained.
    expect(output).toEqual({
      series: { frames: [], predicted: [], target: [], fps: 29.97 }, chunks: input.chunks,
    });
  });

  test("rejects malformed admission, nonfinite input, and inconsistent chunk masks", () => {
    // Given invalid units, stale identity, missing mappings, invalid fps and malformed raw chunks.
    const input = fixture();
    const chunk = input.chunks[0];
    const invalid = [
      ...[0, -1, Infinity, NaN].map((fps) => ({ ...input, fps })),
      { ...input, request: { ...input.request, profileHash: "c".repeat(64) } },
      { ...input, request: { ...input.request, jointUnit: "native" } },
      { ...input, request: { ...input.request, jointMapping: [] } },
      { ...input, chunks: [{ ...chunk, valid: [] }] },
      { ...input, chunks: [{ ...chunk, target: [] }] },
      { ...input, chunks: [{ ...chunk, predicted: [Array(14).fill(0)] }] },
      { ...input, chunks: [{ ...chunk, predicted: [Array(16).fill(NaN)] }] },
      { ...input, chunks: [{ ...chunk, frame: -1 }] },
    ];
    // When crossing the public parse/derive boundary.
    // Then malformed inputs fail instead of returning partial output.
    for (const value of invalid) {
      expect(fkOverviewInputSchema.safeParse(value).success).toBe(false);
      expect(() => deriveFkOverview(value)).toThrow();
    }
    const output = deriveFkOverview(input);
    expect(fkOverviewDataSchema.safeParse({ ...output, series: { ...output.series, predicted: [[0]] } }).success).toBe(false);
  });
});

const replySchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("ready"), data: fkOverviewDataSchema }),
  z.object({ kind: z.literal("error"), reason: z.string() }),
]);

for (const invalid of [false, true]) test(`built browser Worker posts ${invalid ? "error" : "ready"} for one input`, async () => {
  // Given the actual browser bundle in a dedicated Worker and registered bounded events.
  const asset = await buildFkOverviewWorkerAsset();
  const url = URL.createObjectURL(asset);
  const worker = new Worker(url, { type: "module" });
  try {
    const reply = new Promise<unknown>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Worker reply deadline")), 5000);
      worker.onmessage = (event: MessageEvent<unknown>) => { clearTimeout(timeout); resolve(event.data); };
      worker.onerror = (event) => { clearTimeout(timeout); reject(new Error(event.message)); };
    });
    const input = invalid ? { fps: 0 } : fixture();
    // When posting a single input after subscribing.
    worker.postMessage(input);
    const output = replySchema.parse(await reply);
    // Then the Worker posts the public contract, not scientific export data.
    if (invalid) { expect(output.kind).toBe("error"); }
    else {
      expect(output.kind).toBe("ready");
      if (output.kind === "ready") expect(output.data).toEqual(deriveFkOverview(input));
    }
  } finally { worker.terminate(); URL.revokeObjectURL(url); }
}, 10000);
