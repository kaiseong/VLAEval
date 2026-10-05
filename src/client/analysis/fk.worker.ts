import { fkIdentitySchema, fkResultSchema, type FkRequest, type FkResult } from "../../kinematics/contracts";
import { deriveForward } from "../../kinematics/forward";
import { fkCsvExport, fkJsonExport } from "./exports";
import { fkCommandSchema, sameFkIdentity, unpackFkRequest, type FkReply, type FkSelection } from "./fk-protocol";
import { buildFkView, fkFrameIndex, fkPoseSeries } from "./fk-view";

// This Worker is the sole owner of full scientific samples. Nothing mutable is shared.
let request: FkRequest | null = null;
let result: FkResult | null = null;
let channels: ReturnType<typeof fkPoseSeries> = [];
let frames: number[] = [];
const send = (reply: FkReply) => self.postMessage(reply);
const point = (frame: number | null) => {
  if (frame === null || result === null) return null;
  const index = fkFrameIndex(frames, frame);
  return frames[index] === frame ? result.samples[index] ?? null : null;
};
function view(selection: FkSelection, serial: number) {
  if (result === null) return;
  const { samples, ...metadata } = result;
  send({ kind: "view", identity: fkIdentitySchema.parse(result), serial,
    payload: JSON.stringify({
      result: { ...metadata, frameCount: samples.length, firstFrame: frames[0] ?? null, lastFrame: frames.at(-1) ?? null },
      view: buildFkView(channels, selection), selected: point(selection.sourceFrame),
    }) });
}

self.onmessage = (event: MessageEvent<unknown>) => {
  try {
    const command = fkCommandSchema.parse(event.data);
    switch (command.kind) {
      case "derive": {
        request = unpackFkRequest(command);
        result = fkResultSchema.parse(deriveForward(request));
        frames = request.frames.map((sample) => sample.frame);
        if (frames.some((frame, index) => index > 0 && frame <= (frames[index - 1] ?? -1)) ||
          result.samples.length !== frames.length || result.samples.some((sample, index) =>
            sample.frame !== frames[index] ||
            JSON.stringify(sample.source) !== JSON.stringify({
              predicted: request?.frames[index]?.predicted, target: request?.frames[index]?.target,
            }))) throw new FkWorkerError("Derived result does not match complete source");
        channels = fkPoseSeries(result, 1);
        view(command.selection, 0);
        break;
      }
      case "view":
        if (result && sameFkIdentity(result, command.identity)) view(command.selection, command.serial);
        break;
      case "point":
        if (result && sameFkIdentity(result, command.identity))
          send({ kind: "point", identity: command.identity, serial: command.serial,
            sourceFrame: command.sourceFrame, payload: JSON.stringify(point(command.sourceFrame)) });
        break;
      case "export": {
        if (!result || !request || !sameFkIdentity(result, command.identity)) break;
        const input = { identity: command.identity, completed: result,
          context: { profile: request.profile, sourceJobId: request.jobId, sourceEpisode: request.episode } };
        const artifact = command.format === "json" ? fkJsonExport(input) : fkCsvExport(input);
        if (!artifact) throw new FkWorkerError("No matching complete export");
        send({ ...artifact, kind: "export", identity: command.identity, serial: command.serial,
          format: command.format, content: new Blob([artifact.content], { type: artifact.mediaType }) });
        break;
      }
      default: { const exhaustive: never = command; return exhaustive; }
    }
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    send({ kind: "error", reason: error.message.slice(0, 4096) });
  }
};

class FkWorkerError extends Error {
  constructor(readonly reason: string) { super(reason); }
}
