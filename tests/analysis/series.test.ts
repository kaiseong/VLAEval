import { expect, test } from "bun:test";
import {
  clampFrameWindow,
  createTraceSeries,
  findExactSourceFrame,
  findNearestSourceFrame,
  firstStepStatistics,
  frameTimeSeconds,
  selectTraceWindow,
} from "../../src/client/analysis/series";
import type { ChannelStatistics, RawTraceSeries, TraceSeries } from "../../src/client/analysis/series";

const irregularTrace: RawTraceSeries = {
  frames: [0, 3, 9],
  predicted: [[0], [2], [5]],
  target: [[0], [0], [2]],
  fps: 30,
};

function readySeries(input: RawTraceSeries): TraceSeries {
  const result = createTraceSeries(input);
  switch (result.kind) {
    case "ready":
      return result.series;
    case "empty":
      throw new Error("expected ready series, got empty");
    case "invalid":
      throw new Error(`expected ready series, got invalid: ${result.reason}`);
    default: {
      const exhaustive: never = result;
      return exhaustive;
    }
  }
}

function firstChannelStatistics(input: RawTraceSeries): ChannelStatistics {
  const statistics = firstStepStatistics(createTraceSeries(input));
  switch (statistics.kind) {
    case "ready": {
      const firstChannel = statistics.channels[0];
      if (!firstChannel) throw new Error("expected channel 0 statistics");
      return firstChannel;
    }
    case "empty":
      throw new Error("expected statistics for a non-empty trace");
    case "invalid":
      throw new Error(`expected valid statistics, got invalid: ${statistics.reason}`);
    default: {
      const exhaustive: never = statistics;
      return exhaustive;
    }
  }
}

test("nominal seconds use original frame IDs when frames are irregular", () => {
  const series = readySeries(irregularTrace);

  expect(series.frames.map((frame) => frameTimeSeconds(frame, series.fps))).toEqual([0, 0.1, 0.3]);
});

test("nearest source-frame lookup chooses the earlier frame on a tie", () => {
  const series = readySeries(irregularTrace);

  expect(findNearestSourceFrame(series, 6)).toEqual({ index: 1, frame: 3 });
  expect(findNearestSourceFrame(series, -2)).toEqual({ index: 0, frame: 0 });
  expect(findExactSourceFrame(series, 9)).toEqual({ index: 2, frame: 9 });
  expect(findExactSourceFrame(series, 8)).toBeNull();
});

test("inclusive source-frame window clamps and retains both endpoints", () => {
  const series = readySeries(irregularTrace);

  expect(clampFrameWindow(series, { startFrame: -4, endFrame: 30 })).toEqual({
    startFrame: 0,
    endFrame: 9,
  });
  expect(selectTraceWindow(series, { startFrame: 3, endFrame: 9 }).map((row) => row.frame)).toEqual([3, 9]);
  expect(selectTraceWindow(series, { startFrame: 9, endFrame: 3 })).toEqual([]);
});

test("full-episode per-channel statistics ignore the selected display window", () => {
  const original = structuredClone(irregularTrace);
  const parsed = createTraceSeries(irregularTrace);

  expect(parsed.kind).toBe("ready");
  const beforeWindow = firstStepStatistics(parsed);
  const visibleRows = selectTraceWindow(readySeries(irregularTrace), { startFrame: 3, endFrame: 9 });
  const afterWindow = firstStepStatistics(parsed);

  expect(visibleRows.map((row) => row.frame)).toEqual([3, 9]);
  expect(beforeWindow).toEqual({
    kind: "ready",
    channels: [{ channel: 0, mae: 5 / 3, rmse: Math.sqrt(13 / 3), count: 3 }],
  });
  expect(afterWindow).toEqual(beforeWindow);
  expect(irregularTrace).toEqual(original);
});

test("Q03 first-step scope derives statistics from all raw rows", () => {
  const firstStep = createTraceSeries({
    frames: [0, 3],
    predicted: [[0], [2]],
    target: [[0], [0]],
    fps: 30,
  });
  expect(firstStepStatistics(firstStep)).toEqual({
    kind: "ready",
    channels: [{ channel: 0, mae: 1, rmse: Math.sqrt(2), count: 2 }],
  });
});

test("channel statistics remain separate and use direct non-wrapped errors", () => {
  const parsed = createTraceSeries({
    frames: [0],
    predicted: [[3.1, 10]],
    target: [[-3.1, 0]],
    fps: 30,
  });

  expect(firstStepStatistics(parsed)).toEqual({
    kind: "ready",
    channels: [
      { channel: 0, mae: 6.2, rmse: 6.2, count: 1 },
      { channel: 1, mae: 10, rmse: 10, count: 1 },
    ],
  });
});

test("empty traces stay explicitly empty instead of producing zero scores", () => {
  const empty = createTraceSeries({ frames: [], predicted: [], target: [], fps: 30 });

  expect(empty).toEqual({ kind: "empty" });
  expect(firstStepStatistics(empty)).toEqual({ kind: "empty" });
});

test("invalid frame order and duplicate IDs are rejected", () => {
  for (const frames of [[0, 0], [3, 0]]) {
    expect(createTraceSeries({ frames, predicted: [[0], [1]], target: [[0], [0]], fps: 30 })).toEqual({
      kind: "invalid",
      reason: "non_increasing_frames",
    });
  }
});

test("misaligned rows, dimensions and non-finite values are rejected", () => {
  expect(createTraceSeries({ ...irregularTrace, predicted: [[0]] })).toEqual({
    kind: "invalid",
    reason: "misaligned_row_count",
  });
  expect(createTraceSeries({ ...irregularTrace, target: [[0], [0, 1], [2]] })).toEqual({
    kind: "invalid",
    reason: "misaligned_dimensions",
  });
  expect(createTraceSeries({ ...irregularTrace, predicted: [[0], [Number.NaN], [5]] })).toEqual({
    kind: "invalid",
    reason: "non_finite_value",
  });
});

test("invalid FPS and malformed frame IDs are rejected", () => {
  expect(createTraceSeries({ ...irregularTrace, fps: 0 })).toEqual({
    kind: "invalid",
    reason: "invalid_fps",
  });
  expect(createTraceSeries({ ...irregularTrace, frames: [0, 3.5, 9] })).toEqual({
    kind: "invalid",
    reason: "invalid_frame_id",
  });
});

test("finite extreme errors retain representable RMS magnitudes", () => {
  const large = firstChannelStatistics({
    frames: [0],
    predicted: [[1e200]],
    target: [[0]],
    fps: 30,
  });
  const small = firstChannelStatistics({
    frames: [0],
    predicted: [[1e-200]],
    target: [[0]],
    fps: 30,
  });

  expect(Number.isFinite(large.rmse)).toBe(true);
  expect(large.rmse / 1e200).toBeCloseTo(1, 12);
  expect(Number.isFinite(small.rmse)).toBe(true);
  expect(small.rmse / 1e-200).toBeCloseTo(1, 12);
});

test("ordinary and zero errors retain their expected RMS", () => {
  const ordinary = firstChannelStatistics({
    frames: [0, 1],
    predicted: [[3], [4]],
    target: [[0], [0]],
    fps: 30,
  });
  const zero = firstChannelStatistics({
    frames: [0, 1],
    predicted: [[4], [-2]],
    target: [[4], [-2]],
    fps: 30,
  });

  expect(ordinary.rmse).toBeCloseTo(Math.sqrt(12.5), 12);
  expect(zero.rmse).toBe(0);
});

test("mixed error magnitudes retain the dominant finite RMS", () => {
  const channel = firstChannelStatistics({
    frames: [0, 1],
    predicted: [[1e200], [1e-200]],
    target: [[0], [0]],
    fps: 30,
  });
  const expected = 1e200 / Math.sqrt(2);

  expect(Number.isFinite(channel.rmse)).toBe(true);
  expect(channel.rmse / expected).toBeCloseTo(1, 12);
});

test("100000-frame finite input accumulates RMS without argument spreading", () => {
  const length = 100_000;
  const channel = firstChannelStatistics({
    frames: Array.from({ length }, (_, frame) => frame),
    predicted: Array.from({ length }, () => [1e200]),
    target: Array.from({ length }, () => [0]),
    fps: 30,
  });

  expect(channel.count).toBe(length);
  expect(Number.isFinite(channel.rmse)).toBe(true);
  expect(channel.rmse / 1e200).toBeCloseTo(1, 12);
});

test("MAE stays representable when finite magnitudes overflow their sum", () => {
  // Given two individually representable errors whose sum overflows.
  const input = { frames: [0, 1], predicted: [[1e308], [1e308]], target: [[0], [0]], fps: 30 };
  // When full-episode statistics are computed.
  const channel = firstChannelStatistics(input);
  // Then both statistics retain the common magnitude.
  expect(channel.mae).toBe(1e308);
  expect(channel.rmse).toBe(1e308);
});

test("statistics stay representable when signed subtraction overflows before averaging", () => {
  // Given opposite finite extremes diluted by zero errors, in either order/sign.
  for (const sign of [-1, 1]) {
    for (const reverse of [false, true]) {
      const predicted = [[sign * Number.MAX_VALUE], [0], [0], [0]];
      const target = [[-sign * Number.MAX_VALUE], [0], [0], [0]];
      if (reverse) { predicted.reverse(); target.reverse(); }
      // When errors are aggregated without an unrepresentable intermediate.
      const channel = firstChannelStatistics({ frames: [0, 1, 2, 3], predicted, target, fps: 30 });
      // Then the representable boundary mean and RMS are retained.
      expect(channel.mae).toBe(Number.MAX_VALUE / 2);
      expect(channel.rmse).toBe(Number.MAX_VALUE);
    }
  }
});

test("rescaling preserves finite errors before or after an overflowing difference", () => {
  // Given a finite error and an overflowing difference in both orders.
  for (const target of [[[-1e308], [0], [0], [0]], [[0], [-1e308], [0], [0]]]) {
    // When one channel moves between full and half-magnitude units.
    const channel = firstChannelStatistics({
      frames: [0, 1, 2, 3], predicted: [[1e308], [1e308], [0], [0]], target, fps: 30,
    });
    // Then both contributions remain in the aggregate.
    expect(channel.mae / 7.5e307).toBeCloseTo(1, 14);
    expect(channel.rmse / (Math.sqrt(1.25) * 1e308)).toBeCloseTo(1, 14);
  }
});

test("direct subtraction preserves cancellation between close large finite values", () => {
  // Given neighboring large numbers with a precisely representable difference.
  const input = { frames: [0], predicted: [[1e308]], target: [[1e308 - 2 ** 971]], fps: 30 };
  // When computing the error before any scaling.
  const channel = firstChannelStatistics(input);
  // Then cancellation retains the exact difference.
  expect(channel.mae).toBe(2 ** 971);
  expect(channel.rmse).toBe(2 ** 971);
});
