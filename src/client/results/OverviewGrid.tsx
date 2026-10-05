import { useMemo } from "react";
import { createChannelLayout } from "../analysis/channel-layout";
import type { Channel, ChannelLayout } from "../analysis/channel-layout";
import { createTraceSeries, firstStepStatistics } from "../analysis/series";
import type { FrameWindow, RawTraceSeries } from "../analysis/series";
import { TracePlot } from "../charts/TracePlot";
import "./overview.css";

export type OverviewGridProps = {
  readonly actionNames: readonly string[];
  /** Complete selected-episode first-step trace, never a zoomed slice. */
  readonly series: RawTraceSeries;
  readonly sourceFrame: number | null;
  readonly window: FrameWindow;
  readonly onFrameSelect: (frame: number) => void;
  readonly onDetailOpen: (sourceIndex: number) => void;
};

/** Canonical display order only; grouping and raw source indices stay intact. */
export function overviewChannels(layout: ChannelLayout): readonly Channel[] {
  if (layout.kind === "generic") return layout.channels;
  const byName = new Map(layout.channels.map((channel) => [channel.channelName, channel]));
  const names = Array.from({ length: 4 }, (_, row) =>
    (["right", "left"] as const).flatMap((side) =>
      row === 3 ? [`${side}_arm_6`, `${side}_gripper_0`]
        : [`${side}_arm_${row * 2}`, `${side}_arm_${row * 2 + 1}`])).flat();
  return names.flatMap((name) => {
    const channel = byName.get(name);
    return channel ? [channel] : [];
  });
}

const number = (value: number) => Number.isFinite(value)
  ? value.toLocaleString("en-US", { maximumSignificantDigits: 4 }) : "unavailable";

export function OverviewGrid(props: OverviewGridProps) {
  const layout = useMemo(() => createChannelLayout(props.actionNames), [props.actionNames]);
  const channels = useMemo(() => overviewChannels(layout), [layout]);
  const parsed = useMemo(() => createTraceSeries(props.series), [props.series]);
  const statistics = useMemo(() => firstStepStatistics(parsed), [parsed]);
  const panelSeries = useMemo(() => channels.map((channel) => ({
    frames: props.series.frames,
    fps: props.series.fps,
    predicted: props.series.predicted.map((row) => row[channel.sourceIndex] ?? null),
    target: props.series.target.map((row) => row[channel.sourceIndex] ?? null),
  })), [channels, props.series]);
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
  return <section className="overview" aria-label="Action overview" data-layout={layout.kind}>
    <header className="overview__heading">
      <div><h2>Action overview</h2><p>First-step · complete scored trace · native / unknown units</p>
        <p className="overview__cursor">{props.sourceFrame === null ? "No frame selected"
          : `Frame ${props.sourceFrame} · ${number(props.sourceFrame / props.series.fps)} s`}
          {props.sourceFrame !== null && (props.sourceFrame < props.window.startFrame || props.sourceFrame > props.window.endFrame)
            ? " · outside visible window" : ""}</p>
        <p>Window {number(props.window.startFrame / props.series.fps)}–{number(props.window.endFrame / props.series.fps)} s</p></div>
      <div className="overview__legend" aria-label="Trace legend">
        <span><i />Prediction (solid)</span><span><i />GT (dashed)</span>
      </div>
    </header>
    {notice && <p className="overview__notice" role="status">{notice}</p>}
    {!channels.length && <p role="status">No action channels. Choose a result with recorded actions.</p>}
    <div className="overview__grid">
      {channels.map((channel, index) => {
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
            onFrameSelect={props.onFrameSelect} compact />
            : <p className="overview-panel__unavailable">Trace unavailable</p>}
        </article>;
      })}
    </div>
  </section>;
}
