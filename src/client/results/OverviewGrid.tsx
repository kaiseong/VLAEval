import { useMemo, useRef, useState } from "react";
import { createChannelLayout } from "../analysis/channel-layout";
import { metricLabels, metricMse } from "../analysis/metrics";
import { createTraceSeries, firstStepStatistics } from "../analysis/series";
import type { FrameWindow, RawTraceSeries } from "../analysis/series";
import { TracePlot } from "../charts/TracePlot";
import type { TraceHover, TraceOverlay } from "../charts/TracePlot";
import { OverviewTooltip } from "./OverviewTooltip";
import { chunkColor, overviewPoints } from "./overview-inspection";
import type { OverviewChunk, OverviewSeries } from "./overview-inspection";
import { overviewDisplayChannels } from "./overview-channels";
import type { OverviewChannel } from "./overview-channels";
export { overviewChannels } from "./overview-channels";
export type { OverviewChunk } from "./overview-inspection";
import "./overview.css";

const noChunks: readonly OverviewChunk[] = [];

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
  /** Derived values retain source time and chunk identity; raw statistics are not relabelled as pose errors. */
  readonly pose?: { readonly series: OverviewSeries; readonly chunks: readonly OverviewChunk[] };
  /** A single enlarged channel draws every intersecting chunk, without overview thinning. */
  readonly detailDimension?: number;
  readonly chunkOrigin?: number | null;
  /** Display-only: draw every Nth inference (by rank, so sparse evaluations thin too); the selected frame always stays. */
  readonly chunkStride?: number;
  /** Detail only: drag-to-zoom and wheel-pan bounds and setter, passed through to the plot. */
  readonly zoom?: { readonly fullWindow: FrameWindow; readonly onWindowChange: (window: FrameWindow) => void };
  readonly presentation?: {
    readonly coordinateMode: "joint" | "cartesian";
    readonly title: string;
    readonly series: OverviewSeries;
    readonly chunks: readonly OverviewChunk[];
    readonly channels: readonly OverviewChannel[];
    readonly statisticsIndices: readonly (number | null)[] | null;
  };
};

/** Display-only cap on drawn chunks per panel; statistics never use this subset. */
export const MAX_DRAWN_CHUNKS = 40;

/** Anchors drawn in the current window: evenly thinned, always keeping the selected frame. */
export function drawnChunks(chunks: readonly OverviewChunk[], window: FrameWindow, sourceFrame: number | null,
  maximum = MAX_DRAWN_CHUNKS, stride = 1) {
  const sorted = chunks.map((chunk, rank) => ({ chunk, rank })).sort((a, b) => a.chunk.frame - b.chunk.frame);
  const inWindow = sorted.filter(({ chunk }, order) => chunk.frame <= window.endFrame
    && chunk.frame + chunk.valid.lastIndexOf(true) >= window.startFrame
    && (stride <= 1 || order % stride === 0 || chunk.frame === sourceFrame));
  const step = Math.max(1, Math.ceil(inWindow.length / maximum));
  const kept = inWindow.filter((item, index) => index % step === 0 || item.chunk.frame === sourceFrame);
  return { total: sorted.length, inWindow: inWindow.length, kept: kept.map(({ chunk }) => ({
    chunk, order: sorted.findIndex((item) => item.chunk === chunk), selected: chunk.frame === sourceFrame,
  })) };
}

const chunkLabel = (chunk: OverviewChunk, selected: boolean) =>
  `프레임 ${chunk.frame} 예측 · H=${chunk.predicted.length}${selected ? " · 선택됨 (굵은 선)" : ""}`;

const number = (value: number) => Number.isFinite(value)
  ? value.toLocaleString("en-US", { maximumSignificantDigits: 4 }) : "unavailable";

export function OverviewGrid(props: OverviewGridProps) {
  const root = useRef<HTMLElement | null>(null);
  const [hover, setHover] = useState<(TraceHover & { readonly dimension: number }) | null>(null);
  const layout = useMemo(() => createChannelLayout(props.actionNames), [props.actionNames]);
  const poseMode = props.presentation?.coordinateMode === "cartesian" || props.pose !== undefined;
  const coordinateMode = props.presentation?.coordinateMode ?? (poseMode ? "fk" : "joint");
  const detail = props.detailDimension !== undefined;
  const channels = useMemo(() => (props.presentation?.channels ?? overviewDisplayChannels(layout, poseMode))
    .filter((channel) => props.detailDimension === undefined || channel.sourceIndex === props.detailDimension),
  [layout, poseMode, props.detailDimension, props.presentation?.channels]);
  const series = props.presentation?.series ?? props.pose?.series ?? props.series;
  const chunks = props.presentation?.chunks ?? props.pose?.chunks ?? props.chunks ?? noChunks;
  const parsed = useMemo(() => createTraceSeries(props.series), [props.series]);
  const statistics = useMemo(() => firstStepStatistics(parsed), [parsed]);
  const hasChunks = chunks.length > 0;
  const visibleChunks = useMemo(() => {
    const visible = drawnChunks(chunks, props.window, props.sourceFrame, detail || props.chunkOrigin != null ? Infinity : MAX_DRAWN_CHUNKS,
      props.chunkOrigin != null ? 1 : props.chunkStride ?? 1);
    if (props.chunkOrigin == null) return visible;
    const kept = visible.kept.filter(({ chunk }) => chunk.frame === props.chunkOrigin);
    return { ...visible, kept, inWindow: kept.length };
  }, [chunks, props.window, props.sourceFrame, detail, props.chunkOrigin, props.chunkStride]);
  const drawnFrames = useMemo(() => new Set(visibleChunks.kept.map(({ chunk }) => chunk.frame)), [visibleChunks]);
  const activeHover = hover && hover.frame >= props.window.startFrame && hover.frame <= props.window.endFrame ? hover : null;
  const panelSeries = useMemo(() => channels.map((channel) => ({
    frames: series.frames,
    fps: series.fps,
    predicted: series.predicted.map((row) => hasChunks ? null : row[channel.sourceIndex] ?? null),
    target: series.target.map((row) => row[channel.sourceIndex] ?? null),
  })), [channels, series, hasChunks]);
  const panelOverlays = useMemo(() => channels.map((channel): readonly TraceOverlay[] => {
    // GT for every frame covered by a stored chunk, beyond the scored first-step frames.
    const truth = new Map<number, number | null>();
    series.frames.forEach((frame, row) => {
      truth.set(frame, series.target[row]?.[channel.sourceIndex] ?? null);
    });
    for (const chunk of chunks) chunk.target.forEach((row, step) => {
      const value = row[channel.sourceIndex];
      if (chunk.valid[step] === true && !truth.has(chunk.frame + step)) truth.set(chunk.frame + step, value ?? null);
    });
    const reference: TraceOverlay = { key: "gt", color: "", reference: true, label: "GT (정답 궤적) · 점선",
      points: overviewPoints([...truth].sort((a, b) => a[0] - b[0]).map(([frame, value]) => ({ frame, value })), channel.wrapThreshold) };
    return [reference, ...visibleChunks.kept.map(({ chunk, order, selected }) => ({
      key: `chunk-${chunk.frame}`,
      color: chunkColor(order, visibleChunks.total),
      label: chunkLabel(chunk, selected),
      emphasized: selected,
      points: overviewPoints(chunk.predicted.map((row, step) => ({
        frame: chunk.frame + step, value: chunk.valid[step] === true ? row[channel.sourceIndex] ?? null : null,
      })), channel.wrapThreshold),
    }))];
  }), [channels, visibleChunks, chunks, series]);
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
  const horizon = chunks[0]?.predicted.length ?? 0;
  const unitSummary = [...new Set(channels.map((channel) => channel.unit))].join(" · ");
  const panel = (channel: OverviewChannel, index: number) => {
    const metricIndex = props.presentation ? props.presentation.statisticsIndices?.[channel.sourceIndex] : channel.sourceIndex;
    const stats = statistics.kind === "ready" && notice === null && metricIndex != null
      ? statistics.channels[metricIndex] : undefined;
    const showStatistics = props.presentation ? props.presentation.statisticsIndices !== null : !poseMode;
    const title = channel.title;
    const plotSeries = panelSeries[index];
    return <article className={detail ? "trajectory-detail-panel" : "overview-panel"} key={channel.sourceIndex}
      data-channel-name={channel.channelName} data-source-index={channel.sourceIndex}
      data-side={channel.side} data-kind={channel.kind}>
      <header>
        {detail ? <strong>{title}</strong> : <button type="button" data-qa-detail={channel.sourceIndex}
          data-detail-mode={coordinateMode}
          aria-label={`Open detail for ${channel.channelName}`}
          onClick={() => props.onDetailOpen(channel.sourceIndex)}>{title}<span aria-hidden="true"> ↗</span></button>}
        {!showStatistics ? <span>{channel.unit}</span> : <dl className="overview-panel__stats" data-mae={stats?.mae ?? "unavailable"}
          data-rmse={stats?.rmse ?? "unavailable"} data-count={stats?.count ?? 0}
          data-mse={metricMse(undefined, stats?.rmse ?? null) ?? "unavailable"}>
          <div><dt>{metricLabels.mae}</dt><dd>{stats ? number(stats.mae) : "unavailable"}</dd></div>
          <div><dt>{metricLabels.mse}</dt><dd>{stats ? number(stats.rmse * stats.rmse) : "unavailable"}</dd></div>
          <div><dt>{metricLabels.rmse}</dt><dd>{stats ? number(stats.rmse) : "unavailable"}</dd></div>
        </dl>}
      </header>
      {notice === null && plotSeries ? <TracePlot series={plotSeries}
        sourceFrame={props.sourceFrame} window={props.window} yDomain={null}
        labels={{ title: channel.title, unit: channel.unit }}
        {...(channel.wrapThreshold === undefined ? {} : { wrapThreshold: channel.wrapThreshold })}
        onFrameSelect={props.onFrameSelect} compact={!detail} detail={detail} showLegend={false}
        hoverFrame={activeHover?.frame ?? null}
        onFrameHover={(point) => setHover({ ...point, dimension: channel.sourceIndex })}
        onHoverClear={() => setHover(null)}
        {...(hasChunks ? { overlays: panelOverlays[index] ?? [] } : {})}
        {...(detail && props.zoom ? props.zoom : {})} />
        : <p className="overview-panel__unavailable">Trace unavailable</p>}
    </article>;
  };
  const split = props.presentation !== undefined || layout.kind === "rby1";
  return <section ref={root} className="overview" aria-label="Action overview" data-layout={layout.kind} data-coordinate-mode={coordinateMode}
    data-chunk-origin={props.chunkOrigin ?? "all"}
    onPointerLeave={(event) => { if (event.pointerType !== "touch") setHover(null); }}
    onKeyDown={(event) => { if (event.key === "Escape") setHover(null); }}>
    <header className="overview__heading">
      <div><h2>{props.presentation?.title ?? (detail ? `${poseMode ? "FK" : "Joint"} Detail` : poseMode ? "FK overview" : "Action overview")}</h2><p>{hasChunks
        ? `Chunks H=${horizon} vs GT · ${visibleChunks.kept.length}/${visibleChunks.inWindow} drawn${poseMode ? " · x/y/z mm · rx/ry/rz deg" : props.presentation?.statisticsIndices === null ? ` · ${unitSummary}` : " · MAE first-step"}`
        : `First-step · complete scored trace · ${unitSummary}`}</p>
        <p className="overview__cursor">{props.sourceFrame === null ? "No frame selected"
          : `Frame ${props.sourceFrame} · ${number(props.sourceFrame / props.series.fps)} s`}
          {props.sourceFrame !== null && (props.sourceFrame < props.window.startFrame || props.sourceFrame > props.window.endFrame)
            ? " · outside visible window" : ""}</p>
        <p>Window {number(props.window.startFrame / props.series.fps)}–{number(props.window.endFrame / props.series.fps)} s</p></div>
      <div className="overview__legend" aria-label="Trace legend">
        <span data-legend="gt"><i className="overview__legend-gt" aria-hidden="true" />GT (정답 궤적) · 점선</span>
        <span data-legend="predicted"><i aria-hidden="true" />예측 궤적 · 실선{hasChunks ? " (색상 = 추론 시작 프레임)" : ""}</span>
        <span>그래프에 마우스를 올리거나 터치하면 시간별 값 표시</span>
      </div>
    </header>
    {notice && <p className="overview__notice" role="status">{notice}</p>}
    {!channels.length && <p role="status">No action channels. Choose a result with recorded actions.</p>}
    {detail ? channels.map(panel) : split
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
    {activeHover && <OverviewTooltip hover={activeHover} dimension={activeHover.dimension}
      channelName={channels.find((channel) => channel.sourceIndex === activeHover.dimension)?.title ?? ""}
      unit={channels.find((channel) => channel.sourceIndex === activeHover.dimension)?.unit ?? ""}
      series={series} chunks={chunks} origin={props.chunkOrigin ?? null} drawnFrames={drawnFrames} onClose={() => {
        setHover(null);
        root.current?.querySelector<SVGSVGElement>(`article[data-source-index="${activeHover.dimension}"] svg`)?.focus({ preventScroll: true });
      }} />}
  </section>;
}
