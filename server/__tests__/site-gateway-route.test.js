import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { isolatedConfigEnv } from "./isolatedEnv.js";

const OPS_TOKEN = "ops-test-token-private";
const DASH = "dashboard-test-token";

async function listening(server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return server.address().port;
}

function statusBody(siteId = "site-01") {
  return {
    object: "site_gateway.status", site_id: siteId, generated_at: new Date().toISOString(),
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

async function fakeGateway(t, siteId, seen = []) {
  const gateway = createServer((req, res) => {
    const json = (code, body) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(body)); };
    seen.push({ url: req.url, auth: req.headers.authorization });
    if (req.url === "/healthz") return json(200, { status: "ok", service: "karmabox-site-gateway" });
    if (req.url.startsWith("/ops/v1/status")) {
      return req.headers.authorization === `Bearer ${OPS_TOKEN}` ? json(200, statusBody(siteId)) : json(401, { detail: "no" });
    }
    return json(404, {});
  });
  const port = await listening(gateway);
  t.after(() => { gateway.closeAllConnections(); gateway.close(); });
  return port;
}

async function startDashboard(t, env = {}) {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "sparkdash-sitegw-"));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const sparksPath = path.join(tmp, "sparks.json");
  await writeFile(sparksPath, '{"sparks":[]}\n');
  const reservation = createServer();
  const port = await listening(reservation);
  await new Promise((resolve) => reservation.close(resolve));
  const config = isolatedConfigEnv(tmp);
  const child = spawn(process.execPath, ["server/index.js"], {
    cwd: path.resolve(import.meta.dirname, "../.."),
    env: { ...process.env, ...config, PORT: String(port), BIND_HOST: "0.0.0.0", SPARKS_JSON_PATH: sparksPath, SPARKDASH_TOKEN: DASH, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (d) => { output += d; });
  child.stderr.on("data", (d) => { output += d; });
  t.after(async () => {
    if (child.exitCode == null) {
      const exited = once(child, "exit");
      child.kill("SIGTERM");
      await exited;
    }
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("isolated dashboard did not start")), 10000);
    child.once("exit", () => { clearTimeout(timer); reject(new Error("isolated dashboard exited before startup")); });
    child.stdout.on("data", (data) => { if (String(data).includes("server listening")) { clearTimeout(timer); resolve(); } });
  });
  const base = `http://127.0.0.1:${port}`;
  const api = async (method, url, body, headers = { Authorization: `Bearer ${DASH}` }) => {
    const res = await fetch(`${base}${url}`, {
      method, headers: { ...headers, ...(body ? { "Content-Type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    return { status: res.status, headers: res.headers, text, json: text.startsWith("{") || text.startsWith("[") ? JSON.parse(text) : null };
  };
  return { tmp, config, api, output: () => output };
}

test("site gateways: CRUD, write-only tokens, test endpoint, detail, alias, /metrics labels, restart persistence", { timeout: 60000 }, async (t) => {
  const seen = [];
  const portA = await fakeGateway(t, "site-a", seen);
  const portB = await fakeGateway(t, "site-b", seen);
  const dash = await startDashboard(t, { SPARKDASH_SITEGW_URL: "" });
  const { api } = dash;

  // Auth: every route, including the mutating ones, needs the dashboard token on this bind.
  for (const [method, url] of [["GET", "/api/site-gateways"], ["POST", "/api/site-gateways"], ["POST", "/api/site-gateways/test"], ["GET", "/api/site-gateways/x"], ["PATCH", "/api/site-gateways/x"], ["DELETE", "/api/site-gateways/x"]]) {
    assert.equal((await api(method, url, method === "GET" || method === "DELETE" ? undefined : {}, {})).status, 401, `${method} ${url}`);
  }

  // Empty registry, and the single-gateway alias keeps its old "off" shape.
  let list = await api("GET", "/api/site-gateways");
  assert.deepEqual(list.json, { enabled: false, gateways: [] });
  assert.equal(list.headers.get("cache-control"), "no-store");
  const alias = (await api("GET", "/api/site-gateway")).json;
  assert.deepEqual([alias.enabled, alias.available, alias.reachable], [false, false, null]);
  assert.equal((await api("GET", "/api/settings")).json.siteGatewayCount, 0);

  // Validation.
  assert.equal((await api("POST", "/api/site-gateways", { name: "x", url: "http://8.8.8.8:8200" })).status, 400);
  assert.equal((await api("POST", "/api/site-gateways", { name: "x" })).status, 400);

  // Test connection: typed token → ops; no token → liveness; wrong URL → error code; nothing is echoed.
  const url = (port) => `http://127.0.0.1:${port}`;
  const tested = (await api("POST", "/api/site-gateways/test", { url: url(portA), token: OPS_TOKEN })).json;
  assert.deepEqual({ ok: tested.ok, mode: tested.mode, siteId: tested.siteId, services: tested.services }, { ok: true, mode: "ops", siteId: "site-a", services: 2 });
  assert.equal((await api("POST", "/api/site-gateways/test", { url: url(portA) })).json.mode, "liveness");
  assert.equal((await api("POST", "/api/site-gateways/test", { url: "http://8.8.8.8:8200" })).json.error, "site-gateway-url-invalid");
  assert.equal((await api("POST", "/api/site-gateways/test", { url: "http://127.0.0.1:9" })).json.error, "site-gateway-unreachable");

  // Create two gateways; one with a token, one liveness-only.
  const created = await api("POST", "/api/site-gateways", { name: "Guomao A", url: url(portA), token: OPS_TOKEN });
  assert.equal(created.status, 201);
  const idA = created.json.gateway.id;
  assert.equal(created.json.gateway.tokenConfigured, true);
  const idB = (await api("POST", "/api/site-gateways", { name: "Beijing B", url: url(portB) })).json.gateway.id;
  assert.equal((await api("POST", "/api/site-gateways", { name: "dup", url: url(portA) })).status, 409);

  // List: one card each, headline numbers for the ops one, unknown (null) for the liveness one.
  list = await api("GET", "/api/site-gateways");
  assert.equal(list.json.enabled, true);
  const rows = Object.fromEntries(list.json.gateways.map((g) => [g.id, g]));
  assert.equal(rows[idA].mode, "ops");
  assert.equal(rows[idA].requests, 20);
  assert.equal(rows[idA].servicesReady, 1);
  assert.equal(rows[idA].servicesTotal, 2);
  assert.equal(rows[idA].p95Ms, 2500);
  assert.equal(rows[idA].status, undefined, "list rows carry headline numbers only");
  assert.equal(rows[idB].mode, "liveness");
  assert.equal(rows[idB].requests, null);
  assert.equal(rows[idB].source, "config");

  // Detail: full snapshot of that gateway only, no secrets or unlisted fields.
  const detail = await api("GET", `/api/site-gateways/${idA}`);
  assert.equal(detail.status, 200);
  assert.equal(detail.json.name, "Guomao A");
  assert.equal(detail.json.status.siteId, "site-a");
  assert.equal(detail.json.status.traffic.principals[0].principal, "customer-a");
  assert.equal((await api("GET", `/api/site-gateways/${idB}`)).json.status, null);
  assert.equal((await api("GET", "/api/site-gateways/nope")).status, 404);
  assert.equal((await api("GET", "/api/site-gateway")).json.status?.siteId, "site-a", "alias = first gateway");

  // Test connection for a saved gateway reuses its stored token.
  const reused = (await api("POST", "/api/site-gateways/test", { url: url(portA), id: idA })).json;
  assert.equal(reused.mode, "ops");

  // PATCH: rename keeps the token; clearing drops it; unknown id 404.
  const renamed = (await api("PATCH", `/api/site-gateways/${idA}`, { name: "Guomao A2" })).json.gateway;
  assert.deepEqual([renamed.name, renamed.tokenConfigured], ["Guomao A2", true]);
  assert.equal((await api("PATCH", "/api/site-gateways/nope", { name: "x" })).status, 404);
  assert.equal((await api("PATCH", `/api/site-gateways/${idB}`, { token: OPS_TOKEN })).json.gateway.tokenConfigured, true);
  await api("GET", "/api/site-gateways");
  assert.equal((await api("GET", `/api/site-gateways/${idB}`)).json.mode, "ops", "a new token takes effect without a restart");

  // Settings + /metrics (gateway label per series).
  const settings = (await api("GET", "/api/settings")).json;
  assert.equal(settings.siteGatewayEnabled, true);
  assert.equal(settings.siteGatewayCount, 2);
  await api("PUT", "/api/settings", { prometheusExport: true });
  const metrics = (await api("GET", "/metrics")).text;
  assert.match(metrics, new RegExp(`^sparkdash_sitegw_up\\{gateway="${idA}"\\} 1$`, "m"));
  assert.match(metrics, new RegExp(`^sparkdash_sitegw_up\\{gateway="${idB}"\\} 1$`, "m"));
  assert.match(metrics, new RegExp(`^sparkdash_sitegw_requests\\{gateway="${idA}",service="deepseek-v41",class="5xx"\\} 1$`, "m"));
  assert.match(metrics, new RegExp(`^sparkdash_sitegw_latency_p95_seconds\\{gateway="${idB}",service="deepseek-v41"\\} 2.5$`, "m"));

  // Persistence: the JSON file holds no token; a restarted server keeps the gateways and their tokens.
  const filePath = dash.config.SITE_GATEWAYS_JSON_PATH;
  const onDisk = await readFile(filePath, "utf8");
  assert.doesNotMatch(onDisk, new RegExp(OPS_TOKEN));
  assert.deepEqual(JSON.parse(onDisk).map((e) => e.id).sort(), [idA, idB].sort());
  const secrets = await readFile(dash.config.SPARKS_SECRETS_PATH, "utf8");
  assert.doesNotMatch(secrets, new RegExp(OPS_TOKEN), "tokens are encrypted at rest");

  // Delete.
  assert.equal((await api("DELETE", `/api/site-gateways/${idB}`)).status, 200);
  assert.equal((await api("DELETE", `/api/site-gateways/${idB}`)).status, 404);
  assert.deepEqual((await api("GET", "/api/site-gateways")).json.gateways.map((g) => g.id), [idA]);

  // The token never appears in any response body or in the server's output.
  const everything = (await Promise.all([
    api("GET", "/api/site-gateways"), api("GET", `/api/site-gateways/${idA}`), api("GET", "/api/site-gateway"), api("GET", "/api/settings"),
    api("POST", "/api/site-gateways", { name: "again", url: url(portA), token: OPS_TOKEN }),
    api("POST", "/api/site-gateways", { name: "bad", url: `http://8.8.8.8/${OPS_TOKEN}`, token: OPS_TOKEN }),
    api("POST", "/api/site-gateways/test", { url: url(portA), token: OPS_TOKEN }),
  ])).map((r) => r.text).join("\n");
  assert.doesNotMatch(everything, new RegExp(`${OPS_TOKEN}|private-field|10\\.9\\.9\\.9`));
  assert.doesNotMatch(dash.output(), new RegExp(OPS_TOKEN));
  // The ops token only ever went to the ops endpoint; /healthz is unauthenticated.
  assert.ok(seen.filter((s) => s.url === "/healthz").every((s) => s.auth === undefined));
  assert.ok(seen.filter((s) => s.auth).every((s) => s.url.startsWith("/ops/v1/status") && s.auth === `Bearer ${OPS_TOKEN}`));
});

test("site gateways: gateways and tokens survive a restart", { timeout: 60000 }, async (t) => {
  const port = await fakeGateway(t, "site-a");
  const first = await startDashboard(t, { SPARKDASH_SITEGW_URL: "" });
  const created = await first.api("POST", "/api/site-gateways", { name: "Keep me", url: `http://127.0.0.1:${port}`, token: OPS_TOKEN });
  const id = created.json.gateway.id;
  // Second server process on the same config directory.
  const second = await (async () => {
    const reservation = createServer();
    const p = await listening(reservation);
    await new Promise((resolve) => reservation.close(resolve));
    const child = spawn(process.execPath, ["server/index.js"], {
      cwd: path.resolve(import.meta.dirname, "../.."),
      env: { ...process.env, ...first.config, PORT: String(p), BIND_HOST: "0.0.0.0", SPARKDASH_TOKEN: DASH, SPARKDASH_SITEGW_URL: "" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    t.after(async () => { if (child.exitCode == null) { const e = once(child, "exit"); child.kill("SIGTERM"); await e; } });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("restart timed out")), 10000);
      child.stdout.on("data", (d) => { if (String(d).includes("server listening")) { clearTimeout(timer); resolve(); } });
    });
    return `http://127.0.0.1:${p}`;
  })();
  const res = await fetch(`${second}/api/site-gateways/${id}`, { headers: { Authorization: `Bearer ${DASH}` } });
  const body = await res.json();
  assert.equal(body.name, "Keep me");
  assert.equal(body.tokenConfigured, true);
  assert.equal(body.mode, "ops", "the stored token was decrypted and used after the restart");
});

test("site gateways: the SPARKDASH_SITEGW_URL seed is a read-only 'env' entry and keeps the old API working", { timeout: 40000 }, async (t) => {
  const port = await fakeGateway(t, "site-env");
  const dash = await startDashboard(t, { SPARKDASH_SITEGW_URL: `http://127.0.0.1:${port}`, SPARKDASH_SITEGW_TOKEN: OPS_TOKEN });
  const { api } = dash;
  const list = (await api("GET", "/api/site-gateways")).json;
  assert.equal(list.enabled, true);
  assert.equal(list.gateways.length, 1);
  const env = list.gateways[0];
  assert.deepEqual([env.id, env.source, env.name, env.tokenConfigured, env.mode], ["env", "env", "Site Gateway (env)", true, "ops"]);
  const patch = await api("PATCH", "/api/site-gateways/env", { name: "x" });
  assert.equal(patch.status, 409);
  assert.match(patch.json.error, /SPARKDASH_SITEGW_URL/);
  assert.equal((await api("DELETE", "/api/site-gateways/env")).status, 409);
  assert.equal((await api("GET", "/api/site-gateway")).json.status.siteId, "site-env");
  // Adding the very same URL as a stored entry replaces the seed rather than duplicating it.
  const added = await api("POST", "/api/site-gateways", { name: "Stored", url: `http://127.0.0.1:${port}` });
  assert.equal(added.status, 201);
  assert.deepEqual((await api("GET", "/api/site-gateways")).json.gateways.map((g) => g.id), [added.json.gateway.id]);
  assert.doesNotMatch(dash.output(), new RegExp(OPS_TOKEN));
});
