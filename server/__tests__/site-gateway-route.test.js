import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { isolatedConfigEnv } from "./isolatedEnv.js";

const OPS_TOKEN = "ops-test-token-private";

async function listening(server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return server.address().port;
}

function statusBody() {
  return {
    object: "site_gateway.status", site_id: "site-01", generated_at: new Date().toISOString(),
    started_at: new Date(Date.now() - 3600_000).toISOString(), uptime_seconds: 3600, window_seconds: 300,
    limits: { max_concurrent_per_key: 16, rate_limit_requests_per_minute: 120 },
    services: [
      { id: "deepseek-v41", kind: "llm", enabled: true, status: "ready", checked_at: new Date().toISOString(), detail: { http_status: 200 } },
      { id: "media", kind: "media", enabled: true, status: "degraded", checked_at: null, detail: { error: true } },
    ],
    traffic: {
      inflight_total: 1,
      services: [{ service: "deepseek-v41", inflight: 1, requests: 20, status_2xx: 19, status_4xx: 0, status_5xx: 1,
        rate_limited: 0, timeouts: 0, error_rate: 0.05, latency_ms: { p50: 1000, p95: 2500 } }],
      principals: [{ principal: "customer-a", service: "deepseek-v41", inflight: 1, requests: 20, status_2xx: 19,
        status_4xx: 0, status_5xx: 1, rate_limited: 0, timeouts: 0 }],
    },
    history: [],
    secret_extra: "private-field", upstream: "http://10.9.9.9:1234",
  };
}

test("site gateway route: dashboard auth, ops key stays server-side, liveness fallback, /metrics export", { timeout: 40000 }, async (t) => {
  const seen = { ops: [], healthz: [] };
  const gateway = createServer((req, res) => {
    const json = (code, body) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(body)); };
    if (req.url === "/healthz") { seen.healthz.push(req.headers.authorization); return json(200, { status: "ok", service: "karmabox-site-gateway" }); }
    if (req.url.startsWith("/ops/v1/status")) {
      seen.ops.push(req.headers.authorization);
      return req.headers.authorization === `Bearer ${OPS_TOKEN}` ? json(200, statusBody()) : json(401, { detail: "no" });
    }
    return json(404, {});
  });
  const gatewayPort = await listening(gateway);
  t.after(() => { gateway.closeAllConnections(); gateway.close(); });

  const variants = [
    { name: "off", env: { SPARKDASH_SITEGW_URL: "" } },
    { name: "ops", env: { SPARKDASH_SITEGW_URL: `http://127.0.0.1:${gatewayPort}`, SPARKDASH_SITEGW_TOKEN: OPS_TOKEN } },
    { name: "liveness", env: { SPARKDASH_SITEGW_URL: `http://127.0.0.1:${gatewayPort}`, SPARKDASH_SITEGW_TOKEN: "" } },
    { name: "wrong-key", env: { SPARKDASH_SITEGW_URL: `http://127.0.0.1:${gatewayPort}`, SPARKDASH_SITEGW_TOKEN: "wrong-key-value" } },
  ];
  for (const variant of variants) {
    const tmp = await mkdtemp(path.join(os.tmpdir(), "sparkdash-sitegw-"));
    const sparksPath = path.join(tmp, "sparks.json");
    await writeFile(sparksPath, '{"sparks":[]}\n');
    const reservation = createServer();
    const port = await listening(reservation);
    await new Promise((resolve) => reservation.close(resolve));
    const child = spawn(process.execPath, ["server/index.js"], {
      cwd: path.resolve(import.meta.dirname, "../.."),
      env: { ...process.env, ...isolatedConfigEnv(tmp), PORT: String(port), BIND_HOST: "0.0.0.0", SPARKS_JSON_PATH: sparksPath,
        SPARKDASH_TOKEN: "dashboard-test-token", ...variant.env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    try {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("isolated dashboard did not start")), 10000);
        child.once("exit", () => { clearTimeout(timer); reject(new Error("isolated dashboard exited before startup")); });
        child.stdout.on("data", (data) => { if (String(data).includes("server listening")) { clearTimeout(timer); resolve(); } });
      });
      const base = `http://127.0.0.1:${port}`;
      const headers = { Authorization: "Bearer dashboard-test-token" };
      assert.equal((await fetch(`${base}/api/site-gateway`)).status, 401);
      assert.equal((await fetch(`${base}/api/site-gateway`, { headers: { Authorization: "Bearer wrong" } })).status, 401);
      const response = await fetch(`${base}/api/site-gateway`, { headers });
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("cache-control"), "no-store");
      const body = await response.json();
      const text = JSON.stringify(body);
      assert.doesNotMatch(text, /ops-test-token|wrong-key-value|dashboard-test-token|private-field|10\.9\.9\.9|127\.0\.0\.1/);

      if (variant.name === "off") {
        assert.equal(body.enabled, false);
        assert.equal(body.available, false);
        assert.equal(body.reachable, null);
      } else if (variant.name === "ops") {
        assert.equal(body.mode, "ops");
        assert.equal(body.available, true);
        assert.equal(body.tokenConfigured, true);
        assert.equal(body.status.services.length, 2);
        assert.equal(body.status.traffic.services[0].latencyMs.p95, 2500);
        assert.equal(body.status.traffic.principals[0].principal, "customer-a");
      } else {
        assert.equal(body.mode, "liveness");
        assert.equal(body.status, null);
        assert.equal(body.reachable, true);
        assert.equal(body.error, variant.name === "wrong-key" ? "site-gateway-ops-unavailable" : null);
      }

      const settings = await (await fetch(`${base}/api/settings`, { headers })).json();
      assert.equal(settings.siteGatewayEnabled, variant.name !== "off");
      const put = await (await fetch(`${base}/api/settings`, {
        method: "PUT", headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ siteGatewayEnabled: variant.name === "off", SPARKDASH_SITEGW_URL: "http://8.8.8.8" }),
      })).json();
      assert.equal(put.siteGatewayEnabled, variant.name !== "off");

      await fetch(`${base}/api/settings`, {
        method: "PUT", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify({ prometheusExport: true }),
      });
      const metrics = await (await fetch(`${base}/metrics`, { headers })).text();
      if (variant.name === "off") {
        assert.doesNotMatch(metrics, /sparkdash_sitegw/);
      } else {
        assert.match(metrics, /^sparkdash_sitegw_up 1$/m);
        if (variant.name === "ops") {
          assert.match(metrics, /^sparkdash_sitegw_service_up\{service="deepseek-v41"\} 1$/m);
          assert.match(metrics, /^sparkdash_sitegw_service_up\{service="media"\} 0$/m);
          assert.match(metrics, /^sparkdash_sitegw_requests\{service="deepseek-v41",class="5xx"\} 1$/m);
          assert.match(metrics, /^sparkdash_sitegw_latency_p95_seconds\{service="deepseek-v41"\} 2.5$/m);
        } else {
          assert.doesNotMatch(metrics, /sparkdash_sitegw_service_up|sparkdash_sitegw_requests/);
        }
      }
    } finally {
      if (child.exitCode == null) {
        const exited = once(child, "exit");
        child.kill("SIGTERM");
        await exited;
      }
      await rm(tmp, { recursive: true, force: true });
    }
  }
  // The ops key reaches only the ops endpoint; /healthz is always unauthenticated.
  assert.ok(seen.ops.every((value) => value === `Bearer ${OPS_TOKEN}` || value === "Bearer wrong-key-value"));
  assert.ok(seen.healthz.every((value) => value === undefined));
});
