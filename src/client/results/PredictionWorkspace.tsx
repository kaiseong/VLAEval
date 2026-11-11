import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import ky from "ky";
import { z } from "zod";
import type { Job } from "../../contracts";
import { compiledProfileSchema } from "../../kinematics/contracts";
import type { CompiledProfile } from "../../kinematics/contracts";
import { createChannelLayout } from "../analysis/channel-layout";
import { predictionRequestSchema } from "../analysis/prediction-contracts";
import type { PredictionRequest } from "../analysis/prediction-contracts";
import { usePrediction } from "../analysis/use-prediction";
import { predictionExport } from "../analysis/prediction-export";
import type { ExportArtifact } from "../analysis/exports";
import type { FrameWindow, RawTraceSeries } from "../analysis/series";
import { Field } from "../ui/primitives";
import { OverviewGrid } from "./OverviewGrid";
import { overviewDisplayChannels } from "./overview-channels";
import { PredictionSettings } from "./PredictionSettings";
import { declaredPredictionSeed, declaredPredictionSource, initialPredictionSettings } from "./prediction-settings";
import type { PredictionSettingsValue } from "./prediction-settings";
import "./prediction.css";

const catalogSchema = z.object({ profiles: z.array(compiledProfileSchema.innerType().omit({ rightChain: true, leftChain: true }).strip()) });
const jointNames = (["left", "right"] as const).flatMap((side) =>
  [...Array.from({ length: 7 }, (_, i) => `${side}_arm_${i}`), `${side}_gripper_0`]);
type Coordinate = "joint" | "cartesian";
type Chunk = NonNullable<Job["result"]>["samples"][number];
const chunkWindow = (chunk: Chunk): FrameWindow => ({ startFrame: chunk.frame, endFrame: chunk.frame + Math.max(0, chunk.valid.lastIndexOf(true)) });
/** Display-only spacing of the drawn inference chunks; metrics always use every chunk. */
const CHUNK_STRIDES = [1, 2, 3, 4, 5, 10] as const;

export function PredictionWorkspace(props: {
  readonly jobId: string;
  readonly result: NonNullable<Job["result"]>;
  readonly episode: number;
  readonly series: RawTraceSeries;
  readonly chunks: NonNullable<Job["result"]>["samples"];
  readonly sourceFrame: number | null;
  readonly window: FrameWindow;
  readonly fullWindow: FrameWindow;
  readonly onFrameSelect: (frame: number) => void;
  readonly onWindowChange: (window: FrameWindow) => void;
  readonly onDownload: (artifact: ExportArtifact) => void;
}) {
  const [settings, setSettings] = useState(() => initialPredictionSettings(props.result.actionNames, props.result.jointObservations));
  const [coordinate, setCoordinate] = useState<Coordinate>("joint");
  const [detail, setDetail] = useState(false);
  const [chunkStride, setChunkStride] = useState<number>(1);
  const [channelsSelected, setChannelsSelected] = useState<{ joint: string | null; cartesian: string | null }>({ joint: null, cartesian: null });
  const [origin, setOrigin] = useState<{ episode: number; frame: number | null }>({ episode: props.episode, frame: null });
  const [profiles, setProfiles] = useState<z.infer<typeof catalogSchema>["profiles"]>([]);
  const [profile, setProfile] = useState<CompiledProfile | null>(null);
  const [profileLoading, setProfileLoading] = useState(false);
  const [error, setError] = useState("");
  const [applied, setApplied] = useState<{ episode: number; request: PredictionRequest } | null>(null);
  const root = useRef<HTMLElement | null>(null), close = useRef<HTMLButtonElement | null>(null);
  const returnFocus = useRef(false);
  const layout = useMemo(() => createChannelLayout(props.result.actionNames), [props.result.actionNames]);
  const observations = useMemo(() => props.result.jointObservations?.samples.filter((sample) => sample.episode === props.episode) ?? [],
    [props.result.jointObservations, props.episode]);
  const request = applied?.episode === props.episode ? applied.request : null;
  const converted = usePrediction(request);
  const data = converted.data?.[coordinate] ?? null;
  const provenance = converted.data?.provenance[coordinate] ?? null;
  const activeOrigin = origin.episode === props.episode ? origin.frame : null;
  const source = request?.source;
  const channels = useMemo(() => {
    if (!data) return overviewDisplayChannels(layout, false);
    if (coordinate === "cartesian") return overviewDisplayChannels(layout, true);
    const unit = provenance === "ik" ? "rad" : source?.kind === "joint" && source.unit !== "unknown" ? source.unit : "native / unknown";
    return overviewDisplayChannels(createChannelLayout(jointNames), false)
      .map((channel) => ({ ...channel, unit: channel.kind === "gripper" ? "native / unknown" : unit }));
  }, [data, layout, coordinate, provenance, source]);
  const channel = channels.find((item) => item.channelName === channelsSelected[coordinate]) ?? channels[0];
  const rawVisible = !data && coordinate === "joint" && settings.kind !== "cartesian";
  const needsSetup = (!data && !rawVisible) || settings.kind === "unknown";
  const declaration = declaredPredictionSource(settings);

  useEffect(() => {
    const abort = new AbortController();
    void ky.get("/api/kinematics/profiles", { signal: abort.signal, retry: 0 }).json<unknown>().then((value) => {
      if (!abort.signal.aborted) setProfiles(catalogSchema.parse(value).profiles);
    }).catch((cause: unknown) => { if (!abort.signal.aborted) setError(cause instanceof Error ? cause.message : String(cause)); });
    return () => abort.abort();
  }, []);
  useEffect(() => {
    const abort = new AbortController();
    setProfile(null);
    setProfileLoading(Boolean(settings.profileHash));
    if (settings.profileHash) void ky.get(`/api/kinematics/profiles/${settings.profileHash}`, { signal: abort.signal, retry: 0 })
      .json<unknown>().then((value) => {
        if (!abort.signal.aborted) { setProfile(compiledProfileSchema.parse(value)); setProfileLoading(false); }
      }).catch((cause: unknown) => {
        if (!abort.signal.aborted) { setError(cause instanceof Error ? cause.message : String(cause)); setProfileLoading(false); }
      });
    return () => abort.abort();
  }, [settings.profileHash]);

  function apply() {
    if (!declaration.source) { setError(declaration.error); return; }
    const parsed = predictionRequestSchema.safeParse({
      actionNames: props.result.actionNames, source: declaration.source,
      profile: profile?.profileHash === settings.profileHash ? profile : null,
      seed: settings.kind === "cartesian" ? declaredPredictionSeed(settings, observations) : null,
      series: props.series, chunks: props.chunks,
    });
    if (!parsed.success) { setError(parsed.error.issues.map((issue) => issue.message).join("; ")); return; }
    setError(""); setDetail(false); setApplied({ episode: props.episode, request: parsed.data });
  }
  // The source declaration is dataset-wide; a new episode uses it with a fresh data identity.
  useEffect(() => { setDetail(false); apply(); }, [props.episode]);
  useLayoutEffect(() => {
    if (detail) close.current?.focus();
    else if (returnFocus.current && channel) {
      root.current?.querySelector<HTMLElement>(`[data-channel-name="${CSS.escape(channel.channelName)}"] [data-qa-detail]`)?.focus();
      returnFocus.current = false;
    }
  }, [detail]);

  const changeSettings = (next: PredictionSettingsValue) => {
    if (next.kind !== settings.kind) setCoordinate(next.kind === "cartesian" ? "cartesian" : "joint");
    setSettings(next); setApplied(null); setError(""); setDetail(false); returnFocus.current = false;
  };
  const closeDetail = () => {
    returnFocus.current = true; setDetail(false);
    if (zoomed) props.onWindowChange(zoomBase);  // zoom is a Detail tool; the grid returns to its span
  };
  const title = `Prediction · ${coordinate === "joint" ? "Joint" : "Cartesian"}${detail ? " · Detail" : ""}`;
  const statisticsIndices = provenance === "source" && source?.kind === "joint"
    ? [...source.left.joints, source.left.gripper, ...source.right.joints, source.right.gripper] : null;
  const originChunk = activeOrigin == null ? undefined : props.chunks.find((item) => item.frame === activeOrigin);
  const zoomBase = originChunk ? chunkWindow(originChunk) : props.fullWindow;
  const zoomed = props.window.startFrame > zoomBase.startFrame || props.window.endFrame < zoomBase.endFrame;
  // Typical spacing of the evaluated inference frames, for the stride labels.
  const inferenceStep = useMemo(() => {
    const frames = [...new Set(props.chunks.map((item) => item.frame))].sort((a, b) => a - b);
    const gaps = frames.slice(1).map((frame, i) => frame - (frames[i] ?? frame)).sort((a, b) => a - b);
    return gaps[Math.floor(gaps.length / 2)] ?? 1;
  }, [props.chunks]);
  const seconds = (frame: number) => (frame / props.result.fps).toFixed(2);
  const shownSource = provenance === "ik" ? "IK 파생값 · 원래 관절값의 복원이 아닙니다"
    : provenance === "fk" ? "FK 파생값 · 어깨 기준 link_torso_5" : `원본 ${settings.kind === "cartesian" ? "Cartesian" : "Joint"}`;
  const displayExport = (format: "json" | "csv") => {
    if (!request || !converted.data) return;
    const artifact = predictionExport({ jobId: props.jobId, episode: props.episode, coordinate, request,
      result: converted.data, channels, format });
    if (artifact) props.onDownload(artifact);
  };

  return <section ref={root} className="prediction-workspace" data-prediction-coordinate={coordinate}
    data-prediction-detail={detail} data-prediction-state={converted.pending ? "pending" : converted.error ? "error" : data ? "ready" : "raw"}
    onKeyDown={(event) => { if (event.key === "Escape" && detail) { event.preventDefault(); closeDetail(); } }}>
    <div className="prediction-toolbar">
      <div className="result-tabs" role="group" aria-label="Prediction coordinates">
        {(["joint", "cartesian"] as const).map((mode) => <button type="button" key={mode} data-coordinate-tab={mode}
          aria-pressed={coordinate === mode} className={coordinate === mode ? "selected" : ""}
          onClick={() => { setCoordinate(mode); setDetail(false); returnFocus.current = false; }}>{mode === "joint" ? "Joint" : "Cartesian"}</button>)}
      </div>
      <Field label="표시할 예측 청크"><select data-prediction-chunk value={activeOrigin ?? "all"} onChange={(event) => {
        const frame = event.currentTarget.value === "all" ? null : Number(event.currentTarget.value);
        setOrigin({ episode: props.episode, frame });
        const chunk = props.chunks.find((item) => item.frame === frame);
        if (chunk) { props.onFrameSelect(chunk.frame); props.onWindowChange(chunkWindow(chunk)); }
        else props.onWindowChange(props.fullWindow);
      }}><option value="all">전체 청크 ({props.chunks.length})</option>
        {[...props.chunks].sort((a, b) => a.frame - b.frame).map((chunk) => <option key={chunk.frame} value={chunk.frame}>
          프레임 {chunk.frame} · {(chunk.frame / props.result.fps).toFixed(3)}초 · H={chunk.predicted.length}
        </option>)}
      </select></Field>
      <Field label="추론 표시 간격"><select data-chunk-stride value={activeOrigin != null ? 1 : chunkStride}
        disabled={activeOrigin != null || props.chunks.length < 2}
        onChange={(event) => setChunkStride(Number(event.currentTarget.value))}>
        {CHUNK_STRIDES.map((stride) => <option key={stride} value={stride}>{activeOrigin != null ? "선택 청크만 표시"
          : stride === 1 ? `간격 없음 (${inferenceStep}프레임마다 추론)` : `${stride * inferenceStep}프레임마다 (추론 ${stride}번에 1번)`}</option>)}
      </select></Field>
      <span className="badge" data-prediction-provenance={provenance ?? "unconfigured"}>{data ? shownSource : "원본 / 변환 설정 확인"}</span>
    </div>
    <details className="prediction-configuration" open={needsSetup}>
      <summary>원본 형식 · FK / IK 변환 설정</summary>
      <PredictionSettings value={settings} actionNames={props.result.actionNames} profiles={profiles} profile={profile}
        observationCount={observations.length} loading={profileLoading} error={error || declaration.error}
        onChange={changeSettings} onApply={apply} />
    </details>
    {converted.pending && <p role="status">선택한 선언으로 좌표를 계산 중입니다…</p>}
    {converted.error && <p role="alert" className="notice error">{converted.error}</p>}
    {!data && !rawVisible && !converted.pending && <p role="status" className="notice">
      {converted.data?.unavailable[coordinate] || "원본 채널·단위를 지정하고 변환 설정을 적용하세요."}</p>}
    {data && <div className="prediction-provenance"><p>{shownSource}
      {coordinate === "cartesian" ? ` · mm / deg · R=Rz(rz)Ry(ry)Rx(rx) · 기준 ${provenance === "source" && source?.kind === "cartesian" ? source.referenceFrame : "link_torso_5"}` : ""}
      {" · "}상단 지표는 원본 액션 기준입니다.</p>
      <div className="cluster"><button type="button" data-export="prediction-json" onClick={() => displayExport("json")}>전체 좌표 JSON</button>
        <button type="button" data-export="prediction-csv" onClick={() => displayExport("csv")}>전체 좌표 CSV</button></div>
    </div>}
    {converted.data && converted.data.issues.length > 0 && <details><summary>변환 경고 · 실패 지점은 빈 구간으로 표시</summary>
      {converted.data.issues.map((issue) => <p key={issue.reason}>{issue.reason}: {issue.count}</p>)}</details>}
    {(data || rawVisible) && <>
      {detail && <div className="prediction-detail-controls"><button ref={close} type="button" data-close-detail onClick={closeDetail}>확대 닫기</button>
        <Field label="확대할 채널"><select id="dimension-select" value={channel?.channelName ?? ""} onChange={(event) => {
          const name = event.currentTarget.value;
          setChannelsSelected((current) => ({ ...current, [coordinate]: name }));
        }}>
          {channels.map((item) => <option key={item.channelName} value={item.channelName}>{item.title} · {item.unit}</option>)}
        </select></Field>
        <div className="prediction-zoom" data-zoom-state={zoomed ? "zoomed" : "full"}>
          <p>{zoomed
            ? `${seconds(props.window.startFrame)}–${seconds(props.window.endFrame)}초 확대 · 휠 또는 Page Up/Down으로 앞뒤 이동`
            : "그래프를 가로로 드래그하면 그 구간을 확대합니다"}</p>
          <button type="button" data-zoom-reset disabled={!zoomed} onClick={() => props.onWindowChange(zoomBase)}>
            {originChunk ? "선택 청크 구간 보기" : "전체 구간 보기"}</button>
        </div></div>}
      <div className={detail ? "detail-panel" : ""}>
        <OverviewGrid key={`${coordinate}-${detail ? channel?.channelName : "grid"}`} actionNames={props.result.actionNames}
          series={props.series} chunks={props.chunks} sourceFrame={props.sourceFrame} window={props.window}
          chunkOrigin={activeOrigin} chunkStride={chunkStride} onFrameSelect={props.onFrameSelect}
          zoom={{ fullWindow: zoomBase, onWindowChange: props.onWindowChange }}
          onDetailOpen={(dimension) => {
            setChannelsSelected((current) => ({ ...current, [coordinate]: channels.find((item) => item.sourceIndex === dimension)?.channelName ?? null }));
            setDetail(true);
          }} {...(detail && channel ? { detailDimension: channel.sourceIndex } : {})}
          {...(data ? { presentation: { coordinateMode: coordinate, title, ...data, channels, statisticsIndices } } : {})} />
      </div>
    </>}
  </section>;
}
