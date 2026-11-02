import { afterEach, describe, expect, it, vi } from "vitest";
import { ENERGY_ID, KIOSK_ID, OVERVIEW_ID, SITE_GATEWAY_ID, SITE_GATEWAY_PREFIX, TEMPS_ID, benchId, benchTypeOf, idToPath, initialActiveId, isPageId, isStaleSparkId, pathToId, siteGatewayDetailId, siteGatewayIdOf } from "./constants";

describe("route helpers", () => {
  it("round-trips ids and paths", () => {
    expect(pathToId("/energy")).toBe(ENERGY_ID);
    expect(pathToId("/temps")).toBe(TEMPS_ID);
    expect(idToPath(TEMPS_ID)).toBe("/temps");
    expect(pathToId("/spark/a%20b")).toBe("a b");
    expect(idToPath("a b")).toBe("/spark/a%20b");
    expect(pathToId(idToPath(benchId("decode")))).toBe(benchId("decode"));
    expect(pathToId("/showcase/x")).toBeNull();
    expect(idToPath(KIOSK_ID)).toBe("/kiosk");
    expect(pathToId("/kiosk/")).toBe(KIOSK_ID);
    expect(pathToId("/nothing-here")).toBe(OVERVIEW_ID);
    expect(idToPath(SITE_GATEWAY_ID)).toBe("/site-gateway");
    expect(pathToId("/site-gateway")).toBe(SITE_GATEWAY_ID);
    expect(isPageId(SITE_GATEWAY_ID)).toBe(true);
    expect(SITE_GATEWAY_ID).toBe("__site_gateway__");
    // The server gives each gateway's alerts this id (SITE_GATEWAY_UNIT_PREFIX in SiteGatewayProbe.js).
    expect(SITE_GATEWAY_PREFIX).toBe("sitegw:");
    expect(siteGatewayDetailId("gz")).toBe("sitegw:gz");
    expect(siteGatewayIdOf("sitegw:gz")).toBe("gz");
    expect(siteGatewayIdOf("sitegw:")).toBeNull();
    expect(siteGatewayIdOf("spark1")).toBeNull();
    expect(idToPath("sitegw:gz")).toBe("/site-gateway/gz");
    expect(pathToId("/site-gateway/gz")).toBe("sitegw:gz");
    expect(pathToId("/site-gateway/a%20b/")).toBe("sitegw:a b");
    expect(idToPath("sitegw:a b")).toBe("/site-gateway/a%20b");
    expect(isPageId("sitegw:gz")).toBe(true);
    expect(isStaleSparkId("sitegw:gz", ["spark1"], true)).toBe(false);
  });

  describe("initialActiveId", () => {
    afterEach(() => vi.unstubAllGlobals());
    it("reads the deep link synchronously, so /energy never starts on the Overview", () => {
      vi.stubGlobal("location", { pathname: "/energy" });
      expect(initialActiveId()).toBe(ENERGY_ID);
      vi.stubGlobal("location", { pathname: "/spark/alpha" });
      expect(initialActiveId()).toBe("alpha");
    });
    it("falls back to the Overview for showcase paths or a missing pathname", () => {
      vi.stubGlobal("location", { pathname: "/showcase/alpha" });
      expect(initialActiveId()).toBe(OVERVIEW_ID);
      vi.stubGlobal("location", {});
      expect(initialActiveId()).toBe(OVERVIEW_ID);
    });
  });

  describe("isStaleSparkId", () => {
    it("flags a Spark that left the fleet, once the fleet is known", () => {
      expect(isStaleSparkId("gone", ["a", "b"], true)).toBe(true);
      expect(isStaleSparkId("a", ["a", "b"], true)).toBe(false);
    });
    it("never flags pages, the Overview, or anything before the first fleet list", () => {
      expect(isStaleSparkId(ENERGY_ID, [], true)).toBe(false);
      expect(isStaleSparkId(benchId("decode"), [], true)).toBe(false);
      expect(isStaleSparkId(OVERVIEW_ID, [], true)).toBe(false);
      expect(isStaleSparkId(null, [], true)).toBe(false);
      expect(isStaleSparkId("gone", [], false)).toBe(false);
    });
  });
});
