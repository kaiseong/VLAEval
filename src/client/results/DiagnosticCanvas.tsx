import { useId, useState } from "react";
import type { DiagnosticImage } from "../../diagnostic-contracts";
import type { TrajectoryProjection } from "../../kinematics/projection";
import { attentionDisplayIntensity, inverseImageTransform } from "../analysis/diagnostic-data";
import type { ContrastCurve } from "../analysis/diagnostic-data";

export type ProjectedOverlay = {
  readonly side: "left" | "right";
  readonly source: "predicted" | "target";
  readonly points: readonly TrajectoryProjection[];
};

export function DiagnosticCanvas({ image, heatmap, maximum, opacity, trajectories, mode = "original", maskLetterbox = false,
  enhanced = false, selectedPatch = null, onPatchSelect, topPatches = [], describePatch, curve, floor = 0, color = "var(--danger)", badge }: {
  readonly image: DiagnosticImage;
  readonly heatmap: { readonly gridWidth: number; readonly gridHeight: number; readonly values: Float32Array;
    readonly patchValidFraction?: readonly number[] | null | undefined } | null;
  readonly maximum: number;
  readonly opacity: number;
  readonly trajectories: readonly ProjectedOverlay[];
  readonly mode?: "original" | "tokens";
  readonly maskLetterbox?: boolean;
  readonly enhanced?: boolean;
  readonly selectedPatch?: number | null;
  readonly onPatchSelect?: (index: number) => void;
  readonly topPatches?: readonly number[];
  readonly describePatch?: ((index: number) => string) | undefined;
  readonly curve?: ContrastCurve | undefined;
  readonly floor?: number;
  readonly color?: string;
  readonly badge?: string | undefined;
}) {
  const [hover, setHover] = useState<{ readonly index: number; readonly x: number; readonly y: number } | null>(null);
  const clipId = useId();
  const [imageState, setImageState] = useState<"loading" | "ready" | "invalid">("loading");
  const preprocessing = image.preprocessing;
  const viewWidth = mode === "original" ? image.width : preprocessing?.inputWidth ?? heatmap?.gridWidth ?? 1;
  const viewHeight = mode === "original" ? image.height : preprocessing?.inputHeight ?? heatmap?.gridHeight ?? 1;
  const [x, y, width, height] = preprocessing?.contentRect ?? [0, 0, viewWidth, viewHeight];
  const source = `data:${image.mime};base64,${image.dataBase64}`;
  const canOverlay = mode === "tokens" || preprocessing !== null;
  return <figure className="diagnostic-canvas" data-image-state={imageState} data-image-mode={mode}>
    <div className="diagnostic-canvas__image" style={{ aspectRatio: `${viewWidth}/${viewHeight}` }}>
      <img src={source} style={{ visibility: mode === "tokens" ? "hidden" : "visible" }} alt={`${image.role} 원본 · ${image.timestampSeconds.toFixed(3)}초`}
        onLoad={(event) => setImageState(event.currentTarget.naturalWidth === image.width
          && event.currentTarget.naturalHeight === image.height ? "ready" : "invalid")}
        onError={() => setImageState("invalid")} />
      {imageState === "ready" && <svg viewBox={`0 0 ${viewWidth} ${viewHeight}`} role="img"
        aria-label="Attention 가중치와 양팔 TCP 목표 궤적" data-diagnostic-overlay>
        <defs><clipPath id={clipId}><rect x={x} y={y} width={width} height={height} /></clipPath></defs>
        {mode === "tokens" && preprocessing && <rect width={viewWidth} height={viewHeight} fill="black" />}
        {mode === "tokens" && preprocessing && <g clipPath={`url(#${clipId})`}>
          <image href={source} width={image.width} height={image.height}
            transform={`matrix(${preprocessing.sourceToInput.join(" ")})`} />
        </g>}
        {heatmap && canOverlay && <g transform={mode === "original" ? `matrix(${inverseImageTransform(image).join(" ")})` : undefined}>
          <g clipPath={mode === "original" ? `url(#${clipId})` : undefined} data-attention-grid>
            {Array.from(heatmap.values, (value, i) => <rect key={i} data-attention-patch={i}
              onClick={() => onPatchSelect?.(i)}
              onPointerMove={(event) => {
                const box = event.currentTarget.ownerSVGElement?.getBoundingClientRect();
                if (box) setHover({ index: i, x: event.clientX - box.left, y: event.clientY - box.top });
              }}
              onPointerLeave={() => setHover((current) => current?.index === i ? null : current)}
              x={i % heatmap.gridWidth * (preprocessing?.inputWidth ?? viewWidth) / heatmap.gridWidth}
              y={Math.floor(i / heatmap.gridWidth) * (preprocessing?.inputHeight ?? viewHeight) / heatmap.gridHeight}
              width={(preprocessing?.inputWidth ?? viewWidth) / heatmap.gridWidth} height={(preprocessing?.inputHeight ?? viewHeight) / heatmap.gridHeight}
              fill={color} opacity={maskLetterbox && heatmap.patchValidFraction?.[i] === 0 ? 0
                : opacity * attentionDisplayIntensity(value, maximum, curve ?? enhanced, floor)}>
              <title>patch {i}: {value.toPrecision(5)}</title>
            </rect>)}
          </g>
          <g clipPath={mode === "original" ? `url(#${clipId})` : undefined} pointerEvents="none" data-attention-top>
            {topPatches.map((index, rank) => {
              const w = (preprocessing?.inputWidth ?? viewWidth) / heatmap.gridWidth;
              const h = (preprocessing?.inputHeight ?? viewHeight) / heatmap.gridHeight;
              const px = index % heatmap.gridWidth * w, py = Math.floor(index / heatmap.gridWidth) * h;
              return <g key={index} data-attention-top-patch={index}>
                <rect x={px} y={py} width={w} height={h} fill="none" stroke="white" strokeWidth={1.5}
                  strokeDasharray="3 2" vectorEffect="non-scaling-stroke" />
                <text x={px + w * 0.12} y={py + h * 0.42} fontSize={h * 0.38} fill="white" stroke="black"
                  strokeWidth={h * 0.04} paintOrder="stroke">{rank + 1}</text>
              </g>;
            })}
          </g>
          {selectedPatch !== null && selectedPatch < heatmap.values.length && <g
            clipPath={mode === "original" ? `url(#${clipId})` : undefined} pointerEvents="none">
            <rect data-attention-selection={selectedPatch}
              x={selectedPatch % heatmap.gridWidth * (preprocessing?.inputWidth ?? viewWidth) / heatmap.gridWidth}
              y={Math.floor(selectedPatch / heatmap.gridWidth) * (preprocessing?.inputHeight ?? viewHeight) / heatmap.gridHeight}
              width={(preprocessing?.inputWidth ?? viewWidth) / heatmap.gridWidth}
              height={(preprocessing?.inputHeight ?? viewHeight) / heatmap.gridHeight}
              fill="none" stroke="var(--accent)" strokeWidth={2} vectorEffect="non-scaling-stroke" />
          </g>}
        </g>}
        {mode === "original" && trajectories.map((trajectory) => {
          let drawing = false;
          const path = trajectory.points.map((point) => {
            if (point.kind !== "visible") { drawing = false; return ""; }
            const command = drawing ? "L" : "M";
            drawing = true;
            return `${command}${point.u},${point.v}`;
          }).join(" ");
          const color = trajectory.side === "left" ? "var(--accent)" : "var(--target)";
          return <g key={`${trajectory.side}-${trajectory.source}`} data-projected-side={trajectory.side}
            data-projected-source={trajectory.source}>
            <path d={path} fill="none" stroke={color} strokeWidth={2.5} vectorEffect="non-scaling-stroke"
              strokeDasharray={trajectory.source === "target" ? "6 4" : undefined} />
            {trajectory.points.map((point, h) => point.kind === "visible"
              ? <path key={h} d={`M${point.u},${point.v} l0,0`} fill="none" stroke={color}
                strokeWidth={4} strokeLinecap="round" vectorEffect="non-scaling-stroke">
                <title>{trajectory.side} {trajectory.source} · h={h} · z={point.depthM.toFixed(3)} m</title>
              </path> : null)}
          </g>;
        })}
      </svg>}
      {hover && describePatch && heatmap && <div className="diagnostic-canvas__hover" data-attention-hover={hover.index}
        style={{ left: hover.x, top: hover.y, transform: `translate(${hover.x > 160 ? "-100%" : "0"}, ${hover.y > 80 ? "-110%" : "20%"})` }}>
        {describePatch(hover.index)}
      </div>}
      {badge && imageState === "ready" && <span className="diagnostic-canvas__badge" data-canvas-badge>{badge}</span>}
      {imageState === "loading" && <span className="diagnostic-canvas__state" role="status">원본 이미지 확인 중</span>}
      {imageState === "invalid" && <span className="diagnostic-canvas__state" role="alert">이미지 디코딩 또는 해상도 불일치 · 오버레이 표시 안 함</span>}
    </div>
    <figcaption>{image.datasetKey} → {image.modelKey} · {image.width}×{image.height} · {mode === "original" ? "원본 좌표" : "모델 토큰 격자 · 여백 포함"}
      {!preprocessing && heatmap && " · 모델 전처리 기하 미확정: 원본 attention 오버레이 불가"}</figcaption>
  </figure>;
}
