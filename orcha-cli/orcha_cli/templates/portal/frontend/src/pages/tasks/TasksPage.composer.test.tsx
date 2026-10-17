import { cleanup, fireEvent, render, waitFor, within } from "@testing-library/react";
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

const sendBtn = (c: HTMLElement) => within(c.querySelector("#replyWrap") as HTMLElement).getByRole("button", { name: "Post comment" }) as HTMLButtonElement;
const attachBtn = (c: HTMLElement) => within(c.querySelector("#replyWrap") as HTMLElement).getByRole("button", { name: "Attach files" }) as HTMLButtonElement;
const fileInput = (c: HTMLElement) => c.querySelector('#replyWrap input[type="file"]') as HTMLInputElement;

describe("Task thread composer parity (Linear 'Leave a comment…' composer)", () => {
  beforeEach(() => {
    window.scrollTo = vi.fn();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    localStorage.clear();
  });

  it("uses the shared Composer primitive (rounded field, attach + circular send) and grows to its height cap", async () => {
    const { container } = mount();
    await waitFor(() => expect(container.querySelector("#reply")).toBeTruthy());
    const input = container.querySelector("#reply") as HTMLTextAreaElement;
    expect(input.tagName).toBe("TEXTAREA");
    expect(input.getAttribute("placeholder")).toBe("Leave a comment…");
    expect(input.className).toContain("v2-composer-input");
    expect(container.querySelector("#replyWrap .v2-composer")).toBeTruthy();
    expect(attachBtn(container).className).toContain("v2-iconbtn");
    expect(sendBtn(container).className).toContain("v2-iconbtn-circle");
    // empty draft: nothing to post
    expect(sendBtn(container).disabled).toBe(true);

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
    const button = sendBtn(container);

    fireEvent.change(input, { target: { value: "first line\nsecond line" } });
    fireEvent.keyDown(input, { key: "Enter", shiftKey: true });
    expect(messagePosts(calls)).toHaveLength(0);

    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.click(button);
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(messagePosts(calls)).toHaveLength(1));
    expect(messagePosts(calls)[0].body).toEqual({ body: "first line\nsecond line", author_agent_id: "h1" });
    // in flight: the send button is busy + disabled
    expect(button.disabled).toBe(true);
    expect(button).toHaveAttribute("aria-busy", "true");

    await waitFor(() => expect(input.value).toBe(""));
    fireEvent.change(input, { target: { value: "follow-up draft" } });
    const followUp = new File(["notes"], "follow-up.txt", { type: "text/plain" });
    fireEvent.change(fileInput(container), { target: { files: [followUp] } });
    await waitFor(() => expect(container.querySelector("#attachTray")?.textContent).toContain("follow-up.txt"));

    releasePost();
    await waitFor(() => expect(sendBtn(container).disabled).toBe(false));
    expect(input.value).toBe("follow-up draft");
    expect(container.querySelector("#attachTray")?.textContent).toContain("follow-up.txt");
    expect(messagePosts(calls)).toHaveLength(1);
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
    expect(attachBtn(container).disabled).toBe(true);
    expect(sendBtn(container).disabled).toBe(true);
    // the reason is announced, never silent
    expect(container.querySelector("#replyWrap")?.textContent).toContain("thread composer is paused");
    expect(input.getAttribute("aria-describedby")).toBeTruthy();
  });
});
