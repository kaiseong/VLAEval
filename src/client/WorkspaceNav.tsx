import { Activity, Check, Play, Table2 } from "lucide-react";

export type WorkspaceView = "preparation" | "analysis" | "evaluation";

export function WorkspaceNav({ view, onChange }: {
  readonly view: WorkspaceView;
  readonly onChange: (view: WorkspaceView) => void;
}) {
  return <nav className="workspace-nav" aria-label="평가 작업 공간">
    <button type="button" aria-pressed={view === "preparation"} aria-controls="prepare" onClick={() => onChange("preparation")}><Play size={16} aria-hidden="true" />평가 준비{view === "preparation" && <Check size={14} aria-hidden="true" />}</button>
    <button type="button" aria-pressed={view === "analysis"} aria-controls="results" onClick={() => onChange("analysis")}><Activity size={16} aria-hidden="true" />결과 분석{view === "analysis" && <Check size={14} aria-hidden="true" />}</button>
    <button type="button" aria-pressed={view === "evaluation"} aria-controls="evaluation-results" onClick={() => onChange("evaluation")}><Table2 size={16} aria-hidden="true" />평가 결과{view === "evaluation" && <Check size={14} aria-hidden="true" />}</button>
  </nav>;
}
