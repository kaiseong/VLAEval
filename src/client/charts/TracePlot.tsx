import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import { sampleRenderGeometry } from "../analysis/render-sampling";
import type { RenderSamplingInput, RenderSamplingResult } from "../analysis/render-sampling";
import type { FrameWindow } from "../analysis/series";
import { fkFrameIndex } from "../analysis/fk-view";
import type { FkView } from "../analysis/fk-protocol";
import "./plot.css";

export type TracePlotSeries = RenderSamplingInput & { readonly fps: number };
export type TracePlotLabels = {
  readonly title: string;
  readonly unit: string;
};
export type TracePlotProps = {
  readonly series: TracePlotSeries;
  readonly sourceFrame: number | null;
  readonly window: FrameWindow;
  readonly yDomain: readonly [number, number] | null;
  readonly labels: TracePlotLabels;
  readonly onFrameSelect: (frame: number) => void;
  readonly compact?: boolean;
  readonly detail?: boolean;
  readonly wrapThreshold?: number;
  /** Optional geometry supplied by the owning workspace for this window. */
  readonly geometry?: RenderSamplingResult;
  /** Validated bounded Worker view; series.frames is the existing native source index. */
  readonly boundedView?: FkView["channels"][number];
};

type LayoutOptions = {
  readonly series: TracePlotSeries;
  readonly window: FrameWindow;
  readonly yDomain: readonly [number, number] | null;
  readonly width: number;
  readonly height: number;
  readonly wrapThreshold?: number;
  readonly geometry?: RenderSamplingResult;
  readonly boundedView?: FkView["channels"][number];
};

/** Display geometry only. Raw values and source IDs remain untouched. */
export function tracePlotGeometry(options: LayoutOptions) {
  const { series, window, yDomain, width, height } = options;
  if (!Number.isFinite(series.fps) || series.fps <= 0
    || !Number.isFinite(window.startFrame) || !Number.isFinite(window.endFrame)
    || window.startFrame > window.endFrame
    || (yDomain && (!yDomain.every(Number.isFinite) || yDomain[0] > yDomain[1]))) {
    return { kind: "invalid", reason: "invalid_domain" } as const;
  }
  if (!options.boundedView && (series.frames.length !== series.predicted.length || series.frames.length !== series.target.length
    || series.frames.some((frame, index) => !Number.isSafeInteger(frame) || frame < 0
      || (index > 0 && frame <= (series.frames[index - 1] ?? -1))))) {
    return { kind: "invalid", reason: "invalid_series" } as const;
  }
  const first = fkFrameIndex(series.frames, window.startFrame);
  const end = fkFrameIndex(series.frames, Math.floor(window.endFrame) + 1);
  const visible = {
    frames: first === 0 && end === series.frames.length ? series.frames : series.frames.slice(first, end),
    predicted: options.boundedView ? [] : series.predicted.slice(first, end),
    target: options.boundedView ? [] : series.target.slice(first, end),
  };
  // Reserve readable space for bounded scientific ticks, including narrow plots.
  const left = 88;
  const right = Math.max(left + 1, width - 16);
  // Keep the unit caption above the top tick at the readable overview font size.
  const top = 48;
  const bottom = height - 60;
  const sampled = options.boundedView?.geometry ?? options.geometry ?? sampleRenderGeometry(visible, {
    pixelWidth: Math.max(1, Math.floor(right - left)),
    ...(options.wrapThreshold === undefined ? {} : { wrapThreshold: options.wrapThreshold }),
  });
  switch (sampled.kind) {
    case "empty":
      return { kind: "empty" } as const;
    case "invalid":
      return sampled;
    case "ready": {
      const paths = {
        predicted: sampled.predicted.segments.map((segment) => segment.filter((v) => v.frame >= window.startFrame && v.frame <= window.endFrame)).filter((segment) => segment.length),
        target: sampled.target.segments.map((segment) => segment.filter((v) => v.frame >= window.startFrame && v.frame <= window.endFrame)).filter((segment) => segment.length),
      };
      let min = Infinity;
      let max = -Infinity;
      for (const values of [visible.predicted, visible.target]) {
        for (const value of values) {
          if (typeof value === "number" && Number.isFinite(value)) {
            min = Math.min(min, value);
            max = Math.max(max, value);
          }
        }
      }
      if (options.boundedView?.domain) [min, max] = options.boundedView.domain;
      if (!Number.isFinite(min)) return { kind: "empty" } as const;
      if (yDomain) [min, max] = yDomain;
      const scale = Math.max(Math.abs(min), Math.abs(max)) || 1;
      const span = max / scale - min / scale;
      const x = (frame: number) => window.endFrame === window.startFrame
        ? (left + right) / 2
        : left + (frame - window.startFrame) / (window.endFrame - window.startFrame) * (right - left);
      const y = (value: number) => span === 0
        ? (top + bottom) / 2
        : bottom - Math.max(0, Math.min(1, (value / scale - min / scale) / span)) * (bottom - top);
      return { kind: "ready", visible, paths, sampled, min, max, x, y, left, right, top, bottom } as const;
    }
    default: {
      const exhaustive: never = sampled;
      return exhaustive;
    }
  }
}

const displayValue = (value: number | null | undefined) => typeof value === "number" && Number.isFinite(value)
  ? value.toLocaleString("en-US", { maximumSignificantDigits: 5 })
  : "unavailable";

/** Axis presentation only; raw inspection retains its separate precision. */
const axisValue = (value: number) => {
  const decimal = value.toLocaleString("en-US", { maximumSignificantDigits: 3, useGrouping: false });
  return decimal.length <= 6 ? decimal : value.toExponential(1).replace("e+", "e");
};

/** Absolute time needs precision relative to the visible tick interval, not zero. */
const timeAxisValue = (value: number, significantDigits: number) => {
  const decimal = value.toLocaleString("en-US", { maximumSignificantDigits: significantDigits, useGrouping: false });
  return decimal.length <= 9 ? decimal : value.toExponential(significantDigits - 1).replace("e+", "e");
};

export function TracePlot(props: TracePlotProps) {
  const { series, sourceFrame, window, yDomain, labels, onFrameSelect } = props;
  const compact = props.compact === true && props.detail !== true;
  const height = compact ? 160 : 340;
  const timeDigits = window.startFrame === window.endFrame ? 3
    : Math.min(21, Math.max(3, Math.floor(Math.log10(2 * window.endFrame / (window.endFrame - window.startFrame))) + 2));
  const [width, setWidth] = useState(360);
  const stackedTimeAxis = compact && width < 240;
  const axisHeight = height + (stackedTimeAxis ? 64 : 0);
  const svgRef = useRef<SVGSVGElement>(null);
  const id = useId();
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry && entry.contentRect.width > 0) setWidth(entry.contentRect.width);
    });
    observer.observe(svg);
    return () => observer.disconnect();
  }, []);
  const layout = useMemo(() => tracePlotGeometry({
    series, window, yDomain, width, height,
    ...(props.wrapThreshold === undefined ? {} : { wrapThreshold: props.wrapThreshold }),
    ...(props.geometry === undefined ? {} : { geometry: props.geometry }),
    ...(props.boundedView === undefined ? {} : { boundedView: props.boundedView }),
  }), [series, window, yDomain, width, height, props.wrapThreshold, props.geometry, props.boundedView]);
  const frames = layout.kind === "ready" ? layout.visible.frames : [];
  const position = sourceFrame === null ? -1 : fkFrameIndex(frames, sourceFrame);
  const index = frames[position] === sourceFrame ? position : -1;
  const rawIndex = sourceFrame === null ? -1 : fkFrameIndex(series.frames, sourceFrame);
  const selected = index >= 0 && sourceFrame !== null;
  const selectKey = (event: KeyboardEvent<SVGSVGElement>) => {
    let next: number;
    switch (event.key) {
      case "ArrowRight":
      case "ArrowUp": next = Math.min(frames.length - 1, index + 1); break;
      case "ArrowLeft":
      case "ArrowDown": next = Math.max(0, index - 1); break;
      case "Home": next = 0; break;
      case "End": next = frames.length - 1; break;
      default: return;
    }
    event.preventDefault();
    const frame = frames[next];
    if (frame !== undefined) onFrameSelect(frame);
  };
  const valueText = selected
    ? `Frame ${sourceFrame} · ${(sourceFrame / series.fps).toFixed(3)} s`
    : "Selected frame unavailable in this window";
  return <figure className={`trace-plot ${compact ? "trace-plot--compact" : "trace-plot--detail"}`}
    data-source-frame={sourceFrame ?? "unavailable"} data-window-start={window.startFrame}
    data-window-end={window.endFrame} data-unit={labels.unit}>
    <figcaption id={`${id}-title`}><strong>{labels.title}</strong><span>{labels.unit}</span></figcaption>
    {!compact && <div className="trace-plot__legend"><span><i />Prediction (solid)</span><span><i />GT (dashed)</span></div>}
    <svg ref={svgRef} viewBox={`0 0 ${width} ${axisHeight}`} height={axisHeight}
      style={stackedTimeAxis ? { height: axisHeight } : undefined}
      role={frames.length ? "slider" : "img"} tabIndex={frames.length ? 0 : undefined}
      aria-labelledby={`${id}-title`} aria-describedby={`${id}-help`}
      aria-valuemin={frames[0]} aria-valuemax={frames.at(-1)}
      aria-valuenow={selected ? sourceFrame : undefined} aria-valuetext={valueText}
      onKeyDown={selectKey} onClick={(event) => {
        if (layout.kind !== "ready" || !frames.length) return;
        event.currentTarget.focus();
        const matrix = event.currentTarget.getScreenCTM();
        if (!matrix) return;
        const localX = new DOMPoint(event.clientX, event.clientY).matrixTransform(matrix.inverse()).x;
        const fraction = Math.max(0, Math.min(1, (localX - layout.left) / (layout.right - layout.left)));
        const desired = window.startFrame + fraction * (window.endFrame - window.startFrame);
        // Source frames, not retained vertices or row ordinals; ties select earlier.
        let low = 0;
        let high = frames.length;
        while (low < high) {
          const mid = Math.floor((low + high) / 2);
          if ((frames[mid] ?? Infinity) < desired) low = mid + 1;
          else high = mid;
        }
        const earlier = frames[low - 1];
        const later = frames[low];
        const frame = earlier === undefined ? later
          : later === undefined || desired - earlier <= later - desired ? earlier : later;
        if (frame !== undefined) onFrameSelect(frame);
      }}>
      <title>{`${labels.title} (${labels.unit})`}</title>
      <desc id={`${id}-help`}>Prediction is solid; GT is dashed. Click to inspect an original frame. Use arrow keys, Home or End. Time is in seconds.</desc>
      {layout.kind === "ready" ? <>
        {(layout.min === layout.max ? [0.5] : [0, 0.5, 1]).map((fraction) => {
          const value = layout.min * (1 - fraction) + layout.max * fraction;
          return <g key={fraction}><line className="trace-plot__grid" x1={layout.left} x2={layout.right} y1={layout.y(value)} y2={layout.y(value)} />
            <text x={layout.left - 8} y={layout.y(value) + 4} textAnchor="end">{axisValue(value)}</text></g>;
        })}
        <g className="trace-plot__time-axis">{(window.startFrame === window.endFrame ? [0.5] : [0, 0.5, 1]).map((fraction, tickIndex) => {
          const frame = window.startFrame * (1 - fraction) + window.endFrame * fraction;
          return <text key={fraction} x={layout.x(frame)} y={height - 36 + (stackedTimeAxis ? tickIndex * 24 : 0)} textAnchor={fraction === 0 ? "start" : fraction === 1 ? "end" : "middle"}>{timeAxisValue(frame / series.fps, timeDigits)}</text>;
        })}</g>
        <text x={8} y={24}>{labels.unit}</text><text x={(layout.left + layout.right) / 2} y={axisHeight - 12} textAnchor="middle">Time (s)</text>
        {layout.sampled.unavailableBands.map((band, bandIndex) => <g key={bandIndex} data-gap-density="unavailable">
          <rect className="trace-plot__band" x={layout.x(Math.max(window.startFrame, band.startFrame))}
            y={layout.top} width={Math.max(0, layout.x(Math.min(window.endFrame, band.endFrame)) - layout.x(Math.max(window.startFrame, band.startFrame)))} height={layout.bottom - layout.top} />
          <title>Gap density unavailable; zoom in for raw inspection</title>
        </g>)}
        {(["predicted", "target"] as const).map((name) => <g key={name} className={`trace-plot__${name}`}>
          {layout.paths[name].map((segment, segmentIndex) => <g key={segmentIndex}
            data-source-frame-start={segment[0]?.frame} data-source-frame-end={segment.at(-1)?.frame}>
            <path fill="none" d={segment.map((v, i) => `${i ? "L" : "M"}${layout.x(v.frame)},${layout.y(v.value)}`).join(" ")} />
            {segment.length === 1 && segment[0] && <circle data-source-frame={segment[0].frame} cx={layout.x(segment[0].frame)} cy={layout.y(segment[0].value)} r={3} />}
          </g>)}
        </g>)}
        {selected && <line className="trace-plot__cursor" data-source-frame={sourceFrame}
          x1={layout.x(sourceFrame)} x2={layout.x(sourceFrame)} y1={layout.top} y2={layout.bottom} />}
      </> : <text x={width / 2} y={height / 2} textAnchor="middle">{layout.kind === "empty" ? "No valid samples" : "Invalid chart data"}</text>}
    </svg>
    {layout.kind === "ready" && layout.sampled.unavailableBands.length > 0 && <p className="trace-plot__notice">Gap density unavailable · zoom in</p>}
    <p className="trace-plot__inspection" data-selection-status={selected ? "available" : "unavailable"}>{valueText}
      {!compact && selected && <> · Prediction {displayValue(series.predicted[rawIndex])} · GT {displayValue(series.target[rawIndex])} {labels.unit}</>}
    </p>
  </figure>;
}
