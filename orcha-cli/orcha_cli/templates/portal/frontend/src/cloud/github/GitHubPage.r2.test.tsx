/**
 * GitHubPage polish round 2 (screen review r2):
 *  - issue rows carry at most 2 chips (linked task + 1 label, then +N)
 *  - the "Tracked in Orcha" band glyph is neutral, not accent
 *  - detail header: ↗ Open on GitHub is always the first action (issues and
 *    PRs, falling back to the canonical URL from the repo slug); PRs add </>
 *  - phone-width toolbar: a ⋯ holds Browse files / Change repo / Open on GitHub
 *  - one shared not-connected state (RepoNotConnected) with Code Space
 */
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "../../components/ui";
import { SnapshotProvider } from "../../state/SnapshotProvider";
import { GitHubPage, groupIssues } from "./GitHubPage";
import { REPO_NOT_CONNECTED_CTA, REPO_NOT_CONNECTED_TITLE, RepoNotConnected } from "./RepoNotConnected";

const TASK_ID = "00000000-0000-4000-8000-000000000201";
const SNAP = {
  container: { id: "c1", name: "Acme", status: "active", autonomy_level: "plan" },
  agents: [{ id: "h1", alias: "kedar", kind: "human", status: "idle" }],
  tasks: [{ id: TASK_ID, title: "Build the icon rail", status: "in_progress", assignees: [] }],
  requests: [],
};
const LABELS = [{ name: "bug", color: "d73a4a" }, { name: "design", color: "0e8a16" }, { name: "v2", color: "5319e7" }];
const ISSUES = {
  available: true,
  repo: "acme/app",
  issues: [
    { number: 7, title: "Fix login bug", labels: LABELS, assignee: null, updated_at: "2026-08-01T00:00:00Z", tracked_task_id: TASK_ID },
    { number: 8, title: "Untracked with labels", labels: LABELS, assignee: null, updated_at: "2026-08-01T00:00:00Z", tracked_task_id: null },
  ],
};

type Route = (url: string) => { status?: number; body: unknown } | null;
function stub(route: Route = () => null) {
  global.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    const hit = route(url);
    const status = hit?.status ?? 200;
    const body = hit ? hit.body
      : url.startsWith("/api/me") ? { identity: { agent_id: "h1", github_login: "kedar" } }
      : url === "/api/containers/c1/github" ? { repo: "acme/app" }
      : url.startsWith("/api/containers/c1/github/issues?") || url === "/api/containers/c1/github/issues" ? ISSUES
      : url.startsWith("/api/containers/c1/github/pulls") && !/pulls\/\d/.test(url) ? { available: true, repo: "acme/app", pulls: [] }
      : url.startsWith("/api/containers/c1") ? SNAP
      : url === "/api/containers" ? [{ id: "c1", status: "active" }]
      : {};
    return { ok: status < 400, status, json: async () => body } as unknown as Response;
  }) as unknown as typeof fetch;
}
function mount(entry = "/github") {
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
const rowOf = (n: number) => document.querySelector(`[data-gh-row="issue:${n}"]`) as HTMLElement;

describe("GitHub polish r2", () => {
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  it("tracked issue rows show the task chip + 1 label + '+N' (max 2 chips, D12)", async () => {
    stub();
    mount();
    await screen.findByText("Fix login bug");
    const tracked = within(rowOf(7));
    expect(tracked.getByText("Build the icon rail")).toBeInTheDocument();
    expect(rowOf(7).querySelectorAll(".gh-label").length).toBe(1);
    expect(tracked.getByText("+2")).toBeInTheDocument();
    // untracked rows keep 2 labels
    expect(rowOf(8).querySelectorAll(".gh-label").length).toBe(2);
    expect(within(rowOf(8)).getByText("+1")).toBeInTheDocument();
  });

  it("the Tracked in Embodent band uses a neutral glyph (not accent)", () => {
    const g = groupIssues([{ n: 1 }, { n: 2 }], (r) => r.n === 1);
    expect(g[0]).toMatchObject({ id: "tracked", tone: "neutral", glyph: "tracked" });
    expect(g[1]).toMatchObject({ id: "untracked", tone: "ok" });
  });

  it("issue detail: ↗ Open on GitHub falls back to the canonical URL built from the repo slug", async () => {
    stub((url) => (url.startsWith("/api/containers/c1/github/issues/7")
      ? { body: { available: true, repo: "acme/app", issue: { ...ISSUES.issues[0], state: "open", body_markdown: "x", html_url: null, comments: [] } } }
      : null));
    mount("/github?issue=7");
    expect(await screen.findByRole("heading", { name: /Fix login bug/ })).toBeInTheDocument();
    const ext = screen.getByRole("link", { name: "Open on GitHub" });
    expect(ext.getAttribute("href")).toBe("https://github.com/acme/app/issues/7");
    // issues have no Browse head button
    expect(screen.queryByRole("button", { name: /browse files at head/i })).not.toBeInTheDocument();
  });

  it("PR detail: ↗ comes first, </> Browse files at head second", async () => {
    stub((url) => (url.startsWith("/api/containers/c1/github/pulls/12")
      ? { body: { available: true, repo: "acme/app", pull: {
        number: 12, title: "Add OAuth flow", head: "feat/oauth", base: "main", draft: false, state: "open", mergeable_state: "clean",
        updated_at: "2026-08-01T00:00:00Z", requested_reviewers: [], body_markdown: "x", html_url: "https://github.com/acme/app/pull/12",
        comments: [], checks: { passed: 1, total: 1, runs: [] }, files: { count: 0, items: [] },
      } } }
      : null));
    mount("/github?pr=12");
    expect(await screen.findByRole("heading", { name: /Add OAuth flow/ })).toBeInTheDocument();
    const ext = screen.getByRole("link", { name: "Open on GitHub" });
    const browse = screen.getByRole("button", { name: /browse files at head/i });
    expect(ext.getAttribute("href")).toBe("https://github.com/acme/app/pull/12");
    // DOM order: ↗ precedes </>
    expect(ext.compareDocumentPosition(browse) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("the toolbar ⋯ (phone width) offers Browse files, Change repo (with the repo) and Open on GitHub", async () => {
    stub();
    mount();
    await screen.findByText("Fix login bug");
    fireEvent.click(screen.getByRole("button", { name: "Repository actions" }));
    const menu = await screen.findByRole("menu", { name: "Repository actions" });
    expect(within(menu).getByRole("menuitem", { name: /Browse files/ })).toBeInTheDocument();
    const change = within(menu).getByRole("menuitem", { name: /Change repo/ });
    expect(change.textContent).toContain("acme/app");
    expect(within(menu).getByRole("menuitem", { name: /Open on GitHub/ })).toBeInTheDocument();
    fireEvent.click(within(menu).getByRole("menuitem", { name: /Browse files/ }));
    expect(await screen.findByRole("button", { name: /Back to issues/ })).toBeInTheDocument();
  });

  it("RepoNotConnected renders one shared title/body/CTA, as a button or a route link", () => {
    const onConnect = vi.fn();
    render(<MemoryRouter><RepoNotConnected onConnect={onConnect} /></MemoryRouter>);
    expect(screen.getByText(REPO_NOT_CONNECTED_TITLE)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: REPO_NOT_CONNECTED_CTA }));
    expect(onConnect).toHaveBeenCalled();
    cleanup();
    render(<MemoryRouter><RepoNotConnected to="/github?connect=1" /></MemoryRouter>);
    expect(screen.getByRole("link", { name: REPO_NOT_CONNECTED_CTA }).getAttribute("href")).toBe("/github?connect=1");
  });
});
