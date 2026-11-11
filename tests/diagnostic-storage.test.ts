import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import * as fs from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApi } from "../src/api";
import { jobRequestSchema } from "../src/contracts";
import type { Job } from "../src/contracts";
import { diagnosticPacketSchema, maximumDiagnosticBytes } from "../src/diagnostic-contracts";
import type { DiagnosticPacket } from "../src/diagnostic-contracts";
import { JobStore } from "../src/jobs";
import { resultFixture } from "./result-fixture";

const directories: string[] = [];
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aE9sAAAAASUVORK5CYII=", "base64");

async function setup(synthetic = false) {
  const directory = await fs.mkdtemp(join(tmpdir(), "vlaeval-diagnostic-"));
  directories.push(directory);
  const job: Job = {
    id: crypto.randomUUID(), status: "completed", createdAt: "2026-10-15T00:00:00Z",
    request: jobRequestSchema.parse({
      host: "test@localhost", repo: "/synthetic/repo", config: resultFixture.config,
      checkpoint: resultFixture.checkpoint, dataset: resultFixture.dataset, episodes: [3], numSteps: 1,
    }),
    progress: { completed: 3, total: 3, message: "" }, logs: [], error: null,
    result: { ...structuredClone(resultFixture), numSteps: 1 },
  };
  await fs.writeFile(join(directory, `${job.id}.json`), JSON.stringify(job));
  const store = new JobStore(directory, undefined, undefined, synthetic);
  await store.initialize();
  const packet = diagnosticPacketSchema.parse({
    schemaVersion: 1,
    identity: {
      jobId: job.id, episode: 3, frame: 0, dataset: resultFixture.dataset,
      config: resultFixture.config, checkpoint: resultFixture.checkpoint, seed: 0, numSteps: 1,
    },
    provenance: {
      kind: synthetic ? "synthetic" : "captured", adapterRevision: "test",
      backend: synthetic ? "none" : "jax", dtype: "float32", compiled: false,
      inputDigest: "0".repeat(64), noiseDigest: null,
    },
    images: [{
      role: "front", datasetKey: "observation.image", modelKey: "base_0_rgb", width: 1, height: 1,
      timestampSeconds: 0, sha256: createHash("sha256").update(png).digest("hex"),
      mime: "image/png", dataBase64: png.toString("base64"),
      preprocessing: { inputWidth: 1, inputHeight: 1, sourceToInput: [1, 0, 0, 1, 0, 0], contentRect: [0, 0, 1, 1] },
    }],
    attention: null, projection: null, actionDifferences: [],
    timing: { compileMs: null, warmupMs: null, inferenceMs: null, extractionMs: null, peakGpuBytes: null },
  });
  const api = createApi(store);
  const path = join(directory, `${job.id}.diag-3-0.json`);
  return { directory, job, store, packet, api, path };
}

function request(packet: DiagnosticPacket, method = "PUT", body = JSON.stringify(packet), query = "episode=3&frame=0") {
  return new Request(`http://localhost:4310/api/jobs/${packet.identity.jobId}/diagnostics?${query}`, {
    method, ...(method === "PUT" ? { body } : {}),
  });
}

function attention(packet: DiagnosticPacket): DiagnosticPacket {
  return diagnosticPacketSchema.parse({
    ...packet,
    attention: {
      kind: "action_to_image", layers: [0], steps: [{ index: 0, flowTime: 1 }], headReduction: "mean",
      headCount: 1, horizon: 1,
      queryGroups: [
        { id: "early", horizonIndices: [0], queryRows: [0] },
        { id: "late", horizonIndices: [], queryRows: [] },
      ],
      keyCount: 1, keyGroups: [{ id: "camera", kind: "image", modelKey: "base_0_rgb", keyIndices: [0] }],
      cameras: [{ modelKey: "base_0_rgb", gridWidth: 1, gridHeight: 1, patchKeyIndices: [0] }],
      slices: [
        { stepIndex: 0, layer: 0, queryGroup: "early", masses: [{ groupId: "camera", value: 1 }],
          maps: [{ modelKey: "base_0_rgb", valuesF16LE: "ADw=" }], sinkCandidates: [] },
        { stepIndex: 0, layer: 0, queryGroup: "late", masses: [{ groupId: "camera", value: 0 }],
          maps: [{ modelKey: "base_0_rgb", valuesF16LE: "AAA=" }], sinkCandidates: [] },
      ],
      sinkMethod: "test",
    },
  });
}

afterEach(async () => {
  mock.restore();
  await Promise.all(directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

describe("diagnostic artifact receiver", () => {
  test("binds attention horizon, valid queries and action difference channels to saved data", async () => {
    const { api, packet } = await setup();
    const wrongHorizon = attention(packet);
    if (!wrongHorizon.attention) throw new Error("Attention required");
    wrongHorizon.attention.horizon = 2;
    expect((await api(request(wrongHorizon))).status).toBe(400);
    const missingQuery = attention(packet);
    const group = missingQuery.attention?.queryGroups[0], slice = missingQuery.attention?.slices[0];
    if (!group || !slice) throw new Error("Attention group required");
    group.horizonIndices = []; group.queryRows = [];
    slice.masses = [{ groupId: "camera", value: 0 }];
    slice.maps = [{ modelKey: "base_0_rgb", valuesF16LE: "AAA=" }];
    expect((await api(request(missingQuery))).status).toBe(400);
    const wrongChannel = { ...packet, actionDifferences: [
      { channel: "not_in_saved_action", unit: "rad", maxAbsolute: 0, atol: null, rtol: null, exceededCount: null },
    ] };
    expect((await api(request(wrongChannel))).status).toBe(400);
  });

  test("roundtrips captured packet JSON without mutating the run", async () => {
    const { api, packet, directory, job } = await setup();
    const original = await fs.readFile(join(directory, `${job.id}.json`), "utf8");
    expect((await api(request(packet, "GET"))).status).toBe(404);
    const response = await api(request(packet));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(packet);
    expect(await (await api(request(packet, "GET"))).json()).toEqual(packet);
    expect(await fs.readFile(join(directory, `${job.id}.json`), "utf8")).toBe(original);
  });

  test("restores packet JSON from the same resolved directory after restart", async () => {
    const { store, packet, directory } = await setup();
    await store.saveDiagnostic(packet.identity.jobId, packet);
    const alias = join(directory, "alias");
    await fs.symlink(directory, alias);
    const restarted = new JobStore(alias);
    await restarted.initialize();
    expect(await restarted.getDiagnostic(packet.identity.jobId, 3, 0)).toEqual(packet);
    expect((await restarted.storage()).directory).toBe(await fs.realpath(directory));
  });

  test.each(["dataset", "config", "checkpoint", "seed", "numSteps"] as const)(
    "rejects a mismatched result %s", async (field) => {
      const { api, packet } = await setup();
      if (field === "seed" || field === "numSteps") packet.identity[field] += 1;
      else packet.identity[field] += "-different";
      expect((await api(request(packet))).status).toBe(400);
    },
  );

  test("rejects path, query, missing, and unscored anchor identities", async () => {
    const { api, packet, store } = await setup();
    expect((await api(request(packet, "PUT", JSON.stringify(packet), "episode=3&frame=1"))).status).toBe(400);
    expect((await api(request(packet, "PUT", JSON.stringify(packet), "episode=3&frame=0&frame=1"))).status).toBe(400);
    expect((await api(request(packet, "GET", "", "frame=0"))).status).toBe(400);
    expect((await api(request(packet, "GET", "", "episode=3&frame=-1"))).status).toBe(400);
    const other = structuredClone(packet);
    other.identity.jobId = crypto.randomUUID();
    expect((await api(request(other))).status).toBe(404);
    await expect(store.saveDiagnostic(other.identity.jobId, packet)).rejects.toMatchObject({ status: 400 });
    packet.identity.frame = 500;
    expect((await api(request(packet, "PUT", JSON.stringify(packet), "episode=3&frame=500"))).status).toBe(400);
  });

  test("accepts a scored trace anchor not included in samples", async () => {
    const { api, packet } = await setup();
    packet.identity.frame = 2;
    expect((await api(request(packet, "PUT", JSON.stringify(packet), "episode=3&frame=2"))).status).toBe(200);
  });

  test("restricts synthetic publication to explicit test stores and preserves its label", async () => {
    const normal = await setup();
    normal.packet.provenance.kind = "synthetic";
    expect((await normal.api(request(normal.packet))).status).toBe(409);
    const synthetic = await setup(true);
    expect((await synthetic.api(request(synthetic.packet))).status).toBe(200);
    const response = await synthetic.api(request(synthetic.packet, "GET"));
    expect(await response.json()).toEqual(synthetic.packet);
    const ordinary = new JobStore(synthetic.directory);
    await ordinary.initialize();
    await expect(ordinary.getDiagnostic(synthetic.job.id, 3, 0)).rejects.toMatchObject({ status: 409 });
  });

  test.each(["hash", "png-magic", "jpeg-magic"] as const)("rejects invalid image %s", async (kind) => {
    const { api, packet } = await setup();
    const image = packet.images[0];
    if (!image) throw new Error("image fixture missing");
    if (kind === "hash") image.sha256 = "0".repeat(64);
    else if (kind === "jpeg-magic") image.mime = "image/jpeg";
    else {
      const bytes = Buffer.from("not an image");
      image.dataBase64 = bytes.toString("base64");
      image.sha256 = createHash("sha256").update(bytes).digest("hex");
    }
    expect((await api(request(packet))).status).toBe(400);
  });

  test.each(["AHw=", "AIA=", "AEE=", "ADg="])("rejects invalid half-map payload %s", async (encoded) => {
    const { api, packet } = await setup();
    const payload = attention(packet);
    const map = payload.attention?.slices[0]?.maps[0];
    if (!map) throw new Error("attention fixture missing");
    map.valuesF16LE = encoded;
    expect((await api(request(payload))).status).toBe(400);
  });

  test("accepts valid half-map mass and rejects nonfinite half payloads", async () => {
    const { api, packet } = await setup();
    const payload = attention(packet);
    expect((await api(request(payload))).status).toBe(200);
    const map = payload.attention?.slices[0]?.maps[0];
    if (!map) throw new Error("attention fixture missing");
    map.valuesF16LE = "AXw=";
    expect((await api(request(payload))).status).toBe(400);
  });

  test("bounds bodies without a Content-Length even when the API is called directly", async () => {
    const { api, packet } = await setup();
    expect((await api(request(packet, "PUT", " ".repeat(maximumDiagnosticBytes + 1)))).status).toBe(413);
  });

  test("bounds store payloads independently of the HTTP receiver", async () => {
    const { store, packet } = await setup();
    packet.identity.dataset = "x".repeat(maximumDiagnosticBytes);
    await expect(store.saveDiagnostic(packet.identity.jobId, packet)).rejects.toMatchObject({ status: 413 });
  });

  test("inherits same-origin checks for diagnostic publication", async () => {
    const { api, packet } = await setup();
    const foreign = new Request(request(packet), { headers: { origin: "https://foreign.example" } });
    expect((await api(foreign)).status).toBe(403);
  });
});

describe("diagnostic file ownership", () => {
  test("accounts and deletes only exact canonical diagnostics belonging to the run", async () => {
    const { store, packet, directory, job, path } = await setup();
    await store.saveDiagnostic(job.id, packet);
    const kept = [
      `${job.id}.diag-03-0.json`, `${job.id}.diag-3-00.json`, `${job.id}.diag-1000001-0.json`,
      `${job.id}.diag-3-0.json.tmp`, `${crypto.randomUUID()}.diag-3-0.json`,
    ];
    for (const name of kept) await fs.writeFile(join(directory, name), "unrelated");
    const bytes = (await fs.stat(path)).size + (await fs.stat(join(directory, `${job.id}.json`))).size;
    expect((await store.storage()).totalBytes).toBe(bytes);
    await store.delete(job.id);
    expect(store.list()).toEqual([]);
    expect((await fs.readdir(directory)).sort()).toEqual(kept.sort());
  });

  test.each(["symlink", "directory"] as const)("refuses a canonical diagnostic %s for read, write, and delete", async (kind) => {
    const { store, packet, directory, job, path } = await setup();
    const outside = join(directory, "outside.json");
    await fs.writeFile(outside, "untouched");
    if (kind === "symlink") await fs.symlink(outside, path);
    else await fs.mkdir(path);
    await expect(store.getDiagnostic(job.id, 3, 0)).rejects.toMatchObject({ status: 409 });
    await expect(store.saveDiagnostic(job.id, packet)).rejects.toMatchObject({ status: 409 });
    expect((await store.storage()).runs).toEqual([{ id: job.id, bytes: null, deletable: false }]);
    await expect(store.delete(job.id)).rejects.toMatchObject({ status: 409 });
    expect(store.get(job.id).id).toBe(job.id);
    expect(await fs.readFile(outside, "utf8")).toBe("untouched");
    expect((await fs.lstat(join(directory, `${job.id}.json`))).isFile()).toBe(true);
  });

  test("retains the run after a diagnostic filesystem deletion error", async () => {
    const { store, packet, job, directory } = await setup();
    await store.saveDiagnostic(job.id, packet);
    spyOn(fs, "unlink").mockRejectedValueOnce(Object.assign(new Error("denied"), { code: "EACCES" }));
    await expect(store.delete(job.id)).rejects.toMatchObject({ code: "EACCES" });
    expect(store.get(job.id).id).toBe(job.id);
    expect((await fs.lstat(join(directory, `${job.id}.json`))).isFile()).toBe(true);
  });

  test("does not publish a partial file after atomic rename failure", async () => {
    const { store, packet, job, directory } = await setup();
    spyOn(fs, "rename").mockRejectedValueOnce(Object.assign(new Error("denied"), { code: "EACCES" }));
    await expect(store.saveDiagnostic(job.id, packet)).rejects.toMatchObject({ code: "EACCES" });
    expect(await fs.readdir(directory)).toEqual([`${job.id}.json`]);
    expect((await store.storage()).runs[0]?.deletable).toBe(true);
  });

  test("blocks deletion and overlapping writes at the exact pending publication signal", async () => {
    const { store, packet, job } = await setup();
    const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
    const rename = fs.rename;
    spyOn(fs, "rename").mockImplementation(async (from, to) => {
      entered.resolve();
      await release.promise;
      await rename(from, to);
    });
    const saving = store.saveDiagnostic(job.id, packet);
    await entered.promise;
    try {
      await expect(store.delete(job.id)).rejects.toMatchObject({ status: 409 });
      await expect(store.saveDiagnostic(job.id, packet)).rejects.toMatchObject({ status: 409 });
      expect((await store.storage()).runs[0]?.deletable).toBe(false);
    } finally { release.resolve(); }
    await saving;
    await store.delete(job.id);
    expect(store.list()).toEqual([]);
  }, 5000);

  test("blocks publication while deletion owns the run and cannot resurrect it", async () => {
    const { store, packet, job, directory } = await setup();
    await store.saveDiagnostic(job.id, packet);
    const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
    const unlink = fs.unlink;
    spyOn(fs, "unlink").mockImplementation(async (path) => {
      entered.resolve();
      await release.promise;
      await unlink(path);
    });
    const deleting = store.delete(job.id);
    await entered.promise;
    try {
      await expect(store.saveDiagnostic(job.id, packet)).rejects.toMatchObject({ status: 409 });
    } finally { release.resolve(); }
    await deleting;
    await expect(store.saveDiagnostic(job.id, packet)).rejects.toMatchObject({ status: 404 });
    const restarted = new JobStore(directory);
    await restarted.initialize();
    expect(restarted.list()).toEqual([]);
    expect(await fs.readdir(directory)).toEqual([]);
  }, 5000);
});
