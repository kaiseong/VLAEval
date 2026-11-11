import { useEffect, useMemo, useState } from "react";
import { z } from "zod";
import type { Job } from "../../contracts";
import type { FkRequest } from "../../kinematics/contracts";
import { fkOverviewDataSchema } from "../analysis/fk-overview";
import type { FkOverviewData } from "../analysis/fk-overview";
import { OverviewGrid } from "./OverviewGrid";
import type { OverviewGridProps } from "./OverviewGrid";
import { DetailPanel } from "./DetailPanel";
import type { DetailNavigation } from "./DetailPanel";
import { createChannelLayout } from "../analysis/channel-layout";
import { overviewDisplayChannels } from "./overview-channels";

const replySchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("ready"), data: fkOverviewDataSchema }),
  z.object({ kind: z.literal("error"), reason: z.string() }),
]);

/** One Worker per admitted source; settings/episode changes discard old derived coordinates. */
export function FKOverview(props: Omit<OverviewGridProps, "onDetailOpen"> & {
  readonly request: FkRequest | null;
  readonly unavailable: string;
  readonly sourceChunks: NonNullable<Job["result"]>["samples"];
  readonly onDetailOpen: (dimension: number, mode: "joint" | "fk") => void;
  readonly detail?: DetailNavigation;
}) {
  const { request, unavailable, sourceChunks, onDetailOpen, detail, ...grid } = props;
  const channels = useMemo(() => overviewDisplayChannels(createChannelLayout(grid.actionNames), true), [grid.actionNames]);
  const source = useMemo(() => ({ request, chunks: sourceChunks, fps: grid.series.fps }),
    [request, sourceChunks, grid.series.fps]);
  const [state, setState] = useState<{
    readonly source: typeof source | null;
    readonly data: FkOverviewData | null;
    readonly error: string;
  }>({ source: null, data: null, error: "" });
  useEffect(() => {
    if (!source.request) return;
    const worker = new Worker("/assets/fk-overview.worker.js", { type: "module" });
    let current = true;
    worker.onmessage = (event: MessageEvent<unknown>) => {
      if (!current) return;
      const reply = replySchema.safeParse(event.data);
      if (!reply.success) {
        setState({ source, data: null, error: reply.error.message });
        return;
      }
      switch (reply.data.kind) {
        case "ready": setState({ source, data: reply.data.data, error: "" }); break;
        case "error": setState({ source, data: null, error: reply.data.reason }); break;
        default: { const exhaustive: never = reply.data; return exhaustive; }
      }
    };
    worker.onerror = (event) => {
      if (current) setState({ source, data: null, error: event.message || "FK Worker failed" });
    };
    worker.postMessage(source);
    return () => { current = false; worker.terminate(); };
  }, [source]);
  const current = state.source === source ? state : null;
  const pose = current?.data;
  return <div data-fk-overview-state={!request ? "unavailable" : pose ? "ready" : current?.error ? "error" : "pending"}>
    {!pose && <p role="status">{!request ? unavailable : current?.error || "전체 예측 청크와 GT를 FK로 변환 중입니다."}
      {" · "}{detail ? "FK 상세는 변환 완료 후 표시됩니다." : "변환 전까지 Joint 그래프를 표시합니다."}</p>}
    {pose && <p className="overview__notice">어깨 기준 x/y/z (mm), rx/ry/rz (deg) · R=Rz(rz)Ry(ry)Rx(rx).
      {" "}명령 관절값에서 계산한 말단 궤적이며 실측 궤적이 아닙니다. 특이점·각도 경계는 선을 끊어 표시합니다.
      {" "}상단 MAE/RMSE는 원본 Joint 기준입니다.</p>}
    {detail ? pose && <DetailPanel {...detail} trajectory={{ mode: "fk", channels }}
      sourceFrame={grid.sourceFrame ?? 0} window={grid.window} onSourceFrameChange={grid.onFrameSelect}
      renderPlot={() => <OverviewGrid key={`fk-${detail.selectedDimension}`} {...grid} pose={pose}
        detailDimension={detail.selectedDimension} onDetailOpen={(dimension) => onDetailOpen(dimension, "fk")} />} />
      : <OverviewGrid key={pose ? "fk" : "joint"} {...grid} {...(pose ? { pose } : {})}
        onDetailOpen={(dimension) => onDetailOpen(dimension, pose ? "fk" : "joint")} />}
  </div>;
}
