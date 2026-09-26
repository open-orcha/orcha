/**
 * ThreadRail — the Threads tab renders a file's thread list (with the
 * "outdated — pinned to <sha7>" honesty chip when blob_match=false), opening
 * a thread swaps in ThreadView, and switching tabs mounts Live/Learn.
 */
import { useState } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "../../components/ui";
import { SnapshotProvider } from "../../state/SnapshotProvider";
import type { Agent } from "../../types";
import { ThreadRail } from "./ThreadRail";

const AGENTS: Agent[] = [
  { id: "h1", alias: "kedar", kind: "human", status: "idle" } as Agent,
  { id: "a1", alias: "forge", kind: "ai", status: "idle", role: "engineer" } as Agent,
];

const THREADS_PAYLOAD = {
  threads: [
    {
      id: "t1", ref: "HEAD", sha: "abc1234def", path: "a.ts", start_line: 3, end_line: 3,
      kind: "question", status: "open", created_at: "now", updated_at: "now", blob_match: false,
    },
    {
      id: "t2", ref: "HEAD", sha: "abc1234def", path: "a.ts", start_line: 10, end_line: 12,
      kind: "teach", status: "answered", created_at: "now", updated_at: "now", blob_match: true,
    },
  ],
};

const RECENT_PAYLOAD = {
  threads: [
    {
      id: "r1", ref: "HEAD", sha: "abc1234def", path: "b.ts", start_line: 7, end_line: 7,
      kind: "why", status: "open", created_at: "2026-08-06T12:00:00Z", updated_at: "now",
      first_message: "why is this async?",
    },
    {
      id: "r2", ref: "HEAD", sha: "abc1234def", path: "a.ts", start_line: 3, end_line: 3,
      kind: "question", status: "open", created_at: "2026-08-06T11:00:00Z", updated_at: "now",
      first_message: "how does this work?",
    },
  ],
};

function stubFetch(opts: { recent?: unknown } = {}) {
  const json = (data: unknown, status = 200) =>
    ({ ok: status < 400, status, json: async () => data }) as unknown as Response;
  global.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.startsWith("/api/containers/c1/code/threads")) {
      if (url.includes("recent=")) return json(opts.recent ?? RECENT_PAYLOAD);
      return json(THREADS_PAYLOAD);
    }
    if (url.startsWith("/api/containers/c1")) {
      return json({
        container: { id: "c1", name: "Acme", status: "active", autonomy_level: "plan" },
        agents: AGENTS,
        tasks: [],
        requests: [],
      });
    }
    if (url === "/api/containers") return json([{ id: "c1", status: "active" }]);
    return json({});
  }) as unknown as typeof fetch;
}

function mount(props: Partial<Parameters<typeof ThreadRail>[0]> = {}) {
  const defaultProps: Parameters<typeof ThreadRail>[0] = {
    cid: "c1",
    gitRef: "HEAD",
    path: "a.ts",
    agents: AGENTS,
    tab: "threads",
    onTabChange: vi.fn(),
    composerSelection: null,
    onComposerClose: vi.fn(),
    onJumpToLine: vi.fn(),
    openThreadId: null,
    onOpenThread: vi.fn(),
    raiseHand: null,
    onRaiseHandDone: vi.fn(),
    ...props,
  };
  return render(
    <ToastProvider>
      <SnapshotProvider>
        <ThreadRail {...defaultProps} />
      </SnapshotProvider>
    </ToastProvider>,
  );
}

describe("ThreadRail — Threads tab", () => {
  beforeEach(() => { localStorage.clear(); });
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  it("renders the file's threads with kind tags and the outdated honesty chip", async () => {
    stubFetch();
    mount();
    expect(await screen.findByText("Question")).toBeInTheDocument();
    expect(screen.getByText("Teach")).toBeInTheDocument();
    expect(screen.getByText(/outdated — pinned to abc1234/i)).toBeInTheDocument();
    // the answered/non-outdated thread has no outdated chip on its own chip
    expect(screen.getAllByText(/outdated/i)).toHaveLength(1);
  });

  it("clicking a thread chip opens it", async () => {
    stubFetch();
    const onOpenThread = vi.fn();
    mount({ onOpenThread });
    const chip = await screen.findByText("Question");
    fireEvent.click(chip.closest(".cs-thread-chip") as HTMLElement);
    expect(onOpenThread).toHaveBeenCalledWith("t1");
  });

  it("clicking an anchor jumps to its line without opening the thread", async () => {
    stubFetch();
    const onOpenThread = vi.fn();
    const onJumpToLine = vi.fn();
    mount({ onOpenThread, onJumpToLine });
    const anchor = await screen.findByText(":3");
    fireEvent.click(anchor);
    expect(onJumpToLine).toHaveBeenCalledWith(3);
    expect(onOpenThread).not.toHaveBeenCalled();
  });

  it("shows an empty state when the file has no threads", async () => {
    global.fetch = vi.fn(async () =>
      ({ ok: true, status: 200, json: async () => ({ threads: [] }) }) as unknown as Response,
    ) as unknown as typeof fetch;
    mount();
    expect(await screen.findByText(/no threads on this file yet/i)).toBeInTheDocument();
  });

  it("shows the composer when composerSelection is set", async () => {
    stubFetch();
    mount({ composerSelection: { start: 5, end: 5 } });
    expect(await screen.findByText(/line 5/i)).toBeInTheDocument();
  });
});

describe("ThreadRail — tabs", () => {
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  it("renders the Live tab's empty state when no agent is running", async () => {
    stubFetch();
    mount({ tab: "live" });
    expect(await screen.findByText(/no agents are running right now/i)).toBeInTheDocument();
  });

  it("renders the Learn tab", async () => {
    global.fetch = vi.fn(async () =>
      ({ ok: true, status: 200, json: async () => ({ threads: [] }) }) as unknown as Response,
    ) as unknown as typeof fetch;
    mount({ tab: "learn" });
    expect(await screen.findByText(/no teach\/why threads yet/i)).toBeInTheDocument();
  });

  it("renders an Outline tab button alongside Threads/Live/Learn", () => {
    stubFetch();
    mount();
    expect(screen.getByRole("tab", { name: "Outline" })).toBeInTheDocument();
  });

  it("renders a Changes tab button alongside Threads/Live/Learn/Outline", () => {
    stubFetch();
    mount();
    expect(screen.getByRole("tab", { name: "Changes" })).toBeInTheDocument();
  });

  it("renders the Outline tab's symbols for the open file", async () => {
    global.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith("/api/containers/c1/code/outline")) {
        return {
          ok: true, status: 200,
          json: async () => ({
            available: true, ref: "HEAD", path: "a.ts", language: "typescript",
            symbols: [{ name: "helper", kind: "function", line: 3 }],
          }),
        } as unknown as Response;
      }
      return { ok: true, status: 200, json: async () => ({}) } as unknown as Response;
    }) as unknown as typeof fetch;
    mount({ tab: "outline" });
    expect(await screen.findByText("helper")).toBeInTheDocument();
  });
});

describe("ThreadRail — Changes tab (working-tree, local run addendum)", () => {
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  it("lists dirty files and shows the summary header", async () => {
    global.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith("/api/containers/c1/code/worktree/changes")) {
        return {
          ok: true, status: 200,
          json: async () => ({
            available: true, dirty: true,
            files: [{ path: "src/a.ts", status: "M", additions: 2, deletions: 1 }],
            summary: { files: 1, additions: 2, deletions: 1 },
          }),
        } as unknown as Response;
      }
      return { ok: true, status: 200, json: async () => ({}) } as unknown as Response;
    }) as unknown as typeof fetch;
    mount({ tab: "changes" });
    expect(await screen.findByText("src/a.ts")).toBeInTheDocument();
    expect(screen.getByText("1 file changed")).toBeInTheDocument();
  });

  it("clicking a changed file calls onOpenWorktreeDiff with its path", async () => {
    global.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith("/api/containers/c1/code/worktree/changes")) {
        return {
          ok: true, status: 200,
          json: async () => ({
            available: true, dirty: true,
            files: [{ path: "src/a.ts", status: "M", additions: 2, deletions: 1 }],
            summary: { files: 1, additions: 2, deletions: 1 },
          }),
        } as unknown as Response;
      }
      return { ok: true, status: 200, json: async () => ({}) } as unknown as Response;
    }) as unknown as typeof fetch;
    const onOpenWorktreeDiff = vi.fn();
    mount({ tab: "changes", onOpenWorktreeDiff });
    const row = await screen.findByText("src/a.ts");
    fireEvent.click(row.closest(".cs-changes-row") as HTMLElement);
    expect(onOpenWorktreeDiff).toHaveBeenCalledWith("src/a.ts");
  });

  it("shows the clean-tree empty state", async () => {
    global.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith("/api/containers/c1/code/worktree/changes")) {
        return {
          ok: true, status: 200,
          json: async () => ({ available: true, dirty: false, files: [], summary: { files: 0, additions: 0, deletions: 0 } }),
        } as unknown as Response;
      }
      return { ok: true, status: 200, json: async () => ({}) } as unknown as Response;
    }) as unknown as typeof fetch;
    mount({ tab: "changes" });
    expect(await screen.findByText(/working tree clean/i)).toBeInTheDocument();
  });

  it("shows a tab-strip badge once the dirty count is known", async () => {
    global.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith("/api/containers/c1/code/worktree/changes")) {
        return {
          ok: true, status: 200,
          json: async () => ({
            available: true, dirty: true,
            files: [
              { path: "a.ts", status: "M", additions: 1, deletions: 0 },
              { path: "b.ts", status: "A", additions: 1, deletions: 0 },
            ],
            summary: { files: 2, additions: 2, deletions: 0 },
          }),
        } as unknown as Response;
      }
      return { ok: true, status: 200, json: async () => ({}) } as unknown as Response;
    }) as unknown as typeof fetch;
    mount({ tab: "changes" });
    await screen.findByText("a.ts");
    expect(await screen.findByText("2")).toBeInTheDocument();
  });
});

describe("ThreadRail — Recent quick-jump (item 3)", () => {
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  it("no file open: shows the Recent section by default, newest-first with kind glyph/loc/snippet/time", async () => {
    stubFetch();
    mount({ path: "" });
    const row1 = await screen.findByText(/b\.ts:7/);
    expect(row1).toBeInTheDocument();
    expect(screen.getByText("why is this async?")).toBeInTheDocument();
    expect(screen.getByText(/a\.ts:3/)).toBeInTheDocument();
    expect(screen.getByText("how does this work?")).toBeInTheDocument();
    // newest-first ordering: b.ts's row precedes a.ts's row in the DOM
    const rows = document.querySelectorAll(".cs-recent-row");
    expect(rows).toHaveLength(2);
    expect(rows[0].textContent).toContain("b.ts:7");
    expect(rows[1].textContent).toContain("a.ts:3");
  });

  it("a file IS open: the per-file list shows by default, with a compact Recent link", async () => {
    stubFetch();
    mount({ path: "a.ts" });
    expect(await screen.findByText("Question")).toBeInTheDocument();
    expect(screen.getByText(/recent threads/i)).toBeInTheDocument();
    expect(document.querySelector(".cs-recent-row")).toBeNull();
  });

  it("clicking the compact Recent link switches to the repo-wide Recent list", async () => {
    stubFetch();
    mount({ path: "a.ts" });
    await screen.findByText("Question");
    fireEvent.click(screen.getByText(/recent threads/i));
    expect(await screen.findByText(/b\.ts:7/)).toBeInTheDocument();
    expect(screen.getByText(/back to a\.ts/i)).toBeInTheDocument();
  });

  it("clicking a Recent row calls onNavigateToThread with that thread", async () => {
    stubFetch();
    const onNavigateToThread = vi.fn();
    mount({ path: "", onNavigateToThread });
    const row = await screen.findByText(/b\.ts:7/);
    fireEvent.click(row.closest(".cs-recent-row") as HTMLElement);
    expect(onNavigateToThread).toHaveBeenCalledWith(expect.objectContaining({ id: "r1", path: "b.ts" }));
  });

  it("shows an empty state when there are no recent threads", async () => {
    stubFetch({ recent: { threads: [] } });
    mount({ path: "" });
    expect(await screen.findByText(/no threads yet/i)).toBeInTheDocument();
  });

  it("BUG 3: switching to a different file resets showRecent back to the per-file list", async () => {
    stubFetch();
    const { rerender } = mount({ path: "a.ts" });
    await screen.findByText("Question");
    fireEvent.click(screen.getByText(/recent threads/i));
    expect(await screen.findByText(/back to a\.ts/i)).toBeInTheDocument();

    // simulate CodeSpacePage navigating to a different file (path prop changes)
    rerender(
      <ToastProvider>
        <SnapshotProvider>
          <ThreadRail
            cid="c1" gitRef="HEAD" path="b.ts" agents={AGENTS} tab="threads"
            onTabChange={vi.fn()} composerSelection={null} onComposerClose={vi.fn()}
            onJumpToLine={vi.fn()} openThreadId={null} onOpenThread={vi.fn()}
            raiseHand={null} onRaiseHandDone={vi.fn()}
          />
        </SnapshotProvider>
      </ToastProvider>,
    );

    // must NOT still show the repo-wide "Recent threads (all files)" state —
    // it should be back to b.ts's own per-file list (with its own compact
    // Recent link, not the "back to a.ts" link from before).
    expect(screen.queryByText(/back to a\.ts/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/b\.ts:7/)).not.toBeInTheDocument();
  });
});

describe("ThreadRail — optimistic post-to-conversation (item 5)", () => {
  beforeEach(() => { localStorage.clear(); });
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  it("posting a new thread swaps straight into its ThreadView, seeded with the posted message, no extra click", async () => {
    global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method || "GET";
      if (url.startsWith("/api/containers/c1/code/threads") && method === "POST") {
        return {
          ok: true, status: 201,
          // real wire: flat thread row only — the api wrapper synthesizes
          // the seeded message from the posted body.
          json: async () => ({
            id: "new1", ref: "HEAD", sha: "deadbee", path: "a.ts", start_line: 5, end_line: 5,
            kind: "question", status: "open", created_at: "now", updated_at: "now",
          }),
        } as unknown as Response;
      }
      if (url.startsWith("/api/containers/c1/code/threads")) {
        return { ok: true, status: 200, json: async () => THREADS_PAYLOAD } as unknown as Response;
      }
      if (url.startsWith("/api/code/threads/new1")) {
        // the poll/GET path — deliberately slow-ish in spirit; the seed must
        // already be on screen before this ever resolves in the test.
        return { ok: true, status: 200, json: async () => ({
          id: "new1", ref: "HEAD", sha: "deadbee", path: "a.ts", start_line: 5, end_line: 5,
          kind: "question", status: "open", created_at: "now", updated_at: "now",
          messages: [{ id: "m1", is_human: true, body: "How does auth work here?", created_at: "now" }],
        }) } as unknown as Response;
      }
      if (url.startsWith("/api/containers/c1")) {
        return {
          ok: true, status: 200,
          json: async () => ({
            container: { id: "c1", name: "Acme", status: "active", autonomy_level: "plan" },
            agents: AGENTS, tasks: [], requests: [],
          }),
        } as unknown as Response;
      }
      if (url === "/api/containers") return { ok: true, status: 200, json: async () => [{ id: "c1", status: "active" }] } as unknown as Response;
      return { ok: true, status: 200, json: async () => ({}) } as unknown as Response;
    }) as unknown as typeof fetch;

    const onOpenThread = vi.fn();
    // ThreadRail is a controlled component (the parent, CodeSpacePage, owns
    // openThreadId) — a thin stateful wrapper here plays that parent role so
    // the "swap to ThreadView on post" behavior is observable end-to-end,
    // exactly like CodeSpacePage really wires it.
    function Harness() {
      const [openThreadId, setOpenThreadId] = useState<string | null>(null);
      const [composerSelection, setComposerSelection] = useState<{ start: number; end: number } | null>({ start: 5, end: 5 });
      return (
        <ThreadRail
          cid="c1" gitRef="HEAD" path="a.ts" agents={AGENTS} tab="threads"
          onTabChange={vi.fn()}
          composerSelection={composerSelection}
          onComposerClose={() => setComposerSelection(null)}
          onJumpToLine={vi.fn()}
          openThreadId={openThreadId}
          onOpenThread={(id: string | null) => { onOpenThread(id); setOpenThreadId(id); }}
          raiseHand={null}
          onRaiseHandDone={vi.fn()}
        />
      );
    }
    render(
      <ToastProvider>
        <SnapshotProvider>
          <Harness />
        </SnapshotProvider>
      </ToastProvider>,
    );
    await screen.findByText(/line 5/i);
    fireEvent.change(screen.getByLabelText(/thread message/i), { target: { value: "How does auth work here?" } });
    fireEvent.click(screen.getByText("Post"));

    // seeded straight into ThreadView — the posted message is visible without
    // an extra click or waiting for the poll.
    // seeded straight into ThreadView — the posted message is visible without
    // an extra click or waiting for the poll. Scope the query to a message
    // bubble specifically: the composer's OWN textarea is a React-controlled
    // element whose value also renders as a text-node child, so an unscoped
    // queryByText would false-positive-match the still-mounted composer
    // before the real swap to ThreadView happens.
    const message = await screen.findByText(
      "How does auth work here?",
      { selector: ".cs-message-body" },
    );
    expect(message).toBeInTheDocument();
    expect(onOpenThread).toHaveBeenCalledWith("new1");
  });
});
