export const metricLabels = {
  mae: "MAE (Mean Absolute Error)",
  mse: "MSE (Mean Squared Error)",
  rmse: "RMSE (Root Mean Square Error)",
} as const;

/** Older saved runs contain RMSE but not MSE; use the unrounded stored value. */
export function metricMse(mse: number | null | undefined, rmse: number | null): number | null {
  const value = mse === undefined ? rmse === null ? null : rmse * rmse : mse;
  return value !== null && Number.isFinite(value) ? value : null;
}

export function formatMetric(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "—";
  if (value !== 0 && Math.abs(value) < 1e-6) return value.toExponential(3);
  return value.toLocaleString("ko-KR", { maximumFractionDigits: 6 });
}
