/** The Site Gateway rides the alert engine as a pseudo-unit: unreachable = offline, findings = health. */
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { AlertEngine, MIN_CLEAR_MS } from "../engine.js";
import { RULES, ruleById } from "../conditions.js";
import { clock, quietLog } from "./fixtures.js";
import { SITE_GATEWAY_UNIT_PREFIX, siteGatewayAlertUnit } from "../../collectors/SiteGatewayProbe.js";

function setup() {
  const now = clock();
  const sent = [];
  const rules = Object.fromEntries(RULES.map((r) => [r.id, { enabled: r.id.startsWith("sitegw-") || r.id === "offline", forSec: 0 }]));
  const engine = new AlertEngine({
    now, getConfig: () => ({ repeatIntervalMin: 0, rules, channels: [{ id: "c", enabled: true }] }),
    notifier: { dispatch: (_c, group) => (sent.push(group), Promise.resolve([])) }, persistState: () => {}, log: quietLog,
  });
  return { now, sent, engine };
}

const GZ = { id: "gz", name: "Guomao GW" };

const okStatus = (service) => ({
  windowSeconds: 300,
  services: [{ id: "media", enabled: true, status: "ready" }, ...service],
  traffic: { inflightTotal: 0, services: [], principals: [] },
});

test("catalogue lists the three Site Gateway rules", () => {
  for (const id of ["sitegw-degraded", "sitegw-errors", "sitegw-ratelimit"]) {
    assert.equal(ruleById(id)?.source, "health", id);
  }
});

test("an unreachable gateway fires offline under the gateway's page id and resolves on recovery", () => {
  const { now, engine } = setup();
  engine.evaluate([siteGatewayAlertUnit({ enabled: true, reachable: false }, GZ)]);
  const [alert] = engine.active();
  assert.equal(alert.unitId, `${SITE_GATEWAY_UNIT_PREFIX}gz`);
  assert.equal(alert.unitName, "Guomao GW");
  assert.equal(alert.ruleId, "offline");
  const recovered = siteGatewayAlertUnit({ enabled: true, reachable: true, available: true, mode: "liveness", status: null }, GZ);
  engine.evaluate([recovered]);
  assert.equal(engine.active().length, 1, "stays firing until it has been clear for a while");
  now.advance(MIN_CLEAR_MS);
  engine.evaluate([recovered]);
  assert.equal(engine.active().length, 0);
});

test("a degraded backend raises sitegw-degraded; turning monitoring off ends it", () => {
  const { engine } = setup();
  const snapshot = {
    enabled: true, reachable: true, available: true, mode: "ops",
    status: okStatus([{ id: "deepseek-v41", enabled: true, status: "degraded" }]),
  };
  engine.evaluate([siteGatewayAlertUnit(snapshot, GZ)]);
  assert.deepEqual(engine.active().map((a) => a.ruleId), ["sitegw-degraded"]);
  assert.match(engine.active()[0].summary, /deepseek-v41/);
  // Monitoring removed from the configuration: the unit is gone, so its alerts end.
  engine.evaluate([]);
  assert.equal(engine.active().length, 0);
});

test("each gateway alerts under its own page id; removing one ends only its alerts", () => {
  const { engine } = setup();
  const a = siteGatewayAlertUnit({ enabled: true, reachable: false }, { id: "gz", name: "Guomao" });
  const b = siteGatewayAlertUnit({ enabled: true, reachable: false }, { id: "bj", name: "Beijing" });
  engine.evaluate([a, b]);
  assert.deepEqual(engine.active().map((x) => x.unitId).sort(), ["sitegw:bj", "sitegw:gz"]);
  engine.evaluate([a]);
  assert.deepEqual(engine.active().map((x) => x.unitId), ["sitegw:gz"]);
  assert.equal(siteGatewayAlertUnit({ enabled: true, reachable: false }, {}), null, "no id, no unit");
});
