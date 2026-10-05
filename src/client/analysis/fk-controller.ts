import { fkIdentitySchema, fkRequestSchema, fkResultSchema, type FkRequest, type FkResult } from "../../kinematics/contracts";

export type FkState =
  | { readonly status: "unavailable"; readonly reason: string }
  | { readonly status: "pending"; readonly generation: number }
  | { readonly status: "ready"; readonly result: FkResult };

/** A fresh Worker belongs to each selection; injectable only for lifecycle tests. */
export interface FkWorker {
  onmessage: ((event: MessageEvent<unknown>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  onmessageerror: ((event: MessageEvent<unknown>) => void) | null;
  postMessage(request: FkRequest): void;
  terminate(): void;
}

/** Owns the mutable lifecycle. Consumers must invalidate on every settings/selection change. */
export class FkController {
  private generation = 0;
  private worker: FkWorker | null = null;
  private closed = false;
  private current: FkState = { status: "unavailable", reason: "FK is not configured" };

  constructor(
    private readonly onChange: (state: FkState) => void,
    private readonly createWorker: () => FkWorker = () => new Worker("/assets/fk.worker.js", { type: "module" }),
  ) {}

  get state(): FkState { return this.current; }

  get exportResult(): FkResult | null {
    switch (this.current.status) {
      case "ready": return this.current.result;
      case "pending":
      case "unavailable": return null;
      default: {
        const exhaustive: never = this.current;
        return exhaustive;
      }
    }
  }

  private publish(state: FkState): void {
    this.current = state;
    this.onChange(state);
  }

  private detach(): void {
    if (this.worker === null) return;
    this.worker.onmessage = null;
    this.worker.onerror = null;
    this.worker.onmessageerror = null;
    this.worker.terminate();
    this.worker = null;
  }

  invalidate(reason = "FK selection changed"): void {
    this.generation++;
    this.detach();
    this.publish({ status: "unavailable", reason });
  }

  /** Generation is controller-owned, never supplied by UI episode/job counters. */
  start(input: Omit<FkRequest, "generation">): void {
    this.invalidate();
    if (this.closed) return;
    const parsed = fkRequestSchema.safeParse({ ...input, generation: this.generation });
    if (!parsed.success) {
      this.publish({ status: "unavailable", reason: parsed.error.message });
      return;
    }
    const request = parsed.data;
    const generation = this.generation;
    // Constructor/postMessage are browser boundaries: security, clone and load failures
    // must invalidate exports just like asynchronous error/messageerror events.
    try {
      const worker = this.createWorker();
      this.worker = worker;
      const active = () => this.worker === worker && this.generation === generation;
      const fail = (reason: string) => {
        if (active()) this.invalidate(reason);
      };
      worker.onerror = (event) => fail(event.message || "FK Worker failed");
      worker.onmessageerror = () => fail("FK Worker result could not be decoded");
      worker.onmessage = (event) => {
        if (!active()) return;
        const result = fkResultSchema.safeParse(event.data);
        if (!result.success) {
          fail("Invalid FK Worker result");
          return;
        }
        const value = result.data;
        if (JSON.stringify(fkIdentitySchema.parse(value)) !== JSON.stringify(fkIdentitySchema.parse(request))) return;
        const { model, revision, urdfSha256, rootLink, tips } = request.profile;
        const expectedProfile = { model, revision, urdfSha256, rootLink, tips };
        if (JSON.stringify(value.profile) !== JSON.stringify(expectedProfile) ||
            JSON.stringify(value.actionNames) !== JSON.stringify(request.actionNames) ||
            JSON.stringify(value.jointMapping) !== JSON.stringify(request.jointMapping) ||
            value.samples.length !== request.frames.length ||
            value.samples.some((sample, index) => {
              const frame = request.frames[index];
              return frame === undefined || sample.frame !== frame.frame ||
                JSON.stringify(sample.source) !== JSON.stringify({ predicted: frame.predicted, target: frame.target });
            })) {
          fail("FK Worker result does not match selected source");
          return;
        }
        this.detach();
        this.publish({ status: "ready", result: value });
      };
      this.publish({ status: "pending", generation });
      worker.postMessage(request);
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      this.invalidate(error.message);
    }
  }

  dispose(): void {
    this.closed = true;
    this.invalidate("FK controller closed");
  }
}
