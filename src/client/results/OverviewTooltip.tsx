import { useMemo } from "react";
import type { TraceHover } from "../charts/TracePlot";
import { inspectOverviewFrame } from "./overview-inspection";
import type { OverviewChunk, OverviewSeries } from "./overview-inspection";

export function OverviewTooltip(props: {
  readonly hover: TraceHover;
  readonly dimension: number;
  readonly channelName: string;
  readonly unit: string;
  readonly series: OverviewSeries;
  readonly chunks: readonly OverviewChunk[];
  readonly drawnFrames: ReadonlySet<number>;
  readonly origin?: number | null;
  readonly onClose: () => void;
}) {
  const { hover, dimension, series, chunks, drawnFrames } = props;
  const values = useMemo(() => inspectOverviewFrame({
    frame: hover.frame, dimension, series, chunks, drawnFrames, origin: props.origin ?? null,
  }), [hover.frame, dimension, series, chunks, drawnFrames, props.origin]);
  const width = Math.min(480, globalThis.innerWidth - 32);
  const maxHeight = Math.min(360, globalThis.innerHeight - 32);
  const left = Math.max(16, Math.min(globalThis.innerWidth - width - 16,
    hover.clientX + width + 16 <= globalThis.innerWidth ? hover.clientX + 16 : hover.clientX - width - 16));
  const top = Math.max(16, Math.min(hover.clientY + 16, globalThis.innerHeight - maxHeight - 16));
  return <aside className="overview-tooltip" data-overview-tooltip data-frame={hover.frame}
    role="region" aria-label="시간축 상세 값" tabIndex={0}
    style={{ left, top, width, maxHeight }}>
    <header><div><strong>{props.channelName}</strong>
      <div>프레임 {hover.frame} · {(hover.frame / series.fps).toFixed(3)}초 · {props.unit}</div></div>
      <button type="button" onClick={props.onClose}>닫기</button></header>
    <dl>
      <div><dt><i className="overview__legend-gt" />GT (정답)</dt>
        <dd data-value="gt">{values.target === null ? "값 없음" : String(values.target)}</dd></div>
      {chunks.length === 0 && <div><dt><i />예측</dt>
        <dd data-value="predicted">{values.firstStep === null ? "값 없음" : String(values.firstStep)}</dd></div>}
    </dl>
    {chunks.length > 0 && <>
      <p>이 시점의 예측 {values.predictions.length}개 · 스텝 h는 0부터</p>
      {values.predictions.length > 0 ? <table>
        <thead><tr><th>추론 시작</th><th>스텝 / H</th><th>예측값 ({props.unit})</th></tr></thead>
        <tbody>{values.predictions.map((prediction) => <tr key={prediction.origin}
          data-origin={prediction.origin} data-step={prediction.step} data-drawn={prediction.drawn}>
          <td><i style={{ borderTopColor: prediction.color }} />프레임 {prediction.origin}
            {!prediction.drawn && <small>그래프 생략</small>}</td>
          <td>h={prediction.step} / {prediction.horizon}</td>
          <td data-value="prediction">{String(prediction.value)}</td>
        </tr>)}</tbody>
      </table> : <p>유효한 예측값 없음</p>}
    </>}
  </aside>;
}
