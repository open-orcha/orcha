/**
 * Linear polish round 4 (/needs):
 *  - the detail header names a request by its TYPE ("Task request"); "Escalated" is said
 *    by the card / timeline / glyph, not four times (D12);
 *  - the pager ("1 / N" walks every band) explains its total vs the "Waiting on you" badge.
 */
import { cleanup, render, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "../../components/ui";
import { SnapshotProvider } from "../../state/SnapshotProvider";
import { _resetProjectsForTests } from "../../state/projects";
import { NeedsPage, _resetNeedsHistory, pagerHint } from "./NeedsPage";
import { _resetPendingAnswers } from "../requests/RequestsPage";

const jsonRes = (data: unknown, status = 200) => ({ ok: status < 300, status, json: async () => data }) as Response;
const iso = (m: number) => new Date(Date.now() + m * 60_000).toISOString();

beforeEach(() => {
  _resetNeedsHistory();
  _resetProjectsForTests();
  const SNAP = {
    container: { id: "c1", name: "Orcha", status: "active", autonomy_level: "plan" },
    agents: [
      { id: "h1", alias: "kedar", kind: "human", status: "idle", member_role: "owner" },
      { id: "a1", alias: "forge", kind: "ai", status: "working" },
      { id: "a2", alias: "mira", kind: "ai", status: "idle" },
    ],
    tasks: [],
    requests: [
      { id: "r1", type: "task", status: "escalated", escalated: true, priority: 1, requester_id: "a2", target_id: null, created_at: iso(-30),
        payload: JSON.stringify({ summary: "Blocked on missing credentials", task_id: "t9" }) },
      { id: "r2", type: "question", status: "open", priority: 3, requester_id: "a1", target_id: "h1", created_at: iso(-10), payload: "Ship on Friday?" },
    ],
  };
  window.scrollTo = vi.fn();
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === "/api/containers") return jsonRes([{ id: "c1", name: "Orcha", status: "active" }]);
    if (url.startsWith("/api/containers/c1")) return jsonRes(SNAP);
    return jsonRes({ ok: true });
  }));
});
afterEach(() => { _resetPendingAnswers(); cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); localStorage.clear(); });

const mount = (entry: string) =>
  render(
    <ToastProvider>
      <SnapshotProvider>
        <MemoryRouter initialEntries={[entry]}>
          <NeedsPage />
        </MemoryRouter>
      </SnapshotProvider>
    </ToastProvider>,
  );
const detail = () => document.querySelector("#detailMain") as HTMLElement;

describe("Needs you — round 4", () => {
  it("escalated request: header kind is the request type; 'Escalated' is not repeated in the header or rail", async () => {
    mount("/needs?item=request:r1");
    await waitFor(() => expect(detail()?.querySelector(".nd-dkind")?.textContent).toBe("Task request"));
    expect(within(detail()).getByRole("region", { name: "Escalated to you" })).toBeInTheDocument();
    expect(within(detail().querySelector(".rq-rail") as HTMLElement).queryByText("Status")).toBeNull();
    expect(within(detail()).getByRole("list", { name: "Request activity" }).textContent).toMatch(/mira\s*escalated to\s*a human/);
    // JSON-string payload: the title is the summary, never raw JSON
    expect(detail().querySelector(".nd-dtitle")?.textContent).toBe("Blocked on missing credentials");
  });

  it("the pager carries a tooltip explaining its total", async () => {
    mount("/needs?item=request:r2");
    await waitFor(() => expect(detail()?.querySelector(".nd-pager")).toBeTruthy());
    expect(detail().querySelector(".nd-pager")?.getAttribute("title")).toBe("2 items in this view");
  });

  it("pagerHint: names the waiting count when the view holds more", () => {
    expect(pagerHint(10, 8)).toBe("10 items in this view · 8 waiting on you");
    expect(pagerHint(1, 1)).toBe("1 item in this view");
  });
});
