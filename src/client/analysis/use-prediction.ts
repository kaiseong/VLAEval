import { useEffect, useState } from "react";
import { z } from "zod";
import { predictionResultSchema } from "./prediction-contracts";
import type { PredictionRequest, PredictionResult } from "./prediction-contracts";

const replySchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("ready"), data: predictionResultSchema }),
  z.object({ kind: z.literal("error"), reason: z.string() }),
]);

export function usePrediction(request: PredictionRequest | null) {
  const [state, setState] = useState<{
    readonly request: PredictionRequest | null;
    readonly data: PredictionResult | null;
    readonly error: string;
  }>({ request: null, data: null, error: "" });
  useEffect(() => {
    if (!request) return;
    const worker = new Worker("/assets/prediction.worker.js", { type: "module" });
    let current = true;
    worker.onmessage = (event: MessageEvent<unknown>) => {
      if (!current) return;
      const reply = replySchema.safeParse(event.data);
      if (!reply.success) { setState({ request, data: null, error: reply.error.message }); return; }
      switch (reply.data.kind) {
        case "ready": setState({ request, data: reply.data.data, error: "" }); break;
        case "error": setState({ request, data: null, error: reply.data.reason }); break;
        default: { const exhaustive: never = reply.data; return exhaustive; }
      }
    };
    worker.onerror = (event) => {
      if (current) setState({ request, data: null, error: event.message || "Coordinate Worker failed" });
    };
    worker.postMessage(request);
    return () => { current = false; worker.terminate(); };
  }, [request]);
  const ready = request !== null && state.request === request;
  return { data: ready ? state.data : null, error: ready ? state.error : "",
    pending: request !== null && (!ready || (!state.data && !state.error)) };
}
