import { useEffect, useRef, useState } from "react";
import { diagnosticRunStateSchema, diagnosticRunTerminal, mergeDiagnosticRunState } from "../../diagnostic-run-contracts";
import type { DiagnosticRunState } from "../../diagnostic-run-contracts";
import { api, errorMessage } from "../api";

export function DiagnosticLauncher({ jobId, episode, frame, completed, onCompleted, startRequest = 0 }: {
  readonly jobId: string; readonly episode: number; readonly frame: number | null;
  readonly completed: boolean; readonly onCompleted: () => void;
  readonly startRequest?: number;
}) {
  const handledStart = useRef(startRequest);
  const [enabled, setEnabled] = useState(false);
  const [state, setState] = useState<DiagnosticRunState | null>(null);
  const [error, setError] = useState("");
  const [sending, setSending] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const seen = useRef<string | null>(null);
  const latest = useRef<DiagnosticRunState | null>(null);
  const epoch = useRef(0);
  const completion = useRef(onCompleted);
  completion.current = onCompleted;
  const path = `/api/jobs/${jobId}/diagnostics/run`;
  const query = `episode=${episode}&frame=${frame}`;
  const active = state !== null && ["preflight", "running", "cancelling"].includes(state.status);
  function accept(value: unknown) {
    const next = diagnosticRunStateSchema.parse(value);
    if (next.jobId !== jobId || next.episode !== episode || next.frame !== frame)
      throw new Error("진단 작업 식별자가 선택한 프레임과 다릅니다.");
    const accepted = mergeDiagnosticRunState(latest.current, next);
    if (accepted !== next) return accepted;
    latest.current = next;
    setState(next);
    if (next.status === "completed" && next.runId !== seen.current) {
      seen.current = next.runId;
      completion.current();
    }
    return next;
  }
  useEffect(() => {
    const controller = new AbortController();
    const generation = epoch.current;
    setError("");
    if (frame !== null && completed) void api.get(`${path}?${query}`, { signal: controller.signal }).json<unknown>()
      .then((value) => { if (!controller.signal.aborted && generation === epoch.current) accept(value); })
      .catch(async (cause: unknown) => {
        const message = await errorMessage(cause);
        if (!controller.signal.aborted) setError(message);
      });
    return () => controller.abort();
  }, [path, query, completed, refresh]);
  useEffect(() => {
    if (!active || frame === null) return;
    let disposed = false;
    const source = new EventSource(`${path}/events?${query}`);
    source.onmessage = (event) => {
      if (disposed) return;
      try {
        const accepted = accept(JSON.parse(event.data)); setError("");
        if (diagnosticRunTerminal(accepted)) { disposed = true; source.close(); }
      }
      catch (cause) { source.close(); void errorMessage(cause).then((message) => { if (!disposed) setError(message); }); }
    };
    source.onerror = () => {
      source.close();
      if (!disposed) setError("진단 상태 연결이 끊겼습니다. 상태 새로고침으로 실행 상태를 확인하세요.");
    };
    return () => { disposed = true; source.close(); };
  }, [path, query, active, state?.runId]);
  useEffect(() => {
    if (startRequest <= handledStart.current) return;
    handledStart.current = startRequest;
    if (!completed || active) return;
    setEnabled(true);
    void command(false);
  }, [startRequest]);
  async function command(cancel: boolean) {
    if (frame === null || sending) return;
    epoch.current++;
    setSending(true); setError("");
    try {
      accept(await api.post(cancel ? `${path}/cancel` : path,
        { json: cancel ? { runId: state?.runId } : { episode, frame } }).json());
    } catch (cause) { setError(await errorMessage(cause)); }
    finally { setSending(false); }
  }
  return <div className="diagnostic-launcher">
    <label><input type="checkbox" data-diagnostic-enable checked={enabled || active} disabled={active || sending}
      onChange={(event) => setEnabled(event.currentTarget.checked)} />Attention 수집 {enabled || active ? "ON" : "OFF"}</label>
    <p>선택 프레임만 별도 프로세스(JAX 또는 PyTorch, 체크포인트 형식에 맞춰 자동 선택)로 실행합니다. GPU 여유 20 GiB 이상을 확인하며, 일반 평가와 동시에 실행하지 않습니다.</p>
    <div className="cluster">
      <button type="button" data-diagnostic-launch disabled={!enabled || !completed || frame === null || active || sending}
        onClick={() => void command(false)}>선택 프레임 진단 실행</button>
      <button type="button" className="danger" data-diagnostic-cancel disabled={!active || state?.status === "cancelling" || sending}
        onClick={() => void command(true)}>진단 취소</button>
      <button type="button" disabled={sending} onClick={() => setRefresh((value) => value + 1)}>상태 새로고침</button>
    </div>
    {state && <p role="status" data-diagnostic-run-status={state.status}>{state.status} · {state.message}</p>}
    {error && <pre className="notice error" role="alert">{error}</pre>}
  </div>;
}
