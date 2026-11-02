import assert from "node:assert/strict";
import test from "node:test";
import {
  SITE_GATEWAY_UNIT_ID, SiteGatewayStore, parseHealthz, parseStatus, siteGatewayAlertUnit, siteGatewayFindings, siteGatewayUrl,
} from "../SiteGatewayProbe.js";

const TOKEN = "ops-secret-token-value";

function statusPayload(overrides = {}) {
  return {
    object: "site_gateway.status", site_id: "site-01", generated_at: "2026-11-02T08:00:00+00:00",
    started_at: "2026-11-02T06:00:00+00:00", uptime_seconds: 7200, window_seconds: 300,
    limits: { max_concurrent_per_key: 16, rate_limit_requests_per_minute: 120 },
    services: [
      { id: "deepseek-v41", kind: "llm", enabled: true, status: "ready", checked_at: "2026-11-02T07:59:50+00:00",
        detail: { http_status: 200, status: "ok", ready: true, queue_depth: 0, worker_busy: false, error: false, upstream: "http://10.0.0.1" } },
      { id: "media", kind: "media", enabled: true, status: "degraded", checked_at: null, detail: { error: true } },
    ],
    traffic: {
      inflight_total: 2,
      services: [{ service: "deepseek-v41", inflight: 2, requests: 40, status_2xx: 37, status_4xx: 2, status_5xx: 1,
        rate_limited: 1, timeouts: 0, error_rate: 0.025, latency_ms: { p50: 2500, p95: 10000 } }],
      principals: [{ principal: "customer-a", service: "deepseek-v41", inflight: 2, requests: 40, status_2xx: 37,
        status_4xx: 2, status_5xx: 1, rate_limited: 1, timeouts: 0 }],
    },
    history: [{ ts: "2026-11-02T07:58:00+00:00", requests: 12, status_5xx: 0, rate_limited: 0 }],
    ...overrides,
  };
}

test("siteGatewayUrl accepts only private/Tailnet/loopback IP-literal origins", () => {
  for (const ok of ["http://100.64.0.21:8200", "http://127.0.0.1:8200/", "http://192.168.9.124:8200", "https://10.1.2.3",
    "http://172.16.0.5:8200", "http://[::1]:8200", "http://100.127.255.255:1"]) {
    assert.ok(siteGatewayUrl(ok), ok);
  }
  assert.equal(siteGatewayUrl("http://100.64.0.21:8200/"), "http://100.64.0.21:8200");
  for (const bad of ["http://8.8.8.8:8200", "http://karmabox-5e4a.local:8200", "http://100.128.0.1", "http://100.63.255.255",
    "http://user:pw@127.0.0.1", "http://127.0.0.1:8200/ops", "http://127.0.0.1:8200?x=1", "http://127.0.0.1:8200#f",
    "http://127.0.0.1:0", "http://127.0.0.1:70000", "ftp://127.0.0.1", "http://169.254.1.1", "", null, 5]) {
    assert.equal(siteGatewayUrl(bad), null, String(bad));
  }
});

test("parseStatus whitelists fields and keeps unknown as null", () => {
  const parsed = parseStatus(statusPayload());
  assert.equal(parsed.siteId, "site-01");
  assert.equal(parsed.windowSeconds, 300);
  assert.deepEqual(parsed.services[0].detail, { httpStatus: 200, ready: true, queueDepth: 0, workerBusy: false, error: false });
  assert.equal(parsed.services[1].status, "degraded");
  assert.equal(parsed.services[1].detail.queueDepth, null);
  assert.equal(parsed.traffic.services[0].latencyMs.p95, 10000);
  assert.equal(parsed.traffic.principals[0].principal, "customer-a");
  assert.equal(parsed.history[0].requests, 12);
  assert.doesNotMatch(JSON.stringify(parsed), /10\.0\.0\.1|upstream/);
});

test("parseStatus: no data is null, never zero; a zero-request window has no error rate", () => {
  const payload = statusPayload();
  payload.traffic.services = [{ service: "media", inflight: 0, requests: 0, status_2xx: 0, status_4xx: 0, status_5xx: 0,
    rate_limited: 0, timeouts: 0, error_rate: 0, latency_ms: null }];
  const parsed = parseStatus(payload);
  assert.equal(parsed.traffic.services[0].errorRate, null);
  assert.deepEqual(parsed.traffic.services[0].latencyMs, { p50: null, p95: null });
});

test("parseStatus rejects malformed documents and scrubs unsafe labels", () => {
  assert.equal(parseStatus(null), null);
  assert.equal(parseStatus({ ...statusPayload(), object: "other" }), null);
  assert.equal(parseStatus({ ...statusPayload(), window_seconds: 0 }), null);
  const bad = statusPayload();
  bad.traffic.services[0].requests = -1;
  assert.equal(parseStatus(bad), null);
  const secretNames = statusPayload();
  secretNames.traffic.principals[0].principal = "sk-abcdef0123456789";
  secretNames.traffic.principals.push({ ...secretNames.traffic.principals[0], principal: "10.1.2.3" });
  secretNames.traffic.principals.push({ ...secretNames.traffic.principals[0], principal: "http://x" });
  const parsed = parseStatus(secretNames);
  assert.deepEqual(parsed.traffic.principals.map((p) => p.principal), ["unknown", "unknown", "unknown"]);
  const huge = statusPayload();
  huge.traffic.services[0].requests = Number.MAX_SAFE_INTEGER;
  assert.equal(parseStatus(huge).traffic.services[0].requests, 1_000_000_000);
});

test("parseHealthz only accepts status ok", () => {
  assert.equal(parseHealthz({ status: "ok", service: "karmabox-site-gateway" }), true);
  assert.equal(parseHealthz({ status: "degraded" }), false);
  assert.equal(parseHealthz(null), false);
});

function makeStore({ token = TOKEN, url = "http://100.64.0.21:8200", handlers }) {
  let t = 1_000_000;
  const calls = [];
  const store = new SiteGatewayStore({
    url, token, now: () => t,
    read: async (target, opts) => {
      calls.push({ target, token: opts?.token });
      const handler = handlers(target);
      if (handler instanceof Error) throw handler;
      return handler;
    },
  });
  return { store, calls, advance: (ms) => { t += ms; } };
}

test("store: disabled without a URL, invalid for a public address, and neither polls", async () => {
  const none = makeStore({ url: "", handlers: () => { throw new Error("must not read"); } });
  await none.store.refreshIfDue();
  assert.equal(none.store.snapshot().enabled, false);
  assert.equal(none.calls.length, 0);
  const bad = makeStore({ url: "http://8.8.8.8", handlers: () => { throw new Error("must not read"); } });
  await bad.store.refreshIfDue();
  assert.equal(bad.store.enabled, true);
  assert.equal(bad.store.snapshot().error, "site-gateway-configuration-invalid");
  assert.equal(bad.calls.length, 0);
});

test("store: ops mode sends the token only to the ops endpoint and never exposes it", async () => {
  const { store, calls } = makeStore({ handlers: () => statusPayload() });
  assert.equal(store.snapshot().reachable, null, "unknown before the first check");
  await store.refreshIfDue();
  const snap = store.snapshot();
  assert.equal(snap.mode, "ops");
  assert.equal(snap.available, true);
  assert.equal(snap.reachable, true);
  assert.equal(snap.tokenConfigured, true);
  assert.equal(calls[0].target, "http://100.64.0.21:8200/ops/v1/status?window=5");
  assert.equal(calls[0].token, TOKEN);
  assert.doesNotMatch(JSON.stringify(snap), new RegExp(`${TOKEN}|100\\.64\\.0\\.21`));
  assert.equal(snap.samples.length, 1);
  assert.equal(snap.samples[0].requests, 40);
});

test("store: polls at most every 5 s and shares an in-flight read", async () => {
  const { store, calls, advance } = makeStore({ handlers: () => statusPayload() });
  await Promise.all([store.refreshIfDue(), store.refreshIfDue()]);
  await store.refreshIfDue();
  assert.equal(calls.length, 1);
  advance(5_000);
  await store.refreshIfDue();
  assert.equal(calls.length, 2);
});

test("store: no token means liveness only via /healthz", async () => {
  const { store, calls } = makeStore({ token: "", handlers: () => ({ status: "ok", service: "karmabox-site-gateway" }) });
  await store.refreshIfDue();
  const snap = store.snapshot();
  assert.equal(snap.mode, "liveness");
  assert.equal(snap.available, true);
  assert.equal(snap.status, null);
  assert.equal(snap.tokenConfigured, false);
  assert.equal(snap.error, null);
  assert.deepEqual(calls.map((c) => c.target), ["http://100.64.0.21:8200/healthz"]);
  assert.equal(calls[0].token, undefined);
  assert.equal(siteGatewayFindings(snap).length, 0);
});

test("store: ops failure falls back to liveness and says so", async () => {
  const { store } = makeStore({ handlers: (target) => (target.includes("/ops/") ? new Error("401") : { status: "ok" }) });
  await store.refreshIfDue();
  const snap = store.snapshot();
  assert.equal(snap.mode, "liveness");
  assert.equal(snap.error, "site-gateway-ops-unavailable");
  assert.equal(snap.status, null);
});

test("store: unreachable, then stale data is dropped, then recovery", async () => {
  let up = true;
  const { store, advance } = makeStore({ handlers: () => (up ? statusPayload() : new Error("down")) });
  await store.refreshIfDue();
  assert.equal(store.snapshot().available, true);
  up = false;
  advance(5_000);
  await store.refreshIfDue();
  // The last good sample is younger than 30 s, but the newest attempt failed.
  assert.equal(store.snapshot().mode, "unavailable");
  assert.equal(store.snapshot().reachable, false);
  assert.equal(store.snapshot().status, null);
  assert.equal(store.snapshot().error, "site-gateway-unreachable");
  advance(40_000);
  assert.equal(store.snapshot().available, false);
  up = true;
  await store.refreshIfDue();
  assert.equal(store.snapshot().mode, "ops");
});

test("store: a malformed ops document is not trusted and not shown as zero", async () => {
  const { store } = makeStore({ handlers: (target) => (target.includes("/ops/") ? { object: "site_gateway.status" } : { status: "ok" }) });
  await store.refreshIfDue();
  const snap = store.snapshot();
  assert.equal(snap.mode, "liveness");
  assert.equal(snap.status, null);
});

test("store: trend samples are one per 30 s and bounded", async () => {
  const { store, advance } = makeStore({ handlers: () => statusPayload() });
  for (let i = 0; i < 400; i += 1) {
    await store.refresh();
    advance(10_000);
  }
  const { samples } = store.snapshot();
  assert.equal(samples.length, 120);
  const gaps = samples.slice(1).map((s, i) => Date.parse(s.t) - Date.parse(samples[i].t));
  assert.ok(gaps.every((gap) => gap >= 30_000));
});

test("findings: degraded backend, 5xx rate with a request floor, sustained 429", () => {
  const base = { available: true, mode: "ops" };
  const payload = statusPayload();
  assert.deepEqual(siteGatewayFindings({ ...base, status: parseStatus(payload) }).map((f) => f.id), ["sitegw-degraded"]);

  const noisy = statusPayload();
  noisy.traffic.services[0] = { ...noisy.traffic.services[0], requests: 9, status_5xx: 9, error_rate: 1, rate_limited: 0 };
  assert.ok(!siteGatewayFindings({ ...base, status: parseStatus(noisy) }).some((f) => f.id === "sitegw-errors"), "under 10 requests is not judged");

  const failing = statusPayload();
  failing.traffic.services[0] = { ...failing.traffic.services[0], requests: 10, status_5xx: 3, error_rate: 0.3, rate_limited: 5 };
  const ids = siteGatewayFindings({ ...base, status: parseStatus(failing) }).map((f) => f.id);
  assert.deepEqual(ids, ["sitegw-degraded", "sitegw-errors", "sitegw-ratelimit"]);

  const exactly = statusPayload();
  exactly.traffic.services[0] = { ...exactly.traffic.services[0], requests: 10, status_5xx: 2, error_rate: 0.2, rate_limited: 4 };
  assert.deepEqual(siteGatewayFindings({ ...base, status: parseStatus(exactly) }).map((f) => f.id), ["sitegw-degraded"], "thresholds are strict / inclusive as documented");

  assert.deepEqual(siteGatewayFindings({ available: false, mode: "ops", status: null }), []);
  assert.deepEqual(siteGatewayFindings(null), []);
});

test("alert unit: absent when disabled or not yet checked, offline when unreachable", () => {
  assert.equal(siteGatewayAlertUnit({ enabled: false, reachable: null }), null);
  assert.equal(siteGatewayAlertUnit({ enabled: true, reachable: null }), null);
  const down = siteGatewayAlertUnit({ enabled: true, reachable: false });
  assert.equal(down.id, SITE_GATEWAY_UNIT_ID);
  assert.equal(down.online, false);
  assert.match(down.offlineReason, /unreachable/);
  const up = siteGatewayAlertUnit({ enabled: true, reachable: true, available: true, mode: "ops", status: parseStatus(statusPayload()) });
  assert.equal(up.online, true);
  assert.equal(up.health[0].id, "sitegw-degraded");
});
