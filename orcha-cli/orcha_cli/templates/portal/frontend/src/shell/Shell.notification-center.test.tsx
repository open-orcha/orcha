/**
 * Notification center (the topbar "Needs you" bell) — the SHIPPING React path.
 * PR #223 review: the deleted vanilla `tests/portal/notification_center.test.js`
 * covered dormant `static/app.js`; the served portal is React `dist/index.html`,
 * so an inert bell handler left all suites green. This exercises the real
 * contract end-to-end through `Shell`: bell click opens the panel and requests
 * the earlier feed, "Load earlier" pages with the server cursor, and
 * "Mark all read" POSTs and flips rows read.
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { HashRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "../components/ui";
import { SnapshotProvider } from "../state/SnapshotProvider";
import { HomePage } from "../pages/home/HomePage";

const RAW_SNAPSHOT = {
  container: { id: "c1", name: "Orcha", status: "active", autonomy_level: "plan" },
  agents: [{ id: "h1", alias: "kedar", kind: "human", status: "idle" }],
  tasks: [],
  requests: [],
};

const PAGE_1 = {
  notifications: [
    { type: "task_verified", preview: "Ship the widget", actor_alias: "kedar", ts: 1_700_000_100, read: false, deeplink: { kind: "task", id: "t1" } },
    { type: "request_answered", preview: "What port?", actor_alias: "bot", ts: 1_700_000_050, read: true },
  ],
  next_before_ts: 1_700_000_050,
  next_before_id: "n2",
};
const PAGE_2 = {
  notifications: [
    { type: "plan_decided", preview: "Approve rollout", actor_alias: "kedar", ts: 1_700_000_000, read: false },
  ],
  next_before_ts: null,
  next_before_id: null,
};

type Call = { url: string; method: string };
let calls: Call[];

function stubFetch() {
  calls = [];
  const json = (data: unknown) => ({ ok: true, status: 200, json: async () => data }) as unknown as Response;
  global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, method: (init?.method ?? "GET").toUpperCase() });
    if (url === "/api/containers") return json([{ id: "c1", status: "active" }]);
    if (url.startsWith("/api/containers/c1")) return json(RAW_SNAPSHOT);
    const u = new URL(url, "http://portal.test");
    if (u.pathname === "/api/agents/h1/notifications") {
      return json(u.searchParams.has("before_ts") ? PAGE_2 : PAGE_1);
    }
    if (u.pathname === "/api/agents/h1/notifications/read") return json({ ok: true });
    return json({});
  }) as unknown as typeof fetch;
}

function mount() {
  return render(
    <ToastProvider>
      <SnapshotProvider>
        <HashRouter>
          <HomePage />
        </HashRouter>
      </SnapshotProvider>
    </ToastProvider>,
  );
}

const bell = () => document.getElementById("attnPill") as HTMLElement;
const panel = () => document.getElementById("ncFloat") as HTMLElement;
const feedCalls = () => calls.filter((c) => c.url.startsWith("/api/agents/h1/notifications?"));
const readCalls = () => calls.filter((c) => c.url === "/api/agents/h1/notifications/read");

async function openPanel() {
  mount();
  await waitFor(() => expect(bell()).toBeTruthy());
  expect(panel().classList.contains("show")).toBe(false);
  fireEvent.click(bell());
  await waitFor(() => expect(panel().classList.contains("show")).toBe(true));
  await screen.findByText("Task verified · Ship the widget");
}

describe("Shell notification center", () => {
  beforeEach(() => {
    localStorage.clear();
    stubFetch();
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("bell click opens the panel and requests the acting human's earlier feed", async () => {
    await openPanel();
    expect(feedCalls()).toHaveLength(1);
    expect(feedCalls()[0].url).toBe("/api/agents/h1/notifications?zone=earlier&limit=20");
    // both rows rendered, unread state reflected per row, task deeplink wired
    expect(screen.getByText("Request answered · What port?")).toBeInTheDocument();
    const rows = panel().querySelectorAll(".nrow");
    const unreadTitles = Array.from(rows).filter((r) => r.classList.contains("unread")).map((r) => r.querySelector(".ti")?.textContent);
    expect(unreadTitles).toEqual(["Task verified · Ship the widget"]);
    expect(screen.getByText("Task verified · Ship the widget").closest("a")?.getAttribute("href")).toBe("/tasks?task=t1");
    // a second click closes it again (the handler toggles; it is not merely preventDefault)
    fireEvent.click(bell());
    await waitFor(() => expect(panel().classList.contains("show")).toBe(false));
  });

  it("Load earlier pages with the server cursor and appends the older rows", async () => {
    await openPanel();
    fireEvent.click(screen.getByText("… Load earlier"));
    await screen.findByText("Decision made · Approve rollout");
    expect(feedCalls()).toHaveLength(2);
    expect(feedCalls()[1].url).toBe(
      "/api/agents/h1/notifications?zone=earlier&limit=20&before_ts=1700000050&before_id=n2",
    );
    // first page kept, second appended; no more pages → the footer disappears
    expect(screen.getByText("Task verified · Ship the widget")).toBeInTheDocument();
    expect(panel().querySelectorAll(".nc-list .nrow")).toHaveLength(3);
    expect(screen.queryByText("… Load earlier")).toBeNull();
  });

  it("Mark all read POSTs the read endpoint and clears every unread marker", async () => {
    await openPanel();
    expect(panel().querySelectorAll(".nrow.unread")).toHaveLength(1);
    fireEvent.click(screen.getByText("Mark all read"));
    await waitFor(() => expect(readCalls()).toHaveLength(1));
    expect(readCalls()[0].method).toBe("POST");
    expect(panel().querySelectorAll(".nrow.unread")).toHaveLength(0);
    // the panel stays open (stopPropagation keeps the outside-click closer from firing)
    expect(panel().classList.contains("show")).toBe(true);
  });
});
