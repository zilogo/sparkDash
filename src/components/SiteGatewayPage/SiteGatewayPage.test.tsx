import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SiteGatewayPage } from "./SiteGatewayPage";
import { cleanupRenders, flush, render } from "../../testing/render";
import { gatewaySnapshot } from "../../testing/siteGateway";
import { UNKNOWN } from "./siteGatewayFormat";

vi.mock("../../api/client", () => ({ fetchSiteGateway: vi.fn(), fetchSiteGateways: vi.fn() }));
import { fetchSiteGateway } from "../../api/client";
const fetchGateway = vi.mocked(fetchSiteGateway);

describe("Site Gateway detail page", () => {
  afterEach(() => { cleanupRenders(); fetchGateway.mockReset(); });

  it("asks for that gateway only and shows its name and address", async () => {
    fetchGateway.mockResolvedValue(gatewaySnapshot({ id: "bj", name: "Beijing", url: "http://10.0.0.5:8200" }));
    const { container } = render(<SiteGatewayPage gatewayId="bj" onBack={() => {}} />);
    await flush();
    expect(fetchGateway).toHaveBeenCalledWith("bj");
    expect(container.querySelector("h1")?.textContent).toBe("Beijing");
    expect(container.textContent).toContain("http://10.0.0.5:8200");
  });

  it("lists backends and callers with unknown shown as an em dash", async () => {
    fetchGateway.mockResolvedValue(gatewaySnapshot());
    const { container } = render(<SiteGatewayPage gatewayId="gz" onBack={() => {}} />);
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

  it("has a back link to the list", async () => {
    fetchGateway.mockResolvedValue(gatewaySnapshot());
    const onBack = vi.fn();
    const { container } = render(<SiteGatewayPage gatewayId="gz" onBack={onBack} />);
    await flush();
    const back = [...container.querySelectorAll("button")].find((b) => b.textContent?.includes("Site Gateways"))!;
    act(() => back.click());
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it("says so when the gateway does not exist (any more) and still offers the way back", async () => {
    fetchGateway.mockRejectedValue(new Error("Site Gateway not found"));
    const onBack = vi.fn();
    const { container } = render(<SiteGatewayPage gatewayId="gone" onBack={onBack} />);
    await flush();
    expect(container.textContent).toContain("not configured any more");
    expect(container.querySelector("table")).toBeNull();
    act(() => [...container.querySelectorAll("button")].find((b) => b.textContent?.includes("Site Gateways"))!.click());
    expect(onBack).toHaveBeenCalled();
  });

  it("liveness-only mode says how to get more and shows no tables", async () => {
    fetchGateway.mockResolvedValue(gatewaySnapshot({ mode: "liveness", status: null, tokenConfigured: false }));
    const { container } = render(<SiteGatewayPage gatewayId="gz" onBack={() => {}} />);
    await flush();
    expect(container.textContent).toContain("Liveness only");
    expect(container.textContent).toContain("ops key");
    expect(container.querySelector("table")).toBeNull();
  });

  it("unreachable gateway: unknown, not zero", async () => {
    fetchGateway.mockResolvedValue(gatewaySnapshot({ available: false, reachable: false, mode: "unavailable", status: null }));
    const { container } = render(<SiteGatewayPage gatewayId="gz" onBack={() => {}} />);
    await flush();
    expect(container.textContent).toContain("did not answer");
    expect(container.textContent).toContain("unknown, not zero");
    expect(container.querySelector("table")).toBeNull();
  });

  it("a server error shows unknown state, not a made-up one", async () => {
    fetchGateway.mockRejectedValue(new Error("HTTP 500"));
    const { container } = render(<SiteGatewayPage gatewayId="gz" onBack={() => {}} />);
    await flush();
    expect(container.textContent).toContain("did not answer; Site Gateway state is unknown");
  });
});
