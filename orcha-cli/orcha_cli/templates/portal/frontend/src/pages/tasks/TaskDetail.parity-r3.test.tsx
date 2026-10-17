/**
 * Parity round 3 (task detail):
 *  - e2e-permissions-21: a viewer's Task actions ⋯ menu offers "Pair in terminal"
 *    DISABLED with the viewer reason (like Cancel task…), never a live link.
 *  - e2e-permissions-34: the plan gate reads "Plan awaiting approval" for someone
 *    who can't approve; the owner keeps "Plan awaiting your approval".
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "../../components/ui";
import { SnapshotProvider } from "../../state/SnapshotProvider";
import { extensions, type Identity } from "../../extensions";
import { TasksPage } from "./TasksPage";

const PLAN_TID = "t2bbbbbb";
const SNAP = () => ({
  container: { id: "c1", name: "Orcha", status: "active", autonomy_level: "plan" },
  agents: [
    { id: "h1", alias: "kedar", kind: "human", status: "idle", member_role: "owner" },
    { id: "h3", alias: "tomas", kind: "human", status: "idle", member_role: "viewer" },
    { id: "a1", alias: "forge", kind: "ai", status: "working", effective_autonomy: "plan" },
  ],
  tasks: [
    {
      id: PLAN_TID, title: "Plan-gated", status: "in_progress", priority: 50, assignees: ["forge"],
      created_by_agent_id: "h1", created_at: "2026-08-02T00:00:00Z", started_at: "2026-08-02T01:00:00Z",
      definition_of_done: "done", message_summary: { count: 0, last: null },
      plan_message: { body: "My plan: do it", author_alias: "forge", at: "2026-08-02T01:05:00Z" },
    },
  ],
  requests: [],
});
const jsonRes = (data: unknown, status = 200) => ({ ok: status < 300, status, json: async () => data }) as Response;

beforeEach(() => {
  window.scrollTo = vi.fn();
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init && init.method) || "GET";
    if (url === "/api/containers") return jsonRes([{ id: "c1", status: "active" }]);
    if (url.startsWith("/api/containers/c1") && method === "GET") return jsonRes(SNAP());
    if (/\/messages$/.test(url)) return jsonRes({ messages: [] });
    if (/\/runs$/.test(url)) return jsonRes([]);
    return jsonRes({});
  }));
});
afterEach(() => {
  cleanup();
  delete extensions.identity;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  try { localStorage.clear(); sessionStorage.clear(); } catch { /* jsdom */ }
});

const pane = () => document.querySelector("#detailMain .td-pane") as HTMLElement | null;
function renderAs(id: Partial<Identity>) {
  extensions.identity = async () => id as Identity;
  return render(
    <ToastProvider>
      <SnapshotProvider>
        <MemoryRouter initialEntries={["/tasks?task=" + PLAN_TID]}>
          <TasksPage />
        </MemoryRouter>
      </SnapshotProvider>
    </ToastProvider>,
  );
}
async function openMenu() {
  await waitFor(() => expect(pane()).toBeTruthy());
  fireEvent.click(within(pane()!).getByRole("button", { name: "Task actions" }));
  return screen.findByRole("menuitem", { name: /Pair in terminal/ });
}

describe("Pair in terminal is human authority (e2e-permissions-21)", () => {
  it("viewer: disabled with the viewer reason", async () => {
    renderAs({ agent_id: "h3", alias: "tomas", member_role: "viewer" });
    await waitFor(() => expect(document.body.textContent).toContain("Plan awaiting approval"));
    const item = await openMenu();
    expect(item.getAttribute("aria-disabled")).toBe("true");
    expect(item.tagName).not.toBe("A");
    expect((item.getAttribute("title") || "") + item.textContent).toMatch(/viewer/i);
  });
  it("owner: a live link to the agent's pairing surface", async () => {
    renderAs({ agent_id: "h1", alias: "kedar", member_role: "owner" });
    await waitFor(() => expect(document.body.textContent).toContain("Plan awaiting your approval"));
    const item = await openMenu();
    expect(item.getAttribute("aria-disabled")).not.toBe("true");
  });
});

describe("plan gate title (e2e-permissions-34)", () => {
  it("viewer never reads 'your approval'", async () => {
    renderAs({ agent_id: "h3", alias: "tomas", member_role: "viewer" });
    await waitFor(() => expect(document.body.textContent).toContain("Plan awaiting approval"));
    expect(document.body.textContent).not.toContain("Plan awaiting your approval");
  });
});
