import { derivePrediction } from "./prediction";

self.onmessage = (event: MessageEvent<unknown>) => {
  try {
    self.postMessage({ kind: "ready", data: derivePrediction(event.data) });
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    self.postMessage({ kind: "error", reason: error.message.slice(0, 4096) });
  }
};
