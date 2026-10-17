/**
 * GitHubPage — screen review r3:
 *  - ↑/↓ and j/k move between list rows (shared roving handler), Enter opens
 *  - empty list = compact EmptyState with a muted active-filters line
 *  - the sibling section pill shows its count without opening that tab
 *  - PR rail head/base branch: tooltip + click-to-copy
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "../../components/ui";
import { SnapshotProvider } from "../../state/SnapshotProvider";
import { GitHubPage } from "./GitHubPage";

const SNAP = {
  container: { id: "c1", name: "Acme", status: "active", autonomy_level: "plan" },
  agents: [{ id: "h1", alias: "kedar", kind: "human", status: "idle" }],
  tasks: [],
  requests: [],
};
const ISSUES = {
  available: true,
  repo: "acme/app",
  issues: [
    { number: 231, title: "Collapsed sidebar rail", labels: [], assignee: null, updated_at: "2026-08-01T00:00:00Z" },
    { number: 228, title: "Model field empty", labels: [], assignee: null, updated_at: "2026-07-31T00:00:00Z" },
    { number: 201, title: "Docs: review protocol", labels: [], assignee: null, updated_at: "2026-07-30T00:00:00Z" },
  ],
};
const HEAD = "feat/a-very-long-branch-name-that-never-fits-in-the-property-rail";
const PULLS = {
  available: true,
  repo: "acme/app",
  pulls: [{ number: 12, title: "Add OAuth flow", head: HEAD, draft: false, updated_at: "2026-08-01T00:00:00Z", requested_reviewers: [], checks: { total: 0 }, mergeable_state: "clean" }],
};
const PULL_DETAIL = {
  available: true,
  repo: "acme/app",
  pull: {
    ...PULLS.pulls[0], state: "open", base: "main", body_markdown: "", html_url: "https://github.com/acme/app/pull/12",
    created_at: "2026-07-30T00:00:00Z", assignees: [], comments_count: 0, review_comments_count: 0, comments: [],
    checks: { passed: 0, total: 0, runs: [] }, files: { count: 0, items: [] },
  },
};

let issues: typeof ISSUES = ISSUES;
let lastSearch = "";
function LocationProbe() {
  lastSearch = useLocation().search;
  return null;
}
function stub() {
  global.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    const body = /\/github\/pulls\/12$/.test(url) ? PULL_DETAIL
      : url.startsWith("/api/containers/c1/github/pulls") ? PULLS
      : url.startsWith("/api/containers/c1/github/issues") ? issues
      : url.startsWith("/api/me") ? { identity: { agent_id: "h1", github_login: "kedar" } }
      : url === "/api/containers/c1/github" ? { repo: "acme/app" }
      : url.startsWith("/api/containers/c1") ? SNAP
      : url === "/api/containers" ? [{ id: "c1", status: "active" }]
      : {};
    return { ok: true, status: 200, json: async () => body } as unknown as Response;
  }) as unknown as typeof fetch;
}
function mount(entry = "/github") {
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
const row = (n: number) => document.querySelector<HTMLElement>(`[data-gh-row="issue:${n}"]`)!;

describe("GitHubPage r3", () => {
  beforeEach(() => { issues = ISSUES; stub(); });
  afterEach(() => { cleanup(); vi.restoreAllMocks(); try { localStorage.clear(); } catch { /* ignore */ } });

  it("↓ from #231 focuses #228, j/k move too, and Enter opens issue=228", async () => {
    mount();
    await screen.findByText("Collapsed sidebar rail");
    row(231).focus();
    fireEvent.keyDown(row(231), { key: "ArrowDown" });
    expect(document.activeElement).toBe(row(228));
    fireEvent.keyDown(row(228), { key: "j" });
    expect(document.activeElement).toBe(row(201));
    fireEvent.keyDown(row(201), { key: "k" });
    expect(document.activeElement).toBe(row(228));
    fireEvent.keyDown(row(228), { key: "Enter" });
    await waitFor(() => expect(lastSearch).toContain("issue=228"));
  });

  it("skips rows in a collapsed group", async () => {
    mount();
    await screen.findByText("Collapsed sidebar rail");
    const toggle = document.querySelector<HTMLElement>(".v2-group-toggle");
    expect(toggle).not.toBeNull();
    fireEvent.click(toggle!);
    const reachable = Array.from(document.querySelectorAll<HTMLElement>("[data-gh-row]")).filter((r) => !r.closest("[hidden]"));
    expect(reachable).toHaveLength(0);
  });

  it("an empty list is the compact EmptyState naming the active filters", async () => {
    issues = { ...ISSUES, issues: [] };
    mount();
    const empty = await screen.findByText("No open issues");
    const box = empty.closest(".v2-empty-compact") as HTMLElement;
    expect(box).not.toBeNull();
    expect(box.querySelector(".v2-empty-icon svg")).not.toBeNull();
    expect(within(box).getByText("Filters: Open")).toBeInTheDocument();
  });

  it("shows the Pull requests count without opening that tab", async () => {
    mount();
    await screen.findByText("Collapsed sidebar rail");
    const pills = document.querySelector(".gh-kind-pills") as HTMLElement;
    await waitFor(() => {
      const pr = within(pills).getByText("Pull requests").closest("button") as HTMLElement;
      expect(pr.textContent).toContain("1");
    });
  });

  it("the PR rail head branch has the full name as a tooltip and copies on click", async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    mount("/github?pr=12");
    const btn = await screen.findByRole("button", { name: "Copy branch name " + HEAD });
    expect(btn.getAttribute("title")).toContain(HEAD);
    fireEvent.click(btn);
    expect(writeText).toHaveBeenCalledWith(HEAD);
    expect(await screen.findByText("Branch name copied")).toBeInTheDocument();
  });
});
