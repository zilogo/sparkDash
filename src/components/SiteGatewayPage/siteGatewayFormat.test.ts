import { describe, expect, it } from "vitest";
import {
  UNKNOWN, describeTestResult, fmtAgo, fmtLatency, fmtPercent, fmtUptime, gatewayUrlProblem, hostPort, summaryState, trendBuckets,
} from "./siteGatewayFormat";
import { gatewaySnapshot, gatewaySummary, unreachableSummary } from "../../testing/siteGateway";

describe("siteGatewayFormat", () => {
  it("formats unknown as a dash and known values compactly", () => {
    expect(fmtPercent(null)).toBe(UNKNOWN);
    expect(fmtPercent(0)).toBe("0%");
    expect(fmtPercent(0.004)).toBe("<1%");
    expect(fmtPercent(0.25)).toBe("25%");
    expect(fmtLatency(undefined)).toBe(UNKNOWN);
    expect(fmtLatency(250)).toBe("250 ms");
    expect(fmtLatency(2500)).toBe("2.5 s");
    expect(fmtLatency(12_000)).toBe("12 s");
    expect(fmtUptime(null)).toBe(UNKNOWN);
    expect(fmtUptime(90_000)).toBe("1d 1h");
    expect(fmtUptime(3700)).toBe("1h 1m");
  });

  it("splits each minute into 5xx, 429 and the remaining requests", () => {
    const buckets = trendBuckets(gatewaySnapshot());
    expect(buckets).toHaveLength(2);
    expect(buckets[0].values).toEqual({ status5xx: 1, rateLimited: 2, other: 9 });
    expect(buckets[1].values).toEqual({ status5xx: 0, rateLimited: 0, other: 8 });
    expect(trendBuckets(null)).toEqual([]);
  });

  it("fmtAgo and hostPort", () => {
    const now = Date.parse("2026-11-02T08:00:00Z");
    expect(fmtAgo(null)).toBe(UNKNOWN);
    expect(fmtAgo("2026-11-02T07:59:50Z", now)).toBe("10s ago");
    expect(fmtAgo("2026-11-02T07:50:00Z", now)).toBe("10m ago");
    expect(fmtAgo("2026-11-02T05:00:00Z", now)).toBe("3h ago");
    expect(hostPort("http://100.64.0.21:8200")).toBe("100.64.0.21:8200");
    expect(hostPort("not a url")).toBe("not a url");
  });

  describe("gatewayUrlProblem mirrors the server's URL rule", () => {
    it.each([
      "http://100.64.0.21:8200", "http://127.0.0.1:8200", "https://10.1.2.3", "http://172.16.0.1:1/", "http://192.168.9.124:8200",
      "http://[::1]:8200", "  http://100.127.255.255:8200  ",
    ])("accepts %s", (url) => expect(gatewayUrlProblem(url)).toBeNull());

    it.each([
      "", "   ", "100.64.0.21:8200", "ftp://100.64.0.21", "http://8.8.8.8:8200", "http://100.128.0.1", "http://172.32.0.1", "http://192.169.0.1",
      "http://example.com", "http://karmabox-5e4a.local:8200", "http://user:pw@100.64.0.21", "http://100.64.0.21/ops", "http://100.64.0.21:8200?x=1",
      "http://100.64.0.21:8200#frag", "http://300.64.0.21",
    ])("rejects %j", (url) => expect(gatewayUrlProblem(url)).toEqual(expect.any(String)));
  });

  describe("summaryState", () => {
    it("tells ready, partly not ready, liveness only, unreachable, checking, config error and unknown apart", () => {
      expect(summaryState(gatewaySummary({ servicesReady: 2, servicesTotal: 2 }), false)).toEqual({ tone: "good", text: "Ready" });
      expect(summaryState(gatewaySummary(), false)).toEqual({ tone: "bad", text: "1 of 2 not ready" });
      expect(summaryState(gatewaySummary({ mode: "liveness", servicesReady: null, servicesTotal: null }), false).text).toBe("Liveness only");
      expect(summaryState(unreachableSummary(), false)).toEqual({ tone: "bad", text: "Unreachable" });
      expect(summaryState(gatewaySummary({ reachable: null, available: false, mode: null }), false).text).toBe("Checking…");
      expect(summaryState(unreachableSummary({ error: "site-gateway-configuration-invalid" }), false).text).toBe("Invalid URL");
      expect(summaryState(gatewaySummary(), true).text).toBe("Status unknown");
      expect(summaryState(gatewaySummary({ servicesReady: null, servicesTotal: null }), false).text).toBe("Status unknown");
    });
  });

  describe("describeTestResult", () => {
    it("explains each outcome in plain words", () => {
      expect(describeTestResult({ ok: true, mode: "ops", reachable: true, error: null, siteId: "site-01", services: 2 }).text).toContain("2 backends");
      expect(describeTestResult({ ok: true, mode: "ops", reachable: true, error: null, siteId: "site-01", services: 1 }).text).toContain("1 backend)");
      expect(describeTestResult({ ok: true, mode: "liveness", reachable: true, error: null, siteId: null, services: null }).text).toContain("liveness only");
      const wrongKey = describeTestResult({ ok: true, mode: "liveness", reachable: true, error: "site-gateway-ops-unavailable", siteId: null, services: null });
      expect(wrongKey.tone).toBe("warn");
      expect(wrongKey.text).toContain("did not accept this key");
      expect(describeTestResult({ ok: false, mode: "unavailable", reachable: false, error: "site-gateway-url-invalid", siteId: null, services: null }).tone).toBe("bad");
      expect(describeTestResult({ ok: false, mode: "unavailable", reachable: false, error: "site-gateway-unreachable", siteId: null, services: null }).text).toContain("did not answer");
    });
  });
});
