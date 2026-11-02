import type { SiteGatewayDetail, SiteGatewayStatus, SiteGatewaySummary } from "../api/types";

export function gatewayStatus(overrides: Partial<SiteGatewayStatus> = {}): SiteGatewayStatus {
  return {
    siteId: "site-01", generatedAt: "2026-11-02T08:00:00.000Z", startedAt: null, uptimeSeconds: 7200, windowSeconds: 300,
    limits: { maxConcurrentPerKey: 16, rateLimitPerMinute: 120 },
    services: [
      { id: "deepseek-v41", kind: "llm", enabled: true, status: "ready", checkedAt: null,
        detail: { httpStatus: 200, ready: true, queueDepth: null, workerBusy: null, error: false } },
      { id: "media", kind: "media", enabled: true, status: "degraded", checkedAt: null,
        detail: { httpStatus: null, ready: null, queueDepth: 3, workerBusy: true, error: true } },
    ],
    traffic: {
      inflightTotal: 2,
      services: [{ service: "deepseek-v41", inflight: 2, requests: 40, status2xx: 37, status4xx: 2, status5xx: 1, rateLimited: 1, timeouts: 0,
        errorRate: 0.025, latencyMs: { p50: 2500, p95: 10000 } }],
      principals: [{ principal: "customer-a", service: "deepseek-v41", inflight: 2, requests: 40, status2xx: 37, status4xx: 2, status5xx: 1,
        rateLimited: 1, timeouts: 0 }],
    },
    history: [
      { ts: "2026-11-02T07:58:00.000Z", requests: 12, status5xx: 1, rateLimited: 2 },
      { ts: "2026-11-02T07:59:00.000Z", requests: 8, status5xx: null, rateLimited: null },
    ],
    ...overrides,
  };
}

export function gatewaySnapshot(overrides: Partial<SiteGatewayDetail> = {}): SiteGatewayDetail {
  return {
    id: "gz", name: "Guomao", url: "http://100.64.0.21:8200", source: "config",
    enabled: true, tokenConfigured: true, available: true, reachable: true, mode: "ops",
    generatedAt: "2026-11-02T08:00:00.000Z", error: null, status: gatewayStatus(), samples: [], ...overrides,
  };
}

/** A list card: an ops gateway with one of two backends not ready, unless overridden. */
export function gatewaySummary(overrides: Partial<SiteGatewaySummary> = {}): SiteGatewaySummary {
  return {
    id: "gz", name: "Guomao", url: "http://100.64.0.21:8200", source: "config", enabled: true, tokenConfigured: true,
    available: true, reachable: true, mode: "ops", generatedAt: new Date().toISOString(), error: null,
    servicesReady: 1, servicesTotal: 2, inflightTotal: 2, requests: 40, status5xx: 1, errorRate: 0.025, p95Ms: 10_000, windowSeconds: 300,
    ...overrides,
  };
}

/** What the server sends for a gateway it could not reach: no numbers, never zeros. */
export function unreachableSummary(overrides: Partial<SiteGatewaySummary> = {}): SiteGatewaySummary {
  return gatewaySummary({
    available: false, reachable: false, mode: "unavailable", error: "site-gateway-unreachable", generatedAt: null,
    servicesReady: null, servicesTotal: null, inflightTotal: null, requests: null, status5xx: null, errorRate: null, p95Ms: null, windowSeconds: null,
    ...overrides,
  });
}
