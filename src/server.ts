import index from "../index.html";
import { isAbsolute } from "node:path";
import { createApi } from "./api";
import { JobStore } from "./jobs";
import { buildFkWorkerAsset } from "./kinematics/worker-asset";

const runsDirectoryOverride = process.env["VLAEVAL_RUNS_DIR"];
if (runsDirectoryOverride !== undefined && !isAbsolute(runsDirectoryOverride)) {
  throw new Error("VLAEVAL_RUNS_DIR must be an absolute directory path");
}
const runsDirectory = runsDirectoryOverride ?? new URL("../.runs/", import.meta.url).pathname;
const store = new JobStore(runsDirectory);
await store.initialize();
const api = createApi(store);
const fkWorkerAsset = await buildFkWorkerAsset();
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: Number(process.env["PORT"] ?? 4310),
  idleTimeout: 0,
  maxRequestBodySize: 1024 * 1024,
  development: process.env["NODE_ENV"] !== "production",
  routes: {
    "/": index,
    "/assets/fk.worker.js": () => new Response(fkWorkerAsset, {
      headers: { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-cache" },
    }),
  },
  fetch(request) {
    if (new URL(request.url).pathname.startsWith("/api/")) return api(request);
    return new Response("Not found", { status: 404 });
  },
});
console.log(`VLAEval ready at ${server.url}`);
