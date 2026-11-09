/** "Send to Quality when finished" on a task: a person turns it on with a device, and turns it off. */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { TaskQaSection } from "../TaskQaSection";
import { onDoneWords, readOnDone } from "./on-done";

vi.mock("../../../state/SnapshotProvider", () => ({
  useSnapshot: () => ({ cid: "c1", snap: { agents: [] } }),
  useActingAuthority: () => ({ human: { id: "h1", kind: "human", member_role: "owner" }, pending: false }),
}));

const put: unknown[] = [];
const json = (body: unknown, status = 200) => ({ ok: status < 300, status, json: async () => body, text: async () => JSON.stringify(body) }) as unknown as Response;
const IPHONE = { kind: "ios", name: "iPhone 17 Pro", udid: "16D2", runtime: "iOS 26.5", state: "booted" };

function stub(onDone: unknown = null, trigger = "manual") {
  put.length = 0;
  global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (init?.method === "PUT") {
      const body = JSON.parse(String(init.body));
      put.push(body);
      return json({ task_id: "t1", on_done: body.enabled === null ? null : { ...body, by: "h1" } });
    }
    if (url === "/api/tasks/t1/qa") return json({ sessions: [], findings: [], scenarios: [], verdicts: [], requests: [], on_done: onDone });
    if (url.includes("/qa/targets")) return json({ targets: [{ platform: "ios", app_id: "com.acme" }] });
    if (url.includes("/qa/settings")) return json({ agent_id: "qa", default_platform: "ios", trigger, on_fail: "report", max_rounds: 3 });
    if (url.includes("/qa/devices")) return json({ devices: [IPHONE], available: true });
    return json({});
  }) as unknown as typeof fetch;
}

const TASK = { id: "t1", title: "Add checkout", status: "in_progress", workflow_id: null, is_root: false };
const mount = (task: object = TASK) => render(<MemoryRouter><div data-testid="host"><TaskQaSection taskId="t1" task={task as never} /></div></MemoryRouter>);

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("Send to Quality when finished", () => {
  it("turns on with the picked device, and says what it will run on", async () => {
    stub();
    mount();
    fireEvent.click(await screen.findByRole("switch", { name: "Send to Quality when finished" }));
    fireEvent.click(await screen.findByRole("radio", { name: /iPhone 17 Pro/ }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(put).toHaveLength(1));
    expect(put[0]).toMatchObject({ actor_agent_id: "h1", enabled: true, platform: "ios", device: "iPhone 17 Pro" });
    expect(await screen.findByText("iOS · iPhone 17 Pro")).toBeInTheDocument();
    expect(screen.getByRole("switch", { name: "Send to Quality when finished" }).getAttribute("aria-checked")).toBe("true");
  });

  it("off clears the choice on a manual project, and is 'not this one' where every task goes", async () => {
    stub({ enabled: true, platform: "ios", device: null });
    mount();
    fireEvent.click(await screen.findByRole("switch", { name: "Send to Quality when finished" }));
    await waitFor(() => expect(put).toHaveLength(1));
    expect(put[0]).toMatchObject({ enabled: null });
    cleanup();
    stub({ enabled: true, platform: "ios", device: null }, "always");
    mount();
    fireEvent.click(await screen.findByRole("switch", { name: "Send to Quality when finished" }));
    await waitFor(() => expect(put).toHaveLength(1));
    expect(put[0]).toMatchObject({ enabled: false });
  });

  it("is not offered on a workflow's step, the root task or a finished task", async () => {
    for (const task of [{ ...TASK, workflow_id: "w1" }, { ...TASK, is_root: true }, { ...TASK, status: "needs_verification" }]) {
      stub();
      mount(task);
      await waitFor(() => expect(global.fetch).toHaveBeenCalledWith("/api/tasks/t1/qa", expect.anything()));
      expect(screen.queryByRole("switch")).toBeNull();
      cleanup();
    }
  });

  it("reads a stored choice and words it plainly", () => {
    expect(readOnDone({ enabled: true, platform: "android", device: "Pixel_9a", kind: null })).toEqual({ enabled: true, platform: "android", device: "Pixel_9a", kind: null, conditions: null });
    expect(readOnDone({ enabled: true, platform: "android", device: null, kind: null, conditions: { os: "13" } })?.conditions).toEqual({ os: "13" });
    expect(onDoneWords({ platform: "android", device: null, conditions: { os: "13", locale: "sw-KE" } }, null)).toBe("Android · any device · Android 13 · Swahili (Kenya)");
    expect(readOnDone(null)).toBeNull();
    expect(onDoneWords({ platform: "android", device: "Pixel_9a" }, null)).toBe("Android · Pixel 9a");
    expect(onDoneWords({ platform: null, device: null }, "ios")).toBe("iOS · any device");
    expect(onDoneWords({ platform: "web", device: "mobile" }, null)).toBe("Web · Mobile browser");
  });
});
