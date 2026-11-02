import fs from "node:fs";
import { SITE_GATEWAYS_JSON_PATH } from "../config.js";
import { loadSiteGatewayTokens, saveSiteGatewayTokens } from "../secretsStore.js";
import { atomicWrite, quarantineCorrupt } from "../util/atomicWrite.js";
import {
  SiteGatewayStore, probeSiteGatewayOnce, siteGatewayAlertUnit, siteGatewayHeadline, siteGatewayUrl,
} from "../collectors/SiteGatewayProbe.js";

/**
 * Many Site Gateways, configured from the UI.
 *
 *  - `config/site-gateways.json` holds `[{ id, name, url }]` and nothing secret.
 *  - Ops tokens are encrypted in the secrets store (`siteGatewayTokens`), held in
 *    memory for the probes and never returned: callers only see `tokenConfigured`.
 *  - One SiteGatewayStore per gateway, created / replaced / stopped on change, so
 *    a hung or failing gateway never delays or hides another.
 *  - `SPARKDASH_SITEGW_URL` (+ `SPARKDASH_SITEGW_TOKEN`) still works as a read-only
 *    entry with id "env", unless a stored entry already points at that URL.
 */

export const ENV_GATEWAY_ID = "env";
export const MAX_GATEWAYS = 20;
const MAX_NAME_CHARS = 64;
const POLL_TICK_MS = 5_000;
const ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const RESERVED_IDS = new Set([ENV_GATEWAY_ID, "test"]);

/** An error that the route maps to an HTTP status. */
export class SiteGatewayError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

function cleanName(value) {
  if (typeof value !== "string") return "";
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, MAX_NAME_CHARS);
}

function slug(name) {
  const base = name.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^[^a-z0-9]+/, "").replace(/-+$/, "").slice(0, 60);
  return base || "gateway";
}

function hostOf(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

function hostPort(url) {
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
}

export class SiteGatewayRegistry {
  /**
   * @param {object} [opts]
   * @param {string} [opts.filePath]
   * @param {NodeJS.ProcessEnv} [opts.env] source of the SPARKDASH_SITEGW_* seed
   * @param {() => Map<string, string>} [opts.loadTokens]
   * @param {(tokens: Map<string, string>, o: { keepIds: string[] }) => void} [opts.saveTokens]
   * @param {(o: object) => SiteGatewayStore} [opts.createStore]
   * @param {typeof probeSiteGatewayOnce} [opts.probe]
   */
  constructor({
    filePath = SITE_GATEWAYS_JSON_PATH, env = process.env, loadTokens = loadSiteGatewayTokens,
    saveTokens = saveSiteGatewayTokens, createStore = (o) => new SiteGatewayStore(o), probe = probeSiteGatewayOnce,
  } = {}) {
    this.filePath = filePath;
    this.saveTokens = saveTokens;
    this.createStore = createStore;
    this.probe = probe;
    /** @type {{ id: string, name: string, url: string }[]} */
    this._entries = this._load();
    /** @type {Map<string, string>} */
    this._tokens = new Map();
    for (const [id, token] of loadTokens()) if (this._entries.some((e) => e.id === id)) this._tokens.set(id, token);
    this._envSeed = this._readEnvSeed(env);
    /** @type {Map<string, SiteGatewayStore>} */
    this._stores = new Map();
    for (const entry of this._all()) this._stores.set(entry.id, this._makeStore(entry));
    this._timer = null;
  }

  // ─── Loading / saving ──────────────────────────────────

  _load() {
    if (!fs.existsSync(this.filePath)) return [];
    try {
      const data = JSON.parse(fs.readFileSync(this.filePath, "utf8"));
      const list = Array.isArray(data) ? data : [];
      const seen = new Set();
      const out = [];
      for (const item of list) {
        const id = item?.id;
        const name = cleanName(item?.name);
        if (typeof id !== "string" || !ID_RE.test(id) || RESERVED_IDS.has(id) || seen.has(id) || !name || typeof item.url !== "string") continue;
        seen.add(id);
        out.push({ id, name, url: item.url.trim() });
        if (out.length >= MAX_GATEWAYS) break;
      }
      return out;
    } catch (err) {
      if (err instanceof SyntaxError) quarantineCorrupt(this.filePath, "SiteGatewayRegistry", err);
      else console.error(`[SiteGatewayRegistry] Failed to read ${this.filePath}: ${err.message}`);
      return [];
    }
  }

  _persist(entries) {
    atomicWrite(this.filePath, JSON.stringify(entries.map(({ id, name, url }) => ({ id, name, url })), null, 2) + "\n", 0o600);
  }

  _readEnvSeed(env) {
    const raw = typeof env?.SPARKDASH_SITEGW_URL === "string" ? env.SPARKDASH_SITEGW_URL.trim() : "";
    if (!raw) return null;
    const token = typeof env.SPARKDASH_SITEGW_TOKEN === "string" ? env.SPARKDASH_SITEGW_TOKEN.trim() : "";
    return { id: ENV_GATEWAY_ID, name: "Site Gateway (env)", url: siteGatewayUrl(raw) || raw, token: token || null };
  }

  /** The environment seed, unless a stored entry already points at the same URL. */
  get _env() {
    const seed = this._envSeed;
    if (!seed) return null;
    const base = siteGatewayUrl(seed.url);
    return base && this._entries.some((e) => siteGatewayUrl(e.url) === base) ? null : seed;
  }

  _all() {
    const env = this._env;
    return env ? [...this._entries, env] : [...this._entries];
  }

  /** Create or drop the probe of the env entry after the stored entries changed. */
  _syncEnvStore() {
    const env = this._env;
    if (env && !this._stores.has(ENV_GATEWAY_ID)) this._stores.set(ENV_GATEWAY_ID, this._makeStore(env));
    if (!env) this._stores.delete(ENV_GATEWAY_ID);
  }

  _find(id) {
    return this._all().find((e) => e.id === id) || null;
  }

  _tokenOf(entry) {
    return entry.id === ENV_GATEWAY_ID ? entry.token : this._tokens.get(entry.id) || null;
  }

  _makeStore(entry) {
    return this.createStore({ url: entry.url, token: this._tokenOf(entry) });
  }

  _saveTokens() {
    this.saveTokens(this._tokens, { keepIds: this._entries.map((e) => e.id) });
  }

  // ─── Reads ─────────────────────────────────────────────

  get count() {
    return this._all().length;
  }

  has(id) {
    return this._find(id) != null;
  }

  ids() {
    return this._all().map((e) => e.id);
  }

  /** Snapshot of one gateway with its identity; the token is not part of it. */
  snapshot(id) {
    const entry = this._find(id);
    const store = this._stores.get(id);
    if (!entry || !store) return null;
    return {
      ...store.snapshot(),
      id: entry.id,
      name: entry.name,
      url: entry.url,
      source: entry.id === ENV_GATEWAY_ID ? "env" : "config",
    };
  }

  snapshots() {
    return this.ids().map((id) => this.snapshot(id)).filter(Boolean);
  }

  /** Card data for the list: identity, state and headline numbers. No services or callers. */
  summaries() {
    return this.snapshots().map((snap) => {
      const { status: _status, samples: _samples, ...rest } = snap;
      return { ...rest, ...siteGatewayHeadline(snap) };
    });
  }

  /** Alert-engine pseudo-units, one per gateway that has been checked at least once. */
  alertUnits() {
    return this.snapshots()
      .map((snap) => siteGatewayAlertUnit(snap, { id: snap.id, name: snap.name }))
      .filter(Boolean);
  }

  // ─── Polling ───────────────────────────────────────────

  async refreshIfDue(id) {
    const store = this._stores.get(id);
    if (!store) return;
    try {
      await store.refreshIfDue();
    } catch {
      // a failing gateway must not affect the others
    }
  }

  async refreshAll() {
    await Promise.all(this.ids().map((id) => this.refreshIfDue(id)));
  }

  /** Poll on a timer of its own so alerts and /metrics work with no dashboard open. */
  start() {
    if (this._timer) return;
    this._timer = setInterval(() => { this.refreshAll().catch(() => {}); }, POLL_TICK_MS);
    this._timer.unref?.();
    this.refreshAll().catch(() => {});
  }

  stop() {
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
  }

  // ─── Changes ───────────────────────────────────────────

  _validateUrl(url) {
    const base = siteGatewayUrl(url);
    if (!base) {
      throw new SiteGatewayError(
        "URL must be http(s)://<IP>[:port] with an IP address in loopback, private (RFC1918) or Tailnet (100.64.0.0/10) space, and no credentials, path or query",
      );
    }
    return base;
  }

  _uniqueId(name) {
    const base = slug(name);
    let id = RESERVED_IDS.has(base) ? `${base}-gw` : base;
    for (let n = 2; this._entries.some((e) => e.id === id); n += 1) id = `${base.slice(0, 60)}-${n}`;
    return id;
  }

  _requireStored(id) {
    if (id === ENV_GATEWAY_ID) {
      throw new SiteGatewayError("This Site Gateway comes from SPARKDASH_SITEGW_URL on the server and cannot be changed here", 409);
    }
    const entry = this._entries.find((e) => e.id === id);
    if (!entry) throw new SiteGatewayError("Site Gateway not found", 404);
    return entry;
  }

  _rejectDuplicateUrl(base, exceptId) {
    if (this._entries.some((e) => e.id !== exceptId && siteGatewayUrl(e.url) === base)) {
      throw new SiteGatewayError("A Site Gateway with this URL is already configured", 409);
    }
  }

  /** Add a gateway; returns its public snapshot. */
  add({ name, url, token } = {}) {
    if (this._entries.length >= MAX_GATEWAYS) throw new SiteGatewayError(`At most ${MAX_GATEWAYS} Site Gateways can be configured`, 409);
    const base = this._validateUrl(url);
    this._rejectDuplicateUrl(base, null);
    if (token != null && typeof token !== "string") throw new SiteGatewayError("token must be a string");
    const entry = { id: this._uniqueId(cleanName(name) || hostPort(base)), name: cleanName(name) || hostPort(base), url: base };
    const next = [...this._entries, entry];
    const bearer = typeof token === "string" && token.trim() ? token.trim() : null;
    this._persist(next);
    if (bearer) {
      this._tokens.set(entry.id, bearer);
      try {
        this._saveTokens();
      } catch (err) {
        this._tokens.delete(entry.id);
        this._persist(this._entries);
        throw new SiteGatewayError(`Could not store the token: ${err.message}`, 500);
      }
    }
    this._entries = next;
    this._stores.set(entry.id, this._makeStore(entry));
    // An env seed pointing at the same URL steps aside for the stored entry.
    this._syncEnvStore();
    this.refreshIfDue(entry.id).catch(() => {});
    return this.snapshot(entry.id);
  }

  /** Rename, move or re-key a gateway. `token: ""` clears it; an omitted token is kept while the host is unchanged. */
  update(id, { name, url, token } = {}) {
    const entry = this._requireStored(id);
    if (token !== undefined && typeof token !== "string") throw new SiteGatewayError("token must be a string");
    const next = { ...entry };
    const previousTokens = new Map(this._tokens);
    if (name !== undefined) {
      const cleaned = cleanName(name);
      if (!cleaned) throw new SiteGatewayError("name must not be empty");
      next.name = cleaned;
    }
    let tokenChanged = false;
    if (url !== undefined) {
      const base = this._validateUrl(url);
      this._rejectDuplicateUrl(base, id);
      next.url = base;
      if (base !== entry.url && token === undefined && hostOf(base) !== hostOf(entry.url) && this._tokens.has(id)) {
        this._tokens.delete(id);
        tokenChanged = true;
      }
    }
    if (token !== undefined) {
      const bearer = token.trim();
      if (bearer) this._tokens.set(id, bearer);
      else this._tokens.delete(id);
      tokenChanged = true;
    }
    this._persist(this._entries.map((e) => (e.id === id ? next : e)));
    if (tokenChanged) {
      try {
        this._saveTokens();
      } catch (err) {
        this._tokens = previousTokens;
        this._persist(this._entries);
        throw new SiteGatewayError(`Could not store the token: ${err.message}`, 500);
      }
    }
    this._entries = this._entries.map((e) => (e.id === id ? next : e));
    if (next.url !== entry.url || tokenChanged) this._stores.set(id, this._makeStore(next));
    this._syncEnvStore();
    this.refreshIfDue(id).catch(() => {});
    return this.snapshot(id);
  }

  remove(id) {
    this._requireStored(id);
    const next = this._entries.filter((e) => e.id !== id);
    this._persist(next);
    const hadToken = this._tokens.delete(id);
    this._entries = next;
    this._stores.delete(id);
    if (hadToken) {
      try {
        this._saveTokens();
      } catch (err) {
        console.error(`[SiteGatewayRegistry] Could not drop the stored token of ${id}: ${err.message}`);
      }
    }
    // The environment seed reappears if it was only hidden by this entry.
    this._syncEnvStore();
    return true;
  }

  /** "Test connection": uses the stored token of `id` when the caller sends none. */
  async test({ url, token, id } = {}) {
    let bearer = typeof token === "string" ? token : undefined;
    if (bearer === undefined && typeof id === "string") {
      const entry = this._find(id);
      bearer = entry ? this._tokenOf(entry) ?? undefined : undefined;
    }
    return this.probe({ url, token: bearer });
  }
}
