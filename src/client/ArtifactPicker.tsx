import { useEffect, useRef, useState } from "react";
import { RefreshCw } from "lucide-react";
import { checkpointCatalogSchema, datasetuiSchema, hostSchema } from "../contracts";
import { api, errorMessage } from "./api";
import { Field } from "./ui/primitives";

type Choice = { readonly path: string; readonly label: string };
type Catalog = {
  readonly key: string;
  readonly status: "loading" | "ready" | "error";
  readonly choices: readonly Choice[];
  readonly warnings: readonly string[];
  readonly error: string;
};

export function ArtifactPicker(props: {
  readonly kind: "openpi" | "datasetui";
  readonly host: string;
  readonly value: string;
  readonly disabled: boolean;
  readonly onSelect: (path: string) => void;
}) {
  const { kind, host, value, disabled, onSelect } = props;
  const key = `${kind}:${host}`;
  const controller = useRef<AbortController | null>(null);
  const initialized = useRef(false);
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const current = catalog?.key === key ? catalog : null;
  const title = kind === "openpi" ? "OpenPI 체크포인트" : "DatasetUI 데이터셋";

  async function load() {
    controller.current?.abort();
    const request = new AbortController();
    controller.current = request;
    setCatalog({ key, status: "loading", choices: [], warnings: [], error: "" });
    try {
      const json = { host: hostSchema.parse(host) };
      let choices: Choice[];
      let warnings: string[];
      switch (kind) {
        case "openpi": {
          const data = checkpointCatalogSchema.parse(await api.post("/api/openpi-checkpoints", { json, signal: request.signal }).json());
          choices = data.checkpoints.map((item) => ({
            path: item.path,
            label: `${item.path.split("/").at(-1)} · ${item.format.toUpperCase()}${item.step === null ? "" : ` · step ${item.step}`}`,
          }));
          warnings = data.warnings;
          break;
        }
        case "datasetui": {
          const data = datasetuiSchema.parse(await api.post("/api/datasetui", { json, signal: request.signal }).json());
          const names = new Map<string, number>();
          for (const item of data.datasets) names.set(item.name, (names.get(item.name) ?? 0) + 1);
          choices = data.datasets.map((item) => ({
            path: item.path,
            label: `${item.name} · ${item.storageArea} · ${item.episodes ?? "?"} EP${item.version ? ` · ${item.version}` : ""}${(names.get(item.name) ?? 0) > 1 ? ` · ${item.id.slice(0, 8)}` : ""}`,
          }));
          warnings = data.warnings;
          break;
        }
        default: { const exhaustive: never = kind; return exhaustive; }
      }
      if (request.signal.aborted) return;
      choices.sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true }));
      setCatalog({ key, status: "ready", choices, warnings, error: "" });
    } catch (cause) {
      if (request.signal.aborted) return;
      const error = await errorMessage(cause);
      if (!request.signal.aborted) setCatalog({ key, status: "error", choices: [], warnings: [], error });
    }
  }

  // Load once when preparation becomes editable. Typing a new host never starts SSH requests.
  useEffect(() => {
    if (!disabled && !initialized.current) { initialized.current = true; void load(); }
  }, [disabled]);
  useEffect(() => () => controller.current?.abort(), [key]);

  const choices = current?.choices ?? [];
  return <div className="artifact-picker" data-artifact-kind={kind} data-catalog-status={current?.status ?? "idle"}>
    <div className="cluster spread"><strong>{title}</strong>
      <button type="button" disabled={disabled || current?.status === "loading"} onClick={() => void load()}>
        <RefreshCw size={16} aria-hidden="true" />목록 새로고침
      </button></div>
    <Field label={`${title} 선택`} hint={kind === "openpi"
      ? "~/.cache/openpi/openpi-assets/checkpoints (원격 서버)"
      : "DatasetUI(rtx6000) 준비 완료 raw / derived 목록 · NAS 경로는 모든 평가 서버에서 같습니다"}>
      <select data-artifact-select={kind} disabled={disabled || current?.status !== "ready" || !choices.length}
        value={choices.some((choice) => choice.path === value) ? value : ""}
        onChange={(event) => onSelect(event.currentTarget.value)}>
        <option value="">목록에서 선택하세요</option>
        {choices.map((choice) => <option key={choice.path} value={choice.path}>{choice.label}</option>)}
      </select>
    </Field>
    <p className="muted" role="status">{current?.status === "loading" ? `${title} 목록을 읽고 있습니다…`
      : current?.status === "ready" ? choices.length ? `${choices.length}개 · 선택하면 아래 경로에 반영됩니다.` : "사용 가능한 항목이 없습니다. 직접 경로를 입력할 수도 있습니다."
      : current?.status === "error" ? "목록 조회에 실패했습니다. 연결을 확인한 뒤 새로고침하세요."
      : "호스트를 확인한 뒤 목록을 새로고침하세요."}</p>
    {current?.error && <p className="notice error" role="alert">{current.error}</p>}
    {current && current.warnings.length > 0 && <details>
      <summary>목록 주의사항 {current.warnings.length}개</summary>
      <div className="warning-list" tabIndex={0} role="region" aria-label={`${title} 주의사항`}>
        {current.warnings.map((warning, index) => <p key={index}>{warning}</p>)}
      </div>
    </details>}
  </div>;
}
