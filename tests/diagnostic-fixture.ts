import { createHash } from "node:crypto";
import { deflateSync } from "node:zlib";
import { diagnosticPacketSchema } from "../src/diagnostic-contracts";
import { evaluationFixture } from "./evaluation-fixture";

function pngChunk(type: string, data: Buffer) {
  const body = Buffer.concat([Buffer.from(type), data]);
  let crc = 0xffffffff;
  for (const byte of body) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? 0xedb88320 ^ crc >>> 1 : crc >>> 1;
  }
  const chunk = Buffer.alloc(data.length + 12);
  chunk.writeUInt32BE(data.length, 0); body.copy(chunk, 4); chunk.writeUInt32BE((crc ^ 0xffffffff) >>> 0, chunk.length - 4);
  return chunk;
}

/** Clearly synthetic RGB scene, never a recorded camera frame. */
export function diagnosticTestImage(width = 64, height = 48) {
  const raw = Buffer.alloc(height * (1 + width * 3));
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const offset = y * (1 + width * 3) + 1 + x * 3;
    const color = x > 20 && x < 42 && y > 13 && y < 33 ? [190, 150, 70]
      : y > 32 ? [70, 86, 92] : [22, 38, 43];
    raw[offset] = color[0] ?? 0; raw[offset + 1] = color[1] ?? 0; raw[offset + 2] = color[2] ?? 0;
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", header), pngChunk("IDAT", deflateSync(raw)), pngChunk("IEND", Buffer.alloc(0))]);
}

export function halfProbabilities(values: readonly number[]) {
  const data = Buffer.alloc(values.length * 2);
  values.forEach((value, i) => {
    if (value === 0) return;
    let exponent = Math.floor(Math.log2(value));
    let fraction = Math.round((value / 2 ** exponent - 1) * 1024);
    if (fraction === 1024) { exponent++; fraction = 0; }
    const bits = exponent < -14 ? Math.round(value / 2 ** -24) : (exponent + 15) * 1024 + fraction;
    data.writeUInt16LE(bits, i * 2);
  });
  return data.toString("base64");
}

export function diagnosticFixture() {
  const job = evaluationFixture(910);
  if (!job.result) throw new Error("Fixture requires result");
  const row = (frame: number, target = false) => [
    -0.15 + frame * 0.01, frame * 0.025 + (target ? 0.01 : 0), 1, 0, 0, 0, 1,
    0.15 - frame * 0.01, frame * 0.02, 1, 0, 0, 0, 1,
  ];
  job.request.numSteps = 2; job.request.episodes = [3];
  job.result = {
    ...job.result, numSteps: 2, framesEvaluated: 2, validSteps: 8,
    actionNames: ["left_x", "left_y", "left_z", "left_rx", "left_ry", "left_rz", "left_gripper",
      "right_x", "right_y", "right_z", "right_rx", "right_ry", "right_rz", "right_gripper"],
    traces: [{ episode: 3, frames: [0, 1], predicted: [row(0), row(1)], target: [row(0, true), row(1, true)] }],
    samples: [0, 1].map((frame) => ({ episode: 3, frame, prompt: "Synthetic diagnostic fixture",
      predicted: [0, 1, 2, 3].map((h) => row(frame + h)), target: [0, 1, 2, 3].map((h) => row(frame + h, true)),
      valid: [true, true, true, true] })),
    perHorizon: [0, 1, 2, 3].map((step) => ({ step, count: 2, mae: 0, mse: 0, rmse: 0 })),
    perEpisode: [{ episode: 3, framesEvaluated: 2, mae: 0, mse: 0, rmse: 0 }],
    warnings: ["Synthetic fixture; not a trained model evaluation."],
  };
  const image = diagnosticTestImage(), digest = createHash("sha256").update(image).digest("hex");
  const groups = [{ id: "early", horizonIndices: [0, 1], queryRows: [0, 1] },
    { id: "late", horizonIndices: [2, 3], queryRows: [2, 3] }];
  const packet = diagnosticPacketSchema.parse({
    schemaVersion: 1,
    identity: { jobId: job.id, episode: 3, frame: 0, dataset: job.result.dataset, config: job.result.config,
      checkpoint: job.result.checkpoint, seed: job.result.seed, numSteps: 2 },
    provenance: { kind: "synthetic", adapterRevision: "qa-v1", backend: "none", dtype: "float32", compiled: false,
      inputDigest: digest, noiseDigest: null },
    images: [{ role: "front", datasetKey: "observation.images.front", modelKey: "base_0_rgb",
      width: 64, height: 48, timestampSeconds: 0, sha256: digest, mime: "image/png", dataBase64: image.toString("base64"),
      preprocessing: { inputWidth: 64, inputHeight: 64, sourceToInput: [1, 0, 0, 1, 0, 8], contentRect: [0, 8, 64, 48] } }],
    attention: {
      kind: "action_to_image", layers: [0, 1, 2], steps: [{ index: 0, flowTime: 1 }, { index: 1, flowTime: 0.5 }],
      headReduction: "mean", headCount: 2, horizon: 4, queryGroups: groups, keyCount: 24,
      keyGroups: [
        { id: "front", kind: "image", modelKey: "base_0_rgb", keyIndices: Array.from({ length: 16 }, (_, i) => i) },
        { id: "text", kind: "instruction", keyIndices: [16, 17] }, { id: "state", kind: "state", keyIndices: [18] },
        { id: "action", kind: "action", keyIndices: [19, 20, 21, 22] }, { id: "special", kind: "special", keyIndices: [23] },
      ],
      cameras: [{ modelKey: "base_0_rgb", gridWidth: 4, gridHeight: 4, patchKeyIndices: Array.from({ length: 16 }, (_, i) => i) }],
      slices: [0, 1].flatMap((stepIndex) => [0, 1, 2].flatMap((layer) => groups.map((group) => {
        const hotspot = group.id === "early" ? 5 : 10;
        const peak = 0.125 + (stepIndex + layer) * 0.0625;
        return { stepIndex, layer, queryGroup: group.id,
          masses: [{ groupId: "front", value: 0.5 }, { groupId: "text", value: 0.2 }, { groupId: "state", value: 0.05 },
            { groupId: "action", value: 0.2 }, { groupId: "special", value: 0.05 }],
          maps: [{ modelKey: "base_0_rgb", valuesF16LE: halfProbabilities(Array.from({ length: 16 },
            (_, i) => i === hotspot ? peak : (0.5 - peak) / 15)) }],
          sinkCandidates: [{ keyIndex: 16, label: "Synthetic instruction token", mass: 0.15 }],
        };
      }))),
      sinkMethod: "Synthetic candidate for contract validation; no inferred meaning.",
    },
    projection: { modelKey: "base_0_rgb", referenceFrame: "link_torso_5", calibrationId: "synthetic-pinhole",
      calibrationHash: "a".repeat(64), poseEvidence: { kind: "declared_fixed", description: "Synthetic fixed optical camera." },
      assumption: "anchor_reference_fixed", profileHash: null,
      source: { kind: "cartesian", positionUnit: "m", orientation: { kind: "rpy_xyz", unit: "rad" },
        referenceFrame: "link_torso_5", representation: "absolute", nominalSignZeroConfirmed: true,
        left: { position: [0, 1, 2], rotation: [3, 4, 5], gripper: 6 },
        right: { position: [7, 8, 9], rotation: [10, 11, 12], gripper: 13 } },
      camera: { width: 64, height: 48, fx: 80, fy: 80, cx: 32, cy: 24, distortion: { kind: "none" },
        cameraFromReference: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] } },
    actionDifferences: [{ channel: "left_x", unit: "m", maxAbsolute: 0.000001, atol: 0.00001, rtol: 0.0001, exceededCount: 0 }],
    timing: { compileMs: null, warmupMs: null, inferenceMs: null, extractionMs: null, peakGpuBytes: null },
  });
  return { job, packet };
}
