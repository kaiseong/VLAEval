import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";
import { cameraFromReference } from "../../src/kinematics/camera-pose";
import { KinematicsError } from "../../src/kinematics/math";
import { compileMountChain, compileUrdfProfile, UrdfCompileError } from "../../src/kinematics/urdf";

const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] as const;
// Deliberately not in graph order, and with no arm links or naming assumptions.
const source = `<robot name="camera">
  <link name="reference"/><link name="neck"/><link name="head"/><link name="mount"/>
  <joint name="mount_fixed" type="fixed">
    <parent link="head"/><child link="mount"/><origin xyz="0 1 0" rpy="0 0 0"/>
  </joint>
  <joint name="head_0" type="revolute">
    <parent link="neck"/><child link="head"/><origin xyz="2 0 0" rpy="0 0 0"/>
    <axis xyz="2 0 0"/><limit lower="-2" upper="2"/>
  </joint>
  <joint name="neck_fixed" type="fixed">
    <parent link="reference"/><child link="neck"/><origin xyz="1 2 3" rpy="0 0 ${Math.PI / 2}"/>
  </joint>
</robot>`;

describe("source-bound camera pose", () => {
  test("orders mixed joints and preserves origins, normalized axes and limits", () => {
    // Given / When
    const chain = compileMountChain(source, "reference", "mount");
    // Then
    expect(chain.map((joint) => [joint.name, joint.type])).toEqual([
      ["neck_fixed", "fixed"], ["head_0", "revolute"], ["mount_fixed", "fixed"],
    ]);
    expect(chain[0]?.origin).toEqual({ xyz: [1, 2, 3], rpy: [0, 0, Math.PI / 2] });
    expect(chain[1]).toMatchObject({ axis: [1, 0, 0], limit: { lower: -2, upper: 2 } });
    expect(chain[2]).not.toHaveProperty("axis");
  });

  test("inverts noncommuting source, joint and optical rotations with translation", () => {
    // Given: Rz(pi/2) Rx(pi/2) Ry(pi/2), with translations in each local frame.
    const chain = compileMountChain(source, "reference", "mount");
    const mountFromOptical = [0, 0, 1, 0, 0, 1, 0, 0, -1, 0, 0, 2, 0, 0, 0, 1];
    // When
    const actual = cameraFromReference(chain, new Map([["head_0", Math.PI / 2]]), mountFromOptical);
    // Then: referenceFromOptical has t=[3,4,4] and R=[-1,0,0;0,0,1;0,1,0].
    const expected = [-1, 0, 0, 3, 0, 0, 1, -4, 0, 1, 0, -4, 0, 0, 0, 1];
    for (const [index, value] of expected.entries()) expect(actual[index]).toBeCloseTo(value, 12);
  });

  test("rejects a missing head position instead of assuming zero", () => {
    // Given
    const chain = compileMountChain(source, "reference", "mount");
    // When / Then
    expect(() => cameraFromReference(chain, new Map(), identity))
      .toThrow(new KinematicsError("missing_joint"));
  });

  test.each([NaN, Infinity, -Infinity])("rejects nonfinite head position %s", (position) => {
    // Given
    const chain = compileMountChain(source, "reference", "mount");
    // When / Then
    expect(() => cameraFromReference(chain, new Map([["head_0", position]]), identity))
      .toThrow(new KinematicsError("nonfinite"));
  });

  test("evaluates a fixed-only chain without positions", () => {
    // Given
    const chain = compileMountChain(source, "head", "mount");
    // When
    const actual = cameraFromReference(chain, new Map(), identity);
    // Then
    expect(Array.from(actual)).toEqual([1, 0, 0, 0, 0, 1, 0, -1, 0, 0, 1, 0, 0, 0, 0, 1]);
  });

  test("allows an existing reference link to be its own mount", () => {
    // Given
    const chain = compileMountChain(source, "mount", "mount");
    // When
    const actual = cameraFromReference(chain, new Map(), new Float64Array(identity));
    // Then
    expect(chain).toEqual([]);
    expect(Array.from(actual)).toEqual([...identity]);
  });

  const invalidSources = [
    { xml: `<!DOCTYPE robot>${source}`, code: "unsafe_xml" },
    { xml: `<!ENTITY x "camera">${source}`, code: "unsafe_xml" },
    { xml: "<robot><link></robot>", code: "invalid_xml" },
    { xml: "<scene/>", code: "invalid_document" },
    { xml: source.replace('type="revolute"', 'type="prismatic"'), code: "unsupported_joint" },
    { xml: source.replace('type="revolute"', 'type="continuous"'), code: "unsupported_joint" },
    { xml: source.replace('type="fixed"', 'type="floating"'), code: "unsupported_joint" },
    { xml: source.replace('<axis xyz="2 0 0"/>', '<mimic joint="other"/><axis xyz="2 0 0"/>'), code: "mimic_joint" },
    { xml: source.replace('<axis xyz="2 0 0"/>', ""), code: "invalid_axis" },
    { xml: source.replace('<axis xyz="2 0 0"/>', '<axis xyz="0 0 0"/>'), code: "invalid_axis" },
    { xml: source.replace('xyz="1 2 3"', 'xyz="NaN 2 3"'), code: "invalid_number" },
    { xml: source.replace('rpy="0 0 0"', 'rpy="0 Infinity 0"'), code: "invalid_number" },
    { xml: source.replace('<parent link="head"/>', '<parent link="mount"/>'), code: "cycle" },
    { xml: source.replace('<parent link="reference"/>', '<parent link="mount"/>'), code: "cycle" },
    { xml: source.replace('<link name="mount"/>', ""), code: "missing_node" },
    { xml: source.replace('<parent link="head"/>', '<parent link="absent"/>'), code: "missing_node" },
    { xml: source.replace('<link name="mount"/>', '<link name="mount"/><link name="mount"/>'), code: "duplicate_link" },
    { xml: source.replace('name="mount_fixed"', 'name="head_0"'), code: "duplicate_joint" },
    { xml: source.replace("</robot>", '<joint name="extra" type="fixed"><parent link="reference"/><child link="mount"/><origin xyz="0 0 0" rpy="0 0 0"/></joint></robot>'), code: "duplicate_link" },
  ] as const;
  test.each([...invalidSources])("rejects invalid source with $code", ({ xml, code }) => {
    // Given / When
    let caught: unknown;
    try { compileMountChain(xml, "reference", "mount"); } catch (error) { caught = error; }
    // Then
    expect(caught).toBeInstanceOf(UrdfCompileError);
    if (!(caught instanceof UrdfCompileError)) throw new Error("Expected a URDF compilation error");
    expect(caught.code).toBe(code);
  });

  test.each([["mount", "reference"], ["reference", "absent"], ["absent", "absent"]])(
    "rejects disconnected or missing endpoints %s -> %s", (root, mount) => {
      // Given / When / Then
      expect(() => compileMountChain(source, root, mount)).toThrow(UrdfCompileError);
    },
  );

  const invalidMounts = [
    identity.slice(0, 15),
    [...identity, 0],
    identity.map((value, index) => index === 0 ? 2 : value),
    identity.map((value, index) => index === 0 ? -1 : value),
    identity.map((value, index) => index === 1 ? 0.2 : value),
    identity.map((value, index) => index === 12 ? 0.1 : value),
    identity.map((value, index) => index === 15 ? 2 : value),
    identity.map((value, index) => index === 3 ? NaN : value),
    identity.map((value, index) => index === 7 ? Infinity : value),
  ];
  test.each(invalidMounts.map((matrix, index) => ({ matrix, index })))(
    "rejects nonrigid optical mount $index", ({ matrix }) => {
      // Given / When / Then
      expect(() => cameraFromReference([], new Map(), matrix)).toThrow(KinematicsError);
    },
  );

  const hashes = [
    {
      model: "a", profile: "dabcd31bd96486fc9faa164ed25d86395afa66e76c66adbb8cde1e865cc0ed03",
      source: "844ca86c121014b93bec600570a073aa00dff123380a6a234f3b3010e4fb0cec",
      output: "ea691928e564001252f3d80bf2952ee44e7ea7194bf34843f0d5c4cf91576133",
    },
    {
      model: "m", profile: "357b31dbad9e613ce2f906bb2be934b7b8b7793394ed632efbf546aa512d2597",
      source: "c726715120ad5335d472bfb5b83321ddbd15248c346270fbfc63534ad1f7373c",
      output: "ab36fd2d6f5e34fdb2a4987a6e423253d2249e2d8dd22f2364d6e1f6ec9947cf",
    },
  ] as const;
  test.each([...hashes])("preserves exact pre-change $model profile output and hashes", (baseline) => {
    // Given: digests captured from the existing compiler before the shared extraction.
    const path = `tests/fixtures/urdf/rby1${baseline.model}-v1.2.urdf`;
    const xml = readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
    // When
    const profile = compileUrdfProfile(xml, {
      sourcePath: path, model: `RBY1${baseline.model.toUpperCase()}`, revision: "v1.2",
    });
    // Then
    expect(profile.profileHash).toBe(baseline.profile);
    expect(profile.urdfSha256).toBe(baseline.source);
    expect(createHash("sha256").update(JSON.stringify(profile)).digest("hex")).toBe(baseline.output);
  });
});
