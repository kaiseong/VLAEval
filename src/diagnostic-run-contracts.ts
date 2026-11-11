import { z } from "zod";
import { diagnosticPacketSchema } from "./diagnostic-contracts";
import { attentionVideoSchema } from "./attention-video-contracts";

export const diagnosticAnchorSchema = z.object({
  episode: z.number().int().nonnegative().max(1_000_000),
  frame: z.number().int().nonnegative().max(1_000_000),
}).strict();

export const diagnosticRunStateSchema = diagnosticAnchorSchema.extend({
  runId: z.string().uuid().nullable(),
  jobId: z.string().uuid(),
  status: z.enum(["idle", "preflight", "running", "completed", "failed", "blocked", "unsupported", "cancelling", "cancelled"]),
  message: z.string(),
});
export type DiagnosticRunState = z.infer<typeof diagnosticRunStateSchema>;
export type DiagnosticAnchor = z.infer<typeof diagnosticAnchorSchema>;

export const diagnosticRunnerEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("started"), pid: z.number().int().min(2) }),
  z.object({
    type: z.literal("progress"), message: z.string(),
    status: z.enum(["preflight", "running"]).optional(),
  }),
  z.object({ type: z.literal("result"), packet: diagnosticPacketSchema }),
  z.object({ type: z.literal("video"), video: attentionVideoSchema }),
  z.object({
    type: z.literal("error"), message: z.string(),
    status: z.enum(["failed", "blocked", "unsupported"]).optional(),
  }),
]);
export type DiagnosticRunnerEvent = z.infer<typeof diagnosticRunnerEventSchema>;

export type DiagnosticRequest = {
  readonly jobId: string;
  readonly episode: number;
  readonly frame: number;
  readonly repo: string;
  readonly dataset: string;
  readonly config: string;
  readonly checkpoint: string;
  readonly seed: number;
  readonly numSteps: number;
  readonly actionNames: readonly string[];
  readonly savedActions: readonly (readonly number[])[];
  readonly savedActionsScope: "chunk" | "trace_row";
  readonly savedValid: readonly boolean[];
  readonly minimumFreeMiB: 20480;
};

/** Selects runtime_video_main: every third frame of one episode in one remote process. */
export type AttentionVideoRequest = {
  readonly mode: "video";
  readonly jobId: string;
  readonly episode: number;
  readonly repo: string;
  readonly dataset: string;
  readonly config: string;
  readonly checkpoint: string;
  readonly seed: number;
  readonly numSteps: number;
  readonly stride: 3;
  readonly minimumFreeMiB: 20480;
};

export type DiagnosticRunner<Request = DiagnosticRequest> = (
  execution: { readonly host: string; readonly request: Request; readonly signal: AbortSignal },
  onEvent: (event: DiagnosticRunnerEvent) => void,
) => Promise<void>;

export function diagnosticRunTerminal(state: DiagnosticRunState): boolean {
  return !["idle", "preflight", "running", "cancelling"].includes(state.status);
}

/** HTTP snapshots can arrive after a terminal SSE event for the same execution. */
export function mergeDiagnosticRunState(current: DiagnosticRunState | null, incoming: DiagnosticRunState): DiagnosticRunState {
  if (current?.runId && current.runId === incoming.runId && (
    diagnosticRunTerminal(current)
    || current.status === "cancelling" && ["preflight", "running"].includes(incoming.status)
  )) return current;
  return incoming;
}
