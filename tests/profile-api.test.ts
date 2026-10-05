import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApi } from "../src/api";
import { JobStore } from "../src/jobs";
import { ProfileCatalog } from "../src/kinematics/catalog";
import { compiledProfileSchema } from "../src/kinematics/contracts";
import { compileUrdfProfile } from "../src/kinematics/urdf";

const directories: string[] = [];
async function setup() {
  const directory = await mkdtemp(join(tmpdir(), "vlaeval-task13-api-"));
  directories.push(directory);
  const root = join(directory, "root");
  await mkdir(root);
  const xml = await readFile(new URL("./fixtures/urdf/rby1a-v1.2.urdf", import.meta.url), "utf8");
  const path = join(root, "model.urdf");
  await writeFile(path, xml);
  const store = new JobStore(join(directory, "runs"));
  await store.initialize();
  const catalog = new ProfileCatalog(JSON.stringify([root]));
  return { directory, root, xml, path, store, catalog, api: createApi(store, catalog) };
}
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});
const endpoint = "http://127.0.0.1/api/kinematics/profiles";

test("returns actual compiled chains when the known digest id is requested", async () => {
  // Given
  const { api, xml, path } = await setup();
  const expected = compileUrdfProfile(xml, { sourcePath: path, model: "RBY1_A", revision: "v1.2" });
  // When
  const response = await api(new Request(`${endpoint}/${expected.profileHash}`));
  // Then
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(compiledProfileSchema.parse(await response.json())).toEqual(expected);
});

test("lists profile metadata when a local GET is requested", async () => {
  // Given
  const { api, xml, path } = await setup();
  const profile = compileUrdfProfile(xml, { sourcePath: path, model: "RBY1_A", revision: "v1.2" });
  const { rightChain: _right, leftChain: _left, ...metadata } = profile;
  // When
  const response = await api(new Request(endpoint));
  // Then
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ profiles: [{ id: profile.profileHash, ...metadata }], reasons: [] });
});

for (const options of [
  { headers: { origin: "https://outside.example" } },
  { headers: { "sec-fetch-site": "cross-site" } },
]) {
  test(`rejects profile access before routes when guard headers are ${JSON.stringify(options)}`, async () => {
    // Given
    const { api } = await setup();
    // When
    const response = await api(new Request(endpoint, options));
    // Then
    expect(response.status).toBe(403);
  });
}

test("rejects profile access when the request hostname is nonlocal", async () => {
  // Given
  const { api } = await setup();
  // When
  const response = await api(new Request("http://outside.example/api/kinematics/profiles"));
  // Then
  expect(response.status).toBe(403);
});

for (const suffix of ["unknown", "a".repeat(64), "%2Fetc%2Fpasswd", "..%2Foutside.urdf"]) {
  test(`returns 404 when a profile id is unknown or pathlike: ${suffix}`, async () => {
    // Given
    const { api } = await setup();
    // When
    const response = await api(new Request(`${endpoint}/${suffix}`));
    // Then
    expect(response.status).toBe(404);
  });
}

for (const method of ["POST", "PUT", "DELETE"]) {
  test(`rejects writes when the profile endpoint receives ${method}`, async () => {
    // Given
    const { api } = await setup();
    // When
    const response = await api(new Request(endpoint, { method, body: '{"path":"/etc/passwd"}' }));
    // Then
    expect(response.status).toBe(404);
  });
}

test("returns conflict when a listed digest becomes stale", async () => {
  // Given
  const { api, path, xml, catalog } = await setup();
  const id = (await catalog.list()).profiles[0]?.id ?? "";
  await writeFile(path, `${xml}\n`);
  // When
  const response = await api(new Request(`${endpoint}/${id}`));
  // Then
  expect(response.status).toBe(409);
});

test("returns conflict when a listed file is replaced with an escaping symlink", async () => {
  // Given
  const { api, path, xml, directory, catalog } = await setup();
  const id = (await catalog.list()).profiles[0]?.id ?? "";
  const outside = join(directory, "outside.urdf");
  await writeFile(outside, xml);
  await rm(path);
  await symlink(outside, path);
  // When
  const response = await api(new Request(`${endpoint}/${id}`));
  // Then
  expect(response.status).toBe(409);
});

test("preserves raw history when optional profile roots are missing", async () => {
  // Given
  const { store, directory } = await setup();
  const api = createApi(store, new ProfileCatalog(JSON.stringify([join(directory, "absent")])));
  // When
  const responses = await Promise.all([
    api(new Request(endpoint)), api(new Request("http://127.0.0.1/api/jobs")),
  ]);
  // Then
  expect(responses.map((response) => response.status)).toEqual([200, 200]);
  expect(await responses[0]?.json()).toMatchObject({ profiles: [], reasons: [{ code: "ENOENT" }] });
  expect(await responses[1]?.json()).toEqual([]);
});

test("serves exact production responses when called over ephemeral local HTTP", async () => {
  // Given
  const { api, path, xml } = await setup();
  const expected = compileUrdfProfile(xml, { sourcePath: path, model: "RBY1_A", revision: "v1.2" });
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: api });
  try {
    // When
    const response = await fetch(new URL(`/api/kinematics/profiles/${expected.profileHash}`, server.url), {
      signal: AbortSignal.timeout(5000),
    });
    // Then
    expect(response.status).toBe(200);
    expect(compiledProfileSchema.parse(await response.json())).toEqual(expected);
  } finally {
    await server.stop(true);
  }
});

test("does not discover local sources when the origin guard rejects a request", async () => {
  // Given
  const { api, path, xml } = await setup();
  await writeFile(path, `<!DOCTYPE robot>${xml}`);
  await api(new Request(endpoint, { headers: { origin: "https://outside.example" } }));
  await writeFile(path, xml);
  // When
  const response = await api(new Request(endpoint));
  // Then
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ profiles: [expect.objectContaining({ model: "RBY1_A" })], reasons: [] });
});
