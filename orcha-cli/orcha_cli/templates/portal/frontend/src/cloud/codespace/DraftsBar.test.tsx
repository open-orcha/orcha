/**
 * DraftsBar — the "N drafted file(s)" strip, per-file open/discard, and the
 * inline Propose panel's ok/drift/github_error flows. draftStore is backed
 * by an in-memory stub (draftStore.test.ts's precedent); fetch is stubbed
 * per-test for proposeChanges/fetchFile.
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DraftsBar } from "./DraftsBar";
import { __setDraftDbForTests, type DraftDb, listDrafts, putDraft } from "./draftStore";

interface StoredDraft { cid: string; ref: string; path: string; content: string; baseHash: string | null; savedAt: number }

function makeInMemoryDb(): DraftDb {
  const store = new Map<string, StoredDraft>();
  return {
    get: async (key) => store.get(key),
    put: async (key, value) => { store.set(key, value); },
    delete: async (key) => { store.delete(key); },
    getAll: async () => Array.from(store.values()),
  };
}

function stubFetch(handler: (url: string, init?: RequestInit) => unknown) {
  global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const data = handler(String(input), init);
    return { ok: true, status: 200, json: async () => data } as unknown as Response;
  }) as unknown as typeof fetch;
}

describe("DraftsBar", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    __setDraftDbForTests(null);
  });

  it("renders nothing when there are no drafts", () => {
    const { container } = render(
      <DraftsBar cid="c1" gitRef="HEAD" drafts={[]} onOpenDraft={vi.fn()} onDraftsChanged={vi.fn()} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("shows the drafted-file count and each path", () => {
    render(
      <DraftsBar
        cid="c1" gitRef="HEAD"
        drafts={[
          { path: "a.ts", content: "x", baseHash: "h1", savedAt: 1 },
          { path: "b.ts", content: "y", baseHash: null, savedAt: 2 },
        ]}
        onOpenDraft={vi.fn()} onDraftsChanged={vi.fn()}
      />,
    );
    expect(screen.getByText("2 drafted files")).toBeInTheDocument();
    expect(screen.getByTitle("a.ts")).toBeInTheDocument();
    expect(screen.getByTitle("b.ts")).toBeInTheDocument();
  });

  it("clicking a path calls onOpenDraft with that path", () => {
    const onOpenDraft = vi.fn();
    render(
      <DraftsBar cid="c1" gitRef="HEAD" drafts={[{ path: "a.ts", content: "x", baseHash: null, savedAt: 1 }]}
        onOpenDraft={onOpenDraft} onDraftsChanged={vi.fn()} />,
    );
    fireEvent.click(screen.getByTitle("a.ts"));
    expect(onOpenDraft).toHaveBeenCalledWith("a.ts");
  });

  it("discarding a draft deletes it from the store and notifies the caller", async () => {
    __setDraftDbForTests(makeInMemoryDb());
    await putDraft("c1", "HEAD", "a.ts", { content: "x", baseHash: null });
    const onDraftsChanged = vi.fn();
    render(
      <DraftsBar cid="c1" gitRef="HEAD" drafts={[{ path: "a.ts", content: "x", baseHash: null, savedAt: 1 }]}
        onOpenDraft={vi.fn()} onDraftsChanged={onDraftsChanged} />,
    );
    fireEvent.click(screen.getByLabelText("Discard draft for a.ts"));
    await waitFor(() => expect(onDraftsChanged).toHaveBeenCalled());
    expect(await listDrafts("c1", "HEAD")).toEqual([]);
  });

  it("opens the Propose panel and requires a message before sending", () => {
    render(
      <DraftsBar cid="c1" gitRef="HEAD" drafts={[{ path: "a.ts", content: "x", baseHash: "h1", savedAt: 1 }]}
        onOpenDraft={vi.fn()} onDraftsChanged={vi.fn()} />,
    );
    fireEvent.click(screen.getByText("Propose changes…"));
    const sendBtn = screen.getByRole("button", { name: "Propose" });
    expect(sendBtn).toBeDisabled();
    fireEvent.change(screen.getByPlaceholderText(/Short summary/), { target: { value: "Fix the bug" } });
    expect(sendBtn).not.toBeDisabled();
  });

  it("on ok: posts the drafts, clears them, and shows the PR link + hub link", async () => {
    __setDraftDbForTests(makeInMemoryDb());
    await putDraft("c1", "HEAD", "a.ts", { content: "fixed", baseHash: "h1" });
    stubFetch((url) => {
      if (url.includes("/code/github/propose")) {
        return { ok: true, pr_number: 9, pr_url: "https://github.com/o/r/pull/9", branch: "orcha/edits", commit_sha: "sha1" };
      }
      return {};
    });
    const onDraftsChanged = vi.fn();
    render(
      <DraftsBar cid="c1" gitRef="HEAD" drafts={[{ path: "a.ts", content: "fixed", baseHash: "h1", savedAt: 1 }]}
        onOpenDraft={vi.fn()} onDraftsChanged={onDraftsChanged} />,
    );
    fireEvent.click(screen.getByText("Propose changes…"));
    fireEvent.change(screen.getByPlaceholderText(/Short summary/), { target: { value: "Fix the bug" } });
    fireEvent.click(screen.getByRole("button", { name: "Propose" }));

    await screen.findByText(/PR #9/);
    expect(screen.getByRole("link", { name: /PR #9/ })).toHaveAttribute("href", "https://github.com/o/r/pull/9");
    expect(screen.getByRole("link", { name: /PR #9/ })).toHaveAttribute("target", "_blank");
    expect(screen.getByRole("link", { name: /PR #9/ })).toHaveAttribute("rel", "noopener noreferrer");
    expect(screen.getByText("Open in hub")).toHaveAttribute("href", "/github?pr=9");
    expect(onDraftsChanged).toHaveBeenCalled();
    expect(await listDrafts("c1", "HEAD")).toEqual([]);

    const [, init] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls.find(([u]) => String(u).includes("propose"))!;
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body).toEqual({ base_ref: "HEAD", message: "Fix the bug", files: [{ path: "a.ts", content: "fixed", base_hash: "h1" }] });
  });

  it("on drift: keeps the drafts and offers a per-file Reload base action", async () => {
    __setDraftDbForTests(makeInMemoryDb());
    await putDraft("c1", "HEAD", "a.ts", { content: "fixed", baseHash: "stale-hash" });
    stubFetch((url) => {
      if (url.includes("/code/github/propose")) return { ok: false, reason: "drift", paths: ["a.ts"] };
      return {};
    });
    render(
      <DraftsBar cid="c1" gitRef="HEAD" drafts={[{ path: "a.ts", content: "fixed", baseHash: "stale-hash", savedAt: 1 }]}
        onOpenDraft={vi.fn()} onDraftsChanged={vi.fn()} />,
    );
    fireEvent.click(screen.getByText("Propose changes…"));
    fireEvent.change(screen.getByPlaceholderText(/Short summary/), { target: { value: "Fix the bug" } });
    fireEvent.click(screen.getByRole("button", { name: "Propose" }));

    await screen.findByText(/stale against the latest default branch/);
    expect(screen.getByText("Reload base")).toBeInTheDocument();
    // drafts were NOT cleared
    expect(await listDrafts("c1", "HEAD")).toHaveLength(1);
  });

  it("Reload base refetches the file and rewrites the draft's baseHash", async () => {
    __setDraftDbForTests(makeInMemoryDb());
    await putDraft("c1", "HEAD", "a.ts", { content: "fixed-by-human", baseHash: "stale-hash" });
    stubFetch((url) => {
      if (url.includes("/code/github/propose")) return { ok: false, reason: "drift", paths: ["a.ts"] };
      if (url.includes("/github/browse/file")) return { ref: "HEAD", path: "a.ts", content: "latest-upstream", size: 20 };
      return {};
    });
    const onDraftsChanged = vi.fn();
    render(
      <DraftsBar cid="c1" gitRef="HEAD" drafts={[{ path: "a.ts", content: "fixed-by-human", baseHash: "stale-hash", savedAt: 1 }]}
        onOpenDraft={vi.fn()} onDraftsChanged={onDraftsChanged} />,
    );
    fireEvent.click(screen.getByText("Propose changes…"));
    fireEvent.change(screen.getByPlaceholderText(/Short summary/), { target: { value: "Fix the bug" } });
    fireEvent.click(screen.getByRole("button", { name: "Propose" }));
    await screen.findByText("Reload base");

    fireEvent.click(screen.getByText("Reload base"));
    await waitFor(() => expect(onDraftsChanged).toHaveBeenCalledTimes(1));

    const list = await listDrafts("c1", "HEAD");
    expect(list[0].content).toBe("fixed-by-human"); // human edit preserved
    expect(list[0].baseHash).toBeNull(); // reset — BrowseFilePayload carries no blob sha
  });

  it("on github_error: keeps the drafts and shows the detail", async () => {
    __setDraftDbForTests(makeInMemoryDb());
    await putDraft("c1", "HEAD", "a.ts", { content: "fixed", baseHash: "h1" });
    stubFetch((url) => {
      if (url.includes("/code/github/propose")) return { ok: false, reason: "github_error", detail: "rate limited" };
      return {};
    });
    render(
      <DraftsBar cid="c1" gitRef="HEAD" drafts={[{ path: "a.ts", content: "fixed", baseHash: "h1", savedAt: 1 }]}
        onOpenDraft={vi.fn()} onDraftsChanged={vi.fn()} />,
    );
    fireEvent.click(screen.getByText("Propose changes…"));
    fireEvent.change(screen.getByPlaceholderText(/Short summary/), { target: { value: "Fix the bug" } });
    fireEvent.click(screen.getByRole("button", { name: "Propose" }));

    await screen.findByText("rate limited");
    expect(await listDrafts("c1", "HEAD")).toHaveLength(1);
  });
});
