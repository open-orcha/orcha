/**
 * LearnTab — repo-wide teach|why aggregation (the list endpoint WITHOUT a
 * ?path= filter), grouped by path, filterable by kind/agent, opening a
 * thread swaps in the full ThreadView reading surface.
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "../../components/ui";
import { SnapshotProvider } from "../../state/SnapshotProvider";
import type { Agent } from "../../types";
import { LearnTab } from "./LearnTab";

const AGENTS: Agent[] = [
  { id: "h1", alias: "kedar", kind: "human", status: "idle" } as Agent,
  { id: "a1", alias: "forge", kind: "ai", status: "idle", role: "engineer" } as Agent,
];

const THREADS = [
  { id: "t1", ref: "HEAD", sha: "aaa", path: "src/a.ts", start_line: 1, end_line: 1, kind: "teach", status: "resolved", created_by_agent_id: "a1", created_at: "now", updated_at: "now" },
  { id: "t2", ref: "HEAD", sha: "aaa", path: "src/a.ts", start_line: 5, end_line: 5, kind: "why", status: "answered", tagged_agent_id: "a1", created_at: "now", updated_at: "now" },
  { id: "t3", ref: "HEAD", sha: "bbb", path: "src/b.ts", start_line: 2, end_line: 2, kind: "question", status: "open", created_at: "now", updated_at: "now" },
  { id: "t4", ref: "HEAD", sha: "ccc", path: "src/c.ts", start_line: 9, end_line: 9, kind: "note", status: "open", created_at: "now", updated_at: "now" },
];

function stubFetch() {
  const json = (data: unknown) => ({ ok: true, status: 200, json: async () => data }) as unknown as Response;
  global.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.startsWith("/api/code/threads/")) {
      const tid = url.split("/").pop() as string;
      const thread = THREADS.find((t) => t.id === tid);
      return json({ thread, messages: [] });
    }
    if (url.startsWith("/api/containers/c1/code/threads")) return json({ threads: THREADS });
    if (url.startsWith("/api/containers/c1")) {
      return json({ container: { id: "c1", name: "Acme", status: "active", autonomy_level: "plan" }, agents: AGENTS, tasks: [], requests: [] });
    }
    if (url === "/api/containers") return json([{ id: "c1", status: "active" }]);
    return json({});
  }) as unknown as typeof fetch;
}

function mount() {
  return render(
    <ToastProvider>
      <SnapshotProvider>
        <LearnTab cid="c1" agents={AGENTS} />
      </SnapshotProvider>
    </ToastProvider>,
  );
}

describe("LearnTab", () => {
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  it("aggregates only teach|why threads, grouped by path (question/note excluded)", async () => {
    stubFetch();
    mount();
    expect(await screen.findByText("src/a.ts")).toBeInTheDocument();
    const kindTags = Array.from(document.querySelectorAll(".kind-tag")).map((el) => el.textContent);
    expect(kindTags.sort()).toEqual(["Teach", "Why"]);
    // question (t3) / note (t4) threads are excluded from Learn
    expect(screen.queryByText("src/b.ts")).not.toBeInTheDocument();
    expect(screen.queryByText("src/c.ts")).not.toBeInTheDocument();
  });

  it("filters by kind", async () => {
    stubFetch();
    mount();
    await screen.findByText("src/a.ts");
    expect(document.querySelectorAll(".kind-tag")).toHaveLength(2); // teach (t1) + why (t2)
    fireEvent.click(screen.getByRole("button", { name: "Why" }));
    const tags = document.querySelectorAll(".kind-tag");
    expect(tags).toHaveLength(1);
    expect(tags[0].textContent).toBe("Why");
  });

  it("filters by agent", async () => {
    stubFetch();
    mount();
    await screen.findByText("src/a.ts");
    fireEvent.change(screen.getByLabelText(/filter by agent/i), { target: { value: "a1" } });
    // both t1 (created_by a1) and t2 (tagged a1) match — group still present
    expect(screen.getByText("src/a.ts")).toBeInTheDocument();
  });

  it("opening a thread swaps in the full ThreadView reading surface", async () => {
    stubFetch();
    mount();
    await screen.findByText("src/a.ts");
    const chip = document.querySelector(".cs-thread-chip") as HTMLElement;
    fireEvent.click(chip);
    expect(await screen.findByText(/back to threads/i)).toBeInTheDocument();
  });

  it("shows an empty state when there are no teach/why threads", async () => {
    global.fetch = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ threads: [] }) }) as unknown as Response) as unknown as typeof fetch;
    mount();
    expect(await screen.findByText(/no teach\/why threads yet/i)).toBeInTheDocument();
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
