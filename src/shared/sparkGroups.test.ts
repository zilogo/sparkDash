import { describe, expect, it } from "vitest";
import { groupOf, groupSparks, listGroups, summarizeGroup } from "./sparkGroups";
import { makeSpark } from "../testing/fixtures";
import type { SparkSnapshot } from "../api/types";

const inGroup = (id: string, group: string | null | undefined, online = true): SparkSnapshot => ({ ...makeSpark(id, online), group });

describe("groupOf / listGroups / groupSparks", () => {
  it("treats absent, null and blank as ungrouped", () => {
    expect(groupOf({})).toBeNull();
    expect(groupOf({ group: null })).toBeNull();
    expect(groupOf({ group: "  " })).toBeNull();
    expect(groupOf({ group: " A " })).toBe("A");
  });

  it("lists groups once, in order of first appearance", () => {
    expect(listGroups([inGroup("a", "B"), inGroup("b", null), inGroup("c", "A"), inGroup("d", "B")])).toEqual(["B", "A"]);
    expect(listGroups([inGroup("a", undefined)])).toEqual([]);
  });

  it("splits units into groups and an ungrouped remainder keeping order", () => {
    const sparks = [inGroup("a", "X"), inGroup("b", null), inGroup("c", "Y"), inGroup("d", "X")];
    const out = groupSparks(sparks);
    expect(out.groups.map((g) => [g.name, g.sparks.map((s) => s.id)])).toEqual([
      ["X", ["a", "d"]],
      ["Y", ["c"]],
    ]);
    expect(out.ungrouped.map((s) => s.id)).toEqual(["b"]);
  });

  it("returns no groups when nothing is grouped", () => {
    const out = groupSparks([inGroup("a", null), inGroup("b", undefined)]);
    expect(out.groups).toEqual([]);
    expect(out.ungrouped).toHaveLength(2);
  });
});

describe("summarizeGroup", () => {
  it("adds online units' memory and LLM endpoints", () => {
    const sum = summarizeGroup([inGroup("a", "G"), inGroup("b", "G"), inGroup("c", "G", false)]);
    expect(sum).toEqual({ total: 3, online: 2, memUsedMb: 2048, memTotalMb: 8192, llmServing: 2 });
  });

  it("keeps unknowns null instead of zero when every unit is offline", () => {
    const sum = summarizeGroup([inGroup("a", "G", false)]);
    expect(sum).toEqual({ total: 1, online: 0, memUsedMb: null, memTotalMb: null, llmServing: null });
  });

  it("does not count unmeasured memory and skips invalid or unavailable endpoints", () => {
    const noGpu = inGroup("a", "G");
    Object.assign(noGpu.metrics, { gpu: null, unifiedMemory: null });
    const down = inGroup("b", "G");
    Object.assign(down.metrics, { llm: [{ available: false }, { available: true, measurementValid: false }] });
    const sum = summarizeGroup([noGpu, down]);
    expect(sum.memUsedMb).toBe(1024);
    expect(sum.memTotalMb).toBe(4096);
    expect(sum.llmServing).toBe(1);
  });

  it("falls back to unified memory when there is no GPU VRAM", () => {
    const mac = inGroup("a", "G");
    Object.assign(mac.metrics, { gpu: null, unifiedMemory: { used: 10, total: 100, available: 90 } });
    const sum = summarizeGroup([mac]);
    expect([sum.memUsedMb, sum.memTotalMb]).toEqual([10, 100]);
  });
});
