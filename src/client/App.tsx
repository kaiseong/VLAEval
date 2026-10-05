import { useEffect, useRef, useState } from "react";
import { Activity, Check, Database, FolderSearch, Play, RefreshCw, Settings2, Square, Terminal } from "lucide-react";
import { z } from "zod";
import {
  configsSchema, connectionSchema, discoverySchema, discoverRequestSchema,
  episodesRequestSchema, episodesSchema, jobRequestSchema, jobSchema, type Job,
} from "../contracts";
import { api, createdJobSchema, errorMessage, isActive, mergeJob, statusLabels } from "./api";
import { Results } from "./Results";
import { Field, Section } from "./ui/primitives";
import { WorkspaceNav, type WorkspaceView } from "./WorkspaceNav";

const defaults = {
  host: "rtx6000@192.168.0.3", repo: "/home/rtx6000/kgs/pi05_rby1",
  roots: "/home/rtx6000/kgs\n/home/rtx6000/.cache/huggingface/lerobot\n/home/rtx6000/.cache/openpi\n/data",
  checkpoint: "", dataset: "", theme: "system",
} as const;
const settingsSchema = z.object({
  host: z.string(), repo: z.string(), roots: z.string(), checkpoint: z.string(),
  dataset: z.string(), theme: z.enum(["system", "light", "dark"]),
});
type Settings = z.infer<typeof settingsSchema>;
type Discovery = z.infer<typeof discoverySchema>;
type Configs = z.infer<typeof configsSchema>;
type Episodes = z.infer<typeof episodesSchema>;

function initialSettings(): Settings {
  try {
    const stored = localStorage.getItem("vlaeval.settings");
    if (!stored) return { ...defaults };
    const parsed = settingsSchema.safeParse(JSON.parse(stored));
    return parsed.success ? parsed.data : { ...defaults };
  } catch (error) {
    console.warn("VLAEval 설정을 읽지 못했습니다.", error);
    return { ...defaults };
  }
}

export { Field, Section } from "./ui/primitives";

export function App() {
  const [settings, setSettings] = useState(initialSettings);
  const [storageError, setStorageError] = useState("");
  const [discovery, setDiscovery] = useState<Discovery | null>(null);
  const [configs, setConfigs] = useState<Configs | null>(null);
  const [config, setConfig] = useState("");
  const [episodes, setEpisodes] = useState<Episodes | null>(null);
  const [selected, setSelected] = useState<number[]>([]);
  const [metadataState, setMetadataState] = useState<"empty" | "loading" | "ready" | "error">("empty");
  const [metadataError, setMetadataError] = useState("");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [jobs, setJobs] = useState<Job[]>([]);
  const [historyState, setHistoryState] = useState<"loading" | "ready" | "error">("loading");
  const [displayId, setDisplayId] = useState("");
  const [view, setView] = useState<WorkspaceView>("preparation");
  const workspaceChosen = useRef(false);
  const [streamError, setStreamError] = useState("");
  const [streamVersion, setStreamVersion] = useState(0);
  const [cancelling, setCancelling] = useState("");
  const [stride, setStride] = useState(1);
  const [maxSamples, setMaxSamples] = useState(0);
  const [seed, setSeed] = useState(0);
  const [numSteps, setNumSteps] = useState(10);
  const [episodeQuery, setEpisodeQuery] = useState("");
  const mounted = useRef(true);
  const metadataController = useRef<AbortController | null>(null);
  const active = jobs.filter(isActive);
  const locked = active.length > 0 || Boolean(busy) || historyState !== "ready";
  const displayed = jobs.find((job) => job.id === displayId);
  const activeIds = active.map((job) => job.id).sort().join(",");

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  useEffect(() => {
    document.documentElement.dataset.theme = settings.theme;
    try {
      localStorage.setItem("vlaeval.settings", JSON.stringify(settings));
      setStorageError("");
    } catch (cause) {
      setStorageError(cause instanceof Error ? `설정을 저장하지 못했습니다: ${cause.message}` : "브라우저 설정 저장이 차단되었습니다.");
    }
  }, [settings]);

  async function loadHistory(signal?: AbortSignal) {
    setHistoryState("loading");
    setError("");
    try {
      const data = jobSchema.array().parse(await api.get("/api/jobs", signal ? { signal } : {}).json());
      if (signal?.aborted) return;
      setJobs((current) => data.reduce(mergeJob, current));
      if (!workspaceChosen.current) {
        const initial = data.find((job) => job.status === "completed" && job.result) ?? data[0];
        setDisplayId(initial?.id ?? "");
        setView(initial?.result ? "analysis" : "preparation");
        workspaceChosen.current = true;
      }
      setHistoryState("ready");
    } catch (cause) {
      if (signal?.aborted) return;
      setError(await errorMessage(cause));
      setHistoryState("error");
    }
  }

  useEffect(() => {
    const controller = new AbortController();
    void loadHistory(controller.signal);
    return () => controller.abort();
  }, []);

  useEffect(() => {
    if (!activeIds) return;
    let disposed = false;
    const controller = new AbortController();
    const streams = activeIds.split(",").map((id) => {
      const source = new EventSource(`/api/jobs/${id}/events`);
      let snapshotPending = false;
      async function snapshot() {
        if (snapshotPending || disposed) return;
        snapshotPending = true;
        try {
          const job = jobSchema.parse(await api.get(`/api/jobs/${id}`, { signal: controller.signal }).json());
          if (disposed) return;
          setJobs((current) => mergeJob(current, job));
          if (!isActive(job)) source.close();
        } catch (cause) {
          if (disposed) return;
          source.close();
          setStreamError(`실시간 연결이 끊겼습니다. 다시 연결해 현재 상태를 확인하세요.\n${await errorMessage(cause)}`);
        } finally {
          snapshotPending = false;
        }
      }
      source.onopen = () => { setStreamError(""); void snapshot(); };
      source.onmessage = (event) => {
        try {
          const job = jobSchema.parse(JSON.parse(event.data));
          if (job.id !== id) { source.close(); setStreamError("실시간 응답의 실행 ID가 일치하지 않습니다. 다시 연결하세요."); return; }
          setJobs((current) => mergeJob(current, job));
          if (!isActive(job)) source.close();
        } catch (cause) {
          source.close();
          void errorMessage(cause).then((message) => { if (!disposed) setStreamError(`실시간 응답 오류: ${message}`); });
        }
      };
      source.onerror = () => { setStreamError("실시간 연결을 복구하고 있습니다. 저장된 상태를 확인합니다."); void snapshot(); };
      return source;
    });
    return () => { disposed = true; controller.abort(); streams.forEach((source) => source.close()); };
  }, [activeIds, streamVersion]);

  useEffect(() => {
    metadataController.current?.abort();
    setEpisodes(null);
    setSelected([]);
    setEpisodeQuery("");
    setMetadataError("");
    setMetadataState("empty");
    return () => metadataController.current?.abort();
  }, [settings.host, settings.repo, settings.dataset]);

  async function loadEpisodes() {
    metadataController.current?.abort();
    const controller = new AbortController();
    metadataController.current = controller;
    setEpisodes(null);
    setSelected([]);
    setMetadataError("");
    setMetadataState("loading");
    try {
      const request = episodesRequestSchema.parse({ host: settings.host, repo: settings.repo, dataset: settings.dataset });
      const data = episodesSchema.parse(await api.post("/api/episodes", { json: request, signal: controller.signal }).json());
      if (controller.signal.aborted) return;
      setEpisodes(data);
      setMetadataState("ready");
    } catch (cause) {
      if (controller.signal.aborted) return;
      setMetadataError(await errorMessage(cause));
      setMetadataState("error");
    }
  }

  function updateSettings(key: keyof Settings, value: string) {
    if (key === "host") { setDiscovery(null); setConfigs(null); setConfig(""); setEpisodes(null); setSelected([]); }
    if (key === "repo") { setConfigs(null); setConfig(""); setEpisodes(null); setSelected([]); }
    if (key === "dataset") { setEpisodes(null); setSelected([]); }
    if (key === "roots") setDiscovery(null);
    setSettings((current) => settingsSchema.parse({ ...current, [key]: value }));
    setError("");
  }

  async function discover() {
    setBusy("discover"); setError(""); setDiscovery(null);
    try {
      const request = discoverRequestSchema.parse({ host: settings.host, roots: settings.roots.split("\n").map((root) => root.trim()).filter(Boolean) });
      const data = discoverySchema.parse(await api.post("/api/discover", { json: request }).json());
      if (mounted.current) setDiscovery(data);
    } catch (cause) { setError(await errorMessage(cause)); }
    finally { if (mounted.current) setBusy(""); }
  }

  async function loadConfigs() {
    setBusy("configs"); setError(""); setConfigs(null); setConfig("");
    try {
      const request = connectionSchema.parse({ host: settings.host, repo: settings.repo });
      const data = configsSchema.parse(await api.post("/api/configs", { json: request }).json());
      if (mounted.current) setConfigs(data);
    } catch (cause) { setError(await errorMessage(cause)); }
    finally { if (mounted.current) setBusy(""); }
  }

  async function startJob() {
    setBusy("submit"); setError("");
    try {
      const request = jobRequestSchema.parse({ ...settings, config, episodes: selected, stride, maxSamples, seed, numSteps });
      const created = createdJobSchema.parse(await api.post("/api/jobs", { json: request }).json());
      // The backend owns timestamps/status; do not create a synthetic history item.
      setDisplayId(created.id);
      setView("analysis");
      workspaceChosen.current = true;
      const job = jobSchema.parse(await api.get(`/api/jobs/${created.id}`).json());
      setJobs((current) => mergeJob(current, job));
    } catch (cause) {
      setError(await errorMessage(cause));
      // A successful POST followed by a failed snapshot must not permit another run.
      await loadHistory();
    } finally { setBusy(""); }
  }

  async function cancelJob(id: string) {
    setCancelling(id); setError("");
    try {
      const job = jobSchema.parse(await api.post(`/api/jobs/${id}/cancel`).json());
      setJobs((current) => mergeJob(current, job));
    } catch (cause) { setError(await errorMessage(cause)); }
    finally { setCancelling(""); }
  }

  const visibleEpisodes = episodes?.episodes.filter((episode) =>
    `${episode.index} ${episode.tasks.join(" ")}`.toLowerCase().includes(episodeQuery.toLowerCase())) ?? [];
  const selectedFrames = episodes?.episodes.filter((episode) => selected.includes(episode.index)).reduce((sum, episode) => sum + episode.length, 0) ?? 0;
  const prepared = Boolean(config && settings.checkpoint && settings.dataset && selected.length && episodes && metadataState === "ready");

  return <div className="app-shell">
    <a className="skip-link" href="#main">본문으로 이동</a>
    <main id="main" className="main">
    <header className="workspace-header">
      <div className="brand"><Activity aria-hidden="true" /><strong>VLA<span>Eval</span></strong><span className="badge">LOCAL</span></div>
      <h1>에피소드 평가</h1>
      <WorkspaceNav view={view} onChange={(next) => { workspaceChosen.current = true; setView(next); }} />
      <Field label="실행 기록"><select id="history" value={displayId} onChange={(event) => { setDisplayId(event.target.value); setView("analysis"); workspaceChosen.current = true; }}>
        <option value="">실행을 선택하세요</option>
        {jobs.map((job) => <option key={job.id} value={job.id}>{job.request.config} · {statusLabels[job.status]} · {new Date(job.createdAt).toLocaleString("ko-KR")}</option>)}
      </select></Field>
      <button disabled={historyState === "loading"} onClick={() => void loadHistory()} aria-label="기록 새로고침"><RefreshCw size={16} aria-hidden="true" />{historyState === "loading" ? "불러오는 중…" : "새로고침"}</button>
      <div className="rail-footer">
        <Field label="화면 테마"><select value={settings.theme} onChange={(event) => updateSettings("theme", event.target.value)}><option value="system">시스템 설정</option><option value="light">라이트</option><option value="dark">다크</option></select></Field>
      </div>
    </header>
      {historyState === "error" && <p role="alert" className="notice error">기록을 읽지 못했습니다. 오류를 확인하고 기록을 새로고침하세요.</p>}
      {historyState === "ready" && !jobs.length && <p className="notice">저장된 실행이 없습니다. 첫 평가를 시작하세요.</p>}
      {storageError && <p className="notice" role="status">{storageError}</p>}
      {error && <div className="notice error" role="alert"><strong>요청을 완료하지 못했습니다</strong><pre>{error}</pre><button onClick={() => setError("")}>닫기</button></div>}
      {busy && <p className="notice" role="status">{busy === "discover" ? "SSH로 기존 아티팩트를 탐색하고 있습니다. 최대 3분이 걸릴 수 있습니다." : busy === "configs" ? "저장소에서 기존 config 목록을 읽고 있습니다." : "평가 실행을 요청하고 있습니다."}</p>}
      {view === "preparation" && discovery && <div className="notice"><strong>탐색 완료</strong><p>저장소 {discovery.repositories.length} · 체크포인트 {discovery.checkpoints.length} · 데이터셋 {discovery.datasets.length}</p>{discovery.warnings.length > 0 && <details><summary>탐색 주의사항 {discovery.warnings.length}개</summary><div className="warning-list" tabIndex={0} role="region" aria-label="탐색 주의사항">{discovery.warnings.map((warning, index) => <p key={index}>{warning}</p>)}</div></details>}</div>}
      {streamError && <div className="notice" role="status"><p>{streamError}</p><button onClick={() => { setStreamError(""); setStreamVersion((value) => value + 1); }}><RefreshCw size={16} aria-hidden="true" />다시 연결</button></div>}
      {active.map((job) => <section className="run-progress panel" key={job.id} aria-label="진행 중인 평가">
        <div className="cluster spread"><div><span className="badge">{statusLabels[job.status]}</span><strong>{job.request.config}</strong><p>{job.progress.message || "평가 작업을 준비하고 있습니다."}</p></div><button className="danger" disabled={cancelling === job.id} onClick={() => void cancelJob(job.id)}><Square size={15} aria-hidden="true" />{cancelling === job.id ? "취소 요청 중…" : "평가 취소"}</button></div>
        <progress aria-label="평가 진행률" value={job.progress.completed} max={Math.max(1, job.progress.total)} />
        <p className="mono" role="status">{job.progress.completed.toLocaleString()} / {job.progress.total.toLocaleString()} 프레임</p>
      </section>)}
      <form id="prepare" hidden={view !== "preparation"} onSubmit={(event) => { event.preventDefault(); if (prepared && !locked) void startJob(); }}>
        <details className="panel connection-disclosure" id="connection">
          <summary><Settings2 size={16} aria-hidden="true" /> 연결 설정 <span className="muted path">{settings.host}</span></summary>
          <fieldset className="connection" disabled={locked}>
            <legend><Terminal size={16} aria-hidden="true" /> SSH 연결</legend>
            <Field label="대상 호스트"><input value={settings.host} onChange={(event) => updateSettings("host", event.target.value)} spellCheck={false} /></Field>
            <Field label="탐색 루트 · 한 줄에 하나" hint="최대 16개. 기존 파일만 탐색합니다."><textarea rows={3} value={settings.roots} onChange={(event) => updateSettings("roots", event.target.value)} spellCheck={false} /></Field>
            <button type="button" onClick={() => void discover()}><FolderSearch size={17} aria-hidden="true" />{busy === "discover" ? "탐색 중…" : "아티팩트 탐색"}</button>
          </fieldset>
        </details>
        <fieldset className="preparation" disabled={locked}>
          <legend className="sr-only">평가 준비</legend>
          <div className="preparation-grid">
            <Section number="01" title="모델" subtitle="원격 저장소의 기존 config와 체크포인트를 선택하세요.">
              <Field label="모델 저장소 경로"><input className="mono" list="repositories" value={settings.repo} onChange={(event) => updateSettings("repo", event.target.value)} spellCheck={false} /></Field>
              <datalist id="repositories">{discovery?.repositories.map((repo) => <option key={repo.path} value={repo.path} />)}</datalist>
              <button type="button" onClick={() => void loadConfigs()}><RefreshCw size={16} aria-hidden="true" />config 목록 읽기</button>
              <Field label="기존 config"><select value={config} disabled={!configs?.configs.length} onChange={(event) => setConfig(event.target.value)}><option value="">config를 선택하세요</option>{configs?.configs.map((item) => <option value={item.name} key={item.name}>{item.name} · {item.actionDim}차원 / {item.actionHorizon}스텝</option>)}</select></Field>
              {configs && !configs.configs.length && <p className="muted">사용 가능한 config가 없습니다. 저장소 경로와 원격 환경을 확인하세요.</p>}
              {configs && <p className="muted path">저장소 revision: {configs.revision}</p>}
              <Field label="체크포인트 경로" hint="탐색 결과에서 선택하거나 절대 경로를 직접 입력하세요."><input className="mono" list="checkpoints" value={settings.checkpoint} onChange={(event) => updateSettings("checkpoint", event.target.value)} placeholder="/…/checkpoints/…" spellCheck={false} /></Field>
              <datalist id="checkpoints">{discovery?.checkpoints.map((item) => <option key={item.path} value={item.path}>{item.format} · step {item.step ?? "미상"}</option>)}</datalist>
            </Section>
            <Section number="02" title="데이터셋" subtitle="LeRobot 데이터셋을 지정하고 에피소드 메타데이터를 읽습니다.">
              <Field label="데이터셋 경로" hint="탐색 루트 밖의 데이터셋도 절대 경로로 지정할 수 있습니다."><input className="mono" list="datasets" value={settings.dataset} onChange={(event) => updateSettings("dataset", event.target.value)} placeholder="/…/datasets/…" spellCheck={false} /></Field>
              <datalist id="datasets">{discovery?.datasets.map((item) => <option key={item.path} value={item.path}>{item.name} · {item.episodes} 에피소드</option>)}</datalist>
              <div className="dataset-summary"><Database aria-hidden="true" /><div><strong>{metadataState === "ready" ? `${episodes?.episodes.length.toLocaleString()}개 에피소드` : "에피소드 메타데이터"}</strong><p>{metadataState === "loading" ? "원격 데이터셋을 읽고 있습니다…" : episodes ? `${episodes.fps} FPS · ${episodes.version} · ${episodes.episodes.reduce((sum, item) => sum + item.length, 0).toLocaleString()} 프레임` : "저장소와 데이터셋을 지정한 뒤 메타데이터를 읽으세요."}</p></div></div>
              {metadataState === "loading" && <p role="status" className="muted">메타데이터 로딩 중…</p>}
              {metadataError && <div className="notice error" role="alert"><pre>{metadataError}</pre></div>}
              <button type="button" disabled={!settings.host || !settings.repo || !settings.dataset || metadataState === "loading"} onClick={() => void loadEpisodes()}><RefreshCw size={16} aria-hidden="true" />{episodes ? "메타데이터 다시 읽기" : "메타데이터 읽기"}</button>
              <p className="muted">선택한 저장소의 Python 환경으로 데이터셋 메타데이터를 읽습니다.</p>
              <p className="muted">로봇 연결 없이 저장된 관측으로 추론합니다. 평가 중 원격 파일을 변경하지 마세요.</p>
            </Section>
          </div>
          <Section number="03" title="에피소드 선택" subtitle="하나 이상 직접 선택하세요. 기본값은 선택한 에피소드의 모든 프레임입니다.">
            <div className="episode-toolbar cluster spread"><div className="cluster"><button type="button" disabled={!episodes?.episodes.length} onClick={() => setSelected(episodes?.episodes.map((item) => item.index) ?? [])}><Check size={16} aria-hidden="true" />전체 선택</button><button type="button" disabled={!selected.length} onClick={() => setSelected([])}>선택 해제</button><span className="muted">{selected.length}개 선택 · {selectedFrames.toLocaleString()} 프레임</span></div><Field label="에피소드 검색"><input type="search" value={episodeQuery} onChange={(event) => setEpisodeQuery(event.target.value)} placeholder="번호 또는 작업 설명" /></Field></div>
            {!episodes && <div className="empty compact"><Database aria-hidden="true" /><p>{metadataState === "loading" ? "에피소드 목록을 불러오고 있습니다." : "데이터셋 메타데이터를 읽은 뒤 에피소드를 선택하세요."}</p></div>}
            {episodes && !episodes.episodes.length && <div className="empty compact"><p>이 데이터셋에는 에피소드가 없습니다.</p></div>}
            {episodes && episodes.episodes.length > 0 && <div className="episode-list" role="group" aria-label="평가할 에피소드">
              {visibleEpisodes.map((episode) => <label key={episode.index} className={`episode-row ${selected.includes(episode.index) ? "selected" : ""}`}><input type="checkbox" checked={selected.includes(episode.index)} onChange={(event) => setSelected((current) => event.target.checked ? [...current, episode.index] : current.filter((index) => index !== episode.index))} /><span><strong className="mono">EP {String(episode.index).padStart(4, "0")}</strong><small>{episode.length.toLocaleString()} 프레임 · {(episode.length / episodes.fps).toFixed(1)}초</small></span><span className="task-description">{episode.tasks.join(" / ") || "작업 설명 없음"}</span></label>)}
              {!visibleEpisodes.length && <p className="muted">검색과 일치하는 에피소드가 없습니다.</p>}
            </div>}
            <details className="advanced"><summary>평가 옵션 <span className="muted">stride {stride} · 최대 프레임 {maxSamples === 0 ? "전체" : maxSamples}</span></summary><div className="options-grid">
              <Field label="프레임 간격 (stride)" hint="1 = 모든 프레임"><input type="number" min={1} max={100000} value={stride} onChange={(event) => setStride(event.target.valueAsNumber)} /></Field>
              <Field label="최대 평가 프레임" hint="0 = 선택 에피소드 전체"><input type="number" min={0} max={1000000} value={maxSamples} onChange={(event) => setMaxSamples(event.target.valueAsNumber)} /></Field>
              <Field label="시드"><input type="number" min={0} max={2147483647} value={seed} onChange={(event) => setSeed(event.target.valueAsNumber)} /></Field>
              <Field label="추론 스텝 수"><input type="number" min={1} max={100} value={numSteps} onChange={(event) => setNumSteps(event.target.valueAsNumber)} /></Field>
            </div></details>
          </Section>
          <div className="launch-bar"><div><strong>{stride === 1 && maxSamples === 0 ? "선택 에피소드의 모든 프레임 평가" : "사용자 지정 샘플링으로 평가"}</strong><p>{selected.length ? `${selected.length}개 에피소드 · 원본 ${selectedFrames.toLocaleString()} 프레임` : "모델, 데이터셋, 에피소드를 먼저 선택하세요."}</p></div><button className="primary" type="submit" disabled={!prepared || locked}><Play size={17} aria-hidden="true" />평가 시작</button></div>
        </fieldset>
      </form>
      {locked && <p className="muted">{active.length ? "진행 중인 평가가 있어 요청 설정이 잠겨 있습니다. 결과와 실행 기록은 계속 확인할 수 있습니다." : historyState !== "ready" ? "저장된 실행 상태를 확인한 뒤 새 평가를 시작할 수 있습니다." : "현재 요청이 끝나면 설정을 변경할 수 있습니다."}</p>}
      <div id="results" hidden={view !== "analysis"}>
        {displayed?.result ? <Results key={displayed.id} job={displayed} /> : <Section title="평가 결과" subtitle="저장된 실행을 선택하거나 새 평가를 시작하세요.">
          <div className="empty"><Activity size={32} aria-hidden="true" /><h3>{displayed ? statusLabels[displayed.status] : "아직 표시할 결과가 없습니다"}</h3><p>{displayed?.error || (displayed?.status === "cancelled" ? "평가가 취소되었습니다. 설정을 확인한 후 새 평가를 시작하세요." : displayed && isActive(displayed) ? "평가가 끝나면 액션 그래프와 수치 지표가 표시됩니다." : "선택한 에피소드의 예측과 정답을 여기서 비교합니다.")}</p></div>
        </Section>}
        {displayed && <details className="panel logs"><summary>선택 실행 로그 · {statusLabels[displayed.status]}</summary><pre>{displayed.logs.join("\n") || "저장된 로그가 없습니다."}</pre></details>}
      </div>
      <footer className="page-footer">VLAEval · 기존 아티팩트의 오프라인 평가 · 업로드 / 학습 / 로봇 제어 없음</footer>
    </main>
  </div>;
}
