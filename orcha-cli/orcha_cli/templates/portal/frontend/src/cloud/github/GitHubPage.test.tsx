/**
 * GitHubPage — list rendering from the stubbed wire contract, the Start
 * mutation's exact POST body, the acting-human gate, and the pulls tab's
 * progressive checks fill. fetch is stubbed; the snapshot flows through the
 * real SnapshotProvider + mapSnapshot (foundation.test.ts / HomePage.test.tsx
 * harness style).
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "../../components/ui";
import { SnapshotProvider } from "../../state/SnapshotProvider";
import { GitHubPage } from "./GitHubPage";

interface Call { url: string; method: string; body: unknown }

const AGENTS_WITH_HUMAN = [
  { id: "h1", alias: "kedar", kind: "human", status: "idle" },
  { id: "a1", alias: "forge", kind: "ai", status: "idle", role: "web engineer (Next.js dashboard)" },
];
const AGENTS_AI_ONLY = [
  { id: "a1", alias: "forge", kind: "ai", status: "idle", role: "web engineer (Next.js dashboard)" },
];

const rawSnap = (agents: unknown[]) => ({
  container: { id: "c1", name: "Acme", status: "active", autonomy_level: "plan" },
  agents,
  tasks: [],
  requests: [],
});

const ISSUES = {
  available: true,
  repo: "acme/app",
  issues: [
    {
      number: 7,
      title: "Fix login bug",
      labels: [{ name: "bug", color: "d73a4a" }],
      assignee: null,
      updated_at: "2026-08-01T00:00:00Z",
      html_url: "https://github.com/acme/app/issues/7",
      body_excerpt: "login broken on the web dashboard",
      tracked_task_id: null,
    },
  ],
};

const PULLS = {
  available: true,
  repo: "acme/app",
  pulls: [
    {
      number: 12,
      title: "Add OAuth flow",
      head: "feat/oauth",
      draft: false,
      updated_at: "2026-08-01T00:00:00Z",
      html_url: "https://github.com/acme/app/pull/12",
      requested_reviewers: ["kedar"],
      checks: null, // ALWAYS null off the list endpoint — progressive fill
      mergeable_state: "clean",
      tracked_task_id: null,
      author_login: "kedar",
    },
  ],
};

const CHECKS = { available: true, checks: { "12": { passed: 3, failing: 0, pending: 0, total: 3 } } };

const PULL_DETAIL = {
  repo: "acme/app",
  pull: {
    number: 12,
    title: "Add OAuth flow",
    head: "feat/oauth",
    base: "main",
    draft: false,
    state: "open",
    updated_at: "2026-08-01T00:00:00Z",
    html_url: "https://github.com/acme/app/pull/12",
    requested_reviewers: ["kedar"],
    checks: { passed: 3, failing: 0, pending: 0, total: 3 },
    mergeable_state: "clean",
    tracked_task_id: null,
    body_markdown: "adds OAuth",
  },
};

function stubFetch(agents: unknown[]): Call[] {
  const calls: Call[] = [];
  const json = (data: unknown, status = 200) =>
    ({ ok: status < 400, status, json: async () => data }) as unknown as Response;
  global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({
      url,
      method: init?.method || "GET",
      body: init?.body ? JSON.parse(String(init.body)) : null,
    });
    // order matters: the github routes share the /api/containers/c1 prefix
    if (url.startsWith("/api/containers/c1/github/browse/tree")) return json({ ref: "HEAD", path: "", entries: [] });
    if (url.startsWith("/api/containers/c1/github/browse/file")) return json({ ref: "HEAD", path: "README.md", content: "# hi", size: 4 });
    if (url.startsWith("/api/containers/c1/github/issues")) return json(ISSUES);
    if (url.startsWith("/api/containers/c1/github/pulls/12")) return json(PULL_DETAIL);
    if (url.startsWith("/api/containers/c1/github/pulls")) return json(PULLS);
    if (url.startsWith("/api/containers/c1/github/checks")) return json(CHECKS);
    if (url.startsWith("/api/containers/c1/github/start")) return json({ task_id: "t-99", existing: false }, 201);
    if (url.startsWith("/api/me")) return json({ identity: { agent_id: "h1", github_login: "kedar" }, trusted: true });
    if (url.startsWith("/api/containers/c1")) return json(rawSnap(agents));
    if (url === "/api/containers") return json([{ id: "c1", status: "active" }]);
    return json({});
  }) as unknown as typeof fetch;
  return calls;
}

function mount(initialEntry = "/github") {
  return render(
    <ToastProvider>
      <SnapshotProvider>
        <MemoryRouter initialEntries={[initialEntry]}>
          <GitHubPage />
        </MemoryRouter>
      </SnapshotProvider>
    </ToastProvider>,
  );
}

describe("GitHubPage list (wire-contract render)", () => {
  beforeEach(() => { localStorage.clear(); });
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  it("renders the issues list from the stubbed endpoints", async () => {
    const calls = stubFetch(AGENTS_WITH_HUMAN);
    mount();
    expect(await screen.findByText("Fix login bug")).toBeInTheDocument();
    expect(screen.getByText("#7")).toBeInTheDocument();
    expect(screen.getByText("bug")).toBeInTheDocument();
    expect(screen.getByText("Unassigned")).toBeInTheDocument();
    // the vanilla endpoint, verbatim
    expect(calls.some((c) => c.url === "/api/containers/c1/github/issues" && c.method === "GET")).toBe(true);
    // no "connect a repo" empty card once the repo payload landed
    expect(screen.queryByText("No GitHub repo connected")).not.toBeInTheDocument();
  });

  it("renders the vanilla column-header row above the list", async () => {
    stubFetch(AGENTS_WITH_HUMAN);
    mount();
    await screen.findByText("Fix login bug");
    const head = document.querySelector(".ghhead-row");
    expect(head).not.toBeNull();
    // ID | TITLE | REVIEWERS | CHECKS | MERGE | UPDATED, same cell classes as .ghrow
    expect(head!.querySelector(".ghh-num")!.textContent).toBe("ID");
    expect(head!.querySelector(".ghh-main")!.textContent).toBe("TITLE");
    expect(head!.querySelector(".ghh-reviewers")!.textContent).toBe("REVIEWERS");
    expect(head!.querySelector(".ghh-checks")!.textContent).toBe("CHECKS");
    expect(head!.querySelector(".ghh-merge")!.textContent).toBe("MERGE");
    expect(head!.querySelector(".ghh-updated")!.textContent).toBe("UPDATED");
    // pulls tab keeps the header and adds the / CONTEXT suffix to TITLE
    fireEvent.click(screen.getByText("Pull requests"));
    await screen.findByText("Add OAuth flow");
    expect(document.querySelector(".ghhead-row .ghh-main")!.textContent).toBe("TITLE / CONTEXT");
  });

  it("an issue row carries the empty reviewers/checks/merge columns and the updated cell (vanilla degrade)", async () => {
    stubFetch(AGENTS_WITH_HUMAN);
    mount();
    await screen.findByText("Fix login bug");
    const row = document.querySelector('[data-gh-row="issue:7"]');
    expect(row).not.toBeNull();
    // vanilla issueRowHtml leaves the three PR-only columns present but empty
    // so the shared header lines up over both tabs
    expect(row!.querySelector(".gh-reviewers-col")).not.toBeNull();
    expect(row!.querySelector(".gh-reviewers-col")!.innerHTML).toBe("");
    expect(row!.querySelector(".gh-checks-col")!.innerHTML).toBe("");
    expect(row!.querySelector(".gh-merge-col")!.innerHTML).toBe("");
    // updated relative time renders (never the raw ISO string)
    const updated = row!.querySelector(".gh-updated");
    expect(updated!.textContent).toBeTruthy();
    expect(updated!.textContent).not.toContain("2026-08-01");
  });

  it("pulls tab renders PR rows and progressively fills checks via the batch endpoint", async () => {
    const calls = stubFetch(AGENTS_WITH_HUMAN);
    mount();
    await screen.findByText("Fix login bug");
    fireEvent.click(screen.getByText("Pull requests"));
    expect(await screen.findByText("Add OAuth flow")).toBeInTheDocument();
    expect(screen.getByText("feat/oauth")).toBeInTheDocument();
    // checks:null -> batch GET .../github/checks?numbers=12 -> chip patched
    expect(await screen.findByText("3 passed")).toBeInTheDocument();
    expect(calls.some((c) => c.url === "/api/containers/c1/github/checks?numbers=12")).toBe(true);
    // PR dispatch button reads "Fix", clean mergeable_state shows "Checks passed"
    expect(screen.getByRole("button", { name: "Dispatch an agent to fix checks/review feedback on this PR" })).toBeInTheDocument();
    expect(screen.getByText("Checks passed")).toBeInTheDocument();
  });

  it("a PR row fills the reviewers/checks/merge/updated columns (vanilla pullRowHtml)", async () => {
    stubFetch(AGENTS_WITH_HUMAN);
    mount();
    await screen.findByText("Fix login bug");
    fireEvent.click(screen.getByText("Pull requests"));
    await screen.findByText("3 passed"); // progressive fill settled
    const row = document.querySelector('[data-gh-row="pull:12"]');
    expect(row).not.toBeNull();
    // REVIEWERS: requested_reviewers as overlapping avatars in the reviewers column
    const reviewers = row!.querySelector(".gh-reviewers-col .gh-reviewers");
    expect(reviewers).not.toBeNull();
    expect(reviewers!.querySelectorAll(".av").length).toBe(1); // ["kedar"]
    // CHECKS: the rollup chip (patched in by the batch endpoint) in its column
    const checks = row!.querySelector(".gh-checks-col .tag.gh-checks");
    expect(checks).not.toBeNull();
    expect(checks!.classList.contains("pass")).toBe(true);
    expect(checks!.textContent).toContain("3 passed");
    // MERGE: mergeable_state clean -> the green "Checks passed" merge chip
    const merge = row!.querySelector(".gh-merge-col .tag.gh-merge");
    expect(merge).not.toBeNull();
    expect(merge!.classList.contains("ok")).toBe(true);
    // UPDATED: relative time, never the raw ISO string
    const updated = row!.querySelector(".gh-updated");
    expect(updated!.textContent).toBeTruthy();
    expect(updated!.textContent).not.toContain("2026-08-01");
  });

  it("shows the OrchaSkeleton list shimmer while the list fetch is unsettled", async () => {
    // issues fetch never resolves -> after the 120ms show delay the vanilla
    // "list-rows" skeleton markup (shared skeleton.css classes) fills #ghlist
    const json = (data: unknown, status = 200) =>
      ({ ok: status < 400, status, json: async () => data }) as unknown as Response;
    global.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith("/api/containers/c1/github/")) return new Promise<Response>(() => { /* never settles */ });
      if (url.startsWith("/api/me")) return json({ identity: { agent_id: "h1", github_login: "kedar" }, trusted: true });
      if (url.startsWith("/api/containers/c1")) return json(rawSnap(AGENTS_WITH_HUMAN));
      if (url === "/api/containers") return json([{ id: "c1", status: "active" }]);
      return json({});
    }) as unknown as typeof fetch;
    mount();
    await waitFor(() => {
      expect(document.querySelector("#ghlist .ork-sk-wrap .ork-sk-row")).not.toBeNull();
    });
  });
});

describe("GitHubPage Start flow (human-gated mutation)", () => {
  beforeEach(() => { localStorage.clear(); });
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  it("Start posts the exact body and swaps the row to the task chip", async () => {
    const calls = stubFetch(AGENTS_WITH_HUMAN);
    mount();
    await screen.findByText("Fix login bug");
    fireEvent.click(screen.getByRole("button", { name: "Dispatch an agent to work on this issue" }));
    await waitFor(() => {
      const post = calls.find((c) => c.url === "/api/containers/c1/github/start");
      expect(post).toBeTruthy();
      expect(post!.method).toBe("POST");
      // assignee_agent_id omitted on a bare Start (JSON.stringify drops undefined);
      // created_by_agent_id carries the acting human (trust-off attribution)
      expect(post!.body).toEqual({ kind: "issue", number: 7, created_by_agent_id: "h1" });
    });
    expect(await screen.findByText("t-99")).toBeInTheDocument();
    expect(await screen.findByText("Task created")).toBeInTheDocument();
  });

  it("warns and does not POST when no acting human exists", async () => {
    const calls = stubFetch(AGENTS_AI_ONLY);
    mount();
    await screen.findByText("Fix login bug");
    fireEvent.click(screen.getByRole("button", { name: "Dispatch an agent to work on this issue" }));
    expect(await screen.findByText("Pick an acting human first")).toBeInTheDocument();
    expect(calls.some((c) => c.url === "/api/containers/c1/github/start")).toBe(false);
  });
});

describe("GitHubPage Files sub-view integration (?browse=1&ref=&path=)", () => {
  beforeEach(() => { localStorage.clear(); });
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  it("the \"Browse files\" affordance mounts RepoBrowser under ?browse=1", async () => {
    const calls = stubFetch(AGENTS_WITH_HUMAN);
    mount();
    await screen.findByText("Fix login bug");
    fireEvent.click(screen.getByRole("button", { name: /browse files/i }));
    // the list card is gone; RepoBrowser's own wrapper mounts instead
    await waitFor(() => expect(document.querySelector(".rb-wrap")).not.toBeNull());
    expect(calls.some((c) => c.url.includes("/github/browse/tree"))).toBe(true);
  });

  it("deep-links straight into the Files view from ?browse=1&ref=&path=", async () => {
    stubFetch(AGENTS_WITH_HUMAN);
    mount("/github?browse=1&ref=HEAD&path=README.md");
    await waitFor(() => expect(document.querySelector(".rb-wrap")).not.toBeNull());
    // list/detail loaders never fire while browsing
    expect(screen.queryByText("Fix login bug")).not.toBeInTheDocument();
  });

  it("a PR detail's \"Browse head\" link routes into Files at ref=pr/<number>", async () => {
    stubFetch(AGENTS_WITH_HUMAN);
    mount("/github?pr=12");
    expect(await screen.findByRole("heading", { name: /Add OAuth flow/ })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /browse head/i }));
    await waitFor(() => expect(document.querySelector(".rb-wrap")).not.toBeNull());
  });

  it("exiting the Files view (back link) returns to the list", async () => {
    stubFetch(AGENTS_WITH_HUMAN);
    mount();
    await screen.findByText("Fix login bug");
    fireEvent.click(screen.getByRole("button", { name: /browse files/i }));
    await waitFor(() => expect(document.querySelector(".rb-wrap")).not.toBeNull());
    fireEvent.click(document.querySelector('[data-gh-back="1"]') as HTMLElement);
    expect(await screen.findByText("Fix login bug")).toBeInTheDocument();
  });
});

/* ============================================================================
   Orcha Cloud local run, Addendum 2 — local-or-GitHub code source: the header
   repo badge for a local binding, and the hub's honest degradation when the
   bound repo answers with reason:"local_source" (browse/Code Space stay
   fully enabled — this page only covers the issues/pulls hub itself).
   ============================================================================ */
const LOCAL_SOURCE_LIST = { available: false, reason: "local_source", detail: "issues/pulls are GitHub-only" };

function stubFetchLocalSource(binding = "local"): Call[] {
  const calls: Call[] = [];
  const json = (data: unknown, status = 200) =>
    ({ ok: status < 400, status, json: async () => data }) as unknown as Response;
  global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, method: init?.method || "GET", body: init?.body ? JSON.parse(String(init.body)) : null });
    if (url.startsWith("/api/containers/c1/github/issues")) return json(LOCAL_SOURCE_LIST);
    if (url.startsWith("/api/containers/c1/github/pulls")) return json(LOCAL_SOURCE_LIST);
    if (url === "/api/containers/c1/github") return json({ repo: binding });
    if (url.startsWith("/api/github/repos")) return json({ available: false, repos: [] });
    if (url.startsWith("/api/me")) return json({ identity: null, trusted: false });
    if (url.startsWith("/api/containers/c1")) return json(rawSnap(AGENTS_WITH_HUMAN));
    if (url === "/api/containers") return json([{ id: "c1", status: "active" }]);
    return json({});
  }) as unknown as typeof fetch;
  return calls;
}

describe("GitHubPage local-source degradation (Orcha Cloud local run, Addendum 2)", () => {
  beforeEach(() => { localStorage.clear(); });
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  it("reason:local_source renders the honest callout instead of the generic empty state", async () => {
    stubFetchLocalSource();
    mount();
    expect(await screen.findByText(
      "Browsing the local repository. Connect a GitHub repo for issues, PRs, and checks.",
    )).toBeInTheDocument();
    expect(screen.queryByText("No repo connected")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Connect GitHub repo/ })).toBeInTheDocument();
  });

  it("the callout's button opens the Connect-repo picker", async () => {
    stubFetchLocalSource();
    mount();
    await screen.findByText("Browsing the local repository. Connect a GitHub repo for issues, PRs, and checks.");
    fireEvent.click(screen.getByRole("button", { name: /Connect GitHub repo/ }));
    expect(await screen.findByText("Connect a repository")).toBeInTheDocument();
    expect(screen.getByText("This machine")).toBeInTheDocument();
  });

  it("the header shows the Local badge for a local binding, never a github.com link", async () => {
    stubFetchLocalSource();
    mount();
    await screen.findByText("Browsing the local repository. Connect a GitHub repo for issues, PRs, and checks.");
    expect(screen.getByText("Local")).toBeInTheDocument();
    expect(document.querySelector(".repo-badge a")).toBeNull();
  });

  it("pulls tab degrades the same way", async () => {
    stubFetchLocalSource();
    mount();
    await screen.findByText("Browsing the local repository. Connect a GitHub repo for issues, PRs, and checks.");
    fireEvent.click(screen.getByText("Pull requests"));
    expect(await screen.findAllByText("Browsing the local repository. Connect a GitHub repo for issues, PRs, and checks.")).not.toHaveLength(0);
  });
});

/* ============================================================================
   Local-binding + GitHub-origin fall-through (simultaneous local binding +
   GitHub hub): two more shapes the "local_source" degrade can take
   (origin_detected present vs. absent), plus the fully-available fall-through
   case where the hub payload comes back real (never degraded) even though the
   container is still LOCAL-bound.
   ============================================================================ */
const LOCAL_SOURCE_WITH_ORIGIN = {
  available: false, reason: "local_source", detail: "issues/pulls are GitHub-only",
  origin_detected: "acme/site",
};
const ISSUES_VIA_ORIGIN = {
  available: true,
  repo: "acme/site",
  issues: [
    {
      number: 4, title: "From the origin repo", labels: [], assignee: null,
      updated_at: "2026-08-01T00:00:00Z",
      html_url: "https://github.com/acme/site/issues/4",
      body_excerpt: "", tracked_task_id: null,
    },
  ],
};

function stubFetchLocalOrigin(opts: { withToken: boolean }): Call[] {
  const calls: Call[] = [];
  const json = (data: unknown, status = 200) =>
    ({ ok: status < 400, status, json: async () => data }) as unknown as Response;
  global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, method: init?.method || "GET", body: init?.body ? JSON.parse(String(init.body)) : null });
    if (url.startsWith("/api/containers/c1/github/issues")) {
      return json(opts.withToken ? ISSUES_VIA_ORIGIN : LOCAL_SOURCE_WITH_ORIGIN);
    }
    if (url.startsWith("/api/containers/c1/github/pulls")) {
      return json(opts.withToken ? { available: true, repo: "acme/site", pulls: [] } : LOCAL_SOURCE_WITH_ORIGIN);
    }
    if (url === "/api/containers/c1/github") return json({ repo: "local" });
    if (url.startsWith("/api/github/repos")) return json({ available: false, repos: [] });
    if (url.startsWith("/api/me")) return json({ identity: null, trusted: false });
    if (url.startsWith("/api/containers/c1")) return json(rawSnap(AGENTS_WITH_HUMAN));
    if (url === "/api/containers") return json([{ id: "c1", status: "active" }]);
    return json({});
  }) as unknown as typeof fetch;
  return calls;
}

describe("GitHubPage local-binding + GitHub-origin fall-through", () => {
  beforeEach(() => { localStorage.clear(); });
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  it("origin detected but no token: callout names the origin repo and links to Settings", async () => {
    stubFetchLocalOrigin({ withToken: false });
    mount();
    expect(await screen.findByText(
      "This clone comes from acme/site on GitHub — add GitHub access in Settings to see its issues & PRs.",
    )).toBeInTheDocument();
    const link = screen.getByRole("link", { name: /Add GitHub access/ });
    expect(link.getAttribute("href")).toBe("/settings");
    // the generic "Connect GitHub repo" wording/button is NOT shown for this variant
    expect(screen.queryByRole("button", { name: /Connect GitHub repo/ })).not.toBeInTheDocument();
  });

  it("no origin at all: keeps the generic callout wording (unchanged behavior)", async () => {
    stubFetchLocalSource();
    mount();
    expect(await screen.findByText(
      "Browsing the local repository. Connect a GitHub repo for issues, PRs, and checks.",
    )).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /Add GitHub access/ })).not.toBeInTheDocument();
  });

  it("fall-through succeeded (token present): renders real issues, no callout at all", async () => {
    stubFetchLocalOrigin({ withToken: true });
    mount();
    expect(await screen.findByText("From the origin repo")).toBeInTheDocument();
    expect(screen.queryByText(/Browsing the local repository/)).not.toBeInTheDocument();
    expect(screen.queryByText(/This clone comes from/)).not.toBeInTheDocument();
  });

  it("fall-through succeeded: header shows BOTH the Local chip and the muted origin suffix", async () => {
    stubFetchLocalOrigin({ withToken: true });
    mount();
    await screen.findByText("From the origin repo");
    expect(screen.getByText("Local")).toBeInTheDocument();
    expect(screen.getByText("· acme/site")).toBeInTheDocument();
  });
});

/* ============================================================================
   PR-list server-backed filter bar + pagination (monorepo-scale repos):
   author input (+ datalist), Assigned-to-me/My-reviews chips (mutually
   exclusive; disabled when the acting identity has no github_login), the
   free-text search box becoming server-backed q on the pulls tab, and a
   "Load more" pagination footer that appends pages.
   ============================================================================ */
const SEARCH_PAGE_1 = {
  available: true, source: "search", repo: "acme/app",
  pulls: [
    { number: 21, title: "Add OAuth flow", draft: false, updated_at: "2026-08-01T00:00:00Z",
      html_url: "https://github.com/acme/app/pull/21", author_login: "kedar",
      checks: null, tracked_task_id: null },
  ],
  page: 1, per_page: 30, total_count: 2, has_more: true,
};
const SEARCH_PAGE_2 = {
  available: true, source: "search", repo: "acme/app",
  pulls: [
    { number: 22, title: "Fix OAuth bug", draft: false, updated_at: "2026-08-02T00:00:00Z",
      html_url: "https://github.com/acme/app/pull/22", author_login: "forge",
      checks: null, tracked_task_id: null },
  ],
  page: 2, per_page: 30, total_count: 2, has_more: false,
};

function stubFetchFiltered(opts: { identityLogin?: string | null } = {}): Call[] {
  const calls: Call[] = [];
  const json = (data: unknown, status = 200) =>
    ({ ok: status < 400, status, json: async () => data }) as unknown as Response;
  global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, method: init?.method || "GET", body: init?.body ? JSON.parse(String(init.body)) : null });
    if (url.startsWith("/api/containers/c1/github/pulls")) {
      const qs = new URL(url, "http://x").searchParams;
      const hasFilter = qs.has("author") || qs.has("involvement") || qs.has("q");
      if (hasFilter) {
        const page = Number(qs.get("page") || "1");
        return json(page >= 2 ? SEARCH_PAGE_2 : SEARCH_PAGE_1);
      }
      return json(PULLS);
    }
    if (url.startsWith("/api/containers/c1/github/issues")) return json(ISSUES);
    if (url.startsWith("/api/containers/c1/github/checks")) return json(CHECKS);
    if (url.startsWith("/api/me")) {
      const login = opts.identityLogin === undefined ? "kedar" : opts.identityLogin;
      return json({ identity: login ? { agent_id: "h1", github_login: login } : null, trusted: true });
    }
    if (url.startsWith("/api/containers/c1")) return json(rawSnap(AGENTS_WITH_HUMAN));
    if (url === "/api/containers") return json([{ id: "c1", status: "active" }]);
    return json({});
  }) as unknown as typeof fetch;
  return calls;
}

describe("GitHubPage PR-list filter bar + pagination", () => {
  beforeEach(() => { localStorage.clear(); });
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  it("typing in the author input triggers a server-backed search request", async () => {
    const calls = stubFetchFiltered();
    mount();
    await screen.findByText("Fix login bug");
    fireEvent.click(screen.getByText("Pull requests"));
    await screen.findByText("Add OAuth flow"); // plain list first
    const authorInput = screen.getByPlaceholderText("Author…");
    fireEvent.change(authorInput, { target: { value: "octocat" } });
    await waitFor(() => {
      expect(calls.some((c) => c.url.includes("/github/pulls?author=octocat"))).toBe(true);
    });
  });

  it("the author datalist offers logins seen in loaded rows", async () => {
    stubFetchFiltered();
    mount();
    await screen.findByText("Fix login bug");
    fireEvent.click(screen.getByText("Pull requests"));
    await screen.findByText("Add OAuth flow");
    const options = document.querySelectorAll("#ghPullsAuthors option");
    const values = Array.from(options).map((o) => (o as HTMLOptionElement).value);
    expect(values).toContain("kedar"); // PULLS fixture row's author_login
  });

  it("Assigned to me and My reviews chips are mutually exclusive", async () => {
    const calls = stubFetchFiltered();
    mount();
    await screen.findByText("Fix login bug");
    fireEvent.click(screen.getByText("Pull requests"));
    await screen.findByText("Add OAuth flow");
    fireEvent.click(screen.getByText("Assigned to me"));
    await waitFor(() => expect(calls.some((c) => c.url.includes("involvement=assigned"))).toBe(true));
    expect(screen.getByText("Assigned to me").getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(screen.getByText("My reviews"));
    await waitFor(() => expect(calls.some((c) => c.url.includes("involvement=review_requested"))).toBe(true));
    expect(screen.getByText("Assigned to me").getAttribute("aria-pressed")).toBe("false");
    expect(screen.getByText("My reviews").getAttribute("aria-pressed")).toBe("true");
  });

  it("involvement chips are disabled with a tooltip when the identity has no github_login", async () => {
    stubFetchFiltered({ identityLogin: null });
    mount();
    await screen.findByText("Fix login bug");
    fireEvent.click(screen.getByText("Pull requests"));
    await screen.findByText("Add OAuth flow");
    const assigned = screen.getByText("Assigned to me");
    expect(assigned).toBeDisabled();
    expect(assigned.getAttribute("title")).toBe("Link a GitHub login to use this filter");
  });

  it("the search box becomes the server-backed q on the pulls tab", async () => {
    const calls = stubFetchFiltered();
    mount();
    await screen.findByText("Fix login bug");
    fireEvent.click(screen.getByText("Pull requests"));
    await screen.findByText("Add OAuth flow");
    const search = screen.getByPlaceholderText("Search title or body…");
    fireEvent.change(search, { target: { value: "oauth bug" } });
    await waitFor(() => expect(calls.some((c) => c.url.includes("q=oauth"))).toBe(true), { timeout: 2000 });
  });

  it("filtered results replace the plain list and show a Load more footer with ~total", async () => {
    stubFetchFiltered();
    mount();
    await screen.findByText("Fix login bug");
    fireEvent.click(screen.getByText("Pull requests"));
    await screen.findByText("Add OAuth flow");
    fireEvent.change(screen.getByPlaceholderText("Author…"), { target: { value: "kedar" } });
    await screen.findByText("Add OAuth flow"); // filtered page 1 result (same title, different source)
    expect(screen.getByText(/Load more · 1 of ~2/)).toBeInTheDocument();
  });

  it("clicking Load more appends the next page", async () => {
    const calls = stubFetchFiltered();
    mount();
    await screen.findByText("Fix login bug");
    fireEvent.click(screen.getByText("Pull requests"));
    await screen.findByText("Add OAuth flow");
    fireEvent.change(screen.getByPlaceholderText("Author…"), { target: { value: "kedar" } });
    await screen.findByText(/Load more/);
    fireEvent.click(screen.getByText(/Load more/));
    await waitFor(() => expect(calls.some((c) => c.url.includes("page=2"))).toBe(true));
    expect(await screen.findByText("Fix OAuth bug")).toBeInTheDocument();
    // both pages' rows are visible now, and the footer reflects "no more"
    expect(screen.getByText("Add OAuth flow")).toBeInTheDocument();
    expect(screen.queryByText(/Load more/)).not.toBeInTheDocument();
  });

  it("clearing all filters returns to the plain client-side-filtered list", async () => {
    stubFetchFiltered();
    mount();
    await screen.findByText("Fix login bug");
    fireEvent.click(screen.getByText("Pull requests"));
    await screen.findByText("Add OAuth flow");
    const authorInput = screen.getByPlaceholderText("Author…");
    fireEvent.change(authorInput, { target: { value: "kedar" } });
    await waitFor(() => expect(screen.getByText(/Load more/)).toBeInTheDocument());
    fireEvent.change(authorInput, { target: { value: "" } });
    await waitFor(() => expect(screen.queryByText(/Load more/)).not.toBeInTheDocument());
    expect(screen.getByText("Add OAuth flow")).toBeInTheDocument();
  });

  it("the Issues tab is untouched: no filter bar, plain title search still client-side", async () => {
    stubFetchFiltered();
    mount();
    await screen.findByText("Fix login bug");
    expect(screen.queryByPlaceholderText("Author…")).not.toBeInTheDocument();
    expect(screen.queryByText("Assigned to me")).not.toBeInTheDocument();
    expect(screen.getByPlaceholderText("Filter by title or #number…")).toBeInTheDocument();
  });
});
