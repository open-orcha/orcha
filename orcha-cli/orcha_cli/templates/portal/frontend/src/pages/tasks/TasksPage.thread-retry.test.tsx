/**
 * GH #74 — task-thread retry affordance. When the thread fetch for the
 * selected task fails, or comes back empty while message_summary.count says
 * >0, the thread panel renders an honest "Couldn't load the thread — Retry"
 * state instead of a spinner/empty forever. The error LATCHES — no auto-
 * refetch on the 3s poll tick — until the user clicks Retry, which refetches
 * in place. A failed refresh over already-rendered cached messages keeps the
 * messages and shows a smaller "Couldn't refresh — Retry" affordance.
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "../../components/ui";
import { SnapshotProvider } from "../../state/SnapshotProvider";
import { TasksPage } from "./TasksPage";

const RAW_SNAPSHOT = {
  container: { id: "c1", name: "Orcha", status: "active", autonomy_level: "plan" },
  agents: [
    { id: "h1", alias: "kedar", kind: "human", status: "idle" },
    { id: "a1", alias: "forge", kind: "ai", status: "working" },
  ],
  tasks: [
    {
      id: "t1",
      title: "Has messages",
      status: "in_progress",
      priority: 50,
      assignees: ["forge"],
      created_at: "2026-08-01T00:00:00Z",
      definition_of_done: "Works",
      message_summary: { count: 2, last: null },
    },
  ],
  requests: [],
};

interface Call {
  url: string;
  method: string;
}
let calls: Call[] = [];
let messagesHandler: (call: Call) => Response | Promise<Response>;

function jsonRes(data: unknown, status = 200) {
  return { ok: status < 300, status, json: async () => data } as Response;
}

beforeEach(() => {
  calls = [];
  window.scrollTo = vi.fn();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init && init.method) || "GET";
      const call = { url, method };
      calls.push(call);
      if (url === "/api/containers") return jsonRes([{ id: "c1", status: "active" }]);
      if (url.startsWith("/api/containers/c1") && method === "GET") return jsonRes(RAW_SNAPSHOT);
      if (/\/api\/tasks\/[^/]+\/messages$/.test(url) && method === "GET") return messagesHandler(call);
      if (/\/api\/tasks\/[^/]+\/runs$/.test(url)) return jsonRes([]);
      return jsonRes({});
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  try {
    localStorage.clear();
  } catch {
    /* jsdom */
  }
});

function renderPage(initialEntry = "/tasks?task=t1", pollMs = 3000) {
  return render(
    <ToastProvider>
      <SnapshotProvider pollMs={pollMs}>
        <MemoryRouter initialEntries={[initialEntry]}>
          <TasksPage />
        </MemoryRouter>
      </SnapshotProvider>
    </ToastProvider>,
  );
}

describe("GH #74 — task thread retry affordance", () => {
  it("a failed fetch with no cache renders the honest error state, not a perpetual spinner", async () => {
    messagesHandler = () => jsonRes({ detail: "boom" }, 500);
    renderPage();
    const err = await screen.findByText(/Couldn.t load the thread/);
    expect(err).toBeInTheDocument();
    expect(document.querySelector('[data-thread-retry="t1"]')).toBeTruthy();
    expect(screen.queryByText("Loading thread…")).toBeNull();
  });

  it("an empty fetch while summary count > 0 is treated as a failure (data inconsistency)", async () => {
    messagesHandler = () => jsonRes({ messages: [] });
    renderPage();
    const err = await screen.findByText(/Couldn.t load the thread/);
    expect(err).toBeInTheDocument();
  });

  it("the error latches — no auto-refetch on a real poll tick until Retry is clicked", async () => {
    let fetchCount = 0;
    messagesHandler = () => {
      fetchCount++;
      return jsonRes({ detail: "boom" }, 500);
    };
    // fast poll so a real snapshot-poll tick (which bumps the thread-load effect's
    // dependency) fires well within the test — proves the latch survives an actual tick,
    // not just the absence of a rerender.
    renderPage("/tasks?task=t1", 20);
    await screen.findByText(/Couldn.t load the thread/);
    const countAfterFirstError = fetchCount;
    expect(countAfterFirstError).toBe(1);

    // let several real poll ticks elapse without clicking retry
    await new Promise((r) => setTimeout(r, 120));
    expect(fetchCount).toBe(countAfterFirstError); // still latched — no new /messages call
    expect(screen.getByText(/Couldn.t load the thread/)).toBeInTheDocument();
  });

  it("clicking Retry refetches in place and clears the error on success", async () => {
    let attempt = 0;
    messagesHandler = () => {
      attempt++;
      if (attempt === 1) return jsonRes({ detail: "boom" }, 500);
      return jsonRes({
        messages: [
          { message_id: "m1", is_human: false, author_id: "a1", author_alias: "forge", body: "hi", created_at: "2026-08-01T00:01:00Z" },
          { message_id: "m2", is_human: false, author_id: "a1", author_alias: "forge", body: "second", created_at: "2026-08-01T00:02:00Z" },
        ],
      });
    };
    renderPage();
    await screen.findByText(/Couldn.t load the thread/);
    const retryBtn = document.querySelector('[data-thread-retry="t1"]') as HTMLButtonElement;
    fireEvent.click(retryBtn);
    await waitFor(() => {
      expect(screen.getByText("hi")).toBeInTheDocument();
    });
    expect(screen.queryByText(/Couldn.t load the thread/)).toBeNull();
    expect(attempt).toBe(2);
  });

  it("a failed REFRESH over already-rendered cached messages keeps the messages and shows a smaller retry banner", async () => {
    let attempt = 0;
    messagesHandler = () => {
      attempt++;
      if (attempt === 1) {
        return jsonRes({
          messages: [{ message_id: "m1", is_human: false, author_id: "a1", author_alias: "forge", body: "first msg", created_at: "2026-08-01T00:01:00Z" }],
        });
      }
      return jsonRes({ detail: "boom" }, 500);
    };
    renderPage("/tasks?task=t1", 20);
    await waitFor(() => expect(screen.getByText("first msg")).toBeInTheDocument());

    // bump the summary count so the effect re-fetches (simulating a new message landing,
    // and that refetch failing) — rerender with an updated snapshot
    const updatedSnapshot = {
      ...RAW_SNAPSHOT,
      tasks: [{ ...RAW_SNAPSHOT.tasks[0], message_summary: { count: 3, last: null } }],
    };
    messagesHandler = () => {
      attempt++;
      return jsonRes({ detail: "boom" }, 500);
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = (init && init.method) || "GET";
        calls.push({ url, method });
        if (url === "/api/containers") return jsonRes([{ id: "c1", status: "active" }]);
        if (url.startsWith("/api/containers/c1") && method === "GET") return jsonRes(updatedSnapshot);
        if (/\/api\/tasks\/[^/]+\/messages$/.test(url) && method === "GET") return messagesHandler({ url, method });
        if (/\/api\/tasks\/[^/]+\/runs$/.test(url)) return jsonRes([]);
        return jsonRes({});
      }),
    );

    // cached message stays visible + a smaller "Couldn't refresh" banner appears
    await waitFor(() => {
      expect(screen.getByText("first msg")).toBeInTheDocument();
      expect(screen.getByText(/Couldn.t refresh/)).toBeInTheDocument();
    });
    expect(document.querySelector('[data-thread-retry="t1"]')).toBeTruthy();
  });
});
