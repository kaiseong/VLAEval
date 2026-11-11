import { expect, test } from "bun:test";
import { diagnosticPacketSchema } from "../../src/diagnostic-contracts";
import { attentionDisplayScale, attentionDisplayIntensity, patchHasImage, sharedImageMaximum, decodeHalfMap, decodeAttentionMap, inverseImageTransform, selectAttention, validateDiagnosticPayload } from "../../src/client/analysis/diagnostic-data";
import { projectSavedChunk } from "../../src/client/analysis/project-saved-chunk";
import { diagnosticFixture } from "../diagnostic-fixture";

test("binary16 maps decode normals, subnormals and invalid encodings faithfully", () => {
  const data = Buffer.alloc(10);
  [0, 0x3c00, 1, 0x7c00, 0x7e00].forEach((bits, i) => data.writeUInt16LE(bits, i * 2));
  const values = decodeHalfMap(data.toString("base64"));
  expect(values[0]).toBe(0); expect(values[1]).toBe(1); expect(values[2]).toBe(2 ** -24);
  expect(values[3]).toBe(Infinity); expect(Number.isNaN(values[4])).toBe(true);
});

test("all-query map uses actual group counts without renormalizing image mass", () => {
  const { packet } = diagnosticFixture();
  if (!packet.attention) throw new Error("Attention fixture required");
  const early = packet.attention.queryGroups[0];
  if (!early) throw new Error("Early group required");
  early.horizonIndices = [0]; early.queryRows = [0];
  const result = selectAttention(packet, 1, 1, "all");
  const front = selectAttention(packet, 1, 1, "early")?.maps[0]?.values[5];
  const back = selectAttention(packet, 1, 1, "late")?.maps[0]?.values[5];
  if (front === undefined || back === undefined) throw new Error("Maps required");
  expect(result?.queryCount).toBe(3);
  expect(result?.maps[0]?.values[5]).toBeCloseTo((front + 2 * back) / 3, 7);
  expect(result?.masses.find((item) => item.id === "front")?.value).toBe(0.5);
  expect(validateDiagnosticPayload(packet)).toBeNull();
});

test("all-layer selection averages raw maps, masses and padding with unequal query counts at the selected step only", () => {
  const { packet } = diagnosticFixture();
  const attention = packet.attention;
  const early = attention?.queryGroups[0];
  if (!attention || !early) throw new Error("Attention required");
  early.horizonIndices = [0]; early.queryRows = [0];
  for (const slice of attention.slices.filter((item) => item.stepIndex === 1)) {
    const value = (slice.layer + 1) * (slice.queryGroup === "early" ? 1 : 3) * 0.001;
    const map = slice.maps[0];
    if (!map) throw new Error("Map required");
    const bytes = Buffer.alloc(16 * 4);
    for (let i = 0; i < 16; i++) bytes.writeFloatLE(value, i * 4);
    delete map.valuesF16LE;
    map.valuesF32LE = bytes.toString("base64");
    map.letterboxMass = value * 4;
    for (const mass of slice.masses) mass.value = mass.groupId === "front" ? 16 * value : mass.groupId === "text" ? 1 - 16 * value : 0;
  }
  const original = JSON.stringify(packet);
  const selected = selectAttention(packet, 1, "all", "all");
  const expected = 0.001 * 2 * (1 + 2 * 3) / 3;
  expect(selected?.maps[0]?.values[0]).toBeCloseTo(expected, 8);
  expect(selected?.maps[0]?.letterboxMass).toBeCloseTo(expected * 4, 10);
  expect(selected?.masses.find((mass) => mass.id === "front")?.value).toBeCloseTo(expected * 16, 10);
  expect(selected?.masses.reduce((sum, mass) => sum + mass.value, 0)).toBeCloseTo(1, 10);
  expect(selected?.queryCount).toBe(3);
  expect(selected?.layerCount).toBe(3);
  expect(new Set(selected?.sinks.map((sink) => sink.layer))).toEqual(new Set([0, 1, 2]));
  expect(selectAttention(packet, 1, "all", "early")?.maps[0]?.values[0]).toBeCloseTo(0.002, 8);
  expect(selectAttention(packet, 1, 2, "all")?.maps[0]?.values[0]).toBeCloseTo(0.007, 8);
  expect(JSON.stringify(packet)).toBe(original);
  const map = attention.slices.find((item) => item.stepIndex === 1 && item.layer === 2)?.maps[0];
  if (!map) throw new Error("Map required");
  map.letterboxMass = null;
  expect(selectAttention(packet, 1, "all", "all")?.maps[0]?.letterboxMass).toBeNull();
});

test("metadata rejects missing axes, overlapping queries, nonpartitioned keys and bad transforms", () => {
  for (const mutate of [
    (p: ReturnType<typeof diagnosticFixture>["packet"]) => { p.attention?.slices.pop(); },
    (p: ReturnType<typeof diagnosticFixture>["packet"]) => { const g = p.attention?.queryGroups[1]; if (g) g.horizonIndices = [0, 3]; },
    (p: ReturnType<typeof diagnosticFixture>["packet"]) => { const g = p.attention?.keyGroups[1]; if (g) g.keyIndices = [0, 17]; },
    (p: ReturnType<typeof diagnosticFixture>["packet"]) => { const i = p.images[0]; if (i?.preprocessing) i.preprocessing.sourceToInput = [0, 0, 0, 0, 0, 0]; },
  ]) {
    const { packet } = diagnosticFixture();
    mutate(packet);
    expect(diagnosticPacketSchema.safeParse(packet).success).toBe(false);
  }
});

test("payload validation rejects NaN and inflated image mass", () => {
  const { packet } = diagnosticFixture();
  const map = packet.attention?.slices[0]?.maps[0];
  if (!map?.valuesF16LE) throw new Error("Half map required");
  const buffer = Buffer.from(map.valuesF16LE, "base64");
  buffer.writeUInt16LE(0x7e00, 0);
  map.valuesF16LE = buffer.toString("base64");
  expect(validateDiagnosticPayload(packet)).not.toBeNull();
  buffer.writeUInt16LE(0x3c00, 0);
  map.valuesF16LE = buffer.toString("base64");
  expect(validateDiagnosticPayload(packet)).not.toBeNull();
});

test("v2 preserves float32 probabilities and unknown letterbox geometry", () => {
  const { packet } = diagnosticFixture();
  packet.schemaVersion = 2;
  const image = packet.images[0], attention = packet.attention;
  if (!image || !attention) throw new Error("Image and attention required");
  image.geometryResolved = false; image.preprocessing = null;
  for (const slice of attention.slices) for (const map of slice.maps) {
    const values = decodeAttentionMap(map);
    const data = Buffer.alloc(values.length * 4);
    values.forEach((value, i) => data.writeFloatLE(value, i * 4));
    delete map.valuesF16LE;
    map.valuesF32LE = data.toString("base64");
    map.letterboxMass = null;
  }
  const parsed = diagnosticPacketSchema.parse(packet);
  expect(parsed.images[0]?.preprocessing).toBeNull();
  expect(validateDiagnosticPayload(parsed)).toBeNull();
  expect(selectAttention(parsed, 0, 0, "all")?.maps[0]?.letterboxMass).toBeNull();
});

test("model query ranges use adapter intervals rather than rounded UI half splits", () => {
  const { packet } = diagnosticFixture();
  const attention = packet.attention;
  if (!attention) throw new Error("Attention required");
  attention.horizon = 5;
  const late = attention.queryGroups.find((group) => group.id === "late");
  if (!late) throw new Error("Late group required");
  late.horizonIndices = [2, 3, 4]; late.queryRows = [2, 3, 4];
  expect(diagnosticPacketSchema.safeParse(packet).success).toBe(true);
});

test("padding inverse maps model coordinates back to the original image", () => {
  const { packet } = diagnosticFixture();
  const image = packet.images[0];
  if (!image) throw new Error("Image required");
  expect(inverseImageTransform(image)).toEqual([1, -0, -0, 1, 0, -8]);
});

test("projection uses saved full-chunk Cartesian positions and keeps masked gaps", () => {
  const { job, packet } = diagnosticFixture();
  if (!job.result) throw new Error("Result required");
  const chunk = job.result.samples[0];
  if (!chunk) throw new Error("Chunk required");
  chunk.valid[1] = false;
  const output = projectSavedChunk(job.result, packet, null);
  if (output.kind !== "ready") throw new Error(output.reason);
  expect(output.trajectories).toHaveLength(4);
  expect(output.trajectories[0]?.points[0]).toEqual({ kind: "visible", u: 20, v: 24, depthM: 1 });
  expect(output.trajectories[0]?.points[1]?.kind).not.toBe("visible");
  expect(output.trajectories[2]?.points[0]).toEqual({ kind: "visible", u: 44, v: 24, depthM: 1 });
});

test("camera contrast excludes pure padding without splitting partial-patch attention or mutating values", () => {
  const image = diagnosticFixture().packet.images[0];
  if (!image) throw new Error("Image required");
  const map = { gridWidth: 2, gridHeight: 2, values: new Float32Array([1, 0.04, 0.01, 0]),
    patchValidFraction: [0, 0.25, 1, 1] };
  const before = map.values.slice();
  const scale = attentionDisplayScale(map, image, 1, "camera");
  expect(scale.upper).toBeCloseTo(0.04, 8);
  expect(scale.enhanced).toBe(true);
  expect(attentionDisplayIntensity(0.01, 0.04, true)).toBe(0.5);
  expect(map.values).toEqual(before);
  expect(attentionDisplayScale(map, image, 1, "shared").upper).toBe(1);
  expect(attentionDisplayIntensity(0.01, 1, false)).toBe(0.01);
});

test("shared scale ignores pure padding so the visible image is not washed out", () => {
  const image = diagnosticFixture().packet.images[0];
  if (!image) throw new Error("Image required");
  const map = { modelKey: image.modelKey, gridWidth: 2, gridHeight: 2, values: new Float32Array([1, 0.04, 0.01, 0]),
    patchValidFraction: [0, 0.25, 1, 1] };
  const wrist = { ...image, modelKey: "wrist" };
  const other = { ...map, modelKey: "wrist", values: new Float32Array([0.5, 0.5, 0.5, 0.5]), patchValidFraction: [1, 1, 1, 1] };
  expect(sharedImageMaximum([map], [image])).toBeCloseTo(0.04, 8);
  expect(sharedImageMaximum([map, other], [image, wrist])).toBe(0.5);
  expect(sharedImageMaximum([{ ...map, patchValidFraction: null }], [{ ...image, preprocessing: null }])).toBe(1);
  expect(sharedImageMaximum([], [image])).toBe(0);
});

test("focus curve hides values at or below the uniform floor and squares the remainder", () => {
  expect(attentionDisplayIntensity(0.001, 0.01, "focus", 0.002)).toBe(0);
  expect(attentionDisplayIntensity(0.002, 0.01, "focus", 0.002)).toBe(0);
  expect(attentionDisplayIntensity(0.006, 0.01, "focus", 0.002)).toBeCloseTo(0.25, 10);
  expect(attentionDisplayIntensity(0.02, 0.01, "focus", 0.002)).toBe(1);
  expect(attentionDisplayIntensity(0.0025, 0.01, true)).toBeCloseTo(0.5, 10);
  expect(attentionDisplayIntensity(0.0025, 0.01, "linear")).toBeCloseTo(0.25, 10);
});

test("valid-region P95 saturates outliers only in rendering", () => {
  const image = diagnosticFixture().packet.images[0];
  if (!image) throw new Error("Image required");
  const map = { gridWidth: 10, gridHeight: 10,
    values: Float32Array.from({ length: 100 }, (_, i) => i === 99 ? 0.1 : 0.001),
    patchValidFraction: Array(100).fill(1) };
  const scale = attentionDisplayScale(map, image, 0.1, "camera");
  expect(scale.upper).toBeCloseTo(0.001, 8);
  expect(scale.clipped).toBe(1);
  expect(attentionDisplayIntensity(0.1, scale.upper, true)).toBe(1);
  expect(map.values[99]).toBeCloseTo(0.1, 7);
});

test("sparse and zero maps remain defined and geometry uncertainty is explicit", () => {
  const image = diagnosticFixture().packet.images[0];
  if (!image) throw new Error("Image required");
  const map = { gridWidth: 10, gridHeight: 10, values: new Float32Array(100),
    patchValidFraction: Array(100).fill(1) };
  expect(attentionDisplayScale(map, image, 0, "camera").upper).toBe(0);
  expect(attentionDisplayIntensity(0, 0, true)).toBe(0);
  map.values[99] = 0.1;
  expect(attentionDisplayScale(map, image, 0.5, "camera").upper).toBeCloseTo(0.1, 7);
  const unresolved = { ...image, preprocessing: null };
  const unknown = { ...map, patchValidFraction: null };
  expect(patchHasImage(unknown, unresolved, 0)).toBeNull();
  expect(attentionDisplayScale(unknown, unresolved, 0.5, "camera")).toMatchObject({
    upper: 0.5, enhanced: false, reason: "unknown_geometry",
  });
});

test("legacy maps derive padding membership from image geometry", () => {
  const image = diagnosticFixture().packet.images[0];
  if (!image?.preprocessing) throw new Error("Image required");
  image.preprocessing.contentRect = [0, 16, 64, 48];
  const map = { gridWidth: 4, gridHeight: 4, values: Float32Array.from({ length: 16 }, (_, i) => i < 4 ? 0.5 : 0.01) };
  expect(patchHasImage(map, image, 0)).toBe(false);
  expect(patchHasImage(map, image, 4)).toBe(true);
  expect(attentionDisplayScale(map, image, 0.5, "camera").upper).toBeCloseTo(0.01, 7);
});
