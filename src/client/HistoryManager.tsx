import { useEffect, useRef, useState } from "react";
import { Trash2 } from "lucide-react";
import { jobStorageSchema } from "../contracts";
import type { Job, Session } from "../contracts";
import { api, errorMessage, isActive, ownerLabel, ownsJob, statusLabels } from "./api";
import "./history-manager.css";

const bytesLabel = (bytes: number | null) => {
  if (bytes === null) return "크기 확인 불가";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KiB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MiB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GiB`;
};

export function HistoryManager({ jobs, session, onDeleted }: {
  readonly jobs: readonly Job[];
  readonly session: Session | null;
  readonly onDeleted: (id: string) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const cancelConfirmation = useRef<HTMLButtonElement>(null);
  const deleteSelection = useRef<HTMLButtonElement>(null);
  const request = useRef<AbortController | null>(null);
  const [open, setOpen] = useState(false);
  const [storage, setStorage] = useState<ReturnType<typeof jobStorageSchema.parse> | null>(null);
  const [selected, setSelected] = useState<readonly string[]>([]);
  const [confirming, setConfirming] = useState(false);
  const [loading, setLoading] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const records = new Map(storage?.runs.map((run) => [run.id, run]) ?? []);
  const eligible = jobs.filter((job) => !isActive(job) && records.get(job.id)?.deletable && ownsJob(session, job));
  const chosen = eligible.filter((job) => selected.includes(job.id));
  const selectedBytes = chosen.reduce((sum, job) => sum + (records.get(job.id)?.bytes ?? 0), 0);

  async function loadStorage() {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setLoading(true);
    setError("");
    try {
      const value = jobStorageSchema.parse(await api.get("/api/jobs/storage", { signal: controller.signal }).json());
      if (!controller.signal.aborted) setStorage(value);
    } catch (cause) {
      if (!controller.signal.aborted) { setStorage(null); setError(await errorMessage(cause)); }
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }

  useEffect(() => {
    if (open) {
      dialog.current?.showModal();
      void loadStorage();
    } else {
      const wasOpen = dialog.current?.open;
      dialog.current?.close();
      if (wasOpen) trigger.current?.focus();
      request.current?.abort();
    }
    return () => request.current?.abort();
  }, [open]);

  useEffect(() => {
    if (confirming) cancelConfirmation.current?.focus();
  }, [confirming]);

  async function removeSelected() {
    if (deleting || !confirming) return;
    setDeleting(true);
    setError("");
    setMessage("");
    const failures: string[] = [];
    const removed: string[] = [];
    for (const job of chosen) {
      try {
        await api.delete(`/api/jobs/${job.id}`);
        removed.push(job.id);
        onDeleted(job.id);
      } catch (cause) {
        failures.push(`${job.request.config} · ${job.id.slice(0, 8)}: ${await errorMessage(cause)}`);
      }
    }
    setSelected((current) => current.filter((id) => !removed.includes(id)));
    setConfirming(false);
    setMessage(`${removed.length}개 기록을 삭제했습니다.${failures.length ? ` ${failures.length}개는 삭제하지 못했습니다.` : ""}`);
    await loadStorage();
    if (failures.length) setError(failures.join("\n"));
    setDeleting(false);
    deleteSelection.current?.focus();
  }

  return <>
    <button ref={trigger} type="button" data-history-manager onClick={() => {
      setSelected([]); setConfirming(false); setMessage(""); setOpen(true);
    }}><Trash2 size={16} aria-hidden="true" />기록 관리</button>
    <dialog ref={dialog} className="history-manager" aria-labelledby="history-manager-title"
      onClose={() => { setOpen(false); trigger.current?.focus(); }} onCancel={(event) => { if (deleting) event.preventDefault(); }}>
      <header><div><h2 id="history-manager-title">실행 기록 관리</h2>
        <p>{jobs.length}개 기록 · 저장 파일 {storage ? bytesLabel(storage.totalBytes) : "확인 중"}</p></div>
        <button type="button" data-history-close disabled={deleting} onClick={() => setOpen(false)}>닫기</button></header>
      <p className="muted">로컬 결과 JSON(예측 청크·지표·로그)과 연결된 진단 파일(이미지·attention)을 삭제합니다. 원본 데이터셋과 모델 체크포인트는 삭제하지 않습니다.
        {" "}실행 중이거나 저장 중인 기록은 삭제할 수 없습니다.</p>
      {storage && <p className="path mono history-manager__path">{storage.directory}</p>}
      <div className="cluster">
        <button type="button" disabled={loading || deleting || confirming} onClick={() => void loadStorage()}>용량 새로고침</button>
        <button type="button" data-history-select-all disabled={!eligible.length || deleting || confirming}
          onClick={() => setSelected(eligible.map((job) => job.id))}>삭제 가능한 기록 전체 선택</button>
        <button type="button" disabled={!selected.length || deleting || confirming} onClick={() => setSelected([])}>선택 해제</button>
      </div>
      {error && <pre className="notice error" role="alert">{error}</pre>}
      {message && <p role="status" data-history-message>{message}</p>}
      <div className="history-manager__list" role="region" aria-label="저장된 실행 기록" tabIndex={0}>
        {jobs.map((job) => {
          const record = records.get(job.id);
          const mine = ownsJob(session, job);
          const enabled = !isActive(job) && record?.deletable === true && mine;
          return <label className="history-manager__row" key={job.id}>
            <input type="checkbox" data-history-select={job.id} checked={enabled && selected.includes(job.id)}
              disabled={!enabled || deleting || confirming}
              onChange={(event) => {
                const checked = event.currentTarget.checked;
                setSelected((current) => checked ? [...current, job.id] : current.filter((id) => id !== job.id));
              }} />
            <span><strong>{job.request.config}</strong>
              <small>{statusLabels[job.status]} · {new Date(job.createdAt).toLocaleString("ko-KR")} · {job.id.slice(0, 8)}{job.owner ? ` · ${ownerLabel(job)}` : ""}</small>
              <small className="path">{job.request.checkpoint}</small>
              {!enabled && <small>{isActive(job) ? "실행 중 · 삭제 불가" : !mine ? "다른 사람의 기록 · 삭제 불가" : "저장 상태 확인 후 삭제 가능"}</small>}
            </span><span className="mono">{bytesLabel(record?.bytes ?? null)}</span>
          </label>;
        })}
        {!jobs.length && <p className="muted">저장된 실행 기록이 없습니다.</p>}
      </div>
      {confirming ? <section className="history-manager__confirmation" aria-label="선택 기록 삭제 확인">
        <strong>{chosen.length}개 기록 · {bytesLabel(selectedBytes)}를 영구 삭제할까요?</strong>
        <p>삭제한 결과는 복구할 수 없으며 실행 기록과 모델 비교에서도 사라집니다.</p>
        <div className="cluster">
          <button ref={cancelConfirmation} type="button" data-history-cancel-delete disabled={deleting}
            onClick={() => { setConfirming(false); deleteSelection.current?.focus(); }}>취소</button>
          <button type="button" className="danger" data-history-confirm-delete disabled={deleting || !chosen.length}
            onClick={() => void removeSelected()}>{deleting ? "삭제 중…" : "영구 삭제"}</button>
        </div>
      </section> : <footer className="cluster">
        <span>{chosen.length}개 선택 · {bytesLabel(selectedBytes)}</span>
        <button ref={deleteSelection} type="button" className="danger" data-history-delete
          disabled={loading || deleting || !chosen.length} onClick={() => setConfirming(true)}>선택 기록 삭제</button>
      </footer>}
    </dialog>
  </>;
}
