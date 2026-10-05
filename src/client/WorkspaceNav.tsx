import { Activity, Check, Play } from "lucide-react";

export type WorkspaceView = "preparation" | "analysis";

export function WorkspaceNav({ view, onChange }: {
  readonly view: WorkspaceView;
  readonly onChange: (view: WorkspaceView) => void;
}) {
  return <nav className="workspace-nav" aria-label="평가 작업 공간">
    <button type="button" aria-pressed={view === "preparation"} aria-controls="prepare" onClick={() => onChange("preparation")}><Play size={16} aria-hidden="true" />평가 준비{view === "preparation" && <Check size={14} aria-hidden="true" />}</button>
    <button type="button" aria-pressed={view === "analysis"} aria-controls="results" onClick={() => onChange("analysis")}><Activity size={16} aria-hidden="true" />결과 분석{view === "analysis" && <Check size={14} aria-hidden="true" />}</button>
  </nav>;
}
