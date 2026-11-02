import { afterEach, describe, expect, it, vi } from "vitest";
import { SiteGatewayCard } from "./SiteGatewayCard";
import { cleanupRenders, flush, render } from "../../testing/render";
import { gatewaySnapshot } from "../../testing/siteGateway";

vi.mock("../../api/client", () => ({ fetchSiteGateway: vi.fn() }));
import { fetchSiteGateway } from "../../api/client";
const fetchGateway = vi.mocked(fetchSiteGateway);

describe("Site Gateway card", () => {
  afterEach(() => { cleanupRenders(); vi.useRealTimers(); fetchGateway.mockReset(); });

  it("is absent when the server has no gateway configured", async () => {
    fetchGateway.mockResolvedValue(gatewaySnapshot({ enabled: false, available: false, reachable: null, mode: null, status: null }));
    const { container } = render(<SiteGatewayCard />);
    await flush();
    expect(container.textContent).toBe("");
  });

  it("shows in-flight, requests, 5xx rate, p95 and a chip per backend", async () => {
    fetchGateway.mockResolvedValue(gatewaySnapshot());
    const { container } = render(<SiteGatewayCard />);
    await flush();
    const text = container.textContent ?? "";
    expect(text).toContain("1 backend degraded");
    expect(text).toContain("In flight");
    expect(text).toContain("Req / 5 min");
    expect(text).toContain("40");
    expect(text).toContain("3%");
    expect(text).toContain("10 s");
    expect(text).toContain("deepseek-v41");
    expect(text).toContain("media");
  });

  it("liveness-only mode says so and shows no invented counts", async () => {
    fetchGateway.mockResolvedValue(gatewaySnapshot({ mode: "liveness", status: null, tokenConfigured: false }));
    const { container } = render(<SiteGatewayCard />);
    await flush();
    const text = container.textContent ?? "";
    expect(text).toContain("liveness only");
    expect(text).toContain("SPARKDASH_SITEGW_TOKEN");
    expect(text).not.toContain("Req / 5 min");
  });

  it("unreachable gateway is reported as unknown traffic, not zero", async () => {
    fetchGateway.mockResolvedValue(gatewaySnapshot({ available: false, reachable: false, mode: "unavailable", status: null }));
    const { container } = render(<SiteGatewayCard />);
    await flush();
    expect(container.textContent).toContain("Unreachable");
    expect(container.textContent).toContain("unknown");
    expect(container.textContent).not.toContain("In flight");
  });

  it("a dashboard server that does not answer is shown as unknown", async () => {
    fetchGateway.mockRejectedValue(new Error("down"));
    const { container } = render(<SiteGatewayCard />);
    await flush();
    expect(container.textContent).toContain("Status unknown");
  });

  it("shows an em dash for a backend with no requests rather than 0%", async () => {
    const snap = gatewaySnapshot();
    snap.status!.traffic.services = [];
    fetchGateway.mockResolvedValue(snap);
    const { container } = render(<SiteGatewayCard />);
    await flush();
    expect(container.textContent).toContain("—");
  });
});
