import { useEffect, useMemo, useState } from "react";
import { HTTPError } from "ky";
import { attentionVideoSchema, attentionVideoRunStateSchema } from "../../attention-video-contracts";
import type { AttentionVideo as Video, AttentionVideoRunState } from "../../attention-video-contracts";
import { api, errorMessage } from "../api";
import { Field } from "../ui/primitives";
import { decodeAttentionMap, decodeHalfMap, patchHasImage, topImagePatches } from "../analysis/diagnostic-data";
import type { ContrastCurve } from "../analysis/diagnostic-data";
import { DiagnosticCanvas } from "./DiagnosticCanvas";
import { useAttentionColor } from "./attention-color";

const roleOrder = ["left_wrist", "front", "right_wrist"] as const;
const activeStatuses = ["preflight", "running", "cancelling"];
const cycleLayersPerSecond = 6;
type VideoCamera = Video["cameras"][number];
type VideoMap = Video["frames"][number]["maps"][number];
type LayerView = "mean" | number;

function layerValues(map: VideoMap, camera: VideoCamera, layer: LayerView): Float32Array {
  const patches = camera.gridWidth * camera.gridHeight;
  if (layer === "mean" || map.layersF16LE === undefined) return decodeAttentionMap(map);
  return decodeHalfMap(map.layersF16LE).slice(layer * patches, (layer + 1) * patches);
}

/** Per-camera, whole-video valid-region P95 for one layer view, so colors do not flicker between frames. */
function videoScales(video: Video, layer: LayerView) {
  return new Map(video.cameras.map((camera) => {
    const values: number[] = [];
    for (const frame of video.frames) {
      const map = frame.maps.find((item) => item.modelKey === camera.modelKey);
      const image = frame.images.find((item) => item.modelKey === camera.modelKey);
      if (!map || !image) continue;
      const decoded = layerValues(map, camera, layer);
      const grid = { gridWidth: camera.gridWidth, gridHeight: camera.gridHeight, values: decoded, patchValidFraction: camera.patchValidFraction };
      decoded.forEach((value, i) => { if (patchHasImage(grid, image, i) !== false) values.push(value); });
    }
    values.sort((a, b) => a - b);
    const upper = values[Math.ceil(values.length * 0.95) - 1] || values.at(-1) || 0;
    return [camera.modelKey, upper] as const;
  }));
}

export function AttentionVideo({ jobId, episode, completed }: {
  readonly jobId: string; readonly episode: number; readonly completed: boolean;
}) {
  const [video, setVideo] = useState<Video | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [state, setState] = useState<AttentionVideoRunState | null>(null);
  const [revision, setRevision] = useState(0);
  const [position, setPosition] = useState({ index: 0, layer: 0 });
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [opacity, setOpacity] = useState(0.6);
  const [topCount, setTopCount] = useState(5);
  const [curve, setCurve] = useState<ContrastCurve>("focus");
  const [color, setColor] = useAttentionColor();
  const [layer, setLayer] = useState<LayerView>("mean");
  const [cycle, setCycle] = useState(false);
  const [range, setRange] = useState({ start: 0, end: 0 });
  const base = `/api/jobs/${jobId}/attention-video`;
  const active = state !== null && activeStatuses.includes(state.status);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setError(""); setVideo(null);
    void api.get(`${base}?episode=${episode}`, { signal: controller.signal, timeout: 120_000 }).json<unknown>()
      .then((value) => {
        if (controller.signal.aborted) return;
        const parsed = attentionVideoSchema.parse(value);
        setVideo(parsed); setPosition({ index: 0, layer: 0 }); setRange({ start: 0, end: parsed.frames.length - 1 });
        setLayer("mean"); setCycle(false); setPlaying(false);
      })
      .catch(async (cause: unknown) => {
        if (controller.signal.aborted || cause instanceof HTTPError && cause.response.status === 404) return;
        const message = await errorMessage(cause);
        if (!controller.signal.aborted) setError(message);
      }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    if (completed) void api.get(`${base}/run?episode=${episode}`, { signal: controller.signal }).json<unknown>()
      .then((value) => { if (!controller.signal.aborted) setState(attentionVideoRunStateSchema.parse(value)); })
      .catch(() => { /* Run status is optional; the artifact request reports actionable errors. */ });
    return () => controller.abort();
  }, [base, episode, completed, revision]);

  useEffect(() => {
    if (!active) return;
    const source = new EventSource(`${base}/run/events?episode=${episode}`);
    source.onmessage = (event) => {
      const next = attentionVideoRunStateSchema.parse(JSON.parse(event.data));
      setState(next);
      if (!activeStatuses.includes(next.status)) {
        source.close();
        if (next.status === "completed") setRevision((value) => value + 1);
      }
    };
    source.onerror = () => source.close();
    return () => source.close();
  }, [active, base, episode, state?.runId]);

  async function command(cancel: boolean) {
    setError("");
    try {
      setState(attentionVideoRunStateSchema.parse(await api.post(cancel ? `${base}/run/cancel` : `${base}/run`,
        { json: cancel ? { runId: state?.runId } : { episode } }).json()));
    } catch (cause) { setError(await errorMessage(cause)); }
  }

  const frames = video?.frames ?? [];
  const layerCount = video?.selection.layerCount ?? 0;
  const canCycle = layerCount > 0;
  const start = Math.min(range.start, Math.max(0, frames.length - 1));
  const end = Math.max(start, Math.min(range.end, frames.length - 1));
  const cycling = cycle && canCycle;
  const tickPerSecond = cycling ? cycleLayersPerSecond * speed : video ? video.fps / video.selection.stride * speed : 10;
  useEffect(() => {
    if (!playing || frames.length === 0) return;
    const timer = setInterval(() => setPosition((current) => {
      const nextIndex = current.index + 1 > end || current.index < start ? start : current.index + 1;
      if (!cycling) return { index: nextIndex, layer: current.layer };
      return current.layer + 1 < layerCount ? { index: current.index, layer: current.layer + 1 } : { index: nextIndex, layer: 0 };
    }), 1000 / tickPerSecond);
    return () => clearInterval(timer);
  }, [playing, frames.length, tickPerSecond, cycling, layerCount, start, end]);

  const shownLayer: LayerView = cycling ? position.layer : layer;
  const scales = useMemo(() => video ? videoScales(video, shownLayer) : new Map<string, number>(), [video, shownLayer]);
  const frame = frames[Math.min(position.index, frames.length - 1)];
  const cameras = video ? [...video.cameras].sort((a, b) => roleOrder.indexOf(a.role) - roleOrder.indexOf(b.role)) : [];
  const layerLabel = shownLayer === "mean" ? "레이어 평균" : `L${shownLayer} (${shownLayer + 1}/${layerCount})`;
  const frameIndexFor = (value: number) => Math.max(0, Math.min(frames.length - 1, Math.round(value / (video?.selection.stride ?? 1))));

  return <section className="attention-video" data-attention-video={video ? "ready" : "missing"}>
    <header className="cluster spread"><div><h3>Attention 동영상 · EP {episode}</h3>
      <p className="muted">마지막 디노이즈 스텝 · 전체 query · 3프레임 간격. 레이어는 평균 또는 0~{Math.max(0, layerCount - 1)}을 고르거나, 순회 모드로 프레임마다 모든 레이어를 차례로 봅니다. 색 상한은 선택한 레이어 기준 카메라별 영상 전체 P95로 고정해 프레임 간 비교가 가능합니다.</p></div></header>
    {error && <pre role="alert" className="notice error">{error}</pre>}
    <div className="cluster">
      <button type="button" data-attention-video-run disabled={!completed || active}
        onClick={() => void command(false)}>{video ? "동영상 다시 계산" : "에피소드 attention 동영상 계산 (RTX6000 GPU)"}</button>
      {active && <button type="button" className="danger" data-attention-video-cancel disabled={state?.status === "cancelling"}
        onClick={() => void command(true)}>계산 취소</button>}
      {state && state.status !== "idle" && <span role="status" data-attention-video-status={state.status}>{state.status} · {state.message}</span>}
    </div>
    {loading ? <p role="status">저장된 동영상 확인 중</p> : !video ? <p className="muted">이 에피소드의 attention 동영상이 아직 없습니다. 계산은 별도 GPU 프로세스로 실행되며 일반 평가와 동시에 실행하지 않습니다.</p> : <>
      {!canCycle && <p className="notice" role="status">이 동영상은 레이어 평균만 저장된 이전 형식입니다. "동영상 다시 계산"을 누르면 레이어별 보기와 순회 모드를 쓸 수 있습니다.</p>}
      <div className="cluster attention-video__controls">
        <button type="button" data-attention-video-play onClick={() => setPlaying((value) => !value)}>{playing ? "일시정지" : "재생"}</button>
        <input type="range" aria-label="프레임" data-attention-video-seek min={0} max={Math.max(0, frames.length - 1)} value={position.index}
          onChange={(event) => { setPlaying(false); const index = event.currentTarget.valueAsNumber; setPosition((current) => ({ ...current, index })); }} />
        <span className="mono" data-attention-video-frame={frame?.frame} data-attention-video-layer={String(shownLayer)}>
          frame {frame?.frame} · {frame?.timestampSeconds.toFixed(2)} s · {position.index + 1}/{frames.length} · {layerLabel}</span>
      </div>
      <div className="cluster attention-video__controls">
        <Field label="레이어"><select data-attention-video-layer-select value={String(layer)} disabled={cycling} onChange={(event) => {
          const value = event.currentTarget.value;
          setLayer(value === "mean" ? "mean" : Number(value));
        }}><option value="mean">평균 (전체 {layerCount || "?"}개)</option>
          {Array.from({ length: layerCount }, (_, i) => <option key={i} value={i}>Layer {i}</option>)}</select></Field>
        <label><input type="checkbox" data-attention-video-cycle checked={cycling} disabled={!canCycle}
          onChange={(event) => { setCycle(event.currentTarget.checked); setPosition((current) => ({ ...current, layer: 0 })); }} />레이어 순회 (프레임마다 0→{Math.max(0, layerCount - 1)})</label>
        <Field label="구간 시작 frame"><input type="number" data-attention-video-start min={0} step={video.selection.stride}
          value={frames[start]?.frame ?? 0} onChange={(event) => {
            const value = event.currentTarget.valueAsNumber;
            if (Number.isFinite(value)) setRange((current) => ({ ...current, start: frameIndexFor(value) }));
          }} /></Field>
        <Field label="구간 끝 frame"><input type="number" data-attention-video-end min={0} step={video.selection.stride}
          value={frames[end]?.frame ?? 0} onChange={(event) => {
            const value = event.currentTarget.valueAsNumber;
            if (Number.isFinite(value)) setRange((current) => ({ ...current, end: frameIndexFor(value) }));
          }} /></Field>
        <Field label="속도"><select value={speed} onChange={(event) => setSpeed(Number(event.currentTarget.value))}>
          {[0.25, 0.5, 1, 2, 4].map((value) => <option key={value} value={value}>{value}×</option>)}</select></Field>
      </div>
      <div className="cluster attention-video__controls">
        <Field label={`투명도 ${Math.round(opacity * 100)}%`}><input type="range" min={0} max={1} step={0.05} value={opacity}
          onChange={(event) => setOpacity(event.currentTarget.valueAsNumber)} /></Field>
        <Field label="색 강조"><select data-attention-video-curve value={curve} onChange={(event) => {
          const value = event.currentTarget.value;
          if (value === "focus" || value === "sqrt" || value === "linear") setCurve(value);
        }}><option value="focus">높은 값만 강조</option><option value="sqrt">부드럽게</option><option value="linear">선형</option></select></Field>
        <Field label="색"><input type="color" data-attention-video-color value={color}
          onChange={(event) => setColor(event.currentTarget.value)} /></Field>
        <Field label="상위 칸 수 (0=끄기)"><input type="number" data-attention-video-top min={0} max={100} step={1}
          value={topCount} onChange={(event) => {
            const value = event.currentTarget.valueAsNumber;
            if (Number.isInteger(value) && value >= 0 && value <= 100) setTopCount(value);
          }} /></Field>
      </div>
      {frame && <div className="diagnostic-triple">
        {cameras.map((camera) => {
          const image = frame.images.find((item) => item.modelKey === camera.modelKey);
          const raw = frame.maps.find((item) => item.modelKey === camera.modelKey);
          if (!image || !raw) return <p key={camera.modelKey}>{camera.role} 데이터 없음</p>;
          const map = { gridWidth: camera.gridWidth, gridHeight: camera.gridHeight, values: layerValues(raw, camera, shownLayer), patchValidFraction: camera.patchValidFraction };
          const mass = map.values.reduce((sum, value) => sum + value, 0), uniform = mass / map.values.length;
          const top = topCount > 0 ? topImagePatches(map, image, topCount) : [];
          return <div key={camera.modelKey} data-attention-video-panel={camera.role}>
            <strong className="diagnostic-triple__title">{camera.role} · 카메라 attention {(mass * 100).toFixed(2)}%</strong>
            <DiagnosticCanvas key={`${camera.modelKey}:${image.width}x${image.height}`} image={image} heatmap={map}
              maximum={scales.get(camera.modelKey) ?? 0} enhanced curve={curve} floor={uniform} color={color} opacity={opacity} trajectories={[]} mode="original"
              topPatches={top} badge={`frame ${frame.frame} · ${shownLayer === "mean" ? "평균" : `L${shownLayer}`}`}
              describePatch={(i) => `${camera.role} · ${layerLabel} · 칸 #${i}\nattention ${(map.values[i] ?? 0).toPrecision(4)}\n균등 기준의 ${uniform > 0 ? ((map.values[i] ?? 0) / uniform).toFixed(2) : "—"}배`} />
          </div>;
        })}
      </div>}
    </>}
  </section>;
}
