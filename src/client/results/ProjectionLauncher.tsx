import { useEffect, useRef, useState } from "react";
import { z } from "zod";
import { api, errorMessage } from "../api";

const calibrationSchema = z.object({
  label: z.string(), description: z.string(),
  bindings: z.array(z.object({ dataset: z.string(), label: z.string(), provenance: z.string() })),
});

export function ProjectionLauncher({ jobId, dataset, episode, frame, enabled, onCompleted }: {
  readonly jobId: string; readonly dataset: string; readonly episode: number; readonly frame: number | null;
  readonly enabled: boolean; readonly onCompleted: () => void;
}) {
  const [calibration, setCalibration] = useState<z.infer<typeof calibrationSchema> | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const active = useRef<AbortController | null>(null);
  const completed = useRef(onCompleted);
  completed.current = onCompleted;
  const binding = calibration?.bindings.find((item) => item.dataset === dataset);
  useEffect(() => {
    const controller = new AbortController();
    void api.get("/api/projection/calibration", { signal: controller.signal }).json<unknown>()
      .then((value) => { if (!controller.signal.aborted) setCalibration(calibrationSchema.parse(value)); })
      .catch(async (cause: unknown) => {
        if (!controller.signal.aborted) {
          const message = await errorMessage(cause);
          if (!controller.signal.aborted) setError(message);
        }
      });
    return () => { controller.abort(); active.current?.abort(); active.current = null; };
  }, []);
  async function capture() {
    if (frame === null || pending) return;
    const controller = new AbortController();
    active.current = controller;
    setPending(true); setError("");
    try {
      await api.post(`/api/jobs/${jobId}/projection`, {
        json: { episode, frame }, signal: controller.signal, timeout: 120_000,
      });
      if (!controller.signal.aborted) completed.current();
    } catch (cause) {
      if (!controller.signal.aborted) {
        const message = await errorMessage(cause);
        if (!controller.signal.aborted) setError(message);
      }
    } finally {
      if (active.current === controller) { active.current = null; setPending(false); }
    }
  }
  return <div className="projection-launcher">
    <strong>양팔 TCP 궤적 투영</strong>
    <p>{calibration?.label ?? "보정 정보 확인 중"}</p>
    {calibration && <small>{calibration.description}</small>}
    {binding && <small data-projection-binding={binding.dataset}>수집 연결: {binding.label} · {binding.provenance}</small>}
    <div className="cluster">
      <button type="button" data-projection-load disabled={!enabled || frame === null || pending || !binding}
        onClick={() => { void capture(); }}>{pending ? "영상·보정 연결 중" : "영상·양팔 궤적 불러오기 (추론 없음)"}</button>
      {pending && <button type="button" data-projection-cancel onClick={() => active.current?.abort()}>영상 읽기 취소</button>}
    </div>
    {calibration && !binding && <p role="status">이 데이터셋에 검증된 수집 조건 연결이 없습니다. 해당 로봇의 보정 진단 JSON을 사용하세요.</p>}
    {!enabled && <p role="status">완료된 평가의 전체 청크가 저장된 프레임을 선택하세요.</p>}
    {error && <p role="alert" className="notice error">{error}</p>}
  </div>;
}
