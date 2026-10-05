import type { FkResult } from "../../kinematics/contracts";
import { sampleRenderGeometry } from "./render-sampling";
import type { FkSelection, FkView } from "./fk-protocol";

const axes = ["X", "Y", "Z", "Roll", "Pitch", "Yaw"] as const;
const sides = ["right", "left"] as const;

/** Full-data display projection. Called only by the Worker (and numeric unit fixtures). */
export function fkPoseSeries(result: FkResult, fps: number) {
  const frames = result.samples.map((sample) => sample.frame);
  return sides.flatMap((side) => axes.map((axis, index) => ({
    side, axis, unit: index < 3 ? "mm" as const : "deg" as const,
    series: {
      fps, frames,
      predicted: result.samples.map((sample) => index < 3
        ? (sample.arms[side].pose.predicted.translationM?.[index] ?? null)
        : (sample.arms[side].pose.predicted.rpyDeg[index - 3] ?? null)).map((value) => value === null ? null : value * (index < 3 ? 1000 : 1)),
      target: result.samples.map((sample) => index < 3
        ? (sample.arms[side].pose.target.translationM?.[index] ?? null)
        : (sample.arms[side].pose.target.rpyDeg[index - 3] ?? null)).map((value) => value === null ? null : value * (index < 3 ? 1000 : 1)),
    },
  })));
}

/** Binary source lookup also serves exact raw point queries; it never uses rendered vertices. */
export function fkFrameIndex(frames: readonly number[], frame: number): number {
  let low = 0, high = frames.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if ((frames[middle] ?? Infinity) < frame) low = middle + 1;
    else high = middle;
  }
  return low;
}

export function buildFkView(channels: ReturnType<typeof fkPoseSeries>, selection: FkSelection): FkView {
  const { window } = selection;
  return { ...selection, channels: channels.map(({ side, axis, unit, series }) => {
    const start = fkFrameIndex(series.frames, window.startFrame);
    const end = fkFrameIndex(series.frames, Math.floor(window.endFrame) + 1);
    const visible = { frames: series.frames.slice(start, end),
      predicted: series.predicted.slice(start, end), target: series.target.slice(start, end) };
    let min = Infinity, max = -Infinity;
    for (const path of [visible.predicted, visible.target]) for (const value of path) {
      if (value !== null && Number.isFinite(value)) { min = Math.min(min, value); max = Math.max(max, value); }
    }
    const sampled = sampleRenderGeometry(visible, { pixelWidth: 256, ...(unit === "deg" ? { wrapThreshold: 180 } : {}) });
    if (sampled.kind === "invalid") throw new FkViewError(sampled.reason);
    // Adjacent unavailable buckets represent the same continuous unavailable band.
    const bands: { kind: "gap_density_unavailable"; startFrame: number; endFrame: number }[] = [];
    if (sampled.kind === "ready") for (const band of sampled.unavailableBands) {
      const last = bands.at(-1);
      if (last?.endFrame === band.startFrame) last.endFrame = band.endFrame;
      else bands.push({ ...band });
    }
    return { side, axis, unit, domain: Number.isFinite(min) ? [min, max] : null,
      geometry: sampled.kind === "ready" ? { ...sampled, unavailableBands: bands } : sampled };
  }) };
}

class FkViewError extends Error {
  constructor(readonly reason: string) { super(`Invalid FK display data: ${reason}`); }
}
