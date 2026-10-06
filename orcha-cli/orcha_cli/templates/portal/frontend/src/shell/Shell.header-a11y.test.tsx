/**
 * QA #31 / #33 — header a11y + phone crumb (copied fixture from
 * Shell.notification-center.test.tsx).
 *
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

async function openPanel() {
  mount();
  await waitFor(() => expect(bell()).toBeTruthy());
  expect(panel().classList.contains("show")).toBe(false);
  fireEvent.click(bell());
  await waitFor(() => expect(panel().classList.contains("show")).toBe(true));
  await screen.findByText("Ship the widget");
}

describe("Shell header — QA #31 bell semantics + SPA rows, QA #33 project crumb", () => {
  beforeEach(() => {
    localStorage.clear();
    stubFetch();
    window.location.hash = "";
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("the bell is a disclosure <button> controlling a named dialog", async () => {
    mount();
    await waitFor(() => expect(bell()).toBeTruthy());
    expect(bell().tagName).toBe("BUTTON");
    expect(bell().getAttribute("href")).toBeNull();
    expect(bell().getAttribute("aria-haspopup")).toBe("dialog");
    expect(bell().getAttribute("aria-controls")).toBe("ncFloat");
    expect(bell().getAttribute("aria-expanded")).toBe("false");
    expect(panel().getAttribute("role")).toBe("dialog");
    expect(panel().getAttribute("aria-label")).toBe("Notifications");
    fireEvent.click(bell());
    await waitFor(() => expect(bell().getAttribute("aria-expanded")).toBe("true"));
  });

  it("clicking a notification row SPA-navigates (no document load) and closes the panel", async () => {
    await openPanel();
    const row = screen.getByText("Ship the widget").closest("a") as HTMLAnchorElement;
    const notPrevented = fireEvent.click(row, { button: 0 });
    expect(notPrevented).toBe(false); // default (full load) suppressed
    await waitFor(() => expect(window.location.hash).toBe("#/tasks?task=t1"));
    await waitFor(() => expect(panel().classList.contains("show")).toBe(false));
  });

  it("modified clicks keep the browser default (open in new tab)", async () => {
    await openPanel();
    const row = screen.getByText("Ship the widget").closest("a") as HTMLAnchorElement;
    let preventedByApp: boolean | null = null;
    // runs after React's root handler; then stop jsdom's (unimplemented) navigation
    const spy = (e: Event) => { preventedByApp = e.defaultPrevented; e.preventDefault(); };
    window.addEventListener("click", spy);
    try {
      fireEvent.click(row, { button: 0, metaKey: true });
    } finally {
      window.removeEventListener("click", spy);
    }
    expect(preventedByApp).toBe(false);
    expect(window.location.hash).toBe("");
  });

  it("the project crumb (avatar-only at phone widths) keeps its name for assistive tech", async () => {
    mount();
    await waitFor(() => expect(document.querySelector("#topbar .v2-header-pname")).toBeTruthy());
    const name = document.querySelector("#topbar .v2-header-pname") as HTMLElement;
    expect(name.textContent).toBe("Orcha");
    expect(name.closest("[aria-hidden]")).toBeNull(); // visually clipped when narrow, never hidden from AT
    expect(name.closest(".v2-header-crumbs")).toBeTruthy();
    expect(document.querySelector(".v2-header-proj")).toBeNull(); // no second crumb line (one-row header)
  });
});
