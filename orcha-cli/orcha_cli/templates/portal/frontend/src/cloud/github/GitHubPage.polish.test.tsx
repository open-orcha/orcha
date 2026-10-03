/**
 * GitHubPage — Linear polish round 1:
 *  - floating menus (Assign to / Fix info) are placed from their MEASURED size
 *    and clamped inside the viewport (never clipped at the right edge)
 *  - D8 glyph semantics: Blocked is red (danger), Conflicts no longer reuses
 *    the failed ✕ or the cancelled slash
 *  - one search placeholder for both tabs; the filter circle button is always
 *    present (Issues: client-side label / assignee facets)
 *  - PR detail: deep link still gets the "N / M ↑↓" pager, a ⋯ menu, and the
 *    Checks tab count matches the rows it lists
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "../../components/ui";
import { SnapshotProvider } from "../../state/SnapshotProvider";
import { checksTabCount, GitHubPage, groupPulls, placeFloating } from "./GitHubPage";
import { issueFacets, matchesIssuesFilter, UNASSIGNED } from "./ghlib";

const SNAP = {
  container: { id: "c1", name: "Acme", status: "active", autonomy_level: "plan" },
  agents: [{ id: "a1", alias: "infrastructure-and-deployment-specialist", kind: "ai", status: "idle" }],
  tasks: [],
  requests: [],
};
const ISSUES = {
  available: true,
  repo: "acme/app",
  issues: [
    { number: 1, title: "Login breaks", labels: [{ name: "bug", color: "d73a4a" }], assignee: "kedar", updated_at: "2026-08-01T00:00:00Z" },
    { number: 2, title: "Docs typo", labels: [{ name: "docs", color: "0075ca" }], assignee: null, updated_at: "2026-08-01T00:00:00Z" },
    { number: 3, title: "Crash on save", labels: [{ name: "bug", color: "d73a4a" }], assignee: null, updated_at: "2026-08-01T00:00:00Z" },
  ],
};
const PULLS = {
  available: true,
  repo: "acme/app",
  pulls: [
    { number: 12, title: "Add OAuth flow", head: "feat/oauth", updated_at: "2026-08-01T00:00:00Z", requested_reviewers: [], checks: { total: 0 }, mergeable_state: "clean" },
    { number: 13, title: "Remove hash routing", head: "refactor/no-hash", updated_at: "2026-08-01T00:00:00Z", requested_reviewers: [], checks: { total: 0 }, mergeable_state: "blocked" },
  ],
};
const PULL_DETAIL = (n: number) => ({
  available: true,
  repo: "acme/app",
  pull: {
    ...PULLS.pulls.find((p) => p.number === n)!, state: "open", base: "main", body_markdown: "Body",
    html_url: "https://github.com/acme/app/pull/" + n, created_at: "2026-07-30T00:00:00Z", assignees: [], requested_reviewers: [],
    comments_count: 0, review_comments_count: 0, comments: [],
    // the rollup counts 7 checks but GitHub only returned 2 runs
    checks: { passed: 5, failing: 2, total: 7, runs: [
      { name: "build", status: "completed", conclusion: "success" },
      { name: "lint", status: "completed", conclusion: "failure" },
    ] },
    files: { count: 0, items: [] },
  },
});

function stub() {
  global.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    const m = url.match(/\/github\/pulls\/(\d+)$/);
    const body = m ? PULL_DETAIL(Number(m[1]))
      : url.startsWith("/api/containers/c1/github/pulls") ? PULLS
      : url.startsWith("/api/containers/c1/github/issues") ? ISSUES
      : url.startsWith("/api/me") ? { identity: { agent_id: "h1", github_login: "kedar" } }
      : url === "/api/containers/c1/github" ? { repo: "acme/app" }
      : url.startsWith("/api/containers/c1") ? SNAP
      : url === "/api/containers" ? [{ id: "c1", status: "active" }]
      : {};
    return { ok: true, status: 200, json: async () => body } as unknown as Response;
  }) as unknown as typeof fetch;
}
function mount(entry: string) {
  return render(
    <ToastProvider>
      <SnapshotProvider>
        <MemoryRouter initialEntries={[entry]}>
          <GitHubPage />
        </MemoryRouter>
      </SnapshotProvider>
    </ToastProvider>,
  );
}

describe("placeFloating", () => {
  it("right-aligns under the anchor and never runs past the right edge", () => {
    // anchor hugging the right edge of a 1440 window; a 300px menu
    const p = placeFloating({ top: 230, bottom: 258, left: 1390, right: 1414 }, 300, 280, 1440, 900);
    expect(p.left + 300).toBeLessThanOrEqual(1440 - 8);
    expect(p.top).toBe(264);
  });
  it("clamps to 8px on the left on a narrow viewport", () => {
    expect(placeFloating({ top: 10, bottom: 30, left: 20, right: 60 }, 320, 100, 390, 844).left).toBe(8);
  });
  it("flips above the anchor when it would overflow the bottom", () => {
    const p = placeFloating({ top: 800, bottom: 828, left: 900, right: 1000 }, 240, 280, 1440, 900);
    expect(p.top).toBe(800 - 280 - 6);
  });
});

describe("D8 merge-state glyphs + checks count helpers", () => {
  it("Blocked is red (danger), not the amber warning tone", () => {
    const g = groupPulls([{ mergeable_state: "blocked" }, { mergeable_state: "dirty" }]);
    expect(g.map((x) => [x.title, x.tone, x.glyph])).toEqual([["Conflicts", "danger", "conflict"], ["Blocked", "danger", "blocked"]]);
  });
  it("the Checks tab count is the number of rows listed, not the rollup total", () => {
    expect(checksTabCount({ total: 7, passed: 5, failing: 2, runs: [{ name: "a" }, { name: "b" }, { name: "c" }] })).toBe(3);
    expect(checksTabCount({ total: 4, passed: 4 })).toBe(4);
    expect(checksTabCount({ total: 0 })).toBeNull();
  });
});

describe("issues label / assignee facets", () => {
  it("counts labels and assignees (incl. no assignee) and filters by them", () => {
    const f = issueFacets(ISSUES.issues);
    expect(f.labels.map((l) => [l.name, l.count])).toEqual([["bug", 2], ["docs", 1]]);
    expect(f.assignees).toEqual([{ login: "kedar", count: 1 }]);
    expect(f.unassigned).toBe(2);
    const rows = ISSUES.issues;
    expect(rows.filter((r) => matchesIssuesFilter(r, { label: "bug", assignee: null })).map((r) => r.number)).toEqual([1, 3]);
    expect(rows.filter((r) => matchesIssuesFilter(r, { label: "bug", assignee: UNASSIGNED })).map((r) => r.number)).toEqual([3]);
  });
});

describe("GitHubPage polish round 1", () => {
  beforeEach(() => { localStorage.clear(); });
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  it("Issues: same search placeholder as PRs, and a filter button whose label facet filters rows + shows a removable chip", async () => {
    stub();
    mount("/github?tab=issues");
    await screen.findByText("Docs typo");
    expect(screen.getByRole("searchbox", { name: "Filter issues" })).toHaveAttribute("placeholder", "Search…");
    fireEvent.click(screen.getByRole("button", { name: "Issue filters" }));
    const pop = await screen.findByRole("dialog", { name: "Issue filters" });
    fireEvent.click(within(within(pop).getByRole("group", { name: "Label" })).getByRole("button", { name: /bug/ }));
    await waitFor(() => expect(screen.queryByText("Docs typo")).toBeNull());
    expect(screen.getByText("Login breaks")).toBeInTheDocument();
    expect(screen.getByText("Crash on save")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Remove filter: label bug" }));
    expect(await screen.findByText("Docs typo")).toBeInTheDocument();
  });

  it("Assign to menu opens with a sentence-case head and inside the viewport", async () => {
    stub();
    mount("/github?tab=issues");
    await screen.findByText("Docs typo");
    fireEvent.click(document.querySelector('[data-gh-row="issue:2"] [data-gh-start-dd]')!);
    const menu = await waitFor(() => { const m = document.getElementById("ghAssignMenu"); expect(m).not.toBeNull(); return m!; });
    expect(within(menu).getByText("Assign to")).toBeInTheDocument();
    const left = parseFloat(menu.style.left);
    expect(left).toBeGreaterThanOrEqual(8);
    expect(left + menu.offsetWidth).toBeLessThanOrEqual(window.innerWidth - 8);
  });

  it("deep-linked PR detail: pager from the list, ⋯ menu, and a Checks tab that counts its rows", async () => {
    stub();
    mount("/github?pr=13");
    expect(await screen.findByRole("heading", { level: 1, name: "Remove hash routing" })).toBeInTheDocument();
    // list loaded in the background → "2 / 2" pager (Blocked group sorts before Mergeable → #13 is 1st)
    expect(await screen.findByRole("group", { name: "pull request 1 of 2" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Pull request actions" }));
    const menu = await screen.findByRole("menu", { name: "Pull request actions" });
    expect(within(menu).getByRole("menuitem", { name: /Copy #13/ })).toBeInTheDocument();
    expect(within(menu).getByRole("menuitem", { name: /Copy GitHub link/ })).toBeInTheDocument();
    fireEvent.keyDown(document, { key: "Escape" });
    const checksTab = screen.getByRole("tab", { name: /Checks/ });
    expect(checksTab.textContent).toContain("2");
    expect(checksTab.textContent).not.toContain("7");
    fireEvent.click(checksTab);
    expect(await screen.findByText(/GitHub reported 7 checks; 2 shown here/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /All checks on GitHub/ }).getAttribute("href")).toBe("https://github.com/acme/app/pull/13/checks");
  });
});

describe("assignee suggestions ignore function words", () => {
  it("an item sharing only 'and' with an agent's role suggests nobody", async () => {
    const { suggestAgents } = await import("./ghlib");
    const agents = [{ id: "a", alias: "infra", kind: "ai", status: "idle", role: "infrastructure and deployment" }] as unknown as Parameters<typeof suggestAgents>[1];
    expect(suggestAgents({ number: 1, title: "race when stale and the worker restarts" }, agents)).toEqual([]);
    expect(suggestAgents({ number: 2, title: "fix deployment script" }, agents).map((r) => r.tokens)).toEqual([["deployment"]]);
  });
});

describe("integration r2: /github?connect=1 deep link", () => {
  beforeEach(() => { stub(); localStorage.clear(); sessionStorage.clear(); });
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });
  it("opens the Connect-repo picker in one step (Code Space's Connect repo)", async () => {
    mount("/github?connect=1");
    expect(await screen.findByText("Connect a repository", {}, { timeout: 4000 })).toBeInTheDocument();
  });
});
