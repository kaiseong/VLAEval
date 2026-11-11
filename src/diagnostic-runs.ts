import { JobError } from "./jobs";
import type { JobStore } from "./jobs";
import type { DiagnosticPacket } from "./diagnostic-contracts";
import {
  diagnosticAnchorSchema, diagnosticRunTerminal,
} from "./diagnostic-run-contracts";
import type {
  DiagnosticAnchor, DiagnosticRequest, DiagnosticRunner, DiagnosticRunState,
} from "./diagnostic-run-contracts";
import { runDiagnostic } from "./diagnostic-runner";

type Listener = (state: DiagnosticRunState) => void;
type Run = {
  readonly runId: string;
  readonly controller: AbortController;
  state: DiagnosticRunState;
  persisting: boolean;
};

/** One manager owns each store's selected-frame states; the store owns the global GPU slot. */
export class DiagnosticRunManager {
  private readonly states = new Map<string, DiagnosticRunState>();
  private readonly listeners = new Map<string, Set<Listener>>();
  private active: Run | null = null;

  constructor(private readonly store: JobStore, private readonly runner: DiagnosticRunner = runDiagnostic) {}

  private key(jobId: string, anchor: DiagnosticAnchor): string {
    return `${jobId}/${anchor.episode}/${anchor.frame}`;
  }

  get(jobId: string, anchor: DiagnosticAnchor): DiagnosticRunState {
    diagnosticAnchorSchema.parse(anchor);
    this.store.diagnosticJob(jobId, anchor.episode, anchor.frame);
    return this.states.get(this.key(jobId, anchor))
      ?? { runId: null, jobId, ...anchor, status: "idle", message: "" };
  }

  subscribe(jobId: string, anchor: DiagnosticAnchor, listener: Listener): () => void {
    this.get(jobId, anchor);
    const key = this.key(jobId, anchor);
    let listeners = this.listeners.get(key);
    if (!listeners) { listeners = new Set(); this.listeners.set(key, listeners); }
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.listeners.delete(key);
    };
  }

  private publish(run: Run, status: DiagnosticRunState["status"], message: string): void {
    if (run.state.status === status && run.state.message === message) return;
    run.state = { ...run.state, status, message };
    const key = this.key(run.state.jobId, run.state);
    this.states.set(key, run.state);
    for (const listener of this.listeners.get(key) ?? []) listener(run.state);
  }

  start(jobId: string, anchor: DiagnosticAnchor): DiagnosticRunState {
    diagnosticAnchorSchema.parse(anchor);
    const runId = crypto.randomUUID();
    // Synchronous acquisition happens before source reads, SSH, or any other await.
    const job = this.store.acquireDiagnosticRun(jobId, anchor.episode, anchor.frame, runId);
    const result = job.result;
    if (!result) {
      this.store.releaseDiagnosticRun(runId);
      throw new JobError("Completed result is missing", 409);
    }
    const chunk = result.samples.find((sample) => sample.episode === anchor.episode && sample.frame === anchor.frame);
    const trace = result.traces.find((item) => item.episode === anchor.episode && item.frames.includes(anchor.frame));
    const row = trace?.predicted[trace.frames.indexOf(anchor.frame)];
    if (!chunk && !row) {
      this.store.releaseDiagnosticRun(runId);
      throw new JobError("Saved diagnostic actions are missing", 400);
    }
    const request: DiagnosticRequest = {
      jobId, ...anchor, repo: job.request.repo,
      dataset: result.dataset, config: result.config, checkpoint: result.checkpoint,
      seed: result.seed, numSteps: result.numSteps, actionNames: result.actionNames,
      savedActions: chunk ? chunk.predicted : row ? [row] : [],
      savedActionsScope: chunk ? "chunk" : "trace_row",
      savedValid: chunk ? chunk.valid : [true], minimumFreeMiB: 20480,
    };
    const run: Run = {
      runId, controller: new AbortController(), persisting: false,
      state: { runId, jobId, ...anchor, status: "idle", message: "" },
    };
    this.active = run;
    this.publish(run, "preflight", "Checking diagnostic resources");
    const initial = run.state;
    void this.execute(run, { host: job.request.host, request });
    return initial;
  }

  cancel(jobId: string, runId: string): DiagnosticRunState {
    const run = this.active;
    if (!run || run.runId !== runId || run.state.jobId !== jobId) {
      const state = [...this.states.values()].find((item) => item.runId === runId && item.jobId === jobId);
      if (state) return state;
      throw new JobError("Diagnostic run was not found", 404);
    }
    // Once the process has exited, atomic publication finishes rather than falsely reporting cancellation.
    if (!run.persisting && !run.controller.signal.aborted) {
      this.publish(run, "cancelling", "Waiting for remote diagnostic termination");
      run.controller.abort();
    }
    return run.state;
  }

  private async execute(run: Run, execution: { readonly host: string; readonly request: DiagnosticRequest }): Promise<void> {
    let packet: DiagnosticPacket | null = null;
    let terminal: DiagnosticRunState["status"] = "completed";
    let message = "Diagnostic packet saved";
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
          case "result":
            if (packet) throw new JobError("Worker emitted multiple diagnostic packets", 502);
            packet = event.packet;
            break;
          case "video":
            throw new JobError("Selected-frame diagnostics received an attention video", 502);
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
        if (!packet) throw new JobError("Worker exited without a diagnostic packet", 502);
        run.persisting = true;
        const parsed: DiagnosticPacket = packet;
        if (parsed.identity.jobId !== run.state.jobId || parsed.identity.episode !== run.state.episode
          || parsed.identity.frame !== run.state.frame)
          throw new JobError("Diagnostic packet does not match the selected frame", 502);
        // A new attention capture must not erase an independently attached calibration.
        if (!parsed.projection) {
          try {
            const previous = await this.store.getDiagnostic(run.state.jobId, run.state.episode, run.state.frame);
            const oldFront = previous.images.find((image) => image.role === "front");
            const newFront = parsed.images.find((image) => image.role === "front");
            if (previous.projection && oldFront && newFront && oldFront.datasetKey === newFront.datasetKey
              && oldFront.width === newFront.width && oldFront.height === newFront.height
              && Math.abs(oldFront.timestampSeconds - newFront.timestampSeconds) < 1e-6)
              parsed.projection = { ...previous.projection, modelKey: newFront.modelKey };
          } catch (error) { if (!(error instanceof JobError && error.status === 404)) throw error; }
        }
        await this.store.saveDiagnostic(run.state.jobId, parsed, run.runId);
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

const managers = new WeakMap<JobStore, DiagnosticRunManager>();
export function diagnosticRunsFor(store: JobStore): DiagnosticRunManager {
  let manager = managers.get(store);
  if (!manager) { manager = new DiagnosticRunManager(store); managers.set(store, manager); }
  return manager;
}

export function diagnosticEventStream(
  request: Request, manager: DiagnosticRunManager,
  selection: { readonly jobId: string; readonly anchor: DiagnosticAnchor },
): Response {
  const { jobId, anchor } = selection;
  manager.get(jobId, anchor);
  return runStateStream(request, {
    current: () => manager.get(jobId, anchor),
    subscribe: (listener) => manager.subscribe(jobId, anchor, listener),
    terminal: diagnosticRunTerminal,
  });
}

/** SSE: the current state first, then transitions; closes after a terminal state or client abort. */
export function runStateStream<State>(request: Request, source: {
  readonly current: () => State;
  readonly subscribe: (listener: (state: State) => void) => () => void;
  readonly terminal: (state: State) => boolean;
}): Response {
  let cancelStream = () => {};
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      let unsubscribe = () => {};
      const close = (controllerClose = true) => {
        if (closed) return;
        closed = true;
        unsubscribe();
        request.signal.removeEventListener("abort", abort);
        if (controllerClose) controller.close();
      };
      const abort = () => close();
      cancelStream = () => close(false);
      const send = (state: State) => {
        if (closed) return;
        controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(state)}\n\n`));
        if (source.terminal(state)) close();
      };
      unsubscribe = source.subscribe(send);
      request.signal.addEventListener("abort", abort, { once: true });
      if (request.signal.aborted) close();
      else send(source.current());
    },
    cancel() { cancelStream(); },
  });
  return new Response(stream, {
    headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "X-Accel-Buffering": "no" },
  });
}
