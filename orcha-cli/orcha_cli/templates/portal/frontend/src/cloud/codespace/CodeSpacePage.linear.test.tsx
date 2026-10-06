/**
 * Code Space — Linear pass (D5/D7/D8/D9/D12): the page runs flush inside the
 * frame with its search in the Shell toolbar, the code pane has ONE file bar
 * (crumbs + state + ref + file controls, no duplicate header), thread rows
 * are round-avatar Inbox rows with the shared status glyph, and a thread
 * reads like Linear's agent panel (user bubbles, agent text under a round
 * avatar, rounded composer with a circular send; Enter posts).
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "../../components/ui";
import { SnapshotProvider } from "../../state/SnapshotProvider";
import type { Agent } from "../../types";
import { CodeSpacePage } from "./CodeSpacePage";
import type { CodeThreadSummary } from "./codespaceTypes";
import { RecentThreadsList } from "./RecentThreadsList";
import { actorKind, threadStatusWord, ThreadStatusIcon } from "./threadBits";
import { ThreadView } from "./ThreadView";

const AGENTS = [
  { id: "h1", alias: "kedar", kind: "human", status: "idle" },
  { id: "a1", alias: "forge", kind: "ai", status: "idle" },
];
const SNAP = { container: { id: "c1", name: "Acme", status: "active", autonomy_level: "plan" }, agents: AGENTS, tasks: [], requests: [] };
const TREE_ROOT = { ref: "HEAD", path: "", entries: [{ name: "src", path: "src", type: "dir" }, { name: "a.ts", path: "a.ts", type: "file" }] };
const FILE_A = { ref: "HEAD", path: "src/a.ts", content: "const x = 1;\nconst y = 2;", size: 25, blob_sha: "blobA" };
const THREAD = {
  id: "t1", ref: "HEAD", sha: "abc1234def", path: "src/a.ts", start_line: 1, end_line: 2,
  kind: "why", status: "answered", created_at: "2026-09-01T00:00:00Z", updated_at: "2026-09-01T00:00:00Z",
  created_by_alias: "kedar", created_by_agent_id: "h1", tagged_alias: "forge", message_count: 2, blob_match: true,
  first_message: "why is x a const?",
};

type Posted = { url: string; body: unknown };
function stub(posted: Posted[] = []) {
  global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const reply = (body: unknown, status = 200) => ({ ok: status < 400, status, json: async () => body }) as unknown as Response;
    if (init?.method === "POST") {
      posted.push({ url, body: JSON.parse(String(init.body || "null")) });
      return reply({ ...THREAD }, 201);
    }
    if (url.includes("/code/worktree/available")) return reply({ available: true });
    if (url.includes("/code/worktree/branch")) return reply({ available: true, branch: "main", ahead: 0 });
    if (url.includes("/code/github/editable")) return reply({ available: false });
    if (url.includes("/github/browse/tree")) {
      const dir = new URL(url, "http://x").searchParams.get("path") || "";
      return reply(dir ? { ref: "HEAD", path: dir, entries: [{ name: "a.ts", path: "src/a.ts", type: "file" }] } : TREE_ROOT);
    }
    if (url.includes("/github/browse/file")) return reply(FILE_A);
    if (url.startsWith("/api/code/threads/")) {
      return reply({ ...THREAD, messages: [
        { id: "m1", is_human: true, author_agent_id: "h1", body: "why is x a const?", created_at: "2026-09-01T00:00:00Z" },
        { id: "m2", is_human: false, author_agent_id: "a1", body: "It never changes.", created_at: "2026-09-01T00:01:00Z" },
      ] });
    }
    if (url.includes("/code/threads")) return reply({ threads: [THREAD] });
    if (url.includes("/code/outline")) return reply({ available: true, ref: "HEAD", path: "src/a.ts", symbols: [] });
    if (url.startsWith("/api/containers/c1")) return reply(SNAP);
    if (url === "/api/containers") return reply([{ id: "c1", status: "active" }]);
    return reply({});
  }) as unknown as typeof fetch;
}

function mountPage(entry = "/code?path=src/a.ts") {
  return render(
    <ToastProvider>
      <SnapshotProvider>
        <MemoryRouter initialEntries={[entry]}>
          <CodeSpacePage />
        </MemoryRouter>
      </SnapshotProvider>
    </ToastProvider>,
  );
}

describe("Code Space — Linear frame + file bar", () => {
  beforeEach(() => { localStorage.clear(); });
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  it("puts symbol search in the named page toolbar and runs the page flush", async () => {
    stub();
    mountPage();
    const bar = await screen.findByRole("toolbar", { name: "Code Space" });
    expect(within(bar).getByPlaceholderText(/search symbols/i)).toBeInTheDocument();
    expect(within(bar).getByRole("button", { name: "Recent files" })).toBeInTheDocument();
    // wide (jsdom is unmeasured → wide): no drawer toggles
    expect(within(bar).queryByRole("button", { name: /show files/i })).toBeNull();
    expect(document.getElementById("main")?.className).toContain("is-flush");
  });

  it("wide view toggles hide the tree / rail, persist, and a gutter click brings the rail back", async () => {
    stub();
    mountPage();
    const bar = await screen.findByRole("toolbar", { name: "Code Space" });
    const railBtn = within(bar).getByRole("button", { name: "Threads panel" });
    const treeBtn = within(bar).getByRole("button", { name: "File tree" });
    expect(railBtn.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(railBtn);
    fireEvent.click(treeBtn);
    const body = document.querySelector(".cs-body") as HTMLElement;
    expect(body.className).toContain("rail-collapsed");
    expect(body.className).toContain("tree-collapsed");
    expect(JSON.parse(localStorage.getItem("orcha:cs:collapsed") || "{}")).toEqual({ tree: true, rail: true });
    // starting a thread from the gutter needs the rail — it comes back
    await screen.findByText("src/a.ts", { selector: ".rb-file-path" });
    fireEvent.click(document.querySelector('[data-cs-line="1"] .cs-gutter') as HTMLElement);
    await waitFor(() => expect(body.className).not.toContain("rail-collapsed"));
    expect(within(bar).getByRole("button", { name: "Threads panel" }).getAttribute("aria-pressed")).toBe("true");
  });

  it("has ONE file bar: crumbs, state, ref and file controls live in the Edit context row", async () => {
    stub();
    mountPage();
    await screen.findByText("src/a.ts", { selector: ".rb-file-path" });
    const bar = await screen.findByRole("group", { name: "Edit context" });
    await waitFor(() => expect(within(bar).getByRole("navigation", { name: "File path" })).toBeInTheDocument());
    await waitFor(() => expect(within(bar).getByRole("button", { name: "Edit" })).toBeInTheDocument());
    expect(within(bar).getByRole("button", { name: "Commit history" })).toBeInTheDocument();
    expect(within(bar).getByText("25 B")).toBeInTheDocument();
    // the shared chrome header carries no second copy of the crumbs/actions
    const head = document.querySelector(".rb-file-head") as HTMLElement;
    expect(head.querySelector(".cs-breadcrumbs")).toBeNull();
    expect(head.querySelector(".cs-file-actions")).toBeNull();
    // the neutral "Viewing" state is announced, not painted (the Edit toggle says it)
    expect(within(bar).getByText("Viewing").closest(".cs-ctx-state")?.className).toContain("v2-sr");
  });

  it("thread rows are Inbox rows: round author avatar, first line, status glyph with its word", async () => {
    stub();
    mountPage();
    const row = (await screen.findByText("why is x a const?", { selector: ".body-preview" })).closest(".cs-thread-chip") as HTMLElement;
    expect(row.querySelector(".v2-av")).not.toBeNull();
    expect(within(row).getByTitle("Answered").querySelector("svg")).not.toBeNull();
    expect(within(row).getByText("L1-2")).toBeInTheDocument();
    // the author is the row's avatar; the meta line names only the addressee (full pair in the tooltip)
    expect(within(row).getByText("→ @forge").getAttribute("title")).toBe("@kedar → @forge");
    // D8 kind chip: rounded chip with a dot, not coloured text
    expect(row.querySelector(".cs-kind-chip .v2-chip-dot")).not.toBeNull();
    // r2: the ~320px rail meta line never carries the message count (it was
    // hard-clipped to "3 messag") — the count lives in the tooltip + AT name
    expect(row.querySelector(".cs-thread-meta")?.textContent).not.toMatch(/message/);
    expect(row.getAttribute("title")).toBe("2 messages · started by @kedar");
    expect(row.getAttribute("aria-label")).toMatch(/, 2 messages$/);
  });
});

describe("Code Space — thread view (Linear agent panel)", () => {
  beforeEach(() => { localStorage.clear(); });
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  function mountThread() {
    return render(
      <ToastProvider>
        <SnapshotProvider>
          <ThreadView threadId="t1" onBack={vi.fn()} />
        </SnapshotProvider>
      </ToastProvider>,
    );
  }

  it("renders the human message as a user bubble and the agent reply under a round avatar", async () => {
    stub();
    mountThread();
    const human = (await screen.findByText("why is x a const?")).closest(".cs-message") as HTMLElement;
    expect(human.className).toContain("v2-msg-user");
    const agent = (await screen.findByText("It never changes.")).closest(".cs-message") as HTMLElement;
    expect(agent.className).toContain("v2-msg-agent");
    await waitFor(() => expect(within(agent).getByText("forge")).toBeInTheDocument());
    expect(agent.querySelector(".v2-av")).not.toBeNull();
    expect(screen.getByRole("log", { name: "Thread messages" })).toBeInTheDocument();
  });

  it("the reply composer sends on Enter via its circular Reply button (Shift+Enter is a newline)", async () => {
    const posted: Posted[] = [];
    stub(posted);
    mountThread();
    await screen.findByText("It never changes.");
    await waitFor(() => expect(screen.getByRole("button", { name: "Reply" })).toBeDisabled());
    const box = screen.getByLabelText(/reply to thread/i);
    fireEvent.change(box, { target: { value: "thanks" } });
    fireEvent.keyDown(box, { key: "Enter", shiftKey: true });
    expect(posted).toHaveLength(0);
    // wait for the snapshot (acting human) before posting
    await waitFor(() => expect(screen.getByRole("button", { name: "Reply" })).not.toBeDisabled());
    await new Promise((r) => setTimeout(r, 50));
    fireEvent.keyDown(box, { key: "Enter" });
    await waitFor(() => expect(posted.length).toBe(1));
    expect(posted[0].url).toContain("/api/code/threads/t1/messages");
    expect(posted[0].body).toMatchObject({ body: "thanks" });
  });
});

describe("Code Space — shared thread bits", () => {
  afterEach(cleanup);

  it("maps thread statuses onto the ONE glyph set with the exact word", () => {
    expect(threadStatusWord("open")).toBe("Open");
    expect(threadStatusWord("answered")).toBe("Answered");
    expect(threadStatusWord("resolved")).toBe("Resolved");
    render(<ThreadStatusIcon status="resolved" />);
    const icon = screen.getByTitle("Resolved");
    expect(icon.getAttribute("data-status")).toBe("closed");
    expect(icon.textContent).toBe("Resolved");
  });

  it("only claims an AI/human kind for actors the snapshot knows", () => {
    const agents = AGENTS as unknown as Agent[];
    expect(actorKind(agents, "a1")).toBe("ai");
    expect(actorKind(agents, null, "kedar")).toBe("human");
    expect(actorKind(agents, "nobody")).toBeUndefined();
    expect(actorKind(undefined, "a1")).toBeUndefined();
  });

  it("recent rows use a round avatar when the author is known, the kind icon otherwise (never an invented initial)", () => {
    const base = { ...THREAD } as unknown as CodeThreadSummary;
    const { rerender } = render(<RecentThreadsList threads={[base]} agents={AGENTS as unknown as Agent[]} />);
    expect(document.querySelector(".cs-recent-row .v2-av")).not.toBeNull();
    rerender(<RecentThreadsList threads={[{ ...base, created_by_alias: null }]} />);
    expect(document.querySelector(".cs-recent-row .v2-av")).toBeNull();
    expect(document.querySelector(".cs-recent-row .cs-kind-circle")).not.toBeNull();
  });
});
