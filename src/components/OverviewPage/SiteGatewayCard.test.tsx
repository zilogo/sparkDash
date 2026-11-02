import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SiteGatewayCard } from "./SiteGatewayCard";
import { cleanupRenders, flush, render } from "../../testing/render";
import { gatewaySnapshot, gatewaySummary, unreachableSummary } from "../../testing/siteGateway";

vi.mock("../../api/client", () => ({ fetchSiteGateways: vi.fn(), fetchSiteGateway: vi.fn() }));
import { fetchSiteGateway, fetchSiteGateways } from "../../api/client";
const fetchList = vi.mocked(fetchSiteGateways);
const fetchOne = vi.mocked(fetchSiteGateway);

describe("Site Gateway card", () => {
  afterEach(() => { cleanupRenders(); vi.useRealTimers(); fetchList.mockReset(); fetchOne.mockReset(); });

  it("is absent when no gateway is configured", async () => {
    fetchList.mockResolvedValue({ enabled: false, gateways: [] });
    const { container } = render(<SiteGatewayCard />);
    await flush();
    expect(container.textContent).toBe("");
  });

  describe("one gateway: the full card", () => {
    it("shows its name, in-flight, requests, 5xx rate, p95 and a chip per backend", async () => {
      fetchList.mockResolvedValue({ enabled: true, gateways: [gatewaySummary()] });
      fetchOne.mockResolvedValue(gatewaySnapshot());
      const { container } = render(<SiteGatewayCard />);
      await flush();
      expect(fetchOne).toHaveBeenCalledWith("gz");
      const text = container.textContent ?? "";
      expect(text).toContain("Guomao");
      expect(text).toContain("1 backend degraded");
      expect(text).toContain("In flight");
      expect(text).toContain("Req / 5 min");
      expect(text).toContain("40");
      expect(text).toContain("3%");
      expect(text).toContain("10 s");
      expect(text).toContain("deepseek-v41");
      expect(text).toContain("media");
    });

    it("Details opens that gateway", async () => {
      fetchList.mockResolvedValue({ enabled: true, gateways: [gatewaySummary({ id: "gz" })] });
      fetchOne.mockResolvedValue(gatewaySnapshot());
      const onOpenGateway = vi.fn();
      const { container } = render(<SiteGatewayCard onOpenGateway={onOpenGateway} onOpenList={() => {}} />);
      await flush();
      act(() => [...container.querySelectorAll("button")].find((b) => b.textContent === "Details")!.click());
      expect(onOpenGateway).toHaveBeenCalledWith("gz");
    });

    it("liveness-only mode says so and shows no invented counts", async () => {
      fetchList.mockResolvedValue({ enabled: true, gateways: [gatewaySummary({ mode: "liveness" })] });
      fetchOne.mockResolvedValue(gatewaySnapshot({ mode: "liveness", status: null, tokenConfigured: false }));
      const { container } = render(<SiteGatewayCard />);
      await flush();
      const text = container.textContent ?? "";
      expect(text).toContain("liveness only");
      expect(text).not.toContain("Req / 5 min");
    });

    it("an unreachable gateway says unknown, not zero", async () => {
      fetchList.mockResolvedValue({ enabled: true, gateways: [unreachableSummary()] });
      fetchOne.mockResolvedValue(gatewaySnapshot({ available: false, reachable: false, mode: "unavailable", status: null }));
      const { container } = render(<SiteGatewayCard />);
      await flush();
      expect(container.textContent).toContain("did not answer");
      expect(container.textContent).not.toContain("Req / 5 min");
    });
  });

  describe("several gateways: a compact row each", () => {
    const gateways = [
      gatewaySummary({ id: "gz", name: "Guomao", servicesReady: 2, servicesTotal: 2, inflightTotal: 3, requests: 100, errorRate: 0.01 }),
      unreachableSummary({ id: "bj", name: "Beijing", url: "http://10.0.0.5:8200" }),
      gatewaySummary({ id: "sh", name: "Shanghai", url: "http://10.0.0.6:8200", mode: "liveness", servicesReady: null, servicesTotal: null,
        inflightTotal: null, requests: null, errorRate: null, p95Ms: null }),
    ];

    it("lists every gateway with its state, in-flight and 5xx rate; unknown is a dash", async () => {
      fetchList.mockResolvedValue({ enabled: true, gateways });
      const { container } = render(<SiteGatewayCard />);
      await flush();
      expect(fetchOne).not.toHaveBeenCalled();
      const rows = [...container.querySelectorAll(".sg-row")];
      expect(rows.map((r) => r.querySelector(".sg-row__name")?.textContent)).toEqual(["Guomao", "Beijing", "Shanghai"]);
      expect(rows[0].textContent).toContain("3 in flight");
      expect(rows[0].textContent).toContain("1% 5xx");
      expect(rows[0].getAttribute("aria-label")).toBe("Guomao: Ready");
      expect(rows[1].getAttribute("aria-label")).toBe("Beijing: Unreachable");
      expect(rows[1].querySelector(".sg-row__dot--bad")).not.toBeNull();
      expect(rows[1].textContent).toContain("— in flight");
      expect(rows[2].getAttribute("aria-label")).toBe("Shanghai: Liveness only");
      expect(rows[2].querySelector(".sg-row__dot--warn")).not.toBeNull();
    });

    it("a row opens its gateway; All opens the list", async () => {
      fetchList.mockResolvedValue({ enabled: true, gateways });
      const onOpenGateway = vi.fn();
      const onOpenList = vi.fn();
      const { container } = render(<SiteGatewayCard onOpenGateway={onOpenGateway} onOpenList={onOpenList} />);
      await flush();
      act(() => container.querySelectorAll<HTMLButtonElement>(".sg-row")[1].click());
      expect(onOpenGateway).toHaveBeenCalledWith("bj");
      act(() => [...container.querySelectorAll("button")].find((b) => b.textContent === "All")!.click());
      expect(onOpenList).toHaveBeenCalled();
    });
  });
});
