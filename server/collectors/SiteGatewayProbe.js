import { isIP } from "node:net";

/**
 * KarmaBox Site Gateway monitoring.
 *
 * Reads the gateway's read-only ops endpoint (`GET /ops/v1/status`, a separate
 * monitoring key) and, when that is unavailable or no key is configured, falls
 * back to the unauthenticated `GET /healthz` so a bare URL still gives liveness.
 * URL and token are server-side configuration only: the token is never part of
 * a snapshot, a log line or an error message.
 */

const POLL_INTERVAL_MS = 5_000;
const SOURCE_MAX_AGE_MS = 30_000;
const MAX_BODY_BYTES = 256 * 1024;
const TIMEOUT_MS = 5_000;
const WINDOW_MINUTES = 5;
const MAX_SERVICES = 64;
const MAX_PRINCIPALS = 256;
const MAX_HISTORY = 60;
const MAX_COUNT = 1_000_000_000;
const MAX_LATENCY_MS = 24 * 60 * 60_000;
const SAMPLE_EVERY_MS = 30_000;
const SAMPLE_RETENTION = 120;

export const ERROR_RATE_MIN_REQUESTS = 10;
export const ERROR_RATE_THRESHOLD = 0.2;
export const RATE_LIMITED_THRESHOLD = 5;

const SERVICE_STATUSES = new Set(["ready", "degraded", "disabled", "unknown"]);
const LABEL_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;

function looksSecret(value) {
  return /^(?:sk[-_]|bearer(?:[-_ ]|$)|eyJ)/i.test(value) || /^[a-f0-9]{32,}$/i.test(value);
}

/** A display label that is neither a secret, an address nor a URL; otherwise "unknown". */
function label(value) {
  return typeof value === "string" && LABEL_RE.test(value) && !isIP(value) && !looksSecret(value) ? value : "unknown";
}

function isTailnet(octets) {
  return octets[0] === 100 && octets[1] >= 64 && octets[1] <= 127;
}

/**
 * Base URL of the gateway: an IP literal in loopback, RFC1918 or Tailnet
 * (100.64.0.0/10) space, origin only. No DNS, credentials, query, fragment or path.
 * @returns {string|null} origin without trailing slash
 */
export function siteGatewayUrl(raw) {
  if (typeof raw !== "string" || raw.length > 2048 || /[\\?#@]/.test(raw)) return null;
  const text = raw.trim();
  const match = /^(https?):\/\/(\[[^\]]+\]|[^/:]+)(?::(\d{1,5}))?\/?$/.exec(text);
  if (!match) return null;
  const host = match[2].replace(/^\[|\]$/g, "");
  const version = isIP(host);
  const octets = version === 4 ? host.split(".").map(Number) : [];
  const allowed = host === "::1" || (version === 4 && (
    octets[0] === 127 || octets[0] === 10 || isTailnet(octets) ||
    (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) ||
    (octets[0] === 192 && octets[1] === 168)
  ));
  if (!allowed) return null;
  if (match[3] !== undefined && (Number(match[3]) < 1 || Number(match[3]) > 65535)) return null;
  try {
    const url = new URL(text);
    return url.username || url.password ? null : url.origin;
  } catch {
    return null;
  }
}

/** GET one JSON document: bounded time and size, no redirects, JSON content type. */
export async function readJson(url, { token } = {}) {
  const headers = { Accept: "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS), redirect: "error", headers });
  if (!response.ok || !/^application\/(?:[\w.+-]+\+)?json(?:\s*;|$)/i.test(response.headers.get("content-type") || "") ||
    Number(response.headers.get("content-length")) > MAX_BODY_BYTES || !response.body) {
    await response.body?.cancel();
    throw new Error("site-gateway-source-unavailable");
  }
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY_BYTES) {
        await reader.cancel();
        throw new Error("site-gateway-source-unavailable");
      }
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } finally {
    reader.releaseLock();
  }
}

const isObject = (value) => value != null && typeof value === "object" && !Array.isArray(value);
const count = (value) => Number.isSafeInteger(value) && value >= 0 ? Math.min(value, MAX_COUNT) : null;
const ms = (value) => typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.min(value, MAX_LATENCY_MS) : null;
const isoOrNull = (value) => typeof value === "string" && Number.isFinite(Date.parse(value)) ? new Date(Date.parse(value)).toISOString() : null;

function parseDetail(detail) {
  const out = { httpStatus: null, ready: null, queueDepth: null, workerBusy: null, error: false };
  if (!isObject(detail)) return out;
  if (Number.isInteger(detail.http_status) && detail.http_status >= 100 && detail.http_status <= 599) out.httpStatus = detail.http_status;
  if (typeof detail.ready === "boolean") out.ready = detail.ready;
  out.queueDepth = count(detail.queue_depth);
  if (typeof detail.worker_busy === "boolean") out.workerBusy = detail.worker_busy;
  out.error = detail.error === true;
  return out;
}

function parseCounters(entry) {
  const requests = count(entry.requests);
  if (requests == null) return null;
  const out = {
    requests,
    inflight: count(entry.inflight) ?? 0,
    status2xx: count(entry.status_2xx) ?? 0,
    status4xx: count(entry.status_4xx) ?? 0,
    status5xx: count(entry.status_5xx) ?? 0,
    rateLimited: count(entry.rate_limited) ?? 0,
    timeouts: count(entry.timeouts) ?? 0,
  };
  return out;
}

/**
 * Whitelist and bound the ops status document.
 * Anything structurally wrong makes the whole sample invalid (null); an unsafe
 * display string becomes "unknown"; unknown numbers stay null, never 0.
 */
export function parseStatus(payload) {
  if (!isObject(payload) || payload.object !== "site_gateway.status" ||
    !Array.isArray(payload.services) || !isObject(payload.traffic) ||
    !Array.isArray(payload.traffic.services) || !Array.isArray(payload.traffic.principals)) return null;
  const windowSeconds = count(payload.window_seconds);
  if (windowSeconds == null || windowSeconds < 1) return null;

  const services = [];
  for (const item of payload.services.slice(0, MAX_SERVICES)) {
    if (!isObject(item) || label(item.id) === "unknown") return null;
    services.push({
      id: item.id,
      kind: label(item.kind),
      enabled: item.enabled !== false,
      status: SERVICE_STATUSES.has(item.status) ? item.status : "unknown",
      checkedAt: isoOrNull(item.checked_at),
      detail: parseDetail(item.detail),
    });
  }

  const trafficServices = [];
  for (const item of payload.traffic.services.slice(0, MAX_SERVICES)) {
    if (!isObject(item) || label(item.service) === "unknown") return null;
    const counters = parseCounters(item);
    if (!counters) return null;
    const errorRate = typeof item.error_rate === "number" && Number.isFinite(item.error_rate) && item.error_rate >= 0 && item.error_rate <= 1
      ? item.error_rate : null;
    const latency = isObject(item.latency_ms)
      ? { p50: ms(item.latency_ms.p50), p95: ms(item.latency_ms.p95) } : { p50: null, p95: null };
    trafficServices.push({ service: item.service, ...counters, errorRate: counters.requests > 0 ? errorRate : null, latencyMs: latency });
  }

  const principals = [];
  for (const item of payload.traffic.principals.slice(0, MAX_PRINCIPALS)) {
    if (!isObject(item) || label(item.service) === "unknown") return null;
    const counters = parseCounters(item);
    if (!counters) return null;
    principals.push({ principal: label(item.principal), service: item.service, ...counters });
  }

  const history = [];
  for (const item of Array.isArray(payload.history) ? payload.history.slice(-MAX_HISTORY) : []) {
    if (!isObject(item)) continue;
    const ts = isoOrNull(item.ts);
    const requests = count(item.requests);
    if (!ts || requests == null) continue;
    history.push({ ts, requests, status5xx: count(item.status_5xx), rateLimited: count(item.rate_limited) });
  }

  const limits = isObject(payload.limits) ? {
    maxConcurrentPerKey: count(payload.limits.max_concurrent_per_key),
    rateLimitPerMinute: count(payload.limits.rate_limit_requests_per_minute),
  } : { maxConcurrentPerKey: null, rateLimitPerMinute: null };

  return {
    siteId: label(payload.site_id),
    generatedAt: isoOrNull(payload.generated_at),
    startedAt: isoOrNull(payload.started_at),
    uptimeSeconds: count(payload.uptime_seconds),
    windowSeconds,
    limits,
    services,
    traffic: { inflightTotal: count(payload.traffic.inflight_total), services: trafficServices, principals },
    history,
  };
}

/** `/healthz` of the gateway: only `status: "ok"` counts as alive. */
export function parseHealthz(payload) {
  return isObject(payload) && payload.status === "ok";
}

/**
 * Health findings (same shape as server/health findings) from a snapshot.
 * Only judged on fresh ops data: liveness-only or stale data raises nothing here.
 */
export function siteGatewayFindings(snapshot) {
  if (!snapshot?.available || snapshot.mode !== "ops" || !snapshot.status) return [];
  const findings = [];
  const { services, traffic, windowSeconds } = snapshot.status;
  const minutes = Math.max(1, Math.round(windowSeconds / 60));
  const degraded = services.filter((s) => s.enabled && s.status === "degraded").map((s) => s.id);
  if (degraded.length) {
    findings.push({
      id: "sitegw-degraded", severity: "warning", title: "Site Gateway backend degraded",
      detail: `Degraded backend${degraded.length > 1 ? "s" : ""}: ${degraded.slice(0, 8).join(", ")}${degraded.length > 8 ? ", …" : ""}`,
    });
  }
  const failing = traffic.services.filter((s) => s.requests >= ERROR_RATE_MIN_REQUESTS && s.errorRate != null && s.errorRate > ERROR_RATE_THRESHOLD);
  if (failing.length) {
    findings.push({
      id: "sitegw-errors", severity: "critical", title: "Site Gateway 5xx error rate high",
      detail: failing.slice(0, 8).map((s) => `${s.service} ${Math.round(s.errorRate * 100)}% of ${s.requests}`).join(", ") + ` in ${minutes} min`,
    });
  }
  const limited = traffic.services.reduce((sum, s) => sum + s.rateLimited, 0);
  if (limited >= RATE_LIMITED_THRESHOLD) {
    findings.push({
      id: "sitegw-ratelimit", severity: "warning", title: "Site Gateway rate limiting callers",
      detail: `${limited} request${limited === 1 ? "" : "s"} answered 429 in ${minutes} min`,
    });
  }
  return findings;
}

/**
 * The gateway as a pseudo-unit for the alert engine, which only knows units:
 * "offline" is the gateway being unreachable, its findings ride on `health`.
 * Null when monitoring is not configured, so its alerts end with the setting.
 * Its id doubles as the Site Gateway page id, so a click on an alert opens the page.
 */
export const SITE_GATEWAY_UNIT_ID = "__site_gateway__";

export function siteGatewayAlertUnit(snapshot) {
  if (!snapshot?.enabled || snapshot.reachable == null) return null;
  return {
    id: SITE_GATEWAY_UNIT_ID,
    name: "Site Gateway",
    online: snapshot.reachable === true,
    offlineReason: snapshot.reachable === true ? null : "Site Gateway unreachable",
    metrics: {},
    health: siteGatewayFindings(snapshot),
  };
}

export class SiteGatewayStore {
  constructor({ url = process.env.SPARKDASH_SITEGW_URL, token = process.env.SPARKDASH_SITEGW_TOKEN,
    read = readJson, now = () => Date.now() } = {}) {
    this.enabled = typeof url === "string" && url.trim() !== "";
    this.base = siteGatewayUrl(url);
    this.token = typeof token === "string" && token.trim() !== "" ? token.trim() : null;
    this.read = read;
    this.now = now;
    this.status = null;
    this.mode = null;
    this.lastOkMs = null;
    this.lastAttemptMs = null;
    this.error = this.enabled && !this.base ? "site-gateway-configuration-invalid" : null;
    this.lastPollMs = -Infinity;
    this.inflight = null;
    this.samples = [];
    this.lastSampleMs = -Infinity;
  }

  async refreshIfDue() {
    if (!this.enabled || !this.base) return;
    if (this.inflight) return this.inflight;
    if (this.now() - this.lastPollMs < POLL_INTERVAL_MS) return;
    this.lastPollMs = this.now();
    this.inflight = this.refresh().finally(() => { this.inflight = null; });
    return this.inflight;
  }

  async refresh() {
    const at = this.now();
    this.lastAttemptMs = at;
    let opsFailed = false;
    if (this.token) {
      try {
        const parsed = parseStatus(await this.read(`${this.base}/ops/v1/status?window=${WINDOW_MINUTES}`, { token: this.token }));
        if (parsed) {
          this.status = parsed;
          this.mode = "ops";
          this.lastOkMs = at;
          this.error = null;
          this.record(at);
          return;
        }
      } catch {
        // fall through to the liveness probe
      }
      opsFailed = true;
    }
    try {
      if (parseHealthz(await this.read(`${this.base}/healthz`, {}))) {
        this.status = null;
        this.mode = "liveness";
        this.lastOkMs = at;
        this.error = opsFailed ? "site-gateway-ops-unavailable" : null;
        this.record(at);
        return;
      }
    } catch {
      // unreachable
    }
    this.status = null;
    this.mode = "unavailable";
    this.error = "site-gateway-unreachable";
    this.record(at);
  }

  /** One trend sample every 30 s, newest last, bounded. Unknown fields stay null. */
  record(at) {
    if (at - this.lastSampleMs < SAMPLE_EVERY_MS) return;
    this.lastSampleMs = at;
    const reachable = this.mode === "ops" || this.mode === "liveness";
    const sample = { t: new Date(at).toISOString(), reachable, requests: null, status5xx: null, rateLimited: null, inflight: null, degraded: null };
    if (this.mode === "ops" && this.status) {
      const rows = this.status.traffic.services;
      sample.requests = rows.reduce((sum, s) => sum + s.requests, 0);
      sample.status5xx = rows.reduce((sum, s) => sum + s.status5xx, 0);
      sample.rateLimited = rows.reduce((sum, s) => sum + s.rateLimited, 0);
      sample.inflight = this.status.traffic.inflightTotal;
      sample.degraded = this.status.services.filter((s) => s.enabled && s.status === "degraded").length;
    }
    this.samples.push(sample);
    if (this.samples.length > SAMPLE_RETENTION) this.samples.splice(0, this.samples.length - SAMPLE_RETENTION);
  }

  snapshot() {
    const nowMs = this.now();
    const fresh = this.enabled && this.lastOkMs != null && nowMs - this.lastOkMs <= SOURCE_MAX_AGE_MS;
    const mode = fresh ? this.mode : this.enabled && this.lastAttemptMs != null ? "unavailable" : null;
    const available = fresh && (this.mode === "ops" || this.mode === "liveness");
    const out = {
      enabled: this.enabled,
      tokenConfigured: this.token != null,
      available,
      // null until the first poll has finished: unknown, not "down".
      reachable: !this.enabled ? null : available ? true : this.lastAttemptMs != null ? false : null,
      mode,
      generatedAt: available && this.lastOkMs != null ? new Date(this.lastOkMs).toISOString() : null,
      error: this.enabled ? (available ? this.error : this.error ?? (this.lastAttemptMs != null ? "site-gateway-unreachable" : null)) : null,
      status: available && this.mode === "ops" ? this.status : null,
      samples: this.enabled ? this.samples.slice() : [],
    };
    return out;
  }
}
