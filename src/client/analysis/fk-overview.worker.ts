import { deriveFkOverview } from "./fk-overview";

self.onmessage = (event: MessageEvent<unknown>) => {
  try {
    self.postMessage({ kind: "ready", data: deriveFkOverview(event.data) });
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    self.postMessage({ kind: "error", reason: error.message });
  }
};
