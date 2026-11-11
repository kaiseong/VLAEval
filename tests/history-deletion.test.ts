import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { createApi } from "../src/api";
import { jobRequestSchema, jobStorageSchema } from "../src/contracts";
import type { Job } from "../src/contracts";
import { JobStore } from "../src/jobs";

const directories: string[] = [];
const request = jobRequestSchema.parse({
  host: "test@localhost", repo: "/synthetic/repo", config: "test",
  checkpoint: "/synthetic/model", dataset: "/synthetic/data", episodes: [0],
});

async function directory(): Promise<string> {
  const path = await fs.mkdtemp(join(tmpdir(), "vlaeval-history-"));
  directories.push(path);
  return path;
}

async function snapshot(path: string): Promise<Job> {
  const job: Job = {
    id: crypto.randomUUID(), status: "failed", createdAt: new Date().toISOString(),
    request, progress: { completed: 0, total: 0, message: "" },
    logs: [], result: null, error: "synthetic",
  };
  await fs.writeFile(join(path, `${job.id}.json`), JSON.stringify(job));
  return job;
}

function apiRequest(path: string, method = "GET", headers?: HeadersInit): Request {
  return new Request(`http://localhost:4310/api/jobs/${path}`, { method, headers: new Headers(headers) });
}

afterEach(async () => {
  mock.restore();
  await Promise.all(directories.splice(0).map((path) => fs.rm(path, { recursive: true, force: true })));
});

describe("local history deletion", () => {
  test("removes only the canonical snapshot, lowers totals, and survives reinitialization", async () => {
    const path = await directory();
    const removed = await snapshot(path);
    const kept = await snapshot(path);
    const keptPath = join(path, `${kept.id}.json`);
    const original = await fs.readFile(keptPath, "utf8");
    const removedBytes = (await fs.stat(join(path, `${removed.id}.json`))).size;
    const keptBytes = (await fs.stat(keptPath)).size;
    await fs.writeFile(join(path, `${removed.id}.json.tmp`), "unrelated temp");
    await fs.writeFile(join(path, "alias.json"), JSON.stringify(removed));
    const alias = join(await directory(), "store");
    await fs.symlink(path, alias);
    const store = new JobStore(relative(process.cwd(), alias));
    await store.initialize();
    const api = createApi(store);
    const before = jobStorageSchema.parse(await (await api(apiRequest("storage"))).json());
    expect(before.directory).toBe(await fs.realpath(path));
    expect(before.totalBytes).toBe(removedBytes + keptBytes);
    expect(before.runs.find((run) => run.id === removed.id)).toEqual({
      id: removed.id, bytes: removedBytes, deletable: true,
    });

    const response = await api(apiRequest(removed.id, "DELETE"));

    expect(response.status).toBe(204);
    expect(await response.text()).toBe("");
    await expect(fs.lstat(join(path, `${removed.id}.json`))).rejects.toMatchObject({ code: "ENOENT" });
    const after = jobStorageSchema.parse(await (await api(apiRequest("storage"))).json());
    expect(after.totalBytes).toBe(keptBytes);
    expect(after.runs.map((run) => run.id)).toEqual([kept.id]);
    expect(await fs.readFile(keptPath, "utf8")).toBe(original);
    expect(await fs.readFile(join(path, `${removed.id}.json.tmp`), "utf8")).toBe("unrelated temp");
    const restored = new JobStore(path);
    await restored.initialize();
    expect(restored.list().map((job) => job.id)).toEqual([kept.id]);
  });

  test("treats a missing snapshot as already removed", async () => {
    const path = await directory();
    const job = await snapshot(path);
    const store = new JobStore(path);
    await store.initialize();
    await fs.unlink(join(path, `${job.id}.json`));
    expect((await store.storage()).runs).toEqual([{ id: job.id, bytes: null, deletable: true }]);

    expect((await createApi(store)(apiRequest(job.id, "DELETE"))).status).toBe(204);

    expect(store.list()).toEqual([]);
  });

  test.each(["symlink", "directory"] as const)("refuses a %s without touching an outside target", async (kind) => {
    const path = await directory();
    const job = await snapshot(path);
    const store = new JobStore(path);
    await store.initialize();
    const canonical = join(path, `${job.id}.json`);
    const outside = join(await directory(), "outside.json");
    await fs.writeFile(outside, JSON.stringify(job));
    const original = await fs.readFile(outside, "utf8");
    await fs.unlink(canonical);
    if (kind === "symlink") await fs.symlink(outside, canonical);
    else await fs.mkdir(canonical);
    expect((await store.storage()).runs).toEqual([{ id: job.id, bytes: null, deletable: false }]);
    expect((await store.storage()).totalBytes).toBe(0);

    expect((await createApi(store)(apiRequest(job.id, "DELETE"))).status).toBe(409);

    expect(store.get(job.id).id).toBe(job.id);
    expect(await fs.readFile(outside, "utf8")).toBe(original);
    expect((await fs.lstat(canonical)).isSymbolicLink()).toBe(kind === "symlink");
    const restored = new JobStore(path);
    await restored.initialize();
    expect(restored.list()).toEqual([]);
  });

  test("rejects invalid and missing UUIDs and foreign origins before deletion", async () => {
    const path = await directory();
    const job = await snapshot(path);
    const store = new JobStore(path);
    await store.initialize();
    const api = createApi(store);

    expect((await api(apiRequest("not-a-uuid", "DELETE"))).status).toBe(400);
    expect((await api(apiRequest(crypto.randomUUID(), "DELETE"))).status).toBe(404);
    expect((await api(apiRequest("", "DELETE"))).status).toBe(404);
    expect((await api(apiRequest(job.id, "DELETE", { origin: "https://foreign.example" }))).status).toBe(403);
    expect((await api(apiRequest(job.id, "DELETE", { "sec-fetch-site": "cross-site" }))).status).toBe(403);

    expect(store.get(job.id).id).toBe(job.id);
    expect((await fs.lstat(join(path, `${job.id}.json`))).isFile()).toBe(true);
  });

  test("retains memory and disk after filesystem failure and allows a retry", async () => {
    const path = await directory();
    const job = await snapshot(path);
    const store = new JobStore(path);
    await store.initialize();
    const api = createApi(store);
    const failure = Object.assign(new Error("synthetic unlink failure"), { code: "EACCES" });
    const unlink = spyOn(fs, "unlink").mockRejectedValueOnce(failure);

    expect((await api(apiRequest(job.id, "DELETE"))).status).toBe(500);

    expect(store.get(job.id).id).toBe(job.id);
    expect((await fs.lstat(join(path, `${job.id}.json`))).isFile()).toBe(true);
    unlink.mockRestore();
    expect((await api(apiRequest(job.id, "DELETE"))).status).toBe(204);
  });

  test("rejects an overlapping deletion while its exact filesystem operation is pending", async () => {
    const path = await directory();
    const job = await snapshot(path);
    const store = new JobStore(path);
    await store.initialize();
    const api = createApi(store);
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const original = fs.unlink;
    spyOn(fs, "unlink").mockImplementation(async (target) => {
      entered.resolve();
      await release.promise;
      await original(target);
    });
    const first = api(apiRequest(job.id, "DELETE"));
    await entered.promise;
    try {
      expect(store.get(job.id).id).toBe(job.id);
      expect((await store.storage()).runs[0]?.deletable).toBe(false);
      expect((await api(apiRequest(job.id, "DELETE"))).status).toBe(409);
    } finally {
      release.resolve();
    }
    expect((await first).status).toBe(204);
    expect(store.list()).toEqual([]);
  });

  test("rejects queued, running, and terminal finalizing runs without resurrecting deleted history", async () => {
    const path = await directory();
    const initialEntered = Promise.withResolvers<void>();
    const initialRelease = Promise.withResolvers<void>();
    const finalEntered = Promise.withResolvers<void>();
    const finalRelease = Promise.withResolvers<void>();
    const workerRelease = Promise.withResolvers<void>();
    const openFile = fs.open;
    let writes = 0;
    spyOn(fs, "open").mockImplementation((async (target: string, ...rest: Parameters<typeof fs.open> extends [unknown, ...infer R] ? R : never) => {
      if (typeof target !== "string" || !target.endsWith(".tmp")) {
        throw new Error("expected a synthetic JSON snapshot write");
      }
      writes += 1;
      if (writes === 1) {
        initialEntered.resolve();
        await initialRelease.promise;
      } else {
        finalEntered.resolve();
        await finalRelease.promise;
      }
      return openFile(target, ...rest);
    }) as typeof fs.open);
    const store = new JobStore(path, async () => { await workerRelease.promise; });
    await store.initialize();
    const api = createApi(store);
    const starting = store.start(request);
    await initialEntered.promise;
    const job = store.list()[0];
    if (!job) throw new Error("expected synthetic queued run");
    const finished = Promise.withResolvers<void>();
    store.subscribe(job.id, () => { if (job.status === "failed") finished.resolve(); });
    try {
      expect(job.status).toBe("queued");
      expect((await api(apiRequest(job.id, "DELETE"))).status).toBe(409);
      initialRelease.resolve();
      await starting;
      expect(job.status).toBe("running");
      expect((await api(apiRequest(job.id, "DELETE"))).status).toBe(409);
      workerRelease.resolve();
      await finalEntered.promise;
      expect(job.status).toBe("failed");
      expect((await store.storage()).runs[0]?.deletable).toBe(false);
      expect((await api(apiRequest(job.id, "DELETE"))).status).toBe(409);
    } finally {
      initialRelease.resolve();
      workerRelease.resolve();
      finalRelease.resolve();
    }
    await finished.promise;
    expect((await api(apiRequest(job.id, "DELETE"))).status).toBe(204);
    await expect(fs.lstat(join(path, `${job.id}.json`))).rejects.toMatchObject({ code: "ENOENT" });
    const restored = new JobStore(path);
    await restored.initialize();
    expect(restored.list()).toEqual([]);
  });
});
