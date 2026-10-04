import { mkdir, readdir, rename } from "node:fs/promises";
import { join } from "node:path";
import { jobSchema } from "./contracts";
import type { Job, JobRequest, WorkerEvent } from "./contracts";
import { cancelRemote, runRemote } from "./remote";
import type { RemoteRequest } from "./remote";

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
  private active: ActiveRun | null = null;

  constructor(
    private readonly directory: string,
    private readonly runner: Runner = runRemote,
    private readonly cancel: typeof cancelRemote = cancelRemote,
  ) {}

  async initialize(): Promise<void> {
    await mkdir(this.directory, { recursive: true });
    for (const name of await readdir(this.directory)) {
      if (!name.endsWith(".json")) continue;
      const job = jobSchema.parse(await Bun.file(join(this.directory, name)).json());
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
    await Bun.write(`${path}.tmp`, JSON.stringify(job));
    await rename(`${path}.tmp`, path);
  }

  private log(job: Job, line: string): void {
    job.logs.push(line);
    if (job.logs.length > 200) job.logs.shift();
    this.publish(job);
  }

  async start(request: JobRequest): Promise<Job> {
    if (this.active) throw new JobError("이미 평가가 실행 중입니다. 완료하거나 취소한 뒤 시작하세요.", 409);
    const job: Job = {
      id: crypto.randomUUID(), status: "queued", createdAt: new Date().toISOString(), request,
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
