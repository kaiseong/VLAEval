export const MAX_RENDER_VERTICES = 4096;

export type RenderSamplingInput = {
  readonly frames: readonly number[];
  readonly predicted: readonly (number | null | undefined)[];
  readonly target: readonly (number | null | undefined)[];
};

export type RenderSamplingOptions = {
  readonly vertexBudget?: number;
  /** Horizontal pixel columns available to the panel. */
  readonly pixelWidth?: number;
  /** Split a path when adjacent values differ by more than this declared wrap threshold. */
  readonly wrapThreshold?: number;
};

export type RenderVertex = {
  readonly index: number;
  readonly frame: number;
  readonly value: number;
};

export type RenderPath = {
  readonly segments: readonly (readonly RenderVertex[])[];
};

export type UnavailableBand = {
  readonly kind: "gap_density_unavailable";
  readonly startFrame: number;
  readonly endFrame: number;
};

export type RenderSamplingResult =
  | { readonly kind: "empty" }
  | { readonly kind: "invalid"; readonly reason: "invalid_frames" | "misaligned_values" | "invalid_budget" | "invalid_pixel_width" | "invalid_wrap_threshold" }
  | {
    readonly kind: "ready";
    readonly bucketCount: number;
    readonly vertexCount: number;
    readonly sourceIndices: readonly number[];
    readonly predicted: RenderPath;
    readonly target: RenderPath;
    readonly unavailableBands: readonly UnavailableBand[];
  };

type PathName = "predicted" | "target";
type Run = readonly number[];
type Fragment = { readonly path: PathName; readonly bucket: number; readonly indices: readonly number[] };

function splitPathRuns(
  frames: readonly number[],
  values: readonly (number | null | undefined)[],
  wrapThreshold: number | undefined,
): readonly Run[] {
  const runs: number[][] = [];
  let run: number[] = [];
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    const previousIndex = run.at(-1);
    const previous = previousIndex === undefined ? undefined : values[previousIndex];
    if (typeof value !== "number" || !Number.isFinite(value)) {
      if (run.length) runs.push(run);
      run = [];
      continue;
    }
    if (wrapThreshold !== undefined && typeof previous === "number"
      && Math.abs(value - previous) > wrapThreshold) {
      runs.push(run);
      run = [];
    }
    run.push(index);
  }
  if (run.length) runs.push(run);
  return runs;
}

function bucketForFrame(frame: number, start: number, span: number, bucketCount: number): number {
  if (span === 0) return 0;
  return Math.min(bucketCount - 1, Math.floor(((frame - start) / span) * bucketCount));
}

function selectFragmentExtrema(
  indices: readonly number[],
  values: readonly (number | null | undefined)[],
): ReadonlySet<number> {
  const first = indices[0];
  const last = indices.at(-1);
  if (first === undefined || last === undefined) return new Set();

  let minimumIndex = first;
  let maximumIndex = first;
  for (const index of indices.slice(1)) {
    const value = values[index];
    const minimum = values[minimumIndex];
    const maximum = values[maximumIndex];
    if (typeof value === "number" && typeof minimum === "number" && value < minimum) minimumIndex = index;
    if (typeof value === "number" && typeof maximum === "number" && value > maximum) maximumIndex = index;
  }
  return new Set([first, minimumIndex, maximumIndex, last]);
}

export function sampleRenderGeometry(
  input: RenderSamplingInput,
  options: RenderSamplingOptions = {},
): RenderSamplingResult {
  const { frames, predicted, target } = input;
  if (frames.length !== predicted.length || frames.length !== target.length) {
    return { kind: "invalid", reason: "misaligned_values" };
  }
  if (!frames.length) return { kind: "empty" };
  if (frames.some((frame, index) => !Number.isSafeInteger(frame) || frame < 0
    || (index > 0 && frame <= (frames[index - 1] ?? -1)))) {
    return { kind: "invalid", reason: "invalid_frames" };
  }

  const requestedBudget = options.vertexBudget ?? MAX_RENDER_VERTICES;
  if (!Number.isInteger(requestedBudget) || requestedBudget < 1) {
    return { kind: "invalid", reason: "invalid_budget" };
  }
  const requestedPixelWidth = options.pixelWidth ?? Math.max(1, Math.floor(requestedBudget / 8));
  if (!Number.isInteger(requestedPixelWidth) || requestedPixelWidth < 1) {
    return { kind: "invalid", reason: "invalid_pixel_width" };
  }
  const wrapThreshold = options.wrapThreshold;
  if (wrapThreshold !== undefined && (!Number.isFinite(wrapThreshold) || wrapThreshold <= 0)) {
    return { kind: "invalid", reason: "invalid_wrap_threshold" };
  }

  const vertexBudget = Math.min(requestedBudget, MAX_RENDER_VERTICES);
  const bucketCount = Math.min(requestedPixelWidth, Math.max(1, Math.floor(vertexBudget / 16)));
  const bucketVertexLimit = Math.floor(vertexBudget / bucketCount);
  const startFrame = frames[0] ?? 0;
  const endFrame = frames.at(-1) ?? startFrame;
  const frameSpan = endFrame - startFrame;
  const candidates = Array.from({ length: bucketCount }, () => new Set<number>());
  const pathRuns: Record<PathName, readonly Run[]> = {
    predicted: splitPathRuns(frames, predicted, wrapThreshold),
    target: splitPathRuns(frames, target, wrapThreshold),
  };
  const fragments: Fragment[][] = Array.from({ length: bucketCount }, () => []);

  for (const path of ["predicted", "target"] as const) {
    for (const run of pathRuns[path]) {
      let fragment: number[] = [];
      let fragmentBucket: number | undefined;
      for (const index of run) {
        const frame = frames[index];
        if (frame === undefined) continue;
        const bucket = bucketForFrame(frame, startFrame, frameSpan, bucketCount);
        if (fragmentBucket !== undefined && bucket !== fragmentBucket) {
          fragments[fragmentBucket]?.push({ path, bucket: fragmentBucket, indices: fragment });
          fragment = [];
        }
        fragmentBucket = bucket;
        fragment.push(index);
      }
      if (fragmentBucket !== undefined && fragment.length) {
        fragments[fragmentBucket]?.push({ path, bucket: fragmentBucket, indices: fragment });
      }
    }
  }
  for (const bucketFragments of fragments) {
    for (const fragment of bucketFragments) {
      for (const index of selectFragmentExtrema(fragment.indices, input[fragment.path])) {
        candidates[fragment.bucket]?.add(index);
      }
    }
  }

  const unavailableBuckets = new Set<number>();
  const unavailableBands: UnavailableBand[] = [];
  for (let bucket = 0; bucket < bucketCount; bucket += 1) {
    let candidateVertexCount = 0;
    for (const index of candidates[bucket] ?? []) {
      if (typeof predicted[index] === "number" && Number.isFinite(predicted[index])) candidateVertexCount += 1;
      if (typeof target[index] === "number" && Number.isFinite(target[index])) candidateVertexCount += 1;
    }
    if (candidateVertexCount > bucketVertexLimit) {
      unavailableBuckets.add(bucket);
      const span = frameSpan / bucketCount;
      unavailableBands.push({
        kind: "gap_density_unavailable",
        startFrame: startFrame + span * bucket,
        endFrame: bucket === bucketCount - 1 ? endFrame : startFrame + span * (bucket + 1),
      });
    }
  }

  const sourceIndices = new Set<number>();
  let vertexCount = 0;
  const buildPath = (path: PathName): RenderPath => {
    const segments: RenderVertex[][] = [];
    for (const run of pathRuns[path]) {
      let segment: RenderVertex[] = [];
      let lastBucket: number | undefined;
      const flush = () => {
        if (segment.length) segments.push(segment);
        segment = [];
      };
      for (const index of run) {
        const frame = frames[index];
        const value = input[path][index];
        if (frame === undefined || typeof value !== "number") continue;
        const bucket = bucketForFrame(frame, startFrame, frameSpan, bucketCount);
        if (unavailableBuckets.has(bucket)) {
          flush();
          lastBucket = bucket;
          continue;
        }
        if (lastBucket !== undefined) {
          for (let skippedBucket = lastBucket + 1; skippedBucket < bucket; skippedBucket += 1) {
            if (unavailableBuckets.has(skippedBucket)) {
              flush();
              break;
            }
          }
        }
        lastBucket = bucket;
        if (candidates[bucket]?.has(index)) {
          segment.push({ index, frame, value });
          sourceIndices.add(index);
          vertexCount += 1;
        }
      }
      flush();
    }
    return { segments };
  };

  const predictedPath = buildPath("predicted");
  const targetPath = buildPath("target");
  return {
    kind: "ready",
    bucketCount,
    vertexCount,
    sourceIndices: [...sourceIndices].sort((left, right) => left - right),
    predicted: predictedPath,
    target: targetPath,
    unavailableBands,
  };
}
