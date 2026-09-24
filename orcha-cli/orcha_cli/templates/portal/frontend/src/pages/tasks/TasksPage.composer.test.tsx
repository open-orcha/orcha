import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "../../components/ui";
import { SnapshotProvider } from "../../state/SnapshotProvider";
import { TasksPage } from "./TasksPage";

const BASE_SNAPSHOT = {
  container: { id: "c1", name: "Orcha", status: "active", autonomy_level: "plan" },
  agents: [
    { id: "h1", alias: "kedar", kind: "human", status: "idle" },
    { id: "a1", alias: "forge", kind: "ai", status: "working" },
  ],
  tasks: [
    {
      id: "t1",
      title: "Composer task",
      status: "in_progress",
      priority: 50,
      assignees: ["forge"],
      created_by_agent_id: "h1",
      created_at: "2026-09-24T00:00:00Z",
      definition_of_done: "Composer parity",
      message_summary: { count: 0, last: null },
    },
  ],
  requests: [],
};

interface Call {
  url: string;
  method: string;
  body?: unknown;
}

const jsonRes = (data: unknown, status = 200) => ({
  ok: status < 300,
  status,
  json: async () => data,
}) as Response;

function mount(snapshot = BASE_SNAPSHOT, holdPost = false) {
  const calls: Call[] = [];
  let releasePost: (() => void) | null = null;
  const heldPost = new Promise<Response>((resolve) => {
    releasePost = () => resolve(jsonRes({ message_id: "m1" }));
  });

  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method || "GET";
    let body: unknown;
    if (typeof init?.body === "string") body = JSON.parse(init.body);
    calls.push({ url, method, body });
    if (url === "/api/containers") return jsonRes([{ id: "c1", status: "active" }]);
    if (url.startsWith("/api/containers/c1") && method === "GET") return jsonRes(snapshot);
    if (/\/api\/tasks\/[^/]+\/messages$/.test(url) && method === "GET") return jsonRes({ messages: [] });
    if (/\/api\/tasks\/[^/]+\/messages$/.test(url) && method === "POST") return holdPost ? heldPost : jsonRes({ message_id: "m1" });
    if (/\/api\/tasks\/[^/]+\/runs$/.test(url)) return jsonRes([]);
    return jsonRes({});
  }));

  const rendered = render(
    <ToastProvider>
      <SnapshotProvider>
        <MemoryRouter initialEntries={["/tasks?task=t1"]}>
          <TasksPage />
        </MemoryRouter>
      </SnapshotProvider>
    </ToastProvider>,
  );
  return { ...rendered, calls, releasePost: () => releasePost?.() };
}

const messagePosts = (calls: Call[]) => calls.filter((call) => call.url === "/api/tasks/t1/messages" && call.method === "POST");

describe("Task thread composer parity", () => {
  beforeEach(() => {
    window.scrollTo = vi.fn();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    localStorage.clear();
  });

  it("uses the shared multiline layout and grows to the Conversation height cap", async () => {
    const { container } = mount();
    await waitFor(() => expect(container.querySelector("#reply")).toBeTruthy());
    const input = container.querySelector("#reply") as HTMLTextAreaElement;
    expect(input.tagName).toBe("TEXTAREA");
    expect(input.rows).toBe(1);
    expect(input.className).toContain("message-composer__input");
    expect(container.querySelector("#replyWrap .message-composer")).toBeTruthy();
    expect(container.querySelector("#attachBtn")?.className).toContain("message-composer__attach");
    expect(container.querySelector("#replyBtn")).toHaveAttribute("data-task", "t1");

    let scrollHeight = 92;
    Object.defineProperty(input, "scrollHeight", { configurable: true, get: () => scrollHeight });
    fireEvent.change(input, { target: { value: "line one\nline two\nline three" } });
    await waitFor(() => expect(input.style.height).toBe("92px"));
    expect(input.style.overflowY).toBe("hidden");

    scrollHeight = 220;
    fireEvent.change(input, { target: { value: "line one\nline two\nline three\nline four" } });
    await waitFor(() => expect(input.style.height).toBe("160px"));
    expect(input.style.overflowY).toBe("auto");
  });

  it("keeps Shift+Enter for newlines and guards Enter/click against duplicate posts", async () => {
    const { container, calls, releasePost } = mount(BASE_SNAPSHOT, true);
    await waitFor(() => expect(container.querySelector("#reply")).toBeTruthy());
    const input = container.querySelector("#reply") as HTMLTextAreaElement;
    const button = container.querySelector("#replyBtn") as HTMLButtonElement;

    fireEvent.change(input, { target: { value: "first line\nsecond line" } });
    fireEvent.keyDown(input, { key: "Enter", shiftKey: true });
    expect(messagePosts(calls)).toHaveLength(0);

    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.click(button);
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(messagePosts(calls)).toHaveLength(1));
    expect(messagePosts(calls)[0].body).toEqual({ body: "first line\nsecond line", author_agent_id: "h1" });
    expect(button.disabled).toBe(true);
    expect(button.textContent).toContain("Posting");
    expect(button.closest(".message-composer")).toHaveAttribute("aria-busy", "true");

    releasePost();
    await waitFor(() => expect(button.disabled).toBe(false));
    expect(input.value).toBe("");
  });

  it("keeps task-thread controls disabled while the assignee owns a live terminal", async () => {
    const lockedSnapshot = {
      ...BASE_SNAPSHOT,
      agents: BASE_SNAPSHOT.agents.map((agent) => agent.id === "a1" ? { ...agent, embodiment: "live" } : agent),
    };
    const { container } = mount(lockedSnapshot);
    await waitFor(() => expect(container.querySelector("#reply")).toBeTruthy());
    const input = container.querySelector("#reply") as HTMLTextAreaElement;
    expect(input.disabled).toBe(true);
    expect((container.querySelector("#attachBtn") as HTMLButtonElement).disabled).toBe(true);
    expect((container.querySelector("#replyBtn") as HTMLButtonElement).disabled).toBe(true);
    expect(container.querySelector("#replyWrap")?.textContent).toContain("thread composer is paused");
  });
});
