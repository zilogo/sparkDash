import type { SparkSnapshot } from "../api/types";

/** Group name of a unit, or null when it is ungrouped (absent, empty or blank). */
export function groupOf(spark: Pick<SparkSnapshot, "group">): string | null {
  const name = typeof spark.group === "string" ? spark.group.trim() : "";
  return name || null;
}

/** Distinct group names in order of first appearance. */
export function listGroups(sparks: readonly Pick<SparkSnapshot, "group">[]): string[] {
  const seen = new Set<string>();
  for (const spark of sparks) {
    const name = groupOf(spark);
    if (name) seen.add(name);
  }
  return [...seen];
}

export interface SparkGroupBucket<T> {
  name: string;
  sparks: T[];
}

export interface GroupedSparks<T> {
  /** Named groups in order of first appearance; each keeps the input order of its units. */
  groups: SparkGroupBucket<T>[];
  /** Units without a group, in input order. */
  ungrouped: T[];
}

/** Split units into named groups plus the ungrouped remainder (pure). */
export function groupSparks<T extends Pick<SparkSnapshot, "group">>(sparks: readonly T[]): GroupedSparks<T> {
  const byName = new Map<string, T[]>();
  const ungrouped: T[] = [];
  for (const spark of sparks) {
    const name = groupOf(spark);
    if (!name) {
      ungrouped.push(spark);
      continue;
    }
    const bucket = byName.get(name);
    if (bucket) bucket.push(spark);
    else byName.set(name, [spark]);
  }
  return { groups: [...byName].map(([name, list]) => ({ name, sparks: list })), ungrouped };
}

export interface GroupSummary {
  total: number;
  online: number;
  /** GPU / unified memory in use (MB) across online units that report it; null when none does. */
  memUsedMb: number | null;
  /** Capacity (MB) of exactly the units counted in memUsedMb; null when unknown. */
  memTotalMb: number | null;
  /** Available, valid LLM endpoints across online units; null when no online unit reports its endpoints. */
  llmServing: number | null;
}

/**
 * Aggregate one group. Anything not measured stays null so the UI shows an em dash
 * rather than a fabricated zero (offline units contribute nothing to the sums).
 */
export function summarizeGroup(sparks: readonly SparkSnapshot[]): GroupSummary {
  const out: GroupSummary = { total: sparks.length, online: 0, memUsedMb: null, memTotalMb: null, llmServing: null };
  for (const spark of sparks) {
    if (!spark.online) continue;
    out.online += 1;
    const vram = spark.metrics?.gpu?.vram;
    const unified = spark.metrics?.unifiedMemory;
    const total = vram?.total || unified?.total || 0;
    const used = vram?.total ? vram.used : unified?.total ? unified.used : undefined;
    if (total > 0 && typeof used === "number" && Number.isFinite(used)) {
      out.memUsedMb = (out.memUsedMb ?? 0) + used;
      out.memTotalMb = (out.memTotalMb ?? 0) + total;
    }
    const llm = spark.metrics?.llm;
    if (Array.isArray(llm)) {
      out.llmServing = (out.llmServing ?? 0) + llm.filter((e) => e.available && e.measurementValid !== false).length;
    }
  }
  return out;
}
