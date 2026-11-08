/** Create task: "Send to Quality when finished" rides along with the new task. */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "../../components/ui";
import { SnapshotProvider } from "../../state/SnapshotProvider";
import { TasksPage } from "./TasksPage";

let calls: { url: string; method: string; body: unknown }[] = [];
let TRIGGER = "manual";
const jsonRes = (data: unknown, status = 200) => ({ ok: status < 300, status, json: async () => data, text: async () => JSON.stringify(data) }) as Response;
const SNAP = {
  container: { id: "c1", name: "Orcha", status: "active", autonomy_level: "plan" },
  agents: [{ id: "h1", alias: "kedar", kind: "human", status: "idle" }, { id: "a1", alias: "forge", kind: "ai", status: "working" }],
  tasks: [],
  requests: [],
};

beforeEach(() => {
  calls = [];
  TRIGGER = "manual";
  window.scrollTo = vi.fn();
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init && init.method) || "GET";
    const body = init && typeof init.body === "string" ? JSON.parse(init.body) : undefined;
    calls.push({ url, method, body });
    if (url === "/openapi.json") return jsonRes({ paths: {} });
    if (url === "/api/containers") return jsonRes([{ id: "c1", status: "active" }]);
    if (url.includes("/qa/targets")) return jsonRes({ targets: [{ platform: "ios", app_id: "com.acme" }] });
    if (url.includes("/qa/settings")) return jsonRes({ agent_id: null, default_platform: "ios", trigger: TRIGGER, on_fail: "report", max_rounds: 3 });
    if (url.includes("/qa/devices")) return jsonRes({ devices: [{ kind: "ios", name: "iPhone 17 Pro", udid: "16D2", runtime: "iOS 26.5", state: "booted" }], available: true });
    if (url === "/api/containers/c1/tasks" && method === "POST") return jsonRes({ task_id: "t9", status: "ready", assignee_alias: null }, 201);
    if (url.startsWith("/api/tasks/t9/qa/on-done")) return jsonRes({ task_id: "t9", on_done: { ...body, by: "h1" } });
    if (url.startsWith("/api/containers/c1")) return jsonRes(SNAP);
    return jsonRes({});
  }));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  try { localStorage.clear(); } catch { /* jsdom */ }
});

async function compose() {
  render(<ToastProvider><SnapshotProvider><MemoryRouter initialEntries={["/tasks?new=1"]}><TasksPage /></MemoryRouter></SnapshotProvider></ToastProvider>);
  const dialog = await screen.findByRole("dialog", { name: /New task/ });
  fireEvent.change(document.querySelector("#nt_title")!, { target: { value: "Ship it" } });
  fireEvent.change(document.querySelector("#nt_dod")!, { target: { value: "It ships" } });
  return dialog;
}

const onDone = () => calls.filter((c) => c.url === "/api/tasks/t9/qa/on-done" && c.method === "PUT");

describe("Create task: Send to Quality when finished", () => {
  it("is off by default; turned on, the new task goes with the picked device", async () => {
    const dialog = await compose();
    const chip = await within(dialog).findByRole("button", { name: "Send to Quality when finished" });
    expect(chip.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(chip);
    fireEvent.click(await within(dialog).findByRole("radio", { name: /iPhone 17 Pro/ }));
    expect(within(dialog).getByRole("button", { name: "Quality · iOS · iPhone 17 Pro" }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(within(dialog).getByText("Create task"));
    await waitFor(() => expect(onDone()).toHaveLength(1));
    expect(onDone()[0].body).toMatchObject({ actor_agent_id: "h1", enabled: true, platform: "ios", device: "iPhone 17 Pro" });
  });

  it("left alone on a manual project, saves nothing; on where every task goes, off is saved as 'not this one'", async () => {
    let dialog = await compose();
    await within(dialog).findByRole("button", { name: "Send to Quality when finished" });
    fireEvent.click(within(dialog).getByText("Create task"));
    await waitFor(() => expect(calls.some((c) => c.url === "/api/containers/c1/tasks" && c.method === "POST")).toBe(true));
    expect(onDone()).toHaveLength(0);
    cleanup();
    calls = [];
    TRIGGER = "always";
    dialog = await compose();
    const chip = await within(dialog).findByRole("button", { name: /^Quality · iOS/ });
    expect(chip.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(chip);
    fireEvent.click(within(dialog).getByText("Create task"));
    await waitFor(() => expect(onDone()).toHaveLength(1));
    expect(onDone()[0].body).toMatchObject({ enabled: false });
  });
});
