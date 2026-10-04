import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";
import { compiledProfileSchema } from "../../src/kinematics/contracts";
import {
  compileUrdfProfile,
  UrdfCompileError,
  type UrdfCompileErrorCode,
} from "../../src/kinematics/urdf";

const fixturePath = (model: "a" | "m") =>
  new URL(`../fixtures/urdf/rby1${model}-v1.2.urdf`, import.meta.url);

function fixtureXml(model: "a" | "m" = "a"): string {
  return readFileSync(fixturePath(model), "utf8");
}

function compile(xml: string, model: "a" | "m" = "a") {
  return compileUrdfProfile(xml, {
    sourcePath: `tests/fixtures/urdf/rby1${model}-v1.2.urdf`,
    model: `RBY1${model.toUpperCase()}`,
    revision: "v1.2",
  });
}

function expectCompileError(xml: string, code: UrdfCompileErrorCode): void {
  let caught: unknown;
  try {
    compile(xml);
  } catch (error) {
    caught = error;
  }
  if (!(caught instanceof UrdfCompileError)) {
    throw new Error(`Expected UrdfCompileError(${code}), got ${String(caught)}`);
  }
  expect(caught.code).toBe(code);
}

describe("local URDF profile compiler", () => {
  test("compiles both model fixtures to exact named seven-joint chains", () => {
    const profiles = [compile(fixtureXml("a"), "a"), compile(fixtureXml("m"), "m")];
    const sides = ["right", "left"] as const;

    for (const profile of profiles) {
      expect(compiledProfileSchema.parse(profile)).toEqual(profile);
      expect(profile.schemaVersion).toBe(1);
      expect(profile.rootLink).toBe("link_torso_5");
      expect(profile.tips).toEqual({ right: "ee_right", left: "ee_left" });
      for (const side of sides) {
        const chain = profile[`${side}Chain`];
        expect(chain.filter((joint) => joint.type === "revolute").map((joint) => joint.name))
          .toEqual(Array.from({ length: 7 }, (_, index) => `${side}_arm_${index}`));
        expect(chain.at(-1)).toMatchObject({
          name: `tool_${side}`,
          type: "fixed",
          parentLink: `link_${side}_arm_6`,
          childLink: `ee_${side}`,
        });
      }
    }
    expect(profiles[0]?.model).toBe("RBY1A");
    expect(profiles[1]?.model).toBe("RBY1M");
  });

  test("preserves tool offsets and hashes exact fixture bytes", () => {
    const xml = fixtureXml("m");
    const profile = compile(xml, "m");
    const rightTool = profile.rightChain.at(-1);
    const leftTool = profile.leftChain.at(-1);

    expect(rightTool?.origin).toEqual({ xyz: [0, 0, -0.1261], rpy: [0, 0, 0] });
    expect(leftTool?.origin).toEqual({ xyz: [0, 0, -0.1261], rpy: [0, 0, 0] });
    expect(profile.urdfSha256).toBe(createHash("sha256").update(xml).digest("hex"));
    expect(compile(xml, "m").profileHash).toBe(profile.profileHash);
    expect(compile(xml, "a").profileHash).not.toBe(profile.profileHash);
  });

  test("preserves nonzero origin RPY and normalizes source axes", () => {
    const xml = fixtureXml().replace(
      '<origin xyz="0 0 0" rpy="0 0 0" /><axis xyz="1 0 0" />',
      '<origin xyz="0 0 0" rpy="0.1 0.2 0.3" /><axis xyz="1 0 0" />',
    );
    const profile = compile(xml);
    const rightArm1 = profile.rightChain[1];
    const rightArm0 = profile.rightChain[0];

    expect(rightArm1?.origin.rpy).toEqual([0.1, 0.2, 0.3]);
    if (rightArm0?.type !== "revolute") throw new Error("Fixture shoulder must be revolute");
    expect(Math.hypot(...rightArm0.axis)).toBeCloseTo(1, 14);
    const axisLength = Math.hypot(0.93969262, -0.34202014);
    expect(rightArm0.axis[0]).toBe(0);
    expect(rightArm0.axis[1]).toBeCloseTo(0.93969262 / axisLength, 14);
    expect(rightArm0.axis[2]).toBeCloseTo(-0.34202014 / axisLength, 14);
  });

  test("rejects DTD declarations before XML parsing", () => {
    expectCompileError(`<!DOCTYPE robot>${fixtureXml()}`, "unsafe_xml");
  });

  test("rejects entity declarations before XML parsing", () => {
    expectCompileError(`<!ENTITY model "RBY1">${fixtureXml()}`, "unsafe_xml");
  });

  test("rejects a missing terminal tool joint", () => {
    const xml = fixtureXml().replace(
      '<joint name="tool_right" type="fixed"><parent link="link_right_arm_6" /><child link="ee_right" /><origin xyz="0 0 -0.1261" rpy="0 0 0" /><axis xyz="0 0 1" /></joint>',
      "",
    );
    expectCompileError(xml, "missing_node");
  });

  test("rejects mimic declarations on the selected arm chain", () => {
    const xml = fixtureXml().replace(
      '<joint name="right_arm_1" type="revolute">',
      '<joint name="right_arm_1" type="revolute"><mimic joint="right_arm_0" />',
    );
    expectCompileError(xml, "mimic_joint");
  });

  test("rejects cycles before duplicate-parent topology", () => {
    const xml = fixtureXml().replace(
      '<joint name="right_arm_1" type="revolute"><parent link="link_right_arm_0" /><child link="link_right_arm_1" />',
      '<joint name="right_arm_1" type="revolute"><parent link="link_right_arm_0" /><child link="link_right_arm_0" />',
    );
    expectCompileError(xml, "cycle");
  });

  test("rejects duplicate joint names", () => {
    const xml = fixtureXml().replace('name="right_arm_1"', 'name="right_arm_0"');
    expectCompileError(xml, "duplicate_joint");
  });

  test("rejects duplicate link names", () => {
    const xml = fixtureXml().replace(
      '<link name="link_torso_5" />',
      '<link name="link_torso_5" /><link name="link_torso_5" />',
    );
    expectCompileError(xml, "duplicate_link");
  });

  test("rejects unsupported moving joints on a selected chain", () => {
    const xml = fixtureXml().replace(
      '<joint name="right_arm_2" type="revolute">',
      '<joint name="right_arm_2" type="continuous">',
    );
    expectCompileError(xml, "unsupported_joint");
  });

  test("rejects a zero revolute axis", () => {
    const xml = fixtureXml().replace(
      '<axis xyz="0 0.93969262 -0.34202014" />',
      '<axis xyz="0 0 0" />',
    );
    expectCompileError(xml, "invalid_axis");
  });

  test("rejects nonfinite origin values", () => {
    const xml = fixtureXml().replace(
      '<origin xyz="0 -0.220 0.080073451539" rpy="0 0 0" />',
      '<origin xyz="NaN -0.220 0.080073451539" rpy="0 0 0" />',
    );
    expectCompileError(xml, "invalid_number");
  });

  test("rejects joints that reference missing links", () => {
    const xml = fixtureXml().replace(
      '<parent link="link_right_arm_0" />',
      '<parent link="missing_parent" />',
    );
    expectCompileError(xml, "missing_node");
  });

  test("retains a fixed transform inserted between revolute joints", () => {
    const xml = fixtureXml()
      .replace('<link name="link_right_arm_1" />', '<link name="link_right_arm_1" /><link name="right_arm_mount" />')
      .replace(
        '<joint name="right_arm_2" type="revolute"><parent link="link_right_arm_1" />',
        '<joint name="right_arm_mount_fixed" type="fixed"><parent link="link_right_arm_1" /><child link="right_arm_mount" /><origin xyz="0.01 0.02 0.03" rpy="0.1 0 0" /></joint>\n  <joint name="right_arm_2" type="revolute"><parent link="right_arm_mount" />',
      );
    const profile = compile(xml);
    const fixedJoint = profile.rightChain.find((joint) => joint.name === "right_arm_mount_fixed");

    expect(fixedJoint).toEqual({
      name: "right_arm_mount_fixed",
      type: "fixed",
      parentLink: "link_right_arm_1",
      childLink: "right_arm_mount",
      origin: { xyz: [0.01, 0.02, 0.03], rpy: [0.1, 0, 0] },
    });
    expect(profile.rightChain.map((joint) => joint.name)).toContain("right_arm_mount_fixed");
  });
});
