/**
 * GitHubPage V2 (parity G-08, G-02, G-03): recoverable off-states and
 * keyboard access.
 *
 *  - The hub routes answer HTTP 200 + {available:false, reason} for rate
 *    limit / unreachable / not reachable. Before V2 that rendered as an empty
 *    "No open issues." (unknown shown as zero). It must render the real state
 *    with a working Retry.
 *  - A BOUND repo that answers "not connected" is a missing-access state that
 *    deep-links to Settings → GitHub access and offers Change repo.
 *  - A failed checks batch says "Checks unavailable" instead of spinning.
 *  - A failed 60 s refresh keeps the last list but labels it stale (not live).
 *  - Rows open with Enter; the Issues/Pull requests tabs answer arrow keys.
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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
  issues: [{ number: 7, title: "Fix login bug", labels: [], assignee: null, updated_at: "2026-08-01T00:00:00Z", tracked_task_id: null }],
};
const PULLS = {
  available: true,
  repo: "acme/app",
  pulls: [{ number: 12, title: "Add OAuth flow", head: "feat/oauth", draft: false, updated_at: "2026-08-01T00:00:00Z", requested_reviewers: [], checks: null, mergeable_state: "clean", tracked_task_id: null }],
};

type Route = (url: string) => { status?: number; body: unknown } | null;

function stub(route: Route) {
  const calls: string[] = [];
  global.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);
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
  return calls;
}

let lastSearch = "";
function Loc() {
  const l = useLocation();
  lastSearch = l.search;
  return null;
}
function mount(entry = "/github") {
  return render(
    <ToastProvider>
      <SnapshotProvider>
        <MemoryRouter initialEntries={[entry]}>
          <GitHubPage />
          <Loc />
        </MemoryRouter>
      </SnapshotProvider>
    </ToastProvider>,
  );
}

describe("GitHubPage V2 recoverable states", () => {
  beforeEach(() => { localStorage.clear(); lastSearch = ""; });
  afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.useRealTimers(); });

  it("a 200 rate-limited list renders the rate-limit state (never 'No open issues.') and Retry refetches", async () => {
    let limited = true;
    const calls = stub((url) => {
      if (url.startsWith("/api/containers/c1/github/issues")) {
        return limited
          ? { body: { available: false, reason: "rate_limited", detail: "GitHub rate limit or access forbidden (403)", repo: "acme/app" } }
          : { body: ISSUES };
      }
      return null;
    });
    mount();
    // the hub's ambiguous 403 wording ("rate limit or access forbidden") gets
    // honest two-cause copy, with the access check offered
    expect(await screen.findByText("GitHub refused the request")).toBeInTheDocument();
    expect(screen.queryByText("No open issues.")).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Check GitHub access" }).getAttribute("href")).toBe("/settings#tab=github-access");
    limited = false;
    const before = calls.filter((u) => u.includes("/github/issues")).length;
    fireEvent.click(screen.getByRole("button", { name: "Retry now" }));
    expect(await screen.findByText("Fix login bug")).toBeInTheDocument();
    expect(calls.filter((u) => u.includes("/github/issues")).length).toBe(before + 1);
  });

  it("a generic 200 {available:false, reason:unreachable} is an error with Retry, not an empty list", async () => {
    stub((url) => (url.startsWith("/api/containers/c1/github/issues")
      ? { body: { available: false, reason: "unreachable", detail: "could not reach GitHub" } }
      : null));
    mount();
    expect(await screen.findByText("could not reach GitHub")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retry now" })).toBeInTheDocument();
    expect(screen.queryByText("No open issues.")).not.toBeInTheDocument();
  });

  it("a bound repo that GitHub can't return renders the missing-access state with its recoveries", async () => {
    stub((url) => (url.startsWith("/api/containers/c1/github/issues")
      ? { body: { available: false, reason: "repo_not_connected", detail: "repo not reachable with this installation (404)", repo: "acme/app" } }
      : null));
    mount();
    expect(await screen.findByText("Can't reach acme/app")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Check GitHub access" }).getAttribute("href")).toBe("/settings#tab=github-access");
    // two "Change repo" controls exist (header + this state); use the state's own
    const changeBtns = screen.getAllByRole("button", { name: /Change repo/ });
    fireEvent.click(changeBtns[changeBtns.length - 1]);
    // the existing Connect-repo modal opens (its own tests cover the picker)
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
  });

  it("no binding at all keeps the plain 'No repository connected' empty state", async () => {
    stub((url) => {
      if (url === "/api/containers/c1/github") return { body: { repo: null } };
      if (url.startsWith("/api/containers/c1/github/issues")) return { body: { available: false, reason: "repo_not_connected", detail: "no GitHub repo is connected to this project" } };
      return null;
    });
    mount();
    expect(await screen.findByText("No repository connected")).toBeInTheDocument();
  });

  it("a failed checks batch shows 'Checks unavailable' instead of a forever 'checks…'", async () => {
    stub((url) => {
      if (url.startsWith("/api/containers/c1/github/pulls")) return { body: PULLS };
      if (url.startsWith("/api/containers/c1/github/checks")) return { body: { available: false, reason: "rate_limited" } };
      return null;
    });
    mount("/github?tab=pulls");
    expect(await screen.findByText("Add OAuth flow")).toBeInTheDocument();
    expect(await screen.findByText("Checks unavailable")).toBeInTheDocument();
    expect(screen.queryByText("checks…")).not.toBeInTheDocument();
  });

  it("a failed 60s refresh keeps the rows but labels them stale, with Retry", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let fail = false;
    stub((url) => {
      if (url.startsWith("/api/containers/c1/github/issues")) {
        return fail ? { body: { available: false, reason: "unreachable", detail: "could not reach GitHub" } } : { body: ISSUES };
      }
      return null;
    });
    mount();
    expect(await screen.findByText("Fix login bug")).toBeInTheDocument();
    fail = true;
    await act(async () => { vi.advanceTimersByTime(60_000); });
    expect(await screen.findByText(/Couldn't refresh from GitHub/)).toBeInTheDocument();
    expect(screen.getByText(/not live\./)).toBeInTheDocument();
    // the last good rows are still there, clearly labeled
    expect(screen.getByText("Fix login bug")).toBeInTheDocument();
    fail = false;
    fireEvent.click(screen.getByRole("button", { name: "Retry now" }));
    await waitFor(() => expect(screen.queryByText(/Couldn't refresh from GitHub/)).not.toBeInTheDocument());
  });

  it("detail not found offers a way back to the list", async () => {
    stub((url) => (url.startsWith("/api/containers/c1/github/issues/99")
      ? { status: 200, body: { available: false, reason: "not_found", detail: "issue or pull request not found (404)", repo: "acme/app" } }
      : url.startsWith("/api/containers/c1/github/issues") ? { body: ISSUES } : null));
    mount("/github?issue=99");
    expect(await screen.findByText("Issue not found")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Back to issues" }));
    await waitFor(() => expect(lastSearch).not.toContain("issue=99"));
  });
});

describe("GitHubPage V2 keyboard access", () => {
  beforeEach(() => { localStorage.clear(); lastSearch = ""; });
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  it("Enter on a focused row opens its detail route", async () => {
    stub((url) => (url.startsWith("/api/containers/c1/github/issues") ? { body: ISSUES } : null));
    mount();
    const row = await screen.findByRole("link", { name: "Issue #7: Fix login bug" });
    expect(row.getAttribute("tabindex")).toBe("0");
    row.focus();
    fireEvent.keyDown(row, { key: "Enter" });
    await waitFor(() => expect(lastSearch).toContain("issue=7"));
  });

  it("ArrowRight on the Issues pill switches to Pull requests (roving tabindex)", async () => {
    stub((url) => {
      if (url.startsWith("/api/containers/c1/github/issues")) return { body: ISSUES };
      if (url.startsWith("/api/containers/c1/github/pulls")) return { body: PULLS };
      return null;
    });
    mount();
    const issuesTab = await screen.findByRole("radio", { name: /^Issues/ });
    expect(issuesTab.getAttribute("tabindex")).toBe("0");
    expect(screen.getByRole("radio", { name: /^Pull requests/ }).getAttribute("tabindex")).toBe("-1");
    fireEvent.keyDown(issuesTab, { key: "ArrowRight" });
    expect(await screen.findByText("Add OAuth flow")).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /^Pull requests/ }).getAttribute("aria-checked")).toBe("true");
  });
});
