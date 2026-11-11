import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApi } from "../src/api";
import { jobRequestSchema, sessionSchema } from "../src/contracts";
import type { Job } from "../src/contracts";
import { JobStore } from "../src/jobs";
import { lanPolicyFromEnv, peerFor } from "../src/lan";

const directories: string[] = [];
const policy = lanPolicyFromEnv({ VLAEVAL_PUBLIC_HOSTS: "192.168.0.45" });
const lanOff = lanPolicyFromEnv({});
const alice = peerFor("::ffff:192.168.0.77");
const bob = peerFor("192.168.0.88");
const me = peerFor("127.0.0.1");
const evaluation = jobRequestSchema.parse({
  host: "rtx6000@192.168.0.3", repo: "/home/rtx6000/kgs/pi05_rby1", config: "pi05_rby1",
  checkpoint: "/home/rtx6000/.cache/openpi/openpi-assets/checkpoints/x/9999",
  dataset: "/mnt/datasetui-nas/DatasetUI/derived/d", episodes: [0],
});

afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => fs.rm(path, { recursive: true, force: true })));
});

async function setup(owner?: Job["owner"]) {
  const path = await fs.mkdtemp(join(tmpdir(), "vlaeval-lan-"));
  directories.push(path);
  const job: Job = {
    id: crypto.randomUUID(), status: "failed", createdAt: new Date().toISOString(), request: evaluation,
    ...(owner ? { owner } : {}), progress: { completed: 0, total: 0, message: "" }, logs: [], result: null, error: "x",
  };
  await fs.writeFile(join(path, `${job.id}.json`), JSON.stringify(job));
  const started: unknown[] = [];
  const store = new JobStore(path, async (request) => { started.push(request); });
  await store.initialize();
  return { store, job, started, api: createApi(store, undefined, undefined, undefined, policy) };
}

const lan = (path: string, init: RequestInit & { name?: string } = {}) => {
  const headers = new Headers(init.headers);
  if (init.name !== undefined) headers.set("x-vlaeval-user", encodeURIComponent(init.name));
  if (init.body !== undefined) headers.set("content-type", "application/json");
  return new Request(`http://192.168.0.45:4310${path}`, { ...init, headers });
};
const post = (path: string, body: unknown, name = "김철수") => lan(path, { method: "POST", body: JSON.stringify(body), name });

describe("LAN access", () => {
  test("LAN clients are refused while no public host is configured", async () => {
    const { store } = await setup();
    const api = createApi(store, undefined, undefined, undefined, lanOff);
    expect((await api(lan("/api/jobs"), alice)).status).toBe(403);
  });

  test("Host, Origin and cross-site checks hold for LAN and loopback clients", async () => {
    const { api } = await setup();
    expect((await api(new Request("http://evil.example:4310/api/jobs"), alice)).status).toBe(403);
    expect((await api(new Request("http://localhost:4310/api/jobs"), alice)).status).toBe(403);
    expect((await api(lan("/api/jobs", { headers: { origin: "http://evil.example" } }), alice)).status).toBe(403);
    expect((await api(lan("/api/jobs", { headers: { "sec-fetch-site": "cross-site" } }), alice)).status).toBe(403);
    expect((await api(new Request("http://evil.example:4310/api/jobs"), me)).status).toBe(403);
    expect((await api(lan("/api/jobs"), alice)).status).toBe(200);
    expect((await api(new Request("http://127.0.0.1:4310/api/jobs"), me)).status).toBe(200);
  });

  test("session reports the peer", async () => {
    const { api } = await setup();
    expect(sessionSchema.parse(await (await api(lan("/api/session"), alice)).json()))
      .toEqual({ local: false, ip: "192.168.0.77", lan: true });
    expect(sessionSchema.parse(await (await api(new Request("http://127.0.0.1:4310/api/session"), me)).json()).local).toBe(true);
  });

  test("LAN writes need a valid name; the run records name and IP", async () => {
    const { api, store, started } = await setup();
    expect((await api(lan("/api/jobs", { method: "POST", body: JSON.stringify(evaluation) }), alice)).status).toBe(401);
    expect((await api(post("/api/jobs", evaluation, "<script>"), alice)).status).toBe(401);
    const created = await api(post("/api/jobs", evaluation), alice);
    expect(created.status).toBe(201);
    const { id } = await created.json() as { id: string };
    expect(store.get(id).owner).toEqual({ name: "김철수", ip: "192.168.0.77" });
    await Bun.sleep(0);
    expect(started).toHaveLength(1);
  });

  test("LAN requests outside the allowlist are refused before any SSH", async () => {
    const { api, started } = await setup();
    const refused = [
      post("/api/jobs", { ...evaluation, host: "kgs@192.168.0.45" }),
      post("/api/jobs", { ...evaluation, repo: "/tmp/evil" }),
      post("/api/jobs", { ...evaluation, checkpoint: "/home/rtx6000/kgs/../../../etc/passwd" }),
      post("/api/jobs", { ...evaluation, dataset: "/etc" }),
      post("/api/discover", { host: "rtx6000@192.168.0.3", roots: ["/"] }),
      post("/api/discover", { host: "rtx6000@192.168.0.3", roots: ["~/../other"] }),
      post("/api/discover", { host: "rtx6000@192.168.0.3", roots: ["/home/rtx6000/kgsx"] }),
      post("/api/openpi-checkpoints", { host: "rtx6000@192.168.0.3", root: "~/.ssh" }),
      post("/api/configs", { host: "rtx6000@192.168.0.3", repo: "/home/rtx6000" }),
      post("/api/datasetui", { host: "rtx6000@192.168.0.3", datasetuiContainer: "other" }),
      post("/api/episodes", { host: "rtx6000@192.168.0.3", repo: "/home/rtx6000/kgs/pi05_rby1", dataset: "/root" }),
    ];
    for (const request of refused) expect((await api(request, alice)).status).toBe(403);
    expect(started).toHaveLength(0);
  });

  test("each SSH target is checked against its own repo and roots", async () => {
    const { api, started } = await setup();
    const thor = {
      ...evaluation, host: "nvidia@192.168.0.223", repo: "/home/nvidia/kgs/pi05_rby1",
      checkpoint: "/home/nvidia/.cache/openpi/openpi-assets/checkpoints/pi05_rby1_JIMTOF_1023v2_pytorch_100000",
    };
    expect((await api(post("/api/jobs", thor), alice)).status).toBe(201);
    for (const crossed of [
      { ...thor, repo: evaluation.repo },
      { ...thor, checkpoint: evaluation.checkpoint },
      { ...evaluation, checkpoint: thor.checkpoint },
    ]) expect((await api(post("/api/jobs", crossed), alice)).status).toBe(403);
    expect((await api(post("/api/discover", { host: thor.host, roots: ["/home/rtx6000/kgs"] }), alice)).status).toBe(403);
    await Bun.sleep(0);
    expect(started).toHaveLength(1);
  });

  test("LAN clients delete or cancel only runs started from their IP; this PC may change any", async () => {
    const mine = await setup({ name: "김철수", ip: "192.168.0.77" });
    expect((await mine.api(lan(`/api/jobs/${mine.job.id}`, { method: "DELETE", name: "x" }), bob)).status).toBe(403);
    expect((await mine.api(lan(`/api/jobs/${mine.job.id}/cancel`, { method: "POST", name: "x" }), bob)).status).toBe(403);
    expect((await mine.api(lan(`/api/jobs/${mine.job.id}`, { method: "DELETE", name: "김철수" }), alice)).status).toBe(204);
    const legacy = await setup();
    expect((await legacy.api(lan(`/api/jobs/${legacy.job.id}`, { method: "DELETE", name: "x" }), alice)).status).toBe(403);
    expect((await legacy.api(new Request(`http://localhost:4310/api/jobs/${legacy.job.id}`, { method: "DELETE" }), me)).status).toBe(204);
  });

  test("LAN clients cannot re-run a stored job whose paths leave the allowlist, nor cancel others' diagnostics", async () => {
    const { api, job, store } = await setup();
    const local = await api(new Request("http://127.0.0.1:4310/api/jobs", {
      method: "POST", body: JSON.stringify({ ...evaluation, checkpoint: "/root/secret" }),
    }), me);
    const { id } = await local.json() as { id: string };
    await Bun.sleep(0);
    expect(store.get(id).request.checkpoint).toBe("/root/secret");
    for (const path of [`/api/jobs/${id}/diagnostics/run`, `/api/jobs/${id}/projection`]) {
      expect((await api(post(path, { episode: 0, frame: 0 }), alice)).status).toBe(403);
    }
    expect((await api(post(`/api/jobs/${id}/attention-video/run`, { episode: 0 }), alice)).status).toBe(403);
    for (const path of [`/api/jobs/${job.id}/diagnostics/run/cancel`, `/api/jobs/${job.id}/attention-video/run/cancel`]) {
      expect((await api(post(path, { runId: crypto.randomUUID() }), alice)).status).toBe(403);
    }
  });

  test("run snapshots are written through a fresh temp file, never a planted symlink", async () => {
    const { api, store, job } = await setup();
    const victim = join(directories[0]!, "victim.txt");
    await fs.writeFile(victim, "keep");
    await fs.symlink(victim, join(directories[0]!, `${job.id}.json.tmp`));
    const response = await api(post("/api/jobs", evaluation), alice);
    const { id } = await response.json() as { id: string };
    await fs.symlink(victim, join(directories[0]!, `${id}.json.tmp`)).catch(() => {});
    await Bun.sleep(10);
    expect(store.get(id).status).not.toBe("running");
    expect(await fs.readFile(victim, "utf8")).toBe("keep");
    expect((await fs.lstat(join(directories[0]!, `${id}.json`))).isFile()).toBe(true);
  });

  test("loopback requests keep the unrestricted local behaviour", async () => {
    const { api, store } = await setup();
    const response = await api(new Request("http://127.0.0.1:4310/api/jobs", {
      method: "POST", body: JSON.stringify({ ...evaluation, host: "kgs@localhost", repo: "/any" }),
    }), me);
    expect(response.status).toBe(201);
    const { id } = await response.json() as { id: string };
    expect(store.get(id).owner).toBeUndefined();
  });
});
