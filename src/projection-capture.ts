import { diagnosticPacketSchema } from "./diagnostic-contracts";
import type { DiagnosticPacket } from "./diagnostic-contracts";
import { JobError } from "./jobs";
import type { JobStore } from "./jobs";
import type { ProfileCatalog } from "./kinematics/catalog";
import { jimtofFrontCalibration, jimtofProjection } from "./projection-calibration";
import { readProjectionFrame } from "./projection-reader";

export async function captureProjection(
  store: JobStore, profiles: ProfileCatalog, jobId: string,
  anchor: { readonly episode: number; readonly frame: number }, signal: AbortSignal,
  reader: typeof readProjectionFrame = readProjectionFrame,
): Promise<DiagnosticPacket> {
  const reservation = crypto.randomUUID();
  const job = store.acquireDiagnosticRun(jobId, anchor.episode, anchor.frame, reservation);
  try {
    const result = job.result;
    if (!result) throw new JobError("Completed result is missing", 409);
    if (!result.samples.some((chunk) => chunk.episode === anchor.episode && chunk.frame === anchor.frame))
      throw new JobError("선택 프레임의 전체 청크가 저장되지 않았습니다.", 409);
    const entry = (await profiles.list()).profiles.find((profile) => profile.urdfSha256 === jimtofFrontCalibration.urdfSha256);
    if (!entry) throw new JobError("운영 보정에 맞는 고속 그리퍼 URDF가 없습니다.", 409);
    const profile = await profiles.get(entry.id);
    const xml = await Bun.file(profile.sourcePath).text();
    const projection = jimtofProjection(xml, profile, result.actionNames, result.dataset);
    let previous: DiagnosticPacket | null = null;
    try { previous = await store.getDiagnostic(jobId, anchor.episode, anchor.frame); }
    catch (error) { if (!(error instanceof JobError && error.status === 404)) throw error; }
    const observation = await reader(job.request.host, {
      repo: job.request.repo, dataset: result.dataset, ...anchor, datasetKey: jimtofFrontCalibration.datasetKey,
    }, signal);
    if (signal.aborted) throw new JobError("영상 읽기가 취소되었습니다.", 409);
    const target = result.samples.find((chunk) => chunk.episode === anchor.episode && chunk.frame === anchor.frame)?.target[0];
    const action = observation.vectors["action"];
    if (!target || !action || action.values.length !== target.length
      || action.values.some((value, index) => {
        const saved = target[index];
        return saved === undefined || Math.abs(value - saved) > 1e-5 * Math.max(1, Math.abs(value));
      })
      || action.names?.some((name, index) => name !== result.actionNames[index]))
      throw new JobError("현재 데이터셋의 액션/채널이 저장 평가와 다릅니다.", 409);
    if (observation.episode !== anchor.episode || observation.frame !== anchor.frame
      || Math.abs(observation.fps - result.fps) > 1e-9
      || observation.image.width !== projection.camera.width || observation.image.height !== projection.camera.height)
      throw new JobError("영상의 프레임·FPS·크기가 저장 평가/보정과 다릅니다.", 409);
    const front = previous?.images.find((image) => image.role === "front");
    // PNG compression may differ; the reader and diagnostics share uint8 pixel conversion.
    if (front && (front.datasetKey !== observation.image.datasetKey
      || Math.abs(front.timestampSeconds - observation.timestampSeconds) > 1e-6))
      throw new JobError("저장 attention과 투영 영상의 시간·카메라 대응이 다릅니다.", 409);
    if (front) projection.modelKey = front.modelKey;
    const packet = diagnosticPacketSchema.parse(previous ? { ...previous, projection } : {
      schemaVersion: 2,
      identity: { jobId, ...anchor, dataset: result.dataset, config: result.config, checkpoint: result.checkpoint,
        seed: result.seed, numSteps: result.numSteps },
      provenance: { kind: "captured", adapterRevision: "cpu-projection/1", backend: "none", dtype: "uint8",
        compiled: false, inputDigest: observation.image.sha256, noiseDigest: null },
      images: [{ ...observation.image, role: "front", modelKey: projection.modelKey,
        timestampSeconds: observation.timestampSeconds, geometryResolved: false, preprocessing: null }],
      projection, attention: null, actionDifferences: [],
      timing: { compileMs: null, warmupMs: null, inferenceMs: null, extractionMs: null, peakGpuBytes: null },
    });
    await store.saveDiagnostic(jobId, packet, reservation);
    return packet;
  } finally { store.releaseDiagnosticRun(reservation); }
}
