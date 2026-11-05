import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sparkdash-group-"));
process.env.SPARKS_JSON_PATH = path.join(tmp, "sparks.json");
process.env.SPARKS_SECRETS_PATH = path.join(tmp, "sparks-secrets.json");
process.env.SECRETS_KEY_PATH = path.join(tmp, ".secrets-key");

const { SparkRegistry } = await import("../SparkRegistry.js");
const { normalizeGroup, validateGroupField, MAX_GROUP_LENGTH } = await import("../groupField.js");

function registry(initial = '{"sparks":[]}\n') {
  fs.writeFileSync(process.env.SPARKS_JSON_PATH, initial);
  fs.rmSync(process.env.SPARKS_SECRETS_PATH, { force: true });
  return new SparkRegistry();
}
const onDisk = () => JSON.parse(fs.readFileSync(process.env.SPARKS_JSON_PATH, "utf8")).sparks;

test("normalizeGroup trims, strips control characters, caps length, empties to null", () => {
  assert.equal(normalizeGroup("  Rack A "), "Rack A");
  assert.equal(normalizeGroup("Ra\u0000ck\n\t A\u007f"), "Rack A");
  assert.equal(normalizeGroup("   "), null);
  assert.equal(normalizeGroup(""), null);
  assert.equal(normalizeGroup(null), null);
  assert.equal(normalizeGroup(undefined), null);
  assert.equal(normalizeGroup(42), null);
  assert.equal(normalizeGroup("x".repeat(100)).length, MAX_GROUP_LENGTH);
});

test("validateGroupField accepts absent, null and strings only", () => {
  assert.equal(validateGroupField({}), null);
  assert.equal(validateGroupField({ group: null }), null);
  assert.equal(validateGroupField({ group: "a" }), null);
  assert.match(validateGroupField({ group: 3 }), /group/);
  assert.match(validateGroupField({ group: ["a"] }), /group/);
});

test("group is persisted, exposed publicly and survives a reload", () => {
  const r = registry();
  r.addSpark({ id: "a", lanIp: "10.0.0.1", group: " DeepSeek " });
  r.addSpark({ id: "b", lanIp: "10.0.0.2" });
  assert.equal(r.toPublic(r.getSpark("a")).group, "DeepSeek");
  assert.equal(r.toPublic(r.getSpark("b")).group, null);
  assert.equal(onDisk().find((s) => s.id === "a").group, "DeepSeek");
  const again = new SparkRegistry();
  assert.equal(again.getSpark("a").group, "DeepSeek");
  assert.equal(again.getSpark("b").group, null);
});

test("legacy sparks.json without group loads as ungrouped", () => {
  const r = registry(JSON.stringify({ sparks: [{ id: "old", lanIp: "10.0.0.3" }] }));
  assert.equal(r.getSpark("old").group, null);
});

test("PATCH semantics: omitted group is kept, null or empty clears, string replaces", () => {
  const r = registry();
  r.addSpark({ id: "a", lanIp: "10.0.0.1", group: "G1" });
  assert.equal(r.patchSpark("a", { name: "Renamed" }).spark.group, "G1");
  assert.equal(r.patchSpark("a", { group: "G2" }).spark.group, "G2");
  assert.equal(r.patchSpark("a", { group: "" }).spark.group, null);
  r.patchSpark("a", { group: "G3" });
  assert.equal(r.patchSpark("a", { group: null }).spark.group, null);
  assert.equal(onDisk()[0].group, null);
});

test("noteDetectedMac does not drop the group", () => {
  const r = registry();
  r.addSpark({ id: "a", lanIp: "10.0.0.1", group: "G1" });
  r.noteDetectedMac("a", "aa:bb:cc:dd:ee:ff");
  assert.equal(r.getSpark("a").group, "G1");
});
