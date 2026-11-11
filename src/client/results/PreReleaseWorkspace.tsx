import { useEffect, useMemo, useRef, useState } from "react";
import { Camera, FlaskConical } from "lucide-react";
import { HTTPError } from "ky";
import type { Job } from "../../contracts";
import { diagnosticPacketSchema, maximumDiagnosticBytes } from "../../diagnostic-contracts";
import type { DiagnosticPacket } from "../../diagnostic-contracts";
import { compiledProfileSchema } from "../../kinematics/contracts";
import type { CompiledProfile } from "../../kinematics/contracts";
import { api, errorMessage } from "../api";
import { Field } from "../ui/primitives";
import { attentionDisplayIntensity, attentionDisplayScale, patchHasImage, selectAttention, sharedImageMaximum, topImagePatches, validateDiagnosticPayload } from "../analysis/diagnostic-data";
import type { AttentionDisplayMode, ContrastCurve, LayerChoice, QueryGroupChoice } from "../analysis/diagnostic-data";
import { projectSavedChunk } from "../analysis/project-saved-chunk";
import { DiagnosticCanvas } from "./DiagnosticCanvas";
import { DiagnosticLauncher } from "./DiagnosticLauncher";
import { ProjectionLauncher } from "./ProjectionLauncher";
import { AttentionVideo } from "./AttentionVideo";
import { useAttentionColor } from "./attention-color";
import "./prerelease.css";

export function PreReleaseWorkspace({ job, episode, frame }: {
  readonly job: Job;
  readonly episode: number;
  readonly frame: number | null;
}) {
  const [packet, setPacket] = useState<DiagnosticPacket | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  const [uploading, setUploading] = useState(false);
  const [quickStart, setQuickStart] = useState(0);
  const runReady = frame !== null && job.status === "completed";
  const runDiagnostic = () => setQuickStart((value) => value + 1);
  const request = useRef<AbortController | null>(null);
  const identity = `${job.id}:${episode}:${frame}`;
  const currentIdentity = useRef(identity);
  currentIdentity.current = identity;
  const endpoint = frame === null ? null : `/api/jobs/${job.id}/diagnostics?episode=${episode}&frame=${frame}`;
  const currentPacket = packet?.identity.jobId === job.id && packet.identity.episode === episode && packet.identity.frame === frame
    ? packet : null;

  useEffect(() => {
    const controller = new AbortController();
    request.current = controller;
    setPacket(null); setError(""); setPending(Boolean(endpoint));
    if (endpoint) void api.get(endpoint, { signal: controller.signal }).json<unknown>().then((value) => {
      const parsed = diagnosticPacketSchema.parse(value);
      const reason = validateDiagnosticPayload(parsed);
      if (reason) throw new Error(reason);
      if (!controller.signal.aborted) setPacket(parsed);
    }).catch(async (cause: unknown) => {
      if (controller.signal.aborted || cause instanceof HTTPError && cause.response.status === 404) return;
      const message = await errorMessage(cause);
      if (!controller.signal.aborted) setError(message);
    }).finally(() => { if (!controller.signal.aborted) setPending(false); });
    return () => controller.abort();
  }, [endpoint, revision]);

  async function importPacket(file: File) {
    if (!endpoint) return;
    const startedIdentity = identity;
    setUploading(true); setError("");
    try {
      if (file.size > maximumDiagnosticBytes) throw new Error("진단 파일은 16 MiB 이하여야 합니다.");
      const value = diagnosticPacketSchema.parse(JSON.parse(await file.text()));
      if (value.identity.jobId !== job.id || value.identity.episode !== episode || value.identity.frame !== frame)
        throw new Error("선택한 실행·EP·프레임과 진단 파일이 다릅니다.");
      const reason = validateDiagnosticPayload(value);
      if (reason) throw new Error(reason);
      await api.put(endpoint, { json: value });
      if (currentIdentity.current === startedIdentity) setRevision((value) => value + 1);
    } catch (cause) {
      const message = await errorMessage(cause);
      if (currentIdentity.current === startedIdentity) setError(message);
    } finally { setUploading(false); }
  }

  return <section className="prerelease" data-prerelease-frame={frame ?? "unavailable"}>
    <header className="prerelease__heading"><div><h2><FlaskConical size={20} aria-hidden="true" />Pre-release</h2>
      <p>Front 카메라 투영 · Action → Image attention</p></div>
      <span className="badge">실험 기능</span></header>
    <div className="prerelease__connection">
      <ProjectionLauncher key={`projection:${identity}`} jobId={job.id} dataset={job.result?.dataset ?? job.request.dataset}
        episode={episode} frame={frame} enabled={job.status === "completed"
          && Boolean(job.result?.samples.some((sample) => sample.episode === episode && sample.frame === frame))}
        onCompleted={() => setRevision((value) => value + 1)} />
      <DiagnosticLauncher key={identity} jobId={job.id} episode={episode} frame={frame} completed={job.status === "completed"}
        onCompleted={() => setRevision((value) => value + 1)} startRequest={quickStart} />
      <p>프레임 이동이나 이 화면을 여는 동작은 추론을 실행하지 않습니다.</p>
      <div className="cluster">
        <button type="button" data-diagnostic-refresh disabled={!endpoint || pending || uploading}
          onClick={() => setRevision((value) => value + 1)}>저장 결과 새로고침</button>
        <Field label="어댑터 결과 JSON 불러오기"><input type="file" accept=".json,application/json" data-diagnostic-import
          disabled={!endpoint || uploading || job.status !== "completed"} onChange={(event) => {
            const file = event.currentTarget.files?.[0];
            event.currentTarget.value = "";
            if (file) void importPacket(file);
          }} /></Field>
      </div>
      <small>선택: EP {episode} · Frame {frame ?? "없음"} · 파일/API 수신 계약 v1/v2 · 최대 16 MiB</small>
    </div>
    <AttentionVideo key={`video:${job.id}:${episode}`} jobId={job.id} episode={episode} completed={job.status === "completed"} />
    {error && <pre role="alert" className="notice error">{error}</pre>}
    {pending || uploading ? <p role="status">{uploading ? "진단 결과 검증·저장 중" : "저장된 진단 결과 확인 중"}</p>
      : currentPacket && job.result ? <DiagnosticResult key={`${identity}:${revision}`} packet={currentPacket} result={job.result}
        onRunDiagnostic={runReady ? runDiagnostic : null} />
        : <div className="prerelease__empty"><Camera size={32} aria-hidden="true" />
          <h3>이 프레임의 진단 데이터가 없습니다</h3>
          {runReady && <button type="button" className="primary" data-quick-diagnostic onClick={runDiagnostic}>
            이 프레임 진단 실행 (RTX6000 GPU · 약 20초)</button>}
          <p>원본 이미지와 전처리 대응 정보가 필요합니다. 투영에는 같은 로봇·카메라의 보정값과 기준 자세가 추가로 필요합니다.</p>
          <p>보정·영상이 없는 상태에서 임의 궤적이나 attention을 생성하지 않습니다.</p>
        </div>}
  </section>;
}

function DiagnosticResult({ packet, result, onRunDiagnostic }: {
  readonly packet: DiagnosticPacket;
  readonly result: NonNullable<Job["result"]>;
  readonly onRunDiagnostic: (() => void) | null;
}) {
  const attention = packet.attention;
  const [step, setStep] = useState(attention?.steps.at(-1)?.index ?? 0);
  const [layer, setLayer] = useState<LayerChoice>("all");
  const [query, setQuery] = useState<QueryGroupChoice>("all");
  const frontKey = packet.images.find((image) => image.role === "front")?.modelKey ?? packet.images[0]?.modelKey ?? "";
  const [camera, setCamera] = useState(attention && packet.images.length > 1 ? "all" : frontKey);
  const roleOrder = ["left_wrist", "front", "right_wrist"] as const;
  const orderedImages = [...packet.images].sort((a, b) => roleOrder.indexOf(a.role) - roleOrder.indexOf(b.role));
  const allView = camera === "all";
  const focusKey = allView ? frontKey : camera;
  const [showAttention, setShowAttention] = useState(Boolean(attention));
  const [showProjection, setShowProjection] = useState(Boolean(packet.projection));
  const [opacity, setOpacity] = useState(0.6);
  const [imageMode, setImageMode] = useState<"original" | "tokens" | "compare">(
    !attention || packet.images.find((image) => image.role === "front")?.preprocessing ? "original" : "tokens");
  const [maskLetterbox, setMaskLetterbox] = useState(false);
  const [displayMode, setDisplayMode] = useState<AttentionDisplayMode>("camera");
  const [selectedPatch, setSelectedPatch] = useState<number | null>(null);
  const [fixedUpper, setFixedUpper] = useState(0.002);
  const [topCount, setTopCount] = useState(5);
  const [curve, setCurve] = useState<ContrastCurve>("focus");
  const [color, setColor] = useAttentionColor();
  const [profile, setProfile] = useState<CompiledProfile | null>(null);
  const [profileError, setProfileError] = useState("");
  const hash = packet.projection?.profileHash;
  useEffect(() => {
    const abort = new AbortController();
    if (hash) void api.get(`/api/kinematics/profiles/${hash}`, { signal: abort.signal }).json<unknown>().then((value) => {
      if (!abort.signal.aborted) setProfile(compiledProfileSchema.parse(value));
    }).catch(async (cause: unknown) => {
      const message = await errorMessage(cause);
      if (!abort.signal.aborted) setProfileError(message);
    });
    return () => abort.abort();
  }, [hash]);
  const selected = useMemo(() => selectAttention(packet, step, layer, query), [packet, step, layer, query]);
  const tokenLabels = useMemo(() => {
    const labels = new Map<number, string>();
    const layout = packet.adapterMetadata?.["token_layout"];
    if (typeof layout !== "object" || layout === null || !("prompt" in layout)) return labels;
    const prompt = layout.prompt;
    if (typeof prompt !== "object" || prompt === null || !("tokens" in prompt) || !Array.isArray(prompt.tokens)) return labels;
    for (const token of prompt.tokens) {
      if (typeof token === "object" && token !== null && "key" in token && "piece" in token
        && typeof token.key === "number" && typeof token.piece === "string") labels.set(token.key, token.piece);
    }
    return labels;
  }, [packet.adapterMetadata]);
  const projection = useMemo(() => projectSavedChunk(result, packet, profile), [result, packet, profile]);
  const maximum = selected ? sharedImageMaximum(selected.maps, packet.images) : 0;
  // Per-camera display state; raw values and masses are never modified.
  const viewFor = (key: string) => {
    const image = packet.images.find((item) => item.modelKey === key);
    const map = selected?.maps.find((item) => item.modelKey === key) ?? null;
    const display = map && image ? attentionDisplayScale(map, image, maximum, displayMode, fixedUpper) : null;
    const cameraMass = selected?.masses.filter((mass) => mass.kind === "image" && mass.modelKey === key)
      .reduce((sum, mass) => sum + mass.value, 0) ?? 0;
    // Equal split of this camera's raw mass over every one of its patches.
    const uniform = map && map.values.length ? cameraMass / map.values.length : 0;
    const letterboxShare = map && map.letterboxMass != null && cameraMass > 0 ? map.letterboxMass / cameraMass : null;
    const topPatches = map && image && topCount > 0 ? topImagePatches(map, image, topCount) : [];
    const projected = projection.kind === "ready" && packet.projection?.modelKey === key ? projection.trajectories : [];
    const describePatch = map && image ? (index: number) => {
      const value = map.values[index] ?? 0, kind = patchHasImage(map, image, index);
      const rank = topPatches.indexOf(index);
      return `${image.role} · 칸 #${index} (행 ${Math.floor(index / map.gridWidth)}, 열 ${index % map.gridWidth})${rank >= 0 ? ` · 상위 ${rank + 1}` : ""}\n`
        + `attention ${value.toPrecision(4)} (전체 대비 ${(value * 100).toFixed(4)}%)\n`
        + `균등 기준의 ${uniform > 0 ? (value / uniform).toFixed(2) : "—"}배 · 카메라 안 ${cameraMass > 0 ? (value / cameraMass * 100).toFixed(2) : "—"}%\n`
        + (kind === null ? "기하 미확정" : kind ? "영상 칸" : "검은 여백 칸(영상 밖)");
    } : undefined;
    return { key, image, map, display, cameraMass, uniform, letterboxShare, topPatches, projected, describePatch };
  };
  const focus = viewFor(focusKey);
  const { image, map, display, uniform, topPatches } = focus;
  const patch = selectedPatch !== null && map && selectedPatch < map.values.length ? selectedPatch : null;
  const projected = focus.projected;
  // Shared/fixed scales keep their linear meaning unless the focus curve is chosen explicitly.
  const curveFor = (view: ReturnType<typeof viewFor>): ContrastCurve =>
    curve !== "sqrt" ? curve : view.display?.enhanced ? "sqrt" : "linear";
  const colorbar = (view: ReturnType<typeof viewFor>) => showAttention && view.display && view.display.upper > 0
    && <div className="attention-colorbar" data-attention-colorbar={view.key}>
      <div className="attention-colorbar__ramp" style={{ background: `linear-gradient(to right, ${Array.from({ length: 11 }, (_, i) =>
        `color-mix(in srgb, ${color} ${Math.round(100 * opacity * attentionDisplayIntensity((view.display?.upper ?? 0) * i / 10, view.display?.upper ?? 0, curveFor(view), view.uniform))}%, transparent) ${i * 10}%`).join(", ")})` }}>
        {view.uniform > 0 && <span className="attention-colorbar__uniform" data-attention-uniform={view.uniform}
          style={{ left: `${Math.min(100, view.uniform / view.display.upper * 100)}%` }} />}
      </div>
      <div className="attention-colorbar__labels"><span>0</span>
        <span>균등 기준 {view.uniform.toPrecision(3)}{view.uniform > view.display.upper ? " (상한 초과)" : ""}</span>
        <span>{view.display.upper.toPrecision(3)}+</span></div>
      {view.topPatches.length > 0 && view.map && <small data-attention-top-list>상위 칸(유효 영상): {view.topPatches.map((index, rank) =>
        `${rank + 1}=#${index} ${((view.map?.values[index] ?? 0) / (view.uniform || 1)).toFixed(1)}×균등`).join(" · ")}</small>}
    </div>;
  const omitted = projected.reduce((count, line) => count + line.points.filter((point) => point.kind !== "visible").length, 0);
  const projectionPointCount = projected.reduce((count, line) => count + line.points.length, 0);
  const outsideImage = projected.reduce((count, line) => count + line.points.filter(
    (point) => point.kind === "unavailable" && point.reason === "outside_image").length, 0);

  return <div className="diagnostic-result" data-diagnostic-kind={packet.provenance.kind}
    data-attention-step={step} data-attention-layer={layer} data-attention-query={query}
    data-attention-scale={displayMode} data-attention-upper={display?.upper}>
    {packet.provenance.kind === "synthetic" && <p className="notice" role="status"><strong>합성 검증 데이터</strong> · 실제 로봇 또는 모델 성능 결과가 아닙니다.</p>}
    <div className="prerelease__controls">
      <Field label="카메라"><select data-diagnostic-camera value={camera} onChange={(event) => setCamera(event.currentTarget.value)}>
        {packet.images.length > 1 && <option value="all">전체 3개 · left · front · right</option>}
        {orderedImages.map((item) => <option key={item.modelKey} value={item.modelKey}>{item.role} · {item.modelKey}</option>)}
      </select></Field>
      {attention && <>
        <Field label="디노이즈 스텝"><select data-diagnostic-step value={step} onChange={(event) => setStep(Number(event.currentTarget.value))}>
          {attention.steps.map((item) => <option key={item.index} value={item.index}>{item.index + 1}/{attention.steps.length} · t={item.flowTime}</option>)}
        </select></Field>
        <Field label="트랜스포머 레이어"><select data-diagnostic-layer value={layer}
          onChange={(event) => setLayer(event.currentTarget.value === "all" ? "all" : Number(event.currentTarget.value))}>
          <option value="all">전체 {attention.layers.length}개 레이어 평균</option>
          {attention.layers.map((item) => <option key={item} value={item}>Layer {item} · {item + 1}/{attention.layers.length}층</option>)}
        </select></Field>
        <Field label="Action query 시점 구간"><select data-diagnostic-query value={query} onChange={(event) => {
          const value = event.currentTarget.value;
          if (value === "all" || value === "early" || value === "late") setQuery(value);
        }}><option value="all">전체 · query 수 가중 평균</option><option value="early">청크 앞부분</option><option value="late">청크 뒷부분</option></select></Field>
      </>}
    </div>
    <div className="cluster prerelease__toggles">
      <Field label="이미지 표시"><select data-diagnostic-image-mode value={imageMode} onChange={(event) => {
        if (event.currentTarget.value === "original" || event.currentTarget.value === "tokens" || event.currentTarget.value === "compare")
          setImageMode(event.currentTarget.value);
      }}><option value="original">원본 RGB</option><option value="tokens" disabled={!attention && !image?.preprocessing}>모델 토큰 격자 · 여백 포함</option>
        <option value="compare" disabled={!attention && !image?.preprocessing}>원본 ↔ 모델 격자 대조</option></select></Field>
      {attention && <Field label="Attention 표시 대비"><select data-diagnostic-scale value={displayMode} onChange={(event) => {
        if (event.currentTarget.value === "camera" || event.currentTarget.value === "shared") setDisplayMode(event.currentTarget.value);
        if (event.currentTarget.value === "fixed") setDisplayMode("fixed");
      }}><option value="camera">카메라 유효 영역 · 대비 강화</option><option value="shared">원시 공통 스케일 · 선형</option>
        <option value="fixed">선형 · 고정 상한</option></select></Field>}
      {attention && <Field label="색 강조"><select data-diagnostic-curve value={curve} onChange={(event) => {
        const value = event.currentTarget.value;
        if (value === "focus" || value === "sqrt" || value === "linear") setCurve(value);
      }}><option value="focus">높은 값만 강조 · 균등 이하 숨김</option><option value="sqrt">부드럽게(기존)</option>
        <option value="linear">선형</option></select></Field>}
      {attention && <Field label="Attention 색"><input type="color" data-diagnostic-color value={color}
        onChange={(event) => setColor(event.currentTarget.value)} /></Field>}
      {attention && displayMode === "fixed" && <Field label="고정 상한 (원시 가중치)"><input type="number" data-diagnostic-fixed-upper
        min={0.00001} max={1} step={0.0005} value={fixedUpper} onChange={(event) => {
          const value = event.currentTarget.valueAsNumber;
          if (Number.isFinite(value) && value > 0 && value <= 1) setFixedUpper(value);
        }} /></Field>}
      {attention && <Field label="상위 칸 수 (0=끄기)"><input type="number" data-diagnostic-top min={0} max={100} step={1}
        value={topCount} onChange={(event) => {
          const value = event.currentTarget.valueAsNumber;
          if (Number.isInteger(value) && value >= 0 && value <= 100) setTopCount(value);
        }} /></Field>}
      <label><input type="checkbox" data-diagnostic-mask-letterbox checked={maskLetterbox}
        disabled={imageMode === "original" || !map?.patchValidFraction} onChange={(event) => setMaskLetterbox(event.currentTarget.checked)} />순수 여백 패치 숨김</label>
      <label><input type="checkbox" checked={showAttention} disabled={!attention} onChange={(event) => setShowAttention(event.currentTarget.checked)} />Attention 표시</label>
      <label><input type="checkbox" checked={showProjection} disabled={!packet.projection} onChange={(event) => setShowProjection(event.currentTarget.checked)} />양팔 TCP 궤적 표시</label>
      <Field label={`Attention 투명도 ${Math.round(opacity * 100)}%`}><input type="range" min={0} max={1} step={0.05}
        value={opacity} onChange={(event) => setOpacity(event.currentTarget.valueAsNumber)} /></Field>
    </div>
    {imageMode === "compare" && allView && <p className="muted">대조 보기는 front 카메라 기준입니다. 다른 카메라는 카메라 선택에서 고르세요.</p>}
    {imageMode === "compare" && map && image && <div className="cluster diagnostic-patch-inspector">
      <Field label={`대조할 패치 (0–${map.values.length - 1})`}><input type="number" data-diagnostic-patch
        min={0} max={map.values.length - 1} step={1} value={patch ?? ""} onChange={(event) => {
          const value = event.currentTarget.valueAsNumber;
          setSelectedPatch(Number.isInteger(value) && value >= 0 && value < map.values.length ? value : null);
        }} /></Field>
      <button type="button" disabled={patch === null} onClick={() => setSelectedPatch(null)}>선택 해제</button>
      <span data-patch-inspection>{patch === null ? "패치를 누르거나 번호를 입력해 대응 위치를 확인하세요."
        : `패치 ${patch} · 행 ${Math.floor(patch / map.gridWidth)}, 열 ${patch % map.gridWidth} · 원시 가중치 ${map.values[patch]?.toPrecision(5)} · ${
          patchHasImage(map, image, patch) === null ? "기하 미확정: 원본 대응 불가"
            : patchHasImage(map, image, patch) ? "영상과 겹치는 패치" : "순수 여백: 원본 영상에 대응 위치 없음"}`}</span>
    </div>}
    {!attention && <div className="notice attention-missing" role="status" data-attention-missing>
      <strong>이 프레임은 attention이 아직 계산되지 않았습니다.</strong>
      <span>영상·궁적만 불러온 상태입니다. 선택 프레임 진단(RTX6000 GPU, 약 20초)을 실행하면 맵이 표시됩니다.</span>
      {onRunDiagnostic && <button type="button" className="primary" data-quick-diagnostic onClick={onRunDiagnostic}>이 프레임 진단 실행</button>}
    </div>}
    <div className="prerelease__visuals">
      <div>
        {allView && imageMode !== "compare" ? <div className="diagnostic-triple" data-diagnostic-triple>
          {orderedImages.map((item) => {
            const view = viewFor(item.modelKey);
            return <div key={item.modelKey} data-diagnostic-panel={item.role}>
              <strong className="diagnostic-triple__title">{item.role}</strong>
              <DiagnosticCanvas key={`${item.modelKey}:${item.sha256}:${imageMode}`} image={item}
                heatmap={showAttention ? view.map : null} maximum={view.display?.upper ?? maximum}
                enhanced={view.display?.enhanced ?? false} opacity={opacity} trajectories={showProjection ? view.projected : []}
                mode={imageMode === "tokens" ? "tokens" : "original"} maskLetterbox={maskLetterbox}
                topPatches={showAttention ? view.topPatches : []}
                describePatch={view.describePatch} curve={curveFor(view)} floor={view.uniform} color={color} />
              {colorbar(view)}
            </div>;
          })}
        </div> : <>
        <div className={imageMode === "compare" ? "diagnostic-pair" : undefined}>
          {image && (imageMode === "compare" ? ["original", "tokens"] as const : [imageMode]).map((mode) =>
            <DiagnosticCanvas key={`${image.modelKey}:${image.sha256}:${image.width}:${image.height}:${mode}`}
              image={image} heatmap={showAttention ? map : null} maximum={display?.upper ?? maximum}
              enhanced={display?.enhanced ?? false} opacity={opacity} trajectories={showProjection ? projected : []}
              mode={mode} maskLetterbox={maskLetterbox} selectedPatch={imageMode === "compare" ? patch : null}
              onPatchSelect={setSelectedPatch} topPatches={showAttention ? topPatches : []}
              describePatch={focus.describePatch} curve={curveFor(focus)} floor={focus.uniform} color={color} />)}
        </div>
        {colorbar(focus)}
        </>}
        <div className="prerelease__legend">
          {showAttention && display && <span data-attention-scale-legend>
            Attention 표시 범위 0–{display.upper.toPrecision(4)} · {display.enhanced
              ? `선택 카메라 유효 영역 P95 · 제곱근 대비 · 상한 초과 유효 패치 ${display.clipped}개 포화 · 카메라 간 색 농도 직접 비교 불가`
              : displayMode === "fixed" ? `사용자 고정 상한 · 선형 · 상한 초과 유효 패치 ${display.clipped}개 포화 · 프레임·레이어 간 비교 가능`
                : "전체 카메라·여백 포함 공통 최대값 · 선형 표시"}
            {display.reason && " · 유효 영역을 확정할 수 없어 공통 스케일 사용"}
            {" · "}표시만 조정하며 원시 가중치·배분 수치는 유지
          </span>}
          {showProjection && <span>왼팔: 청록 · 오른팔: 황토 · 예측: 실선 · GT 목표: 점선 · 투영 제외 {omitted}점</span>}
        </div>
        {showProjection && imageMode !== "tokens" && projectionPointCount > 0 && omitted === projectionPointCount
          && <p className="notice" role="status" data-projection-empty data-outside-image={outsideImage}>
            현재 청크는 영상 안에 표시할 수 있는 TCP 점이 없습니다. 화면 밖 {outsideImage}점 · 기타 제외 {omitted - outsideImage}점.
            {" "}팔이 화면 안에 들어오는 프레임을 선택하세요.
          </p>}
      </div>
      <aside className="prerelease__mass">
        <h3>Attention 배분</h3>
        {!attention ? <p>수신된 attention이 없습니다.</p> : !selected ? <p>선택 구간에 유효 query가 없습니다.</p> : <>
          <p>유효 query {selected.queryCount}개 · head 평균 · {layer === "all" ? `${selected.layerCount}개 레이어 균등 평균` : `Layer ${layer}`}</p>
          {selected.masses.map((mass) => <div key={mass.id} data-attention-mass={mass.id} data-value={mass.value}>
            <span>{mass.kind}{mass.modelKey ? ` · ${mass.modelKey}` : ` · ${mass.id}`}</span>
            <strong>{(mass.value * 100).toFixed(2)}%</strong><meter min={0} max={1} value={mass.value} aria-label={mass.id} />
          </div>)}
          <small>이미지 밖 텍스트·상태·액션 비중을 포함한 원래 softmax 배분입니다.</small>
          {selected.maps.map((item) => {
            const cameraMass = selected.masses.filter((mass) => mass.kind === "image" && mass.modelKey === item.modelKey)
              .reduce((sum, mass) => sum + mass.value, 0);
            return <p key={item.modelKey} data-letterbox-camera={item.modelKey}>
              {item.modelKey} 여백: {item.letterboxMass === null ? "기하 미확정 / 미제공"
                : `전체 attention의 ${(item.letterboxMass * 100).toFixed(2)}% · 해당 카메라 질량 중 ${cameraMass > 0 ? (item.letterboxMass / cameraMass * 100).toFixed(2) : "—"}%`}
            </p>;
          })}
          <small>여백 숨김은 표시만 바꿉니다. 부분 패치의 유효 픽셀 비율은 attention 질량의 실제 분할값이 아닙니다.</small>
        </>}
      </aside>
    </div>
    <p className="muted">레이어는 트랜스포머 깊이, 디노이즈 스텝은 flow matching 반복입니다. 깊은 층의 이미지 토큰에는 다른 위치·토큰 정보가 섞입니다.
      {" "}색칠된 패치만 보았다는 뜻이나 행동 원인·affordance의 확정값이 아닙니다. 팔별 attention은 제공하지 않습니다.</p>
    {showProjection && <div className="notice">
      {packet.projection ? <>
        <p>보정 {packet.projection.calibrationId} · 기준 {packet.projection.referenceFrame} · 현재 카메라/몸통 기준 고정 가정</p>
        <p>{packet.projection.poseEvidence.kind}: {packet.projection.poseEvidence.description}</p>
        <p>GT는 저장된 목표 액션의 TCP 경로이며 측정된 손끝 이동이 아닙니다.</p>
        {projection.kind === "unavailable" && <p role="status">투영 준비 안 됨: {profileError || projection.reason}</p>}
      </> : <p>카메라 보정·기준 자세 입력이 없습니다.</p>}
    </div>}
    <details><summary>집중 토큰 후보 / 수치 차이 / 실행 정보</summary>
      {packet.adapterArrays && <a className="diagnostic-array-download"
        href={`data:application/octet-stream;base64,${packet.adapterArrays.dataBase64}`}
        download={`attention-${packet.identity.episode}-${packet.identity.frame}.npz`}>원본 어댑터 배열 NPZ 다운로드</a>}
      <p>{attention?.sinkMethod ?? "Sink 정보 없음"} · 후보는 개별 레이어·구간의 원시 값이며 평균 맵의 top-k가 아닙니다. 무의미한 토큰이라는 확정 판정도 아닙니다.</p>
      {selected?.sinks.map((sink, i) => <p key={i}>Layer {sink.layer} · {sink.queryGroup} · key {sink.keyIndex} · {sink.label}
        {tokenLabels.has(sink.keyIndex) && ` · ${tokenLabels.get(sink.keyIndex)}`} · {(sink.mass * 100).toFixed(3)}%</p>)}
      <div className="table-scroll" tabIndex={0} role="region" aria-label="저장 액션 대비 수치 차이">
        <table><caption>어댑터 보고: 저장 액션 대비 차이 · 통과/실패 판정 아님</caption>
          <thead><tr><th>채널</th><th>단위</th><th>최대 절대 차이</th><th>atol / rtol</th><th>초과 개수</th></tr></thead>
          <tbody>{packet.actionDifferences.map((item) => <tr key={item.channel}><th>{item.channel}</th><td>{item.unit}</td>
            <td>{item.maxAbsolute.toPrecision(5)}</td><td>{item.atol ?? "—"} / {item.rtol ?? "—"}</td><td>{item.exceededCount ?? "—"}</td></tr>)}</tbody>
        </table>
      </div>
      {packet.sameProcessDifferences && <details><summary>같은 프로세스의 일반 추론 대비 진단 차이</summary>
        {packet.sameProcessDifferences.map((item) => <p key={item.channel}>{item.channel} · {item.maxAbsolute.toPrecision(5)} {item.unit}</p>)}
      </details>}
      <p>{packet.provenance.backend} · {packet.provenance.dtype} · compile {String(packet.provenance.compiled)} · adapter {packet.provenance.adapterRevision}</p>
      <p>컴파일 {packet.timing.compileMs ?? "—"} ms · 워밍업 {packet.timing.warmupMs ?? "—"} ms · 추론 {packet.timing.inferenceMs ?? "—"} ms
        {" · "}추출 {packet.timing.extractionMs ?? "—"} ms · peak GPU {packet.timing.peakGpuBytes ?? "—"} bytes</p>
      <p>전체 진단 {packet.timing.totalMs ?? "—"} ms · 전처리 {packet.timing.prepareMs ?? "—"} ms · 비교 추론 {packet.timing.referenceInferenceMs ?? "—"} ms
        {" · "}전송 {packet.timing.hostTransferBytes ?? "—"} bytes · 컴파일 임시 공간 {packet.timing.compiledTempBytes ?? "—"} bytes (추가 GPU 점유량과 다름)</p>
    </details>
  </div>;
}
