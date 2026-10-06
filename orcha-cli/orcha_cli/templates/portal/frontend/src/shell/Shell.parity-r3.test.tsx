/**
 * Parity round 3 (shell):
 *  - SH-130: a WHOLE-backend outage reads "Can't reach Orcha" at once — a project
 *    list cached before the outage is no proof Orcha answers now (it refreshes
 *    only every 60 s), and a 502 / 504 is a gateway saying Orcha didn't answer.
 *    After recovery the sidebar list and the notification feed re-load at once.
 *  - a11y extra: tab count titles agree in number ("1 open task").
 *  - extra: the non-member sidebar reads "No projects you're a member of" and
 *    offers Sign out when a proxy sign-in exists (no cid ⇒ no /api/me).
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { HashRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "../components/ui";
import { SnapshotProvider, snapshotErrorKind, _setActingIdentity, _setActingAuth } from "../state/SnapshotProvider";
import { _resetProjectsForTests } from "../state/projects";
import { Shell, listedProjectName } from "./Shell";
import { sectionCounts } from "./nav";
import type { Snapshot } from "../types";

const json = (data: unknown, status = 200) =>
  ({ ok: status < 400, status, json: async () => data }) as unknown as Response;

const SNAP = {
  container: { id: "c1", name: "Orcha", status: "active", autonomy_level: "plan", wakes_enabled: true },
  agents: [{ id: "h1", alias: "kedar", kind: "human", status: "idle" }],
  tasks: [], requests: [],
};

let mode: "ok" | "down" = "ok";
let calls: string[] = [];
let listBody: unknown = { containers: [{ id: "c1", name: "Orcha", status: "active" }] };
let userinfo: Response | null = null;

beforeEach(() => {
  localStorage.clear();
  mode = "ok";
  calls = [];
  listBody = { containers: [{ id: "c1", name: "Orcha", status: "active" }] };
  userinfo = null;
  global.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);
    if (url === "/oauth2/userinfo") return userinfo ?? json({ detail: "Not Found" }, 404);
    if (mode === "down") return json({ detail: "boom" }, 503);
    if (url.startsWith("/api/containers?") || url === "/api/containers") return json(listBody);
    if (url.startsWith("/api/containers/c1")) return json(SNAP);
    if (url.startsWith("/api/agents/h1/notifications")) return json({ notifications: [], next_before_ts: null });
    return json({});
  }) as unknown as typeof fetch;
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  _setActingIdentity(null);
  _setActingAuth({ pending: false, trusted: false });
  _resetProjectsForTests();
});

function mountShell(pollMs = 100) {
  return render(
    <ToastProvider>
      <SnapshotProvider pollMs={pollMs}>
        <HashRouter>
          <Shell page="home" title="Overview"><div>body</div></Shell>
        </HashRouter>
      </SnapshotProvider>
    </ToastProvider>,
  );
}
const count = (pred: (u: string) => boolean) => calls.filter(pred).length;
const isList = (u: string) => u === "/api/containers" || u.startsWith("/api/containers?");
const isFeed = (u: string) => u.startsWith("/api/agents/h1/notifications?");

describe("SH-130 pure helpers", () => {
  it("502 / 504 are 'network' (a gateway: Orcha didn't answer); 503 / 500 stay 'server'", () => {
    expect(snapshotErrorKind("/api/containers/c1 → 502")).toBe("network");
    expect(snapshotErrorKind("x", 504)).toBe("network");
    expect(snapshotErrorKind("/api/containers/c1 → 503")).toBe("server");
    expect(snapshotErrorKind("x", 500)).toBe("server");
  });
  it("listedProjectName: only a list fetched AFTER the failure began proves Orcha answers", () => {
    const list = [{ id: "c1", name: "billing" }];
    expect(listedProjectName("c1", { list, error: null, fetchedAt: 100 }, null)).toBe("billing");
    expect(listedProjectName("c1", { list, error: null, fetchedAt: 100 }, 200)).toBeNull(); // stale cache
    expect(listedProjectName("c1", { list, error: null, fetchedAt: 300 }, 200)).toBe("billing");
    expect(listedProjectName("c1", { list, error: "boom", fetchedAt: 300 }, 200)).toBeNull();
    expect(listedProjectName("c9", { list, error: null, fetchedAt: 300 }, 200)).toBeNull();
  });
});

describe("SH-130 whole-backend outage + recovery", () => {
  it("with a cached list, an outage reads Can't reach Embodent — never '<project> is unreachable'", async () => {
    mountShell();
    await waitFor(() => expect(count(isList)).toBeGreaterThan(0));
    await waitFor(() => expect(document.querySelector(".v2-sb-note.is-error")).toBeNull());
    await new Promise((r) => setTimeout(r, 250)); // a good snapshot + list are on screen
    const listBefore = count(isList);
    // everything 5xx's from now on; jump the clock past STALE_MS so it reads offline
    mode = "down";
    const real = Date.now.bind(Date);
    vi.spyOn(Date, "now").mockImplementation(() => real() + 11_000);
    // the first failure re-asks the project list at once (not on the 60 s tick)
    await waitFor(() => expect(count(isList)).toBeGreaterThan(listBefore), { timeout: 2000 });
    await screen.findByText(/Can't reach Embodent/, { selector: ".v2-stalebar-msg" }, { timeout: 6000 });
    expect(document.querySelector(".v2-stalebar-msg")!.textContent).not.toMatch(/Orcha is unreachable/);
    expect(screen.queryByText(/^Connected — /)).toBeNull();
  }, 12_000);

  it("after recovery the sidebar list and the notification feed re-load at once", async () => {
    mode = "down";
    mountShell();
    await screen.findByText(/Project list unavailable/, {}, { timeout: 3000 });
    const listBefore = count(isList);
    mode = "ok";
    // the snapshot poll (100 ms) recovers; the list must follow within ~1 s, not 60 s
    await waitFor(() => expect(count(isList)).toBeGreaterThan(listBefore), { timeout: 1500 });
    await waitFor(() => expect(screen.queryByText(/Project list unavailable/)).toBeNull(), { timeout: 1500 });
    const feedAfterFirstOk = count(isFeed);
    expect(feedAfterFirstOk).toBeGreaterThan(0); // loaded on recovery (never loaded while down: no human)
  }, 10_000);

  it("a feed that failed during a blip re-loads when the snapshot recovers", async () => {
    mountShell();
    await waitFor(() => expect(count(isFeed)).toBeGreaterThan(0));
    const feedBefore = count(isFeed);
    mode = "down";
    await waitFor(() => expect(calls.slice(-3).some((u) => u.startsWith("/api/containers/c1"))).toBe(true));
    await new Promise((r) => setTimeout(r, 300)); // a few failed polls
    mode = "ok";
    await waitFor(() => expect(count(isFeed)).toBeGreaterThan(feedBefore), { timeout: 1500 });
  }, 10_000);
});

describe("tab count titles agree in number (a11y extra)", () => {
  const snap = (tasks: number, agents: number) => ({
    container: { id: "c1" },
    agents: Array.from({ length: agents }, (_, i) => ({ id: "a" + i, alias: "a" + i, kind: "ai" })),
    tasks: Array.from({ length: tasks }, (_, i) => ({ id: "t" + i, title: "t", status: "ready" })),
    requests: [],
  }) as unknown as Snapshot;
  it("1 → singular, otherwise plural", () => {
    const one = sectionCounts(snap(1, 1));
    expect(one.tasks.n).toBe(1);
    expect(one.tasks.title).toBe("open task (not completed or cancelled)");
    expect(one.agents.title).toBe("agent (AI + human)");
    const two = sectionCounts(snap(2, 3));
    expect(two.tasks.title).toBe("open tasks (not completed or cancelled)");
    expect(two.agents.title).toBe("agents (AI + human)");
    expect(sectionCounts(snap(0, 0)).requests.title).toBe("open requests");
  });
});

describe("zero memberships (non-member sidebar)", () => {
  it("reads 'No projects you're a member of' and offers Sign out when a proxy sign-in exists", async () => {
    listBody = { containers: [] };
    userinfo = json({ user: "stranger-x", email: "x@example.com" });
    mountShell();
    await screen.findByText("No projects you're a member of", {}, { timeout: 3000 });
    expect(screen.queryByText("No projects yet")).toBeNull();
    const acct = await screen.findByRole("button", { name: /^Account:/ }, { timeout: 3000 });
    fireEvent.click(acct);
    const out = await screen.findByRole("menuitem", { name: "Sign out" });
    expect(out.getAttribute("href")).toBe("/oauth2/sign_out?rd=%2Fwelcome");
  });
  it("self-host (no proxy session): no account menu is invented", async () => {
    listBody = { containers: [] };
    mountShell();
    await screen.findByText("No projects you're a member of", {}, { timeout: 3000 });
    await waitFor(() => expect(calls).toContain("/oauth2/userinfo"));
    expect(screen.queryByRole("button", { name: /^Account:/ })).toBeNull();
  });
});
