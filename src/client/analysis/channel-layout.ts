export type ChannelSide = "right" | "left" | "generic";
export type ChannelKind = "joint" | "gripper" | "generic";
export type ChannelUnit = "native" | "rad" | "deg" | "unknown";

export type Channel = {
  readonly channelName: string;
  readonly sourceIndex: number;
  readonly side: ChannelSide;
  readonly kind: ChannelKind;
  readonly displayUnit: ChannelUnit;
};

export type ChannelGroup = {
  readonly side: ChannelSide;
  readonly channels: readonly Channel[];
};

export type ChannelLayout = {
  readonly kind: "rby1" | "generic";
  readonly groups: readonly ChannelGroup[];
  readonly channels: readonly Channel[];
  readonly fkEligible: boolean;
};

const RBY1_CHANNELS = [
  ...Array.from({ length: 7 }, (_, index) => `right_arm_${index}`),
  ...Array.from({ length: 7 }, (_, index) => `left_arm_${index}`),
  "right_gripper_0",
  "left_gripper_0",
] as const;

const channelMetadata = (name: string): Pick<Channel, "side" | "kind"> | null => {
  const armMatch = /^(right|left)_arm_([0-6])$/.exec(name);
  if (armMatch) {
    return {
      side: armMatch[1] === "right" ? "right" : "left",
      kind: "joint",
    };
  }
  if (name === "right_gripper_0") return { side: "right", kind: "gripper" };
  if (name === "left_gripper_0") return { side: "left", kind: "gripper" };
  return null;
};

export const createChannelLayout = (names: readonly string[]): ChannelLayout => {
  const uniqueNames = new Set(names);
  const recognized = names.length === RBY1_CHANNELS.length
    && uniqueNames.size === names.length
    && RBY1_CHANNELS.every((name) => uniqueNames.has(name));

  const channels = names.map((channelName, sourceIndex): Channel => {
    const metadata = recognized ? channelMetadata(channelName) : null;
    return {
      channelName,
      sourceIndex,
      side: metadata?.side ?? "generic",
      kind: metadata?.kind ?? "generic",
      displayUnit: "native",
    };
  });

  const groups: ChannelGroup[] = recognized
    ? (["right", "left"] as const).map((side) => ({
      side,
      channels: channels.filter((channel) => channel.side === side),
    }))
    : [{ side: "generic", channels }];

  return {
    kind: recognized ? "rby1" : "generic",
    groups,
    channels,
    fkEligible: false,
  };
};
