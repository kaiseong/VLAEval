import { useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { Download, FileJson, LineChart } from "lucide-react";
import type { z } from "zod";
import { resultSchema, type Job } from "../contracts";
import { Field, Section } from "./App";

type Result = z.infer<typeof resultSchema>;
type Point = { readonly frame: number; readonly predicted: number | undefined; readonly target: number | undefined };

const format = (value: number | null | undefined) => value == null ? "—" : value.toLocaleString("ko-KR", { maximumFractionDigits: 6 });

function download(filename: string, content: string, type: string) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function csvCell(value: string | number): string {
  return `"${String(value).replaceAll('"', '""')}"`;
}

function traceCsv(result: Result): string {
  const rows = ["episode,frame,time_seconds,dimension,action,predicted,target,error"];
  for (const trace of result.traces) {
    trace.frames.forEach((frame, index) => {
      const predicted = trace.predicted[index] ?? [];
      const target = trace.target[index] ?? [];
      for (let dimension = 0; dimension < Math.max(predicted.length, target.length); dimension += 1) {
        const prediction = predicted[dimension];
        const truth = target[dimension];
        rows.push([
          trace.episode, frame, frame / result.fps, dimension,
          result.actionNames[dimension] ?? `action_${dimension}`, prediction ?? "",
          truth ?? "", prediction == null || truth == null ? "" : prediction - truth,
        ].map(csvCell).join(","));
      }
    });
  }
  return "\ufeff" + rows.join("\r\n");
}

function Metric({ label, value, detail }: { readonly label: string; readonly value: number; readonly detail: string }) {
  return <div className="metric"><span>{label}</span><strong>{format(value)}</strong><small>{detail}</small></div>;
}

function MetricTable({ caption, headings, children }: {
  readonly caption: string; readonly headings: readonly string[]; readonly children: ReactNode;
}) {
  return <div className="table-scroll" tabIndex={0} role="region" aria-label={caption}>
    <table><caption>{caption}</caption><thead><tr>{headings.map((heading) => <th scope="col" key={heading}>{heading}</th>)}</tr></thead><tbody>{children}</tbody></table>
  </div>;
}

function TraceChart({ points, title, fps, horizon = false }: {
  readonly points: readonly Point[]; readonly title: string; readonly fps: number; readonly horizon?: boolean;
}) {
  const [inspect, setInspect] = useState(0);
  const [width, setWidth] = useState(980);
  const svgRef = useRef<SVGSVGElement | null>(null);
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry && entry.contentRect.width > 0) setWidth(entry.contentRect.width);
    });
    observer.observe(svg);
    return () => observer.disconnect();
  }, []);
  const geometry = useMemo(() => {
    let min = Infinity;
    let max = -Infinity;
    for (const point of points) {
      for (const value of [point.predicted, point.target]) {
        if (value !== undefined) { min = Math.min(min, value); max = Math.max(max, value); }
      }
    }
    if (!Number.isFinite(min)) return null;
    const padding = (max - min || Math.abs(max) * 0.1 || 1) * 0.08;
    min -= padding; max += padding;
    const start = points[0]?.frame ?? 0;
    const end = points[points.length - 1]?.frame ?? start;
    const x = (frame: number) => 68 + ((frame - start) / (end - start || 1)) * Math.max(1, width - 92);
    const y = (value: number) => 280 - ((value - min) / (max - min)) * 248;
    function path(key: "predicted" | "target") {
      let connected = false;
      return points.map((point) => {
        const value = point[key];
        if (value === undefined) { connected = false; return ""; }
        const command = `${connected ? "L" : "M"}${x(point.frame).toFixed(2)},${y(value).toFixed(2)}`;
        connected = true;
        return command;
      }).join(" ");
    }
    return { min, max, start, end, x, y, predicted: path("predicted"), target: path("target") };
  }, [points, width]);
  const point = points[Math.min(inspect, Math.max(0, points.length - 1))];
  if (!geometry || !points.length) return <div className="empty compact"><p>이 선택에 유효한 액션 데이터가 없습니다.</p></div>;
  return <figure className="trace-figure">
    <figcaption className="cluster spread"><strong>{title}</strong><span className="legend"><span><i className="prediction-line" />예측</span><span><i className="target-line" />정답 (GT)</span></span></figcaption>
    <svg ref={svgRef} className="trace-chart" viewBox={`0 0 ${width} 340`} role="img" aria-label={`${title}. 예측은 실선, 정답은 점선. 아래 프레임 검사와 CSV에서 정확한 값을 확인할 수 있습니다.`}>
      <title>{title}</title><desc>{horizon ? "미래 청크의 유효 horizon 액션 비교." : "모든 평가 프레임의 첫 스텝 액션 비교."} 액션 단위는 데이터셋을 따릅니다.</desc>
      {(width < 500 ? [0, 2, 4] : [0, 1, 2, 3, 4]).map((tick) => {
        const value = geometry.min + ((geometry.max - geometry.min) / 4) * tick;
        const frame = geometry.start + ((geometry.end - geometry.start) / 4) * tick;
        return <g key={tick}><line className="grid-line" x1={68} x2={width - 24} y1={geometry.y(value)} y2={geometry.y(value)} /><text x={58} y={geometry.y(value) + 5} textAnchor="end">{value.toFixed(3)}</text><text x={geometry.x(frame)} y={306} textAnchor="middle">{horizon ? format(frame) : (frame / fps).toFixed(2)}</text></g>;
      })}
      <text x={68} y={20}>액션 값</text><text x={width / 2} y={332} textAnchor="middle">{horizon ? "예측 horizon 스텝 (0부터)" : "에피소드 시간 (초)"}</text>
      <path className="predicted-path" d={geometry.predicted} /><path className="target-path" d={geometry.target} />
      {points.length === 1 && point && <g>{point.predicted !== undefined && <circle className="predicted-dot" cx={geometry.x(point.frame)} cy={geometry.y(point.predicted)} r={4} />}{point.target !== undefined && <circle className="target-dot" cx={geometry.x(point.frame)} cy={geometry.y(point.target)} r={3} />}</g>}
      {point && <line className="inspection-line" x1={geometry.x(point.frame)} x2={geometry.x(point.frame)} y1={32} y2={280} />}
    </svg>
    <div className="point-inspector">
      <Field label={horizon ? "horizon 검사 위치" : "평가 프레임 검사 위치"}><input type="range" min={0} max={points.length - 1} step={1} value={Math.min(inspect, points.length - 1)} onChange={(event) => setInspect(event.target.valueAsNumber)} /></Field>
      <p className="mono">{horizon ? "스텝" : "프레임"} {point?.frame} {!horizon && point ? `· ${(point.frame / fps).toFixed(3)}초` : ""} · 예측 {format(point?.predicted)} · GT {format(point?.target)} · 오차 {point?.predicted == null || point.target == null ? "—" : format(point.predicted - point.target)}</p>
    </div>
  </figure>;
}

export function Results({ job }: { readonly job: Job }) {
  return job.result ? <ResultView job={job} result={job.result} /> : null;
}

function ResultView({ job, result }: { readonly job: Job; readonly result: Result }) {
  const [episode, setEpisode] = useState(result.traces[0]?.episode ?? -1);
  const [dimension, setDimension] = useState(0);
  const [sampleIndex, setSampleIndex] = useState(0);
  const [metricTab, setMetricTab] = useState<"episode" | "dimension" | "horizon">("episode");
  const [exportError, setExportError] = useState("");
  const trace = result.traces.find((item) => item.episode === episode);
  const actionName = result.actionNames[dimension] ?? `action_${dimension}`;
  const points = useMemo(() => trace?.frames.map((frame, index) => ({
    frame, predicted: trace.predicted[index]?.[dimension], target: trace.target[index]?.[dimension],
  })) ?? [], [trace, dimension]);
  const sample = result.samples[sampleIndex];
  const horizonPoints = useMemo(() => sample?.predicted.map((prediction, index) => ({
    frame: index, predicted: sample.valid[index] ? prediction[dimension] : undefined,
    target: sample.valid[index] ? sample.target[index]?.[dimension] : undefined,
  })) ?? [], [sample, dimension]);

  function exportData(kind: "json" | "csv") {
    setExportError("");
    try {
      download(`vlaeval-${job.id}.${kind}`, kind === "json" ? JSON.stringify(result, null, 2) : traceCsv(result),
        kind === "json" ? "application/json;charset=utf-8" : "text/csv;charset=utf-8");
    } catch (cause) {
      setExportError(cause instanceof Error ? `내보내기 실패: ${cause.message}` : "내보내기에 실패했습니다.");
    }
  }

  return <div className="result-stack">
    <Section title="평가 결과" subtitle={`${new Date(job.createdAt).toLocaleString("ko-KR")} · ${result.config}`}>
      <div className="cluster spread"><p className="muted">선택 실행의 결과 · {result.framesEvaluated.toLocaleString()} 프레임 · {result.fps} FPS</p><div className="cluster"><button onClick={() => exportData("json")}><FileJson size={16} aria-hidden="true" />결과 JSON</button><button disabled={!result.traces.length} onClick={() => exportData("csv")}><Download size={16} aria-hidden="true" />전체 trace CSV</button></div></div>
      {exportError && <p role="alert" className="notice error">{exportError}</p>}
      <div className="metrics-grid">
        <Metric label="첫 스텝 MAE" value={result.firstStepMae} detail="평가 프레임의 즉시 액션" />
        <Metric label="첫 스텝 RMSE" value={result.firstStepRmse} detail="평가 프레임의 즉시 액션" />
        <Metric label="전체 청크 MAE" value={result.mae} detail={`${result.validSteps.toLocaleString()} 유효 horizon 스텝`} />
        <Metric label="전체 청크 RMSE" value={result.rmse} detail="전체 유효 청크 액션" />
      </div>
      <div className="cluster result-meta"><span>추론 지연 중앙값 <strong>{format(result.latencyMs.median)} ms</strong></span><span>p95 <strong>{format(result.latencyMs.p95)} ms</strong></span><span>시드 {result.seed}</span><span>추론 {result.numSteps} 스텝</span><span>stride {job.request.stride}</span><span>최대 프레임 {job.request.maxSamples === 0 ? "전체" : job.request.maxSamples}</span></div>
      <details className="artifact-details"><summary>이 결과의 아티팩트 경로</summary><dl><dt>호스트</dt><dd className="path">{job.request.host}</dd><dt>저장소</dt><dd className="path">{job.request.repo}</dd><dt>체크포인트</dt><dd className="path">{result.checkpoint}</dd><dt>데이터셋</dt><dd className="path">{result.dataset}</dd><dt>에피소드</dt><dd className="path">{job.request.episodes.join(", ")}</dd></dl></details>
      {result.warnings.length > 0 && <div className="notice"><strong>평가 주의사항</strong>{result.warnings.map((warning, index) => <p key={index}>{warning}</p>)}</div>}
    </Section>
    <Section title="에피소드 액션 비교" subtitle="모든 평가 프레임의 첫 스텝 예측과 정답입니다. 현재 준비 설정과 무관하게 선택한 실행의 데이터를 표시합니다.">
      <div className="chart-controls"><Field label="결과 에피소드"><select value={episode} disabled={!result.traces.length} onChange={(event) => setEpisode(Number(event.target.value))}>{result.traces.map((item) => <option key={item.episode} value={item.episode}>EP {item.episode} · {item.frames.length.toLocaleString()} 평가 프레임</option>)}</select></Field><Field label="관절 / 액션 차원"><select value={dimension} disabled={!result.actionNames.length} onChange={(event) => setDimension(Number(event.target.value))}>{result.actionNames.map((name, index) => <option key={index} value={index}>{index} · {name}</option>)}</select></Field></div>
      {trace ? <TraceChart key={`${episode}-${dimension}`} points={points} title={`EP ${episode} · ${actionName}`} fps={result.fps} /> : <div className="empty compact"><LineChart aria-hidden="true" /><p>저장된 에피소드 trace가 없습니다.</p></div>}
      <p className="muted">단위는 데이터셋의 액션 표현을 따릅니다. CSV는 모든 에피소드와 차원의 첫 스텝 trace를 포함합니다.</p>
    </Section>
    <Section title="수치 지표" subtitle="에피소드 지표는 첫 action 기준, 차원별·horizon별 지표는 전체 유효 청크 기준입니다.">
      <div className="metric-tabs" role="group" aria-label="지표 범위"><button aria-pressed={metricTab === "episode"} className={metricTab === "episode" ? "selected" : ""} onClick={() => setMetricTab("episode")}>에피소드</button><button aria-pressed={metricTab === "dimension"} className={metricTab === "dimension" ? "selected" : ""} onClick={() => setMetricTab("dimension")}>차원 · 청크</button><button aria-pressed={metricTab === "horizon"} className={metricTab === "horizon" ? "selected" : ""} onClick={() => setMetricTab("horizon")}>Horizon · 청크</button></div>
      {metricTab === "episode" && <MetricTable caption="에피소드별 오차 · 첫 action 기준" headings={["에피소드", "평가 프레임", "MAE", "RMSE"]}>{result.perEpisode.map((item) => <tr key={item.episode}><th scope="row">EP {item.episode}</th><td>{item.framesEvaluated.toLocaleString()}</td><td>{format(item.mae)}</td><td>{format(item.rmse)}</td></tr>)}</MetricTable>}
      {metricTab === "dimension" && <MetricTable caption="액션 차원별 전체 청크 오차" headings={["액션 차원", "MAE", "RMSE"]}>{result.perDimension.map((item, index) => <tr key={index}><th scope="row">{item.name}</th><td>{format(item.mae)}</td><td>{format(item.rmse)}</td></tr>)}</MetricTable>}
      {metricTab === "horizon" && <MetricTable caption="Horizon별 전체 청크 오차 · 유효 비교가 없으면 —" headings={["Horizon 스텝", "유효 개수", "MAE", "RMSE"]}>{result.perHorizon.map((item) => <tr key={item.step}><th scope="row">{item.step}</th><td>{item.count.toLocaleString()}</td><td>{format(item.mae)}</td><td>{format(item.rmse)}</td></tr>)}</MetricTable>}
    </Section>
    <Section title="미래 액션 청크" subtitle="저장된 제한 개수의 청크 샘플입니다. 전체 에피소드 trace가 아니며 유효 horizon만 비교합니다.">
      {result.samples.length ? <><Field label="청크 샘플"><select value={sampleIndex} onChange={(event) => setSampleIndex(Number(event.target.value))}>{result.samples.map((item, index) => <option key={index} value={index}>EP {item.episode} · 프레임 {item.frame}</option>)}</select></Field>{sample && <><p className="muted path">작업: {sample.prompt || "설명 없음"} · 액션 차원: {actionName}</p><TraceChart key={`sample-${sampleIndex}-${dimension}`} points={horizonPoints} title={`EP ${sample.episode} / 프레임 ${sample.frame} · ${actionName}`} fps={result.fps} horizon /></>}</> : <p className="empty compact">저장된 청크 샘플이 없습니다.</p>}
    </Section>
  </div>;
}
