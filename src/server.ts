import index from "../index.html";
import { isAbsolute } from "node:path";
import { createApi } from "./api";
import { lanPolicyFromEnv, peerFor } from "./lan";
import { JobStore } from "./jobs";
import { maximumDiagnosticBytes } from "./diagnostic-contracts";
import { buildFkOverviewWorkerAsset, buildFkWorkerAsset, buildPredictionWorkerAsset } from "./kinematics/worker-asset";

const runsDirectoryOverride = process.env["VLAEVAL_RUNS_DIR"];
if (runsDirectoryOverride !== undefined && !isAbsolute(runsDirectoryOverride)) {
  throw new Error("VLAEVAL_RUNS_DIR must be an absolute directory path");
}
const runsDirectory = runsDirectoryOverride ?? new URL("../.runs/", import.meta.url).pathname;
const store = new JobStore(runsDirectory);
await store.initialize();
const policy = lanPolicyFromEnv();
const api = createApi(store, undefined, undefined, undefined, policy);
const fkWorkerAsset = await buildFkWorkerAsset();
const fkOverviewWorkerAsset = await buildFkOverviewWorkerAsset();
const predictionWorkerAsset = await buildPredictionWorkerAsset();
// LAN mode: VLAEVAL_BIND=127.0.0.1,<LAN IP> plus VLAEVAL_PUBLIC_HOSTS=<LAN IP>. One listener per address,
// so other interfaces (VPN, docker bridges) stay closed; loopback-only by default.
const addresses = (process.env["VLAEVAL_BIND"] ?? "127.0.0.1").split(",").map((value) => value.trim()).filter(Boolean);
for (const hostname of addresses) {
  const server = Bun.serve({
    hostname,
    port: Number(process.env["PORT"] ?? 4310),
    idleTimeout: 0,
    maxRequestBodySize: maximumDiagnosticBytes,
    development: process.env["NODE_ENV"] !== "production",
    routes: {
      "/": index,
      "/assets/fk.worker.js": () => new Response(fkWorkerAsset, {
        headers: { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-cache" },
      }),
      "/assets/fk-overview.worker.js": () => new Response(fkOverviewWorkerAsset, {
        headers: { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-cache" },
      }),
      "/assets/prediction.worker.js": () => new Response(predictionWorkerAsset, {
        headers: { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-cache" },
      }),
    },
    fetch(request, server) {
      if (new URL(request.url).pathname.startsWith("/api/")) return api(request, peerFor(server.requestIP(request)?.address));
      return new Response("Not found", { status: 404 });
    },
  });
  console.log(`VLAEval ready at ${server.url}${policy.publicHosts.length ? ` · LAN hosts ${policy.publicHosts.join(", ")}` : ""} · runs ${runsDirectory}`);
}
