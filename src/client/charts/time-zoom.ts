import type { FrameWindow } from "../analysis/series";

/** Drag shorter than this (CSS px) stays a click that selects a frame. */
export const BRUSH_MIN_PX = 6;
/** Narrowest zoom: whole frames, at least this many frames wide. */
export const MIN_ZOOM_FRAMES = 2;

/** Drag-to-zoom is possible only when the bounds are wider than the narrowest zoom. */
export const canZoom = (full: FrameWindow) => full.endFrame - full.startFrame > MIN_ZOOM_FRAMES;

export const isZoomed = (window: FrameWindow, full: FrameWindow) =>
  window.startFrame > full.startFrame || window.endFrame < full.endFrame;

/** Brushed frame interval -> whole-frame window inside `full`, at least MIN_ZOOM_FRAMES wide. */
export function brushWindow(a: number, b: number, full: FrameWindow): FrameWindow | null {
  if (![a, b, full.startFrame, full.endFrame].every(Number.isFinite)) return null;
  const fullSpan = full.endFrame - full.startFrame;
  if (fullSpan <= MIN_ZOOM_FRAMES) return null;
  let start = Math.max(full.startFrame, Math.floor(Math.min(a, b)));
  let end = Math.min(full.endFrame, Math.ceil(Math.max(a, b)));
  if (end - start < MIN_ZOOM_FRAMES) {
    const mid = (start + end) / 2;
    start = Math.max(full.startFrame, Math.floor(mid - MIN_ZOOM_FRAMES / 2));
    end = Math.min(full.endFrame, start + MIN_ZOOM_FRAMES);
    start = Math.max(full.startFrame, end - MIN_ZOOM_FRAMES);
  }
  return { startFrame: start, endFrame: end };
}

/** Shift a zoomed window by `deltaFrames`, keeping its span and staying inside `full`. */
export function panWindow(window: FrameWindow, full: FrameWindow, deltaFrames: number): FrameWindow {
  const span = window.endFrame - window.startFrame;
  if (!Number.isFinite(deltaFrames) || span >= full.endFrame - full.startFrame) return window;
  const start = Math.max(full.startFrame, Math.min(full.endFrame - span, Math.round(window.startFrame + deltaFrames)));
  return start === window.startFrame ? window : { startFrame: start, endFrame: start + span };
}

/** Wheel delta in CSS px: the dominant axis, lines and pages scaled to px. Positive = later in time. */
export function wheelPixels(event: Pick<WheelEvent, "deltaX" | "deltaY" | "deltaMode">, pagePx: number) {
  const raw = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
  return raw * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? pagePx : 1);
}
