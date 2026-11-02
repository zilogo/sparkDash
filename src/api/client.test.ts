import { afterEach, describe, expect, it, vi } from "vitest";

// client.ts reads the token when the module loads, so each case stores (or
// clears) it first and imports a fresh copy of the module.
async function loadClient() {
  vi.resetModules();
  return import("./client");
}

describe("fetchInferenceActivity", () => {
  afterEach(() => { localStorage.removeItem("sparkdashToken"); vi.unstubAllGlobals(); });
  it("uses the ordinary authenticated dashboard GET without sending an inference key", async () => {
    localStorage.setItem("sparkdashToken", "dashboard-token");
    const payload = { enabled: false, available: false, labels: [], active: [], recent: [] };
    const fetchMock = vi.fn().mockResolvedValue(Response.json(payload));
    vi.stubGlobal("fetch", fetchMock);
    const { fetchInferenceActivity } = await loadClient();
    expect(await fetchInferenceActivity()).toEqual(payload);
    expect(fetchMock).toHaveBeenCalledWith("/api/inference/activity", { headers: { Authorization: "Bearer dashboard-token" } });
  });
});

describe("Site Gateway client", () => {
  afterEach(() => { localStorage.removeItem("sparkdashToken"); vi.unstubAllGlobals(); });

  it("reads the list and one detail with the dashboard token; the gateway token never travels on reads", async () => {
    localStorage.setItem("sparkdashToken", "dashboard-token");
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(Response.json({ enabled: false, gateways: [] })));
    vi.stubGlobal("fetch", fetchMock);
    const { fetchSiteGateways, fetchSiteGateway } = await loadClient();
    expect(await fetchSiteGateways()).toEqual({ enabled: false, gateways: [] });
    expect(fetchMock).toHaveBeenCalledWith("/api/site-gateways", { headers: { Authorization: "Bearer dashboard-token" } });
    await fetchSiteGateway("a b/c");
    expect(fetchMock).toHaveBeenLastCalledWith("/api/site-gateways/a%20b%2Fc", { headers: { Authorization: "Bearer dashboard-token" } });
  });

  it("creates, updates, deletes and tests with JSON bodies on the right routes", async () => {
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(Response.json({ success: true })));
    vi.stubGlobal("fetch", fetchMock);
    const { createSiteGateway, updateSiteGateway, deleteSiteGateway, testSiteGateway } = await loadClient();
    await createSiteGateway({ name: "GZ", url: "http://100.64.0.21:8200", token: "t" });
    await updateSiteGateway("gz", { token: "" });
    await deleteSiteGateway("gz");
    await testSiteGateway({ url: "http://100.64.0.21:8200", id: "gz" });
    const calls = fetchMock.mock.calls.map(([url, init]) => [url, init.method, init.body]);
    expect(calls).toEqual([
      ["/api/site-gateways", "POST", JSON.stringify({ name: "GZ", url: "http://100.64.0.21:8200", token: "t" })],
      ["/api/site-gateways/gz", "PATCH", JSON.stringify({ token: "" })],
      ["/api/site-gateways/gz", "DELETE", undefined],
      ["/api/site-gateways/test", "POST", JSON.stringify({ url: "http://100.64.0.21:8200", id: "gz" })],
    ]);
  });

  it("surfaces the server's error message", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ error: "A Site Gateway with this URL is already configured" }, { status: 409 })));
    const { createSiteGateway } = await loadClient();
    await expect(createSiteGateway({ url: "http://100.64.0.21:8200" })).rejects.toThrow("already configured");
  });
});

describe("cancelShowcaseBeacon", () => {
  afterEach(() => {
    localStorage.removeItem("sparkdashToken");
    vi.unstubAllGlobals();
  });

  it("sends the stored access token with the keepalive DELETE", async () => {
    localStorage.setItem("sparkdashToken", "s3cret");
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const { cancelShowcaseBeacon } = await loadClient();

    cancelShowcaseBeacon("spark 1", "sess/42");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/sparks/spark%201/llm/showcase/sess%2F42");
    expect(init).toMatchObject({ method: "DELETE", keepalive: true });
    expect(init.headers).toEqual({ Authorization: "Bearer s3cret" });
  });

  it("sends no Authorization header when no token is stored", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const { cancelShowcaseBeacon } = await loadClient();

    cancelShowcaseBeacon("spark-1", "abc");

    const [, init] = fetchMock.mock.calls[0];
    expect(init).toMatchObject({ method: "DELETE", keepalive: true });
    expect(init.headers).not.toHaveProperty("Authorization");
  });

  it("swallows a rejected request so unload handlers never throw", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));
    const { cancelShowcaseBeacon } = await loadClient();

    expect(() => cancelShowcaseBeacon("spark-1", "abc")).not.toThrow();
    await Promise.resolve();
  });
});
