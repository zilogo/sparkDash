import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchSparks, updateSpark } from "../api/client";
import type { SparkConfig } from "../api/types";
import { EditSparkDialog } from "./EditSparkDialog";
import { flush, render } from "../testing/render";

vi.mock("../api/client", () => ({
  deleteSpark: vi.fn(),
  fetchSparks: vi.fn(),
  setSparkPassword: vi.fn(),
  testSpark: vi.fn(),
  testSparkConfig: vi.fn(),
  updateSpark: vi.fn(),
  fetchGpuClock: vi.fn(() => Promise.resolve({ supported: false, reason: "test" })),
  setGpuClock: vi.fn(),
  resetGpuClock: vi.fn(),
}));

const spark: SparkConfig = {
  id: "lab",
  name: "Lab",
  lanIp: "192.168.1.50",
  isLocal: false,
  ssh: { host: "192.168.1.50", user: "zurih", auth: "key", port: 2200 },
};

class MemoryWebSocket {
  static instances: MemoryWebSocket[] = [];
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  readyState = 0;
  constructor(public url: string) {
    MemoryWebSocket.instances.push(this);
  }
  send() {}
  close() {
    this.readyState = 3;
    this.onclose?.(new CloseEvent("close"));
  }
}

describe("EditSparkDialog SSH port", () => {
  beforeEach(() => {
    vi.stubGlobal("WebSocket", MemoryWebSocket);
    Object.defineProperty(window, "location", {
      configurable: true,
      value: { protocol: "http:", host: "localhost:5555" },
    });
    vi.mocked(fetchSparks).mockResolvedValue({ sparks: [spark] });
    vi.mocked(updateSpark).mockResolvedValue({ success: true, spark });
  });
  afterEach(() => vi.unstubAllGlobals());

  it("shows the saved SSH port and saves a new one", async () => {
    render(<EditSparkDialog open sparkId="lab" onClose={() => {}} onSaved={() => {}} />);
    await flush();

    const port = document.getElementById("edit-spark-ssh-port") as HTMLInputElement;
    expect(port).not.toBeNull();
    expect(port.value).toBe("2200");

    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    setter?.call(port, "2222");
    act(() => port.dispatchEvent(new Event("input", { bubbles: true })));

    const save = Array.from(document.querySelectorAll("button")).find((button) => button.textContent === "Save");
    await act(async () => {
      save?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(updateSpark).toHaveBeenCalledWith(
      "lab",
      expect.objectContaining({
        ssh: expect.objectContaining({ user: "zurih", port: 2222 }),
      })
    );
  });
});

describe("EditSparkDialog group", () => {
  beforeEach(() => {
    vi.stubGlobal("WebSocket", MemoryWebSocket);
    Object.defineProperty(window, "location", {
      configurable: true,
      value: { protocol: "http:", host: "localhost:5555" },
    });
    vi.mocked(updateSpark).mockResolvedValue({ success: true, spark });
  });
  afterEach(() => vi.unstubAllGlobals());

  const save = async () => {
    const button = Array.from(document.querySelectorAll("button")).find((b) => b.textContent === "Save");
    await act(async () => {
      button?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
  };
  const type = (el: HTMLInputElement, value: string) => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(el, value);
    act(() => el.dispatchEvent(new Event("input", { bubbles: true })));
  };

  it("offers existing groups, shows the saved one and saves a changed one", async () => {
    vi.mocked(fetchSparks).mockResolvedValue({ sparks: [{ ...spark, group: "DeepSeek" }] });
    render(<EditSparkDialog open sparkId="lab" onClose={() => {}} onSaved={() => {}} existingGroups={["DeepSeek", "Qwen"]} />);
    await flush();
    const input = document.getElementById("edit-spark-group") as HTMLInputElement;
    expect(input.value).toBe("DeepSeek");
    const options = [...document.querySelectorAll(`datalist#${CSS.escape(input.getAttribute("list") ?? "")} option`)].map((o) => o.getAttribute("value"));
    expect(options).toEqual(["DeepSeek", "Qwen"]);
    type(input, " Brand new ");
    await save();
    expect(updateSpark).toHaveBeenLastCalledWith("lab", expect.objectContaining({ group: "Brand new" }));
  });

  it("clears the group with an explicit null", async () => {
    vi.mocked(fetchSparks).mockResolvedValue({ sparks: [{ ...spark, group: "DeepSeek" }] });
    render(<EditSparkDialog open sparkId="lab" onClose={() => {}} onSaved={() => {}} />);
    await flush();
    type(document.getElementById("edit-spark-group") as HTMLInputElement, "");
    await save();
    expect(updateSpark).toHaveBeenLastCalledWith("lab", expect.objectContaining({ group: null }));
  });
});
