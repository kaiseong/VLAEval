import { expect, test } from "bun:test";
import { isActive, mergeJob } from "../src/client/api";
import { jobRequestSchema } from "../src/contracts";
import type { Job } from "../src/contracts";
import { resultFixture } from "./result-fixture";

const request = jobRequestSchema.parse({
  host: "rtx6000@192.168.0.3", repo: "/models/openpi", config: "test",
  checkpoint: "/models/100", dataset: "/data/test", episodes: [3],
});
const running: Job = {
  id: "b8191bcd-4cf1-418c-a3d9-5c94deed4045",
  status: "running", createdAt: "2026-10-04T00:00:00Z", request,
  progress: { completed: 2, total: 3, message: "evaluating" },
  logs: [], result: null, error: null,
};

test("a stale reconnect snapshot does not move frame progress backwards", () => {
  const incoming = { ...running, progress: { ...running.progress, completed: 1 } };
  expect(mergeJob([running], incoming)[0]?.progress.completed).toBe(2);
});

test("a late running snapshot cannot replace a completed result", () => {
  const completed: Job = { ...running, status: "completed", result: resultFixture };
  expect(mergeJob([completed], running)[0]?.result?.traces).toEqual(resultFixture.traces);
  expect(mergeJob([completed], running)[0]?.status).toBe("completed");
});

test("terminal updates replace active jobs and retain other run history", () => {
  const previous = { ...running, id: "e4a6a5b0-51ce-4313-8b8d-9b3f19a4c827", createdAt: "2026-10-03T00:00:00Z" };
  const completed: Job = { ...running, status: "completed", result: resultFixture };
  const jobs = mergeJob([previous, running], completed);
  expect(jobs.map((job) => job.id)).toEqual([completed.id, previous.id]);
  expect(jobs[0]?.status).toBe("completed");
});

test("saved result selection does not change the active cancellation identity", () => {
  const saved: Job = { ...running, id: "e4a6a5b0-51ce-4313-8b8d-9b3f19a4c827", status: "completed", result: resultFixture };
  const jobs = mergeJob([running], saved);
  const displayed = jobs.find((job) => job.id === saved.id);
  expect(displayed?.result).toEqual(resultFixture);
  expect(jobs.filter(isActive).map((job) => job.id)).toEqual([running.id]);
});

test("a stale history refresh cannot revive a cancelled job", () => {
  const cancelled: Job = { ...running, status: "cancelled" };
  expect(mergeJob([cancelled], running).filter(isActive)).toEqual([]);
  expect(mergeJob([cancelled], running)[0]?.status).toBe("cancelled");
});
