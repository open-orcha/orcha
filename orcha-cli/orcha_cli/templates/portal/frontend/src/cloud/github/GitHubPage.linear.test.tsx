/**
 * GitHubPage — Linear layout (directives D5–D12):
 *  - grouping helpers (PRs by GitHub merge state, issues by Orcha tracking)
 *  - one-line rows with a tracked-task chip carrying the task's real status
 *  - detail = Linear issue: header row (h1) + pager, Orcha dispatch card,
 *    Activity timeline, PropertyRail with explicit empty values
 *  - PR server filters live in a popover; active ones show as removable chips
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "../../components/ui";
import { SnapshotProvider } from "../../state/SnapshotProvider";
import { GitHubPage, groupIssues, groupPulls, tightMd } from "./GitHubPage";

const TASK_ID = "00000000-0000-4000-8000-000000000301";
const SNAP = {
  container: { id: "c1", name: "Acme", status: "active", autonomy_level: "plan" },
  agents: [{ id: "h1", alias: "kedar", kind: "human", status: "idle" }],
  tasks: [{ id: TASK_ID, title: "Ship OAuth", status: "in_progress", assignees: [] }],
  requests: [],
};
const PULLS = {
  available: true,
  repo: "acme/app",
  pulls: [
    { number: 12, title: "Add OAuth flow", head: "feat/oauth", draft: false, updated_at: "2026-08-01T00:00:00Z", requested_reviewers: [], checks: { passed: 1, total: 1 }, mergeable_state: "clean", tracked_task_id: TASK_ID, author_login: "kedar" },
    { number: 13, title: "Remove hash routing", head: "refactor/no-hash", draft: false, updated_at: "2026-08-01T00:00:00Z", requested_reviewers: [], checks: { total: 0 }, mergeable_state: "dirty", tracked_task_id: null },
    { number: 14, title: "WIP export", head: "feat/export", draft: true, updated_at: "2026-08-01T00:00:00Z", requested_reviewers: [], checks: { total: 0 }, mergeable_state: "draft", tracked_task_id: null },
  ],
};
const PULL_DETAIL = (n: number) => ({
  available: true,
  repo: "acme/app",
  pull: {
    ...PULLS.pulls.find((p) => p.number === n)!, state: "open", base: "main", body_markdown: "## Summary\n\n- one\n- two",
    html_url: "https://github.com/acme/app/pull/" + n, created_at: "2026-07-30T00:00:00Z", assignees: [], requested_reviewers: [],
    comments_count: 1, review_comments_count: 0,
    comments: [{ author_login: "rev", body_markdown: "Looks good", created_at: "2026-08-01T00:00:00Z" }],
    checks: { passed: 0, total: 0, runs: [] }, files: { count: 0, items: [] },
  },
});

let lastSearch = "";
function LocationProbe() {
  lastSearch = useLocation().search;
  return null;
}
function stub() {
  global.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    const m = url.match(/\/github\/pulls\/(\d+)$/);
    const body = m ? PULL_DETAIL(Number(m[1]))
      : url.startsWith("/api/containers/c1/github/pulls") ? PULLS
      : url.startsWith("/api/containers/c1/github/issues") ? { available: true, repo: "acme/app", issues: [] }
      : url.startsWith("/api/me") ? { identity: { agent_id: "h1", github_login: "kedar" } }
      : url === "/api/containers/c1/github" ? { repo: "acme/app" }
      : url.startsWith("/api/containers/c1") ? SNAP
      : url === "/api/containers" ? [{ id: "c1", status: "active" }]
      : {};
    return { ok: true, status: 200, json: async () => body } as unknown as Response;
  }) as unknown as typeof fetch;
}
function mount(entry = "/github?tab=pulls") {
  return render(
    <ToastProvider>
      <SnapshotProvider>
        <MemoryRouter initialEntries={[entry]}>
          <GitHubPage />
          <LocationProbe />
        </MemoryRouter>
      </SnapshotProvider>
    </ToastProvider>,
  );
}

describe("GitHub grouping + markdown helpers", () => {
  it("groups PRs by GitHub's merge state, needs-attention first and drafts last", () => {
    const g = groupPulls([
      { mergeable_state: "clean" }, { mergeable_state: "dirty" }, { mergeable_state: "clean", draft: true },
      { mergeable_state: "blocked" }, { mergeable_state: null },
    ]);
    expect(g.map((x) => [x.title, x.items.length])).toEqual([["Conflicts", 1], ["Blocked", 1], ["Mergeable", 1], ["Unknown", 1], ["Draft", 1]]);
    expect(g[0].tone).toBe("danger");
  });
  it("groups issues into tracked / not tracked and omits empty groups", () => {
    const rows = [{ n: 1, t: true }, { n: 2, t: false }, { n: 3, t: false }];
    expect(groupIssues(rows, (r) => r.t).map((g) => [g.id, g.items.length])).toEqual([["tracked", 1], ["untracked", 2]]);
    expect(groupIssues([{ t: false }], (r) => r.t).map((g) => g.id)).toEqual(["untracked"]);
  });
  it("tightMd drops the newline before a block span and keeps ONE paragraph break after a list", () => {
    const html = '<span class="md-h">A</span>\n<span class="md-li">x</span>\n<span class="md-li">y</span>\n\nPara\n\nNext';
    // the list already ends its line, so "\n\n" after it would paint two blank lines
    expect(tightMd(html)).toBe('<span class="md-h">A</span><span class="md-li">x</span><span class="md-li">y</span>\nPara\n\nNext');
  });
});

describe("GitHubPage Linear list + detail", () => {
  beforeEach(() => { localStorage.clear(); lastSearch = ""; });
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  it("a tracked PR row shows the task title with its status glyph, and no row action", async () => {
    stub();
    mount();
    await screen.findByText("Add OAuth flow");
    const row = await waitFor(() => {
      const r = document.querySelector('[data-gh-row="pull:12"]')!;
      expect(r.querySelector(".gh-task-chip")?.textContent).toBe("Ship OAuth");
      return r;
    });
    expect(row.querySelector(".gh-task-chip .v2-si")).not.toBeNull(); // the task's real status glyph
    expect(row.querySelector(".gh-task-chip")!.getAttribute("title")).toContain("In progress");
    expect(row.querySelector(".gh-actions")).toBeNull();
    // an untracked row keeps the hover-revealed Fix split
    expect(document.querySelector('[data-gh-row="pull:13"] .gh-actions .gh-start')).not.toBeNull();
    // bands in merge-state order: Conflicts, Mergeable, Draft
    const groups = Array.from(document.querySelectorAll(".v2-listgroup")).map((g) => g.getAttribute("data-group"));
    expect(groups).toEqual(["pull-conflicts", "pull-mergeable", "pull-draft"]);
  });

  it("detail from the list: header h1 + pager in list order, Embodent card, timeline, rail empties", async () => {
    stub();
    mount();
    await screen.findByText("Remove hash routing");
    fireEvent.click(screen.getByText("Remove hash routing"));
    expect(await screen.findByRole("heading", { level: 1, name: "Remove hash routing" })).toBeInTheDocument();
    // pager follows the grouped list order: Conflicts(#13) is first of 3
    expect(screen.getByRole("group", { name: "pull request 1 of 3" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Next pull request" }));
    await waitFor(() => expect(lastSearch).toContain("pr=12"));
    expect(await screen.findByRole("heading", { level: 1, name: "Add OAuth flow" })).toBeInTheDocument();
    // tracked → the Orcha card shows the task chip instead of the Fix action
    const card = screen.getByRole("region", { name: "Embodent" });
    expect(within(card).getByText("Tracked as a task")).toBeInTheDocument();
    expect(within(card).queryByRole("button", { name: /Dispatch an agent/ })).toBeNull();
    // activity: opened event + the comment card
    const tl = screen.getByRole("list", { name: "Activity" });
    expect(within(tl).getByText(/opened this pull request/)).toBeInTheDocument();
    expect(within(tl).getByText("Looks good")).toBeInTheDocument();
    // rail: explicit empty values, never a blank cell
    const rail = screen.getByRole("complementary", { name: "Pull request properties" });
    expect(within(rail).getByText("No reviewer")).toBeInTheDocument();
    expect(within(rail).getByText("No assignee")).toBeInTheDocument();
    expect(within(rail).getByText("No checks")).toBeInTheDocument();
    expect(within(rail).getByText("Mergeable")).toBeInTheDocument();
    // Open on GitHub is a real link (circle button)
    expect(screen.getByRole("link", { name: "Open on GitHub" }).getAttribute("href")).toBe("https://github.com/acme/app/pull/12");
  });

  it("an active author filter shows as a removable chip in the toolbar", async () => {
    stub();
    mount();
    await screen.findByText("Add OAuth flow");
    fireEvent.click(screen.getByRole("button", { name: "Pull request filters" }));
    fireEvent.change(screen.getByPlaceholderText("Author…"), { target: { value: "kedar" } });
    const chip = await screen.findByRole("button", { name: "Remove filter: author kedar" });
    expect(screen.getByRole("button", { name: "Pull request filters" }).textContent).toContain("1");
    fireEvent.click(chip);
    await waitFor(() => expect(screen.queryByRole("button", { name: "Remove filter: author kedar" })).toBeNull());
  });
});
