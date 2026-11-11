import ky, { HTTPError } from "ky";
import { z } from "zod";
import { jobSchema, type Job, type Session } from "../contracts";

/** Fields shared by stored jobs and the job summaries the API sends. */
type JobState = Pick<Job, "id" | "status" | "createdAt" | "owner" | "progress">;

const userKey = "vlaeval.user";
export function savedUser(): string {
  try { return localStorage.getItem(userKey) ?? ""; } catch { return ""; }
}
export function saveUser(name: string): void {
  try { localStorage.setItem(userKey, name.trim()); } catch { /* Name is then asked again next visit. */ }
}

/** The typed name rides on every request so LAN runs record who started them. */
export const api = ky.create({
  retry: 0, timeout: 180000,
  hooks: { beforeRequest: [(request) => {
    const name = savedUser().trim();
    if (name) request.headers.set("x-vlaeval-user", encodeURIComponent(name));
  }] },
});

/** Runs this browser may delete or cancel: all on this PC, otherwise the ones started from this IP. */
export function ownsJob(session: Session | null, job: JobState): boolean {
  return session === null || session.local || job.owner?.ip === session.ip;
}

export function ownerLabel(job: JobState): string {
  return job.owner ? `${job.owner.name} (${job.owner.ip})` : "";
}
export const createdJobSchema = z.object({ id: jobSchema.shape.id });

export async function errorMessage(error: unknown): Promise<string> {
  if (error instanceof HTTPError) {
    const body = await error.response.text();
    return `HTTP ${error.response.status}: ${body || error.message}`;
  }
  if (error instanceof z.ZodError) return error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("\n");
  return error instanceof Error ? error.message : "알 수 없는 오류가 발생했습니다.";
}

export function isActive(job: Pick<Job, "status">): boolean {
  return job.status === "queued" || job.status === "running";
}

export const statusLabels = {
  queued: "대기 중", running: "평가 중", completed: "완료", failed: "실패", cancelled: "취소됨",
} as const;

export function mergeJob<T extends JobState>(jobs: T[], incoming: T, deletedIds?: ReadonlySet<string>): T[] {
  if (deletedIds?.has(incoming.id)) return jobs;
  const previous = jobs.find((job) => job.id === incoming.id);
  // A reconnect snapshot may arrive after a newer SSE update.
  if (previous && ((!isActive(previous) && isActive(incoming)) ||
    (isActive(previous) && isActive(incoming) && previous.progress.completed > incoming.progress.completed))) return jobs;
  return [incoming, ...jobs.filter((job) => job.id !== incoming.id)]
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
