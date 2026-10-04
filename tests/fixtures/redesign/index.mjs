import { fkRequestSchema } from "../../../src/kinematics/contracts";

const actionNames = Array.from({ length: 16 }, (_, index) => {
  if (index === 14) return "right_gripper_0";
  if (index === 15) return "left_gripper_0";
  return index < 7 ? `right_arm_${index}` : `left_arm_${index - 7}`;
});
const profileHash = "a".repeat(64);
const chain = (side) => [...Array.from({ length: 7 }, (_, index) => ({
  name: `${side}_arm_${index}`,
  type: "revolute",
  parentLink: index === 0 ? "link_torso_5" : `link_${side}_arm_${index - 1}`,
  childLink: `link_${side}_arm_${index}`,
  origin: { xyz: [0, 0, 0], rpy: [0, 0, 0] },
  axis: [0, 0, 1],
})), {
  name: `tool_${side}`, type: "fixed", parentLink: `link_${side}_arm_6`, childLink: `ee_${side}`,
  origin: { xyz: [0, 0, -0.1261], rpy: [0, 0, 0] },
}];
const fkRequest = fkRequestSchema.parse({
  schemaVersion: 1,
  jobId: "00000000-0000-4000-8000-000000000006",
  episode: 3,
  profileHash,
  jointUnit: "rad",
  representation: "absolute_joint_position",
  convention: { kind: "nominal_sign_zero", nominalSignZeroConfirmed: true, source: "user_declared" },
  generation: 1,
  profile: {
    schemaVersion: 1,
    profileHash,
    sourcePath: "/qa/rby1.urdf",
    model: "synthetic-rby1",
    revision: "fixture-revision",
    urdfSha256: "b".repeat(64),
    rootLink: "link_torso_5",
    tips: { right: "ee_right", left: "ee_left" },
    rightChain: chain("right"),
    leftChain: chain("left"),
  },
  actionNames,
  jointMapping: actionNames.slice(0, 14).map((channelName, sourceIndex) => ({
    jointName: channelName,
    channelName,
    sourceIndex,
  })),
  frames: [0, 1, 2].map((frame) => ({
    frame,
    predicted: Array.from({ length: 16 }, (_, index) => (frame * 0.01 + index * 0.1) + 0.1),
    target: Array.from({ length: 16 }, (_, index) => frame * 0.01 + index * 0.1),
  })),
});

function makeResult({ frames = [0, 1, 2], names = actionNames, samples } = {}) {
  const values = frames.map((frame) => names.map((_, dimension) => frame * 0.01 + dimension * 0.1));
  return {
    config: "qa_fixture",
    checkpoint: "/qa/checkpoint",
    dataset: "/qa/dataset",
    seed: 0,
    numSteps: 10,
    framesEvaluated: frames.length,
    validSteps: frames.length,
    actionNames: names,
    fps: 30,
    perEpisode: [{ episode: 3, framesEvaluated: frames.length, mae: 0.1, rmse: 0.1 }],
    traces: [{ episode: 3, frames, predicted: values.map((row) => row.map((value) => value + 0.1)), target: values }],
    perDimension: names.map((name) => ({ name, mae: 0.1, rmse: 0.1 })),
    perHorizon: [{ step: 0, count: frames.length, mae: 0.1, rmse: 0.1 }],
    mae: 0.1,
    rmse: 0.1,
    firstStepMae: 0.1,
    firstStepRmse: 0.1,
    latencyMs: { median: 20, p95: 22 },
    samples: samples ?? [{
      episode: 3,
      frame: frames[0] ?? 0,
      prompt: "Synthetic QA fixture, not a trained model result",
      predicted: [[...((values[0] ?? []).map((value) => value + 0.1))]],
      target: [[...(values[0] ?? [])]],
      valid: [true],
    }],
    warnings: ["Synthetic QA fixture. Not an actual model evaluation."],
  };
}

function makeJob(result, { id = "00000000-0000-4000-8000-000000000006", status = "completed" } = {}) {
  return {
    id,
    status,
    createdAt: "2026-10-04T00:00:00.000Z",
    request: {
      host: "qa@localhost",
      repo: "/qa/repository",
      config: "qa_fixture",
      checkpoint: "/qa/checkpoint",
      dataset: "/qa/dataset",
      episodes: [3],
      maxSamples: 0,
      stride: 1,
      seed: 0,
      numSteps: 10,
    },
    progress: { completed: 3, total: 3, message: "QA fixture complete" },
    logs: ["QA fixture; no model was run."],
    result,
    error: null,
  };
}

const standard = makeResult();
const fixtureBuilders = {
  "legacy-run": () => makeJob(standard),
  "rby1-16": () => makeJob(makeResult()),
  "irregular-frames": () => makeJob(makeResult({ frames: [0, 3, 9] })),
  "scalar-padding": () => makeJob(makeResult({
    names: ["action_0"],
    frames: [0, 1, 2],
    samples: [{
      episode: 3,
      frame: 0,
      prompt: "Synthetic padded-horizon fixture",
      predicted: [[0], [10], [1_000_000_000]],
      target: [[0], [0], [1_000_000_000]],
      valid: [true, true, false],
    }],
  })),
  "fk-certified": () => makeJob(makeResult()),
  "rby1-16x100000": () => makeJob(makeResult({ frames: Array.from({ length: 100000 }, (_, index) => index) })),
  "malformed-and-empty": () => null,
  "generic-run": () => makeJob(makeResult({ names: ["action_0", "action_1"] })),
  "horizon-boundaries": () => makeJob(makeResult()),
  lifecycle: () => makeJob(null, { status: "running" }),
};

export const fixtureNames = Object.freeze(Object.keys(fixtureBuilders));

export function fixtureJob(name) {
  const build = fixtureBuilders[name];
  if (!build) throw new Error(`Unknown fixture "${name}". Available: ${fixtureNames.join(", ")}`);
  const job = build();
  if (!job) throw new Error(`Fixture "${name}" has no job record`);
  return job;
}

export function fixtureJobs(name) {
  const build = fixtureBuilders[name];
  if (!build) throw new Error(`Unknown fixture "${name}". Available: ${fixtureNames.join(", ")}`);
  const job = build();
  return job ? [job] : [];
}

export function fixtureSnapshot(name) {
  return {
    fixture: name,
    jobs: fixtureJobs(name),
    fkRequest: name === "fk-certified" ? fkRequest : null,
    horizonCases: name === "horizon-boundaries" ? [
      { frames: 100, horizon: 40, scoredAnchors: 100, validRows: 3220 },
      { frames: 40, horizon: 40, scoredAnchors: 40, validRows: 820 },
      { frames: 10, horizon: 40, scoredAnchors: 10, validRows: 55 },
      { frames: 1, horizon: 40, scoredAnchors: 1, validRows: 1 },
    ] : [],
  };
}

export function transportResponse(mode) {
  if (mode === "malformed-json") return new Response("{", { headers: { "content-type": "application/json" } });
  if (mode === "bare-nan") return new Response('{"invalid":NaN}', { headers: { "content-type": "application/json" } });
  if (mode === "schema-error") return Response.json({ jobs: "not-an-array" });
  throw new Error(`Unknown transport mode "${mode}"`);
}
