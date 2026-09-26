/**
 * ChangesTab — the working-tree "what have agents changed" list: dirty rows
 * with status badges + counts, summary header, empty/clean state, the
 * github_source degrade, click-to-open, and the dirty-count callback the
 * ThreadRail badge relies on. Stubs `fetchWorktreeChanges`'s underlying
 * `fetch` directly (matches ThreadRail.test.tsx's own stubFetch idiom).
 *
 * The commit/push tests below route on the request URL (a single fetch
 * mock covers changes/branch/commit/push, since ChangesTab fires all four)
 * rather than the single-payload stub the read-only tests above use.
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChangesTab } from "./ChangesTab";

function stubFetch(payload: unknown) {
  global.fetch = vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => payload,
  })) as unknown as typeof fetch;
}

function jsonResponse(payload: unknown) {
  return { ok: true, status: 200, json: async () => payload };
}

const NO_BRANCH = { available: false };
const CLEAN = { available: true, dirty: false, files: [], summary: { files: 0, additions: 0, deletions: 0 } };
const ONE_DIRTY = {
  available: true,
  dirty: true,
  files: [{ path: "src/a.ts", status: "M", additions: 3, deletions: 1 }],
  summary: { files: 1, additions: 3, deletions: 1 },
};

describe("ChangesTab", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("shows the clean-tree empty state", async () => {
    stubFetch({ available: true, dirty: false, files: [], summary: { files: 0, additions: 0, deletions: 0 } });
    render(<ChangesTab cid="c1" onOpenChange={vi.fn()} />);
    expect(await screen.findByText(/working tree clean/i)).toBeInTheDocument();
  });

  it("renders dirty rows with status badges, counts, and the summary header", async () => {
    stubFetch({
      available: true,
      dirty: true,
      files: [
        { path: "src/a.ts", status: "M", additions: 3, deletions: 1 },
        { path: "src/new.ts", status: "??", additions: 5, deletions: 0 },
        { path: "src/gone.ts", status: "D", additions: 0, deletions: 8 },
      ],
      summary: { files: 3, additions: 8, deletions: 9 },
    });
    render(<ChangesTab cid="c1" onOpenChange={vi.fn()} />);
    expect(await screen.findByText("src/a.ts")).toBeInTheDocument();
    expect(screen.getByText("src/new.ts")).toBeInTheDocument();
    expect(screen.getByText("src/gone.ts")).toBeInTheDocument();
    expect(screen.getByText("3 files changed")).toBeInTheDocument();
    expect(screen.getByText("+8")).toBeInTheDocument();
    expect(screen.getByText("−9")).toBeInTheDocument();
  });

  it("clicking a row calls onOpenChange with that path", async () => {
    stubFetch({
      available: true,
      dirty: true,
      files: [{ path: "src/a.ts", status: "M", additions: 1, deletions: 0 }],
      summary: { files: 1, additions: 1, deletions: 0 },
    });
    const onOpenChange = vi.fn();
    render(<ChangesTab cid="c1" onOpenChange={onOpenChange} />);
    const row = await screen.findByText("src/a.ts");
    fireEvent.click(row.closest(".cs-changes-row") as HTMLElement);
    expect(onOpenChange).toHaveBeenCalledWith("src/a.ts");
  });

  it("renders the github_source degrade honestly", async () => {
    stubFetch({ available: false, reason: "github_source", detail: "needs a local repository" });
    render(<ChangesTab cid="c1" onOpenChange={vi.fn()} />);
    expect(await screen.findByText(/using a\s*\n?\s*connected GitHub repo|needs a local repository/i)).toBeTruthy();
  });

  it("reports the dirty count via onDirtyCountChange", async () => {
    stubFetch({
      available: true,
      dirty: true,
      files: [
        { path: "a.ts", status: "M", additions: 1, deletions: 0 },
        { path: "b.ts", status: "A", additions: 2, deletions: 0 },
      ],
      summary: { files: 2, additions: 3, deletions: 0 },
    });
    const onDirtyCountChange = vi.fn();
    render(<ChangesTab cid="c1" onOpenChange={vi.fn()} onDirtyCountChange={onDirtyCountChange} />);
    await waitFor(() => expect(onDirtyCountChange).toHaveBeenCalledWith(2));
  });

  it("reports zero when the tree is clean", async () => {
    stubFetch({ available: true, dirty: false, files: [], summary: { files: 0, additions: 0, deletions: 0 } });
    const onDirtyCountChange = vi.fn();
    render(<ChangesTab cid="c1" onOpenChange={vi.fn()} onDirtyCountChange={onDirtyCountChange} />);
    await waitFor(() => expect(onDirtyCountChange).toHaveBeenCalledWith(0));
  });

  it("highlights the currently-selected path", async () => {
    stubFetch({
      available: true,
      dirty: true,
      files: [{ path: "src/a.ts", status: "M", additions: 1, deletions: 0 }],
      summary: { files: 1, additions: 1, deletions: 0 },
    });
    render(<ChangesTab cid="c1" selectedPath="src/a.ts" onOpenChange={vi.fn()} />);
    const row = await screen.findByText("src/a.ts");
    expect(row.closest(".cs-changes-row")).toHaveClass("on");
  });

  it("renders a binary marker when counts are null", async () => {
    stubFetch({
      available: true,
      dirty: true,
      files: [{ path: "img.png", status: "M", additions: null, deletions: null }],
      summary: { files: 1, additions: 0, deletions: 0 },
    });
    render(<ChangesTab cid="c1" onOpenChange={vi.fn()} />);
    expect(await screen.findByText("binary")).toBeInTheDocument();
  });

  describe("commit flow", () => {
    it("commits the checked files and refreshes the list", async () => {
      const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
        const u = String(url);
        if (u.endsWith("/worktree/branch")) return jsonResponse(NO_BRANCH);
        if (u.endsWith("/worktree/commit") && init?.method === "POST") {
          return jsonResponse({ ok: true, sha: "abc123", short: "abc123" });
        }
        if (u.endsWith("/worktree/changes")) {
          // first call: dirty; after commit: clean
          return jsonResponse(fetchMock.mock.calls.filter((c) => String(c[0]).endsWith("/worktree/changes")).length <= 1 ? ONE_DIRTY : CLEAN);
        }
        return jsonResponse({});
      });
      global.fetch = fetchMock as unknown as typeof fetch;

      render(<ChangesTab cid="c1" onOpenChange={vi.fn()} />);
      await screen.findByText("src/a.ts");

      const checkbox = screen.getByRole("checkbox", { name: /include src\/a\.ts/i });
      expect(checkbox).toBeChecked(); // checked by default

      const msgInput = screen.getByPlaceholderText("Commit message");
      fireEvent.change(msgInput, { target: { value: "fix the thing" } });

      const commitBtn = screen.getByRole("button", { name: /commit 1 file/i });
      expect(commitBtn).not.toBeDisabled();
      fireEvent.click(commitBtn);

      await waitFor(() => {
        const commitCalls = fetchMock.mock.calls.filter((c) => String(c[0]).endsWith("/worktree/commit"));
        expect(commitCalls.length).toBe(1);
      });
      const [, commitInit] = fetchMock.mock.calls.find((c) => String(c[0]).endsWith("/worktree/commit"))!;
      const body = JSON.parse((commitInit as RequestInit).body as string);
      expect(body).toEqual({ paths: ["src/a.ts"], message: "fix the thing" });

      // refresh called: changes fetched again after commit
      await waitFor(() => {
        const changesCalls = fetchMock.mock.calls.filter((c) => String(c[0]).endsWith("/worktree/changes"));
        expect(changesCalls.length).toBeGreaterThanOrEqual(2);
      });
      await screen.findByText(/working tree clean/i);
    });

    it("unchecking a file excludes it from the commit and the button count", async () => {
      const fetchMock = vi.fn(async (url: string) => {
        const u = String(url);
        if (u.endsWith("/worktree/branch")) return jsonResponse(NO_BRANCH);
        if (u.endsWith("/worktree/changes")) {
          return jsonResponse({
            available: true,
            dirty: true,
            files: [
              { path: "a.ts", status: "M", additions: 1, deletions: 0 },
              { path: "b.ts", status: "M", additions: 1, deletions: 0 },
            ],
            summary: { files: 2, additions: 2, deletions: 0 },
          });
        }
        return jsonResponse({});
      });
      global.fetch = fetchMock as unknown as typeof fetch;

      render(<ChangesTab cid="c1" onOpenChange={vi.fn()} />);
      await screen.findByText("a.ts");
      const checkboxA = screen.getByRole("checkbox", { name: /include a\.ts/i });
      fireEvent.click(checkboxA);
      expect(checkboxA).not.toBeChecked();

      fireEvent.change(screen.getByPlaceholderText("Commit message"), { target: { value: "msg" } });
      expect(screen.getByRole("button", { name: /commit 1 file/i })).toBeInTheDocument();
    });

    it("disables Commit until a message is entered", async () => {
      stubFetch(ONE_DIRTY);
      render(<ChangesTab cid="c1" onOpenChange={vi.fn()} />);
      await screen.findByText("src/a.ts");
      expect(screen.getByRole("button", { name: /commit 1 file/i })).toBeDisabled();
    });
  });

  describe("branch bar / push", () => {
    it("hides the branch bar when unavailable", async () => {
      const fetchMock = vi.fn(async (url: string) => {
        const u = String(url);
        if (u.endsWith("/worktree/branch")) return jsonResponse(NO_BRANCH);
        if (u.endsWith("/worktree/changes")) return jsonResponse(CLEAN);
        return jsonResponse({});
      });
      global.fetch = fetchMock as unknown as typeof fetch;
      render(<ChangesTab cid="c1" onOpenChange={vi.fn()} />);
      await screen.findByText(/working tree clean/i);
      expect(document.querySelector(".cs-branch-bar")).not.toBeInTheDocument();
    });

    it("shows branch name and ahead count, and pushes on click", async () => {
      let pushed = false;
      const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
        const u = String(url);
        if (u.endsWith("/worktree/branch")) {
          return jsonResponse({ available: true, branch: "feat/foo", sha: "deadbeef", ahead: 2, behind: 0, remote: "origin" });
        }
        if (u.endsWith("/worktree/push") && init?.method === "POST") {
          pushed = true;
          return jsonResponse({ ok: true, detail: "Pushed 2 commits" });
        }
        if (u.endsWith("/worktree/changes")) return jsonResponse(CLEAN);
        return jsonResponse({});
      });
      global.fetch = fetchMock as unknown as typeof fetch;

      render(<ChangesTab cid="c1" onOpenChange={vi.fn()} />);
      expect(await screen.findByText("feat/foo")).toBeInTheDocument();
      expect(screen.getByText("2 ahead")).toBeInTheDocument();

      fireEvent.click(screen.getByRole("button", { name: /push/i }));
      await waitFor(() => expect(pushed).toBe(true));
    });

    it("shows a failure detail via toast when push fails (does not throw)", async () => {
      const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
        const u = String(url);
        if (u.endsWith("/worktree/branch")) {
          return jsonResponse({ available: true, branch: "main", sha: "deadbeef", ahead: 1, behind: 0, remote: "origin" });
        }
        if (u.endsWith("/worktree/push") && init?.method === "POST") {
          return jsonResponse({ ok: false, detail: "remote rejected" });
        }
        if (u.endsWith("/worktree/changes")) return jsonResponse(CLEAN);
        return jsonResponse({});
      });
      global.fetch = fetchMock as unknown as typeof fetch;

      render(<ChangesTab cid="c1" onOpenChange={vi.fn()} />);
      await screen.findByText("main");
      fireEvent.click(screen.getByRole("button", { name: /push/i }));
      await waitFor(() => {
        const pushCalls = fetchMock.mock.calls.filter((c) => String(c[0]).endsWith("/worktree/push"));
        expect(pushCalls.length).toBe(1);
      });
    });

    it("disables Push when nothing is ahead", async () => {
      const fetchMock = vi.fn(async (url: string) => {
        const u = String(url);
        if (u.endsWith("/worktree/branch")) {
          return jsonResponse({ available: true, branch: "main", sha: "deadbeef", ahead: 0, behind: 0, remote: "origin" });
        }
        if (u.endsWith("/worktree/changes")) return jsonResponse(CLEAN);
        return jsonResponse({});
      });
      global.fetch = fetchMock as unknown as typeof fetch;
      render(<ChangesTab cid="c1" onOpenChange={vi.fn()} />);
      await screen.findByText("main");
      expect(screen.getByRole("button", { name: /push/i })).toBeDisabled();
    });
  });
});
