import type { DiagnosticPacket, DiagnosticImage } from "../../diagnostic-contracts";

/** Canonical little-endian binary16 probabilities; no JSON float expansion on disk. */
export function decodeHalfMap(encoded: string): Float32Array {
  const bytes = atob(encoded);
  const values = new Float32Array(bytes.length / 2);
  for (let i = 0; i < values.length; i++) {
    const bits = bytes.charCodeAt(i * 2) | bytes.charCodeAt(i * 2 + 1) << 8;
    const sign = bits & 0x8000 ? -1 : 1;
    const exponent = (bits >> 10) & 31, fraction = bits & 1023;
    values[i] = exponent === 0 ? sign * fraction * 2 ** -24
      : exponent === 31 ? fraction ? NaN : sign * Infinity
        : sign * (1 + fraction / 1024) * 2 ** (exponent - 15);
  }
  return values;
}

export function decodeAttentionMap(map: { readonly valuesF16LE?: string | undefined; readonly valuesF32LE?: string | undefined }): Float32Array {
  if (map.valuesF32LE === undefined) return decodeHalfMap(map.valuesF16LE ?? "");
  const raw = atob(map.valuesF32LE);
  const bytes = Uint8Array.from(raw, (value) => value.charCodeAt(0));
  const view = new DataView(bytes.buffer);
  return Float32Array.from({ length: bytes.length / 4 }, (_, index) => view.getFloat32(index * 4, true));
}

export function validateDiagnosticPayload(packet: DiagnosticPacket): string | null {
  const attention = packet.attention;
  if (!attention) return null;
  for (const slice of attention.slices) {
    const group = attention.queryGroups.find((item) => item.id === slice.queryGroup);
    for (const map of slice.maps) {
      const values = decodeAttentionMap(map);
      if (values.some((value) => !Number.isFinite(value) || value < 0 || value > 1))
        return "Attention maps require finite probabilities in [0,1]";
      const sum = values.reduce((total, value) => total + value, 0);
      if (!group?.queryRows.length && sum !== 0) return "Empty query groups must have zero payloads";
      const imageGroups = attention.keyGroups.filter((item) => item.kind === "image" && item.modelKey === map.modelKey);
      const mass = imageGroups.reduce((total, item) =>
        total + (slice.masses.find((entry) => entry.groupId === item.id)?.value ?? 0), 0);
      if (sum > mass + 0.003) return "Image patch weights exceed declared camera attention mass";
      if (map.letterboxMass != null && map.letterboxMass > mass + 0.003)
        return "Letterbox mass exceeds camera attention mass";
      const camera = attention.cameras.find((item) => item.modelKey === map.modelKey);
      const imageKeyCount = imageGroups.reduce((count, item) => count + item.keyIndices.length, 0);
      if (camera?.patchKeyIndices.length === imageKeyCount && Math.abs(sum - mass) > 0.003)
        return "Image patch weights disagree with declared camera attention mass";
    }
  }
  return null;
}

export type QueryGroupChoice = "all" | "early" | "late";
export type LayerChoice = "all" | number;

export type AttentionDisplayMode = "camera" | "shared" | "fixed";
type DisplayMap = {
  readonly gridWidth: number; readonly gridHeight: number; readonly values: Float32Array;
  readonly patchValidFraction?: readonly number[] | null | undefined;
};

/** Geometry only decides membership; it never scales measured attention mass. */
export function patchHasImage(map: DisplayMap, image: DiagnosticImage, index: number): boolean | null {
  const fraction = map.patchValidFraction?.[index];
  if (fraction !== undefined) return fraction > 0;
  const geometry = image.preprocessing;
  if (!geometry) return null;
  const width = geometry.inputWidth / map.gridWidth, height = geometry.inputHeight / map.gridHeight;
  const x = index % map.gridWidth * width, y = Math.floor(index / map.gridWidth) * height;
  const [cx, cy, cw, ch] = geometry.contentRect;
  return x < cx + cw && x + width > cx && y < cy + ch && y + height > cy;
}

/** Highest valid-image patches (pure padding excluded), descending raw weight. */
export function topImagePatches(map: DisplayMap, image: DiagnosticImage, count: number): number[] {
  return Array.from(map.values, (value, index) => ({ value, index }))
    .filter(({ index }) => patchHasImage(map, image, index) !== false)
    .sort((a, b) => b.value - a.value || a.index - b.index).slice(0, count).map(({ index }) => index);
}

/** Shared linear upper bound: largest raw weight over every camera's valid-image patches (pure padding excluded). */
export function sharedImageMaximum(maps: readonly (DisplayMap & { readonly modelKey: string })[], images: readonly DiagnosticImage[]): number {
  let maximum = 0;
  for (const map of maps) {
    const image = images.find((item) => item.modelKey === map.modelKey);
    map.values.forEach((value, i) => { if (!image || patchHasImage(map, image, i) !== false) maximum = Math.max(maximum, value); });
  }
  return maximum;
}

export function attentionDisplayScale(map: DisplayMap, image: DiagnosticImage, sharedMaximum: number, mode: AttentionDisplayMode, fixedUpper = 0) {
  if (mode === "shared") return { upper: sharedMaximum, enhanced: false, clipped: 0, reason: null };
  if (mode === "fixed") return { upper: fixedUpper, enhanced: false,
    clipped: Array.from(map.values).filter((value, i) => value > fixedUpper && patchHasImage(map, image, i) !== false).length, reason: null };
  const valid: number[] = [];
  for (let i = 0; i < map.values.length; i++) {
    const included = patchHasImage(map, image, i);
    if (included === null) return { upper: sharedMaximum, enhanced: false, clipped: 0, reason: "unknown_geometry" };
    const value = map.values[i];
    if (included && value !== undefined) valid.push(value);
  }
  if (!valid.length) return { upper: sharedMaximum, enhanced: false, clipped: 0, reason: "empty_valid_region" };
  valid.sort((a, b) => a - b);
  // Nearest-rank P95. Preserve sparse peaks if the percentile is zero.
  const upper = valid[Math.ceil(valid.length * 0.95) - 1] || valid.at(-1) || 0;
  return { upper, enhanced: true, clipped: valid.filter((value) => value > upper).length, reason: null };
}

export type ContrastCurve = "focus" | "sqrt" | "linear";

/** focus: values at or below `floor` (the camera's uniform baseline) are transparent;
 * the remaining range to `upper` is squared so only clearly above-average patches stand out. */
export function attentionDisplayIntensity(value: number, upper: number, curve: boolean | ContrastCurve, floor = 0): number {
  if (upper <= 0) return 0;
  const linear = Math.min(1, Math.max(0, value / upper));
  const kind = curve === true ? "sqrt" : curve === false ? "linear" : curve;
  switch (kind) {
    case "linear": return linear;
    case "sqrt": return Math.sqrt(linear);
    case "focus": {
      const base = Math.min(Math.max(0, floor / upper), 0.95);
      const above = Math.max(0, (linear - base) / (1 - base));
      return above * above;
    }
    default: { const exhaustive: never = kind; return exhaustive; }
  }
}

export function selectAttention(packet: DiagnosticPacket, stepIndex: number, layer: LayerChoice, choice: QueryGroupChoice) {
  const attention = packet.attention;
  if (!attention) return null;
  const groups = attention.queryGroups.filter((group) => choice === "all" || choice === group.id);
  const layers = attention.layers.filter((item) => layer === "all" || item === layer);
  const count = groups.reduce((sum, group) => sum + group.queryRows.length, 0);
  if (count === 0 || layers.length === 0) return null;
  const slices = layers.flatMap((selectedLayer) => groups.map((group) => ({
    group, layer: selectedLayer,
    weight: group.queryRows.length / count / layers.length,
    slice: attention.slices.find((slice) => slice.stepIndex === stepIndex && slice.layer === selectedLayer && slice.queryGroup === group.id),
  })));
  if (slices.some((item) => !item.slice)) return null;
  const maps = attention.cameras.map((camera) => {
    const values = new Float64Array(camera.gridWidth * camera.gridHeight);
    let letterboxMass: number | null = 0;
    for (const { group, slice, weight } of slices) {
      const map = slice?.maps.find((item) => item.modelKey === camera.modelKey);
      if (!map) return null;
      const source = decodeAttentionMap(map);
      source.forEach((value, i) => { values[i] = (values[i] ?? 0) + value * weight; });
      if (group.queryRows.length) {
        if (map.letterboxMass == null) letterboxMass = null;
        else if (letterboxMass !== null) letterboxMass += map.letterboxMass * weight;
      }
    }
    return { ...camera, values: Float32Array.from(values), letterboxMass };
  });
  if (maps.some((map) => map === null)) return null;
  const masses = attention.keyGroups.map((group) => ({
    ...group,
    value: slices.reduce((sum, item) => sum
      + (item.slice?.masses.find((mass) => mass.groupId === group.id)?.value ?? 0) * item.weight, 0),
  }));
  // Top-k sets cannot reconstruct a pooled top-k: retain layer and group identity.
  const sinks = slices.flatMap(({ group, slice, layer: selectedLayer }) =>
    slice?.sinkCandidates.map((candidate) => ({ ...candidate, queryGroup: group.id, layer: selectedLayer })) ?? []);
  return { maps: maps.filter((map) => map !== null), masses, sinks, queryCount: count, layerCount: layers.length };
}

export function inverseImageTransform(image: DiagnosticImage): readonly number[] {
  if (!image.preprocessing) throw new Error("Image geometry is unresolved");
  const [a, b, c, d, e, f] = image.preprocessing.sourceToInput;
  const determinant = a * d - b * c;
  return [d / determinant, -b / determinant, -c / determinant, a / determinant,
    (c * f - d * e) / determinant, (b * e - a * f) / determinant];
}
