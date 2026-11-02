import { afterEach, describe, expect, it, vi } from "vitest";
import { SiteGatewayPage } from "./SiteGatewayPage";
import { fmtLatency, fmtPercent, fmtUptime, trendBuckets, UNKNOWN } from "./siteGatewayFormat";
import { cleanupRenders, flush, render } from "../../testing/render";
import { gatewaySnapshot } from "../../testing/siteGateway";

vi.mock("../../api/client", () => ({ fetchSiteGateway: vi.fn() }));
import { fetchSiteGateway } from "../../api/client";
const fetchGateway = vi.mocked(fetchSiteGateway);

describe("Site Gateway page", () => {
  afterEach(() => { cleanupRenders(); fetchGateway.mockReset(); });

  it("lists backends and callers with unknown shown as an em dash", async () => {
    fetchGateway.mockResolvedValue(gatewaySnapshot());
    const { container } = render(<SiteGatewayPage />);
    await flush();
    const text = container.textContent ?? "";
    expect(text).toContain("deepseek-v41");
    expect(text).toContain("customer-a");
    expect(text).toContain("2.5 s");
    expect(text).toContain("3%");
    // media has no traffic row: its counters are unknown, not 0.
    const mediaRow = [...container.querySelectorAll("tbody tr")].find((row) => row.textContent?.includes("media"));
    expect(mediaRow?.textContent).toContain(UNKNOWN);
    expect(mediaRow?.textContent).toContain("3");
  });

  it("explains monitoring is not configured", async () => {
    fetchGateway.mockResolvedValue(gatewaySnapshot({ enabled: false, available: false, reachable: null, mode: null, status: null }));
    const { container } = render(<SiteGatewayPage />);
    await flush();
    expect(container.textContent).toContain("not configured");
    expect(container.textContent).toContain("SPARKDASH_SITEGW_URL");
  });

  it("liveness-only mode asks for the ops key and shows no tables", async () => {
    fetchGateway.mockResolvedValue(gatewaySnapshot({ mode: "liveness", status: null, tokenConfigured: false }));
    const { container } = render(<SiteGatewayPage />);
    await flush();
    expect(container.textContent).toContain("Liveness only");
    expect(container.textContent).toContain("SPARKDASH_SITEGW_TOKEN");
    expect(container.querySelector("table")).toBeNull();
  });

  it("unreachable gateway: unknown, not zero", async () => {
    fetchGateway.mockResolvedValue(gatewaySnapshot({ available: false, reachable: false, mode: "unavailable", status: null }));
    const { container } = render(<SiteGatewayPage />);
    await flush();
    expect(container.textContent).toContain("did not answer");
    expect(container.textContent).toContain("unknown, not zero");
    expect(container.querySelector("table")).toBeNull();
  });
});

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
});
