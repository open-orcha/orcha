/**
 * Full-QA round 2 (task detail):
 *  - TG-05b: a cancelled upstream is satisfied — a ready task never reads
 *    "Blocked by" for it; with one cancelled + one open upstream only the open
 *    one is listed under "Blocked by".
 *  - TG-35: the reviewer button's max-width compensates its -6px margin so a
 *    name like "maya-member" is not clipped 6px short.
 */
import { cleanup, render, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "../../components/ui";
import { SnapshotProvider } from "../../state/SnapshotProvider";
import { extensions, type Identity } from "../../extensions";
import { TasksPage } from "./TasksPage";
import { taskDetailCss as DETAIL_CSS } from "./detailCss";

const TID = "tbbbbbbb";
let upstream: unknown[] = [];
const SNAP = () => ({
  container: { id: "c1", name: "Orcha", status: "active", autonomy_level: "plan" },
  agents: [{ id: "h1", alias: "kedar", kind: "human", status: "idle", member_role: "owner" }],
  tasks: [
    {
      id: TID, title: "B task", status: "ready", priority: 50, assignees: [],
      created_by_agent_id: "h1", created_at: "2026-08-02T00:00:00Z",
      definition_of_done: "done", message_summary: { count: 0, last: null },
    },
  ],
  requests: [],
});
const jsonRes = (data: unknown, status = 200) => ({ ok: status < 300, status, json: async () => data }) as Response;
const IMP = () => ({
  downstream_tasks: [], upstream_tasks: upstream, in_flight_agents: [], spawned_from_request: null,
  open_requests_from_assignees: [],
  summary: { downstream_total: 0, would_unblock: 0, still_blocked: 0, in_flight_agents: 0, open_requests: 0, completes_container: false },
});

beforeEach(() => {
  window.scrollTo = vi.fn();
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === "/api/containers") return jsonRes([{ id: "c1", status: "active" }]);
    if (url.startsWith("/api/containers/c1")) return jsonRes(SNAP());
    if (/\/close-implications$/.test(url)) return jsonRes(IMP());
    if (/\/messages$/.test(url)) return jsonRes({ messages: [] });
    if (/\/runs$/.test(url)) return jsonRes([]);
    return jsonRes({});
  }));
  extensions.identity = async () => ({ agent_id: "h1", alias: "kedar", member_role: "owner" }) as Identity;
});
afterEach(() => {
  cleanup();
  delete extensions.identity;
  vi.unstubAllGlobals();
  try { localStorage.clear(); sessionStorage.clear(); } catch { /* jsdom */ }
});

function renderDetail() {
  return render(
    <ToastProvider>
      <SnapshotProvider>
        <MemoryRouter initialEntries={["/tasks?task=" + TID]}>
          <TasksPage />
        </MemoryRouter>
      </SnapshotProvider>
    </ToastProvider>,
  );
}
const relText = (rel: string) => Array.from(document.querySelectorAll(`[data-rel="${rel}"]`)).map((e) => e.textContent).join("|");

describe("TG-05b: cancelled upstream is satisfied", () => {
  it("ready task with only a cancelled upstream reads 'Depends on … cancelled', never 'Blocked by'", async () => {
    upstream = [{ task_id: "tA", title: "A2 upstream", status: "cancelled", satisfied: true }];
    renderDetail();
    await waitFor(() => expect(relText("upstream")).toContain("A2 upstream"));
    expect(document.body.textContent).not.toContain("Blocked by");
    expect(document.body.textContent).toContain("Depends on");
    expect(relText("upstream")).toContain("cancelled");
  });
  it("cancelled + ready upstreams: only the ready one blocks", async () => {
    upstream = [
      { task_id: "tA", title: "A cancelled", status: "cancelled", satisfied: true },
      { task_id: "tC", title: "C open", status: "ready", satisfied: false },
    ];
    renderDetail();
    await waitFor(() => expect(relText("upstream")).toContain("C open"));
    expect(relText("upstream")).not.toContain("A cancelled");
    expect(relText("upstream-done")).toContain("A cancelled");
    expect(document.body.textContent).toContain("Blocked by");
  });
  it("older backend without `satisfied`: cancelled falls back to satisfied", async () => {
    upstream = [{ task_id: "tA", title: "Old A", status: "cancelled" }];
    renderDetail();
    await waitFor(() => expect(relText("upstream")).toContain("Old A"));
    expect(document.body.textContent).not.toContain("Blocked by");
  });
});

describe("TG-35: reviewer button width", () => {
  it("compensates the -6px margin", () => {
    expect(DETAIL_CSS).toMatch(/\.td-rev \.td-prop-btn\s*\{[^}]*max-width:\s*calc\(100% \+ 6px\)/);
  });
});

import { workCss } from "./workCss";
describe("VD-06: Open runs tap area", () => {
  it("gives .td-ev-link a 44px ::after under pointer: coarse", () => {
    const i = workCss.indexOf("@media (pointer: coarse)");
    expect(i).toBeGreaterThan(-1);
    expect(workCss.slice(i)).toMatch(/\.td-ev-link::after\s*\{[^}]*height:\s*44px/);
  });
});
