import { constants } from "node:fs";
import { open, readdir, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import { createHash } from "node:crypto";
import { z } from "zod";
import type { CompiledProfile } from "./contracts";
import { compileUrdfProfile, UrdfCompileError } from "./urdf";

const defaultRoots = [
  "/home/kgs/workspace/sdk-tools/rby1-pose-studio/assets/models/rby1a/urdf",
  "/home/kgs/workspace/sdk-tools/rby1-pose-studio/assets/models/rby1m/urdf",
] as const;
const maxXmlBytes = 2 * 1024 * 1024;
const rootsSchema = z.array(z.string().refine(isAbsolute, "URDF roots must be absolute directories"));
const robotIdentitySchema = z.object({
  name: z.literal("robot"),
  attributes: z.object({ name: z.string().regex(/^RBY1_[AM]_v\d+\.\d+(?:\.\d+)?$/) }),
});

export class ProfileCatalogError extends Error {
  readonly name = "ProfileCatalogError";
  constructor(readonly code: "not_found" | "outside_root" | "too_large" | "changed_digest" | "invalid_source") {
    super(`Local FK profile rejected: ${code}`);
  }
  get status(): number { return this.code === "not_found" ? 404 : 409; }
}

type Source = Readonly<{ root: string; path: string }>;
type Entry = Readonly<{ source: Source; profile: CompiledProfile }>;
type Reason = Readonly<{ sourcePath: string; code: string; message: string }>;
type Snapshot = Readonly<{ entries: readonly Entry[]; reasons: readonly Reason[] }>;

function confined(root: string, path: string): boolean {
  const local = relative(root, path);
  return local !== "" && local !== ".." && !local.startsWith(`..${sep}`) && !isAbsolute(local);
}

function reason(sourcePath: string, error: unknown): Reason {
  if (error instanceof ProfileCatalogError || error instanceof UrdfCompileError) {
    return { sourcePath, code: error.code, message: error.message };
  }
  if (error instanceof z.ZodError || error instanceof SyntaxError) {
    return { sourcePath, code: "invalid_source", message: error.message };
  }
  if (error instanceof Error && "code" in error && typeof error.code === "string") {
    return { sourcePath, code: error.code, message: error.message };
  }
  throw error;
}

async function readXml(source: Source): Promise<Readonly<{ xml: string; sourcePath: string }>> {
  const sourcePath = await realpath(source.path);
  if (!confined(source.root, sourcePath) || await realpath(source.root) !== source.root) {
    throw new ProfileCatalogError("outside_root");
  }
  const file = await open(sourcePath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    // This local Linux service checks the opened descriptor, not just a raceable pathname.
    if (!confined(source.root, await realpath(`/proc/self/fd/${file.fd}`))) {
      throw new ProfileCatalogError("outside_root");
    }
    const stat = await file.stat();
    if (!stat.isFile()) throw new ProfileCatalogError("invalid_source");
    if (stat.size > maxXmlBytes) throw new ProfileCatalogError("too_large");
    const buffer = Buffer.alloc(maxXmlBytes + 1);
    let bytes = 0;
    while (bytes < buffer.length) {
      const read = await file.read(buffer, bytes, buffer.length - bytes, bytes);
      if (read.bytesRead === 0) break;
      bytes += read.bytesRead;
    }
    if (bytes > maxXmlBytes) throw new ProfileCatalogError("too_large");
    const content = buffer.subarray(0, bytes);
    const xml = content.toString("utf8");
    if (!content.equals(Buffer.from(xml, "utf8"))) throw new ProfileCatalogError("invalid_source");
    return { xml, sourcePath };
  } finally {
    await file.close();
  }
}

function compile(xml: string, sourcePath: string): CompiledProfile {
  if (/<!\s*(?:DOCTYPE|ENTITY)\b/i.test(xml)) {
    throw new UrdfCompileError("unsafe_xml", "DTD and entities are not allowed");
  }
  const robot = robotIdentitySchema.parse(Bun.XML.parse(xml, { compact: false }));
  const [model, revision] = robot.attributes.name.split("_v");
  if (model === undefined || revision === undefined) throw new ProfileCatalogError("invalid_source");
  return compileUrdfProfile(xml, { sourcePath, model, revision: `v${revision}` });
}

/** An immutable discovery snapshot; every use rechecks confinement and exact source bytes. */
export class ProfileCatalog {
  private snapshot: Promise<Snapshot> | undefined;
  constructor(private readonly rootsJson: string | undefined = process.env["VLAEVAL_URDF_ROOTS"]) {}

  private async discover(): Promise<Snapshot> {
    const entries: Entry[] = [];
    const reasons: Reason[] = [];
    let roots: readonly string[];
    try {
      roots = this.rootsJson === undefined ? defaultRoots : rootsSchema.parse(JSON.parse(this.rootsJson));
    } catch (error) {
      return { entries, reasons: [reason("VLAEVAL_URDF_ROOTS", error)] };
    }
    if (roots.length === 0) reasons.push({ sourcePath: "", code: "no_roots", message: "No optional URDF roots configured" });
    for (const configuredRoot of new Set(roots)) {
      try {
        const root = await realpath(configuredRoot);
        const names = await readdir(root);
        const files = names.filter((name) => name.endsWith(".urdf")).sort();
        if (files.length === 0) reasons.push({ sourcePath: root, code: "no_profiles", message: "No URDF files in root" });
        for (const name of files) {
          const source = { root, path: join(root, name) };
          try {
            const { xml, sourcePath } = await readXml(source);
            const profile = compile(xml, sourcePath);
            if (!entries.some((entry) => entry.profile.profileHash === profile.profileHash)) {
              entries.push({ source, profile });
            }
          } catch (error) {
            reasons.push(reason(source.path, error));
          }
        }
      } catch (error) {
        reasons.push(reason(configuredRoot, error));
      }
    }
    return { entries, reasons };
  }

  private load(): Promise<Snapshot> {
    this.snapshot ??= this.discover();
    return this.snapshot;
  }

  private async current(entry: Entry): Promise<CompiledProfile> {
    const { xml, sourcePath } = await readXml(entry.source);
    if (sourcePath !== entry.profile.sourcePath ||
        createHash("sha256").update(xml).digest("hex") !== entry.profile.urdfSha256) {
      throw new ProfileCatalogError("changed_digest");
    }
    return entry.profile;
  }

  async list() {
    const snapshot = await this.load();
    const profiles = [];
    const reasons = [...snapshot.reasons];
    for (const entry of snapshot.entries) {
      try {
        const { rightChain: _right, leftChain: _left, ...metadata } = await this.current(entry);
        profiles.push({ id: entry.profile.profileHash, ...metadata });
      } catch (error) {
        reasons.push(reason(entry.source.path, error));
      }
    }
    return { profiles, reasons };
  }

  async get(id: string): Promise<CompiledProfile> {
    const entry = (await this.load()).entries.find((entry) => entry.profile.profileHash === id);
    if (entry === undefined) throw new ProfileCatalogError("not_found");
    try {
      return await this.current(entry);
    } catch (error) {
      if (error instanceof ProfileCatalogError) throw error;
      reason(entry.source.path, error);
      throw new ProfileCatalogError("invalid_source");
    }
  }
}
