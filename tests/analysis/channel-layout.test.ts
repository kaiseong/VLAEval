import { describe, expect, it } from "bun:test";
import { createChannelLayout } from "../../src/client/analysis/channel-layout";

const rby1Names = [
  ...Array.from({ length: 7 }, (_, index) => `right_arm_${index}`),
  ...Array.from({ length: 7 }, (_, index) => `left_arm_${index}`),
  "right_gripper_0",
  "left_gripper_0",
];

describe("createChannelLayout", () => {
  it("recognizes the exact permuted names and preserves source indices", () => {
    const permutation = [...rby1Names].reverse();
    const layout = createChannelLayout(permutation);

    expect(layout.kind).toBe("rby1");
    expect(layout.fkEligible).toBe(false);
    expect(layout.channels.map(({ channelName, sourceIndex }) => [
      channelName,
      sourceIndex,
    ])).toEqual(permutation.map((name, sourceIndex) => [name, sourceIndex]));
    expect(layout.groups.map(({ side, channels }) => [
      side,
      channels.map(({ channelName }) => channelName),
    ])).toEqual([
      ["right", permutation.filter((name) => name.startsWith("right_"))],
      ["left", permutation.filter((name) => name.startsWith("left_"))],
    ]);
    expect(layout.channels.every(({ displayUnit }) => displayUnit === "native")).toBe(true);
  });

  it("keeps generic dimensions and unknown names visible without robot identity", () => {
    const names = ["generic2D", "action_0", "mystery", "action_3"];
    const layout = createChannelLayout(names);

    expect(layout.kind).toBe("generic");
    expect(layout.fkEligible).toBe(false);
    expect(layout.groups).toHaveLength(1);
    expect(layout.groups[0]?.channels.map(({ channelName }) => channelName)).toEqual(names);
    expect(layout.channels.map(({ sourceIndex, side, kind, displayUnit }) => [
      sourceIndex,
      side,
      kind,
      displayUnit,
    ])).toEqual(names.map((_, index) => [index, "generic", "generic", "native"]));
  });

  it("falls back to a complete generic grid for missing or duplicate names", () => {
    const missing = createChannelLayout(rby1Names.slice(0, -1));
    const duplicate = createChannelLayout([...rby1Names.slice(0, -1), "right_arm_0"]);

    expect(missing.kind).toBe("generic");
    expect(missing.channels).toHaveLength(rby1Names.length - 1);
    expect(missing.channels.every(({ side, kind }) => side === "generic" && kind === "generic"))
      .toBe(true);
    expect(duplicate.kind).toBe("generic");
    expect(duplicate.channels.map(({ channelName }) => channelName))
      .toEqual([...rby1Names.slice(0, -1), "right_arm_0"]);
    expect(duplicate.channels.every(({ side }) => side === "generic")).toBe(true);
  });
});
