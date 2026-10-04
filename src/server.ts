import index from "../index.html";
import { createApi } from "./api";
import { JobStore } from "./jobs";

const store = new JobStore(new URL("../.runs/", import.meta.url).pathname);
await store.initialize();
const api = createApi(store);
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: Number(process.env["PORT"] ?? 4310),
  idleTimeout: 0,
  maxRequestBodySize: 1024 * 1024,
  development: process.env["NODE_ENV"] !== "production",
  routes: { "/": index },
  fetch(request) {
    if (new URL(request.url).pathname.startsWith("/api/")) return api(request);
    return new Response("Not found", { status: 404 });
  },
});
console.log(`VLAEval ready at ${server.url}`);
