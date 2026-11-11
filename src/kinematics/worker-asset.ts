export async function buildFkWorkerAsset(): Promise<Blob> {
  return buildWorkerAsset("../client/analysis/fk.worker.ts");
}

export async function buildFkOverviewWorkerAsset(): Promise<Blob> {
  return buildWorkerAsset("../client/analysis/fk-overview.worker.ts");
}

export async function buildPredictionWorkerAsset(): Promise<Blob> {
  return buildWorkerAsset("../client/analysis/prediction.worker.ts");
}

async function buildWorkerAsset(path: string): Promise<Blob> {
  const workerPath = new URL(path, import.meta.url).pathname;
  const build = await Bun.build({
    target: "browser",
    entrypoints: [workerPath],
    format: "esm",
  });
  if (!build.success) throw new AggregateError(build.logs, "Could not build FK Worker");
  const entry = build.outputs.find((output) => output.kind === "entry-point");
  if (!entry) throw new AggregateError(build.logs, "FK Worker build emitted no entry");
  return entry;
}
