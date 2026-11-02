import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SiteGatewayListPage } from "./SiteGatewayListPage";
import { cleanupRenders, flush, render } from "../../testing/render";
import { gatewaySummary, unreachableSummary } from "../../testing/siteGateway";

vi.mock("../../api/client", () => ({
  fetchSiteGateways: vi.fn(), fetchSiteGateway: vi.fn(), deleteSiteGateway: vi.fn(),
  createSiteGateway: vi.fn(), updateSiteGateway: vi.fn(), testSiteGateway: vi.fn(),
}));
import { deleteSiteGateway, fetchSiteGateways } from "../../api/client";
const fetchList = vi.mocked(fetchSiteGateways);
const remove = vi.mocked(deleteSiteGateway);

const byLabel = (root: ParentNode, label: string) => root.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!;
const buttonText = (root: ParentNode, text: string) => [...root.querySelectorAll("button")].find((b) => b.textContent === text)!;

describe("Site Gateways list page", () => {
  afterEach(() => { cleanupRenders(); fetchList.mockReset(); remove.mockReset(); });

  it("shows a card per gateway with state and headline numbers; unknown is a dash", async () => {
    fetchList.mockResolvedValue({
      enabled: true,
      gateways: [
        gatewaySummary({ id: "gz", name: "Guomao", servicesReady: 2, servicesTotal: 2 }),
        gatewaySummary({ id: "bj", name: "Beijing", url: "http://10.0.0.5:8200", mode: "liveness", servicesReady: null, servicesTotal: null,
          inflightTotal: null, requests: null, status5xx: null, errorRate: null, p95Ms: null }),
      ],
    });
    const { container } = render(<SiteGatewayListPage onOpen={() => {}} />);
    await flush();
    const cards = container.querySelectorAll("article.sg-card");
    expect(cards).toHaveLength(2);
    const gz = cards[0].textContent ?? "";
    expect(gz).toContain("Guomao");
    expect(gz).toContain("100.64.0.21:8200");
    expect(gz).toContain("Ready");
    expect(gz).toContain("2/2");
    expect(gz).toContain("40");
    expect(gz).toContain("3%");
    expect(gz).toContain("10 s");
    const bj = cards[1].textContent ?? "";
    expect(bj).toContain("Liveness only");
    expect(bj).toContain("—");
    expect(bj).not.toMatch(/\b0%/);
  });

  it("an unreachable gateway still gets its card, with unknown numbers", async () => {
    fetchList.mockResolvedValue({ enabled: true, gateways: [unreachableSummary({ id: "down", name: "Down GW" })] });
    const { container } = render(<SiteGatewayListPage onOpen={() => {}} />);
    await flush();
    const card = container.querySelector("article.sg-card")!;
    expect(card.textContent).toContain("Down GW");
    expect(card.textContent).toContain("Unreachable");
    expect(card.textContent).toContain("Updated —");
    expect([...card.querySelectorAll(".sg-kpi__value")].every((v) => v.textContent === "—")).toBe(true);
  });

  it("clicking a card opens that gateway", async () => {
    fetchList.mockResolvedValue({ enabled: true, gateways: [gatewaySummary({ id: "gz" }), gatewaySummary({ id: "bj", name: "Beijing", url: "http://10.0.0.5:8200" })] });
    const onOpen = vi.fn();
    const { container } = render(<SiteGatewayListPage onOpen={onOpen} />);
    await flush();
    act(() => byLabel(container, "Open Beijing").click());
    expect(onOpen).toHaveBeenCalledWith("bj");
  });

  it("explains how to add the first gateway when there is none", async () => {
    fetchList.mockResolvedValue({ enabled: false, gateways: [] });
    const { container } = render(<SiteGatewayListPage onOpen={() => {}} />);
    await flush();
    expect(container.querySelector("article")).toBeNull();
    expect(container.textContent).toContain("No Site Gateway is monitored yet");
    expect(container.textContent).toContain("ops key");
    act(() => buttonText(container.querySelector(".sg-empty-state")!, "Add Site Gateway").click());
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain("Add Site Gateway");
  });

  it("the header button opens the add dialog; edit opens it filled in", async () => {
    fetchList.mockResolvedValue({ enabled: true, gateways: [gatewaySummary()] });
    const { container } = render(<SiteGatewayListPage onOpen={() => {}} />);
    await flush();
    act(() => [...container.querySelectorAll("button")].find((b) => b.textContent?.includes("Add Site Gateway"))!.click());
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain("Add Site Gateway");
    act(() => buttonText(document.body, "Cancel").click());
    act(() => byLabel(container, "Edit Guomao").click());
    await flush();
    const dialog = document.querySelector('[role="dialog"]')!;
    expect(dialog.textContent).toContain("Edit Site Gateway");
    expect(dialog.querySelector<HTMLInputElement>('input[type="text"][placeholder="Guomao"]')?.value).toBe("Guomao");
  });

  it("removing asks first, then deletes and reloads", async () => {
    fetchList.mockResolvedValue({ enabled: true, gateways: [gatewaySummary()] });
    remove.mockResolvedValue({ success: true });
    const { container } = render(<SiteGatewayListPage onOpen={() => {}} />);
    await flush();
    act(() => byLabel(container, "Remove Guomao").click());
    expect(remove).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Remove?");
    act(() => buttonText(container, "Keep").click());
    expect(container.textContent).not.toContain("Remove?");
    act(() => byLabel(container, "Remove Guomao").click());
    fetchList.mockResolvedValue({ enabled: false, gateways: [] });
    await act(async () => { buttonText(container, "Remove").click(); });
    await flush();
    expect(remove).toHaveBeenCalledWith("gz");
    expect(container.querySelector("article")).toBeNull();
  });

  it("a failed removal says why and keeps the card", async () => {
    fetchList.mockResolvedValue({ enabled: true, gateways: [gatewaySummary()] });
    remove.mockRejectedValue(new Error("disk full"));
    const { container } = render(<SiteGatewayListPage onOpen={() => {}} />);
    await flush();
    act(() => byLabel(container, "Remove Guomao").click());
    await act(async () => { buttonText(container, "Remove").click(); });
    await flush();
    expect(container.querySelector('[role="alert"]')?.textContent).toBe("disk full");
    expect(container.querySelector("article")).not.toBeNull();
  });

  it("a gateway from the server environment is read-only: no edit, no remove", async () => {
    fetchList.mockResolvedValue({ enabled: true, gateways: [gatewaySummary({ id: "env", name: "Site Gateway (env)", source: "env" })] });
    const { container } = render(<SiteGatewayListPage onOpen={() => {}} />);
    await flush();
    expect(container.textContent).toContain("from server environment");
    expect(container.querySelector('button[aria-label^="Edit"]')).toBeNull();
    expect(container.querySelector('button[aria-label^="Remove"]')).toBeNull();
  });

  it("when the dashboard server does not answer the state is unknown, not empty", async () => {
    fetchList.mockRejectedValue(new Error("HTTP 500"));
    const { container } = render(<SiteGatewayListPage onOpen={() => {}} />);
    await flush();
    expect(container.textContent).toContain("did not answer");
    expect(container.textContent).not.toContain("No Site Gateway is monitored yet");
  });
});
