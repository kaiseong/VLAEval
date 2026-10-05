import type { ReactNode } from "react";
import type { Job } from "../../contracts";
import { Section } from "../ui/primitives";

type Result = NonNullable<Job["result"]>;
type MetricTab = "episode" | "dimension" | "horizon";

export interface MetricTablesProps {
  readonly result: Pick<Result, "perEpisode" | "perDimension" | "perHorizon">;
  readonly metricTab: MetricTab;
  readonly onMetricTabChange: (tab: MetricTab) => void;
}

const format = (value: number | null) => value === null
  ? "—" : value.toLocaleString("ko-KR", { maximumFractionDigits: 6 });

export function MetricTables({ result, metricTab, onMetricTabChange }: MetricTablesProps) {
  let caption: string;
  let headings: readonly string[];
  let rows: ReactNode;
  switch (metricTab) {
    case "episode":
      caption = "에피소드별 오차 · 첫 action 기준";
      headings = ["에피소드", "평가 프레임", "MAE", "RMSE"];
      rows = result.perEpisode.map((item) => <tr key={item.episode}>
        <th scope="row">EP {item.episode}</th><td>{item.framesEvaluated.toLocaleString("ko-KR")}</td>
        <td>{format(item.mae)}</td><td>{format(item.rmse)}</td>
      </tr>);
      break;
    case "dimension":
      caption = "액션 차원별 전체 청크 오차";
      headings = ["액션 차원", "MAE", "RMSE"];
      rows = result.perDimension.map((item, index) => <tr key={index}>
        <th scope="row">{item.name}</th><td>{format(item.mae)}</td><td>{format(item.rmse)}</td>
      </tr>);
      break;
    case "horizon":
      caption = "Horizon별 전체 청크 오차 · 유효 비교가 없으면 —";
      headings = ["Horizon 스텝", "유효 개수", "MAE", "RMSE"];
      rows = result.perHorizon.map((item) => <tr key={item.step}>
        <th scope="row">{item.step}</th><td>{item.count.toLocaleString("ko-KR")}</td>
        <td>{format(item.mae)}</td><td>{format(item.rmse)}</td>
      </tr>);
      break;
    default: {
      const exhaustive: never = metricTab;
      return exhaustive;
    }
  }
  return <div className="metric-tables" style={{ minWidth: 0 }}><Section title="수치 지표" subtitle="에피소드: 첫 action · 차원 / horizon: 실행 전체 유효 청크">
    <div className="metric-tabs" role="group" aria-label="지표 범위">
      <button aria-pressed={metricTab === "episode"} className={metricTab === "episode" ? "selected" : ""} onClick={() => onMetricTabChange("episode")}>에피소드</button>
      <button aria-pressed={metricTab === "dimension"} className={metricTab === "dimension" ? "selected" : ""} onClick={() => onMetricTabChange("dimension")}>차원 · 청크</button>
      <button aria-pressed={metricTab === "horizon"} className={metricTab === "horizon" ? "selected" : ""} onClick={() => onMetricTabChange("horizon")}>Horizon · 청크</button>
    </div>
    <div className="table-scroll" tabIndex={0} role="region" aria-label={caption}>
      <table style={{ minWidth: "max-content" }} data-metric-scope={metricTab === "episode" ? "episode-first-step" : "run-chunk"} data-metric-tab={metricTab}>
        <caption>{caption}</caption>
        <thead><tr>{headings.map((heading) => <th scope="col" key={heading} style={{ whiteSpace: "nowrap", overflowWrap: "normal" }}>{heading}</th>)}</tr></thead>
        <tbody>{rows}</tbody>
      </table>
    </div>
  </Section></div>;
}
