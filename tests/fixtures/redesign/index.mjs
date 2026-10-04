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

function makeCoverageJob({ id, cases, horizon, interiorPadding = [] }) {
  const episodes = cases.map(({ episode, frames }) => {
    const geometricFullAnchors = Math.max(frames - horizon + 1, 0);
    const validRowsByHorizon = Array.from({ length: horizon }, (_, offset) => Math.max(frames - offset, 0));
    const validRows = validRowsByHorizon.reduce((sum, count) => sum + count, 0);
    return {
      episode,
      originalFrames: frames,
      scoredAnchors: frames,
      geometricFullAnchors,
      fullyValidChunks: geometricFullAnchors,
      geometricTailAnchors: frames - geometricFullAnchors,
      validRows,
      validRowsByHorizon,
    };
  });
  const coverage = {
    horizon,
    episodes,
    scoredAnchors: episodes.reduce((sum, item) => sum + item.scoredAnchors, 0),
    geometricFullAnchors: episodes.reduce((sum, item) => sum + item.geometricFullAnchors, 0),
    fullyValidChunks: episodes.reduce((sum, item) => sum + item.fullyValidChunks, 0),
    geometricTailAnchors: episodes.reduce((sum, item) => sum + item.geometricTailAnchors, 0),
    validRows: episodes.reduce((sum, item) => sum + item.validRows, 0),
    validRowsByHorizon: Array.from({ length: horizon }, (_, offset) =>
      episodes.reduce((sum, item) => sum + item.validRowsByHorizon[offset], 0)),
  };
  const traces = cases.map(({ episode, frames }) => ({
    episode,
    frames: Array.from({ length: frames }, (_, frame) => frame),
    predicted: Array.from({ length: frames }, () => [0]),
    target: Array.from({ length: frames }, () => [0]),
  }));
  const samples = cases.flatMap(({ episode, frames }) =>
    Array.from({ length: frames }, (_, frame) => {
      const valid = Array.from({ length: horizon }, (_, offset) =>
        frame + offset < frames && !interiorPadding.some((item) =>
          item.episode === episode && item.frame === frame && item.offset === offset));
      return {
        episode,
        frame,
        prompt: "Synthetic horizon coverage fixture",
        predicted: valid.map((isValid) => [isValid ? 0 : -1_000_000_000]),
        target: valid.map((isValid) => [isValid ? 0 : 1_000_000_000]),
        valid,
      };
    }));
  for (const padding of interiorPadding) {
    const episodeCoverage = episodes.find((item) => item.episode === padding.episode);
    if (episodeCoverage) {
      episodeCoverage.validRowsByHorizon[padding.offset] -= 1;
      episodeCoverage.validRows -= 1;
      episodeCoverage.fullyValidChunks -= 1;
      coverage.validRowsByHorizon[padding.offset] -= 1;
      coverage.validRows -= 1;
      coverage.fullyValidChunks -= 1;
    }
  }
  const result = makeResult({ names: ["action_0"], frames: [] });
  result.framesEvaluated = coverage.scoredAnchors;
  result.validSteps = coverage.validRows;
  result.perEpisode = traces.map((trace) => ({
    episode: trace.episode, framesEvaluated: trace.frames.length, mae: 0, rmse: 0,
  }));
  result.traces = traces;
  result.perDimension = [{ name: "action_0", mae: 0, rmse: 0 }];
  result.perHorizon = coverage.validRowsByHorizon.map((count, step) => ({
    step, count, mae: count ? 0 : null, rmse: count ? 0 : null,
  }));
  result.mae = 0;
  result.rmse = 0;
  result.firstStepMae = 0;
  result.firstStepRmse = 0;
  result.samples = samples;
  result.coverage = coverage;
  const job = makeJob(result, { id });
  job.request.episodes = cases.map(({ episode }) => episode);
  job.progress = { completed: coverage.scoredAnchors, total: coverage.scoredAnchors, message: "QA fixture complete" };
  return job;
}

function makeScalarPaddingJob() {
  const chunkRmse = Math.sqrt(104 / 3);
  const result = makeResult({
    names: ["action_0"],
    frames: [0, 1],
    samples: [
      {
        episode: 3, frame: 0, prompt: "Synthetic padded-horizon fixture",
        predicted: [[0], [10], [1_000_000_000]], target: [[0], [0], [0]], valid: [true, true, false],
      },
      {
        episode: 3, frame: 1, prompt: "Synthetic padded-horizon fixture",
        predicted: [[2], [1_000_000_000], [1_000_000_000]], target: [[0], [0], [0]], valid: [true, false, false],
      },
    ],
  });
  result.framesEvaluated = 2;
  result.validSteps = 3;
  result.traces = [{ episode: 3, frames: [0, 1], predicted: [[0], [2]], target: [[0], [0]] }];
  result.perEpisode = [{ episode: 3, framesEvaluated: 2, mae: 1, rmse: Math.sqrt(2) }];
  result.perDimension = [{ name: "action_0", mae: 4, rmse: chunkRmse }];
  result.perHorizon = [
    { step: 0, count: 2, mae: 1, rmse: Math.sqrt(2) },
    { step: 1, count: 1, mae: 10, rmse: 10 },
    { step: 2, count: 0, mae: null, rmse: null },
  ];
  result.mae = 4;
  result.rmse = chunkRmse;
  result.firstStepMae = 1;
  result.firstStepRmse = Math.sqrt(2);
  return makeJob(result);
}

const standard = makeResult();
const fixtureBuilders = {
  "legacy-run": () => makeJob(standard),
  "rby1-16": () => makeJob(makeResult()),
  "irregular-frames": () => makeJob(makeResult({ frames: [0, 3, 9] })),
  "scalar-padding": makeScalarPaddingJob,
  "fk-certified": () => makeJob(makeResult()),
  "rby1-16x100000": () => makeJob(makeResult({ frames: Array.from({ length: 100000 }, (_, index) => index) })),
  "malformed-and-empty": () => null,
  "generic-run": () => makeJob(makeResult({ names: ["action_0", "action_1"] })),
  "horizon-boundaries": () => makeCoverageJob({
    id: "00000000-0000-4000-8000-000000000007",
    horizon: 40,
    cases: [
      { episode: 100, frames: 100 },
      { episode: 40, frames: 40 },
      { episode: 10, frames: 10 },
      { episode: 1, frames: 1 },
    ],
  }),
  "horizon-interior-padding": () => makeCoverageJob({
    id: "00000000-0000-4000-8000-000000000008",
    horizon: 3,
    cases: [{ episode: 30, frames: 3 }],
    interiorPadding: [{ episode: 30, frame: 0, offset: 1 }],
  }),
  "horizon-multiple-episodes": () => makeCoverageJob({
    id: "00000000-0000-4000-8000-000000000009",
    horizon: 4,
    cases: [{ episode: 31, frames: 3 }, { episode: 32, frames: 2 }],
  }),
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
  const quantitativeFacts = name === "scalar-padding" ? {
    episode: 3,
    firstStepErrors: [0, 2],
    retainedChunkErrors: [[0, 10, null], [2, null, null]],
    chunkMae: 4,
    chunkRmse: Math.sqrt(104 / 3),
    firstStepMae: 1,
    firstStepRmse: Math.sqrt(2),
    validRowsByHorizon: [2, 1, 0],
  } : null;
  const horizonCases = {
    "horizon-boundaries": [
      { episode: 100, frames: 100, horizon: 40, scoredAnchors: 100, geometricFullAnchors: 61, fullyValidChunks: 61, geometricTailAnchors: 39, validRows: 3220, validRowsByHorizon: Array.from({ length: 40 }, (_, offset) => 100 - offset) },
      { episode: 40, frames: 40, horizon: 40, scoredAnchors: 40, geometricFullAnchors: 1, fullyValidChunks: 1, geometricTailAnchors: 39, validRows: 820, validRowsByHorizon: Array.from({ length: 40 }, (_, offset) => 40 - offset) },
      { episode: 10, frames: 10, horizon: 40, scoredAnchors: 10, geometricFullAnchors: 0, fullyValidChunks: 0, geometricTailAnchors: 10, validRows: 55, validRowsByHorizon: Array.from({ length: 40 }, (_, offset) => Math.max(10 - offset, 0)) },
      { episode: 1, frames: 1, horizon: 40, scoredAnchors: 1, geometricFullAnchors: 0, fullyValidChunks: 0, geometricTailAnchors: 1, validRows: 1, validRowsByHorizon: Array.from({ length: 40 }, (_, offset) => Math.max(1 - offset, 0)) },
    ],
    "horizon-interior-padding": [
      { episode: 30, frames: 3, horizon: 3, scoredAnchors: 3, validRows: 5, geometricFullAnchors: 1, fullyValidChunks: 0, validRowsByHorizon: [3, 1, 1], padding: [{ frame: 0, offset: 1 }] },
    ],
    "horizon-multiple-episodes": [
      { episode: 31, frames: 3, horizon: 4, scoredAnchors: 3, validRows: 6, validRowsByHorizon: [3, 2, 1, 0] },
      { episode: 32, frames: 2, horizon: 4, scoredAnchors: 2, validRows: 3, validRowsByHorizon: [2, 1, 0, 0] },
    ],
  }[name] ?? [];
  return {
    fixture: name,
    jobs: fixtureJobs(name),
    fkRequest: name === "fk-certified" ? fkRequest : null,
    quantitativeFacts,
    horizonCases,
  };
}

export function transportResponse(mode) {
  if (mode === "malformed-json") return new Response("{", { headers: { "content-type": "application/json" } });
  if (mode === "bare-nan") return new Response('{"invalid":NaN}', { headers: { "content-type": "application/json" } });
  if (mode === "schema-error") return Response.json({ jobs: "not-an-array" });
  throw new Error(`Unknown transport mode "${mode}"`);
}
