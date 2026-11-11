import type { ExportArtifact } from "./exports";
import type { PredictionRequest, PredictionResult } from "./prediction-contracts";
import type { OverviewChannel } from "../results/overview-channels";

export function predictionExport(input: {
  readonly jobId: string;
  readonly episode: number;
  readonly coordinate: "joint" | "cartesian";
  readonly request: PredictionRequest;
  readonly result: PredictionResult;
  readonly channels: readonly OverviewChannel[];
  readonly format: "json" | "csv";
}): ExportArtifact | null {
  const data = input.result[input.coordinate];
  if (!data) return null;
  const provenance = input.result.provenance[input.coordinate];
  const filename = `vlaeval-${input.jobId}-ep${input.episode}-${input.coordinate}-${provenance}.${input.format}`;
  if (input.format === "json") return { filename, mediaType: "application/json;charset=utf-8",
    content: JSON.stringify({ schemaVersion: 1, jobId: input.jobId, episode: input.episode,
      coordinate: input.coordinate, provenance, source: input.request.source, actionNames: input.request.actionNames,
      profile: provenance === "source" ? null : input.request.profile, seed: provenance === "ik" ? input.request.seed : null,
      channels: input.channels, issues: input.result.issues, ...data }, null, 2) };
  const cell = (value: string | number | boolean | null | undefined) => `"${String(value ?? "").replaceAll('"', '""')}"`;
  const reference = input.coordinate === "cartesian" && input.request.source.kind === "cartesian"
    ? input.request.source.referenceFrame : input.request.profile?.rootLink ?? "";
  const metadata = [input.coordinate, provenance, provenance === "source" ? "" : input.request.profile?.profileHash ?? "",
    reference, provenance === "ik" ? input.request.seed?.kind ?? "" : ""];
  const rows = [["coordinate", "provenance", "profile_hash", "reference_frame", "seed_kind",
    "kind", "origin", "h", "frame", "time_seconds", "source_valid",
    ...input.channels.map((channel) => `predicted.${channel.channelName}[${channel.unit}]`),
    ...input.channels.map((channel) => `target.${channel.channelName}[${channel.unit}]`)].map(cell).join(",")];
  data.series.frames.forEach((frame, index) => rows.push([...metadata, "first_step", frame, 0, frame, frame / data.series.fps, true,
    ...(data.series.predicted[index] ?? []), ...(data.series.target[index] ?? [])].map(cell).join(",")));
  for (const chunk of data.chunks) chunk.predicted.forEach((predicted, h) =>
    rows.push([...metadata, "chunk", chunk.frame, h, chunk.frame + h, (chunk.frame + h) / data.series.fps, chunk.valid[h] ?? false,
      ...predicted, ...(chunk.target[h] ?? [])].map(cell).join(",")));
  return { filename, mediaType: "text/csv;charset=utf-8", content: rows.join("\n") };
}
