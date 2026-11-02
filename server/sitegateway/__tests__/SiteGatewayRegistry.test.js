import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ENV_GATEWAY_ID, MAX_GATEWAYS, SiteGatewayError, SiteGatewayRegistry } from "../SiteGatewayRegistry.js";
import { SiteGatewayStore } from "../../collectors/SiteGatewayProbe.js";

const TOKEN = "ops-secret-token-value";

function statusPayload() {
  return {
    object: "site_gateway.status", site_id: "site-01", generated_at: "2026-11-02T08:00:00+00:00",
    started_at: "2026-11-02T06:00:00+00:00", uptime_seconds: 7200, window_seconds: 300,
    limits: { max_concurrent_per_key: 16, rate_limit_requests_per_minute: 120 },
    services: [{ id: "deepseek-v41", kind: "llm", enabled: true, status: "ready", checked_at: null, detail: {} }],
    traffic: { inflight_total: 0, services: [{ service: "deepseek-v41", inflight: 0, requests: 10, status_2xx: 10, status_4xx: 0, status_5xx: 0, rate_limited: 0, timeouts: 0, error_rate: 0, latency_ms: { p50: 100, p95: 250 } }], principals: [] },
    history: [],
  };
}

function setup({ env = {}, read, tokens = new Map(), saveFails = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sparkdash-sgw-"));
  const filePath = path.join(dir, "site-gateways.json");
  const saved = { tokens: new Map(tokens), calls: 0 };
  const reads = [];
  const defaultRead = async (target, opts) => {
    reads.push({ target, token: opts?.token });
    if (target.includes("/ops/")) return opts?.token === TOKEN ? statusPayload() : Promise.reject(new Error("401"));
    return { status: "ok" };
  };
  const make = () => new SiteGatewayRegistry({
    filePath, env,
    loadTokens: () => new Map(saved.tokens),
    saveTokens: (map) => {
      saved.calls += 1;
      if (saveFails) throw new Error("disk full");
      saved.tokens = new Map(map);
    },
    createStore: (o) => new SiteGatewayStore({ ...o, read: read || defaultRead }),
  });
  return { dir, filePath, saved, reads, registry: make(), make, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test("add: validates the URL, derives a unique slug id, persists only {id,name,url} at 0600", () => {
  const { registry, filePath, cleanup } = setup();
  try {
    assert.throws(() => registry.add({ name: "x", url: "http://8.8.8.8:8200" }), (e) => e instanceof SiteGatewayError && e.status === 400);
    assert.throws(() => registry.add({ name: "x", url: "http://gw.example.com" }), SiteGatewayError);
    assert.throws(() => registry.add({ name: "x", url: "http://user:pw@100.64.0.21:8200" }), SiteGatewayError);
    assert.throws(() => registry.add({ name: "x", url: "http://100.64.0.21:8200/ops?x=1" }), SiteGatewayError);
    const a = registry.add({ name: "Guomao 国贸 GW", url: "http://100.64.0.21:8200", token: TOKEN });
    const b = registry.add({ name: "Guomao 国贸 GW", url: "http://100.64.0.22:8200" });
    assert.match(a.id, /^[a-z0-9][a-z0-9._-]{0,63}$/);
    assert.notEqual(a.id, b.id);
    assert.equal(a.url, "http://100.64.0.21:8200");
    assert.equal(a.tokenConfigured, true);
    assert.equal(b.tokenConfigured, false);
    assert.equal(a.source, "config");
    const onDisk = JSON.parse(fs.readFileSync(filePath, "utf8"));
    assert.deepEqual(onDisk.map((e) => Object.keys(e).sort()), [["id", "name", "url"], ["id", "name", "url"]]);
    assert.doesNotMatch(fs.readFileSync(filePath, "utf8"), new RegExp(TOKEN));
    assert.equal(fs.statSync(filePath).mode & 0o777, 0o600);
    assert.throws(() => registry.add({ name: "dup", url: "http://100.64.0.21:8200" }), (e) => e.status === 409);
  } finally {
    registry.stop();
    cleanup();
  }
});

test("name defaults to host:port; reserved ids are never issued; at most 20 gateways", () => {
  const { registry, cleanup } = setup();
  try {
    assert.equal(registry.add({ url: "http://10.0.0.1:8200" }).name, "10.0.0.1:8200");
    assert.notEqual(registry.add({ name: "env", url: "http://10.0.0.2:8200" }).id, ENV_GATEWAY_ID);
    assert.notEqual(registry.add({ name: "test", url: "http://10.0.0.3:8200" }).id, "test");
    for (let i = 4; i <= MAX_GATEWAYS; i += 1) registry.add({ name: `g${i}`, url: `http://10.0.0.${i}:8200` });
    assert.throws(() => registry.add({ name: "one too many", url: "http://10.0.1.1:8200" }), (e) => e.status === 409);
  } finally {
    cleanup();
  }
});

test("registry survives a restart; tokens come back from the token store, not the JSON file", () => {
  const first = setup();
  try {
    const a = first.registry.add({ name: "GZ", url: "http://100.64.0.21:8200", token: TOKEN });
    const again = first.make();
    const snap = again.snapshot(a.id);
    assert.equal(snap.name, "GZ");
    assert.equal(snap.tokenConfigured, true);
    assert.equal(first.saved.tokens.get(a.id), TOKEN);
  } finally {
    first.cleanup();
  }
});

test("a corrupt registry file is set aside, not overwritten and not fatal", () => {
  const { filePath, make, cleanup, dir } = setup();
  try {
    fs.writeFileSync(filePath, "{ not json");
    const registry = make();
    assert.equal(registry.count, 0);
    assert.ok(fs.readdirSync(dir).some((f) => f.includes("corrupt") || f.includes("bak")), "the bad file is kept aside");
  } finally {
    cleanup();
  }
});

test("update: rename, re-key, and the token rules around changing the URL", () => {
  const { registry, saved, cleanup } = setup();
  try {
    const a = registry.add({ name: "GZ", url: "http://100.64.0.21:8200", token: TOKEN });
    assert.equal(registry.update(a.id, { name: "Guomao" }).name, "Guomao");
    assert.equal(registry.update(a.id, { url: "http://100.64.0.21:9300" }).tokenConfigured, true, "same host, new port: token kept");
    assert.equal(registry.update(a.id, { url: "http://100.64.0.99:9300" }).tokenConfigured, false, "different host: token dropped");
    assert.equal(saved.tokens.has(a.id), false);
    assert.equal(registry.update(a.id, { token: "new-token-value" }).tokenConfigured, true);
    assert.equal(registry.update(a.id, { token: "" }).tokenConfigured, false, "empty string clears");
    assert.throws(() => registry.update(a.id, { name: "  " }), SiteGatewayError);
    assert.throws(() => registry.update(a.id, { url: "http://8.8.8.8" }), SiteGatewayError);
    assert.throws(() => registry.update(a.id, { token: 5 }), SiteGatewayError);
    assert.throws(() => registry.update("nope", { name: "x" }), (e) => e.status === 404);
    const b = registry.add({ name: "B", url: "http://100.64.0.30:8200" });
    assert.throws(() => registry.update(b.id, { url: "http://100.64.0.99:9300" }), (e) => e.status === 409, "URL already used by another gateway");
  } finally {
    cleanup();
  }
});

test("a token that cannot be stored fails the change and leaves nothing half-saved", () => {
  const { registry, filePath, cleanup } = setup({ saveFails: true });
  try {
    assert.throws(() => registry.add({ name: "GZ", url: "http://100.64.0.21:8200", token: TOKEN }), (e) => e.status === 500);
    assert.equal(registry.count, 0);
    assert.deepEqual(JSON.parse(fs.readFileSync(filePath, "utf8")), []);
  } finally {
    cleanup();
  }
});

test("remove: stops the probe, drops the token, and is not allowed for the env entry", async () => {
  const { registry, saved, reads, cleanup } = setup({ env: { SPARKDASH_SITEGW_URL: "http://100.64.0.50:8200", SPARKDASH_SITEGW_TOKEN: TOKEN } });
  try {
    const a = registry.add({ name: "GZ", url: "http://100.64.0.21:8200", token: TOKEN });
    assert.ok(saved.tokens.has(a.id));
    registry.remove(a.id);
    assert.equal(registry.has(a.id), false);
    assert.equal(registry.snapshot(a.id), null);
    assert.equal(saved.tokens.has(a.id), false);
    reads.length = 0;
    await registry.refreshAll();
    assert.ok(reads.every((r) => !r.target.includes("100.64.0.21")), "the removed gateway is no longer polled");
    assert.throws(() => registry.remove("nope"), (e) => e.status === 404);
    assert.throws(() => registry.remove(ENV_GATEWAY_ID), (e) => e.status === 409 && /SPARKDASH_SITEGW_URL/.test(e.message));
    assert.throws(() => registry.update(ENV_GATEWAY_ID, { name: "x" }), (e) => e.status === 409);
  } finally {
    cleanup();
  }
});

test("env seed: read-only entry 'env', hidden while a stored entry has the same URL and back after removal", () => {
  const { registry, cleanup } = setup({ env: { SPARKDASH_SITEGW_URL: "http://100.64.0.21:8200/", SPARKDASH_SITEGW_TOKEN: TOKEN } });
  try {
    assert.deepEqual(registry.ids(), [ENV_GATEWAY_ID]);
    const env = registry.snapshot(ENV_GATEWAY_ID);
    assert.equal(env.source, "env");
    assert.equal(env.name, "Site Gateway (env)");
    assert.equal(env.tokenConfigured, true);
    assert.equal(env.url, "http://100.64.0.21:8200");
    const stored = registry.add({ name: "Same", url: "http://100.64.0.21:8200" });
    assert.deepEqual(registry.ids(), [stored.id], "no duplicate of the env gateway");
    registry.remove(stored.id);
    assert.deepEqual(registry.ids(), [ENV_GATEWAY_ID]);
    assert.equal(registry.snapshot(ENV_GATEWAY_ID).tokenConfigured, true);
  } finally {
    cleanup();
  }
});

test("env seed with an invalid URL shows as a configuration error, never as reachable", async () => {
  const { registry, reads, cleanup } = setup({ env: { SPARKDASH_SITEGW_URL: "http://8.8.8.8" } });
  try {
    await registry.refreshAll();
    assert.equal(reads.length, 0);
    assert.equal(registry.snapshot(ENV_GATEWAY_ID).error, "site-gateway-configuration-invalid");
  } finally {
    cleanup();
  }
});

test("no snapshot, summary, error or alert unit ever contains a token", async () => {
  const { registry, cleanup } = setup({ env: { SPARKDASH_SITEGW_URL: "http://100.64.0.50:8200", SPARKDASH_SITEGW_TOKEN: "env-secret-token-value" } });
  try {
    registry.add({ name: "GZ", url: "http://100.64.0.21:8200", token: TOKEN });
    await registry.refreshAll();
    const dump = JSON.stringify([registry.snapshots(), registry.summaries(), registry.alertUnits()]);
    assert.doesNotMatch(dump, new RegExp(`${TOKEN}|env-secret-token-value`));
    try {
      registry.add({ name: "bad", url: `http://8.8.8.8/${TOKEN}` });
    } catch (err) {
      assert.doesNotMatch(err.message, new RegExp(TOKEN));
    }
  } finally {
    cleanup();
  }
});

test("summaries: headline numbers per gateway, unreachable gateways still listed", async () => {
  const down = new Set(["100.64.0.22"]);
  const read = async (target, opts) => {
    if (down.has(new URL(target).hostname)) throw new Error("connect ECONNREFUSED");
    if (target.includes("/ops/")) return statusPayload();
    return { status: "ok" };
  };
  const { registry, cleanup } = setup({ read });
  try {
    const a = registry.add({ name: "Up", url: "http://100.64.0.21:8200", token: TOKEN });
    const b = registry.add({ name: "Down", url: "http://100.64.0.22:8200", token: TOKEN });
    await registry.refreshAll();
    const rows = Object.fromEntries(registry.summaries().map((r) => [r.id, r]));
    assert.equal(rows[a.id].mode, "ops");
    assert.equal(rows[a.id].requests, 10);
    assert.equal(rows[a.id].servicesReady, 1);
    assert.equal(rows[a.id].p95Ms, 250);
    assert.equal(rows[a.id].status, undefined, "list rows do not carry the full status");
    assert.equal(rows[b.id].reachable, false);
    assert.equal(rows[b.id].error, "site-gateway-unreachable");
    assert.equal(rows[b.id].requests, null, "unknown, not zero");
    const units = Object.fromEntries(registry.alertUnits().map((u) => [u.id, u.online]));
    assert.deepEqual(units, { [`sitegw:${a.id}`]: true, [`sitegw:${b.id}`]: false });
  } finally {
    cleanup();
  }
});

test("isolation: one gateway that hangs or throws does not delay or break the others", async () => {
  let release;
  const hang = new Promise((resolve) => { release = resolve; });
  const read = async (target) => {
    const host = new URL(target).hostname;
    if (host === "100.64.0.22") await hang;
    if (host === "100.64.0.23") throw new Error("boom");
    if (target.includes("/ops/")) return statusPayload();
    return { status: "ok" };
  };
  const { registry, cleanup } = setup({ read });
  try {
    const ok = registry.add({ name: "ok", url: "http://100.64.0.21:8200", token: TOKEN });
    registry.add({ name: "hangs", url: "http://100.64.0.22:8200", token: TOKEN });
    registry.add({ name: "throws", url: "http://100.64.0.23:8200", token: TOKEN });
    await registry.refreshIfDue(ok.id);
    assert.equal(registry.snapshot(ok.id).mode, "ops");
    const pending = registry.refreshAll();
    release();
    await pending;
    assert.equal(registry.snapshot(ok.id).available, true);
  } finally {
    release();
    cleanup();
  }
});

test("hot: changing the URL swaps the probe; a rename keeps the history", async () => {
  const { registry, reads, cleanup } = setup();
  try {
    const a = registry.add({ name: "GZ", url: "http://100.64.0.21:8200", token: TOKEN });
    await registry.refreshIfDue(a.id);
    const before = registry.snapshot(a.id).samples.length;
    assert.ok(before > 0);
    registry.update(a.id, { name: "Renamed" });
    assert.equal(registry.snapshot(a.id).samples.length, before, "history survives a rename");
    reads.length = 0;
    registry.update(a.id, { url: "http://100.64.0.77:8200", token: TOKEN });
    await registry.refreshIfDue(a.id);
    assert.ok(reads.length > 0 && reads.every((r) => r.target.startsWith("http://100.64.0.77:8200")));
  } finally {
    cleanup();
  }
});

test("test connection reuses the stored token for a saved gateway and takes a typed one otherwise", async () => {
  const calls = [];
  const { registry, cleanup } = setup();
  registry.probe = async (input) => { calls.push(input); return { ok: true, mode: "ops", reachable: true, error: null, siteId: "s", services: 1 }; };
  try {
    const a = registry.add({ name: "GZ", url: "http://100.64.0.21:8200", token: TOKEN });
    await registry.test({ url: a.url, id: a.id });
    await registry.test({ url: a.url, id: a.id, token: "typed-token" });
    await registry.test({ url: a.url, id: "unknown" });
    assert.deepEqual(calls.map((c) => c.token), [TOKEN, "typed-token", undefined]);
  } finally {
    cleanup();
  }
});

test("secrets store: tokens are encrypted on disk, round-trip, and other sections are left alone", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sparkdash-sgw-secrets-"));
  try {
    const script = `
      import { saveSecrets, saveSiteGatewayTokens, loadSiteGatewayTokens, loadSecrets, saveAlertChannelUrls, saveHelperTokens } from "./server/secretsStore.js";
      saveSecrets(new Map([["spark1", "ssh-password-value"]]));
      saveAlertChannelUrls(new Map([["c1", "https://hooks.example/abc"]]));
      saveSiteGatewayTokens(new Map([["gz", "${TOKEN}"], ["bj", "second-token-value"]]));
      // other writers must keep the gateway tokens
      saveSecrets(new Map([["spark1", "ssh-password-value"]]));
      saveAlertChannelUrls(new Map([["c1", "https://hooks.example/abc"]]));
      saveHelperTokens(new Map([["h1", "helper-token-value"]]));
      const loaded = loadSiteGatewayTokens();
      console.log(JSON.stringify({ gz: loaded.get("gz"), bj: loaded.get("bj"), pw: loadSecrets().passwords.get("spark1") }));
      saveSiteGatewayTokens(new Map([["gz", "${TOKEN}"]]), { keepIds: ["gz"] });
      console.log(JSON.stringify({ afterDrop: [...loadSiteGatewayTokens().keys()] }));
    `;
    const run = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
      cwd: path.resolve(import.meta.dirname, "../../.."),
      env: { ...process.env, SPARKS_SECRETS_PATH: path.join(dir, "secrets.json"), SECRETS_KEY_PATH: path.join(dir, ".key"), SPARKDASH_SECRETS_KEY: "" },
      encoding: "utf8",
    });
    assert.equal(run.status, 0, run.stderr);
    const lines = run.stdout.split("\n").filter((l) => l.startsWith("{"));
    assert.deepEqual(JSON.parse(lines[0]), { gz: TOKEN, bj: "second-token-value", pw: "ssh-password-value" });
    assert.deepEqual(JSON.parse(lines[1]), { afterDrop: ["gz"] });
    const raw = fs.readFileSync(path.join(dir, "secrets.json"), "utf8");
    assert.doesNotMatch(raw, new RegExp(`${TOKEN}|second-token-value|ssh-password-value|helper-token-value`));
    assert.ok(JSON.parse(raw).siteGatewayTokens.gz, "stored under its own section");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
