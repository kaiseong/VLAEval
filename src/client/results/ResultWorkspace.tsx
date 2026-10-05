import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Download, FileJson, X } from "lucide-react";
import ky from "ky";
import { z } from "zod";
import type { Job } from "../../contracts";
import { compiledProfileSchema } from "../../kinematics/contracts";
import type { CompiledProfile } from "../../kinematics/contracts";
import { createChannelLayout } from "../analysis/channel-layout";
import { FkController } from "../analysis/fk-controller";
import type { FkState } from "../analysis/fk-controller";
import { rawJsonExport, rawTraceCsv, currentFkExport } from "../analysis/exports";
import type { ExportArtifact } from "../analysis/exports";
import type { FkDownload } from "../analysis/fk-protocol";
import { createTraceSeries, findNearestSourceFrame, clampFrameWindow } from "../analysis/series";
import type { FrameWindow } from "../analysis/series";
import { TracePlot } from "../charts/TracePlot";
import { Field } from "../ui/primitives";
import { OverviewGrid } from "./OverviewGrid";
import { DetailPanel } from "./DetailPanel";
import { ChunkPanel } from "./ChunkPanel";
import { MetricTables } from "./MetricTables";
import { CoverageSummary } from "./CoverageSummary";
import { FKSettings, declaredFKRequest, initialFKSettings } from "./FKSettings";
import type { FKSettingsValue, FKProfileMetadata } from "./FKSettings";
import { FKPanel } from "./FKPanel";
import "./workspace.css";

// allow: SIZE_OK — This existing episode state machine owns the coupled native/FK cursor,
// focus and export lifecycle. Task 44 changes that boundary without splitting native views.
type Result = NonNullable<Job["result"]>;
type View = "overview" | "detail" | "chunks" | "metrics" | "fk";
const views = [
  ["overview", "Overview"], ["detail", "Detail"], ["chunks", "Future chunks"],
  ["metrics", "Metrics"], ["fk", "Optional FK"],
] as const;
const profileListSchema = z.object({
  profiles: z.array(compiledProfileSchema.innerType().omit({ rightChain: true, leftChain: true }).strip()),
});
const format = (value: number) => value.toLocaleString("ko-KR", { maximumFractionDigits: 6 });

export function initialWorkspaceSelection(jobId: string, episode: number, result: Result) {
  const trace = result.traces.find((item) => item.episode === episode);
  const first = trace?.frames[0] ?? 0;
  return {
    jobId, episode, sourceFrame: trace?.frames[0] ?? null,
    window: { startFrame: first, endFrame: trace?.frames.at(-1) ?? first },
    chunkOrigin: first, chunkHorizon: 0, dimension: 0,
  };
}

function download(artifact: ExportArtifact | FkDownload) {
  const url = URL.createObjectURL(new Blob([artifact.content], { type: artifact.mediaType }));
  try {
    const link = document.createElement("a");
    link.href = url;
    link.download = artifact.filename;
    document.body.append(link);
    try { link.click(); } finally { link.remove(); }
  } finally { URL.revokeObjectURL(url); }
}

export function ResultWorkspace({ job, result }: { readonly job: Job; readonly result: Result }) {
  const [selected, setSelected] = useState({ jobId: job.id, episode: result.traces[0]?.episode ?? result.samples[0]?.episode ?? -1 });
  // A run can change without App remounting us. Reset before committing any old selection.
  if (selected.jobId !== job.id) {
    setSelected({ jobId: job.id, episode: result.traces[0]?.episode ?? result.samples[0]?.episode ?? -1 });
  }
  const episode = selected.jobId === job.id ? selected.episode : result.traces[0]?.episode ?? result.samples[0]?.episode ?? -1;
  return <EpisodeWorkspace key={`${job.id}:${episode}`} job={job} result={result} episode={episode}
    onEpisodeChange={(next) => setSelected({ jobId: job.id, episode: next })} />;
}

function EpisodeWorkspace({ job, result, episode, onEpisodeChange }: {
  readonly job: Job; readonly result: Result; readonly episode: number;
  readonly onEpisodeChange: (episode: number) => void;
}) {
  const [selection, setSelection] = useState(() => initialWorkspaceSelection(job.id, episode, result));
  const [view, setView] = useState<View>("overview");
  const [metricTab, setMetricTab] = useState<"episode" | "dimension" | "horizon">("episode");
  const [exportError, setExportError] = useState("");
  const [settings, setSettings] = useState<FKSettingsValue>(initialFKSettings);
  const [profiles, setProfiles] = useState<readonly FKProfileMetadata[]>([]);
  const [catalog, setCatalog] = useState({ loading: false, notice: "" });
  const [profile, setProfile] = useState<CompiledProfile | null>(null);
  const [fk, setFK] = useState<FkState>({ status: "unavailable", reason: "FK is off. Raw joint analysis remains available." });
  const controller = useRef<FkController | null>(null);
  const workspace = useRef<HTMLDivElement | null>(null);
  const closeButton = useRef<HTMLButtonElement | null>(null);
  const opener = useRef<HTMLElement | null>(null);
  const returnFocus = useRef(false);
  const trace = result.traces.find((item) => item.episode === episode);
  const series = useMemo(() => trace ? { ...trace, fps: result.fps }
    : { frames: [], predicted: [], target: [], fps: result.fps }, [trace, result.fps]);
  const parsed = useMemo(() => createTraceSeries(series), [series]);
  const layout = useMemo(() => createChannelLayout(result.actionNames), [result.actionNames]);
  const episodes = Array.from(new Set([...result.traces.map((item) => item.episode), ...result.samples.map((item) => item.episode)]));

  useEffect(() => {
    const owned = new FkController(setFK);
    controller.current = owned;
    return () => { controller.current = null; owned.dispose(); };
  }, []);

  useEffect(() => {
    if (view !== "fk") return;
    const abort = new AbortController();
    setCatalog({ loading: true, notice: "" });
    void ky.get("/api/kinematics/profiles", { signal: abort.signal, retry: 0 }).json<unknown>()
      .then((data) => {
        if (abort.signal.aborted) return;
        setProfiles(profileListSchema.parse(data).profiles);
        setCatalog({ loading: false, notice: "" });
      }).catch((error: unknown) => {
        if (!abort.signal.aborted) setCatalog({ loading: false, notice: error instanceof Error ? error.message : String(error) });
      });
    return () => abort.abort();
  }, [view]);

  useEffect(() => {
    const owned = controller.current;
    if (!owned) return;
    const abort = new AbortController();
    owned.invalidate("FK declaration changed. Raw joint analysis remains available.");
    setProfile(null);
    const derive = async () => {
      let compiled: CompiledProfile | null = null;
      if (settings.enabled && settings.profileHash) {
        compiled = compiledProfileSchema.parse(await ky.get(`/api/kinematics/profiles/${settings.profileHash}`,
          { signal: abort.signal, retry: 0 }).json<unknown>());
      }
      if (abort.signal.aborted) return;
      setProfile(compiled);
      const admission = declaredFKRequest(settings, compiled, {
        jobId: job.id, episode, actionNames: result.actionNames,
        jointMapping: layout.kind === "rby1" ? layout.channels.filter((channel) => channel.kind === "joint")
          .map((channel) => ({ jointName: channel.channelName, channelName: channel.channelName, sourceIndex: channel.sourceIndex })) : [],
        frames: [],
      });
      if (admission.kind === "ready") owned.start({ ...admission.request,
        frames: trace?.frames.map((frame, index) => ({
          frame, predicted: trace.predicted[index] ?? [], target: trace.target[index] ?? [],
        })) ?? [] }, { sourceFrame: selection.sourceFrame, window: selection.window });
      else owned.invalidate(admission.reason);
    };
    void derive().catch((error: unknown) => {
      if (!abort.signal.aborted) owned.invalidate(error instanceof Error ? error.message : String(error));
    });
    return () => { abort.abort(); owned.invalidate("FK source or declaration changed"); };
  }, [settings, job.id, episode, result.actionNames, trace, layout]);

  useEffect(() => {
    controller.current?.select({ sourceFrame: selection.sourceFrame, window: selection.window });
  }, [selection.sourceFrame, selection.window]);

  useLayoutEffect(() => {
    if (view === "detail" && opener.current) closeButton.current?.focus();
    if (view === "overview" && returnFocus.current) {
      const sourceIndex = opener.current?.dataset["qaDetail"];
      if (sourceIndex !== undefined) workspace.current?.querySelector<HTMLElement>(`[data-qa-detail="${sourceIndex}"]`)?.focus();
      returnFocus.current = false;
      opener.current = null;
    }
  }, [view]);

  const selectFrame = (frame: number) => {
    if (parsed.kind !== "ready") return;
    const nearest = findNearestSourceFrame(parsed.series, frame);
    if (nearest) setSelection((current) => ({ ...current, sourceFrame: nearest.frame }));
  };
  const selectWindow = (window: FrameWindow) => {
    if (parsed.kind !== "ready") return;
    const clamped = clampFrameWindow(parsed.series, window);
    if (clamped) setSelection((current) => ({ ...current, window: clamped }));
  };
  const closeDetail = () => { returnFocus.current = opener.current !== null; setView("overview"); };
  // Ready artifacts must match both the current declaration and the completed controller.
  const completed = fk.status === "ready" && fk.result.jobId === job.id && fk.result.episode === episode
    && settings.enabled && fk.result.profileHash === settings.profileHash && fk.result.jointUnit === settings.jointUnit
    && settings.representation === "absolute_joint_position" && settings.nominalSignZeroConfirmed
    ? fk.result : null;
  const canExport = completed !== null && profile !== null;
  async function exportData(kind: "json" | "csv" | "fk-json" | "fk-csv") {
    setExportError("");
    let artifact: ExportArtifact | FkDownload | null;
    switch (kind) {
      case "json": artifact = { filename: `vlaeval-${job.id}.json`, content: rawJsonExport(result), mediaType: "application/json;charset=utf-8" }; break;
      case "csv": artifact = { filename: `vlaeval-${job.id}.csv`, content: rawTraceCsv(result), mediaType: "text/csv;charset=utf-8" }; break;
      case "fk-json": artifact = canExport && controller.current ? await currentFkExport(controller.current, "json") : null; break;
      case "fk-csv": artifact = canExport && controller.current ? await currentFkExport(controller.current, "csv") : null; break;
      default: { const exhaustive: never = kind; return exhaustive; }
    }
    if (!artifact) { setExportError("No matching completed FK result. Configure and complete this selection first."); return; }
    try { download(artifact); } catch (error) {
      setExportError(error instanceof Error ? `내보내기 실패: ${error.message}` : "내보내기에 실패했습니다.");
    }
  }

  let content;
  switch (view) {
    case "overview":
      content = <OverviewGrid actionNames={result.actionNames} series={series} sourceFrame={selection.sourceFrame}
        window={selection.window} onFrameSelect={selectFrame} onDetailOpen={(dimension) => {
          opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
          setSelection((current) => ({ ...current, dimension })); setView("detail");
        }} />;
      break;
    case "detail":
      content = <><button ref={closeButton} data-close-detail onClick={closeDetail}><X size={16} aria-hidden="true" />Close detail</button>
        <DetailPanel result={result} selectedEpisode={episode} selectedDimension={selection.dimension}
          sourceFrame={selection.sourceFrame ?? 0} window={selection.window} onEpisodeChange={onEpisodeChange}
          onDimensionChange={(dimension) => setSelection((current) => ({ ...current, dimension }))}
          onSourceFrameChange={selectFrame} onWindowChange={selectWindow} renderPlot={(context) => <TracePlot
            series={{ frames: context.series.frames, fps: result.fps,
              predicted: context.series.predicted.map((row) => row[context.selectedDimension] ?? null),
              target: context.series.target.map((row) => row[context.selectedDimension] ?? null) }}
            sourceFrame={selection.sourceFrame} window={selection.window} yDomain={null}
            labels={{ title: context.title, unit: "native / unknown" }} onFrameSelect={selectFrame} detail />} /></>;
      break;
    case "chunks":
      content = <><Field label="Inspect chunk origin (original frame)"><input id="chunk-origin-frame" type="number" min={0} step={1}
        value={selection.chunkOrigin} onChange={(event) => {
          const chunkOrigin = event.currentTarget.valueAsNumber;
          if (Number.isSafeInteger(chunkOrigin) && chunkOrigin >= 0)
            setSelection((current) => ({ ...current, chunkOrigin }));
        }} /></Field><ChunkPanel result={result} selectedEpisode={episode} selectedOriginFrame={selection.chunkOrigin}
          selectedHorizon={selection.chunkHorizon} selectedDimension={selection.dimension} onEpisodeChange={onEpisodeChange}
          onOriginFrameChange={(chunkOrigin) => setSelection((current) => ({ ...current, chunkOrigin }))}
          onHorizonChange={(chunkHorizon) => {
            if (Number.isSafeInteger(chunkHorizon) && chunkHorizon >= 0) setSelection((current) => ({ ...current, chunkHorizon }));
          }} onDimensionChange={(dimension) => setSelection((current) => ({ ...current, dimension }))}
          renderPlot={(context) => <TracePlot series={{ fps: result.fps, frames: context.points.map((point) => context.selectedOriginFrame + point.frame),
            predicted: context.points.map((point) => point.predicted ?? null), target: context.points.map((point) => point.target ?? null) }}
            sourceFrame={selection.chunkOrigin + selection.chunkHorizon}
            window={{ startFrame: context.selectedOriginFrame, endFrame: context.selectedOriginFrame + Math.max(0, context.points.length - 1) }}
            yDomain={null} labels={{ title: `${context.title} · future source time (origin + horizon) / FPS`, unit: "native / unknown" }}
            onFrameSelect={(frame) => setSelection((current) => ({ ...current, chunkHorizon: frame - current.chunkOrigin }))} detail />} /></>;
      break;
    case "metrics": content = <MetricTables result={result} metricTab={metricTab} onMetricTabChange={setMetricTab} />; break;
    case "fk":
      content = <><FKSettings value={settings} profiles={profiles} onChange={(next) => {
        controller.current?.invalidate("FK declaration changed");
        setSettings(next);
      }} notice={catalog.notice} loading={catalog.loading} />
        <div className="cluster"><button data-export="fk-json" disabled={!canExport} onClick={() => exportData("fk-json")}>Derived FK JSON</button>
          <button data-export="fk-csv" disabled={!canExport} onClick={() => exportData("fk-csv")}>Derived FK CSV</button></div>
        <FKPanel state={completed ? fk : fk.status === "ready"
          ? { status: "unavailable", reason: "No matching current FK selection" } : fk}
          frames={series.frames} fps={result.fps} sourceFrame={selection.sourceFrame} window={selection.window} onFrameSelect={selectFrame} /></>;
      break;
    default: { const exhaustive: never = view; return exhaustive; }
  }

  return <div ref={workspace} className="result-workspace" data-job-id={job.id} data-episode={episode}
    data-source-frame={selection.sourceFrame ?? "unavailable"} data-window-start={selection.window.startFrame}
    data-window-end={selection.window.endFrame} data-view={view}
    onKeyDown={(event) => { if (event.key === "Escape" && view === "detail") { event.preventDefault(); closeDetail(); } }}>
    <header className="result-toolbar">
      <div><h2>평가 결과</h2><p>{result.config} · {result.framesEvaluated.toLocaleString()} frames · {result.fps} FPS</p></div>
      <Field label="결과 에피소드"><select id="workspace-episode" value={episode} disabled={!episodes.length}
        onChange={(event) => onEpisodeChange(Number(event.currentTarget.value))}>
        {!episodes.length && <option value={episode}>No saved episode</option>}
        {episodes.map((item) => <option key={item} value={item}>EP {item}</option>)}
      </select></Field>
      <div className="cluster"><button data-export="json" onClick={() => exportData("json")}><FileJson size={16} aria-hidden="true" />결과 JSON</button>
        <button data-export="csv" disabled={!result.traces.length} onClick={() => exportData("csv")}><Download size={16} aria-hidden="true" />전체 trace CSV</button></div>
    </header>
    <CoverageSummary result={result} request={job.request} episode={episode} frames={trace?.frames ?? []} />
    {job.error && <p role="alert" className="notice error">{job.error}</p>}
    {exportError && <p role="alert" className="notice error">{exportError}</p>}
    <dl className="result-scores">
      {([
        ["첫 스텝 MAE", result.firstStepMae], ["첫 스텝 RMSE", result.firstStepRmse],
        ["전체 청크 MAE", result.mae], ["전체 청크 RMSE", result.rmse],
      ] as const).map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{format(value)}</dd></div>)}
      <div><dt>Valid horizon rows</dt><dd>{result.validSteps.toLocaleString()}</dd></div>
    </dl>
    <div className="result-navigation"><div className="result-tabs" role="group" aria-label="Result views">
      {views.map(([name, label]) => <button key={name} data-view-tab={name} aria-pressed={view === name}
        className={view === name ? "selected" : ""} onClick={() => {
          if (view === "detail" && name === "overview") closeDetail(); else setView(name);
        }}>{view === name && <span aria-hidden="true">✓</span>}{label}</button>)}
    </div>
    {(view === "overview" || view === "fk") && <div className="workspace-cursor">
      <Field label="Source frame"><input id="workspace-frame" type="number" min={0} step={1} disabled={selection.sourceFrame === null}
        value={selection.sourceFrame ?? ""} onChange={(event) => selectFrame(event.currentTarget.valueAsNumber)} /></Field>
      <Field label="Window start"><input id="workspace-start" type="number" value={selection.window.startFrame}
        onChange={(event) => selectWindow({ ...selection.window, startFrame: event.currentTarget.valueAsNumber })} /></Field>
      <Field label="Window end"><input id="workspace-end" type="number" value={selection.window.endFrame}
        onChange={(event) => selectWindow({ ...selection.window, endFrame: event.currentTarget.valueAsNumber })} /></Field>
      <output className="mono">Frame {selection.sourceFrame ?? "unavailable"} · {selection.sourceFrame === null ? "unavailable" : selection.sourceFrame / result.fps} s
        {" · "}Window {selection.window.startFrame}–{selection.window.endFrame}</output>
    </div>}</div>
    <div className="result-content">{content}</div>
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
