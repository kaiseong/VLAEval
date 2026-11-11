import { expect, test } from "bun:test";
import { mergeDiagnosticRunState } from "../src/diagnostic-run-contracts";
import type { DiagnosticRunState } from "../src/diagnostic-run-contracts";

test("terminal SSE state survives a late cancellation HTTP snapshot", () => {
  const state: DiagnosticRunState = { runId: crypto.randomUUID(), jobId: crypto.randomUUID(),
    episode: 1, frame: 0, status: "cancelled", message: "" };
  expect(mergeDiagnosticRunState(state, { ...state, status: "cancelling" })).toBe(state);
  expect(mergeDiagnosticRunState(state, { ...state, status: "running" })).toBe(state);
  const newRun = { ...state, runId: crypto.randomUUID(), status: "preflight" } as const;
  expect(mergeDiagnosticRunState(state, newRun)).toBe(newRun);
});
