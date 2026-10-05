import type { ReactNode } from "react";
import type { Job } from "../../contracts";
import {
  createTraceSeries, findExactSourceFrame, frameTimeSeconds, selectTraceWindow,
} from "../analysis/series";
import type { FrameWindow, TraceSeries } from "../analysis/series";
import { Field, Section } from "../ui/primitives";

type Result = NonNullable<Job["result"]>;

export interface DetailPanelProps {
  readonly result: Pick<Result, "traces" | "actionNames" | "fps">;
  readonly selectedEpisode: number;
  readonly selectedDimension: number;
  readonly sourceFrame: number;
  readonly window: FrameWindow;
  readonly onEpisodeChange: (episode: number) => void;
  readonly onDimensionChange: (dimension: number) => void;
  readonly onSourceFrameChange: (frame: number) => void;
  readonly onWindowChange: (window: FrameWindow) => void;
  readonly renderPlot: (context: DetailPlotContext) => ReactNode;
}

export type DetailPlotContext = Omit<DetailPanelProps, "result" | "renderPlot"> & {
  readonly series: TraceSeries;
  readonly title: string;
};

export function DetailPanel(props: DetailPanelProps) {
  const { result, selectedEpisode, selectedDimension, sourceFrame, window } = props;
  const trace = result.traces.find((item) => item.episode === selectedEpisode);
  const parsed = createTraceSeries(trace ? { ...trace, fps: result.fps }
    : { frames: [], predicted: [], target: [], fps: result.fps });
  let content: ReactNode;
  switch (parsed.kind) {
    case "empty":
      content = <p role="status" className="empty compact">저장된 에피소드 trace가 없습니다.</p>;
      break;
    case "invalid":
      content = <p role="status" className="empty compact">Trace 사용 불가: {parsed.reason}</p>;
      break;
    case "ready": {
      const series = parsed.series;
      const exact = findExactSourceFrame(series, sourceFrame);
      const row = exact === null ? undefined : series.rows[exact.index];
      const predicted = row?.predicted[selectedDimension];
      const target = row?.target[selectedDimension];
      const title = `EP ${selectedEpisode} · ${result.actionNames[selectedDimension] ?? `action_${selectedDimension}`}`;
      content = <>
        {props.renderPlot({
          series, title, selectedEpisode, selectedDimension, sourceFrame, window,
          onEpisodeChange: props.onEpisodeChange,
          onDimensionChange: props.onDimensionChange,
          onSourceFrameChange: props.onSourceFrameChange,
          onWindowChange: props.onWindowChange,
        })}
        <p className="muted" data-window-count={selectTraceWindow(series, window).length}>
          표시 구간의 평가 프레임: {selectTraceWindow(series, window).length}
        </p>
        {predicted !== undefined && target !== undefined
          ? <dl className="point-inspector mono" data-source-frame={sourceFrame}>
            <dt>프레임</dt><dd>{sourceFrame}</dd>
            <dt>시간 (초)</dt><dd>{frameTimeSeconds(sourceFrame, result.fps)}</dd>
            <dt>예측</dt><dd data-value="predicted">{predicted}</dd>
            <dt>GT</dt><dd data-value="target">{target}</dd>
            <dt>오차</dt><dd>{predicted - target}</dd>
          </dl>
          : <p role="status" data-source-frame={sourceFrame}>선택한 원본 프레임 / 차원의 정확한 값은 사용할 수 없습니다.</p>}
      </>;
      break;
    }
    default: {
      const exhaustive: never = parsed;
      return exhaustive;
    }
  }
  return <div className="detail-panel"><Section title="에피소드 액션 비교" subtitle="선택 에피소드의 모든 평가 프레임 · 첫 스텝 예측과 정답">
    <div className="chart-controls">
      <Field label="결과 에피소드"><select id="episode-select" value={selectedEpisode} onChange={(event) => props.onEpisodeChange(Number(event.target.value))}>
        {!trace && <option value={selectedEpisode}>EP {selectedEpisode} · 사용 불가</option>}
        {result.traces.map((item) => <option key={item.episode} value={item.episode}>EP {item.episode}</option>)}
      </select></Field>
      <Field label="관절 / 액션 차원"><select id="dimension-select" value={selectedDimension} onChange={(event) => props.onDimensionChange(Number(event.target.value))}>
        {result.actionNames.map((name, index) => <option key={index} value={index}>{index} · {name}</option>)}
      </select></Field>
      <Field label="원본 프레임 검사"><input id="source-frame" type="number" min={0} step={1} value={sourceFrame} onChange={(event) => props.onSourceFrameChange(event.target.valueAsNumber)} /></Field>
      <Field label="구간 시작 원본 프레임"><input id="window-start" type="number" value={window.startFrame} onChange={(event) => props.onWindowChange({ ...window, startFrame: event.target.valueAsNumber })} /></Field>
      <Field label="구간 끝 원본 프레임 (포함)"><input id="window-end" type="number" value={window.endFrame} onChange={(event) => props.onWindowChange({ ...window, endFrame: event.target.valueAsNumber })} /></Field>
    </div>
    {content}
  </Section></div>;
}
