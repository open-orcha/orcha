/**
 * GitHubPage V2 screen-quality fixes (fix round 1):
 *  - an HTTP 403 that isn't a rate limit is a no-access state (not "rate limit")
 *  - a tracked task shows its TITLE, never the raw uuid
 *  - checks omitted from the batch answer resolve to "No checks" (no endless "checks…")
 *  - merge state is labelled in GitHub's terms, never "Checks passed"
 *  - with no repo bound, the tabs/filters/Browse chrome is hidden
 *  - PR detail shows comments + counts; no duplicated in-page crumb
 */
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "../../components/ui";
import { SnapshotProvider } from "../../state/SnapshotProvider";
import { GitHubPage, startFailureMessage } from "./GitHubPage";
import { classifyDetailError, classifyError, fillMissingChecks, labelDot, mergeStateLabel, trackedTaskLabel } from "./ghlib";

const TASK_ID = "00000000-0000-4000-8000-000000000201";
const SNAP = {
  container: { id: "c1", name: "Acme", status: "active", autonomy_level: "plan" },
  agents: [{ id: "h1", alias: "kedar", kind: "human", status: "idle" }],
  tasks: [{ id: TASK_ID, title: "Build the icon rail", status: "in_progress", assignees: [] }],
  requests: [],
};
const ISSUES = {
  available: true,
  repo: "acme/app",
  issues: [{ number: 7, title: "Fix login bug", labels: [{ name: "bug", color: "d73a4a" }], assignee: null, updated_at: "2026-08-01T00:00:00Z", tracked_task_id: TASK_ID }],
};
const PULLS = {
  available: true,
  repo: "acme/app",
  pulls: [
    { number: 12, title: "Add OAuth flow", head: "feat/oauth", draft: false, updated_at: "2026-08-01T00:00:00Z", requested_reviewers: [], checks: null, mergeable_state: "clean", tracked_task_id: null },
    { number: 13, title: "Remove hash routing", head: "refactor/no-hash", draft: false, updated_at: "2026-08-01T00:00:00Z", requested_reviewers: [], checks: null, mergeable_state: "dirty", tracked_task_id: null },
  ],
};

type Route = (url: string) => { status?: number; body: unknown } | null;
function stub(route: Route) {
  global.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    const hit = route(url);
    const status = hit?.status ?? 200;
    const body = hit ? hit.body
      : url.startsWith("/api/me") ? { identity: { agent_id: "h1", github_login: "kedar" } }
      : url === "/api/containers/c1/github" ? { repo: "acme/app" }
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

describe("ghlib V2 helpers", () => {
  it("classifies a permissions 403 as no_access and a rate-limit 403/429 as rate_limited", () => {
    expect(classifyError(403, { detail: "Resource not accessible by personal access token (repo scope missing)." }).kind).toBe("no_access");
    expect(classifyError(403, { detail: "API rate limit exceeded for user" }).kind).toBe("rate_limited");
    expect(classifyError(403, { reason: "rate_limited" }).kind).toBe("rate_limited");
    expect(classifyError(429, null).kind).toBe("rate_limited");
    expect(classifyDetailError(403, { detail: "Must have admin rights" }).kind).toBe("no_access");
  });
  it("labels mergeable_state in GitHub's terms, never 'Checks passed'", () => {
    expect(mergeStateLabel("clean").label).toBe("Mergeable");
    expect(mergeStateLabel("blocked").label).toBe("Blocked");
    expect(mergeStateLabel("dirty")).toMatchObject({ label: "Conflicts", tone: "danger" });
    expect(mergeStateLabel("unstable").label).toBe("Unstable");
    expect(mergeStateLabel("clean", true).label).toBe("Draft");
    expect(mergeStateLabel(null).label).toBe("Unknown");
  });
  it("resolves a tracked task to its title, with a neutral fallback (never the id)", () => {
    expect(trackedTaskLabel("t1", [{ id: "t1", title: "Ship it" }])).toBe("Ship it");
    expect(trackedTaskLabel("t2", [{ id: "t1", title: "Ship it" }])).toBe("Tracked task");
  });
  it("fills numbers missing from a checks answer with an empty rollup", () => {
    const out = fillMissingChecks([1, 2], { "1": { passed: 3, total: 3 } });
    expect(out[1]).toMatchObject({ passed: 3 });
    expect(out[2]).toMatchObject({ total: 0 });
  });
  it("label dots use the sanitized repo color or the fallback palette", () => {
    expect(labelDot({ name: "bug", color: "D73A4A" }).color).toBe("#d73a4a");
    expect(labelDot({ name: "x", color: "red;}" }).color).toMatch(/^#[0-9a-f]{6}$/);
  });
  it("start failures read as human copy, never a raw status + server string", () => {
    const m = startFailureMessage("issue", 228, 404, "mock gh start");
    expect(m).toBe("Couldn't start a task for issue #228: this item or the project's GitHub connection wasn't found.");
    expect(m).not.toContain("404");
    expect(startFailureMessage("pull", 3, 400, "mock")).toContain("the request was rejected");
  });
});

describe("GitHubPage V2 fixes", () => {
  beforeEach(() => { localStorage.clear(); });
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  it("an HTTP 403 without a rate-limit reason renders the no-access state", async () => {
    stub((url) => (url.startsWith("/api/containers/c1/github/issues")
      ? { status: 403, body: { detail: "Resource not accessible by personal access token (repo scope missing)." } }
      : null));
    mount();
    expect(await screen.findByText("GitHub token can't access acme/app")).toBeInTheDocument();
    expect(screen.queryByText(/rate limit/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/retries automatically/i)).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Check GitHub access" }).className).toContain("v2-btn-primary");
  });

  it("a tracked issue shows the task title, not the uuid", async () => {
    stub((url) => (url.startsWith("/api/containers/c1/github/issues") ? { body: ISSUES } : null));
    mount();
    await screen.findByText("Fix login bug");
    const chip = await waitFor(() => {
      const el = document.querySelector('[data-gh-row="issue:7"] .gh-task-chip');
      expect(el?.textContent).toBe("Build the icon rail");
      return el!;
    });
    expect(chip.textContent).not.toContain(TASK_ID);
    expect(chip.getAttribute("title")).toContain("Build the icon rail");
  });

  it("checks omitted by the batch answer read 'No checks'; merge chips use GitHub's terms", async () => {
    stub((url) => {
      if (url.startsWith("/api/containers/c1/github/pulls")) return { body: PULLS };
      if (url.startsWith("/api/containers/c1/github/checks")) return { body: { available: true, checks: { "12": { passed: 2, failing: 0, pending: 1, total: 3 } } } };
      return null;
    });
    mount("/github?tab=pulls");
    expect(await screen.findByText("1 pending")).toBeInTheDocument();
    await waitFor(() => expect(document.querySelector('[data-gh-row="pull:13"] .gh-checks')!.textContent).toBe("No checks"));
    expect(screen.queryByText("checks…")).not.toBeInTheDocument();
    expect(screen.getByText("Mergeable")).toBeInTheDocument();
    expect(screen.getByText("Conflicts")).toBeInTheDocument();
    expect(screen.queryByText("Checks passed")).not.toBeInTheDocument();
  });

  it("with no repo bound, the list chrome is hidden and Connect repo is the primary action", async () => {
    stub((url) => {
      if (url === "/api/containers/c1/github") return { body: { repo: null } };
      if (url.startsWith("/api/containers/c1/github/issues")) return { body: { available: false, reason: "repo_not_connected" } };
      return null;
    });
    mount();
    // same shared EmptyState + wording as Code Space's not-connected state
    expect(await screen.findByText("No repository connected")).toBeInTheDocument();
    expect(document.querySelector(".v2-empty")).not.toBeNull();
    expect(screen.queryByRole("radio", { name: /^Issues/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /browse files/i })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Connect repo" }).className).toContain("v2-btn-primary");
    expect(document.querySelector(".repo-not-connected")).not.toBeNull();
  });

  it("PR detail renders comments + counts and no in-page crumb", async () => {
    stub((url) => {
      if (url.startsWith("/api/containers/c1/github/pulls/12")) {
        return { body: { available: true, repo: "acme/app", pull: {
          ...PULLS.pulls[0], state: "open", base: "main", body_markdown: "Adds OAuth", html_url: "https://github.com/acme/app/pull/12",
          comments_count: 3, review_comments_count: 2,
          comments: [{ author_login: "rev", body_markdown: "Looks good", created_at: "2026-08-01T00:00:00Z" }],
          checks: { passed: 1, total: 1, runs: [] }, files: { count: 0, items: [] },
        } } };
      }
      return null;
    });
    mount("/github?pr=12");
    expect(await screen.findByRole("heading", { name: /Add OAuth flow/ })).toBeInTheDocument();
    expect(screen.getByText("Looks good")).toBeInTheDocument();
    expect(screen.getByText(/Showing 1 of 3 comments · 2 review comments/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /View all on GitHub/ }).getAttribute("href")).toBe("https://github.com/acme/app/pull/12");
    expect(document.querySelector(".gh-crumb")).toBeNull();
    // the view's single primary action is Fix
    expect(screen.getByRole("button", { name: "Dispatch an agent to fix checks/review feedback on this PR" }).className).toContain("v2-btn-primary");
  });
});
