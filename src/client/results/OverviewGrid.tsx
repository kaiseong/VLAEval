import { useMemo } from "react";
import { createChannelLayout } from "../analysis/channel-layout";
import type { Channel, ChannelLayout } from "../analysis/channel-layout";
import { createTraceSeries, firstStepStatistics } from "../analysis/series";
import type { FrameWindow, RawTraceSeries } from "../analysis/series";
import { TracePlot } from "../charts/TracePlot";
import type { TraceOverlay } from "../charts/TracePlot";
import "./overview.css";

/** One stored predicted action chunk anchored at an original source frame. */
export type OverviewChunk = {
  readonly frame: number;
  readonly predicted: readonly (readonly number[])[];
  readonly target: readonly (readonly number[])[];
  readonly valid: readonly boolean[];
};

export type OverviewGridProps = {
  readonly actionNames: readonly string[];
  /** Complete selected-episode first-step trace, never a zoomed slice. */
  readonly series: RawTraceSeries;
  readonly sourceFrame: number | null;
  readonly window: FrameWindow;
  readonly onFrameSelect: (frame: number) => void;
  readonly onDetailOpen: (sourceIndex: number) => void;
  /** Selected-episode predicted chunks; when present they replace the first-step line. */
  readonly chunks?: readonly OverviewChunk[];
};

/** Display-only cap on drawn chunks per panel; statistics never use this subset. */
export const MAX_DRAWN_CHUNKS = 40;

/** Canonical display order: left arm (J0-J6, gripper) then right arm; raw source indices stay intact. */
export function overviewChannels(layout: ChannelLayout): readonly Channel[] {
  if (layout.kind === "generic") return layout.channels;
  const byName = new Map(layout.channels.map((channel) => [channel.channelName, channel]));
  const names = (["left", "right"] as const).flatMap((side) =>
    [...Array.from({ length: 7 }, (_, joint) => `${side}_arm_${joint}`), `${side}_gripper_0`]);
  return names.flatMap((name) => {
    const channel = byName.get(name);
    return channel ? [channel] : [];
  });
}

/** Anchors drawn in the current window: evenly thinned, always keeping the selected frame. */
export function drawnChunks(chunks: readonly OverviewChunk[], window: FrameWindow, sourceFrame: number | null) {
  const sorted = chunks.map((chunk, rank) => ({ chunk, rank })).sort((a, b) => a.chunk.frame - b.chunk.frame);
  const inWindow = sorted.filter(({ chunk }) => chunk.frame >= window.startFrame && chunk.frame <= window.endFrame);
  const step = Math.max(1, Math.ceil(inWindow.length / MAX_DRAWN_CHUNKS));
  const kept = inWindow.filter((item, index) => index % step === 0 || item.chunk.frame === sourceFrame);
  return { total: sorted.length, inWindow: inWindow.length, kept: kept.map(({ chunk }) => ({
    chunk, order: sorted.findIndex((item) => item.chunk === chunk), selected: chunk.frame === sourceFrame,
  })) };
}

const chunkColor = (order: number, total: number) =>
  `hsl(${Math.round(220 - 220 * (total > 1 ? order / (total - 1) : 0))} 75% 45%)`;

const number = (value: number) => Number.isFinite(value)
  ? value.toLocaleString("en-US", { maximumSignificantDigits: 4 }) : "unavailable";

export function OverviewGrid(props: OverviewGridProps) {
  const layout = useMemo(() => createChannelLayout(props.actionNames), [props.actionNames]);
  const channels = useMemo(() => overviewChannels(layout), [layout]);
  const parsed = useMemo(() => createTraceSeries(props.series), [props.series]);
  const statistics = useMemo(() => firstStepStatistics(parsed), [parsed]);
  const hasChunks = (props.chunks?.length ?? 0) > 0;
  const visibleChunks = useMemo(() => drawnChunks(props.chunks ?? [], props.window, props.sourceFrame),
    [props.chunks, props.window, props.sourceFrame]);
  const panelSeries = useMemo(() => channels.map((channel) => ({
    frames: props.series.frames,
    fps: props.series.fps,
    predicted: props.series.predicted.map((row) => hasChunks ? null : row[channel.sourceIndex] ?? null),
    target: props.series.target.map((row) => row[channel.sourceIndex] ?? null),
  })), [channels, props.series, hasChunks]);
  const panelOverlays = useMemo(() => channels.map((channel): readonly TraceOverlay[] => {
    // GT for every frame covered by a stored chunk, beyond the scored first-step frames.
    const truth = new Map<number, number>();
    props.series.frames.forEach((frame, row) => {
      const value = props.series.target[row]?.[channel.sourceIndex];
      if (typeof value === "number") truth.set(frame, value);
    });
    for (const chunk of props.chunks ?? []) chunk.target.forEach((row, step) => {
      const value = row[channel.sourceIndex];
      if (chunk.valid[step] === true && typeof value === "number" && !truth.has(chunk.frame + step)) truth.set(chunk.frame + step, value);
    });
    const reference: TraceOverlay = { key: "gt", color: "", reference: true,
      points: [...truth].sort((a, b) => a[0] - b[0]).map(([frame, value]) => ({ frame, value })) };
    return [reference, ...visibleChunks.kept.map(({ chunk, order, selected }) => ({
      key: `chunk-${chunk.frame}`,
      color: chunkColor(order, visibleChunks.total),
      emphasized: selected,
      points: chunk.predicted.flatMap((row, step) => {
        const value = row[channel.sourceIndex];
        return chunk.valid[step] === true && typeof value === "number" ? [{ frame: chunk.frame + step, value }] : [];
      }),
    }))];
  }), [channels, visibleChunks, props.chunks, props.series]);
  let notice: string | null = null;
  switch (parsed.kind) {
    case "empty": notice = "No episode samples. Choose an episode with a saved trace."; break;
    case "invalid": notice = `Episode trace unavailable: ${parsed.reason}. Choose another episode.`; break;
    case "ready":
      if (parsed.series.channelCount !== props.actionNames.length) {
        notice = "Channel names and trace dimensions do not match. Choose a valid result.";
      }
      break;
    default: {
      const exhaustive: never = parsed;
      return exhaustive;
    }
  }
  const horizon = props.chunks?.[0]?.predicted.length ?? 0;
  const panel = (channel: Channel, index: number) => {
    const stats = statistics.kind === "ready" && notice === null
      ? statistics.channels[channel.sourceIndex] : undefined;
    const title = channel.kind === "generic" ? channel.channelName
      : `${channel.side === "right" ? "Right" : "Left"} ${channel.kind === "gripper" ? "gripper" : `J${channel.channelName.at(-1)}`}`;
    const plotSeries = panelSeries[index];
    return <article className="overview-panel" key={channel.sourceIndex}
      data-channel-name={channel.channelName} data-source-index={channel.sourceIndex}
      data-side={channel.side} data-kind={channel.kind}>
      <header>
        <button type="button" data-qa-detail={channel.sourceIndex}
          aria-label={`Open detail for ${channel.channelName}`}
          onClick={() => props.onDetailOpen(channel.sourceIndex)}>{title}<span aria-hidden="true"> ↗</span></button>
        <dl className="overview-panel__stats" data-mae={stats?.mae ?? "unavailable"}
          data-rmse={stats?.rmse ?? "unavailable"} data-count={stats?.count ?? 0}>
          <div><dt>MAE</dt><dd>{stats ? number(stats.mae) : "unavailable"}</dd></div>
          <div><dt>RMSE</dt><dd>{stats ? number(stats.rmse) : "unavailable"}</dd></div>
        </dl>
      </header>
      {notice === null && plotSeries ? <TracePlot series={plotSeries}
        sourceFrame={props.sourceFrame} window={props.window} yDomain={null}
        labels={{ title: channel.channelName, unit: "native / unknown" }}
        onFrameSelect={props.onFrameSelect} compact
        {...(hasChunks ? { overlays: panelOverlays[index] ?? [] } : {})} />
        : <p className="overview-panel__unavailable">Trace unavailable</p>}
    </article>;
  };
  const split = layout.kind === "rby1";
  return <section className="overview" aria-label="Action overview" data-layout={layout.kind}>
    <header className="overview__heading">
      <div><h2>Action overview</h2><p>{hasChunks
        ? `Chunks H=${horizon} vs GT · ${visibleChunks.kept.length}/${visibleChunks.inWindow} drawn · MAE first-step`
        : "First-step · complete scored trace · native / unknown units"}</p>
        <p className="overview__cursor">{props.sourceFrame === null ? "No frame selected"
          : `Frame ${props.sourceFrame} · ${number(props.sourceFrame / props.series.fps)} s`}
          {props.sourceFrame !== null && (props.sourceFrame < props.window.startFrame || props.sourceFrame > props.window.endFrame)
            ? " · outside visible window" : ""}</p>
        <p>Window {number(props.window.startFrame / props.series.fps)}–{number(props.window.endFrame / props.series.fps)} s</p></div>
      <div className="overview__legend" aria-label="Trace legend">
        {hasChunks
          ? <><span><i className="overview__legend-chunks" />Prediction chunk (color = inference frame, early → late)</span><span><i />GT (dashed)</span></>
          : <><span><i />Prediction (solid)</span><span><i />GT (dashed)</span></>}
      </div>
    </header>
    {notice && <p className="overview__notice" role="status">{notice}</p>}
    {!channels.length && <p role="status">No action channels. Choose a result with recorded actions.</p>}
    {split
      ? <div className="overview__grid overview__grid--split">
        {(["left", "right"] as const).map((side) => <section key={side} className="overview__arm" data-arm={side}
          aria-label={side === "left" ? "Left arm" : "Right arm"}>
          <h3>{side === "left" ? "Left arm" : "Right arm"}</h3>
          <div className="overview__arm-panels">
            {channels.map((channel, index) => channel.side === side ? panel(channel, index) : null)}
          </div>
        </section>)}
      </div>
      : <div className="overview__grid">{channels.map(panel)}</div>}
  </section>;
}
