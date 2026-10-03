/**
 * D14 — sidebar project tree like Orca + user-chosen project icons.
 *  · project icon: default neutral glyph (never initials); "Change icon…" in the ⋯
 *    menu opens the picker (emoji search / recents / typed emoji; glyph + colour);
 *    the pick persists per PROJECT via PUT /api/containers/{cid}/icon (mig 050
 *    `containers.icon`, read back from the list + snapshot `icon` field).
 *  · tree: primary checkout (worktree/branch) → agent branch rows (runs[0].branch)
 *    → agents under the branch they work on; PR icon when a pull's head matches.
 *    Nothing is shown without that data (agents then nest directly under the project).
 *  · caret whenever the row has children; ⋯ always rendered (visible on hover/focus).
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { HashRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "../components/ui";
import { SnapshotProvider } from "../state/SnapshotProvider";
import { _resetProjectsForTests } from "../state/projects";
import { HomePage } from "../pages/home/HomePage";
import * as prefs from "../cloud/projects/prefs";
import * as icons from "../cloud/projects/projectIcons";
import { _resetTreeCachesForTests, buildProjectTree, compactAgo, repoFromRemote } from "./Sidebar";
import { searchEmoji } from "../components/primitives/EmojiPickerData";
import type { ProjectAgentRow } from "./liveAgents";

const now = Date.now();
const iso = (msAgo: number) => new Date(now - msAgo).toISOString();

function snapshot() {
  return {
    container: { id: "c1", name: "Website", status: "active", autonomy_level: "plan", wakes_enabled: true, last_wake_scan_at: new Date().toISOString() },
    agents: [
      { id: "h1", alias: "kedar", kind: "human", status: "idle" },
      { id: "a2", alias: "Mira", kind: "ai", status: "working", last_active: iso(3 * 60_000), current_task: { task_id: "t2", title: "Ship login" } },
      { id: "a3", alias: "Nova", kind: "ai", status: "working", last_active: iso(20 * 60_000), current_task: null },
      { id: "a4", alias: "Ivy", kind: "ai", status: "idle", last_active: iso(5 * 60_000) },
    ],
    tasks: [{ id: "t2", title: "Ship login", status: "in_progress", assignees: ["Mira"] }],
    requests: [],
    task_total: 1, request_total: 0,
  };
}
const CONTAINERS = [
  { id: "c1", name: "Website", status: "active", needs_you: 0, github_repo: "acme/web" },
  { id: "c2", name: "API service", status: "active", needs_you: 1 },
];

let calls: { url: string; method: string; body?: string }[] = [];
function stub(opts: { branch?: boolean; prefs?: Record<string, unknown> | null; iconStatus?: number } = {}) {
  const json = (data: unknown) => ({ ok: true, status: 200, json: async () => data }) as unknown as Response;
  calls = [];
  global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, method: init?.method || "GET", body: init?.body as string | undefined });
    if (url === "/api/containers") return json({ containers: CONTAINERS });
    if (url === "/api/prefs") return json({ prefs: opts.prefs === undefined ? {} : opts.prefs });
    if (/^\/api\/containers\/[^/]+\/icon$/.test(url) && init?.method === "PUT") {
      if (opts.iconStatus && opts.iconStatus >= 400) return { ok: false, status: opts.iconStatus, json: async () => ({ detail: "no" }) } as unknown as Response;
      const icon = JSON.parse(String(init?.body || "{}")).icon;
      return json({ container_id: decodeURIComponent(url.split("/")[3]), icon: icon && icon.kind === "glyph" ? { color: null, ...icon } : icon });
    }
    if (url === "/api/containers/c1/code/worktree/branch") {
      return json(opts.branch ? { available: true, branch: "main", remote: "git@github.com:acme/web.git" } : { available: false, reason: "github_source" });
    }
    if (url === "/api/containers/c1/github/pulls") return json({ available: true, pulls: [{ number: 55, head: "mira/login", html_url: "https://github.com/acme/web/pull/55" }] });
    if (url.startsWith("/api/agents/a2/runs")) return json({ runs: [{ run_id: "r1", branch: opts.branch ? "mira/login" : null }] });
    if (url.startsWith("/api/agents/")) return json({ runs: [] });
    if (url.startsWith("/api/containers/c1")) return json(snapshot());
    return json({});
  }) as unknown as typeof fetch;
}
const mount = () => render(<ToastProvider><SnapshotProvider><HashRouter><HomePage /></HashRouter></SnapshotProvider></ToastProvider>);
const sidebar = () => document.getElementById("sidebar") as HTMLElement;

beforeEach(() => {
  localStorage.clear();
  _resetProjectsForTests();
  _resetTreeCachesForTests();
  prefs._resetForTests();
  window.location.hash = "";
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); window.location.hash = ""; });

const row = (alias: string, id: string, state: ProjectAgentRow["state"] = "working"): ProjectAgentRow =>
  ({ alias, status: "working", state, fragment: "x", agent: { id, alias } as ProjectAgentRow["agent"] });

describe("D14 tree model (pure)", () => {
  it("primary first; a non-primary branch only when a shown agent works on it; unknown branch → directly under the project", () => {
    const t = buildProjectTree({
      primary: { branch: "main", repo: "acme/web" },
      agents: [row("mira", "a"), row("nova", "b"), row("ivy", "c")],
      more: 2,
      branchOf: new Map([["mira", "mira/login"], ["nova", null], ["ivy", "main"]]),
      repo: "acme/web",
      prs: new Map([["mira/login", { number: 55, url: "u" }]]),
    });
    expect(t.checkouts.map((c) => [c.checkout.branch, c.checkout.primary, c.agents.map((a) => a.alias)])).toEqual([
      ["main", true, ["ivy"]], ["mira/login", false, ["mira"]],
    ]);
    expect(t.checkouts[1].checkout.pr).toEqual({ number: 55, url: "u" });
    expect(t.loose.map((a) => a.alias)).toEqual(["nova"]);
    expect(t.more).toBe(2);
    expect(t.hasChildren).toBe(true);
  });
  it("worktrees disabled: branch-less agents work in the primary checkout", () => {
    const t = buildProjectTree({ primary: { branch: "main", repo: null }, agents: [row("nova", "b")], more: 0, branchOf: new Map(), repo: null, mainCheckoutOnly: true });
    expect(t.checkouts[0].agents.map((a) => a.alias)).toEqual(["nova"]);
    expect(t.loose).toHaveLength(0);
  });
  it("no data → no children (never fabricated)", () => {
    expect(buildProjectTree({ primary: null, agents: [], more: 0, branchOf: new Map(), repo: "acme/web" }).hasChildren).toBe(false);
  });
  it("repoFromRemote / compactAgo", () => {
    expect(repoFromRemote("git@github.com:acme/web.git")).toBe("acme/web");
    expect(repoFromRemote("https://github.com/acme/web")).toBe("acme/web");
    expect(repoFromRemote("")).toBeNull();
    expect(compactAgo(iso(10_000), now)).toBe("now");
    expect(compactAgo(iso(5 * 60_000), now)).toBe("5m");
    expect(compactAgo(iso(3 * 3600_000), now)).toBe("3h");
    expect(compactAgo(iso(2 * 86400_000), now)).toBe("2d");
  });
});

describe("D14 project icon store (projectIcons.ts — canonical containers.icon)", () => {
  it("validates like the desktop: emoji or known glyph + palette colour; initials / junk rejected", () => {
    expect(icons.parseProjectIcon({ kind: "emoji", value: "🚀" })).toEqual({ kind: "emoji", value: "🚀" });
    expect(icons.parseProjectIcon({ kind: "glyph", value: "rocket", color: 3 })).toEqual({ kind: "glyph", value: "rocket", color: 3 });
    expect(icons.parseProjectIcon({ kind: "glyph", value: "rocket", color: 12 })).toEqual({ kind: "glyph", value: "rocket", color: null });
    expect(icons.parseProjectIcon({ kind: "emoji", value: "OW" })).toBeNull();
    expect(icons.parseProjectIcon({ kind: "glyph", value: "nope" })).toBeNull();
  });
  it("server rows win (list / snapshot `icon`); rows without the key (older portal) are ignored", () => {
    icons.applyContainerIcons([{ id: "c2", icon: { kind: "glyph", value: "leaf", color: 1 } }, { id: "c3" }]);
    expect(icons.projectIcons()).toEqual({ c2: { kind: "glyph", value: "leaf", color: 1 } });
    icons.applyContainerIcons([{ id: "c2", icon: null }]);
    expect(icons.projectIcons()).toEqual({});
    icons.applyContainerIcons([{ id: "c2", icon: { kind: "emoji", value: "OW" } }]); // junk from anywhere → default
    expect(icons.projectIcons()).toEqual({});
  });
  it("a pick paints now and PUTs ONE project to the canonical per-project route", async () => {
    stub();
    const done = icons.saveProjectIcon("c1", { kind: "emoji", value: "📚" });
    expect(icons.projectIcons().c1).toEqual({ kind: "emoji", value: "📚" });
    // a server read racing the write never reverts the optimistic pick
    icons.applyContainerIcons([{ id: "c1", icon: null }]);
    expect(icons.projectIcons().c1).toEqual({ kind: "emoji", value: "📚" });
    await expect(done).resolves.toBe(true);
    const put = calls.find((c) => c.method === "PUT" && c.url === "/api/containers/c1/icon")!;
    expect(JSON.parse(put.body!)).toEqual({ icon: { kind: "emoji", value: "📚" } });
    expect(calls.some((c) => c.url.startsWith("/api/prefs"))).toBe(false);
    expect(prefs.localPrefs()).not.toHaveProperty("project_icons");
    expect(icons.emojiRecents()[0]).toBe("📚");
    expect(JSON.parse(localStorage.getItem(icons.PROJECT_ICONS_KEY)!)).toEqual({ c1: { kind: "emoji", value: "📚" } });
  });
  it("a refused write (viewer 403) rolls back to the previous icon", async () => {
    stub({ iconStatus: 403 });
    icons.applyContainerIcons([{ id: "c1", icon: { kind: "glyph", value: "leaf", color: 2 } }]);
    const done = icons.saveProjectIcon("c1", { kind: "emoji", value: "🧪" });
    expect(icons.projectIcons().c1).toEqual({ kind: "emoji", value: "🧪" });
    await expect(done).resolves.toBe(false);
    expect(icons.projectIcons().c1).toEqual({ kind: "glyph", value: "leaf", color: 2 });
  });
  it("the project list's `icon` field feeds every surface", async () => {
    const withIcon = [{ ...CONTAINERS[0] }, { ...CONTAINERS[1], icon: { kind: "emoji", value: "🦩" } }];
    stub();
    const base = global.fetch;
    global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) =>
      String(input) === "/api/containers"
        ? ({ ok: true, status: 200, json: async () => ({ containers: withIcon }) }) as unknown as Response
        : base(input, init)) as unknown as typeof fetch;
    mount();
    await waitFor(() => expect(sidebar().querySelector('[data-proj="c2"] .v2-sb-picon')!.getAttribute("data-icon")).toBe("emoji:🦩"));
  });
  it("emoji search: every word prefixes a name word", () => {
    expect(searchEmoji("rock").map((e) => e.emoji)).toContain("🚀");
    expect(searchEmoji("red hea").map((e) => e.emoji)).toContain("❤️");
    expect(searchEmoji("zzzqqq")).toEqual([]);
  });
});

describe("D14 sidebar", () => {
  it("rows show the neutral default glyph (never initials) and an always-rendered ⋯", async () => {
    stub();
    mount();
    await within(sidebar()).findByRole("link", { name: /^API service,/ });
    for (const id of ["c1", "c2"]) {
      const li = sidebar().querySelector(`[data-proj="${id}"]`)!;
      const icon = li.querySelector(".v2-sb-picon")!;
      expect(icon.getAttribute("data-icon")).toBe("default");
      expect(icon.textContent).toBe("");
      expect(li.querySelector(".v2-sb-more")).toBeTruthy();
    }
    // c2 has no snapshot → no children → no caret; c1 has live agents → caret
    expect(sidebar().querySelector('[data-proj="c2"] .v2-sb-proj-caret')).toBeNull();
    await waitFor(() => expect(sidebar().querySelector('[data-proj="c1"] .v2-sb-proj-caret')).toBeTruthy());
  });

  it("⋯ → Change icon… → pick an emoji: every surface updates and the pick persists", async () => {
    stub();
    mount();
    const more = await within(sidebar()).findByRole("button", { name: "API service actions" });
    fireEvent.click(more);
    fireEvent.click(await screen.findByRole("menuitem", { name: /Change icon/ }));
    const dlg = await screen.findByRole("dialog", { name: "Change icon for API service" });
    const search = within(dlg).getByRole("textbox", { name: "Search emoji" });
    await waitFor(() => expect(document.activeElement).toBe(search));
    fireEvent.change(search, { target: { value: "rocket" } });
    fireEvent.click(within(dlg).getByRole("button", { name: /rocket/ }));
    await waitFor(() => expect(sidebar().querySelector('[data-proj="c2"] .v2-sb-picon')!.getAttribute("data-icon")).toBe("emoji:🚀"));
    expect(screen.queryByRole("dialog", { name: /Change icon/ })).toBeNull();
    await waitFor(() => expect(calls.some((c) => c.method === "PUT" && c.url === "/api/containers/c2/icon")).toBe(true));
  });

  it("a pasted emoji is usable; the Icons tab picks a glyph with a palette colour; Reset returns to default", async () => {
    stub();
    mount();
    const more = await within(sidebar()).findByRole("button", { name: "API service actions" });
    fireEvent.click(more);
    fireEvent.click(await screen.findByRole("menuitem", { name: /Change icon/ }));
    let dlg = await screen.findByRole("dialog", { name: /Change icon/ });
    fireEvent.change(within(dlg).getByRole("textbox"), { target: { value: "🦩" } });
    fireEvent.click(within(dlg).getByRole("button", { name: "Use 🦩" }));
    await waitFor(() => expect(icons.projectIcons().c2).toEqual({ kind: "emoji", value: "🦩" }));

    fireEvent.click(more);
    fireEvent.click(await screen.findByRole("menuitem", { name: /Change icon/ }));
    dlg = await screen.findByRole("dialog", { name: /Change icon/ });
    fireEvent.click(within(dlg).getByRole("tab", { name: "Icons" }));
    fireEvent.click(within(dlg).getByRole("radio", { name: "Lime" }));
    fireEvent.click(within(dlg).getByRole("button", { name: "database" }));
    await waitFor(() => expect(icons.projectIcons().c2).toEqual({ kind: "glyph", value: "database", color: 3 }));
    expect(sidebar().querySelector('[data-proj="c2"] .v2-sb-picon')!.getAttribute("data-icon")).toBe("glyph:database");

    fireEvent.click(more);
    fireEvent.click(await screen.findByRole("menuitem", { name: /Change icon/ }));
    dlg = await screen.findByRole("dialog", { name: /Change icon/ });
    fireEvent.click(within(dlg).getByRole("button", { name: "Reset to default" }));
    await waitFor(() => expect(icons.projectIcons().c2).toBeUndefined());
  });

  it("without branch data agents nest directly under the project; a working agent shows its task or 'working', never an age", async () => {
    stub({ branch: false });
    mount();
    const list = await within(sidebar()).findByRole("list", { name: "Live agents in Website" });
    expect(list.querySelector(".v2-sb-br")).toBeNull();
    const nova = within(list).getByRole("link", { name: /^Nova,/ });
    expect(nova.querySelector(".v2-sb-agent-task")!.textContent).toBe("working");
    expect(nova.querySelector(".v2-sb-agent-age")!.textContent).toBe("20m");
    expect(within(list).queryByRole("link", { name: /^Ivy,/ })).toBeNull(); // idle → hidden (D11)
  });

  it("with real branch data: primary checkout (badge; repo line only when it isn't the project's repo), the agent's branch with its PR, agents under their branch", async () => {
    stub({ branch: true });
    mount();
    const list = await within(sidebar()).findByRole("list", { name: "Branches and live agents in Website" });
    await waitFor(() => expect(list.querySelectorAll(".v2-sb-br")).toHaveLength(2));
    const [main, feat] = [...list.querySelectorAll<HTMLElement>(".v2-sb-br")];
    expect(main.querySelector(".v2-sb-br-name")!.textContent).toBe("main");
    expect(main.querySelector(".v2-sb-br-badge")!.textContent).toBe("primary");
    // the checkout's repo IS the project's github_repo → not repeated under the branch
    expect(main.querySelector(".v2-sb-br-repo")).toBeNull();
    expect(main.querySelector(".v2-sb-br-main")!.getAttribute("aria-label")).toContain("acme/web"); // still in the name / tooltip
    expect(feat.querySelector(".v2-sb-br-name")!.textContent).toBe("mira/login");
    expect(feat.querySelector(".v2-sb-br-badge")).toBeNull();
    expect(feat.querySelector(".v2-sb-br-repo")).toBeNull(); // the repo is one fact, shown once
    await waitFor(() => expect(feat.querySelector("a.v2-sb-br-pr")?.getAttribute("href")).toBe("https://github.com/acme/web/pull/55"));
    expect(within(feat).getByRole("link", { name: /^Mira,/ })).toBeTruthy();
    // Nova's run has no branch → directly under the project
    const nova = within(list).getByRole("link", { name: /^Nova,/ });
    expect(nova.closest(".v2-sb-br")).toBeNull();
    // …and BEFORE the branch groups, so it never reads as the last branch's child
    const order = [...list.children].map((li) => (li.classList.contains("v2-sb-br") ? "branch" : li.querySelector(".v2-sb-agent") ? "agent" : "other"));
    expect(order.indexOf("agent")).toBeLessThan(order.indexOf("branch"));
    // the caret collapses the whole tree and is remembered
    const caret = within(sidebar()).getByRole("button", { name: "Hide branches and live agents in Website" });
    act(() => { fireEvent.click(caret); });
    expect(within(sidebar()).queryByRole("list", { name: /Branches and live agents/ })).toBeNull();
  });
});
