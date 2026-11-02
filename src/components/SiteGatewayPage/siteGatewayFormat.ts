import type { SiteGatewayServiceStatus, SiteGatewaySnapshot } from "../../api/types";
import type { TagTone } from "../ui/Tag";
import type { BarBucket } from "../ui/StackedBarChart";

/** Unknown is shown as an em dash, never as 0. */
export const UNKNOWN = "—";

export function fmtCount(value: number | null | undefined): string {
  return typeof value === "number" && Number.isFinite(value) ? String(value) : UNKNOWN;
}

export function fmtPercent(ratio: number | null | undefined): string {
  if (typeof ratio !== "number" || !Number.isFinite(ratio)) return UNKNOWN;
  const pct = ratio * 100;
  return `${pct > 0 && pct < 1 ? "<1" : Math.round(pct)}%`;
}

export function fmtLatency(ms: number | null | undefined): string {
  if (typeof ms !== "number" || !Number.isFinite(ms)) return UNKNOWN;
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`;
}

export function fmtUptime(seconds: number | null | undefined): string {
  if (typeof seconds !== "number" || !Number.isFinite(seconds)) return UNKNOWN;
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return days > 0 ? `${days}d ${hours}h` : hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
}

export const SERVICE_TONE: Record<SiteGatewayServiceStatus, TagTone> = {
  ready: "good",
  degraded: "bad",
  disabled: "neutral",
  unknown: "warn",
};

export interface GatewayHeadline {
  tone: TagTone;
  text: string;
}

/** One line on what the dashboard actually knows. */
export function gatewayHeadline(snapshot: SiteGatewaySnapshot | null, failed: boolean): GatewayHeadline {
  if (failed || !snapshot) return { tone: "warn", text: "Status unknown" };
  if (snapshot.reachable == null) return { tone: "neutral", text: "Checking…" };
  if (!snapshot.available) return { tone: "bad", text: "Unreachable" };
  if (snapshot.mode === "liveness") return { tone: "good", text: "Alive (liveness only)" };
  const services = snapshot.status?.services ?? [];
  const degraded = services.filter((s) => s.enabled && s.status === "degraded").length;
  return degraded > 0
    ? { tone: "bad", text: `${degraded} backend${degraded === 1 ? "" : "s"} degraded` }
    : { tone: "good", text: "All backends ready" };
}

/** Per-minute buckets for the trend chart: 5xx, 429 and the rest of the requests. */
export function trendBuckets(snapshot: SiteGatewaySnapshot | null): BarBucket[] {
  const history = snapshot?.status?.history ?? [];
  return history.map((point) => {
    const when = new Date(point.ts);
    const label = when.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
    const status5xx = point.status5xx ?? 0;
    const rateLimited = point.rateLimited ?? 0;
    return {
      key: point.ts,
      label,
      title: label,
      values: {
        status5xx,
        rateLimited,
        other: Math.max(0, point.requests - status5xx - rateLimited),
      },
    };
  });
}
