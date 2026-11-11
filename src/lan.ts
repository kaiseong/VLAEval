import { posix } from "node:path";
import { JobError } from "./jobs";
import { remoteTargets } from "./targets";
import type { RemoteTarget } from "./targets";

/** Who sent a request: the TCP peer address and whether it is this PC. */
export type Peer = { readonly address: string; readonly local: boolean };
export type Owner = { readonly name: string; readonly ip: string };

export const userHeader = "x-vlaeval-user";
const loopbackNames = ["127.0.0.1", "localhost", "[::1]"];

export function isLoopback(address: string): boolean {
  return address === "::1" || /^(::ffff:)?127\.\d+\.\d+\.\d+$/.test(address);
}

export const localPeer: Peer = { address: "127.0.0.1", local: true };
export function peerFor(address: string | undefined): Peer {
  const value = address ?? "";
  return { address: value.replace(/^::ffff:(?=\d+\.\d+\.\d+\.\d+$)/, ""), local: isLoopback(value) };
}

/** What a LAN (non-loopback) client may reach; this PC itself is unrestricted. */
export type LanPolicy = {
  /** Host header values the server answers to besides loopback, e.g. the PC's LAN IP. Empty = LAN off. */
  readonly publicHosts: readonly string[];
  /** SSH targets with their repo and path allowlists (src/targets.ts). */
  readonly targets: readonly RemoteTarget[];
  readonly datasetuiContainer: string;
  readonly datasetuiRoot: string;
};

const list = (value: string | undefined) => (value ?? "").split(",").map((item) => item.trim()).filter(Boolean);

export function lanPolicyFromEnv(env: Record<string, string | undefined> = process.env): LanPolicy {
  return {
    publicHosts: list(env["VLAEVAL_PUBLIC_HOSTS"]),
    targets: remoteTargets,
    datasetuiContainer: "datasetui-api-1",
    datasetuiRoot: "/mnt/datasetui-nas/DatasetUI",
  };
}

/** Host/Origin/fetch-site checks: blocks other sites and DNS rebinding for both loopback and LAN clients. */
export function sameOriginAllowed(request: Request, peer: Peer, policy: LanPolicy): boolean {
  const url = new URL(request.url);
  const hostAllowed = peer.local
    ? loopbackNames.includes(url.hostname) || policy.publicHosts.includes(url.hostname)
    : policy.publicHosts.includes(url.hostname);
  const origin = request.headers.get("origin");
  return hostAllowed && (origin === null || origin === url.origin)
    && request.headers.get("sec-fetch-site") !== "cross-site";
}

/** Name typed by the user (sent URI-encoded so Korean survives HTTP headers); null if absent or invalid. */
export function userName(request: Request): string | null {
  const raw = request.headers.get(userHeader);
  if (raw === null) return null;
  let name: string;
  try { name = decodeURIComponent(raw).trim(); } catch { return null; }
  return /^[\p{L}\p{N} ._-]{1,40}$/u.test(name) ? name : null;
}

export function requireOwner(request: Request, peer: Peer): Owner {
  const name = userName(request) ?? (peer.local ? "local" : null);
  if (name === null) throw new JobError("화면 위쪽에 이름을 입력한 뒤 다시 시도하세요. (한글·영문·숫자 40자 이내)", 401);
  return { name, ip: peer.address };
}

function under(path: string, roots: readonly string[], home: string): boolean {
  const absolute = path.startsWith("~/") ? `${home}/${path.slice(2)}` : path;
  if (!absolute.startsWith("/") || absolute.split("/").includes("..")) return false;
  const normal = posix.normalize(absolute).replace(/\/+$/, "") || "/";
  return roots.some((root) => normal === root || normal.startsWith(`${root}/`));
}

/** Rejects a LAN client's request fields that leave the allowlist; loopback requests pass unchanged. */
export function assertAllowed(peer: Peer, policy: LanPolicy, input: {
  readonly host: string; readonly repo?: string; readonly roots?: readonly string[]; readonly root?: string;
  readonly checkpoint?: string; readonly dataset?: string;
  readonly datasetuiContainer?: string; readonly datasetuiRoot?: string;
}): void {
  if (peer.local) return;
  const deny = (field: string): never => { throw new JobError(`사내망 접속에서는 허용되지 않은 ${field}입니다.`, 403); };
  // Every request names its host; paths are checked against that host's own allowlist.
  const target = policy.targets.find((item) => item.host === input.host);
  if (!target) return deny("SSH 대상");
  if (input.repo !== undefined && input.repo.replace(/\/+$/, "") !== target.repo) deny("모델 저장소 경로");
  for (const [field, value] of [["탐색 경로", input.root], ["체크포인트 경로", input.checkpoint], ["데이터셋 경로", input.dataset]] as const) {
    if (value !== undefined && !under(value, target.roots, target.home)) deny(field);
  }
  for (const root of input.roots ?? []) if (!under(root, target.roots, target.home)) deny("탐색 경로");
  if (input.datasetuiContainer !== undefined && input.datasetuiContainer !== policy.datasetuiContainer) deny("DatasetUI 컨테이너");
  if (input.datasetuiRoot !== undefined && input.datasetuiRoot.replace(/\/+$/, "") !== policy.datasetuiRoot) deny("DatasetUI 경로");
}

/** LAN clients may change only the runs they started (matched by peer IP); this PC may change any run. */
export function assertOwns(peer: Peer, owner: Owner | undefined): void {
  if (!peer.local && owner?.ip !== peer.address)
    throw new JobError("다른 사람이 실행한 기록은 변경할 수 없습니다.", 403);
}
