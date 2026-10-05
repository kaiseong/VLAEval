import type { ReactNode } from "react";
import type { Job } from "../../contracts";
import { Field, Section } from "../ui/primitives";

type Result = NonNullable<Job["result"]>;
type ChunkSample = Result["samples"][number];

export type ChunkPoint = {
  readonly frame: number;
  readonly predicted: number | undefined;
  readonly target: number | undefined;
};

export interface ChunkPanelProps {
  readonly result: Pick<Result, "samples" | "traces" | "actionNames" | "fps">;
  readonly selectedEpisode: number;
  readonly selectedOriginFrame: number;
  readonly selectedHorizon: number;
  readonly selectedDimension: number;
  readonly onEpisodeChange: (episode: number) => void;
  readonly onOriginFrameChange: (frame: number) => void;
  readonly onHorizonChange: (horizon: number) => void;
  readonly onDimensionChange: (dimension: number) => void;
  readonly renderPlot: (context: ChunkPlotContext) => ReactNode;
}

export type ChunkPlotContext = Omit<ChunkPanelProps, "result" | "renderPlot"> & {
  readonly sample: ChunkSample;
  readonly points: readonly ChunkPoint[];
  readonly fps: number;
  readonly title: string;
};

export function ChunkPanel(props: ChunkPanelProps) {
  const { result, selectedEpisode, selectedOriginFrame, selectedHorizon, selectedDimension } = props;
  const episodes = Array.from(new Set([
    ...result.traces.map((trace) => trace.episode), ...result.samples.map((sample) => sample.episode),
  ])).sort((a, b) => a - b);
  const origins = result.samples.filter((sample) => sample.episode === selectedEpisode);
  const sample = origins.find((item) => item.frame === selectedOriginFrame);
  const predicted = sample?.predicted[selectedHorizon]?.[selectedDimension];
  const target = sample?.target[selectedHorizon]?.[selectedDimension];
  const available = sample !== undefined && Number.isSafeInteger(selectedHorizon)
    && selectedHorizon >= 0 && sample.valid[selectedHorizon] === true
    && predicted !== undefined && target !== undefined;
  return <div className="chunk-panel"><Section title="미래 액션 청크" subtitle="저장된 청크 샘플 · 전체 유효 청크 지표와 별개의 선택 검사">
    <div className="chart-controls">
      <Field label="청크 에피소드"><select id="chunk-episode" value={selectedEpisode} onChange={(event) => props.onEpisodeChange(Number(event.target.value))}>
        {!episodes.includes(selectedEpisode) && <option value={selectedEpisode}>EP {selectedEpisode} · 사용 불가</option>}
        {episodes.map((episode) => <option key={episode} value={episode}>EP {episode}</option>)}
      </select></Field>
      <Field label="청크 원본 시작 프레임"><select id="chunk-origin" value={selectedOriginFrame} onChange={(event) => props.onOriginFrameChange(Number(event.target.value))}>
        {!sample && <option value={selectedOriginFrame}>{selectedOriginFrame} · 저장된 샘플 없음</option>}
        {origins.map((item) => <option key={item.frame} value={item.frame}>{item.frame}</option>)}
      </select></Field>
      <Field label="Horizon 스텝 (0부터)"><input id="chunk-horizon" type="number" min={0} step={1} value={selectedHorizon} onChange={(event) => props.onHorizonChange(event.target.valueAsNumber)} /></Field>
      <Field label="관절 / 액션 차원"><select id="chunk-dimension" value={selectedDimension} onChange={(event) => props.onDimensionChange(Number(event.target.value))}>
        {result.actionNames.map((name, index) => <option key={index} value={index}>{index} · {name}</option>)}
      </select></Field>
    </div>
    {available ? <>
      <p className="muted path">작업: {sample.prompt || "설명 없음"}</p>
      {props.renderPlot({
        sample, fps: result.fps, selectedEpisode, selectedOriginFrame, selectedHorizon, selectedDimension,
        title: `EP ${selectedEpisode} / 프레임 ${selectedOriginFrame} · ${result.actionNames[selectedDimension] ?? `action_${selectedDimension}`}`,
        points: sample.predicted.map((prediction, horizon) => ({
          frame: horizon, predicted: sample.valid[horizon] ? prediction[selectedDimension] : undefined,
          target: sample.valid[horizon] ? sample.target[horizon]?.[selectedDimension] : undefined,
        })),
        onEpisodeChange: props.onEpisodeChange, onOriginFrameChange: props.onOriginFrameChange,
        onHorizonChange: props.onHorizonChange, onDimensionChange: props.onDimensionChange,
      })}
      <dl className="point-inspector mono" data-origin-frame={selectedOriginFrame} data-horizon={selectedHorizon}>
        <dt>예측</dt><dd data-value="predicted">{predicted}</dd>
        <dt>GT</dt><dd data-value="target">{target}</dd>
        <dt>오차</dt><dd>{predicted - target}</dd>
      </dl>
    </> : <p role="status" className="empty compact" data-availability="unavailable">
      EP {selectedEpisode} / 원본 프레임 {selectedOriginFrame} / horizon {selectedHorizon}: 저장된 유효 청크를 사용할 수 없습니다.
    </p>}
  </Section></div>;
}
