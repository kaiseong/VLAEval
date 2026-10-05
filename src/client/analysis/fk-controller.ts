import { fkIdentitySchema, fkRequestSchema, type FkRequest } from "../../kinematics/contracts";
import { fkDisplaySchema, fkReplySchema, fkSampleSchema, freezeFk, sameFkIdentity, packFkFrames } from "./fk-protocol";
import type { FkCommand, FkDownload, FkMetadata, FkSample, FkSelection, FkView } from "./fk-protocol";

export type FkState =
  | { readonly status: "unavailable"; readonly reason: string }
  | { readonly status: "pending"; readonly generation: number }
  | { readonly status: "ready"; readonly result: FkMetadata; readonly view: FkView; readonly selected: FkSample | null };

/** Each generation owns a live Worker, including its exact points and encoded exports. */
export interface FkWorker {
  onmessage: ((event: MessageEvent<unknown>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  onmessageerror: ((event: MessageEvent<unknown>) => void) | null;
  postMessage(request: FkCommand, transfer?: Transferable[]): void;
  terminate(): void;
}

export class FkController {
  private generation = 0;
  private serial = 0;
  private worker: FkWorker | null = null;
  private closed = false;
  private selection: FkSelection | null = null;
  private pointSerial = 0;
  private viewSerial = 0;
  private viewSelection: FkSelection | null = null;
  private readonly downloads = new Map<number, { readonly format: "json" | "csv"; readonly resolve: (value: FkDownload | null) => void }>();
  private current: FkState = { status: "unavailable", reason: "FK is not configured" };

  constructor(
    private readonly onChange: (state: FkState) => void,
    private readonly createWorker: () => FkWorker = () => new Worker("/assets/fk.worker.js", { type: "module" }),
  ) {}
  get state(): FkState { return this.current; }
  /** Metadata is not a scientific result; full samples never cross this getter. */
  get exportResult(): FkMetadata | null { return this.current.status === "ready" ? this.current.result : null; }
  private publish(state: FkState): void {
    this.current = freezeFk(state);
    this.onChange(this.current);
  }
  invalidate(reason = "FK selection changed"): void {
    this.generation++;
    if (this.worker) {
      this.worker.onmessage = null;
      this.worker.onerror = null;
      this.worker.onmessageerror = null;
      this.worker.terminate();
      this.worker = null;
    }
    for (const pending of this.downloads.values()) pending.resolve(null);
    this.downloads.clear();
    this.selection = null;
    this.publish({ status: "unavailable", reason });
  }
  start(input: Omit<FkRequest, "generation">, selected?: FkSelection): void {
    this.invalidate();
    if (this.closed) return;
    // Bounded declaration preflight only; full source validation belongs to the Worker.
    const parsed = fkRequestSchema.safeParse({ ...input, generation: this.generation, frames: [] });
    if (!parsed.success) { this.publish({ status: "unavailable", reason: parsed.error.message }); return; }
    const snapshot = parsed.data;
    const firstFrame = input.frames[0]?.frame ?? null, lastFrame = input.frames.at(-1)?.frame ?? null;
    const frameCount = input.frames.length;
    const initial = selected ?? { sourceFrame: firstFrame,
      window: { startFrame: firstFrame ?? 0, endFrame: lastFrame ?? 0 } };
    this.selection = structuredClone(initial);
    this.viewSelection = structuredClone(initial);
    this.viewSerial = 0;
    const generation = this.generation;
    try {
      const worker = this.createWorker();
      this.worker = worker;
      const active = () => this.worker === worker && this.generation === generation;
      const fail = (reason: string) => { if (active()) this.invalidate(reason); };
      worker.onerror = (event) => fail(event.message || "FK Worker failed");
      worker.onmessageerror = () => fail("FK Worker result could not be decoded");
      worker.onmessage = (event) => {
        if (!active()) return;
        try {
          const parsedReply = fkReplySchema.safeParse(event.data);
          if (!parsedReply.success) { fail("Invalid FK Worker result"); return; }
          const reply = parsedReply.data;
          if (reply.kind === "error") { fail(reply.reason); return; }
          if (!sameFkIdentity(reply.identity, snapshot)) return;
          switch (reply.kind) {
            case "view": {
              if (reply.serial !== this.viewSerial) return;
              const display = fkDisplaySchema.safeParse(JSON.parse(reply.payload));
              if (!display.success) { fail("Invalid bounded FK view"); return; }
              const { result, view, selected: point } = display.data;
              const { model, revision, urdfSha256, rootLink, tips } = snapshot.profile;
              if (!sameFkIdentity(result, snapshot) ||
                JSON.stringify(result.profile) !== JSON.stringify({ model, revision, urdfSha256, rootLink, tips }) ||
                JSON.stringify(result.actionNames) !== JSON.stringify(snapshot.actionNames) ||
                JSON.stringify(result.jointMapping) !== JSON.stringify(snapshot.jointMapping) ||
                result.frameCount !== frameCount || result.firstFrame !== firstFrame || result.lastFrame !== lastFrame ||
                Object.values(result.summaries).some((arm) => Object.values(arm).some((metric) => metric.count > frameCount)) ||
                JSON.stringify(view.window) !== JSON.stringify(this.viewSelection?.window) ||
                view.sourceFrame !== this.viewSelection?.sourceFrame ||
                (point !== null && point.frame !== view.sourceFrame)) {
                fail("FK Worker result does not match selected source"); return;
              }
              this.publish({ status: "ready", result, view, selected: point });
              if (this.selection && JSON.stringify(this.selection.window) !== JSON.stringify(view.window)) this.queryView();
              else if (this.selection?.sourceFrame !== view.sourceFrame) this.queryPoint();
              break;
            }
            case "point": {
              if (reply.serial !== this.pointSerial || reply.sourceFrame !== this.selection?.sourceFrame) return;
              const sample = fkSampleSchema.nullable().safeParse(JSON.parse(reply.payload));
              if (!sample.success || (sample.data !== null && sample.data.frame !== reply.sourceFrame)) {
                fail("FK point does not match selected source"); return;
              }
              if (this.current.status === "ready") this.publish({ ...this.current, selected: sample.data });
              break;
            }
            case "export": {
              const pending = this.downloads.get(reply.serial);
              if (!pending) return;
              if (pending.format !== reply.format || reply.filename !== `vlaeval-${snapshot.jobId}-ep${snapshot.episode}.fk.${pending.format}` ||
                reply.mediaType !== (pending.format === "json" ? "application/json;charset=utf-8" : "text/csv;charset=utf-8") ||
                reply.content.type !== reply.mediaType) { fail("FK export identity or format mismatch"); return; }
              this.downloads.delete(reply.serial);
              pending.resolve(reply);
              break;
            }
            default: { const exhaustive: never = reply; return exhaustive; }
          }
        } catch (error) {
          if (!(error instanceof Error)) throw error;
          fail(error.message);
        }
      };
      this.publish({ status: "pending", generation });
      // Snapshot each numeric value once, then transfer ownership without graph cloning.
      const source = packFkFrames(input.frames);
      worker.postMessage({ kind: "derive", request: snapshot, source, selection: initial }, [source]);
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      this.invalidate(error.message);
    }
  }
  select(selection: FkSelection): void {
    const previous = this.selection;
    this.selection = structuredClone(selection);
    if (this.current.status !== "ready" || !previous) return;
    if (previous.window.startFrame !== selection.window.startFrame || previous.window.endFrame !== selection.window.endFrame) {
      this.queryView();
    } else if (previous.sourceFrame !== selection.sourceFrame) this.queryPoint();
  }
  private queryView(): void {
    if (this.current.status !== "ready" || !this.selection) return;
    this.viewSerial = ++this.serial;
    this.viewSelection = structuredClone(this.selection);
    this.post({ kind: "view", identity: fkIdentitySchema.parse(this.current.result), serial: this.viewSerial, selection: this.selection });
  }
  private queryPoint(): void {
    if (this.current.status !== "ready" || !this.selection) return;
    this.pointSerial = ++this.serial;
    this.post({ kind: "point", identity: fkIdentitySchema.parse(this.current.result), serial: this.pointSerial, sourceFrame: this.selection.sourceFrame });
  }
  export(format: "json" | "csv"): Promise<FkDownload | null> {
    if (this.current.status !== "ready" || !this.worker) return Promise.resolve(null);
    const serial = ++this.serial, identity = fkIdentitySchema.parse(this.current.result);
    return new Promise((resolve) => {
      this.downloads.set(serial, { format, resolve });
      this.post({ kind: "export", identity, serial, format });
    });
  }
  private post(command: FkCommand): void {
    try { this.worker?.postMessage(command); }
    catch (error) {
      if (!(error instanceof Error)) throw error;
      this.invalidate(error.message);
    }
  }
  dispose(): void { this.closed = true; this.invalidate("FK controller closed"); }
}
