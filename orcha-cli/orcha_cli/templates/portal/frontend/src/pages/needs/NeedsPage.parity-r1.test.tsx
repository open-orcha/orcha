/**
 * Parity round 1 fixes (Needs you):
 *  - a verification item's Activity has no "proposed a plan" line built from an ordinary
 *    first agent message (only plan items / decided plans have a plan);
 *  - a viewer's notice names the viewer role, not "No acting human";
 *  - All projects: project lifecycle labels ("Paused", not the raw word), the whole row is
 *    the link (no repeated "Open queue" text), "current" as a badge;
 *  - the Waiting pill keeps its count while selected.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "../../components/ui";
import { extensions, type Identity } from "../../extensions";
import { SnapshotProvider, _setActingAuth, _setActingIdentity } from "../../state/SnapshotProvider";
import { _resetProjectsForTests } from "../../state/projects";
import { NeedsPage, _resetNeedsHistory } from "./NeedsPage";

const base = { assignees: ["qa-bot"], created_by_agent_id: "h1", definition_of_done: "It works", message_summary: { count: 1, last: null } };
let SNAP: Record<string, unknown>;
let loc = { search: "" };
const jsonRes = (data: unknown, status = 200) => ({ ok: status < 300, status, json: async () => data }) as Response;

beforeEach(() => {
  _resetNeedsHistory();
  _resetProjectsForTests();
  SNAP = {
    container: { id: "c1", name: "Orcha", status: "active", autonomy_level: "plan" },
    agents: [
      { id: "h1", alias: "kedar", kind: "human", status: "idle", member_role: "owner" },
      { id: "a1", alias: "qa-bot", kind: "ai", status: "working" },
    ],
    tasks: [
      { ...base, id: "t2", title: "Verify export", status: "needs_verification", priority: 20, created_at: "2026-08-02T00:00:00Z", result: "Done",
        plan_message: { body: "Export verified locally.", author_alias: "qa-bot", at: "2026-08-02T02:00:00Z" } },
      { ...base, id: "t1", title: "Plan me", status: "in_progress", priority: 10, created_at: "2026-08-01T00:00:00Z",
        plan_message: { body: "Step 1: do it", author_alias: "qa-bot", at: "2026-08-01T02:00:00Z" } },
    ],
    requests: [],
  };
  window.scrollTo = vi.fn();
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === "/api/containers") return jsonRes([
      { id: "c1", name: "Orcha", status: "active", needs_you: 2 },
      { id: "c2", name: "Infra ops", status: "paused", needs_you: 0 },
    ]);
    if (url.startsWith("/api/containers/c1")) return jsonRes(SNAP);
    if (/\/runs$/.test(url)) return jsonRes([]);
    return jsonRes({});
  }));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  localStorage.clear();
  delete extensions.identity;
  _setActingIdentity(null);
  _setActingAuth({ pending: false, trusted: false });
});

function Probe() {
  loc = { search: useLocation().search };
  return null;
}
const mount = (entry = "/needs") =>
  render(
    <ToastProvider>
      <SnapshotProvider>
        <MemoryRouter initialEntries={[entry]}>
          <NeedsPage />
          <Probe />
        </MemoryRouter>
      </SnapshotProvider>
    </ToastProvider>,
  );

describe("Needs you — parity round 1", () => {
  it("a verification's Activity has no 'proposed a plan' event; a plan item keeps it", async () => {
    mount("/needs?item=verify:t2");
    const act = await screen.findByRole("region", { name: "Activity" });
    expect(act.textContent).not.toMatch(/proposed a plan/);
    cleanup();
    mount("/needs?item=plan:t1");
    const act2 = await screen.findByRole("region", { name: "Activity" });
    expect(act2.textContent).toMatch(/proposed a plan/);
  });

  it("a viewer's notice names the role, not 'No acting human'", async () => {
    extensions.identity = async () => ({ agent_id: "h1", alias: "kedar", member_role: "viewer" }) as Identity;
    mount();
    const list = () => document.getElementById("nlist")!;
    await waitFor(() => expect(within(list()).getByRole("note").textContent).toMatch(/Your role is viewer \(read-only\)/));
    expect(list().textContent).not.toMatch(/No acting human/);
  });

  it("All projects: 'Paused' label, row links, a 'current' badge, no repeated 'Open queue' text", async () => {
    mount("/needs?scope=all");
    const table = await screen.findByRole("table");
    await waitFor(() => expect(table.textContent).toContain("Infra ops"));
    expect(table.textContent).toContain("Paused");
    expect(table.textContent).not.toMatch(/\bpaused\b/);
    expect(table.textContent).not.toContain("Open queue");
    expect(within(table).getByText("current")).toBeInTheDocument();
    expect(within(table).getByRole("link", { name: "Open queue for Infra ops" })).toBeInTheDocument();
    // the current project's row opens its queue
    fireEvent.click(within(table).getByRole("link", { name: "Open queue for Orcha" }));
    await waitFor(() => expect(loc.search).toBe(""));
  });

  it("the Waiting pill keeps its count while it is the selected view", async () => {
    mount();
    await waitFor(() => expect(screen.getByRole("radio", { name: /^Waiting\s*2/ })).toBeInTheDocument());
    expect(screen.getByRole("radio", { name: /^Waiting\s*2/ }).getAttribute("aria-checked")).toBe("true");
  });
});
