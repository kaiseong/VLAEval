export async function buildFkWorkerAsset(): Promise<Blob> {
  const workerPath = new URL("../client/analysis/fk.worker.ts", import.meta.url).pathname;
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
