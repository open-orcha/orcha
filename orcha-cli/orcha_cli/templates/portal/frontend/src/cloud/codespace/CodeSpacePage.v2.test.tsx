/**
 * Code Space V2 (parity C-02, C-03, C-13, C-14, C-15): the edit-context strip
 * makes source / ref / state / destination explicit for BOTH edit flows, the
 * pane dividers and tree work from the keyboard, the file error state offers
 * Retry, and a 200 {available:false} browse answer is never an empty repo.
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "../../components/ui";
import { SnapshotProvider } from "../../state/SnapshotProvider";
import { CodeSpacePage } from "./CodeSpacePage";
import { destinationText, EditContext } from "./EditContext";

const SNAP = {
  container: { id: "c1", name: "Acme", status: "active", autonomy_level: "plan" },
  agents: [{ id: "h1", alias: "kedar", kind: "human", status: "idle" }],
  tasks: [],
  requests: [],
};
const TREE_ROOT = {
  ref: "HEAD", path: "",
  entries: [
    { name: "src", path: "src", type: "dir" },
    { name: "a.ts", path: "a.ts", type: "file" },
    { name: "b.ts", path: "b.ts", type: "file" },
  ],
};
const FILE_A = { ref: "HEAD", path: "a.ts", content: "const x = 1;", size: 12, blob_sha: "blobA" };

type Over = (url: string) => { status?: number; body: unknown } | null;
function stub(opts: { worktree?: boolean; editable?: boolean; branch?: string | null; over?: Over } = {}) {
  const calls: string[] = [];
  global.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);
    const o = opts.over ? opts.over(url) : null;
    const reply = (body: unknown, status = 200) => ({ ok: status < 400, status, json: async () => body }) as unknown as Response;
    if (o) return reply(o.body, o.status ?? 200);
    if (url.includes("/code/worktree/available")) return reply({ available: !!opts.worktree });
    if (url.includes("/code/worktree/branch")) return reply(opts.branch ? { available: true, branch: opts.branch, ahead: 0 } : { available: false });
    if (url.includes("/code/github/editable")) return reply({ available: !!opts.editable });
    if (url.includes("/github/browse/tree")) return reply(TREE_ROOT);
    if (url.includes("/github/browse/file")) return reply(FILE_A);
    if (url.includes("/code/threads")) return reply({ threads: [] });
    if (url.includes("/code/outline")) return reply({ available: true, ref: "HEAD", path: "a.ts", symbols: [] });
    if (url.startsWith("/api/containers/c1")) return reply(SNAP);
    if (url === "/api/containers") return reply([{ id: "c1", status: "active" }]);
    return reply({});
  }) as unknown as typeof fetch;
  return calls;
}

let lastSearch = "";
function Loc() {
  lastSearch = useLocation().search;
  return null;
}
function mount(entry = "/code?path=a.ts") {
  return render(
    <ToastProvider>
      <SnapshotProvider>
        <MemoryRouter initialEntries={[entry]}>
          <CodeSpacePage />
          <Loc />
        </MemoryRouter>
      </SnapshotProvider>
    </ToastProvider>,
  );
}

describe("EditContext (pure)", () => {
  afterEach(cleanup);

  it("names a distinct destination for each flow and never offers a default-branch write", () => {
    expect(destinationText({ source: "worktree", gitRef: "HEAD" })).toMatch(/local working tree/);
    const gh = destinationText({ source: "github", gitRef: "HEAD" });
    expect(gh).toMatch(/draft in this browser/);
    expect(gh).toMatch(/new branch and pull request/);
    expect(gh).toMatch(/default branch is never written directly/);
    expect(destinationText({ source: "readonly", gitRef: "HEAD" })).toMatch(/Read-only/);
    // a pinned ref is read-only whatever the source
    expect(destinationText({ source: "worktree", gitRef: "abc1234def5678" })).toMatch(/Historical version — read-only/);
    expect(destinationText({ source: "github", gitRef: "abc1234def5678" })).toMatch(/Historical version — read-only/);
  });

  it("shows the real local branch, dirty state, and Back to HEAD for a pinned ref", () => {
    const back = vi.fn();
    const { rerender } = render(
      <EditContext source="worktree" gitRef="HEAD" branch="feat/x" editing dirty draftCount={0} />,
    );
    expect(screen.getByText("Local worktree")).toBeInTheDocument();
    expect(screen.getByText("feat/x (HEAD)")).toBeInTheDocument();
    expect(screen.getByText("Unsaved changes — autosaving")).toBeInTheDocument();
    rerender(<EditContext source="worktree" gitRef="HEAD" branch="feat/x" editing dirty={false} draftCount={0} />);
    expect(screen.getByText("Saved to working tree")).toBeInTheDocument();
    rerender(<EditContext source="github" gitRef="0123456789abcdef0123" editing={false} dirty={false} draftCount={2} onBackToHead={back} />);
    expect(screen.getByText("Pinned 0123456")).toBeInTheDocument();
    expect(screen.getByText("2 drafts not proposed")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Back to HEAD" }));
    expect(back).toHaveBeenCalledTimes(1);
  });
});

describe("CodeSpacePage V2", () => {
  beforeEach(() => { localStorage.clear(); lastSearch = ""; });
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  it("local-binding project: the strip says Local worktree + the real branch + worktree destination", async () => {
    stub({ worktree: true, branch: "main" });
    mount();
    const strip = await screen.findByRole("group", { name: "Edit context" });
    expect(strip.textContent).toContain("Local worktree");
    await waitFor(() => expect(strip.textContent).toContain("main (HEAD)"));
    expect(strip.textContent).toContain("saved straight to this file in the local working tree");
  });

  it("GitHub-bound editable project: the strip says draft & propose, never a direct write", async () => {
    stub({ worktree: false, editable: true });
    mount();
    const strip = await screen.findByRole("group", { name: "Edit context" });
    await waitFor(() => expect(strip.textContent).toContain("GitHub · draft & propose"));
    expect(strip.textContent).toContain("default branch is never written directly");
    // no invented branch name for a GitHub binding
    expect(strip.textContent).not.toMatch(/\(HEAD\)/);
  });

  it("read-only project: the strip says Read-only and no Edit toggle is offered", async () => {
    stub({ worktree: false, editable: false });
    mount();
    const strip = await screen.findByRole("group", { name: "Edit context" });
    await waitFor(() => expect(strip.textContent).toContain("Read-only"));
    expect(screen.queryByRole("button", { name: /edit this file/i })).not.toBeInTheDocument();
  });

  it("pinned ref: Back to HEAD returns ?ref= to HEAD", async () => {
    stub({ worktree: true });
    mount("/code?path=a.ts&ref=0123456789abcdef0123456789abcdef01234567");
    fireEvent.click(await screen.findByRole("button", { name: "Back to HEAD" }));
    await waitFor(() => expect(lastSearch).toContain("ref=HEAD"));
  });

  it("pane dividers are focusable separators that resize from the keyboard", async () => {
    stub();
    mount();
    const sep = await screen.findByRole("separator", { name: "Resize file tree pane" });
    expect(sep.getAttribute("tabindex")).toBe("0");
    const before = Number(sep.getAttribute("aria-valuenow"));
    fireEvent.keyDown(sep, { key: "ArrowRight" });
    await waitFor(() => expect(Number(sep.getAttribute("aria-valuenow"))).toBe(before + 16));
    fireEvent.keyDown(sep, { key: "Home" });
    await waitFor(() => expect(Number(sep.getAttribute("aria-valuenow"))).toBe(240));
  });

  it("tree rows are treeitems: ArrowDown moves focus, Enter opens a file", async () => {
    stub();
    mount("/code");
    await screen.findByRole("tree", { name: "Repository files" });
    const items = await screen.findAllByRole("treeitem");
    expect(items).toHaveLength(3);
    // the caret glyph is aria-hidden: accessible names are the plain entry names
    expect(screen.getByRole("treeitem", { name: "src" }).getAttribute("aria-expanded")).toBe("false");
    expect(items[1]).toBe(screen.getByRole("treeitem", { name: "a.ts" }));
    items[0].focus();
    fireEvent.keyDown(items[0], { key: "ArrowDown" });
    expect(document.activeElement).toBe(items[1]);
    fireEvent.keyDown(items[1], { key: "Enter" });
    await waitFor(() => expect(lastSearch).toContain("path=a.ts"));
  });

  it("a 200 {available:false, reason:rate_limited} tree renders the rate-limit state with Retry (not 'No files.')", async () => {
    let limited = true;
    stub({
      over: (url) => (url.includes("/github/browse/tree") && limited
        ? { body: { available: false, reason: "rate_limited", detail: "GitHub rate limit or access forbidden (403)", repo: "acme/app" } }
        : null),
    });
    mount("/code");
    expect(await screen.findByText("GitHub rate limit hit")).toBeInTheDocument();
    expect(screen.queryByText("No files.")).not.toBeInTheDocument();
    limited = false;
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("b.ts")).toBeInTheDocument();
  });

  it("a failed file read offers Retry that re-fetches the file", async () => {
    let fail = true;
    const calls = stub({
      over: (url) => (url.includes("/github/browse/file") && fail
        ? { body: { available: false, reason: "unreachable", detail: "could not reach GitHub" } }
        : null),
    });
    mount();
    expect(await screen.findByText("could not reach GitHub")).toBeInTheDocument();
    fail = false;
    const n = calls.filter((u) => u.includes("/github/browse/file")).length;
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await screen.findByText("a.ts", { selector: ".rb-file-path" });
    expect(calls.filter((u) => u.includes("/github/browse/file")).length).toBe(n + 1);
  });

  it("rail tabs follow the ARIA tabs keyboard model", async () => {
    stub();
    mount();
    const threads = await screen.findByRole("tab", { name: "Threads" });
    expect(threads.getAttribute("tabindex")).toBe("0");
    threads.focus();
    fireEvent.keyDown(threads, { key: "ArrowRight" });
    await waitFor(() => expect(screen.getByRole("tab", { name: "Live" }).getAttribute("aria-selected")).toBe("true"));
    expect(document.activeElement).toBe(screen.getByRole("tab", { name: "Live" }));
    fireEvent.keyDown(document.activeElement as Element, { key: "End" });
    await waitFor(() => expect(screen.getByRole("tab", { name: /Changes/ }).getAttribute("aria-selected")).toBe("true"));
  });
});
