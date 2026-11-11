import { z } from "zod";
import {
  configsSchema, connectionSchema, discoverySchema, discoverRequestSchema,
  episodesRequestSchema, episodesSchema, jobRequestSchema,
  checkpointCatalogSchema, openpiCheckpointsRequestSchema, datasetuiRequestSchema, datasetuiSchema,
} from "./contracts";
import type { WorkerEvent } from "./contracts";
import { isTerminal, JobError } from "./jobs";
import { readJobRoute, summarizeJob } from "./job-summary";
import type { JobStore } from "./jobs";
import { RemoteError, runRemote } from "./remote";
import type { RemoteRequest } from "./remote";
import { ProfileCatalog, ProfileCatalogError } from "./kinematics/catalog";
import { diagnosticPacketSchema, maximumDiagnosticBytes } from "./diagnostic-contracts";
import { diagnosticAnchorSchema } from "./diagnostic-run-contracts";
import { DiagnosticRunManager, diagnosticEventStream, diagnosticRunsFor } from "./diagnostic-runs";
import { captureProjection } from "./projection-capture";
import { attentionVideoAnchorSchema } from "./attention-video-contracts";
import { AttentionVideoRunManager, attentionVideoEventStream, attentionVideosFor } from "./attention-video-runs";
import { jimtofFrontCalibration } from "./projection-calibration";
import { assertAllowed, assertOwns, lanPolicyFromEnv, localPeer, requireOwner, sameOriginAllowed, userName } from "./lan";
import type { LanPolicy, Peer } from "./lan";
import { targetFor } from "./targets";

async function collect(request: RemoteRequest): Promise<WorkerEvent> {
  let response: WorkerEvent | null = null;
  await runRemote(request, (event) => {
    if (event.type === "discovery" || event.type === "configs" || event.type === "episodes" || event.type === "datasetui") response = event;
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
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(summarizeJob(job))}\n\n`));
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

export function createApi(
  store: JobStore, profiles = new ProfileCatalog(), diagnostics: DiagnosticRunManager = diagnosticRunsFor(store),
  videos: AttentionVideoRunManager = attentionVideosFor(store), policy: LanPolicy = lanPolicyFromEnv(),
): (request: Request, peer?: Peer) => Promise<Response> {
  // Diagnostic and attention-video runs belong to whoever started them (peer IP), not to the job owner.
  const runStarters = new Map<string, string>();
  const started = <T extends { runId: string | null }>(peer: Peer, snapshot: T): T => {
    if (snapshot.runId) runStarters.set(snapshot.runId, peer.address);
    return snapshot;
  };
  const assertStarted = (peer: Peer, runId: string) => {
    if (!peer.local && runStarters.get(runId) !== peer.address)
      throw new JobError("다른 사람이 시작한 진단은 취소할 수 없습니다.", 403);
  };
  return async (request, peer = localPeer) => {
    const url = new URL(request.url);
    if ((!peer.local && policy.publicHosts.length === 0) || !sameOriginAllowed(request, peer, policy)) {
      return Response.json({ error: "허용된 주소의 동일 출처 요청만 받습니다." }, { status: 403 });
    }
    const allow = (input: Parameters<typeof assertAllowed>[2]) => assertAllowed(peer, policy, input);
    // Re-runs on a stored job reuse its paths, so they must fit the allowlist too (runs from this PC may not).
    const jobHost = (id: string) => {
      const { host, repo, checkpoint, dataset } = store.get(id).request;
      allow({ host, repo, checkpoint, dataset });
    };
    try {
      if (request.method !== "GET" && !peer.local) {
        const owner = requireOwner(request, peer);
        console.log(`[lan] ${owner.name}@${owner.ip} ${request.method} ${url.pathname}`);
      }
      if (request.method === "GET" && url.pathname === "/api/session")
        return Response.json({ local: peer.local, ip: peer.address, lan: policy.publicHosts.length > 0 },
          { headers: { "Cache-Control": "no-store" } });
      if (request.method === "GET" && url.pathname === "/api/projection/calibration")
        return Response.json(jimtofFrontCalibration);
      const projectionMatch = /^\/api\/jobs\/([^/]+)\/projection$/.exec(url.pathname);
      if (request.method === "POST" && projectionMatch?.[1]) {
        const id = z.string().uuid().parse(projectionMatch[1]);
        const anchor = diagnosticAnchorSchema.parse(await request.json());
        jobHost(id);
        return Response.json(await captureProjection(store, profiles, id, anchor, request.signal));
      }
      if (request.method === "GET" && url.pathname === "/api/kinematics/profiles") {
        return Response.json(await profiles.list(), { headers: { "Cache-Control": "no-store" } });
      }
      const profileMatch = /^\/api\/kinematics\/profiles\/([a-f0-9]{64})$/.exec(url.pathname);
      if (request.method === "GET" && profileMatch?.[1]) {
        return Response.json(await profiles.get(profileMatch[1]), { headers: { "Cache-Control": "no-store" } });
      }
      // Summaries, per-episode data and downloads; whole stored runs (up to 400 MB each) are never sent.
      const read = request.method === "GET" ? readJobRoute(url, store) : null;
      if (read) return read;
      if (url.pathname === "/api/jobs/storage" && request.method === "GET") {
        return Response.json(await store.storage(), { headers: { "Cache-Control": "no-store" } });
      }
      if (url.pathname === "/api/jobs" && request.method === "POST") {
        const input = jobRequestSchema.parse(await request.json());
        allow(input);
        const job = await store.start(input, peer.local && userName(request) === null ? undefined : requireOwner(request, peer));
        return Response.json({ id: job.id }, { status: 201 });
      }
      const videoMatch = /^\/api\/jobs\/([^/]+)\/attention-video(\/run(?:\/events|\/cancel)?)?$/.exec(url.pathname);
      if (videoMatch?.[1]) {
        const id = z.string().uuid().parse(videoMatch[1]);
        const suffix = videoMatch[2];
        const queryEpisode = () => {
          if (url.searchParams.getAll("episode").length !== 1)
            throw new JobError("Attention video episode query must be unambiguous", 400);
          return attentionVideoAnchorSchema.parse({
            episode: z.string().regex(/^(0|[1-9][0-9]*)$/).transform(Number).parse(url.searchParams.get("episode")),
          }).episode;
        };
        if (request.method === "GET" && !suffix)
          return Response.json(await store.getAttentionVideo(id, queryEpisode()), { headers: { "Cache-Control": "no-store" } });
        if (request.method === "POST" && suffix === "/run/cancel") {
          const input = z.object({ runId: z.string().uuid() }).strict().parse(await request.json());
          assertStarted(peer, input.runId);
          return Response.json(videos.cancel(id, input.runId));
        }
        if (request.method === "POST" && suffix === "/run") {
          const { episode } = attentionVideoAnchorSchema.parse(await request.json());
          jobHost(id);
          return Response.json(started(peer, videos.start(id, episode)), { status: 202 });
        }
        if (request.method === "GET" && suffix === "/run/events")
          return attentionVideoEventStream(request, videos, id, queryEpisode());
        if (request.method === "GET" && suffix === "/run")
          return Response.json(videos.get(id, queryEpisode()), { headers: { "Cache-Control": "no-store" } });
        return Response.json({ error: "경로를 찾을 수 없습니다." }, { status: 404 });
      }
      const diagnosticRunMatch = /^\/api\/jobs\/([^/]+)\/diagnostics\/run(\/events|\/cancel)?$/.exec(url.pathname);
      if (diagnosticRunMatch?.[1]) {
        const id = z.string().uuid().parse(diagnosticRunMatch[1]);
        const suffix = diagnosticRunMatch[2];
        if (request.method === "POST" && suffix === "/cancel") {
          const input = z.object({ runId: z.string().uuid() }).strict().parse(await request.json());
          assertStarted(peer, input.runId);
          return Response.json(diagnostics.cancel(id, input.runId));
        }
        if (request.method === "POST" && !suffix) {
          const anchor = diagnosticAnchorSchema.parse(await request.json());
          jobHost(id);
          return Response.json(started(peer, diagnostics.start(id, anchor)), { status: 202 });
        }
        if (request.method === "GET" && (!suffix || suffix === "/events")) {
          if (url.searchParams.getAll("episode").length !== 1 || url.searchParams.getAll("frame").length !== 1)
            throw new JobError("Diagnostic anchor query must be unambiguous", 400);
          const index = z.string().regex(/^(0|[1-9][0-9]*)$/).transform(Number);
          const anchor = diagnosticAnchorSchema.parse({
            episode: index.parse(url.searchParams.get("episode")),
            frame: index.parse(url.searchParams.get("frame")),
          });
          if (suffix === "/events") return diagnosticEventStream(request, diagnostics, { jobId: id, anchor });
          return Response.json(diagnostics.get(id, anchor), { headers: { "Cache-Control": "no-store" } });
        }
        return Response.json({ error: "경로를 찾을 수 없습니다." }, { status: 404 });
      }
      const diagnosticMatch = /^\/api\/jobs\/([^/]+)\/diagnostics$/.exec(url.pathname);
      if (diagnosticMatch?.[1] && (request.method === "GET" || request.method === "PUT")) {
        const id = z.string().uuid().parse(diagnosticMatch[1]);
        const anchor = z.string().regex(/^(0|[1-9][0-9]*)$/).transform(Number)
          .pipe(z.number().int().nonnegative().max(1_000_000));
        const episode = anchor.parse(url.searchParams.get("episode"));
        const frame = anchor.parse(url.searchParams.get("frame"));
        if (url.searchParams.getAll("episode").length !== 1 || url.searchParams.getAll("frame").length !== 1)
          throw new JobError("Diagnostic anchor query must be unambiguous", 400);
        if (request.method === "GET") {
          return Response.json(await store.getDiagnostic(id, episode, frame), {
            headers: { "Cache-Control": "no-store" },
          });
        }
        assertOwns(peer, store.get(id).owner);
        if (Number(request.headers.get("content-length")) > maximumDiagnosticBytes)
          throw new JobError("Diagnostic body exceeds byte limit", 413);
        const reader = request.body?.getReader();
        if (!reader) throw new JobError("Diagnostic JSON body is required", 400);
        const chunks: Uint8Array[] = [];
        let length = 0;
        try {
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            length += value.byteLength;
            if (length > maximumDiagnosticBytes) {
              await reader.cancel();
              throw new JobError("Diagnostic body exceeds byte limit", 413);
            }
            chunks.push(value);
          }
        } finally {
          reader.releaseLock();
        }
        const packet = diagnosticPacketSchema.parse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        if (packet.identity.jobId !== id || packet.identity.episode !== episode || packet.identity.frame !== frame)
          throw new JobError("Diagnostic packet must match path and query identity", 400);
        await store.saveDiagnostic(id, packet);
        return Response.json(packet, { headers: { "Cache-Control": "no-store" } });
      }
      const match = /^\/api\/jobs\/([^/]+)(\/events|\/cancel)?$/.exec(url.pathname);
      if (match?.[1]) {
        const id = match[1];
        if (!peer.local && ((!match[2] && request.method === "DELETE") || (match[2] === "/cancel" && request.method === "POST")))
          assertOwns(peer, store.get(z.string().uuid().parse(id)).owner);
        if (!match[2] && request.method === "DELETE") {
          await store.delete(z.string().uuid().parse(id));
          return new Response(null, { status: 204 });
        }
        if (match[2] === "/events" && request.method === "GET") return eventStream(request, store, id);
        if (match[2] === "/cancel" && request.method === "POST")
          return Response.json(summarizeJob(await store.requestCancel(id)));
      }
      if (request.method !== "POST") return Response.json({ error: "경로를 찾을 수 없습니다." }, { status: 404 });
      switch (url.pathname) {
        case "/api/openpi-checkpoints": {
          const input = openpiCheckpointsRequestSchema.parse(await request.json());
          allow(input);
          return Response.json(checkpointCatalogSchema.parse(await collect({
            host: input.host, roots: [input.root], operation: "discover",
          })));
        }
        case "/api/datasetui": {
          const input = datasetuiRequestSchema.parse(await request.json());
          allow(input);
          // The registry runs on one host; NAS paths are identical on every target, so its listing applies to all.
          const host = targetFor(input.host)?.datasetuiHost ?? input.host;
          return Response.json(datasetuiSchema.parse(await collect({ ...input, host, operation: "datasetui" })));
        }
        case "/api/discover": {
          const input = discoverRequestSchema.parse(await request.json());
          allow(input);
          return Response.json(discoverySchema.parse(await collect({ ...input, operation: "discover" })));
        }
        case "/api/configs": {
          const input = connectionSchema.parse(await request.json());
          allow(input);
          return Response.json(configsSchema.parse(await collect({ ...input, operation: "configs" })));
        }
        case "/api/episodes": {
          const input = episodesRequestSchema.parse(await request.json());
          allow(input);
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
