import { lstat, mkdir, open, readdir, realpath, rename, unlink } from "node:fs/promises";
import { constants } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { jobSchema } from "./contracts";
import type { Job, JobRequest, JobStorage, WorkerEvent } from "./contracts";
import type { Owner } from "./lan";
import { cancelRemote, runRemote } from "./remote";
import type { RemoteRequest } from "./remote";
import { diagnosticPacketSchema, maximumDiagnosticBytes } from "./diagnostic-contracts";
import type { DiagnosticImage, DiagnosticPacket } from "./diagnostic-contracts";
import { attentionVideoSchema, maximumAttentionVideoBytes } from "./attention-video-contracts";
import type { AttentionVideo } from "./attention-video-contracts";
import { validateDiagnosticPayload } from "./client/analysis/diagnostic-data";

function missing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

async function regularFile(path: string) {
  const entry = await lstat(path).catch((error: unknown) => {
    if (missing(error)) return null;
    throw error;
  });
  if (entry && !entry.isFile()) throw new JobError("Unsafe diagnostic or run artifact: expected a regular file", 409);
  return entry;
}

export class JobError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "JobError";
  }
}

type Runner = (
  request: RemoteRequest,
  onEvent: (event: WorkerEvent) => void,
  onLog: (line: string) => void,
) => Promise<void>;
type Listener = (job: Job) => void;
type ActiveRun = {
  readonly job: Job;
  pid: number | null;
  cancelRequested: boolean;
  cancelSending: boolean;
};
export function isTerminal(job: Job): boolean {
  return job.status === "completed" || job.status === "failed" || job.status === "cancelled";
}

/** Owns mutable run state and subscribers; only terminal snapshots are persisted. */
export class JobStore {
  private readonly jobs = new Map<string, Job>();
  private readonly listeners = new Map<string, Set<Listener>>();
  private readonly deleting = new Set<string>();
  private readonly writingDiagnostics = new Set<string>();
  private active: ActiveRun | null = null;
  private diagnosticActive: { readonly jobId: string; readonly runId: string } | null = null;

  constructor(
    private directory: string,
    private readonly runner: Runner = runRemote,
    private readonly cancel: typeof cancelRemote = cancelRemote,
    private readonly allowSyntheticDiagnostics = false,
  ) {}

  async initialize(): Promise<void> {
    await mkdir(this.directory, { recursive: true });
    this.directory = await realpath(this.directory);
    for (const name of await readdir(this.directory)) {
      if (!name.endsWith(".json") || !jobSchema.shape.id.safeParse(name.slice(0, -5)).success) continue;
      if (!(await lstat(join(this.directory, name))).isFile()) continue;
      const job = jobSchema.parse(await Bun.file(join(this.directory, name)).json());
      if (name !== `${job.id}.json`) continue;
      if (!isTerminal(job)) {
        job.status = "failed";
        job.error = "앱이 종료되어 실행 확인이 중단되었습니다. 원격 프로세스 상태를 확인하세요.";
        await this.persist(job);
      }
      this.jobs.set(job.id, job);
    }
  }

  list(): Job[] {
    return [...this.jobs.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  get(id: string): Job {
    const job = this.jobs.get(id);
    if (!job) throw new JobError("평가 실행을 찾을 수 없습니다.", 404);
    return job;
  }

  private async diagnosticFiles(id: string): Promise<string[]> {
    // Only canonical, flat names owned by this exact UUID are run artifacts.
    const pattern = new RegExp(`^${id}\\.diag-(0|[1-9][0-9]{0,6})-(0|[1-9][0-9]{0,6})\\.json$`);
    const video = new RegExp(`^${id}\\.attnvideo-(0|[1-9][0-9]{0,6})\\.json$`);
    return (await readdir(this.directory)).filter((name) => {
      const match = pattern.exec(name);
      if (match !== null) return Number(match[1]) <= 1_000_000 && Number(match[2]) <= 1_000_000;
      const videoMatch = video.exec(name);
      return videoMatch !== null && Number(videoMatch[1]) <= 1_000_000;
    }).map((name) => join(this.directory, name));
  }

  diagnosticJob(id: string, episode: number, frame: number): Job {
    jobSchema.shape.id.parse(id);
    diagnosticPacketSchema.innerType().shape.identity.shape.episode.parse(episode);
    diagnosticPacketSchema.innerType().shape.identity.shape.frame.parse(frame);
    const job = this.get(id);
    const result = job.result;
    if (job.status !== "completed" || !result || this.active?.job.id === id || this.deleting.has(id))
      throw new JobError("Diagnostics require a stored, completed run", 409);
    if (!result.traces.some((trace) => trace.episode === episode && trace.frames.includes(frame))
      && !result.samples.some((sample) => sample.episode === episode && sample.frame === frame && sample.valid[0]))
      throw new JobError("Diagnostic frame must be a saved scored anchor", 400);
    return job;
  }

  acquireDiagnosticRun(id: string, episode: number, frame: number, runId: string): Job {
    const job = this.diagnosticJob(id, episode, frame);
    if (this.active || this.diagnosticActive || this.writingDiagnostics.size > 0)
      throw new JobError("Evaluation or diagnostics already owns the execution slot", 409);
    this.diagnosticActive = { jobId: id, runId };
    return job;
  }

  attentionVideoJob(id: string, episode: number): Job {
    jobSchema.shape.id.parse(id);
    attentionVideoSchema.innerType().shape.identity.shape.episode.parse(episode);
    const job = this.get(id);
    const result = job.result;
    if (job.status !== "completed" || !result || this.active?.job.id === id || this.deleting.has(id))
      throw new JobError("Attention video requires a stored, completed run", 409);
    if (!result.traces.some((trace) => trace.episode === episode) && !result.samples.some((sample) => sample.episode === episode))
      throw new JobError("Attention video episode must be part of the saved run", 400);
    return job;
  }

  /** Shares the single diagnostic GPU slot, so it excludes evaluation, diagnostics, deletion and publication. */
  acquireAttentionVideoRun(id: string, episode: number, runId: string): Job {
    const job = this.attentionVideoJob(id, episode);
    if (this.active || this.diagnosticActive || this.writingDiagnostics.size > 0)
      throw new JobError("Evaluation or diagnostics already owns the execution slot", 409);
    this.diagnosticActive = { jobId: id, runId };
    return job;
  }

  releaseDiagnosticRun(runId: string): void {
    if (this.diagnosticActive?.runId === runId) this.diagnosticActive = null;
  }

  private validateDiagnostic(job: Job, packet: DiagnosticPacket): void {
    const result = job.result;
    if (!result) throw new JobError("Completed result is missing", 409);
    for (const field of ["dataset", "config", "checkpoint", "seed", "numSteps"] as const) {
      if (packet.identity[field] !== result[field])
        throw new JobError(`Diagnostic identity mismatch: ${field}`, 400);
    }
    if (packet.provenance.kind === "synthetic" && !this.allowSyntheticDiagnostics)
      throw new JobError("Synthetic diagnostics are restricted to explicitly opted-in test stores", 409);
    if (packet.attention) {
      const chunk = result.samples.find((sample) => sample.episode === packet.identity.episode && sample.frame === packet.identity.frame);
      const horizon = chunk?.predicted.length ?? result.coverage?.horizon ?? result.perHorizon.length;
      if (packet.attention.horizon !== horizon)
        throw new JobError("Diagnostic attention horizon differs from the saved run", 400);
    }
    for (const differences of [packet.actionDifferences, packet.sameProcessDifferences ?? []]) {
      if (new Set(differences.map((item) => item.channel)).size !== differences.length
        || differences.some((item) => !result.actionNames.includes(item.channel)))
        throw new JobError("Action differences must identify unique saved output channels", 400);
    }
    const reason = validateDiagnosticPayload(packet);
    if (reason) throw new JobError(reason, 400);
    if (packet.adapterArrays) {
      const bytes = Buffer.from(packet.adapterArrays.dataBase64, "base64");
      if (!bytes.subarray(0, 4).equals(Buffer.from([80, 75, 3, 4]))
        || createHash("sha256").update(bytes).digest("hex") !== packet.adapterArrays.sha256)
        throw new JobError("Adapter NPZ signature or SHA256 mismatch", 400);
    }
    this.validateImages(packet.images);
  }

  private validateImages(images: readonly DiagnosticImage[]): void {
    for (const image of images) {
      const bytes = Buffer.from(image.dataBase64, "base64");
      const magic = image.mime === "image/png"
        ? bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
        : bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
      if (!magic || createHash("sha256").update(bytes).digest("hex") !== image.sha256)
        throw new JobError("Diagnostic image MIME signature or SHA256 mismatch", 400);
    }
  }

  private validateAttentionVideo(job: Job, video: AttentionVideo): void {
    const result = job.result;
    if (!result) throw new JobError("Completed result is missing", 409);
    for (const field of ["dataset", "config", "checkpoint", "seed", "numSteps"] as const) {
      if (video.identity[field] !== result[field])
        throw new JobError(`Attention video identity mismatch: ${field}`, 400);
    }
    if (video.provenance.kind === "synthetic" && !this.allowSyntheticDiagnostics)
      throw new JobError("Synthetic diagnostics are restricted to explicitly opted-in test stores", 409);
    for (const frame of video.frames) this.validateImages(frame.images);
  }

  private async readArtifact(path: string, limit: number, label: string): Promise<unknown> {
    const entry = await regularFile(path);
    if (!entry) throw new JobError(`${label} artifact is missing`, 404);
    if (entry.size > limit) throw new JobError(`${label} artifact exceeds byte limit`, 413);
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW).catch((error: unknown) => {
      if (missing(error)) throw new JobError(`${label} artifact is missing`, 404);
      throw error;
    });
    try {
      return JSON.parse(await file.readFile("utf8"));
    } finally {
      await file.close();
    }
  }

  /** Temporary file, regular-file checks around the rename, and no symlink following. */
  private async writeArtifact(id: string, path: string, serialized: string): Promise<void> {
    if (this.writingDiagnostics.has(id)) throw new JobError("Diagnostic publication already in progress", 409);
    this.writingDiagnostics.add(id);
    const temporary = `${path}.${crypto.randomUUID()}.tmp`;
    let created = false;
    try {
      if (!(await regularFile(join(this.directory, `${id}.json`))))
        throw new JobError("Stored run snapshot is missing", 409);
      await regularFile(path);
      const file = await open(temporary, "wx", 0o600);
      created = true;
      try {
        await file.writeFile(serialized);
      } finally {
        await file.close();
      }
      await regularFile(path);
      await rename(temporary, path);
      created = false;
    } finally {
      try {
        if (created) await unlink(temporary);
      } finally {
        this.writingDiagnostics.delete(id);
      }
    }
  }

  async getAttentionVideo(id: string, episode: number): Promise<AttentionVideo> {
    const job = this.attentionVideoJob(id, episode);
    const raw = await this.readArtifact(join(this.directory, `${id}.attnvideo-${episode}.json`),
      maximumAttentionVideoBytes, "Attention video");
    const video = attentionVideoSchema.parse(raw);
    if (video.identity.jobId !== id || video.identity.episode !== episode)
      throw new JobError("Attention video path identity mismatch", 409);
    this.validateAttentionVideo(job, video);
    return video;
  }

  async saveAttentionVideo(id: string, video: AttentionVideo, runId?: string): Promise<void> {
    const serialized = JSON.stringify(video);
    if (Buffer.byteLength(serialized) > maximumAttentionVideoBytes)
      throw new JobError("Attention video artifact exceeds byte limit", 413);
    const parsed = attentionVideoSchema.parse(video);
    if (parsed.identity.jobId !== id) throw new JobError("Attention video job identity mismatch", 400);
    const job = this.attentionVideoJob(id, parsed.identity.episode);
    if (this.diagnosticActive?.jobId === id && this.diagnosticActive.runId !== runId)
      throw new JobError("Diagnostic execution owns publication for this run", 409);
    this.validateAttentionVideo(job, parsed);
    await this.writeArtifact(id, join(this.directory, `${id}.attnvideo-${parsed.identity.episode}.json`), serialized);
  }

  async getDiagnostic(id: string, episode: number, frame: number): Promise<DiagnosticPacket> {
    const job = this.diagnosticJob(id, episode, frame);
    const packet = diagnosticPacketSchema.parse(await this.readArtifact(
      join(this.directory, `${id}.diag-${episode}-${frame}.json`), maximumDiagnosticBytes, "Diagnostic"));
    if (packet.identity.jobId !== id || packet.identity.episode !== episode || packet.identity.frame !== frame)
      throw new JobError("Diagnostic path identity mismatch", 409);
    this.validateDiagnostic(job, packet);
    return packet;
  }

  async saveDiagnostic(id: string, packet: DiagnosticPacket, runId?: string): Promise<void> {
    // Store methods are also a boundary for non-HTTP artifact receivers.
    const serialized = JSON.stringify(packet);
    if (Buffer.byteLength(serialized) > maximumDiagnosticBytes)
      throw new JobError("Diagnostic artifact exceeds byte limit", 413);
    const parsed = diagnosticPacketSchema.parse(packet);
    if (parsed.identity.jobId !== id) throw new JobError("Diagnostic job identity mismatch", 400);
    const job = this.diagnosticJob(id, parsed.identity.episode, parsed.identity.frame);
    if (this.diagnosticActive?.jobId === id && this.diagnosticActive.runId !== runId)
      throw new JobError("Diagnostic execution owns publication for this run", 409);
    this.validateDiagnostic(job, parsed);
    await this.writeArtifact(id,
      join(this.directory, `${id}.diag-${parsed.identity.episode}-${parsed.identity.frame}.json`), serialized);
  }

  async storage(): Promise<JobStorage> {
    const runs = await Promise.all(this.list().map(async (job) => {
      const entry = await lstat(join(this.directory, `${job.id}.json`)).catch((error: unknown) => {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
        throw error;
      });
      let bytes = entry?.isFile() ? entry.size : null;
      let safe = entry === null || entry.isFile();
      for (const path of await this.diagnosticFiles(job.id)) {
        const diagnostic = await lstat(path).catch((error: unknown) => {
          if (missing(error)) return null;
          throw error;
        });
        if (diagnostic && !diagnostic.isFile()) safe = false;
        else if (diagnostic) bytes = (bytes ?? 0) + diagnostic.size;
      }
      return {
        id: job.id,
        bytes: safe ? bytes : null,
        deletable: safe && isTerminal(job)
          && this.active?.job.id !== job.id && this.diagnosticActive?.jobId !== job.id
          && !this.deleting.has(job.id) && !this.writingDiagnostics.has(job.id),
      };
    }));
    return {
      directory: this.directory,
      totalBytes: runs.reduce((total, run) => total + (run.bytes ?? 0), 0),
      runs,
    };
  }

  async delete(id: string): Promise<void> {
    const job = this.get(id);
    // Terminal status precedes final persistence; active must also be clear.
    if (!isTerminal(job) || this.active?.job.id === id || this.diagnosticActive?.jobId === id
      || this.deleting.has(id) || this.writingDiagnostics.has(id)) {
      throw new JobError("실행 중이거나 정리 중인 평가는 삭제할 수 없습니다.", 409);
    }
    this.deleting.add(id);
    try {
      const path = join(this.directory, `${job.id}.json`);
      const diagnostics = await this.diagnosticFiles(id);
      // Preflight all owned files before removing anything; unsafe entries retain the run.
      for (const artifact of [path, ...diagnostics]) await regularFile(artifact);
      for (const artifact of diagnostics) {
        if (await regularFile(artifact)) await unlink(artifact);
      }
      try {
        const entry = await lstat(path);
        if (!entry.isFile()) throw new JobError("일반 실행 기록 파일만 삭제할 수 있습니다.", 409);
        await unlink(path);
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      }
      this.jobs.delete(id);
      this.listeners.delete(id);
    } finally {
      this.deleting.delete(id);
    }
  }

  subscribe(id: string, listener: Listener): () => void {
    this.get(id);
    let listeners = this.listeners.get(id);
    if (!listeners) {
      listeners = new Set();
      this.listeners.set(id, listeners);
    }
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.listeners.delete(id);
    };
  }

  private publish(job: Job): void {
    for (const listener of this.listeners.get(job.id) ?? []) listener(job);
  }

  private async persist(job: Job): Promise<void> {
    const path = join(this.directory, `${job.id}.json`);
    // Fresh exclusive temp file: a pre-planted symlink (e.g. on a shared NAS) is never followed.
    const temporary = `${path}.${crypto.randomUUID()}.tmp`;
    const file = await open(temporary, "wx", 0o600);
    try {
      await file.writeFile(JSON.stringify(job));
    } finally {
      await file.close();
    }
    try {
      await rename(temporary, path);
    } catch (error) {
      await unlink(temporary).catch(() => {});
      throw error;
    }
  }

  private log(job: Job, line: string): void {
    job.logs.push(line);
    if (job.logs.length > 200) job.logs.shift();
    this.publish(job);
  }

  async start(request: JobRequest, owner?: Owner): Promise<Job> {
    if (this.active || this.diagnosticActive)
      throw new JobError("이미 평가 또는 진단이 실행 중입니다. 완료하거나 취소한 뒤 시작하세요.", 409);
    const job: Job = {
      id: crypto.randomUUID(), status: "queued", createdAt: new Date().toISOString(), request,
      ...(owner ? { owner: { ...owner } } : {}),
      progress: { completed: 0, total: 0, message: "추론 PC에 연결 중" },
      logs: [], result: null, error: null,
    };
    const run: ActiveRun = { job, pid: null, cancelRequested: false, cancelSending: false };
    this.active = run;
    this.jobs.set(job.id, job);
    try {
      await this.persist(job);
    } catch (error) {
      this.active = null;
      this.jobs.delete(job.id);
      throw error;
    }
    void this.execute(run);
    return job;
  }

  private async execute(run: ActiveRun): Promise<void> {
    const { job } = run;
    job.status = "running";
    this.publish(job);
    let cancelled = false;
    try {
      await this.runner({ ...job.request, operation: "evaluate" }, (event) => {
        switch (event.type) {
          case "started":
            run.pid = event.pid;
            if (run.cancelRequested) void this.signalCancel(run);
            break;
          case "progress":
            job.progress = { completed: event.completed, total: event.total, message: event.message };
            break;
          case "result":
            job.result = event.result;
            break;
          case "error":
            job.error = event.message;
            break;
          case "cancelled":
            cancelled = true;
            break;
          case "configs":
          case "discovery":
          case "datasetui":
          case "episodes":
            throw new JobError("평가 실행에서 잘못된 worker 응답을 받았습니다.", 502);
          default: {
            const exhaustive: never = event;
            throw new JobError(`알 수 없는 worker 이벤트: ${exhaustive}`, 502);
          }
        }
        this.publish(job);
      }, (line) => this.log(job, line));
      if (cancelled) {
        job.status = "cancelled";
        job.result = null;
        job.progress.message = "원격 평가가 취소되었습니다.";
      } else if (job.error || !job.result) {
        throw new JobError(job.error ?? "worker가 평가 결과 없이 종료되었습니다.", 502);
      } else {
        job.status = "completed";
        job.progress.message = "평가 완료";
        job.progress.completed = job.progress.total;
      }
    } catch (error) {
      job.status = "failed";
      job.result = null;
      job.error = error instanceof Error ? error.message : String(error);
    } finally {
      try {
        await this.persist(job);
      } catch (error) {
        job.status = "failed";
        job.error = `결과 저장 실패: ${error instanceof Error ? error.message : String(error)}`;
      }
      this.active = null;
      this.publish(job);
    }
  }

  async requestCancel(id: string): Promise<Job> {
    const job = this.get(id);
    const run = this.active;
    if (isTerminal(job) || !run || run.job.id !== id) return job;
    run.cancelRequested = true;
    job.progress.message = "취소 요청 중: 원격 worker 종료 확인을 기다립니다.";
    this.publish(job);
    if (run.pid !== null) await this.signalCancel(run);
    return job;
  }

  private async signalCancel(run: ActiveRun): Promise<void> {
    if (run.pid === null || run.cancelSending || this.active !== run) return;
    run.cancelSending = true;
    try {
      await this.cancel(run.job.request.host, run.pid);
    } catch (error) {
      if (this.active === run && !isTerminal(run.job)) {
        run.job.error = `취소 요청 실패: ${error instanceof Error ? error.message : String(error)}`;
        this.log(run.job, run.job.error);
      }
    } finally {
      run.cancelSending = false;
    }
  }
}
