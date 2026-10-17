/**
 * LearnTab — repo-wide teach|why library (the ?recent= list mode), grouped by
 * path, searchable + filterable by kind/agent; file-aware quick starts that
 * create REAL teach/why threads; opening a lesson swaps in LessonView.
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "../../components/ui";
import { SnapshotProvider } from "../../state/SnapshotProvider";
import type { Agent } from "../../types";
import { LearnTab, type LearnTabProps } from "./LearnTab";
import { _resetLessonTitles } from "./lessonTitles";

const AGENTS: Agent[] = [
  { id: "h1", alias: "kedar", kind: "human", status: "idle" } as Agent,
  { id: "a1", alias: "forge", kind: "ai", status: "idle", role: "engineer" } as Agent,
  { id: "a2", alias: "atlas", kind: "ai", status: "idle", role: "architect" } as Agent,
];

const THREADS = [
  { id: "t1", ref: "HEAD", sha: "aaa", path: "src/a.ts", start_line: 1, end_line: 1, kind: "teach", status: "resolved", created_by_agent_id: "h1", tagged_agent_id: "a1", tagged_alias: "forge", first_message: "Teach me how the cache works.", created_at: "now", updated_at: "now" },
  { id: "t2", ref: "HEAD", sha: "aaa", path: "src/a.ts", start_line: 5, end_line: 5, kind: "why", status: "answered", tagged_agent_id: "a2", tagged_alias: "atlas", first_message: "Why is the retry capped at three?", created_at: "now", updated_at: "now" },
  { id: "t3", ref: "HEAD", sha: "bbb", path: "src/b.ts", start_line: 2, end_line: 2, kind: "question", status: "open", created_at: "now", updated_at: "now" },
  { id: "t4", ref: "HEAD", sha: "ccc", path: "src/c.ts", start_line: 9, end_line: 9, kind: "note", status: "open", created_at: "now", updated_at: "now" },
];

interface Call { url: string; method: string; body: Record<string, unknown> | null }

function stubFetch(opts: { threads?: unknown[]; detail?: Record<string, unknown> } = {}): Call[] {
  const calls: Call[] = [];
  const json = (data: unknown, status = 200) => ({ ok: status < 400, status, json: async () => data }) as unknown as Response;
  global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method || "GET";
    calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : null });
    if (url.startsWith("/api/code/threads/")) {
      const tid = url.split("/").pop() as string;
      if (opts.detail) return json(opts.detail);
      const thread = THREADS.find((t) => t.id === tid);
      return json({ ...thread, messages: [] });
    }
    if (url.startsWith("/api/containers/c1/code/threads")) {
      if (method === "POST") {
        const b = JSON.parse(String(init!.body));
        return json({ id: "new1", ref: "HEAD", sha: "abc", path: b.path, start_line: b.start_line, end_line: b.end_line, kind: b.kind, status: "open", tagged_agent_id: b.tagged_agent_id, tagged_alias: "forge", created_at: "now", updated_at: "now" }, 201);
      }
      return json({ threads: opts.threads ?? THREADS });
    }
    if (url.startsWith("/api/containers/c1")) {
      return json({ container: { id: "c1", name: "Acme", status: "active", autonomy_level: "plan" }, agents: AGENTS, tasks: [], requests: [] });
    }
    if (url === "/api/containers") return json([{ id: "c1", status: "active" }]);
    return json({});
  }) as unknown as typeof fetch;
  return calls;
}

function mount(props: Partial<LearnTabProps> = {}) {
  return render(
    <ToastProvider>
      <SnapshotProvider>
        <LearnTab cid="c1" agents={AGENTS} {...props} />
      </SnapshotProvider>
    </ToastProvider>,
  );
}

const posts = (calls: Call[]) => calls.filter((c) => c.method === "POST" && c.url === "/api/containers/c1/code/threads");

describe("LearnTab — library", () => {
  beforeEach(() => { localStorage.clear(); _resetLessonTitles(); });
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  it("aggregates only teach|why threads, grouped by path (question/note excluded)", async () => {
    stubFetch();
    mount();
    expect(await screen.findByText("src/a.ts")).toBeInTheDocument();
    const kindTags = Array.from(document.querySelectorAll(".cs-learn-library .kind-tag")).map((el) => el.textContent);
    expect(kindTags.sort()).toEqual(["Teach", "Why"]);
    expect(screen.queryByText("src/b.ts")).not.toBeInTheDocument();
    expect(screen.queryByText("src/c.ts")).not.toBeInTheDocument();
  });

  it("rows read as lessons: a title from the question, file:lines, the answering agent", async () => {
    stubFetch();
    mount();
    expect(await screen.findByText("Teach me how the cache works")).toBeInTheDocument();
    expect(screen.getByText("Why is the retry capped at three?")).toBeInTheDocument();
    expect(screen.getByText("a.ts:5")).toBeInTheDocument();
    expect(document.querySelector(".cs-learn-library .cs-thread-who")?.textContent).toBe("@forge");
  });

  it("a remembered lesson title replaces the question title", async () => {
    localStorage.setItem("orcha:cs:lesson-titles", JSON.stringify({ t2: "Why retries stop at three" }));
    _resetLessonTitles();
    stubFetch();
    mount();
    expect(await screen.findByText("Why retries stop at three")).toBeInTheDocument();
  });

  it("filters by kind", async () => {
    stubFetch();
    mount();
    await screen.findByText("src/a.ts");
    expect(document.querySelectorAll(".cs-learn-library .kind-tag")).toHaveLength(2);
    fireEvent.click(screen.getByRole("radio", { name: "Why" }));
    const tags = document.querySelectorAll(".cs-learn-library .kind-tag");
    expect(tags).toHaveLength(1);
    expect(tags[0].textContent).toBe("Why");
  });

  it("filters by agent", async () => {
    stubFetch();
    mount();
    await screen.findByText("src/a.ts");
    fireEvent.change(screen.getByLabelText(/filter by agent/i), { target: { value: "a2" } });
    expect(screen.getByText("Why is the retry capped at three?")).toBeInTheDocument();
    expect(screen.queryByText("Teach me how the cache works")).not.toBeInTheDocument();
  });

  it("searches titles and questions", async () => {
    stubFetch();
    mount();
    await screen.findByText("src/a.ts");
    fireEvent.change(screen.getByLabelText(/search lessons/i), { target: { value: "retry" } });
    expect(screen.getByText("Why is the retry capped at three?")).toBeInTheDocument();
    expect(screen.queryByText("Teach me how the cache works")).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(/search lessons/i), { target: { value: "zzz" } });
    expect(screen.getByText(/no lessons match/i)).toBeInTheDocument();
  });

  it("opening a lesson swaps in the lesson view (waiting while unanswered)", async () => {
    stubFetch();
    mount();
    await screen.findByText("src/a.ts");
    fireEvent.click(document.querySelector(".cs-lesson-row") as HTMLElement);
    expect(await screen.findByRole("button", { name: /library/i })).toBeInTheDocument();
    // t1 has no agent answer yet → the honest waiting state
    await waitFor(() => expect(document.querySelector(".cs-lesson-waiting")?.textContent).toMatch(/@forge/));
  });

  it("the empty library is an inviting hero, not a bare line", async () => {
    stubFetch({ threads: [] });
    mount({ path: "src/shell/Shell.tsx", lineCount: 40 });
    expect(await screen.findByText(/learn this codebase/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /explain this file/i })).toBeInTheDocument();
    expect(screen.queryByLabelText(/search lessons/i)).not.toBeInTheDocument();
  });
});

describe("LearnTab — quick starts", () => {
  beforeEach(() => { localStorage.clear(); _resetLessonTitles(); });
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  it("offers file + selection aware quick starts", async () => {
    stubFetch({ threads: [] });
    mount({ path: "src/shell/Shell.tsx", lineCount: 40, selection: { start: 19, end: 28 } });
    expect(await screen.findByRole("button", { name: /teach me the concept at lines 19–28/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /explain this file/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /why does this exist/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /give me a tour of src\/shell\//i })).toBeInTheDocument();
  });

  it("'Explain this file' creates a real teach thread anchored to the whole file, asking the default agent", async () => {
    const calls = stubFetch({ threads: [] });
    mount({ path: "src/shell/Shell.tsx", lineCount: 40 });
    const btn = await screen.findByRole("button", { name: /explain this file/i });
    await waitFor(() => expect(btn).not.toBeDisabled());
    fireEvent.click(btn);
    await waitFor(() => expect(posts(calls)).toHaveLength(1));
    expect(posts(calls)[0].body).toEqual({
      ref: "HEAD",
      path: "src/shell/Shell.tsx",
      start_line: 1,
      end_line: 40,
      kind: "teach",
      body: "Explain src/shell/Shell.tsx: what it does, how it is structured, and the key lines to read first.",
      tagged_agent_id: "a1",
      actor_agent_id: "h1",
    });
    // straight into the lesson (waiting) view
    expect(await screen.findByRole("button", { name: /library/i })).toBeInTheDocument();
  });

  it("the selection quick start anchors to the selected lines; the @agent picker is honoured", async () => {
    const calls = stubFetch({ threads: [] });
    mount({ path: "src/shell/Shell.tsx", lineCount: 40, selection: { start: 19, end: 28 } });
    const btn = await screen.findByRole("button", { name: /teach me the concept at lines 19–28/i });
    await waitFor(() => expect(btn).not.toBeDisabled());
    fireEvent.change(screen.getByLabelText(/ask which agent/i), { target: { value: "a2" } });
    fireEvent.click(btn);
    await waitFor(() => expect(posts(calls)).toHaveLength(1));
    expect(posts(calls)[0].body).toMatchObject({ kind: "teach", path: "src/shell/Shell.tsx", start_line: 19, end_line: 28, tagged_agent_id: "a2" });
  });

  it("'Why does this exist?' creates a why thread", async () => {
    const calls = stubFetch({ threads: [] });
    mount({ path: "src/a.ts", lineCount: 10 });
    const btn = await screen.findByRole("button", { name: /why does this exist/i });
    await waitFor(() => expect(btn).not.toBeDisabled());
    fireEvent.click(btn);
    await waitFor(() => expect(posts(calls)).toHaveLength(1));
    expect(posts(calls)[0].body).toMatchObject({ kind: "why", path: "src/a.ts", start_line: 1, end_line: 1 });
  });

  it("controlled mode reports the created lesson to the page", async () => {
    stubFetch({ threads: [] });
    const onOpenLesson = vi.fn();
    mount({ path: "src/a.ts", lineCount: 10, openLessonId: null, onOpenLesson });
    const btn = await screen.findByRole("button", { name: /give me a tour/i });
    await waitFor(() => expect(btn).not.toBeDisabled());
    fireEvent.click(btn);
    await waitFor(() => expect(onOpenLesson).toHaveBeenCalledWith(expect.objectContaining({ id: "new1", kind: "teach" })));
  });
});

it("REGRESSION (Learn black-screen): fetches via the recent mode, never the pathless counts shape", async () => {
  const calls: string[] = [];
  global.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);
    if (url.includes("/code/threads")) {
      // pathless WITHOUT recent returns {by_path} — that shape crashed the rail once.
      if (!url.includes("recent=")) return { ok: true, status: 200, json: async () => ({ by_path: [] }) } as unknown as Response;
      return { ok: true, status: 200, json: async () => ({ threads: [] }) } as unknown as Response;
    }
    if (String(input) === "/api/containers") return { ok: true, status: 200, json: async () => [{ id: "c1", status: "active" }] } as unknown as Response;
    return { ok: true, status: 200, json: async () => ({ container: { id: "c1" }, agents: [], tasks: [], requests: [] }) } as unknown as Response;
  }) as unknown as typeof fetch;
  mount();
  await vi.waitFor(() => {
    const threadCalls = calls.filter((u) => u.includes("/code/threads"));
    expect(threadCalls.length).toBeGreaterThan(0);
    threadCalls.forEach((u) => expect(u).toContain("recent="));
  });
});
