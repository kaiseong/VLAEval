import { useMemo, useState } from "react";
import type { ErrorRange, JobSummary } from "../../contracts";
import { computeLabel, runDevice } from "../api";
import { Field, Section } from "../ui/primitives";
import { formatMetric, metricLabels, metricMse } from "../analysis/metrics";
import { comparisonDifferences, comparisonDifferenceLabels, isCompletedEvaluation } from "../analysis/run-comparison";
import type { CompletedEvaluation } from "../analysis/run-comparison";
import "./evaluation-results.css";

const rangeAt = (range: ErrorRange) => `EP ${range.at.episode} · frame ${range.at.frame} · step ${range.at.step} · ${range.at.dimension}`;

const checkpointName = (job: CompletedEvaluation) => job.result.checkpoint.split("/").filter(Boolean).slice(-2).join("/");
/** How many frames were inferred, over how many episodes, so runs of different scope are told apart. */
const runScope = (job: CompletedEvaluation) =>
  `추론 ${job.result.framesEvaluated.toLocaleString()}프레임 · EP ${job.result.perEpisode.length}개`;
const runLabel = (job: CompletedEvaluation) =>
  `${job.result.config} · ${runDevice(job.request)} · ${runScope(job)} · ${checkpointName(job)} · ${new Date(job.createdAt).toLocaleString("ko-KR")} · ${job.id.slice(0, 8)}`;

export function EvaluationResults({ jobs, selectedId, onSelect }: {
  readonly jobs: readonly JobSummary[];
  readonly selectedId: string;
  readonly onSelect: (id: string) => void;
}) {
  const completed = useMemo(() => jobs.filter(isCompletedEvaluation), [jobs]);
  const [comparisonIds, setComparisonIds] = useState<readonly string[]>([]);
  const base = completed.find((job) => job.id === selectedId) ?? completed[0];
  const selectedJobs = useMemo(() => base ? [base, ...completed.filter((job) =>
    job.id !== base.id && comparisonIds.includes(job.id))] : [], [base, completed, comparisonIds]);
  const entries = useMemo(() => selectedJobs.map((job) => ({
    job, episodes: job.result.episodeChunkMetrics,
    differences: base && job.id !== base.id ? comparisonDifferences(base, job) : [],
  })), [selectedJobs, base]);
  const episodes = [...new Set(entries.flatMap((entry) => entry.episodes.map((item) => item.episode)))].sort((a, b) => a - b);
  const identity = (job: CompletedEvaluation) => <div className="evaluation-model">
    <strong>{job.result.config}{job.id === base?.id ? " · 기준" : ""}</strong>
    <span title={job.result.checkpoint}>{checkpointName(job)}</span>
    <span data-run-device>추론: {runDevice(job.request)}</span>
    <span data-run-scope>{runScope(job)}</span>
    <small>{new Date(job.createdAt).toLocaleString("ko-KR")} · {job.id.slice(0, 8)}</small>
  </div>;
  const headings = <><th scope="col">모델 / 체크포인트</th><th scope="col">평가 프레임</th>
    <th scope="col">유효 청크 행</th><th scope="col">{metricLabels.mae}</th>
    <th scope="col">{metricLabels.mse}</th><th scope="col">{metricLabels.rmse}</th>
    <th scope="col">p99 오차 (|예측−정답|)</th><th scope="col">최대 오차 (|예측−정답|)</th></>;
  const metricCells = (mae: number | null, mse: number | null, rmse: number | null) =>
    <><td data-metric="mae" data-value={mae ?? "unavailable"}>{formatMetric(mae)}</td>
      <td data-metric="mse" data-value={mse ?? "unavailable"}>{formatMetric(mse)}</td>
      <td data-metric="rmse" data-value={rmse ?? "unavailable"}>{formatMetric(rmse)}</td></>;
  const rangeCells = (range: ErrorRange | null | undefined) =>
    <><td data-metric="p99" data-value={range?.p99 ?? "unavailable"}>{formatMetric(range?.p99 ?? null)}</td>
      <td data-metric="max" data-value={range?.max ?? "unavailable"} title={range ? rangeAt(range) : undefined}>
        {formatMetric(range?.max ?? null)}{range && <small className="evaluation-max-at">{rangeAt(range)}</small>}</td></>;

  return <div className="evaluation-results">
    <Section title="평가 결과" subtitle="전체 에피소드와 각 EP의 전체 청크 오차 · 유효 마스크 적용 · 원본 액션 기준">
      {!base ? <p role="status">완료된 평가가 없습니다. 평가를 완료하면 저장된 모델 간 결과를 비교할 수 있습니다.</p> : <>
        <Field label="기준 평가"><select data-evaluation-base value={base.id} onChange={(event) => onSelect(event.currentTarget.value)}>
          {completed.map((job) => <option key={job.id} value={job.id}>{runLabel(job)}</option>)}
        </select></Field>
        <details className="evaluation-compare">
          <summary>다른 모델 / 체크포인트 비교 ({selectedJobs.length - 1}개 선택)</summary>
          {completed.length < 2 ? <p className="muted">비교할 다른 완료 실행이 없습니다. 다른 모델로 평가한 뒤 이곳에서 선택하세요.</p>
            : <fieldset><legend>함께 표시할 저장된 평가</legend>
              {completed.filter((job) => job.id !== base.id).map((job) => <label key={job.id}>
                <input type="checkbox" data-compare-run={job.id} checked={comparisonIds.includes(job.id)}
                  onChange={(event) => {
                    // Read now: React may run the updater after the event, when currentTarget is null.
                    const checked = event.currentTarget.checked;
                    setComparisonIds((current) => checked ? [...current, job.id] : current.filter((id) => id !== job.id));
                  }} />
                <span>{runLabel(job)}</span>
              </label>)}
            </fieldset>}
        </details>
        {entries.length > 1 && <div className="evaluation-comparison-status" role="status">
          {entries.slice(1).map(({ job, differences }) => <p key={job.id} data-comparison-job={job.id}
            data-comparison-status={differences.length ? "different" : "matched"}>
            <strong>{job.result.config} · {job.id.slice(0, 8)}</strong>: {differences.length
              ? `조건 차이: ${differences.map((key) => comparisonDifferenceLabels[key] ?? key).join(", ")}. 직접 순위 비교에 주의하세요.`
              : "기록된 평가 범위와 설정이 같습니다."}</p>)}
          <p className="muted">동일 경로라도 데이터셋 내용·액션 단위/표현의 일치 여부는 저장 기록만으로 보장되지 않습니다.</p>
        </div>}
        <div className="table-scroll" tabIndex={0} role="region" aria-label="전체 에피소드 전체 청크 결과">
          <table data-evaluation-table="overall"><caption>전체 에피소드 · 전체 청크</caption>
            <thead><tr>{headings}</tr></thead><tbody>
              {entries.map(({ job }) => <tr key={job.id} data-result-run={job.id}>
                <th scope="row">{identity(job)}</th><td>{job.result.framesEvaluated.toLocaleString()}</td>
                <td>{job.result.validSteps.toLocaleString()}</td>
                {metricCells(job.result.mae, metricMse(job.result.mse, job.result.rmse), job.result.rmse)}
                {rangeCells(job.result.errorRange.overall)}
              </tr>)}
            </tbody></table>
        </div>
        <div className="table-scroll" tabIndex={0} role="region" aria-label="EP별 전체 청크 결과">
          <table data-evaluation-table="episodes"><caption>모든 EP · 전체 청크</caption>
            <thead><tr><th scope="col">EP</th>{headings}</tr></thead><tbody>
              {episodes.flatMap((episode) => entries.map(({ job, episodes: metrics }) => {
                const item = metrics.find((row) => row.episode === episode);
                return <tr key={`${episode}-${job.id}`} data-result-run={job.id} data-result-episode={episode}>
                  <th scope="row">EP {episode}</th><td>{identity(job)}
                    {(!item || item.reason) && <small className="evaluation-unavailable" title={item?.reason ?? undefined}>
                      {item ? "저장된 전체 청크가 부족하거나 일치하지 않습니다." : "이 실행에서 평가하지 않은 EP"}</small>}
                  </td><td>{item?.framesEvaluated.toLocaleString() ?? "—"}</td>
                  <td>{item?.validSteps?.toLocaleString() ?? "—"}</td>
                  {metricCells(item?.mae ?? null, item?.mse ?? null, item?.rmse ?? null)}
                  {rangeCells(job.result.errorRange.episodes.find((range) => range.episode === episode))}
                </tr>;
              }))}
            </tbody></table>
        </div>
        <p className="muted">전체 값은 유효 비교 수로 통합하며 EP별 평균의 단순 평균이 아닙니다.
          {" "}MAE/RMSE와 p99/최대 오차는 원본 단위, MSE는 원본 단위의 제곱입니다. p99/최대는 유효 청크 행의 모든 스텝·차원
          오차에서 구하므로(p99는 nearest rank) 단위가 다른 차원(관절 rad, 그리퍼 등)이 섞입니다. 최대 오차 아래에 위치(EP·frame·step·차원)를 적었습니다. 부족한 저장 데이터는 —로 표시합니다.</p>
        <details className="evaluation-provenance"><summary>비교 실행 정보</summary>
          {entries.map(({ job }) => <div key={job.id}><strong>{runLabel(job)}</strong>
            <p>데이터셋: {job.result.dataset}</p><p>체크포인트: {job.result.checkpoint}</p>
            <p>EP: {job.result.perEpisode.map((item) => item.episode).join(", ")} · FPS {job.result.fps}
              {" · "}stride {job.request.stride} · 최대 프레임 {job.request.maxSamples || "전체"}
              {" · "}seed {job.result.seed} · 추론 스텝 {job.result.numSteps}</p>
          </div>)}
        </details>
      </>}
    </Section>
  </div>;
}
