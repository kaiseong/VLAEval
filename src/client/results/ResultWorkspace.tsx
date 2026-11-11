import { useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { Download, FileJson } from "lucide-react";
import type { Job, JobSummary, Result, ResultSummary } from "../../contracts";
import type { ExportArtifact } from "../analysis/exports";
import { createTraceSeries, findNearestSourceFrame } from "../analysis/series";
import type { FrameWindow } from "../analysis/series";
import { Field } from "../ui/primitives";
import { PredictionWorkspace } from "./PredictionWorkspace";
import { MetricTables } from "./MetricTables";
import { CoverageSummary } from "./CoverageSummary";
import { PreReleaseWorkspace } from "./PreReleaseWorkspace";
import { useEpisodeResult } from "./episode-result";
import type { EpisodeLoad } from "./episode-result";
import "./workspace.css";

const format = (value: number) => value.toLocaleString("ko-KR", { maximumFractionDigits: 6 });

export function initialWorkspaceSelection(jobId: string, episode: number, result: Result) {
  const trace = result.traces.find((item) => item.episode === episode);
  const first = trace?.frames[0] ?? 0;
  const last = result.samples.reduce((end, sample) => {
    const lastValid = sample.valid.lastIndexOf(true);
    return sample.episode === episode && lastValid >= 0 ? Math.max(end, sample.frame + lastValid) : end;
  }, trace?.frames.at(-1) ?? first);
  return {
    jobId, episode, sourceFrame: trace?.frames[0] ?? null,
    window: { startFrame: first, endFrame: last },
    chunkOrigin: first, chunkHorizon: 0, dimension: 0,
  };
}

function download(artifact: ExportArtifact) {
  const url = URL.createObjectURL(new Blob([artifact.content], { type: artifact.mediaType }));
  try {
    const link = document.createElement("a");
    link.href = url; link.download = artifact.filename;
    document.body.append(link);
    try { link.click(); } finally { link.remove(); }
  } finally { URL.revokeObjectURL(url); }
}

/** Lets the browser save a server download straight to disk; the page never holds the file. */
function downloadUrl(url: string, filename: string) {
  const link = document.createElement("a");
  link.href = url; link.download = filename;
  document.body.append(link);
  try { link.click(); } finally { link.remove(); }
}

function EpisodeLoadStatus({ episode, load, onRetry }: {
  readonly episode: number; readonly load: EpisodeLoad; readonly onRetry: () => void;
}) {
  if (load.kind === "ready") return null;
  if (load.kind === "error") return <div className="notice error episode-load" role="alert" data-episode-load="error">
    <p>EP {episode} 데이터를 불러오지 못했습니다. {load.message}</p>
    <button type="button" onClick={onRetry}>다시 불러오기</button>
  </div>;
  const elapsed = (performance.now() - load.startedAt) / 1000;
  const remaining = load.total !== null && load.loaded > 0 ? elapsed / load.loaded * (load.total - load.loaded) : null;
  return <div className="notice episode-load" role="status" data-episode-load="loading">
    <p>EP {episode} 데이터를 불러오는 중 · 청크 {load.loaded.toLocaleString()} / {load.total?.toLocaleString() ?? "확인 중"}
      {remaining !== null && ` · 약 ${Math.max(1, Math.ceil(remaining))}초 남음`}</p>
    <progress max={load.total || 1} value={load.total === null ? 0 : load.loaded}
      aria-label={`EP ${episode} 청크 불러오기 진행률`} />
  </div>;
}

/**
 * A stored run: the summary gives the episode list and aggregates, the selected episode's frames load on demand.
 * The previous episode stays on screen (with its prediction settings) until the next one has loaded.
 */
export function ResultWorkspace({ job, summary }: { readonly job: JobSummary; readonly summary: ResultSummary }) {
  const firstEpisode = summary.episodes[0]?.episode ?? -1;
  const [selected, setSelected] = useState({ jobId: job.id, episode: firstEpisode });
  if (selected.jobId !== job.id) setSelected({ jobId: job.id, episode: firstEpisode });
  const episode = selected.jobId === job.id ? selected.episode : firstEpisode;
  const [attempt, setAttempt] = useState(0);
  const load = useEpisodeResult(job.id, summary, episode, attempt);
  const ready = load.kind === "ready" ? load.result : null;
  const [shown, setShown] = useState<{ readonly episode: number; readonly result: Result } | null>(null);
  useEffect(() => { if (ready) setShown({ episode, result: ready }); }, [ready, episode]);
  const display = ready ? { episode, result: ready } : shown;
  const [exportError, setExportError] = useState("");
  const exportRun = (file: "result.json" | "traces.csv") => {
    setExportError("");
    try { downloadUrl(`/api/jobs/${job.id}/${file}`, `vlaeval-${job.id}.${file === "result.json" ? "json" : "csv"}`); }
    catch (error) {
      setExportError(error instanceof Error ? `내보내기 실패: ${error.message}` : "내보내기에 실패했습니다.");
    }
  };
  const episodes = summary.episodes.map((item) => item.episode);
  const toolbar = <>
    <header className="result-toolbar">
      <div><h2>평가 결과</h2><p>{summary.config} · {summary.framesEvaluated.toLocaleString()} frames · {summary.fps} FPS</p></div>
      <Field label="결과 에피소드"><select id="workspace-episode" value={episode} disabled={!episodes.length}
        onChange={(event) => setSelected({ jobId: job.id, episode: Number(event.currentTarget.value) })}>
        {!episodes.length && <option value={episode}>No saved episode</option>}
        {episodes.map((item) => <option key={item} value={item}>EP {item}</option>)}
      </select></Field>
      <div className="cluster">
        <button data-export="json" onClick={() => exportRun("result.json")}>
          <FileJson size={16} aria-hidden="true" />결과 JSON</button>
        <button data-export="csv" disabled={!summary.episodes.some((item) => item.traceFrames > 0)}
          onClick={() => exportRun("traces.csv")}>
          <Download size={16} aria-hidden="true" />전체 trace CSV</button>
      </div>
    </header>
    {exportError && <p role="alert" className="notice error">{exportError}</p>}
    <EpisodeLoadStatus episode={episode} load={load} onRetry={() => setAttempt((value) => value + 1)} />
  </>;
  // Not `.result-workspace` yet: that class marks a rendered episode (QA scenarios and tests wait for it).
  if (!display) return <div className="result-loading" data-job-id={job.id} data-episode={episode}>{toolbar}</div>;
  return <EpisodeWorkspace key={job.id} job={{ ...job, result: display.result }} result={display.result}
    episode={display.episode} toolbar={toolbar} />;
}

function EpisodeWorkspace({ job, result, episode, toolbar }: {
  readonly job: Job; readonly result: Result; readonly episode: number; readonly toolbar: ReactNode;
}) {
  const [selection, setSelection] = useState(() => initialWorkspaceSelection(job.id, episode, result));
  if (selection.episode !== episode) setSelection(initialWorkspaceSelection(job.id, episode, result));
  const [view, setView] = useState<"prediction" | "metrics" | "prerelease">("prediction");
  const [metricTab, setMetricTab] = useState<"episode" | "dimension" | "horizon">("episode");
  const [exportError, setExportError] = useState("");
  const trace = result.traces.find((item) => item.episode === episode);
  const chunks = useMemo(() => result.samples.filter((sample) => sample.episode === episode), [result.samples, episode]);
  const series = useMemo(() => trace ? { ...trace, fps: result.fps }
    : { frames: [], predicted: [], target: [], fps: result.fps }, [trace, result.fps]);
  const parsed = useMemo(() => createTraceSeries(series), [series]);
  const fullWindow = useMemo(() => initialWorkspaceSelection(job.id, episode, result).window, [job.id, episode, result]);
  const selectFrame = (frame: number) => {
    if (parsed.kind !== "ready") return;
    const nearest = findNearestSourceFrame(parsed.series, frame);
    if (nearest) setSelection((current) => ({ ...current, sourceFrame: nearest.frame }));
  };
  const selectWindow = (window: FrameWindow) => {
    if (parsed.kind !== "ready" || !Number.isFinite(window.startFrame) || !Number.isFinite(window.endFrame)
      || window.startFrame > window.endFrame) return;
    setSelection((current) => ({ ...current, window: {
      startFrame: Math.max(fullWindow.startFrame, Math.min(fullWindow.endFrame, window.startFrame)),
      endFrame: Math.max(fullWindow.startFrame, Math.min(fullWindow.endFrame, window.endFrame)),
    } }));
  };
  const exportData = (artifact: ExportArtifact) => {
    setExportError("");
    try { download(artifact); } catch (error) {
      setExportError(error instanceof Error ? `내보내기 실패: ${error.message}` : "내보내기에 실패했습니다.");
    }
  };

  return <div className="result-workspace" data-job-id={job.id} data-episode={episode}
    data-source-frame={selection.sourceFrame ?? "unavailable"} data-window-start={selection.window.startFrame}
    data-window-end={selection.window.endFrame} data-view={view}>
    {toolbar}
    <CoverageSummary result={result} request={job.request} episode={episode} frames={trace?.frames ?? []} />
    {job.error && <p role="alert" className="notice error">{job.error}</p>}
    {exportError && <p role="alert" className="notice error">{exportError}</p>}
    <div className="result-navigation">
      <div className="result-tabs" role="group" aria-label="Result views">
        {(["prediction", "metrics", "prerelease"] as const).map((name) => <button type="button" key={name} data-view-tab={name}
          aria-pressed={view === name} className={view === name ? "selected" : ""} onClick={() => setView(name)}>
          {view === name && <span aria-hidden="true">✓</span>}{name === "prediction" ? "Prediction" : name === "metrics" ? "Metrics" : "Pre-release"}
        </button>)}
      </div>
      {view !== "metrics" && <div className="workspace-cursor">
        <Field label="Source frame"><input id="workspace-frame" type="number" min={0} step={1} disabled={selection.sourceFrame === null}
          value={selection.sourceFrame ?? ""} onChange={(event) => selectFrame(event.currentTarget.valueAsNumber)} /></Field>
        <Field label="Window start"><input id="workspace-start" type="number" value={selection.window.startFrame}
          onChange={(event) => selectWindow({ ...selection.window, startFrame: event.currentTarget.valueAsNumber })} /></Field>
        <Field label="Window end"><input id="workspace-end" type="number" value={selection.window.endFrame}
          onChange={(event) => selectWindow({ ...selection.window, endFrame: event.currentTarget.valueAsNumber })} /></Field>
        <output className="mono">Frame {selection.sourceFrame ?? "unavailable"} · {selection.sourceFrame === null ? "unavailable" : selection.sourceFrame / result.fps} s
          {" · "}Window {selection.window.startFrame}–{selection.window.endFrame}</output>
      </div>}
    </div>
    <div className="result-content" hidden={view !== "prediction"}>
      <PredictionWorkspace jobId={job.id} result={result} episode={episode} series={series} chunks={chunks}
        sourceFrame={selection.sourceFrame} window={selection.window} fullWindow={fullWindow}
        onFrameSelect={selectFrame} onWindowChange={selectWindow} onDownload={exportData} />
    </div>
    {view === "metrics" && <MetricTables result={result} metricTab={metricTab} onMetricTabChange={setMetricTab} />}
    {view === "prerelease" && <PreReleaseWorkspace job={job} episode={episode} frame={selection.sourceFrame} />}
    <details className="result-provenance"><summary>Metadata &amp; warnings ({result.warnings.length})</summary>
      <dl><dt>Created</dt><dd>{new Date(job.createdAt).toLocaleString("ko-KR")}</dd>
        <dt>Host / repository</dt><dd className="path">{job.request.host} / {job.request.repo}</dd>
        <dt>Checkpoint</dt><dd className="path">{result.checkpoint}</dd><dt>Dataset</dt><dd className="path">{result.dataset}</dd>
        <dt>Episodes</dt><dd>{job.request.episodes.join(", ")}</dd><dt>Seed / inference steps / stride</dt><dd>{result.seed} / {result.numSteps} / {job.request.stride}</dd>
        <dt>Maximum frames</dt><dd>{job.request.maxSamples === 0 ? "All" : job.request.maxSamples}</dd>
        <dt>Latency median / p95</dt><dd>{format(result.latencyMs.median)} / {format(result.latencyMs.p95)} ms</dd></dl>
      {result.warnings.map((warning, index) => <p key={index}>{warning}</p>)}
    </details>
  </div>;
}
