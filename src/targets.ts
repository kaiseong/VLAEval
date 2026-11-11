/**
 * Evaluation hosts the UI offers and LAN clients may reach. Shared by server and client.
 * Paths are the remote host's own absolute paths; the DatasetUI NAS is mounted at the same
 * path on every host, so a dataset picked from the DatasetUI listing works on any target.
 */
export type RemoteTarget = {
  readonly id: string;
  readonly label: string;
  readonly host: string;
  /** Remote home, used to expand `~/` paths in allowlist checks. */
  readonly home: string;
  readonly repo: string;
  /** Discovery roots offered in the UI; LAN clients may only touch paths under these. */
  readonly roots: readonly string[];
  /** Interpreter for PyTorch (model.safetensors) checkpoints; `~` expands on the remote host. */
  readonly pytorchPython: string;
  /** Host that runs the DatasetUI registry container and lists its datasets. */
  readonly datasetuiHost: string;
  /** Offers the TensorRT compute mode (an engine built on this host under `<checkpoint>/engine/`). */
  readonly tensorrt: boolean;
};

const datasetuiRoot = "/mnt/datasetui-nas/DatasetUI";
const rtx6000 = "rtx6000@192.168.0.3";

export const remoteTargets: readonly RemoteTarget[] = [
  {
    id: "rtx6000", label: "RTX6000 · 공용 서버", host: rtx6000, home: "/home/rtx6000",
    repo: "/home/rtx6000/kgs/pi05_rby1",
    roots: ["/home/rtx6000/kgs", "/home/rtx6000/.cache/huggingface/lerobot", "/home/rtx6000/.cache/openpi", datasetuiRoot, "/data"],
    pytorchPython: "~/kgs/venvs/pi05_cu128/bin/python", datasetuiHost: rtx6000, tensorrt: false,
  },
  {
    // The repo's .venv/bin/python is deploy/thor/python: python3 inside the openpi-pi0.5:vlaeval container.
    id: "thor", label: "Thor · docker PyTorch", host: "nvidia@192.168.0.223", home: "/home/nvidia",
    repo: "/home/nvidia/kgs/pi05_rby1",
    roots: ["/home/nvidia/kgs", "/home/nvidia/.cache/huggingface/lerobot", "/home/nvidia/.cache/openpi", datasetuiRoot],
    pytorchPython: "/home/nvidia/kgs/pi05_rby1/.venv/bin/python", datasetuiHost: rtx6000, tensorrt: true,
  },
];

export function targetFor(host: string): RemoteTarget | undefined {
  return remoteTargets.find((target) => target.host === host);
}
