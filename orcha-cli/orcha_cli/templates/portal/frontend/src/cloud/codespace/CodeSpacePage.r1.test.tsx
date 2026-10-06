/**
 * Code Space — V2 screen-quality round 1: width-driven layout modes, the
 * page-level "no repository" state, the landing/rail de-duplication, the ref
 * picker, the one-line edit-context strip, the labeled Edit toggle, and the
 * Changes tab's untracked / rename rendering.
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "../../components/ui";
import { SnapshotProvider } from "../../state/SnapshotProvider";
import { ChangesTab } from "./ChangesTab";
import { CodeSpacePage } from "./CodeSpacePage";
import { EditContext } from "./EditContext";
import { loadRecentRefs, recordRecentRef } from "./RefPicker";
import { CODE_COMFORT_WIDTH, layoutFor } from "./useCodeLayout";

const SNAP = {
  container: { id: "c1", name: "Acme", status: "active", autonomy_level: "plan" },
  agents: [{ id: "h1", alias: "kedar", kind: "human", status: "idle" }],
  tasks: [],
  requests: [],
};
const TREE_ROOT = { ref: "HEAD", path: "", entries: [{ name: "a.ts", path: "a.ts", type: "file" }] };
const FILE_A = { ref: "HEAD", path: "a.ts", content: "const x = 1;", size: 12, blob_sha: "blobA" };
const RECENT = {
  threads: [
    { id: "t1", ref: "HEAD", sha: "s", path: "a.ts", start_line: 1, end_line: 1, kind: "why", status: "open", created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z", first_message: "why is this here?" },
  ],
};

type Over = (url: string) => { status?: number; body: unknown } | null;
function stub(opts: { worktree?: boolean; over?: Over } = {}) {
  global.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    const reply = (body: unknown, status = 200) => ({ ok: status < 400, status, json: async () => body }) as unknown as Response;
    const o = opts.over ? opts.over(url) : null;
    if (o) return reply(o.body, o.status ?? 200);
    if (url.includes("/code/worktree/available")) return reply({ available: !!opts.worktree });
    if (url.includes("/code/worktree/branch")) return reply({ available: false });
    if (url.includes("/code/github/editable")) return reply({ available: false });
    if (url.includes("/github/browse/tree")) return reply(TREE_ROOT);
    if (url.includes("/github/browse/file")) return reply(FILE_A);
    if (url.includes("recent=")) return reply(RECENT);
    if (url.includes("/code/threads")) return reply({ threads: [] });
    if (url.includes("/code/outline")) return reply({ available: true, ref: "HEAD", path: "a.ts", symbols: [] });
    if (url.startsWith("/api/containers/c1")) return reply(SNAP);
    if (url === "/api/containers") return reply([{ id: "c1", status: "active" }]);
    return reply({});
  }) as unknown as typeof fetch;
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

describe("layoutFor (pure)", () => {
  it("is wide with room for tree + rail + a comfortable code column, medium without the rail, narrow otherwise", () => {
    expect(layoutFor(0, 240, 300)).toBe("wide"); // unmeasured (jsdom) keeps the three-pane layout
    expect(layoutFor(240 + 300 + CODE_COMFORT_WIDTH, 240, 300)).toBe("wide");
    expect(layoutFor(876, 240, 300)).toBe("medium"); // ≈ 900 px viewport
    expect(layoutFor(358, 240, 300)).toBe("narrow"); // ≈ 390 px viewport
  });
});

describe("recent refs (RefPicker memory)", () => {
  beforeEach(() => localStorage.clear());
  it("remembers non-HEAD refs newest-first, de-duplicated, capped", () => {
    recordRecentRef("c1", "HEAD");
    recordRecentRef("c1", "v1.0");
    recordRecentRef("c1", "main");
    recordRecentRef("c1", "v1.0");
    expect(loadRecentRefs("c1")).toEqual(["v1.0", "main"]);
    for (let i = 0; i < 10; i++) recordRecentRef("c1", "r" + i);
    expect(loadRecentRefs("c1")).toHaveLength(5);
  });
});

describe("EditContext one-line strip", () => {
  afterEach(cleanup);
  it("keeps the destination sentence in the accessible text behind an info affordance, and renders a ref slot", () => {
    render(<EditContext source="worktree" gitRef="HEAD" editing={false} dirty={false} draftCount={0} refSlot={<button type="button">REFSLOT</button>} />);
    const strip = screen.getByRole("group", { name: "Edit context" });
    expect(strip.textContent).toContain("saved straight to this file in the local working tree");
    expect(screen.getByLabelText("Where edits go")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "REFSLOT" })).toBeInTheDocument();
  });
});

describe("CodeSpacePage — round 1", () => {
  beforeEach(() => { localStorage.clear(); lastSearch = ""; });
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  it("no repository connected is ONE page-level state with a primary Connect action — no tree, symbol search, or rail", async () => {
    stub({ over: (url) => (url.includes("/github/browse/tree") ? { body: { available: false, reason: "repo_not_connected", detail: "no repo" } } : null) });
    mount("/code");
    // the SAME shared component as the GitHub tab's empty state (RepoNotConnected)
    expect(await screen.findByText("No repository connected")).toBeInTheDocument();
    expect(document.querySelector(".repo-not-connected.cs-not-connected")).not.toBeNull();
    expect(screen.getByRole("link", { name: /^connect repo$/i }).getAttribute("href")).toMatch(/\/github\?connect=1/);
    expect(screen.queryByPlaceholderText(/search symbols/i)).not.toBeInTheDocument();
    expect(document.querySelector(".cs-rail")).toBeNull();
    expect(document.querySelector(".cs-tree-pane")).toBeNull();
  });

  it("landing lists recent threads once — the rail shows a hint instead of the same list", async () => {
    stub();
    mount("/code");
    await screen.findByText("why is this here?");
    expect(document.querySelectorAll(".cs-recent-row")).toHaveLength(1);
    expect(document.querySelector(".cs-rail .cs-recent-row")).toBeNull();
    // one short line; the explanation lives in the ? tooltip (D12)
    expect(document.querySelector(".cs-rail .cs-rail-hint")?.textContent).toBe("Open a file to see its threads.");
    expect(screen.getByLabelText("About code threads")).toBeInTheDocument();
  });

  it("the ref picker switches ?ref= to a typed branch / tag / SHA", async () => {
    stub();
    mount();
    const btn = await screen.findByRole("button", { name: /HEAD/ , expanded: false });
    fireEvent.click(btn);
    const input = await screen.findByLabelText("Branch, tag or commit SHA");
    fireEvent.change(input, { target: { value: "release/1.2" } });
    fireEvent.click(screen.getByRole("button", { name: "Go" }));
    await waitFor(() => expect(lastSearch).toContain("ref=release%2F1.2"));
  });

  it("the Edit toggle is a labeled pressed-state button (not an unlabeled icon)", async () => {
    stub({ worktree: true, over: (url) => (url.includes("/code/worktree/file") ? { body: { available: true, path: "a.ts", content: "x", content_hash: "h" } } : null) });
    mount();
    const edit = await screen.findByRole("button", { name: "Edit" });
    expect(edit.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(edit);
    const editing = await screen.findByRole("button", { name: "Editing" });
    expect(editing.getAttribute("aria-pressed")).toBe("true");
  });
});

describe("ChangesTab — untracked and renames", () => {
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  it("an untracked text file reads 'new file' with a U marker (never 'binary' / '??'); a rename names its origin", async () => {
    global.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      const body = url.includes("/worktree/changes")
        ? {
            available: true, dirty: true,
            files: [
              { path: "scratch/notes.txt", status: "??", additions: null, deletions: null },
              { path: "src/New.tsx", status: "R", additions: 1, deletions: 1, orig_path: "src/Old.tsx" },
              { path: "img.png", status: "M", additions: null, deletions: null, binary: true },
            ],
            summary: { files: 3, additions: 1, deletions: 1 },
          }
        : { available: false };
      return { ok: true, status: 200, json: async () => body } as unknown as Response;
    }) as unknown as typeof fetch;
    render(<ToastProvider><ChangesTab cid="c1" onOpenChange={vi.fn()} /></ToastProvider>);
    expect(await screen.findByText("new file")).toBeInTheDocument();
    expect(screen.getByLabelText("Untracked").textContent).toBe("U");
    expect(screen.queryByText("??")).not.toBeInTheDocument();
    expect(screen.getByText("renamed from src/Old.tsx")).toBeInTheDocument();
    expect(screen.getAllByText("binary")).toHaveLength(1);
  });
});
