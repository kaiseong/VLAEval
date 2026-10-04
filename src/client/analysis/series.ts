export type RawTraceSeries = {
  readonly frames: readonly number[];
  readonly predicted: readonly (readonly number[])[];
  readonly target: readonly (readonly number[])[];
  readonly fps: number;
};

export type TraceSeries = RawTraceSeries & {
  readonly kind: "ready";
  readonly channelCount: number;
  readonly rows: readonly TraceSample[];
};

export type InvalidSeriesReason =
  | "invalid_fps"
  | "invalid_frame_id"
  | "non_increasing_frames"
  | "misaligned_row_count"
  | "misaligned_dimensions"
  | "non_finite_value";

export type TraceSeriesResult =
  | { readonly kind: "empty" }
  | { readonly kind: "invalid"; readonly reason: InvalidSeriesReason }
  | { readonly kind: "ready"; readonly series: TraceSeries };

export type SourceFrame = {
  readonly index: number;
  readonly frame: number;
};

export type FrameWindow = {
  readonly startFrame: number;
  readonly endFrame: number;
};

export type TraceSample = {
  readonly frame: number;
  readonly predicted: readonly number[];
  readonly target: readonly number[];
};

export type ChannelStatistics = {
  readonly channel: number;
  readonly mae: number;
  readonly rmse: number;
  readonly count: number;
};

export type SeriesStatistics =
  | { readonly kind: "empty" }
  | { readonly kind: "invalid"; readonly reason: InvalidSeriesReason }
  | { readonly kind: "ready"; readonly channels: readonly ChannelStatistics[] };

export function createTraceSeries(input: RawTraceSeries): TraceSeriesResult {
  if (!Number.isFinite(input.fps) || input.fps <= 0) {
    return { kind: "invalid", reason: "invalid_fps" };
  }
  if (input.frames.length !== input.predicted.length || input.frames.length !== input.target.length) {
    return { kind: "invalid", reason: "misaligned_row_count" };
  }

  let channelCount: number | undefined;
  const rows: TraceSample[] = [];
  for (let index = 0; index < input.frames.length; index += 1) {
    const frame = input.frames[index];
    const predicted = input.predicted[index];
    const target = input.target[index];
    if (frame === undefined || !Number.isSafeInteger(frame) || frame < 0) {
      return { kind: "invalid", reason: "invalid_frame_id" };
    }
    if (index > 0 && frame <= (input.frames[index - 1] ?? -1)) {
      return { kind: "invalid", reason: "non_increasing_frames" };
    }
    if (predicted === undefined || target === undefined || predicted.length !== target.length) {
      return { kind: "invalid", reason: "misaligned_dimensions" };
    }
    if (channelCount === undefined) channelCount = predicted.length;
    if (predicted.length !== channelCount) {
      return { kind: "invalid", reason: "misaligned_dimensions" };
    }
    if (predicted.some((value) => !Number.isFinite(value)) || target.some((value) => !Number.isFinite(value))) {
      return { kind: "invalid", reason: "non_finite_value" };
    }
    rows.push({ frame, predicted: predicted.slice(), target: target.slice() });
  }

  if (input.frames.length === 0) return { kind: "empty" };
  const copiedInput = {
    frames: rows.map((row) => row.frame),
    predicted: rows.map((row) => row.predicted),
    target: rows.map((row) => row.target),
    fps: input.fps,
  };
  return {
    kind: "ready",
    series: {
      ...copiedInput,
      kind: "ready",
      channelCount: channelCount ?? 0,
      rows,
    },
  };
}

export function findExactSourceFrame(series: TraceSeries, frame: number): SourceFrame | null {
  if (!Number.isSafeInteger(frame)) return null;
  let low = 0;
  let high = series.frames.length - 1;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const candidate = series.frames[middle];
    if (candidate === frame) return { index: middle, frame: candidate };
    if (candidate === undefined || candidate > frame) high = middle - 1;
    else low = middle + 1;
  }
  return null;
}

export function findNearestSourceFrame(series: TraceSeries, frame: number): SourceFrame | null {
  if (!Number.isFinite(frame)) return null;
  const exact = findExactSourceFrame(series, frame);
  if (exact) return exact;
  let low = 0;
  let high = series.frames.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if ((series.frames[middle] ?? Infinity) < frame) low = middle + 1;
    else high = middle;
  }
  const earlier = series.frames[low - 1];
  const later = series.frames[low];
  if (earlier === undefined) return later === undefined ? null : { index: low, frame: later };
  if (later === undefined || frame - earlier <= later - frame) {
    return { index: low - 1, frame: earlier };
  }
  return { index: low, frame: later };
}

export function frameTimeSeconds(frame: number, fps: number): number {
  return frame / fps;
}

export function clampFrameWindow(
  series: TraceSeries,
  window: FrameWindow,
): FrameWindow | null {
  if (!Number.isFinite(window.startFrame) || !Number.isFinite(window.endFrame)
    || window.startFrame > window.endFrame) return null;
  const first = series.frames[0];
  const last = series.frames[series.frames.length - 1];
  if (first === undefined || last === undefined) return null;
  return {
    startFrame: Math.max(first, Math.min(last, window.startFrame)),
    endFrame: Math.max(first, Math.min(last, window.endFrame)),
  };
}

export function selectTraceWindow(series: TraceSeries, window: FrameWindow): readonly TraceSample[] {
  const clamped = clampFrameWindow(series, window);
  if (!clamped) return [];
  let low = 0;
  let high = series.frames.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if ((series.frames[middle] ?? Infinity) < clamped.startFrame) low = middle + 1;
    else high = middle;
  }
  const start = low;
  high = series.frames.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if ((series.frames[middle] ?? Infinity) <= clamped.endFrame) low = middle + 1;
    else high = middle;
  }
  return series.rows.slice(start, low);
}

export function firstStepStatistics(series: TraceSeriesResult): SeriesStatistics {
  switch (series.kind) {
    case "empty":
      return { kind: "empty" };
    case "invalid":
      return { kind: "invalid", reason: series.reason };
    case "ready": {
      const minimumNormalSquareRoot = Math.sqrt(2 ** -1022);
      const totals = new Map<number, {
        absolute: number;
        squared: number;
        squaredSafe: boolean;
        scale: number;
        factor: number;
        scaledAbsolute: number;
        scaledSquares: number;
        count: number;
      }>();
      for (const row of series.series.rows) {
        const targetValues = row.target.values();
        for (const [channel, prediction] of row.predicted.entries()) {
          const target = targetValues.next();
          if (target.done) return { kind: "invalid", reason: "misaligned_dimensions" };
          const error = prediction - target.value;
          const total = totals.get(channel) ?? {
            absolute: 0,
            squared: 0,
            squaredSafe: true,
            scale: 0,
            factor: 1,
            scaledAbsolute: 0,
            scaledSquares: 0,
            count: 0,
          };
          // Keep finite subtraction exact, especially for close large operands.
          // An overflowing difference fits in half units; restore the factor
          // only after division/rooting, when the statistic may be representable.
          const factor = Number.isFinite(error) ? total.factor : 2;
          const magnitude = Number.isFinite(error)
            ? Math.abs(error) / factor
            : Math.abs(prediction / 2 - target.value / 2);
          let scale = total.scale * (total.factor / factor);
          let scaledAbsolute = total.scaledAbsolute;
          let scaledSquares = total.scaledSquares;
          if (magnitude > 0) {
            if (magnitude > scale) {
              scaledAbsolute = 1 + scaledAbsolute * (scale / magnitude);
              scaledSquares = 1 + scaledSquares * (scale / magnitude) ** 2;
              scale = magnitude;
            } else {
              scaledAbsolute += magnitude / scale;
              scaledSquares += (magnitude / scale) ** 2;
            }
          }
          const count = total.count + 1;
          const squaredSafe = total.squaredSafe
            && factor === 1
            && (magnitude === 0 || magnitude >= minimumNormalSquareRoot);
          const squared = squaredSafe ? total.squared + error * error : total.squared;
          totals.set(channel, {
            absolute: total.absolute + Math.abs(error),
            squared,
            squaredSafe: squaredSafe && Number.isFinite(squared),
            scale,
            factor,
            scaledAbsolute,
            scaledSquares,
            count,
          });
        }
        if (!targetValues.next().done) return { kind: "invalid", reason: "misaligned_dimensions" };
      }
      const channels = Array.from(totals, ([channel, total]): ChannelStatistics => ({
        channel,
        mae: Number.isFinite(total.absolute)
          ? total.absolute / total.count
          : total.scale * (total.scaledAbsolute / total.count) * total.factor,
        rmse: total.scale === 0
          ? 0
          : total.squaredSafe
            ? Math.sqrt(total.squared / total.count)
            : total.scale * Math.sqrt(total.scaledSquares / total.count) * total.factor,
        count: total.count,
      }));
      return { kind: "ready", channels };
    }
    default: {
      const exhaustive: never = series;
      return exhaustive;
    }
  }
}
