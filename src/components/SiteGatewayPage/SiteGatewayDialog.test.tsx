import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SiteGatewayDialog } from "./SiteGatewayDialog";
import { cleanupRenders, flush, render } from "../../testing/render";
import { gatewaySummary } from "../../testing/siteGateway";

vi.mock("../../api/client", () => ({ createSiteGateway: vi.fn(), updateSiteGateway: vi.fn(), testSiteGateway: vi.fn() }));
import { createSiteGateway, testSiteGateway, updateSiteGateway } from "../../api/client";
const create = vi.mocked(createSiteGateway);
const update = vi.mocked(updateSiteGateway);
const test = vi.mocked(testSiteGateway);

const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]')!;
const input = (label: string) => dialog().querySelector<HTMLInputElement>(`input[id$="-${label}"]`)!;
const button = (text: string) => [...dialog().querySelectorAll("button")].find((b) => b.textContent === text)!;

function typeInto(el: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  act(() => {
    setter.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

const saved = { success: true, gateway: {} as never };

function setup(gateway = null as ReturnType<typeof gatewaySummary> | null) {
  const onClose = vi.fn();
  const onSaved = vi.fn();
  render(<SiteGatewayDialog open gateway={gateway} onClose={onClose} onSaved={onSaved} />);
  return { onClose, onSaved };
}

describe("Site Gateway dialog", () => {
  afterEach(() => { cleanupRenders(); create.mockReset(); update.mockReset(); test.mockReset(); });

  it("Add and Test stay disabled until the URL is acceptable, and it says what is wrong", () => {
    setup();
    expect(button("Add").disabled).toBe(true);
    expect(button("Test connection").disabled).toBe(true);
    typeInto(input("url"), "http://8.8.8.8:8200");
    expect(button("Add").disabled).toBe(true);
    expect(dialog().textContent).toContain("Only loopback, private");
    expect(input("url").getAttribute("aria-invalid")).toBe("true");
    typeInto(input("url"), "http://100.64.0.21:8200");
    expect(button("Add").disabled).toBe(false);
    expect(button("Test connection").disabled).toBe(false);
    expect(input("url").getAttribute("aria-invalid")).toBe("false");
  });

  it("the ops key field is a password field and never shows a saved value", () => {
    setup(gatewaySummary({ tokenConfigured: true }));
    expect(input("token").type).toBe("password");
    expect(input("token").value).toBe("");
    expect(input("token").placeholder).toContain("saved");
  });

  it("adds a gateway with the typed key and closes", async () => {
    create.mockResolvedValue(saved);
    const { onClose, onSaved } = setup();
    typeInto(input("name"), "  Guomao ");
    typeInto(input("url"), "http://100.64.0.21:8200");
    typeInto(input("token"), " ops-key ");
    await act(async () => { button("Add").click(); });
    await flush();
    expect(create).toHaveBeenCalledWith({ name: "Guomao", url: "http://100.64.0.21:8200", token: "ops-key" });
    expect(onSaved).toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });

  it("an empty name and key are simply left out", async () => {
    create.mockResolvedValue(saved);
    setup();
    typeInto(input("url"), "http://100.64.0.21:8200");
    await act(async () => { button("Add").click(); });
    await flush();
    expect(create).toHaveBeenCalledWith({ url: "http://100.64.0.21:8200", name: undefined });
  });

  it("shows the server's refusal and stays open", async () => {
    create.mockRejectedValue(new Error("A Site Gateway with this URL is already configured"));
    const { onClose } = setup();
    typeInto(input("url"), "http://100.64.0.21:8200");
    await act(async () => { button("Add").click(); });
    await flush();
    expect(dialog().querySelector('[role="alert"]')?.textContent).toContain("already configured");
    expect(onClose).not.toHaveBeenCalled();
    expect(button("Add").disabled).toBe(false);
  });

  describe("Test connection", () => {
    it("with a typed key sends the key and shows the ops result", async () => {
      test.mockResolvedValue({ ok: true, mode: "ops", reachable: true, error: null, siteId: "site-01", services: 2 });
      setup();
      typeInto(input("url"), "http://100.64.0.21:8200");
      typeInto(input("token"), "typed");
      await act(async () => { button("Test connection").click(); });
      await flush();
      expect(test).toHaveBeenCalledWith({ url: "http://100.64.0.21:8200", token: "typed" });
      expect(dialog().querySelector('[role="status"]')?.textContent).toContain("Connected with the ops key (site site-01, 2 backends)");
    });

    it("without a key on a new gateway checks liveness only", async () => {
      test.mockResolvedValue({ ok: true, mode: "liveness", reachable: true, error: null, siteId: null, services: null });
      setup();
      typeInto(input("url"), "http://100.64.0.21:8200");
      await act(async () => { button("Test connection").click(); });
      await flush();
      expect(test).toHaveBeenCalledWith({ url: "http://100.64.0.21:8200" });
      expect(dialog().textContent).toContain("liveness only");
    });

    it("when editing with no new key it asks the server to reuse the saved one", async () => {
      test.mockResolvedValue({ ok: true, mode: "ops", reachable: true, error: null, siteId: "s", services: 1 });
      setup(gatewaySummary({ id: "gz", tokenConfigured: true }));
      await act(async () => { button("Test connection").click(); });
      await flush();
      expect(test).toHaveBeenCalledWith({ url: "http://100.64.0.21:8200", id: "gz" });
    });

    it("reports a failure clearly and a changed URL clears the old result", async () => {
      test.mockResolvedValue({ ok: false, mode: "unavailable", reachable: false, error: "site-gateway-unreachable", siteId: null, services: null });
      setup();
      typeInto(input("url"), "http://100.64.0.21:8200");
      await act(async () => { button("Test connection").click(); });
      await flush();
      expect(dialog().querySelector('[role="status"]')?.textContent).toContain("did not answer");
      typeInto(input("url"), "http://100.64.0.22:8200");
      expect(dialog().querySelector('[role="status"]')).toBeNull();
    });

    it("a failing request is shown as an error", async () => {
      test.mockRejectedValue(new Error("HTTP 500"));
      setup();
      typeInto(input("url"), "http://100.64.0.21:8200");
      await act(async () => { button("Test connection").click(); });
      await flush();
      expect(dialog().querySelector('[role="alert"]')?.textContent).toBe("HTTP 500");
    });
  });

  describe("editing", () => {
    const gateway = gatewaySummary({ id: "gz", name: "Guomao", tokenConfigured: true });

    it("Save is disabled until something changes", () => {
      setup(gateway);
      expect(button("Save").disabled).toBe(true);
      typeInto(input("name"), "Guomao 2");
      expect(button("Save").disabled).toBe(false);
    });

    it("renaming keeps the saved key: no token is sent", async () => {
      update.mockResolvedValue(saved);
      const { onSaved } = setup(gateway);
      typeInto(input("name"), "Guomao 2");
      await act(async () => { button("Save").click(); });
      await flush();
      expect(update).toHaveBeenCalledWith("gz", { url: "http://100.64.0.21:8200", name: "Guomao 2" });
      expect(onSaved).toHaveBeenCalled();
    });

    it("a typed key replaces the saved one", async () => {
      update.mockResolvedValue(saved);
      setup(gateway);
      typeInto(input("token"), "new-key");
      await act(async () => { button("Save").click(); });
      await flush();
      expect(update).toHaveBeenCalledWith("gz", { url: "http://100.64.0.21:8200", name: "Guomao", token: "new-key" });
    });

    it("'Remove the saved key' sends an empty token", async () => {
      update.mockResolvedValue(saved);
      setup(gateway);
      const box = dialog().querySelector<HTMLInputElement>('input[type="checkbox"]')!;
      act(() => box.click());
      expect(button("Save").disabled).toBe(false);
      await act(async () => { button("Save").click(); });
      await flush();
      expect(update).toHaveBeenCalledWith("gz", { url: "http://100.64.0.21:8200", name: "Guomao", token: "" });
    });

    it("with the key marked for removal, Test no longer asks the server to reuse it", async () => {
      test.mockResolvedValue({ ok: true, mode: "liveness", reachable: true, error: null, siteId: null, services: null });
      setup(gateway);
      act(() => dialog().querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());
      await act(async () => { button("Test connection").click(); });
      await flush();
      expect(test).toHaveBeenCalledWith({ url: "http://100.64.0.21:8200" });
    });

    it("offers no 'remove key' when none is saved", () => {
      setup(gatewaySummary({ tokenConfigured: false }));
      expect(dialog().querySelector('input[type="checkbox"]')).toBeNull();
    });
  });

  it("Escape and Cancel close it", () => {
    const { onClose } = setup();
    act(() => button("Cancel").click());
    expect(onClose).toHaveBeenCalledTimes(1);
    act(() => void window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});
