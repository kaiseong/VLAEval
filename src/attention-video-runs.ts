import { JobError } from "./jobs";
import type { JobStore } from "./jobs";
import { attentionVideoAnchorSchema, attentionVideoRunTerminal } from "./attention-video-contracts";
import type { AttentionVideo, AttentionVideoRunState } from "./attention-video-contracts";
import type { AttentionVideoRequest, DiagnosticRunner } from "./diagnostic-run-contracts";
import { runDiagnostic } from "./diagnostic-runner";
import { runStateStream } from "./diagnostic-runs";

type Listener = (state: AttentionVideoRunState) => void;
type Run = {
  readonly runId: string;
  readonly controller: AbortController;
  state: AttentionVideoRunState;
  persisting: boolean;
};

/** Episode attention-video runs keyed by (jobId, episode); the store owns the shared GPU slot. */
export class AttentionVideoRunManager {
  private readonly states = new Map<string, AttentionVideoRunState>();
  private readonly listeners = new Map<string, Set<Listener>>();
  private active: Run | null = null;

  constructor(
    private readonly store: JobStore,
    private readonly runner: DiagnosticRunner<AttentionVideoRequest> = runDiagnostic,
  ) {}

  private key(jobId: string, episode: number): string {
    return `${jobId}/${episode}`;
  }

  get(jobId: string, episode: number): AttentionVideoRunState {
    attentionVideoAnchorSchema.parse({ episode });
    this.store.attentionVideoJob(jobId, episode);
    return this.states.get(this.key(jobId, episode))
      ?? { runId: null, jobId, episode, status: "idle", message: "" };
  }

  subscribe(jobId: string, episode: number, listener: Listener): () => void {
    this.get(jobId, episode);
    const key = this.key(jobId, episode);
    let listeners = this.listeners.get(key);
    if (!listeners) { listeners = new Set(); this.listeners.set(key, listeners); }
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.listeners.delete(key);
    };
  }

  private publish(run: Run, status: AttentionVideoRunState["status"], message: string): void {
    if (run.state.status === status && run.state.message === message) return;
    run.state = { ...run.state, status, message };
    const key = this.key(run.state.jobId, run.state.episode);
    this.states.set(key, run.state);
    for (const listener of this.listeners.get(key) ?? []) listener(run.state);
  }

  start(jobId: string, episode: number): AttentionVideoRunState {
    attentionVideoAnchorSchema.parse({ episode });
    const runId = crypto.randomUUID();
    // Synchronous acquisition happens before source reads, SSH, or any other await.
    const job = this.store.acquireAttentionVideoRun(jobId, episode, runId);
    const result = job.result;
    if (!result) {
      this.store.releaseDiagnosticRun(runId);
      throw new JobError("Completed result is missing", 409);
    }
    const request: AttentionVideoRequest = {
      mode: "video", jobId, episode, repo: job.request.repo,
      dataset: result.dataset, config: result.config, checkpoint: result.checkpoint,
      seed: result.seed, numSteps: result.numSteps, stride: 3, minimumFreeMiB: 20480,
    };
    const run: Run = {
      runId, controller: new AbortController(), persisting: false,
      state: { runId, jobId, episode, status: "idle", message: "" },
    };
    this.active = run;
    this.publish(run, "preflight", "Checking diagnostic resources");
    const initial = run.state;
    void this.execute(run, { host: job.request.host, request });
    return initial;
  }

  cancel(jobId: string, runId: string): AttentionVideoRunState {
    const run = this.active;
    if (!run || run.runId !== runId || run.state.jobId !== jobId) {
      const state = [...this.states.values()].find((item) => item.runId === runId && item.jobId === jobId);
      if (state) return state;
      throw new JobError("Attention video run was not found", 404);
    }
    if (!run.persisting && !run.controller.signal.aborted) {
      this.publish(run, "cancelling", "Waiting for remote diagnostic termination");
      run.controller.abort();
    }
    return run.state;
  }

  private async execute(run: Run, execution: { readonly host: string; readonly request: AttentionVideoRequest }): Promise<void> {
    let video: AttentionVideo | null = null;
    let terminal: AttentionVideoRunState["status"] = "completed";
    let message = "Attention video saved";
    let workerFailure = false;
    try {
      await this.runner({ ...execution, signal: run.controller.signal }, (event) => {
        switch (event.type) {
          case "started":
            if (!run.controller.signal.aborted) this.publish(run, "running", "Diagnostic worker started");
            break;
          case "progress":
            if (!run.controller.signal.aborted) this.publish(run, event.status ?? "running", event.message);
            break;
          case "video":
            if (video) throw new JobError("Worker emitted multiple attention videos", 502);
            video = event.video;
            break;
          case "result":
            throw new JobError("Attention video run received a selected-frame packet", 502);
          case "error":
            workerFailure = true;
            terminal = event.status ?? "failed";
            message = event.message;
            break;
          default: {
            const exhaustive: never = event;
            throw new JobError(`Unknown diagnostic event: ${exhaustive}`, 502);
          }
        }
      });
      if (run.controller.signal.aborted) {
        terminal = "cancelled";
        message = "Remote diagnostic process exited";
      } else if (!workerFailure) {
        if (!video) throw new JobError("Worker exited without an attention video", 502);
        run.persisting = true;
        const parsed: AttentionVideo = video;
        if (parsed.identity.jobId !== run.state.jobId || parsed.identity.episode !== run.state.episode)
          throw new JobError("Attention video does not match the selected episode", 502);
        await this.store.saveAttentionVideo(run.state.jobId, parsed, run.runId);
      }
    } catch (error) {
      terminal = "failed";
      message = error instanceof Error ? error.message : String(error);
    } finally {
      this.store.releaseDiagnosticRun(run.runId);
      this.active = null;
      this.publish(run, terminal, message);
    }
  }
}

const managers = new WeakMap<JobStore, AttentionVideoRunManager>();
export function attentionVideosFor(store: JobStore): AttentionVideoRunManager {
  let manager = managers.get(store);
  if (!manager) { manager = new AttentionVideoRunManager(store); managers.set(store, manager); }
  return manager;
}

export function attentionVideoEventStream(
  request: Request, manager: AttentionVideoRunManager, jobId: string, episode: number,
): Response {
  manager.get(jobId, episode);
  return runStateStream(request, {
    current: () => manager.get(jobId, episode),
    subscribe: (listener) => manager.subscribe(jobId, episode, listener),
    terminal: attentionVideoRunTerminal,
  });
}
