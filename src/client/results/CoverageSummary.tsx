import type { Job } from "../../contracts";

type Result = NonNullable<Job["result"]>;

export interface CoverageSummaryProps {
  readonly result: Pick<Result, "coverage" | "perEpisode" | "validSteps">;
  readonly request: Pick<Job["request"], "maxSamples" | "stride">;
  readonly episode: number;
  readonly frames: readonly number[];
}

export function CoverageSummary({ result, request, episode, frames }: CoverageSummaryProps) {
  const coverage = result.coverage;
  const selected = coverage?.episodes.find((item) => item.episode === episode);
  const episodeResult = result.perEpisode.find((item) => item.episode === episode);
  const scoredAnchors = selected?.scoredAnchors ?? episodeResult?.framesEvaluated ?? frames.length;
  const lastScoredFrame = frames.at(-1);
  const subset = request.maxSamples > 0 || request.stride !== 1;
  const recorded = selected !== undefined;
  const knownCoverage = recorded ? "recorded" : "unknown";

  return <div className="coverage-summary" aria-label="Frame and horizon coverage"
    data-coverage-known={knownCoverage} data-coverage-episode={episode}
    data-scored-anchors={scoredAnchors}
    data-original-length-known={recorded ? "true" : "false"}
    data-original-frames={recorded ? selected.originalFrames : "unknown"}
    data-mask-validity={recorded ? "recorded" : "unknown"}
    data-geometric-full={recorded ? selected.geometricFullAnchors : "unknown"}
    data-geometric-tail={recorded ? selected.geometricTailAnchors : "unknown"}
    data-fully-valid={recorded ? selected.fullyValidChunks : "unknown"}
    data-valid-rows={recorded ? selected.validRows : "unknown"}
    data-run-valid-rows={result.validSteps}
    data-last-scored-frame={lastScoredFrame ?? "unknown"}
    data-subset={subset ? "true" : "false"} data-subset-stride={request.stride}
    data-subset-max-samples={request.maxSamples} data-warmup-excluded="true">
    <span className="coverage-summary__scope" data-coverage-scope="first-step">
      <strong>First-step · EP {episode}</strong>
      {` ${scoredAnchors.toLocaleString("ko-KR")} scored anchors / ${recorded ? selected.originalFrames.toLocaleString("ko-KR") : "unknown"} original frames · last ${lastScoredFrame ?? "unknown"} · warm-up excluded`}
    </span>
    <span className="coverage-summary__scope" data-coverage-scope="future-chunk">
      <strong>Future chunks · EP {episode}</strong>
      {recorded
        ? ` H=${coverage?.horizon ?? "unknown"} · ${selected.geometricFullAnchors.toLocaleString("ko-KR")} full / ${selected.geometricTailAnchors.toLocaleString("ko-KR")} tail geometric anchors · ${selected.fullyValidChunks.toLocaleString("ko-KR")} valid chunks · ${selected.validRows.toLocaleString("ko-KR")} valid rows`
        : " geometric full/tail anchors, valid chunks, and episode mask rows unknown"}
    </span>
    {coverage && !recorded && <span className="coverage-summary__scope" data-coverage-scope="run-chunk">
      {`Run coverage · ${coverage.scoredAnchors.toLocaleString("ko-KR")} anchors · ${coverage.geometricFullAnchors.toLocaleString("ko-KR")} full · ${coverage.geometricTailAnchors.toLocaleString("ko-KR")} tail · ${coverage.fullyValidChunks.toLocaleString("ko-KR")} valid chunks · ${coverage.validRows.toLocaleString("ko-KR")} valid rows`}
    </span>}
    {subset && <span className="coverage-summary__subset" data-coverage-subset>
      Quick subset · request stride {request.stride} · maxSamples {request.maxSamples === 0 ? "all" : request.maxSamples.toLocaleString("ko-KR")}
    </span>}
  </div>;
}
