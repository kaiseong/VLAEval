import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProfileCatalog } from "../../src/kinematics/catalog";
import { compileUrdfProfile } from "../../src/kinematics/urdf";

const directories: string[] = [];
const fixture = new URL("../fixtures/urdf/rby1a-v1.2.urdf", import.meta.url);
async function setup() {
  const directory = await mkdtemp(join(tmpdir(), "vlaeval-task13-catalog-"));
  directories.push(directory);
  const root = join(directory, "root");
  await mkdir(root);
  const xml = await readFile(fixture, "utf8");
  const path = join(root, "model.urdf");
  await writeFile(path, xml);
  return { directory, root, xml, path, catalog: new ProfileCatalog(JSON.stringify([root])) };
}
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

test("returns compiler output when a source declares exact model and revision", async () => {
  // Given
  const { catalog, xml, path } = await setup();
  const expected = compileUrdfProfile(xml, { sourcePath: path, model: "RBY1_A", revision: "v1.2" });
  // When
  const listing = await catalog.list();
  const profile = await catalog.get(listing.profiles[0]?.id ?? "");
  // Then
  expect(profile).toEqual(expected);
  expect(profile.urdfSha256).toBe(createHash("sha256").update(xml).digest("hex"));
  expect(listing.reasons).toEqual([]);
});

for (const value of ["null", "{}", '"relative"', '["relative"]', '["/tmp",3]', "{"]) {
  test(`returns an empty reasoned catalog when root configuration is invalid: ${value}`, async () => {
    // Given
    const catalog = new ProfileCatalog(value);
    // When
    const listing = await catalog.list();
    // Then
    expect(listing.profiles).toEqual([]);
    expect(listing.reasons[0]?.code).toBe("invalid_source");
  });
}

test("returns reasons when optional roots are absent or empty", async () => {
  // Given
  const { directory } = await setup();
  const root = join(directory, "empty");
  await mkdir(root);
  const catalog = new ProfileCatalog(JSON.stringify([join(directory, "absent"), root]));
  // When
  const listing = await catalog.list();
  // Then
  expect(listing.profiles).toEqual([]);
  expect(listing.reasons.map((reason) => reason.code)).toEqual(["ENOENT", "no_profiles"]);
});

test("returns an explicit reason when no roots are configured", async () => {
  // Given
  const catalog = new ProfileCatalog("[]");
  // When
  const listing = await catalog.list();
  // Then
  expect(listing).toMatchObject({ profiles: [], reasons: [{ code: "no_roots" }] });
});

for (const [label, transform, code] of [
  ["DTD", (xml: string) => `<!DOCTYPE robot SYSTEM "http://127.0.0.1:1/external">${xml}`, "unsafe_xml"],
  ["entity", (xml: string) => `<!ENTITY external SYSTEM "file:///etc/passwd">${xml}`, "unsafe_xml"],
  ["malformed XML", () => "<robot><link></robot>", "invalid_source"],
  ["arbitrary robot label", (xml: string) => xml.replace("RBY1_A_v1.2", "my-M-default"), "invalid_source"],
  ["missing chain", (xml: string) => xml.replace('name="ee_right"', 'name="missing_tip"'), "missing_node"],
  ["oversized XML", (xml: string) => `${xml}${" ".repeat(2 * 1024 * 1024)}`, "too_large"],
] as const) {
  test(`omits unsafe source when it contains ${label}`, async () => {
    // Given
    const { root, path, xml } = await setup();
    await writeFile(path, transform(xml));
    const catalog = new ProfileCatalog(JSON.stringify([root]));
    // When
    const listing = await catalog.list();
    // Then
    expect(listing.profiles).toEqual([]);
    expect(listing.reasons[0]?.code).toBe(code);
  });
}

test("rejects a prefix sibling symlink when it escapes the root", async () => {
  // Given
  const { root, xml, path } = await setup();
  const outside = `${root}-outside`;
  await mkdir(outside);
  await writeFile(join(outside, "model.urdf"), xml);
  await rm(path);
  await symlink(join(outside, "model.urdf"), path);
  // When
  const listing = await new ProfileCatalog(JSON.stringify([root])).list();
  // Then
  expect(listing).toMatchObject({ profiles: [], reasons: [{ code: "outside_root" }] });
});

test("deduplicates profiles when an in-root alias resolves to the same file", async () => {
  // Given
  const { catalog, path, root } = await setup();
  await symlink(path, join(root, "alias.urdf"));
  // When
  const listing = await catalog.list();
  // Then
  expect(listing.profiles).toHaveLength(1);
  expect(listing.profiles[0]?.sourcePath).toBe(path);
});

test("rejects stale profile identity when source bytes change", async () => {
  // Given
  const { catalog, path, xml } = await setup();
  const id = (await catalog.list()).profiles[0]?.id ?? "";
  await writeFile(path, `${xml}\n`);
  // When
  const result = catalog.get(id);
  // Then
  await expect(result).rejects.toMatchObject({ code: "changed_digest", status: 409 });
});

test("omits stale entries when the catalog is listed again", async () => {
  // Given
  const { catalog, path, xml } = await setup();
  await catalog.list();
  await writeFile(path, `${xml}\n`);
  // When
  const listing = await catalog.list();
  // Then
  expect(listing).toMatchObject({ profiles: [], reasons: [{ code: "changed_digest" }] });
});

test("rejects replacement symlink when an already catalogued file escapes", async () => {
  // Given
  const { catalog, path, directory, xml } = await setup();
  const id = (await catalog.list()).profiles[0]?.id ?? "";
  const outside = join(directory, "outside.urdf");
  await writeFile(outside, xml);
  await rm(path);
  await symlink(outside, path);
  // When
  const result = catalog.get(id);
  // Then
  await expect(result).rejects.toMatchObject({ code: "outside_root" });
});

test("rejects replaced root when its realpath no longer matches", async () => {
  // Given
  const { catalog, root, directory } = await setup();
  const id = (await catalog.list()).profiles[0]?.id ?? "";
  await rename(root, join(directory, "moved"));
  await symlink(join(directory, "moved"), root);
  // When
  const result = catalog.get(id);
  // Then
  await expect(result).rejects.toMatchObject({ code: "outside_root" });
});

test("rejects a non-file source when a directory has an URDF suffix", async () => {
  // Given
  const { root, path } = await setup();
  await rm(path);
  await mkdir(path);
  // When
  const listing = await new ProfileCatalog(JSON.stringify([root])).list();
  // Then
  expect(listing).toMatchObject({ profiles: [], reasons: [{ code: "invalid_source" }] });
});

test("rejects unknown identity without treating it as a source path", async () => {
  // Given
  const { catalog, path } = await setup();
  // When
  const result = catalog.get(path);
  // Then
  await expect(result).rejects.toMatchObject({ code: "not_found", status: 404 });
});

test("accepts exact byte limit when valid XML is exactly two MiB", async () => {
  // Given
  const { root, path, xml } = await setup();
  const paddingBytes = 2 * 1024 * 1024 - Buffer.byteLength(xml);
  const boundedXml = `${xml}${" ".repeat(paddingBytes)}`;
  await writeFile(path, boundedXml);
  // When
  const listing = await new ProfileCatalog(JSON.stringify([root])).list();
  // Then
  expect(listing.profiles).toHaveLength(1);
  expect(listing.profiles[0]?.urdfSha256).toBe(createHash("sha256").update(boundedXml).digest("hex"));
});

test("rejects lossy decoding when input bytes are not UTF-8", async () => {
  // Given
  const { root, path, xml } = await setup();
  await writeFile(path, Buffer.concat([Buffer.from(xml), Buffer.from([0xff])]));
  // When
  const listing = await new ProfileCatalog(JSON.stringify([root])).list();
  // Then
  expect(listing).toMatchObject({ profiles: [], reasons: [{ code: "invalid_source" }] });
});
