/**
 * TasksPage — collab v1 reviewer chip/picker + open-orcha#209 JSONB result
 * rendering. Verifies:
 *  - the chip renders when the snapshot speaks collab (cloud: member_role /
 *    reviewer fields) and is hidden entirely on open backends;
 *  - the picker is owner-gated and PUTs the exact vanilla body to
 *    /api/tasks/{tid}/reviewer;
 *  - a JSONB (object) task.result renders normalized text — never
 *    "[object Object]" — in both the Result field and the verify gate.
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "../../components/ui";
import { SnapshotProvider } from "../../state/SnapshotProvider";
import { TasksPage } from "./TasksPage";

/* eslint-disable @typescript-eslint/no-explicit-any */
function rawSnap(opts: {
  collab?: boolean; // agents carry member_role (cloud)
  actorRole?: string | null; // h1's member_role when collab
  reviewer?: { agent_id: string; alias: string; github_login?: string | null } | null;
  result?: unknown;
}) {
  const collab = opts.collab !== false;
  const agents: any[] = [
    { id: "h1", alias: "kedar", kind: "human", status: "idle" },
    { id: "h2", alias: "sam", kind: "human", status: "idle", github_login: "sam-gh" },
    { id: "a1", alias: "forge", kind: "ai", status: "working" },
  ];
  if (collab) {
    agents[0].member_role = opts.actorRole === undefined ? "owner" : opts.actorRole;
    agents[1].member_role = "member";
  }
  const task: any = {
    id: "t1",
    title: "Verify me",
    status: "needs_verification",
    priority: 10,
    assignees: ["forge"],
    created_by_agent_id: "a1",
    created_at: "2026-08-01T00:00:00Z",
    definition_of_done: "It works end to end",
    result: opts.result !== undefined ? opts.result : "I did the thing",
    message_summary: { count: 0, last: null },
  };
  if (opts.reviewer !== undefined) {
    task.reviewer = opts.reviewer;
    task.reviewer_agent_id = opts.reviewer ? opts.reviewer.agent_id : null;
  }
  return {
    container: { id: "c1", name: "Orcha", status: "active", autonomy_level: "plan" },
    agents,
    tasks: [task],
    requests: [],
  };
}

interface Call { url: string; method: string; body: unknown }
let calls: Call[] = [];
let snapshot: unknown = null;
let reviewerEcho: unknown = {};

function jsonRes(data: unknown, status = 200) {
  return { ok: status < 300, status, json: async () => data } as Response;
}

beforeEach(() => {
  calls = [];
  reviewerEcho = {};
  window.scrollTo = vi.fn();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init && init.method) || "GET";
      let body: unknown = undefined;
      if (init && typeof init.body === "string") {
        try { body = JSON.parse(init.body); } catch { body = init.body; }
      }
      calls.push({ url, method, body });
      if (url === "/api/containers") return jsonRes([{ id: "c1", status: "active" }]);
      if (url.startsWith("/api/containers/c1")) return jsonRes(snapshot);
      if (/\/api\/tasks\/[^/]+\/reviewer$/.test(url)) return jsonRes(reviewerEcho);
      if (/\/api\/tasks\/[^/]+\/messages$/.test(url) && method === "GET") return jsonRes({ messages: [] });
      if (/\/api\/tasks\/[^/]+\/runs$/.test(url)) return jsonRes([]);
      return jsonRes({});
    }),
  );
});
/* eslint-enable @typescript-eslint/no-explicit-any */

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  try { localStorage.clear(); } catch { /* jsdom */ }
});

function renderPage() {
  return render(
    <ToastProvider>
      <SnapshotProvider>
        <MemoryRouter initialEntries={["/tasks?task=t1"]}>
          <TasksPage />
        </MemoryRouter>
      </SnapshotProvider>
    </ToastProvider>,
  );
}

describe("reviewer chip (collab v1, tasks-detail.js reviewerChip)", () => {
  it("renders the resolved reviewer (github_login preferred) when fields are present", async () => {
    snapshot = rawSnap({ reviewer: { agent_id: "h2", alias: "sam", github_login: "sam-gh" } });
    renderPage();
    await screen.findByText("reviewer");
    expect(screen.getByText("sam-gh")).toBeInTheDocument();
  });

  it("renders 'anyone' when collab is on but no reviewer is set", async () => {
    snapshot = rawSnap({ reviewer: null });
    renderPage();
    await screen.findByText("reviewer");
    expect(screen.getByText("anyone")).toBeInTheDocument();
  });

  it("renders NOTHING on open backends (no member_role, no reviewer fields)", async () => {
    snapshot = rawSnap({ collab: false, result: "plain" });
    renderPage();
    await screen.findByRole("heading", { name: /Verify me/ });
    expect(screen.queryByText("reviewer")).not.toBeInTheDocument();
    expect(screen.queryByText("anyone")).not.toBeInTheDocument();
    expect(screen.queryByTitle("Change reviewer")).not.toBeInTheDocument();
  });

  it("hides the change affordance from non-owner members (owner-gated)", async () => {
    snapshot = rawSnap({ actorRole: "member", reviewer: { agent_id: "h2", alias: "sam", github_login: "sam-gh" } });
    renderPage();
    await screen.findByText("reviewer");
    expect(screen.queryByTitle("Change reviewer")).not.toBeInTheDocument();
  });

  it("shows the change affordance when member_role is ABSENT but reviewer fields exist (permissive fallback)", async () => {
    snapshot = rawSnap({ collab: false, reviewer: { agent_id: "h2", alias: "sam", github_login: "sam-gh" } });
    renderPage();
    await screen.findByText("reviewer");
    expect(screen.getByTitle("Change reviewer")).toBeInTheDocument();
  });

  it("owner picker PUTs the exact vanilla body {reviewer_agent_id, actor_agent_id}", async () => {
    snapshot = rawSnap({ actorRole: "owner", reviewer: null });
    reviewerEcho = { reviewer: { agent_id: "h2", alias: "sam", github_login: "sam-gh" } };
    renderPage();
    await screen.findByText("reviewer");
    fireEvent.click(screen.getByTitle("Change reviewer"));
    // picker lists the human members + the Anyone reset
    const sel = document.getElementById("revSel") as HTMLSelectElement;
    expect(sel).toBeTruthy();
    expect(Array.from(sel.options).map((o) => o.value)).toEqual(["", "h1", "h2"]);
    fireEvent.change(sel, { target: { value: "h2" } });
    fireEvent.click(screen.getByRole("button", { name: "Set reviewer" }));
    await waitFor(() => {
      const put = calls.find((c) => c.url === "/api/tasks/t1/reviewer");
      expect(put).toBeTruthy();
      expect(put!.method).toBe("PUT");
      expect(put!.body).toEqual({ reviewer_agent_id: "h2", actor_agent_id: "h1" });
    });
    // the 200 echo is stamped in place — the chip updates without the poll
    await waitFor(() => expect(screen.getByText("sam-gh")).toBeInTheDocument());
  });

  it("clearing via '— Anyone —' PUTs reviewer_agent_id: null", async () => {
    snapshot = rawSnap({ actorRole: "owner", reviewer: { agent_id: "h2", alias: "sam", github_login: "sam-gh" } });
    reviewerEcho = { reviewer: null };
    renderPage();
    await screen.findByText("reviewer");
    fireEvent.click(screen.getByTitle("Change reviewer"));
    const sel = document.getElementById("revSel") as HTMLSelectElement;
    // current reviewer is preselected and labeled
    expect(sel.value).toBe("h2");
    expect(Array.from(sel.options).find((o) => o.value === "h2")!.text).toBe("sam-gh (current)");
    fireEvent.change(sel, { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Set reviewer" }));
    await waitFor(() => {
      const put = calls.find((c) => c.url === "/api/tasks/t1/reviewer");
      expect(put).toBeTruthy();
      expect(put!.method).toBe("PUT");
      expect(put!.body).toEqual({ reviewer_agent_id: null, actor_agent_id: "h1" });
    });
  });
});

describe("JSONB result rendering (open-orcha#209)", () => {
  it("renders the conventional text field of an object result — never [object Object]", async () => {
    snapshot = rawSnap({ reviewer: null, result: { result: "PR #203 opened and merged" } });
    renderPage();
    // both render sites (Result field + verify-gate body) show the normalized text
    const hits = await screen.findAllByText(/PR #203 opened and merged/);
    expect(hits.length).toBeGreaterThanOrEqual(2);
    expect(document.body.textContent).not.toContain("[object Object]");
  });

  it("pretty-prints an unconventional object result", async () => {
    snapshot = rawSnap({ reviewer: null, result: { pr: 203, ok: true } });
    renderPage();
    await screen.findByRole("heading", { name: /Verify me/ });
    expect(document.body.textContent).toContain('"pr": 203');
    expect(document.body.textContent).not.toContain("[object Object]");
  });
});
