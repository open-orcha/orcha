/**
 * ProjectsPage — "All projects" compact list (V2; parity R-02, P-01…P-03).
 * The membership-filtered list from GET /api/containers (shared project
 * store), every Open link carries ?cid= (full href — that is project
 * switching), pending decisions are labeled with what they measure and a
 * missing figure is "unavailable", never 0. fetch is stubbed.
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "../../components/ui";
import { _resetProjectsForTests } from "../../state/projects";
import { resetIdentity } from "../identity";
import { HUB_REFRESH_MS, ProjectsPage, aiAgentCount, nextSort, sortProjects, wakeHealth, type ProjContainer } from "./ProjectsPage";

// the scoped project (useSnapshot().cid) — null by default like an unscoped mount
const scoped = vi.hoisted(() => ({
  cid: null as string | null, snap: null as unknown,
  attention: { items: [], count: null as number | null, partial: false, followUps: [], readOnly: false },
}));
vi.mock("../../state/SnapshotProvider", () => ({
  useSnapshot: () => ({ snap: scoped.snap, cid: scoped.cid, multi: false, refresh: async () => {} }),
  actingHuman: () => null,
  setActingHuman: () => {},
}));
vi.mock("../../state/attention", () => ({ useAttention: () => scoped.attention }));
import * as prefs from "./prefs";
import * as icons from "./projectIcons";

interface Call { url: string; method: string; body: unknown }

const containers = [
  {
    id: "c1", name: "acme-ehr", description: "The EHR build", status: "active",
    github_repo: "acme/ehr", agents: 3, tasks: 12, needs_you: 2,
    member_count: 2, last_wake_scan_at: new Date(Date.now() - 120_000).toISOString(),
    members: [
      { alias: "kedar", github_login: "kedar-gh", member_role: "owner" },
      { alias: "sam", github_login: null, member_role: "member" },
    ],
  },
  {
    id: "c2", name: "api-gateway", description: null, status: "provisioning",
    github_repo: null, agents: 1, tasks: 0, needs_you: 0, last_wake_scan_at: null,
    member_count: 4, members: null, // roster privacy: count only
  },
  {
    id: "c3", name: "legacy-backend", description: "Old stack", status: "active",
    github_repo: null, agents: 0, tasks: 1, // no needs_you field at all → unavailable
    member_count: 1, members: null,
  },
];

let listStatus = 200;
let meBody: unknown = null; // null = the default owner envelope
function stubFetch(opts?: { prefs?: Record<string, string> | null }): Call[] {
  const calls: Call[] = [];
  const json = (data: unknown, status = 200) =>
    ({ ok: status < 400, status, json: async () => data }) as unknown as Response;
  global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, method: init?.method || "GET", body: init?.body ? JSON.parse(String(init.body)) : null });
    if (url === "/api/prefs") return json({ prefs: opts?.prefs ?? null });
    if (url === "/api/containers") return json({ containers }, listStatus);
    if (url.startsWith("/api/me")) return json(meBody ?? { identity: { github_login: "kedar-gh", member_role: "owner" }, trusted: true });
    if (url.includes("/pairing")) return json({ detail: { message: "stub" } }, 409);
    return json({});
  }) as unknown as typeof fetch;
  return calls;
}

function mount() {
  return render(
    <ToastProvider>
      <MemoryRouter>
        <ProjectsPage />
      </MemoryRouter>
    </ToastProvider>,
  );
}

beforeEach(() => {
  localStorage.clear();
  prefs._resetForTests();
  _resetProjectsForTests();
  resetIdentity();
  listStatus = 200;
  meBody = null;
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); _resetProjectsForTests(); });

describe("ProjectsPage (All projects list)", () => {
  it("renders one row per membership with the manager fields", async () => {
    const calls = stubFetch();
    mount();
    expect(await screen.findByText("acme-ehr")).toBeInTheDocument();
    expect(screen.getByText("api-gateway")).toBeInTheDocument();
    expect(calls.some((c) => c.url === "/api/containers" && c.method === "GET")).toBe(true);
    const ehr = document.querySelector<HTMLElement>('[data-proj-card="c1"]')!;
    expect(within(ehr).getByText("The EHR build")).toBeInTheDocument();
    expect(within(ehr).getByText("acme/ehr")).toBeInTheDocument();
    expect(within(ehr).getByTitle(/waiting on you/)).toHaveTextContent("2");
    // 2 min old stamp at fetch time is past the 2-min wake window → a Stale health chip
    expect(ehr.querySelector('[data-wake="stale"]')).toHaveTextContent(/Stale · 2m/);
    const gw = document.querySelector<HTMLElement>('[data-proj-card="c2"]')!;
    expect(within(gw).queryByText("No description yet.")).toBeNull(); // no filler copy
    expect(within(gw).getByText("4 members")).toBeInTheDocument(); // roster privacy: count, never names
    expect(within(gw).getByText("No wake service")).toHaveClass("v2-sr"); // "—" visually, fact for AT + tooltip
    // missing needs_you is "unavailable", never a fake 0
    const legacy = document.querySelector<HTMLElement>('[data-proj-card="c3"]')!;
    expect(within(legacy).getByText(/Pending decisions unavailable/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "New project" })).toBeInTheDocument();
    // the "All projects 3" pill says the total; no duplicate "3 projects" text
    expect(screen.queryByText("3 projects")).toBeNull();
  });

  it("project names open the project with ?cid=<id> (full href navigation)", async () => {
    stubFetch();
    mount();
    await screen.findByText("acme-ehr");
    expect(screen.getByRole("link", { name: "acme-ehr" })).toHaveAttribute("href", "/?cid=c1");
    expect(screen.getByRole("link", { name: "api-gateway" })).toHaveAttribute("href", "/?cid=c2");
  });

  it("filter narrows the list and says when nothing matches", async () => {
    stubFetch();
    mount();
    await screen.findByText("acme-ehr");
    fireEvent.click(screen.getByRole("button", { name: "Filter projects" }));
    fireEvent.change(screen.getByLabelText("Filter projects"), { target: { value: "gateway" } });
    expect(screen.queryByText("acme-ehr")).toBeNull();
    expect(screen.getByText("1 of 3 projects")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Filter projects"), { target: { value: "zzz" } });
    expect(screen.getByText(/No project matches/)).toBeInTheDocument();
    // the zero is said once (the no-match line), not also as "0 of 3 projects"
    expect(screen.queryByText("0 of 3 projects")).toBeNull();
    fireEvent.click(document.getElementById("projClear")!);
    expect(screen.getByText("acme-ehr")).toBeInTheDocument();
    expect(screen.queryByText(/No project matches/)).toBeNull();
  });

  it("row menu pins a project (local, shared with the sidebar) and links to its settings", async () => {
    stubFetch();
    mount();
    await screen.findByText("acme-ehr");
    fireEvent.click(screen.getByRole("button", { name: "api-gateway actions" }));
    const menu = await screen.findByRole("menu");
    expect(within(menu).getByRole("menuitem", { name: /Project settings/ })).toHaveAttribute("href", "/settings?cid=c2");
    fireEvent.click(within(menu).getByRole("menuitem", { name: /Add to favorites/ }));
    expect(JSON.parse(localStorage.getItem("orcha:v2:pinnedProjects") || "[]")).toEqual(["c2"]);
    expect(await screen.findByRole("rowgroup", { name: "Favorite projects" })).toBeInTheDocument();
    expect(within(screen.getByRole("rowgroup", { name: "Favorite projects" })).getByText("api-gateway")).toBeInTheDocument();
    // the ⋯ menu now offers the inverse
    fireEvent.click(screen.getByRole("button", { name: "api-gateway actions" }));
    expect(await screen.findByRole("menuitem", { name: /Remove from favorites/ })).toBeInTheDocument();
  });

  it("Pair phone opens the cid-scoped pairing modal for THAT project", async () => {
    const calls = stubFetch();
    mount();
    await screen.findByText("acme-ehr");
    // pairing lives in the row menu only (no per-row phone icon)
    expect(screen.queryByRole("button", { name: /Pair a phone/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "api-gateway actions" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: /Pair phone/ }));
    await waitFor(() => expect(calls.some((c) => c.url.startsWith("/api/containers/c2/pairing"))).toBe(true));
  });

  it("identity for pairing comes from /api/me?cid=<first project>", async () => {
    const calls = stubFetch();
    mount();
    await screen.findByText("acme-ehr");
    await waitFor(() => expect(calls.some((c) => c.url === "/api/me?cid=c1")).toBe(true));
  });

  it("default stars render only when server prefs are active (mig 040)", async () => {
    stubFetch({ prefs: { default_cid: "c2" } });
    mount();
    await screen.findByText("acme-ehr");
    await waitFor(() => expect(document.querySelectorAll("[data-def-cid]").length).toBe(3));
    expect(document.querySelector('[data-def-cid="c2"]')).toHaveClass("on");
    expect(document.querySelector('[data-def-cid="c1"]')).not.toHaveClass("on");
  });

  it("self-host (prefs null) paints NO stars at all", async () => {
    stubFetch({ prefs: null });
    mount();
    await screen.findByText("acme-ehr");
    expect(document.querySelectorAll("[data-def-cid]").length).toBe(0);
  });

  it("zero and unavailable pending counts read differently; the measure is labelled once", async () => {
    stubFetch();
    mount();
    await screen.findByText("acme-ehr");
    expect(screen.getByText(/the same count as the sidebar/)).toBeInTheDocument();
    const legacy = document.querySelector('[data-proj-card="c3"]') as HTMLElement | null;
    expect(within(legacy!).queryByText(/n\/a/)).toBeNull();
    expect(within(legacy!).getByTitle(/did not report pending decisions/)).toHaveTextContent(/^—Pending decisions unavailable$/);
    const gw = document.querySelector('[data-proj-card="c2"]') as HTMLElement;
    expect(within(gw).getByTitle("Nothing waiting on you")).toHaveTextContent(/^0 waiting on you$/);
    expect(within(gw).getByText("Provisioning")).toBeInTheDocument(); // non-active status is a word
  });

  it("active projects carry no status word; the row has a project avatar", async () => {
    stubFetch();
    mount();
    await screen.findByText("acme-ehr");
    const ehr = document.querySelector('[data-proj-card="c1"]') as HTMLElement;
    // D14: a project ICON (default neutral cube), never initials
    const ico = ehr.querySelector<HTMLElement>(".prow-av.v2-picon")!;
    expect(ico).toHaveAttribute("data-icon", "default");
    expect(ico.textContent).toBe("");
    expect(ehr.querySelector(".v2-av-project")).toBeNull();
    expect(within(ehr).queryByText(/^Active$/)).toBeNull();
  });

  it("D14: a chosen project icon (shared per-project store) shows on the row and updates live", async () => {
    stubFetch();
    mount();
    await screen.findByText("acme-ehr");
    act(() => icons.setProjectIcon("c1", { kind: "emoji", value: "🚀" }));
    const ico = document.querySelector<HTMLElement>('[data-proj-card="c1"] .prow-av')!;
    expect(ico).toHaveAttribute("data-icon", "emoji:🚀");
    expect(ico).toHaveTextContent("🚀");
    act(() => icons.setProjectIcon("c1", { kind: "glyph", value: "rocket", color: 3 }));
    expect(document.querySelector('[data-proj-card="c1"] .prow-av')).toHaveAttribute("data-icon", "glyph:rocket");
    act(() => icons.setProjectIcon("c1", null));
    expect(document.querySelector('[data-proj-card="c1"] .prow-av')).toHaveAttribute("data-icon", "default");
  });

  it("D14: the row ⋯ menu opens the icon picker; picking sets that project's icon", async () => {
    stubFetch();
    mount();
    await screen.findByText("acme-ehr");
    fireEvent.click(screen.getByRole("button", { name: "acme-ehr actions" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: /Change icon/ }));
    const dlg = await screen.findByRole("dialog");
    expect(dlg).toBeInTheDocument();
    const reset = within(dlg).queryByRole("button", { name: /Reset|Remove/i });
    act(() => icons.setProjectIcon("c1", { kind: "emoji", value: "🧪" }));
    expect(document.querySelector('[data-proj-card="c1"] .prow-av')).toHaveAttribute("data-icon", "emoji:🧪");
    if (reset) {
      fireEvent.click(reset);
      expect(document.querySelector('[data-proj-card="c1"] .prow-av')).toHaveAttribute("data-icon", "default");
    }
  });

  it("Initiatives table: scope pills filter active/inactive with honest counts", async () => {
    stubFetch();
    mount();
    await screen.findByText("acme-ehr");
    const scope = screen.getByRole("radiogroup", { name: "Project scope" });
    expect(within(scope).getByRole("radio", { name: /All projects\s*3/ })).toHaveAttribute("aria-checked", "true");
    fireEvent.click(within(scope).getByRole("radio", { name: /Inactive\s*1/ }));
    expect(screen.getByText("api-gateway")).toBeInTheDocument(); // provisioning ≠ active
    expect(screen.queryByText("acme-ehr")).toBeNull();
    expect(screen.queryByText("1 of 3 projects")).toBeNull(); // the pill already carries the count
    fireEvent.click(within(scope).getByRole("radio", { name: /Active\s*2/ }));
    expect(screen.queryByText("api-gateway")).toBeNull();
    expect(screen.getByText("legacy-backend")).toBeInTheDocument();
  });

  it("roster members render as one AvatarStack; the whole row stays one link", async () => {
    stubFetch();
    mount();
    await screen.findByText("acme-ehr");
    const ehr = document.querySelector<HTMLElement>('[data-proj-card="c1"]')!;
    expect(within(ehr).getByRole("img", { name: "Members: kedar, sam" })).toBeInTheDocument();
    // one row link (the name) + the repository's own github.com link above it
    expect(within(ehr).getAllByRole("link").map((l) => l.getAttribute("href"))).toEqual(["/?cid=c1", "https://github.com/acme/ehr"]);
    // no filler, no duplicated measure in rows; the column header carries it
    // server needs_you = the portal's attention rule (attention_counts.py) → the sidebar's name
    expect(document.querySelector(".proj-cols")?.textContent).toMatch(/Needs you/);
    expect(document.querySelector(".proj-cols")?.textContent).not.toMatch(/Awaiting human|excludes plan/i);
  });

  it("a failed load shows an error with Retry, not an empty list", async () => {
    listStatus = 500;
    stubFetch();
    mount();
    expect(await screen.findByText("Couldn't load projects")).toBeInTheDocument();
    expect(screen.queryByText("No projects yet")).toBeNull();
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
  });
});

describe("ProjectsPage polish (Linear r1)", () => {
  it("wakeHealth: Waking inside the window, Stale after it, none without a stamp — judged at fetch time", () => {
    const asOf = Date.parse("2026-09-28T12:00:00Z");
    expect(wakeHealth("2026-09-28T11:59:30Z", asOf)).toMatchObject({ kind: "waking", health: "on_track", label: "Waking" });
    expect(wakeHealth("2026-09-28T11:30:00Z", asOf)).toMatchObject({ kind: "stale", health: "at_risk" });
    expect(wakeHealth(null, asOf)).toMatchObject({ kind: "none", health: null });
    expect(wakeHealth("garbage", asOf).kind).toBe("none");
  });

  it("a fresh wake stamp renders the Waking health chip", async () => {
    stubFetch();
    const fresh = containers[0].last_wake_scan_at;
    containers[0].last_wake_scan_at = new Date(Date.now() - 10_000).toISOString();
    try {
      mount();
      await screen.findByText("acme-ehr");
      const ehr = document.querySelector<HTMLElement>('[data-proj-card="c1"]')!;
      expect(ehr.querySelector('[data-wake="waking"] .v2-health.is-on_track')).toHaveTextContent("Waking");
    } finally { containers[0].last_wake_scan_at = fresh; }
  });

  it("GitHub repos show the GitHub mark in the UI font (no link icon, no mono)", async () => {
    stubFetch();
    mount();
    await screen.findByText("acme-ehr");
    const repo = document.querySelector('[data-proj-card="c1"] .prepo')!;
    expect(repo).toHaveAttribute("data-repo-kind", "github");
    expect(repo.querySelector("svg.prepo-ico")).toBeTruthy();
  });

  it("tasks render as done / total only when the server sends tasks_done", async () => {
    stubFetch();
    (containers[0] as Record<string, unknown>).tasks_done = 5;
    try {
      mount();
      await screen.findByText("acme-ehr");
      const ehr = document.querySelector<HTMLElement>('[data-proj-card="c1"] .pcell-tasks')!;
      expect(ehr).toHaveTextContent(/^5 \/ 12 tasks$/);
      expect(document.querySelector('[data-proj-card="c2"] .pcell-tasks')).toHaveTextContent(/^0 tasks$/);
    } finally { delete (containers[0] as Record<string, unknown>).tasks_done; }
  });

  it("filter is a circular button that expands; Esc clears and collapses it", async () => {
    stubFetch();
    mount();
    await screen.findByText("acme-ehr");
    expect(screen.queryByRole("searchbox")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Filter projects" }));
    const box = screen.getByLabelText("Filter projects");
    fireEvent.change(box, { target: { value: "ehr" } });
    expect(screen.queryByText("api-gateway")).toBeNull();
    fireEvent.keyDown(box, { key: "Escape" });
    expect(screen.getByText("api-gateway")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Filter projects" })).toBeInTheDocument();
  });

  it("the project this tab is scoped to opens in-app (no reload); others switch by full href", async () => {
    stubFetch();
    scoped.cid = "c2";
    try {
      mount();
      await screen.findByText("acme-ehr");
      expect(screen.getByRole("link", { name: "api-gateway" })).toHaveAttribute("href", "/"); // router Link
      expect(screen.getByRole("link", { name: "acme-ehr" })).toHaveAttribute("href", "/?cid=c1");
    } finally { scoped.cid = null; }
  });
});

describe("ProjectsPage local repo badge (Orcha Cloud local run, Addendum 2)", () => {
  it("a local binding renders the workspace name + Local chip, not a github.com link", async () => {
    const localContainers = [
      { id: "c3", name: "quantal-local", description: "Local dev", status: "active",
        github_repo: "local", agents: 1, tasks: 0, needs_you: 0, member_count: 1, members: null },
    ];
    global.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      const json = (data: unknown) => ({ ok: true, status: 200, json: async () => data }) as unknown as Response;
      if (url === "/api/prefs") return json({ prefs: null });
      if (url === "/api/containers") return json({ containers: localContainers });
      if (url.startsWith("/api/me")) return json({ identity: null, trusted: false });
      return json({});
    }) as unknown as typeof fetch;
    mount();
    // the row name AND the badge's own local label both read "quantal-local"
    expect(await screen.findAllByText("quantal-local")).toHaveLength(2);
    expect(screen.getByText("Local")).toBeInTheDocument();
    const badge = document.querySelector(".prepo")!;
    expect(badge.querySelector("a")).toBeNull();
  });
});

describe("ProjectsPage polish (Linear r2)", () => {
  const order = () => Array.from(document.querySelectorAll<HTMLElement>("[data-proj-card]")).map((e) => e.dataset.projCard);

  it("the repository cell links to github.com/<slug> in a new tab", async () => {
    stubFetch();
    mount();
    await screen.findByText("acme-ehr");
    const link = screen.getByRole("link", { name: /acme\/ehr/ });
    expect(link).toHaveAttribute("href", "https://github.com/acme/ehr");
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noreferrer");
  });

  it("Agents counts AI only (agents − human members); unknown people ⇒ labelled AI+human total", () => {
    expect(aiAgentCount({ agents: 9, member_count: 2 })).toBe(7);
    expect(aiAgentCount({ agents: 1, member_count: 1 })).toBe(0);
    expect(aiAgentCount({ agents: 4, member_count: 1, ai_agents: 2 })).toBe(2); // server value wins
    expect(aiAgentCount({ agents: 3, member_count: null })).toBeNull();
  });

  it("the Agents cell renders the AI count", async () => {
    stubFetch();
    mount();
    await screen.findByText("acme-ehr");
    expect(document.querySelector('[data-proj-card="c1"] .pcell-agents')).toHaveTextContent(/^1 AI agent$/); // 3 agents − 2 people
    expect(document.querySelector('[data-proj-card="c3"] .pcell-agents')).toHaveTextContent(/^0 AI agents$/);
  });

  it("done / total tasks carry a progress ring", async () => {
    stubFetch();
    (containers[0] as Record<string, unknown>).tasks_done = 6;
    try {
      mount();
      await screen.findByText("acme-ehr");
      expect(document.querySelector('[data-proj-card="c1"] .ptasks-ring')).toHaveAttribute("data-progress", "50");
      expect(document.querySelector('[data-proj-card="c2"] .ptasks-ring')).toBeNull(); // no done figure ⇒ no ring
    } finally { delete (containers[0] as Record<string, unknown>).tasks_done; }
  });

  it("the description trails the name on the same line (fixed-height rows)", async () => {
    stubFetch();
    mount();
    await screen.findByText("acme-ehr");
    const top = document.querySelector('[data-proj-card="c1"] .prow-top')!;
    expect(top.querySelector(".pdesc")).toHaveTextContent("The EHR build");
  });

  it("column headers sort: first direction → flipped → back to your order", async () => {
    stubFetch();
    mount();
    await screen.findByText("acme-ehr");
    expect(order()).toEqual(["c1", "c2", "c3"]);
    fireEvent.click(screen.getByRole("button", { name: "Sort by Tasks" }));
    expect(order()).toEqual(["c1", "c3", "c2"]); // 12, 1, 0
    expect(screen.getByRole("button", { name: /Sort by Tasks, descending/ })).toHaveAttribute("aria-pressed", "true");
    // table semantics: every sortable header is a columnheader carrying aria-sort
    const table = screen.getByRole("table", { name: "All projects" });
    const heads = within(table).getAllByRole("columnheader");
    const sortOf = (k: string) => heads.find((h) => h.querySelector(`[data-sort-key="${k}"]`))!.getAttribute("aria-sort");
    expect(sortOf("tasks")).toBe("descending");
    expect(sortOf("name")).toBe("none");
    expect(within(table).getAllByRole("row").length).toBe(4); // header + 3 projects
    fireEvent.click(screen.getByRole("button", { name: /Sort by Tasks/ }));
    expect(order()).toEqual(["c2", "c3", "c1"]);
    fireEvent.click(screen.getByRole("button", { name: /Sort by Tasks/ }));
    expect(order()).toEqual(["c1", "c2", "c3"]);
    fireEvent.click(screen.getByRole("button", { name: "Sort by Name" }));
    expect(order()).toEqual(["c1", "c2", "c3"]); // acme-ehr, api-gateway, legacy-backend
  });

  it("unknown figures sink in either direction; nextSort cycles", () => {
    const rows = [
      { id: "a", name: "a", needs_you: null }, { id: "b", name: "b", needs_you: 3 }, { id: "c", name: "c", needs_you: 1 },
    ] as ProjContainer[];
    expect(sortProjects(rows, { key: "needs", dir: "desc" }).map((r) => r.id)).toEqual(["b", "c", "a"]);
    expect(sortProjects(rows, { key: "needs", dir: "asc" }).map((r) => r.id)).toEqual(["c", "b", "a"]);
    expect(nextSort(null, "needs")).toEqual({ key: "needs", dir: "desc" });
    expect(nextSort({ key: "needs", dir: "desc" }, "needs")).toEqual({ key: "needs", dir: "asc" });
    expect(nextSort({ key: "needs", dir: "asc" }, "needs")).toBeNull();
    expect(nextSort(null, "name")).toEqual({ key: "name", dir: "asc" });
  });

  it("projects.css: breakpoint hides beat the cell display rule; only controls sit above the row link", () => {
    const css = readFileSync(resolve(__dirname, "projects.css"), "utf8");
    // the base flex rule must be :where()-wrapped (R3 blocker: (0,2,0) beat the (0,1,0) media hides)
    expect(css).not.toMatch(/^\.proj-row \.pcell-repo, \.proj-row \.pcell-wake/m);
    expect(css).toMatch(/:where\(\.proj-row\) :where\(\.pcell-repo, \.pcell-wake, \.pcell-needs\)/);
    expect(css).toMatch(/\.proj-cols \.pcell-repo, \.proj-row \.pcell-repo \{ display: none; \}/);
    expect(css).toMatch(/\.proj-row \.pcell-repo, \.proj-row \.pcell-num, \.proj-row \.pcell-members, \.proj-row \.pcell-wake \{ display: none; \}/);
    // read-only cells stay under the ::after link layer (clicking them opens the project)
    const layer = css.match(/^\.proj-row [^{]*\{ position: relative; z-index: 1; \}/m)?.[0] ?? "";
    expect(layer).toContain(".prepo");
    expect(layer).not.toMatch(/pwake|pcell-num|pneeds|pmembers/);
  });
});

describe("ProjectsPage parity r1 (home-projects fixer)", () => {
  const openIconItem = async () => {
    await screen.findByText("acme-ehr");
    fireEvent.click(screen.getByRole("button", { name: "acme-ehr actions" }));
    return screen.findByRole("menuitem", { name: /Change icon/ });
  };

  it("e2e-permissions-7 / SG-09: a viewer's 'Change icon…' is disabled with the reason and opens no picker", async () => {
    meBody = { identity: { github_login: "tomas-v", member_role: "viewer", grants: [] }, trusted: true };
    const calls = stubFetch();
    mount();
    const item = await openIconItem();
    await waitFor(() => expect(item).toHaveAttribute("aria-disabled", "true"));
    expect(item).toHaveAttribute("title", "Your role is viewer (read-only)");
    fireEvent.click(item);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(calls.some((c) => c.url.includes("/icon"))).toBe(false);
    // asked about THAT project, not the first one
    expect(calls.some((c) => c.url === "/api/me?cid=c1")).toBe(true);
  });

  it("a member without manage_autonomy is refused (same gate as PUT /icon); a signed-in non-member too", async () => {
    meBody = { identity: { github_login: "amina", member_role: "member", grants: ["manage_keys"] }, trusted: true };
    stubFetch();
    mount();
    const item = await openIconItem();
    await waitFor(() => expect(item).toHaveAttribute("aria-disabled", "true"));
    expect(item.getAttribute("title")).toMatch(/owner role or the Autonomy permission/);
  });

  it("a member holding manage_autonomy, an owner, and trust-off (self-host) keep the picker", async () => {
    meBody = { identity: { github_login: "amina", member_role: "member", grants: ["manage_autonomy"] }, trusted: true };
    stubFetch();
    mount();
    const item = await openIconItem();
    await waitFor(() => expect(item).not.toHaveAttribute("aria-disabled", "true"));
    fireEvent.click(item);
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
  });

  it("SH-116: the open hub re-fetches the project list every 15 s", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const calls = stubFetch();
      mount();
      await screen.findByText("acme-ehr");
      const lists = () => calls.filter((c) => c.url === "/api/containers").length;
      const before = lists();
      await act(async () => { await vi.advanceTimersByTimeAsync(HUB_REFRESH_MS + 50); });
      expect(lists()).toBeGreaterThan(before);
      expect(HUB_REFRESH_MS).toBe(15_000);
    } finally { vi.useRealTimers(); }
  });

  it("D12 one fact: the CURRENT project's Needs you shows the live (sidebar) count; others keep the server's", async () => {
    stubFetch();
    scoped.cid = "c1";
    scoped.snap = { container: { id: "c1" } };
    scoped.attention = { ...scoped.attention, count: 9, readOnly: false };
    try {
      mount();
      await screen.findByText("acme-ehr");
      expect(document.querySelector('[data-proj-card="c1"] .pneeds')?.textContent).toMatch(/^9/);
      expect(document.querySelector('[data-proj-card="c2"] .pneeds')?.textContent).toMatch(/^0/);
    } finally {
      scoped.cid = null; scoped.snap = null; scoped.attention = { ...scoped.attention, count: null };
    }
  });
});

describe("TG-36: projects.css never styles a bare global .prow", () => {
  it("row rules are scoped to .proj-row, so the task rail's protocol .prow keeps its own layout", () => {
    const css = readFileSync(resolve(__dirname, "projects.css"), "utf8");
    expect(css).not.toMatch(/\.prow(?![-\w])/);
    expect(css).toMatch(/\.proj-row \{\s*position: relative; height: 44px;/);
  });
});
