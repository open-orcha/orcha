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
import { ncEarlierRow, ncUnreadCount } from "./Shell";

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
  await screen.findByText("Ship the widget");
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
    // page 1 is prefetched for the unread badge and refreshed on open — always page 1
    expect(feedCalls().length).toBeGreaterThanOrEqual(1);
    for (const c of feedCalls()) expect(c.url).toBe("/api/agents/h1/notifications?zone=earlier&limit=20");
    // both rows rendered, unread state reflected per row, task deeplink wired
    expect(screen.getByText("What port?")).toBeInTheDocument();
    const rows = panel().querySelectorAll(".nrow");
    const unreadTitles = Array.from(rows).filter((r) => r.classList.contains("unread")).map((r) => r.querySelector(".ti-t")?.textContent);
    expect(unreadTitles).toEqual(["Ship the widget"]);
    expect(screen.getByText("Ship the widget").closest("a")?.getAttribute("href")).toBe("/tasks?task=t1");
    // a second click closes it again (the handler toggles; it is not merely preventDefault)
    fireEvent.click(bell());
    await waitFor(() => expect(panel().classList.contains("show")).toBe(false));
  });

  it("Load earlier pages with the server cursor and appends the older rows", async () => {
    await openPanel();
    fireEvent.click(screen.getByText("Load earlier"));
    await screen.findByText("Approve rollout");
    const before = feedCalls().filter((c) => c.url.includes("before_ts"));
    expect(before).toHaveLength(1);
    expect(before[0].url).toBe(
      "/api/agents/h1/notifications?zone=earlier&limit=20&before_ts=1700000050&before_id=n2",
    );
    // first page kept, second appended; no more pages → the footer disappears
    expect(screen.getByText("Ship the widget")).toBeInTheDocument();
    expect(panel().querySelectorAll(".nc-list .nrow")).toHaveLength(3);
    expect(screen.queryByText("Load earlier")).toBeNull();
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

describe("Shell notification center — Inbox rows + unread badge", () => {
  beforeEach(() => { localStorage.clear(); stubFetch(); });
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  it("rows are avatar + one-line title + one-line 'what happened' + age, no chevron", async () => {
    await openPanel();
    const row = screen.getByText("Ship the widget").closest(".nrow")!;
    expect(row.querySelector(".nc-av")).toBeTruthy();
    expect(row.querySelector(".nc-badge")).toBeTruthy();
    expect(row.querySelector(".me")?.textContent).toBe("Task verified · kedar");
    expect(row.querySelector(".nc-r .when")).toBeTruthy();
    expect(row.querySelector(".go")).toBeNull();
  });

  it("the bell badge is an UNREAD dot that clears after Mark all read", async () => {
    mount();
    await waitFor(() => expect(bell().querySelector(".n")).toBeTruthy());
    expect(bell().getAttribute("aria-label")).toContain("1 unread");
    fireEvent.click(bell());
    await waitFor(() => expect(panel().classList.contains("show")).toBe(true));
    await screen.findByText("Ship the widget");
    fireEvent.click(screen.getByText("Mark all read"));
    await waitFor(() => expect(bell().querySelector(".n")).toBeNull());
    expect(bell().getAttribute("aria-label")).not.toContain("unread");
  });

  it("ncUnreadCount caps a fully-unread page with more to load", () => {
    expect(ncUnreadCount([{ read: false }, { read: true }], true)).toEqual({ n: 1, label: "1" });
    expect(ncUnreadCount([{ read: false }, { read: false }], true)).toEqual({ n: 2, label: "2+" });
    expect(ncUnreadCount([], false)).toEqual({ n: 0, label: "0" });
  });

  it("opening the panel moves focus inside, Tab stays inside, Esc returns to the bell (review M1)", async () => {
    await openPanel();
    await waitFor(() => expect(panel().contains(document.activeElement)).toBe(true));
    expect((document.activeElement as HTMLElement).classList.contains("nrow")).toBe(true);
    const inside = Array.from(panel().querySelectorAll<HTMLElement>("a[href], button:not([disabled])")).filter((e) => e.tabIndex >= 0);
    inside[inside.length - 1].focus();
    fireEvent.keyDown(document.activeElement!, { key: "Tab" });
    expect(panel().contains(document.activeElement)).toBe(true);
    fireEvent.keyDown(document.activeElement!, { key: "Tab", shiftKey: true });
    expect(panel().contains(document.activeElement)).toBe(true);
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    expect(document.activeElement).toBe(bell());
  });

  it("the unread dot leads the title, not the age column (m4)", async () => {
    await openPanel();
    const row = screen.getByText("Ship the widget").closest(".nrow")!;
    expect(row.querySelector(".ti > .nc-unread")).toBeTruthy();
    expect(row.querySelector(".nc-r .nc-unread")).toBeNull();
  });

  it("a bare notification names its kind + actor / project, never a lone 'Notification' (m3)", () => {
    const bare = ncEarlierRow({ type: "weird", ts: 1, read: true, deeplink: { kind: "other", id: "x" } }, "orcha-web");
    expect(bare.ti).toBe("Weird"); // parity: the humanized type, as the old UI showed
    expect(bare.me).toBe("orcha-web");
    expect(bare.icon).toBe("bell");
    const withActor = ncEarlierRow({ type: "task_assigned", actor_alias: "lead", ts: 1, read: false, deeplink: { kind: "task", id: "t" } }, "orcha-web");
    expect(withActor.ti).toBe("Task assigned");
    expect(withActor.me).toBe("by lead · orcha-web");
    expect(withActor.actor).toBe("lead");
  });
});
