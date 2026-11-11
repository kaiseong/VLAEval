import type { TraceOverlay } from "../charts/TracePlot";

export type OverviewSeries = {
  readonly frames: readonly number[];
  readonly predicted: readonly (readonly (number | null)[])[];
  readonly target: readonly (readonly (number | null)[])[];
  readonly fps: number;
};

/** A stored action chunk anchored at an original source frame. */
export type OverviewChunk = {
  readonly frame: number;
  readonly predicted: readonly (readonly (number | null)[])[];
  readonly target: readonly (readonly (number | null)[])[];
  readonly valid: readonly boolean[];
};

export const chunkColor = (order: number, total: number) =>
  `hsl(${Math.round(220 - 220 * (total > 1 ? order / (total - 1) : 0))} 75% 45%)`;

/** Exact raw values only: never interpolate gaps or use the display-thinned subset. */
export function inspectOverviewFrame(input: {
  readonly frame: number;
  readonly dimension: number;
  readonly series: OverviewSeries;
  readonly chunks: readonly OverviewChunk[];
  readonly drawnFrames: ReadonlySet<number>;
  readonly origin?: number | null;
}) {
  const { frame, dimension, series, chunks, drawnFrames } = input;
  const row = series.frames.indexOf(frame);
  let target = series.target[row]?.[dimension] ?? null;
  const sorted = [...chunks].sort((a, b) => a.frame - b.frame);
  const predictions = sorted.flatMap((chunk, order) => {
    const step = frame - chunk.frame;
    if (chunk.valid[step] !== true) return [];
    target ??= chunk.target[step]?.[dimension] ?? null;
    if (input.origin != null && chunk.frame !== input.origin) return [];
    const value = chunk.predicted[step]?.[dimension];
    return typeof value === "number" && Number.isFinite(value) ? [{
      origin: chunk.frame, step, horizon: chunk.predicted.length, value,
      color: chunkColor(order, sorted.length), drawn: drawnFrames.has(chunk.frame),
    }] : [];
  });
  const firstStep = chunks.length === 0 ? series.predicted[row]?.[dimension] ?? null : null;
  return {
    target: target !== null && Number.isFinite(target) ? target : null,
    firstStep: firstStep !== null && Number.isFinite(firstStep) ? firstStep : null,
    predictions,
  };
}

/** Preserve unavailable values and Euler discontinuities as geometry breaks. */
export function overviewPoints(
  rows: readonly { readonly frame: number; readonly value: number | null }[],
  wrapThreshold?: number,
): TraceOverlay["points"] {
  let previous: { readonly frame: number; readonly value: number } | null = null;
  return rows.flatMap(({ frame, value }) => {
    if (value === null || !Number.isFinite(value)) { previous = null; return []; }
    const breakBefore = previous === null || frame > previous.frame + 1
      || (wrapThreshold !== undefined && Math.abs(value - previous.value) > wrapThreshold);
    previous = { frame, value };
    return [{ frame, value, breakBefore }];
  });
}
