import ky, { HTTPError } from "ky";
import { z } from "zod";
import { jobSchema, type Job } from "../contracts";

export const api = ky.create({ retry: 0, timeout: 180000 });
export const createdJobSchema = z.object({ id: jobSchema.shape.id });

export async function errorMessage(error: unknown): Promise<string> {
  if (error instanceof HTTPError) {
    const body = await error.response.text();
    return `HTTP ${error.response.status}: ${body || error.message}`;
  }
  if (error instanceof z.ZodError) return error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("\n");
  return error instanceof Error ? error.message : "알 수 없는 오류가 발생했습니다.";
}

export function isActive(job: Job): boolean {
  return job.status === "queued" || job.status === "running";
}

export const statusLabels = {
  queued: "대기 중", running: "평가 중", completed: "완료", failed: "실패", cancelled: "취소됨",
} as const;

export function mergeJob(jobs: Job[], incoming: Job): Job[] {
  const previous = jobs.find((job) => job.id === incoming.id);
  // A reconnect snapshot may arrive after a newer SSE update.
  if (previous && ((!isActive(previous) && isActive(incoming)) ||
    (isActive(previous) && isActive(incoming) && previous.progress.completed > incoming.progress.completed))) return jobs;
  return [incoming, ...jobs.filter((job) => job.id !== incoming.id)]
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
