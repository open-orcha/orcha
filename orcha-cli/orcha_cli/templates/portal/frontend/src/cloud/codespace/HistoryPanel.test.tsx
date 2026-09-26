/**
 * HistoryPanel — the file-header History popover: commit list (short sha,
 * summary, relative time), empty/unavailable states, click -> ref switch,
 * and the close button.
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HistoryPanel } from "./HistoryPanel";

function stubFetch(payload: unknown) {
  global.fetch = vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => payload,
  })) as unknown as typeof fetch;
}

describe("HistoryPanel", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("renders the commit list with short sha, summary, and relative time", async () => {
    stubFetch({
      available: true,
      path: "src/a.ts",
      commits: [
        { sha: "a".repeat(40), short: "aaaaaaa", summary: "add feature", author: "forge", committed_at: new Date().toISOString() },
        { sha: "b".repeat(40), short: "bbbbbbb", summary: "initial commit", author: "kedar", committed_at: new Date().toISOString() },
      ],
    });
    render(<HistoryPanel cid="c1" path="src/a.ts" gitRef="HEAD" onSelectCommit={vi.fn()} onClose={vi.fn()} />);
    expect(await screen.findByText("add feature")).toBeInTheDocument();
    expect(screen.getByText("initial commit")).toBeInTheDocument();
    expect(screen.getByText("aaaaaaa")).toBeInTheDocument();
    expect(screen.getByText("bbbbbbb")).toBeInTheDocument();
  });

  it("clicking a commit row calls onSelectCommit with its full sha", async () => {
    const sha = "c".repeat(40);
    stubFetch({
      available: true,
      commits: [{ sha, short: "ccccccc", summary: "fix bug", author: "forge", committed_at: new Date().toISOString() }],
    });
    const onSelectCommit = vi.fn();
    render(<HistoryPanel cid="c1" path="src/a.ts" gitRef="HEAD" onSelectCommit={onSelectCommit} onClose={vi.fn()} />);
    const row = await screen.findByText("fix bug");
    fireEvent.click(row.closest(".cs-history-row") as HTMLElement);
    expect(onSelectCommit).toHaveBeenCalledWith(sha);
  });

  it("shows an empty state when the file has no history", async () => {
    stubFetch({ available: true, commits: [] });
    render(<HistoryPanel cid="c1" path="src/a.ts" gitRef="HEAD" onSelectCommit={vi.fn()} onClose={vi.fn()} />);
    expect(await screen.findByText(/no history found/i)).toBeInTheDocument();
  });

  it("shows the unavailable detail when the container is GitHub-bound", async () => {
    stubFetch({ available: false, reason: "github_source", detail: "needs a local repository" });
    render(<HistoryPanel cid="c1" path="src/a.ts" gitRef="HEAD" onSelectCommit={vi.fn()} onClose={vi.fn()} />);
    expect(await screen.findByText(/needs a local repository/i)).toBeInTheDocument();
  });

  it("clicking the close button calls onClose", async () => {
    stubFetch({ available: true, commits: [] });
    const onClose = vi.fn();
    render(<HistoryPanel cid="c1" path="src/a.ts" gitRef="HEAD" onSelectCommit={vi.fn()} onClose={onClose} />);
    fireEvent.click(screen.getByLabelText(/close history/i));
    expect(onClose).toHaveBeenCalled();
  });

  it("re-fetches when the path changes", async () => {
    stubFetch({ available: true, commits: [{ sha: "d".repeat(40), short: "ddddddd", summary: "first file", author: "forge", committed_at: new Date().toISOString() }] });
    const { rerender } = render(<HistoryPanel cid="c1" path="a.ts" gitRef="HEAD" onSelectCommit={vi.fn()} onClose={vi.fn()} />);
    await screen.findByText("first file");

    stubFetch({ available: true, commits: [{ sha: "e".repeat(40), short: "eeeeeee", summary: "second file", author: "forge", committed_at: new Date().toISOString() }] });
    rerender(<HistoryPanel cid="c1" path="b.ts" gitRef="HEAD" onSelectCommit={vi.fn()} onClose={vi.fn()} />);
    expect(await screen.findByText("second file")).toBeInTheDocument();
  });
});
