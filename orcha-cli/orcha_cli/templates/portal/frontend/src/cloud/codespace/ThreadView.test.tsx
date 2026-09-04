/**
 * ThreadView — messages/reply/resolve, the "outdated" honesty chip, the item-5
 * optimistic seed + reply, and the item-2 "via request <id>" bidirectional
 * chip (the reverse direction of the wake payload's portal deep-link).
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "../../components/ui";
import { SnapshotProvider } from "../../state/SnapshotProvider";
import type { CodeThreadDetailPayload } from "./codespaceTypes";
import { ThreadView } from "./ThreadView";

const AGENTS = [
  { id: "h1", alias: "kedar", kind: "human", status: "idle" },
  { id: "a1", alias: "forge", kind: "ai", status: "idle", role: "engineer" },
];

const THREAD_DETAIL = {
  thread: {
    id: "t1", ref: "HEAD", sha: "abc1234def", path: "a.ts", start_line: 3, end_line: 3,
    kind: "question", status: "open", created_at: "now", updated_at: "now",
  },
  messages: [
    { id: "m1", is_human: true, body: "how does this work?", created_at: "now" },
  ],
};

function stubFetch(overrides: { detail?: unknown } = {}) {
  const json = (data: unknown, status = 200) =>
    ({ ok: status < 400, status, json: async () => data }) as unknown as Response;
  global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method || "GET";
    if (url.startsWith("/api/code/threads/") && !url.includes("/messages")) {
      const d = (overrides.detail ?? THREAD_DETAIL) as { thread?: object; messages?: unknown[] };
      // real wire: FLAT thread + inline messages
      return json(d.thread ? { ...d.thread, messages: d.messages ?? [] } : d);
    }
    if (url.includes("/messages") && method === "POST") {
      return json({ ...THREAD_DETAIL.thread }, 201); // real wire: flat thread row only
    }
    if (url.startsWith("/api/containers/c1")) {
      return json({
        container: { id: "c1", name: "Acme", status: "active", autonomy_level: "plan" },
        agents: AGENTS, tasks: [], requests: [],
      });
    }
    if (url === "/api/containers") return json([{ id: "c1", status: "active" }]);
    return json({});
  }) as unknown as typeof fetch;
}

function mount(props: Partial<Parameters<typeof ThreadView>[0]> = {}) {
  const defaultProps: Parameters<typeof ThreadView>[0] = {
    threadId: "t1",
    onBack: vi.fn(),
    ...props,
  };
  return render(
    <ToastProvider>
      <SnapshotProvider>
        <ThreadView {...defaultProps} />
      </SnapshotProvider>
    </ToastProvider>,
  );
}

describe("ThreadView", () => {
  beforeEach(() => { localStorage.clear(); });
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  it("fetches and renders the thread's messages", async () => {
    stubFetch();
    mount();
    expect(await screen.findByText("how does this work?")).toBeInTheDocument();
    expect(screen.getByText("Question")).toBeInTheDocument();
  });

  it("item 2: renders a 'via request <id>' chip linking to /requests?req= when request_id is set", async () => {
    stubFetch({
      detail: {
        thread: { ...THREAD_DETAIL.thread, request_id: "11111111-2222-3333-4444-555555555555" },
        messages: THREAD_DETAIL.messages,
      },
    });
    mount();
    const chip = await screen.findByText(/via request 11111111/i);
    expect(chip.getAttribute("href")).toBe("/requests?req=11111111-2222-3333-4444-555555555555");
  });

  it("no request_id: no request chip is rendered", async () => {
    stubFetch();
    mount();
    await screen.findByText("how does this work?");
    expect(screen.queryByText(/via request/i)).not.toBeInTheDocument();
  });

  // Learn-tab black-screen regression (root cause): GET /api/code/threads/{id}
  // resolving "ok" with a body that has no `thread` key (empty object, or any
  // other shape mismatch) used to throw destructuring `thread.blob_match`,
  // unmounting the whole page with no boundary to catch it. ThreadView must
  // degrade to an inline "couldn't load" message instead of crashing.
  it("a malformed detail payload (no thread key) degrades instead of crashing", async () => {
    stubFetch({ detail: {} });
    const onBack = vi.fn();
    mount({ onBack });
    expect(await screen.findByText(/couldn.t load this thread/i)).toBeInTheDocument();
    // the back affordance still works from the degraded state.
    fireEvent.click(screen.getByText(/back to threads/i));
    expect(onBack).toHaveBeenCalled();
  });

  it("a null detail payload also degrades instead of crashing", async () => {
    global.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith("/api/code/threads/")) {
        return { ok: true, status: 200, json: async () => null } as unknown as Response;
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
    mount();
    expect(await screen.findByText(/couldn.t load this thread/i)).toBeInTheDocument();
  });
});

describe("ThreadView — item 5: optimistic seed + optimistic reply", () => {
  beforeEach(() => { localStorage.clear(); });
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  it("a seeded thread renders immediately with no 'Loading thread…' flash", async () => {
    // fetch would hang forever if awaited — proves the seed alone paints first.
    global.fetch = vi.fn(() => new Promise(() => {})) as unknown as typeof fetch;
    const seed: CodeThreadDetailPayload = THREAD_DETAIL as CodeThreadDetailPayload;
    render(
      <ToastProvider>
        <SnapshotProvider>
          <ThreadView threadId="t1" onBack={vi.fn()} seed={seed} />
        </SnapshotProvider>
      </ToastProvider>,
    );
    expect(screen.getByText("how does this work?")).toBeInTheDocument();
    expect(screen.queryByText(/loading thread/i)).not.toBeInTheDocument();
  });

  it("posting a reply appends it immediately (optimistic), before the POST resolves", async () => {
    const resolvers: Array<() => void> = [];
    global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method || "GET";
      if (url.includes("/messages") && method === "POST") {
        return new Promise((resolve) => {
          resolvers.push(() => resolve({
            ok: true, status: 201,
            json: async () => ({ ...THREAD_DETAIL.thread }), // real wire: flat row
          } as unknown as Response));
        });
      }
      if (url.startsWith("/api/code/threads/")) {
        return { ok: true, status: 200, json: async () => ({ ...THREAD_DETAIL.thread, messages: THREAD_DETAIL.messages }) } as unknown as Response;
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

    mount();
    await screen.findByText("how does this work?");
    fireEvent.change(screen.getByLabelText(/reply to thread/i), { target: { value: "a reply" } });
    fireEvent.click(screen.getByText("Reply"));

    // appears immediately, marked pending, BEFORE the POST promise resolves.
    const bubble = await screen.findByText("a reply", { selector: ".cs-message-body" });
    expect(bubble.closest(".cs-message")?.className).toContain("pending");
    expect(screen.getByText(/sending…/i)).toBeInTheDocument();

    resolvers.forEach((r) => r());
    // reconciled: the pending marker clears once the real response lands.
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.getByText("a reply", { selector: ".cs-message-body" }).closest(".cs-message")?.className).not.toContain("pending");
  });

  it("a failed reply POST rolls back the optimistic message and restores the draft", async () => {
    global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method || "GET";
      if (url.includes("/messages") && method === "POST") {
        return { ok: false, status: 500, json: async () => ({ detail: "boom" }) } as unknown as Response;
      }
      if (url.startsWith("/api/code/threads/")) {
        return { ok: true, status: 200, json: async () => ({ ...THREAD_DETAIL.thread, messages: THREAD_DETAIL.messages }) } as unknown as Response;
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

    mount();
    await screen.findByText("how does this work?");
    fireEvent.change(screen.getByLabelText(/reply to thread/i), { target: { value: "will fail" } });
    fireEvent.click(screen.getByText("Reply"));

    // end state: the failed POST rolled the optimistic bubble back out and
    // restored the human's draft text so nothing is silently lost.
    await screen.findByText(/couldn't post/i);
    expect(screen.queryByText("will fail", { selector: ".cs-message-body" })).not.toBeInTheDocument();
    expect((screen.getByLabelText(/reply to thread/i) as HTMLTextAreaElement).value).toBe("will fail");
  });
});

describe("ThreadView — chat-feel animation + auto-scroll (panel improvements item 2)", () => {
  beforeEach(() => { localStorage.clear(); });
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  it("newly-mounted messages carry the mount animation class", async () => {
    stubFetch();
    mount();
    await screen.findByText("how does this work?");
    const bubble = document.querySelector(".cs-message");
    expect(bubble).not.toBeNull();
    expect(bubble!.className).toContain("cs-message-mount");
  });

  it("a pending (optimistic) message also carries the mount class, not a hard pending/settled swap", async () => {
    global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method || "GET";
      if (url.includes("/messages") && method === "POST") {
        return new Promise(() => {}); // never resolves — stays pending for this test
      }
      if (url.startsWith("/api/code/threads/")) {
        return { ok: true, status: 200, json: async () => ({ ...THREAD_DETAIL.thread, messages: THREAD_DETAIL.messages }) } as unknown as Response;
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

    mount();
    await screen.findByText("how does this work?");
    fireEvent.change(screen.getByLabelText(/reply to thread/i), { target: { value: "hello" } });
    fireEvent.click(screen.getByText("Reply"));
    const pending = document.querySelector(".cs-message.pending");
    expect(pending).not.toBeNull();
    expect(pending!.className).toContain("cs-message-mount");
  });
});
