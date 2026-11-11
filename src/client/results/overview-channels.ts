import type { Channel, ChannelLayout } from "../analysis/channel-layout";

export type OverviewChannel = {
  readonly channelName: string;
  readonly sourceIndex: number;
  readonly side: Channel["side"];
  readonly kind: Channel["kind"] | "pose";
  readonly title: string;
  readonly unit: string;
  readonly wrapThreshold?: number;
};

/** Display ordering never changes native source indices. */
export function overviewChannels(layout: ChannelLayout): readonly Channel[] {
  if (layout.kind === "generic") return layout.channels;
  const byName = new Map(layout.channels.map((channel) => [channel.channelName, channel]));
  const names = (["left", "right"] as const).flatMap((side) =>
    [...Array.from({ length: 7 }, (_, joint) => `${side}_arm_${joint}`), `${side}_gripper_0`]);
  return names.flatMap((name) => {
    const channel = byName.get(name);
    return channel ? [channel] : [];
  });
}

export function overviewDisplayChannels(layout: ChannelLayout, pose: boolean): readonly OverviewChannel[] {
  if (pose) return (["left", "right"] as const).flatMap((side, arm) =>
    (["x", "y", "z", "rx", "ry", "rz", "gripper"] as const).map((axis, index) => ({
      channelName: `${side}_${axis}`, sourceIndex: arm * 7 + index, side,
      kind: axis === "gripper" ? "gripper" : "pose",
      title: `${side === "left" ? "Left" : "Right"} ${axis}`,
      unit: index < 3 ? "mm" : index < 6 ? "deg" : "native / unknown",
      ...(index >= 3 && index < 6 ? { wrapThreshold: 180 } : {}),
    })));
  return overviewChannels(layout).map((channel) => ({
    ...channel, unit: "native / unknown",
    title: channel.kind === "generic" ? channel.channelName
      : `${channel.side === "right" ? "Right" : "Left"} ${channel.kind === "gripper" ? "gripper" : `J${channel.channelName.at(-1)}`}`,
  }));
}
