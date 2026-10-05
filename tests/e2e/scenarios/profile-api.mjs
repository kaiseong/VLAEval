import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApi } from "../../../src/api.ts";
import { JobStore } from "../../../src/jobs.ts";
import { ProfileCatalog } from "../../../src/kinematics/catalog.ts";
import { compiledProfileSchema } from "../../../src/kinematics/contracts.ts";
import { compileUrdfProfile } from "../../../src/kinematics/urdf.ts";

export async function runScenario({ args, outputPath, startHarness }) {
  if (args.fixture !== "profile-root") throw new Error("profile-api requires profile-root");
  // The API has no pixel surface; use the actual createApi server, not fixture HTTP interception.
  void startHarness;
  const assertions = [];
  const actions = [];
  const servers = [];
  const directory = await mkdtemp(join(tmpdir(), "vlaeval-task13-http-"));
  const previousRoots = process.env.VLAEVAL_URDF_ROOTS;
  const cleanup = { browserOpen: false, serverOpen: true, tempStoreExists: true, cleanupErrors: [] };
  const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
  function assert(name, passed, detail) {
    assertions.push({ name, passed, detail });
    if (!passed) throw new Error(`Assertion failed: ${name}: ${JSON.stringify(detail)}`);
  }
  function serve(api) {
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: api });
    servers.push(server);
    actions.push({ action: "actual-createApi-server-start", url: server.url.href });
    return server;
  }
  async function request(server, path, options = {}) {
    const response = await fetch(new URL(path, server.url), {
      ...options, signal: AbortSignal.timeout(5000),
    });
    const body = await response.text();
    actions.push({
      action: "http-response", method: options.method ?? "GET", url: new URL(path, server.url).href,
      status: response.status, headers: Object.fromEntries(response.headers), body, bodySha256: hash(body),
    });
    return { status: response.status, body: JSON.parse(body) };
  }
  try {
    const root = join(directory, "root");
    await mkdir(root);
    const xml = await readFile(new URL("../../fixtures/urdf/rby1a-v1.2.urdf", import.meta.url), "utf8");
    const path = join(root, "model.urdf");
    await writeFile(path, xml);
    const store = new JobStore(join(directory, "runs"));
    await store.initialize();
    process.env.VLAEVAL_URDF_ROOTS = JSON.stringify([root]);
    const server = serve(createApi(store));
    const listing = await request(server, "/api/kinematics/profiles?path=/etc/passwd");
    assert("configured-root-list-200", listing.status === 200 && listing.body.profiles.length === 1, listing);
    const id = listing.body.profiles[0].id;
    const known = await request(server, `/api/kinematics/profiles/${id}`);
    const profile = compiledProfileSchema.parse(known.body);
    const expected = compileUrdfProfile(xml, { sourcePath: path, model: "RBY1_A", revision: "v1.2" });
    assert("known-profile-exact-compiler-output", known.status === 200 &&
      JSON.stringify(profile) === JSON.stringify(expected), profile);
    assert("known-profile-source-digest", profile.urdfSha256 === hash(xml), profile.urdfSha256);
    for (const unknown of ["unknown", "0".repeat(64), "%2Fetc%2Fpasswd", "..%2Foutside.urdf"]) {
      const response = await request(server, `/api/kinematics/profiles/${unknown}`);
      assert(`unknown-or-pathlike-404-${unknown}`, response.status === 404, response);
    }
    for (const headers of [{ origin: "https://outside.example" }, { "sec-fetch-site": "cross-site" }]) {
      const response = await request(server, "/api/kinematics/profiles", { headers });
      assert(`cross-origin-403-${JSON.stringify(headers)}`, response.status === 403, response);
    }
    const local = await request(server, `/api/kinematics/profiles/${id}`, { headers: { origin: server.url.origin } });
    assert("same-origin-detail-200", local.status === 200, local.status);
    for (const method of ["POST", "PUT", "DELETE"]) {
      const response = await request(server, "/api/kinematics/profiles", {
        method, body: JSON.stringify({ path: "/etc/passwd", xml }),
      });
      assert(`read-only-${method}-404`, response.status === 404, response);
    }
    assert("upload-no-file-side-effect", hash(await readFile(path)) === hash(xml), path);
    await writeFile(path, `${xml}\n`);
    const stale = await request(server, `/api/kinematics/profiles/${id}`);
    assert("stale-state-digest-change-409", stale.status === 409, stale);
    const changedList = await request(server, "/api/kinematics/profiles");
    assert("stale-state-removed-from-list", changedList.body.profiles.length === 0 &&
      changedList.body.reasons.some((reason) => reason.code === "changed_digest"), changedList);
    await writeFile(path, xml);
    const outside = join(directory, "outside.urdf");
    await writeFile(outside, xml);
    await rm(path);
    await symlink(outside, path);
    const escaped = await request(server, `/api/kinematics/profiles/${id}`);
    assert("catalogued-symlink-escape-409", escaped.status === 409, escaped);
    const absentServer = serve(createApi(store, new ProfileCatalog(JSON.stringify([join(directory, "absent")]))));
    const absent = await request(absentServer, "/api/kinematics/profiles");
    assert("missing-optional-root-reason", absent.status === 200 && absent.body.profiles.length === 0 &&
      absent.body.reasons[0].code === "ENOENT", absent);
    const jobs = await request(absentServer, "/api/jobs");
    assert("raw-history-remains-available", jobs.status === 200 && Array.isArray(jobs.body), jobs);
    const invalidConfig = serve(createApi(store, new ProfileCatalog('["relative"]')));
    const invalidRoots = await request(invalidConfig, "/api/kinematics/profiles");
    assert("invalid-roots-not-startup-failure", invalidRoots.status === 200 &&
      invalidRoots.body.profiles.length === 0 && invalidRoots.body.reasons[0].code === "invalid_source", invalidRoots);

    let externalHits = 0;
    const sentinel = Bun.serve({
      hostname: "127.0.0.1", port: 0,
      fetch() { externalHits += 1; return new Response("unexpected XML fetch"); },
    });
    servers.push(sentinel);
    const badRoot = join(directory, "bad-root");
    await mkdir(badRoot);
    await writeFile(join(badRoot, "dtd.urdf"), `<!DOCTYPE robot SYSTEM "${sentinel.url.href}external">${xml}`);
    await writeFile(join(badRoot, "entity.urdf"), `<!ENTITY external SYSTEM "file://${outside}">${xml}`);
    await writeFile(join(badRoot, "invalid.urdf"), "<robot><link></robot>");
    await writeFile(join(badRoot, "large.urdf"), `${xml}${" ".repeat(2 * 1024 * 1024)}`);
    await writeFile(join(badRoot, "label.urdf"), xml.replace("RBY1_A_v1.2", "arbitrary-M"));
    await symlink(outside, join(badRoot, "escape.urdf"));
    const badServer = serve(createApi(store, new ProfileCatalog(JSON.stringify([badRoot]))));
    const rejected = await request(badServer, "/api/kinematics/profiles");
    const codes = Object.fromEntries(rejected.body.reasons.map((reason) => [reason.sourcePath.split("/").at(-1), reason.code]));
    assert("adversarial-inputs-not-offered", rejected.status === 200 && rejected.body.profiles.length === 0, rejected);
    for (const [name, code] of [
      ["dtd.urdf", "unsafe_xml"], ["entity.urdf", "unsafe_xml"], ["invalid.urdf", "invalid_source"],
      ["large.urdf", "too_large"], ["label.urdf", "invalid_source"], ["escape.urdf", "outside_root"],
    ]) assert(`rejected-${name}`, codes[name] === code, codes);
    assert("no-external-XML-network-effects", externalHits === 0, externalHits);
    assert("external-file-remains-unchanged", hash(await readFile(outside)) === hash(xml), outside);

    delete process.env.VLAEVAL_URDF_ROOTS;
    const defaultServer = serve(createApi(store));
    const defaults = await request(defaultServer, "/api/kinematics/profiles");
    const actualModels = new Set();
    for (const metadata of defaults.body.profiles) {
      const detail = await request(defaultServer, `/api/kinematics/profiles/${metadata.id}`);
      const actual = compiledProfileSchema.parse(detail.body);
      const sourceBytes = await readFile(actual.sourcePath);
      assert(`actual-default-source-${metadata.id}`, detail.status === 200 &&
        actual.urdfSha256 === hash(sourceBytes) && actual.profileHash === metadata.id, actual);
      actualModels.add(actual.model);
    }
    assert("actual-A-and-M-default-models", actualModels.has("RBY1_A") && actualModels.has("RBY1_M"), [...actualModels]);
  } finally {
    if (previousRoots === undefined) delete process.env.VLAEVAL_URDF_ROOTS;
    else process.env.VLAEVAL_URDF_ROOTS = previousRoots;
    await Promise.all(servers.map((server) => server.stop(true)));
    cleanup.serverOpen = false;
    await rm(directory, { recursive: true, force: true });
    cleanup.tempStoreExists = false;
    actions.push({ action: "task-owned-resource-cleanup", servers: servers.length, directory, ...cleanup });
    await writeFile(join(outputPath, "profile-cleanup.json"), `${JSON.stringify(cleanup, null, 2)}\n`);
    await writeFile(join(outputPath, "profile-http.json"), `${JSON.stringify(actions, null, 2)}\n`);
    await writeFile(join(outputPath, "profile-assertions.json"), `${JSON.stringify(assertions, null, 2)}\n`);
  }
  assertions.push({ name: "owned-resources-closed", passed: !cleanup.serverOpen && !cleanup.tempStoreExists, detail: cleanup });
  return { assertions, actions };
}
