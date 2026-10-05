import { z } from "zod";
import {
  configsSchema, connectionSchema, discoverySchema, discoverRequestSchema,
  episodesRequestSchema, episodesSchema, jobRequestSchema,
} from "./contracts";
import type { WorkerEvent } from "./contracts";
import { isTerminal, JobError } from "./jobs";
import type { JobStore } from "./jobs";
import { RemoteError, runRemote } from "./remote";
import type { RemoteRequest } from "./remote";
import { ProfileCatalog, ProfileCatalogError } from "./kinematics/catalog";

async function collect(request: RemoteRequest): Promise<WorkerEvent> {
  let response: WorkerEvent | null = null;
  await runRemote(request, (event) => {
    if (event.type === "discovery" || event.type === "configs" || event.type === "episodes") response = event;
  }, () => { /* These operations report actionable warnings in their JSON response. */ });
  if (!response) throw new RemoteError("원격 탐색 결과가 없습니다.");
  return response;
}

export function eventStream(request: Request, store: JobStore, id: string): Response {
  store.get(id);
  let cleanup = () => {};
  let cancelStream = () => {};
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      const close = (closeController = true) => {
        if (closed) return;
        closed = true;
        cleanup();
        request.signal.removeEventListener("abort", abort);
        if (closeController) controller.close();
      };
      const abort = () => close();
      cancelStream = () => close(false);
      const send = () => {
        if (closed) return;
        const job = store.get(id);
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(job)}\n\n`));
        if (isTerminal(job)) close();
      };
      cleanup = store.subscribe(id, send);
      request.signal.addEventListener("abort", abort, { once: true });
      if (request.signal.aborted) close();
      else send();
    },
    cancel() { cancelStream(); },
  });
  return new Response(stream, {
    headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "X-Accel-Buffering": "no" },
  });
}

export function createApi(store: JobStore, profiles = new ProfileCatalog()): (request: Request) => Promise<Response> {
  return async (request) => {
    const url = new URL(request.url);
    const origin = request.headers.get("origin");
    if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
      || (origin !== null && origin !== url.origin)
      || request.headers.get("sec-fetch-site") === "cross-site") {
      return Response.json({ error: "로컬 동일 출처 요청만 허용합니다." }, { status: 403 });
    }
    try {
      if (request.method === "GET" && url.pathname === "/api/kinematics/profiles") {
        return Response.json(await profiles.list(), { headers: { "Cache-Control": "no-store" } });
      }
      const profileMatch = /^\/api\/kinematics\/profiles\/([a-f0-9]{64})$/.exec(url.pathname);
      if (request.method === "GET" && profileMatch?.[1]) {
        return Response.json(await profiles.get(profileMatch[1]), { headers: { "Cache-Control": "no-store" } });
      }
      if (url.pathname === "/api/jobs" && request.method === "GET") return Response.json(store.list());
      if (url.pathname === "/api/jobs" && request.method === "POST") {
        const job = await store.start(jobRequestSchema.parse(await request.json()));
        return Response.json({ id: job.id }, { status: 201 });
      }
      const match = /^\/api\/jobs\/([a-f0-9-]+)(\/events|\/cancel)?$/.exec(url.pathname);
      if (match?.[1]) {
        const id = match[1];
        if (match[2] === "/events" && request.method === "GET") return eventStream(request, store, id);
        if (match[2] === "/cancel" && request.method === "POST") return Response.json(await store.requestCancel(id));
        if (!match[2] && request.method === "GET") return Response.json(store.get(id));
      }
      if (request.method !== "POST") return Response.json({ error: "경로를 찾을 수 없습니다." }, { status: 404 });
      switch (url.pathname) {
        case "/api/discover": {
          const input = discoverRequestSchema.parse(await request.json());
          return Response.json(discoverySchema.parse(await collect({ ...input, operation: "discover" })));
        }
        case "/api/configs": {
          const input = connectionSchema.parse(await request.json());
          return Response.json(configsSchema.parse(await collect({ ...input, operation: "configs" })));
        }
        case "/api/episodes": {
          const input = episodesRequestSchema.parse(await request.json());
          return Response.json(episodesSchema.parse(await collect({ ...input, operation: "episodes" })));
        }
        default: return Response.json({ error: "경로를 찾을 수 없습니다." }, { status: 404 });
      }
    } catch (error) {
      const status = error instanceof ProfileCatalogError ? error.status
        : error instanceof JobError ? error.status
        : error instanceof z.ZodError || error instanceof SyntaxError ? 400
        : error instanceof RemoteError ? 502 : 500;
      return Response.json({
        error: error instanceof Error ? error.message : String(error),
      }, { status });
    }
  };
}
