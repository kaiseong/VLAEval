import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApi, eventStream } from "../src/api";
import { jobRequestSchema, resultSchema } from "../src/contracts";
import type { Job } from "../src/contracts";
import { isTerminal, JobStore } from "../src/jobs";
import { consumeLines, quoteShell, sshCommand, workerCommand } from "../src/remote";
import { resultFixture } from "./result-fixture";

const directories: string[] = [];
async function makeDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "vlaeval-test-"));
  directories.push(directory);
  return directory;
}
afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
const request = jobRequestSchema.parse({
  host: "rtx6000@192.168.0.3", repo: "/models/openpi", config: "test",
  checkpoint: "/models/100", dataset: "/data/test", episodes: [3, 8],
});

function terminal(store: JobStore, id: string): Promise<Job> {
  const result = Promise.withResolvers<Job>();
  const unsubscribe = store.subscribe(id, (job) => {
    if (isTerminal(job)) {
      unsubscribe();
      result.resolve(job);
    }
  });
  return result.promise;
}

describe("input and SSH boundaries", () => {
  test("parses legacy results without optional horizon coverage", () => {
    const result = resultSchema.parse(resultFixture);
    expect(result.coverage).toBeUndefined();
  });

  test("requires explicit episodes and defaults to every selected frame", () => {
    expect(request.stride).toBe(1);
    expect(request.maxSamples).toBe(0);
    expect(jobRequestSchema.safeParse({ ...request, episodes: [] }).success).toBe(false);
    expect(jobRequestSchema.safeParse({ ...request, host: "-oProxyCommand=touch /tmp/x" }).success).toBe(false);
  });

  test("quotes remote paths and separates SSH options from the destination", () => {
    expect(quoteShell("/path/it's here")).toBe("'/path/it'\\''s here'");
    const command = workerCommand({ ...request, repo: "/models/it's here", operation: "evaluate" });
    expect(command).toContain("'/models/it'\\''s here/.venv/bin/python'");
    const args = sshCommand(request.host, command);
    expect(args.slice(-3)).toEqual(["--", request.host, command]);
  });

  test("decodes split UTF-8 and lines without dropping a final partial line", async () => {
    const bytes = new TextEncoder().encode("한글\nsecond\nlast");
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes.slice(0, 1));
        controller.enqueue(bytes.slice(1, 8));
        controller.enqueue(bytes.slice(8));
        controller.close();
      },
    });
    const lines: string[] = [];
    await consumeLines(stream, (line) => lines.push(line));
    expect(lines).toEqual(["한글", "second", "last"]);
  });

  test("accepts a large full-episode result without a fixed line-size cap", async () => {
    const chunk = new Uint8Array(1024 * 1024).fill(120);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let index = 0; index < 33; index += 1) controller.enqueue(chunk);
        controller.enqueue(new TextEncoder().encode("\n"));
        controller.close();
      },
    });
    const lengths: number[] = [];
    await consumeLines(stream, (line) => lengths.push(line.length));
    expect(lengths).toEqual([33 * 1024 * 1024]);
  });
});

describe("job lifecycle", () => {
  test("preserves full episode traces in completed and restored results", async () => {
    const directory = await makeDirectory();
    const gate = Promise.withResolvers<void>();
    const store = new JobStore(directory, async (_request, emit) => {
      await gate.promise;
      emit({ type: "result", result: resultFixture });
    });
    await store.initialize();
    const job = await store.start(request);
    const finished = terminal(store, job.id);
    gate.resolve();
    expect((await finished).status).toBe("completed");
    const restored = new JobStore(directory);
    await restored.initialize();
    expect(restored.get(job.id).result?.traces).toEqual(resultFixture.traces);
    expect(restored.get(job.id).result?.perHorizon).toEqual(resultFixture.perHorizon);
  });

  test("persists worker failure and does not invent a completed result", async () => {
    const directory = await makeDirectory();
    const gate = Promise.withResolvers<void>();
    const store = new JobStore(directory, async () => {
      await gate.promise;
      throw new Error("checkpoint missing");
    });
    await store.initialize();
    const job = await store.start(request);
    const finished = terminal(store, job.id);
    gate.resolve();
    expect((await finished).status).toBe("failed");
    expect(job.result).toBeNull();
    const restored = new JobStore(directory);
    await restored.initialize();
    expect(restored.get(job.id).error).toBe("checkpoint missing");
  });

  test("rejects a concurrent evaluation until the worker actually exits", async () => {
    const gate = Promise.withResolvers<void>();
    const store = new JobStore(await makeDirectory(), async () => { await gate.promise; });
    await store.initialize();
    const job = await store.start(request);
    const finished = terminal(store, job.id);
    await expect(store.start(request)).rejects.toThrow("이미 평가");
    gate.resolve();
    expect((await finished).status).toBe("failed");
    expect(job.error).toContain("결과 없이");
  });

  test("queues early cancellation and confirms it from the remote worker", async () => {
    const startGate = Promise.withResolvers<void>();
    const cancelGate = Promise.withResolvers<void>();
    const calls: { host: string; pid: number }[] = [];
    const store = new JobStore(await makeDirectory(), async (_request, emit) => {
      await startGate.promise;
      emit({ type: "started", pid: 456 });
      await cancelGate.promise;
      emit({ type: "cancelled" });
    }, async (host, pid) => {
      calls.push({ host, pid });
      cancelGate.resolve();
    });
    await store.initialize();
    const job = await store.start(request);
    const finished = terminal(store, job.id);
    await store.requestCancel(job.id);
    expect(job.status).toBe("running");
    expect(calls).toEqual([]);
    startGate.resolve();
    expect((await finished).status).toBe("cancelled");
    expect(calls).toEqual([{ host: request.host, pid: 456 }]);
  });

  test("SSE emits the initial snapshot and closes after terminal evidence", async () => {
    const gate = Promise.withResolvers<void>();
    const store = new JobStore(await makeDirectory(), async (_request, emit) => {
      await gate.promise;
      emit({ type: "cancelled" });
    });
    await store.initialize();
    const job = await store.start(request);
    const stream = eventStream(new Request(`http://127.0.0.1/api/jobs/${job.id}/events`), store, job.id);
    const body = stream.text();
    gate.resolve();
    const records = (await body).trim().split("\n\n").map((line) => JSON.parse(line.slice(6)));
    expect(records[0].status).toBe("running");
    expect(records.at(-1).status).toBe("cancelled");
  });

  test("closing the event stream also detaches its abort listener", async () => {
    const gate = Promise.withResolvers<void>();
    const store = new JobStore(await makeDirectory(), async (_request, emit) => {
      await gate.promise;
      emit({ type: "cancelled" });
    });
    await store.initialize();
    const job = await store.start(request);
    const finished = terminal(store, job.id);
    const abort = new AbortController();
    const stream = eventStream(new Request(`http://127.0.0.1/api/jobs/${job.id}/events`, {
      signal: abort.signal,
    }), store, job.id);
    await stream.body?.cancel();
    abort.abort();
    gate.resolve();
    expect((await finished).status).toBe("cancelled");
  });
});

describe("HTTP boundaries", () => {
  test("rejects cross-origin requests without starting a worker", async () => {
    let started = false;
    const store = new JobStore(await makeDirectory(), async () => { started = true; });
    await store.initialize();
    const api = createApi(store);
    const response = await api(new Request("http://127.0.0.1:4310/api/jobs", {
      method: "POST", headers: { origin: "https://outside.example", "Content-Type": "application/json" },
      body: JSON.stringify(request),
    }));
    expect(response.status).toBe(403);
    expect(started).toBe(false);
  });

  test("invalid episode selection returns 400 before any remote work", async () => {
    const store = new JobStore(await makeDirectory());
    await store.initialize();
    const response = await createApi(store)(new Request("http://localhost:4310/api/jobs", {
      method: "POST", body: JSON.stringify({ ...request, episodes: [] }),
    }));
    expect(response.status).toBe(400);
    expect(store.list()).toEqual([]);
  });
});
