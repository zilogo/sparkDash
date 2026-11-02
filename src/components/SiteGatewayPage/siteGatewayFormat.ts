import type { SiteGatewayServiceStatus, SiteGatewaySnapshot, SiteGatewaySummary, SiteGatewayTestResult } from "../../api/types";
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

/** One line on what the dashboard knows about a gateway from its list entry. */
export function summaryState(summary: SiteGatewaySummary, failed: boolean): GatewayHeadline {
  if (failed) return { tone: "warn", text: "Status unknown" };
  if (summary.error === "site-gateway-configuration-invalid") return { tone: "bad", text: "Invalid URL" };
  if (summary.reachable == null) return { tone: "neutral", text: "Checking…" };
  if (!summary.available) return { tone: "bad", text: "Unreachable" };
  if (summary.mode === "liveness") return { tone: "warn", text: "Liveness only" };
  const { servicesReady: ready, servicesTotal: total } = summary;
  if (ready == null || total == null) return { tone: "warn", text: "Status unknown" };
  return ready === total ? { tone: "good", text: "Ready" } : { tone: "bad", text: `${total - ready} of ${total} not ready` };
}

/** host:port of a gateway URL for display; the raw string when it does not parse. */
export function hostPort(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

export function fmtAgo(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return UNKNOWN;
  const seconds = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (!Number.isFinite(seconds)) return UNKNOWN;
  return seconds < 60 ? `${seconds}s ago` : seconds < 3600 ? `${Math.round(seconds / 60)}m ago` : `${Math.round(seconds / 3600)}h ago`;
}

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

/**
 * Mirrors the server's rule (siteGatewayUrl): http(s)://<IP>[:port], origin only, with an address in
 * loopback, private or Tailnet space. Returns a message, or null when the URL is acceptable.
 * The server stays the authority; this only keeps Save disabled for the obvious mistakes.
 */
export function gatewayUrlProblem(raw: string): string | null {
  const text = raw.trim();
  if (!text) return "Enter the gateway URL, for example http://100.64.0.21:8200";
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return "Not a valid URL. Use http://<IP>:<port>";
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return "Use http:// or https://";
  if (url.username || url.password || url.search || url.hash || (url.pathname !== "/" && url.pathname !== "")) {
    return "Give only the address and port: no credentials, path or query";
  }
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (host === "::1") return null;
  const m = IPV4.exec(host);
  if (!m) return "Use an IP address (loopback, private or Tailnet), not a host name";
  const [a, b, c, d] = m.slice(1).map(Number);
  if ([a, b, c, d].some((n) => n > 255)) return "Not a valid IP address";
  const allowed = a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  return allowed ? null : "Only loopback, private (10/172.16/192.168) and Tailnet (100.64/10) addresses are allowed";
}

/** What the Test connection button says. */
export function describeTestResult(result: SiteGatewayTestResult): { tone: TagTone; text: string } {
  if (result.ok && result.mode === "ops") {
    const backends = result.services == null ? "" : `, ${result.services} backend${result.services === 1 ? "" : "s"}`;
    return { tone: "good", text: `Connected with the ops key (site ${result.siteId ?? UNKNOWN}${backends})` };
  }
  if (result.ok) {
    return result.error === "site-gateway-ops-unavailable"
      ? { tone: "warn", text: "Reachable, but the ops status did not accept this key (wrong key, or the gateway has no /ops endpoint yet). Only liveness will be monitored." }
      : { tone: "warn", text: "Reachable (liveness only). Add the gateway's ops key to see backends and traffic." };
  }
  if (result.error === "site-gateway-url-invalid") return { tone: "bad", text: "The server rejected this URL (only loopback, private and Tailnet IP addresses are allowed)." };
  return { tone: "bad", text: "The gateway did not answer. Check the address, the port and that the dashboard server can reach it." };
}
