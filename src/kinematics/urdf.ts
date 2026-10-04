import { createHash } from "node:crypto";
import {
  compiledProfileSchema,
  fkContractVersion,
  type CompiledProfile,
} from "./contracts";

export type UrdfCompileErrorCode =
  | "unsafe_xml" | "invalid_xml" | "invalid_document"
  | "duplicate_link" | "duplicate_joint" | "missing_node"
  | "cycle" | "mimic_joint" | "unsupported_joint"
  | "invalid_number" | "invalid_axis" | "invalid_chain";

export class UrdfCompileError extends Error {
  constructor(readonly code: UrdfCompileErrorCode, message: string) {
    super(message);
    this.name = "UrdfCompileError";
  }
}

export type UrdfProfileMetadata = Readonly<{
  sourcePath: string;
  model: string;
  revision: string;
}>;

type XmlElement = {
  readonly name: string;
  readonly attributes: Readonly<Record<string, unknown>>;
  readonly children: readonly unknown[];
};

type Vector3 = [number, number, number];
type CompiledJoint = CompiledProfile["rightChain"][number];

type SourceJoint = {
  readonly name: string; readonly type: string;
  readonly parentLink: string; readonly childLink: string;
  readonly origin: { readonly xyz: Vector3; readonly rpy: Vector3 };
  readonly axis: Vector3 | null; readonly mimic: boolean;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isXmlElement(value: unknown): value is XmlElement {
  return isRecord(value) && typeof value.name === "string" &&
    isRecord(value.attributes) && Array.isArray(value.children);
}

function childElements(parent: XmlElement, name: string): XmlElement[] {
  return parent.children.filter(isXmlElement).filter((child) => child.name === name);
}

function requiredAttribute(element: XmlElement, name: string, context: string): string {
  const value = element.attributes[name];
  if (typeof value !== "string" || value.length === 0) {
    throw new UrdfCompileError("invalid_document", `${context} is missing its ${name} attribute`);
  }
  return value;
}

function singleChild(parent: XmlElement, name: string, context: string): XmlElement {
  const matches = childElements(parent, name);
  if (matches.length !== 1 || matches[0] === undefined) {
    throw new UrdfCompileError("invalid_document", `${context} must contain exactly one ${name} element`);
  }
  return matches[0];
}

function parseVector(element: XmlElement, attribute: string, context: string): Vector3 {
  const values = requiredAttribute(element, attribute, context).trim().split(/\s+/).map(Number);
  const [x, y, z] = values;
  if (values.length !== 3 || x === undefined || y === undefined || z === undefined ||
      ![x, y, z].every(Number.isFinite)) {
    throw new UrdfCompileError("invalid_number", `${context} ${attribute} must contain three finite numbers`);
  }
  return [x, y, z];
}

function normalizeAxis(axis: Vector3, jointName: string): Vector3 {
  const magnitude = Math.hypot(...axis);
  if (!Number.isFinite(magnitude) || magnitude === 0) {
    throw new UrdfCompileError("invalid_axis", `Revolute joint ${jointName} has a zero or nonfinite axis`);
  }
  return [axis[0] / magnitude, axis[1] / magnitude, axis[2] / magnitude];
}

function parseJoint(element: XmlElement): SourceJoint {
  const name = requiredAttribute(element, "name", "Joint");
  const context = `Joint ${name}`;
  const type = requiredAttribute(element, "type", context);
  const parent = singleChild(element, "parent", context);
  const child = singleChild(element, "child", context);
  const origin = singleChild(element, "origin", context);
  const axisElement = childElements(element, "axis")[0];
  return {
    name,
    type,
    parentLink: requiredAttribute(parent, "link", `${context} parent`),
    childLink: requiredAttribute(child, "link", `${context} child`),
    origin: {
      xyz: parseVector(origin, "xyz", `${context} origin`),
      rpy: parseVector(origin, "rpy", `${context} origin`),
    },
    axis: axisElement === undefined ? null : parseVector(axisElement, "xyz", `${context} axis`),
    mimic: childElements(element, "mimic").length > 0,
  };
}

function assertAcyclic(links: ReadonlySet<string>, joints: readonly SourceJoint[]): void {
  const outgoing = new Map<string, SourceJoint[]>();
  for (const joint of joints) {
    const edges = outgoing.get(joint.parentLink) ?? [];
    edges.push(joint);
    outgoing.set(joint.parentLink, edges);
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (link: string): void => {
    if (visiting.has(link)) throw new UrdfCompileError("cycle", `URDF joint graph contains a cycle at link ${link}`);
    if (visited.has(link)) return;
    visiting.add(link);
    for (const joint of outgoing.get(link) ?? []) visit(joint.childLink);
    visiting.delete(link);
    visited.add(link);
  };
  for (const link of links) visit(link);
}

function chainToTip(
  rootLink: string,
  tipLink: string,
  joints: readonly SourceJoint[],
): SourceJoint[] {
  const incoming = new Map<string, SourceJoint>();
  for (const joint of joints) {
    if (incoming.has(joint.childLink)) {
      throw new UrdfCompileError("duplicate_link", `More than one joint creates link ${joint.childLink}`);
    }
    incoming.set(joint.childLink, joint);
  }

  const reversed: SourceJoint[] = [];
  const visited = new Set<string>([tipLink]);
  let current = tipLink;
  while (current !== rootLink) {
    const joint = incoming.get(current);
    if (joint === undefined) throw new UrdfCompileError("missing_node", `No joint path connects ${rootLink} to ${tipLink}`);
    reversed.push(joint);
    current = joint.parentLink;
    if (visited.has(current)) throw new UrdfCompileError("cycle", `URDF chain to ${tipLink} cycles at link ${current}`);
    visited.add(current);
  }
  return reversed.reverse();
}

function compileArmChain(
  side: "right" | "left",
  joints: readonly SourceJoint[],
): CompiledProfile["rightChain"] {
  const tip = `ee_${side}`;
  const chain = chainToTip("link_torso_5", tip, joints);
  const expectedNames = Array.from({ length: 7 }, (_, index) => `${side}_arm_${index}`);
  const revolutes = chain.filter((joint) => joint.type === "revolute");
  const tool = chain.at(-1);

  for (const joint of chain) {
    if (joint.mimic) {
      throw new UrdfCompileError("mimic_joint", `Chain joint ${joint.name} uses a mimic declaration`);
    }
    if (joint.type !== "fixed" && joint.type !== "revolute") {
      throw new UrdfCompileError("unsupported_joint", `Chain joint ${joint.name} has unsupported type ${joint.type}`);
    }
  }

  if (revolutes.length !== 7 ||
      expectedNames.some((name, index) => revolutes[index]?.name !== name) ||
      tool?.name !== `tool_${side}` ||
      tool.type !== "fixed" ||
      tool.parentLink !== `link_${side}_arm_6` ||
      tool.childLink !== tip) {
    throw new UrdfCompileError(
      "invalid_chain",
      `${side} chain must contain seven ordered arm revolutes and terminal tool_${side} to ${tip}`,
    );
  }

  return chain.map((joint): CompiledJoint => {
    const common = {
      name: joint.name,
      parentLink: joint.parentLink,
      childLink: joint.childLink,
      origin: joint.origin,
    };
    if (joint.type === "fixed") return { ...common, type: "fixed" };
    if (joint.axis === null) {
      throw new UrdfCompileError("invalid_axis", `Revolute joint ${joint.name} is missing its axis`);
    }
    return { ...common, type: "revolute", axis: normalizeAxis(joint.axis, joint.name) };
  });
}

export function compileUrdfProfile(xml: string, metadata: UrdfProfileMetadata): CompiledProfile {
  for (const [name, value] of Object.entries(metadata)) {
    if (value.trim().length === 0) {
      throw new UrdfCompileError("invalid_document", `Profile metadata ${name} must not be empty`);
    }
  }
  if (/<!\s*(?:DOCTYPE|ENTITY)\b/i.test(xml)) {
    throw new UrdfCompileError("unsafe_xml", "DTD and entity declarations are not allowed in URDF input");
  }

  let parsed: unknown;
  try {
    parsed = Bun.XML.parse(xml, { compact: false });
  } catch (error) {
    if (error instanceof Error) {
      throw new UrdfCompileError("invalid_xml", `URDF XML is not well formed: ${error.message}`);
    }
    throw error;
  }
  if (!isXmlElement(parsed) || parsed.name !== "robot") {
    throw new UrdfCompileError("invalid_document", "URDF document root must be a robot element");
  }

  const links = new Set<string>();
  for (const element of childElements(parsed, "link")) {
    const name = requiredAttribute(element, "name", "Link");
    if (links.has(name)) throw new UrdfCompileError("duplicate_link", `Duplicate URDF link ${name}`);
    links.add(name);
  }
  for (const required of ["link_torso_5", "ee_right", "ee_left"]) {
    if (!links.has(required)) throw new UrdfCompileError("missing_node", `URDF is missing required link ${required}`);
  }

  const joints: SourceJoint[] = [];
  const jointNames = new Set<string>();
  for (const element of childElements(parsed, "joint")) {
    const joint = parseJoint(element);
    if (jointNames.has(joint.name)) {
      throw new UrdfCompileError("duplicate_joint", `Duplicate URDF joint ${joint.name}`);
    }
    jointNames.add(joint.name);
    if (!links.has(joint.parentLink) || !links.has(joint.childLink)) {
      const missing = !links.has(joint.parentLink) ? joint.parentLink : joint.childLink;
      throw new UrdfCompileError("missing_node", `Joint ${joint.name} references missing link ${missing}`);
    }
    if (joint.type === "revolute" && joint.axis === null) {
      throw new UrdfCompileError("invalid_axis", `Revolute joint ${joint.name} is missing its axis`);
    }
    if (joint.type === "revolute" && joint.axis !== null) normalizeAxis(joint.axis, joint.name);
    joints.push(joint);
  }
  assertAcyclic(links, joints);

  const rootLink = "link_torso_5";
  const tips = { right: "ee_right", left: "ee_left" } as const;
  const rightChain = compileArmChain("right", joints);
  const leftChain = compileArmChain("left", joints);
  const urdfSha256 = createHash("sha256").update(xml).digest("hex");
  const profileContent = {
    schemaVersion: fkContractVersion,
    sourcePath: metadata.sourcePath,
    model: metadata.model,
    revision: metadata.revision,
    urdfSha256,
    rootLink,
    tips,
    rightChain,
    leftChain,
  };
  const profileHash = createHash("sha256").update(JSON.stringify(profileContent)).digest("hex");
  return compiledProfileSchema.parse({ ...profileContent, profileHash });
}
