/**
 * Request text + answered-question card (owner requests, mig 065):
 *  - a code-thread question shows a clean title + just the question; the agent's wake text
 *    (anchor header, lesson guide, "reply via POST …", raw /code?… link) never renders —
 *    for new rows (detail.display_title / code_thread) and legacy combined rows alike;
 *  - "Open thread in Code" chip instead of the raw portal path;
 *  - answered question: the answer in the card, one-click Resolve (no dialog) with Undo,
 *    "Turn into a task" / "Ask a follow-up" secondary; a WORK request keeps Convert primary;
 *  - a request auto-resolved by its code thread says so in the activity.
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "../../components/ui";
import { SnapshotProvider } from "../../state/SnapshotProvider";
import { RequestsPage, _resetPendingAnswers, isAnsweredQuestion } from "./RequestsPage";
import { _resetResolves, flushResolves } from "./resolveUndo";

const iso = (m: number) => new Date(Date.now() + m * 60_000).toISOString();
const TID = "0b5c3a1e-1111-4222-8333-444455556666";
const QUESTION = "Give me a tour of the deploy/ folder, starting from docker-compose.yml: what lives here, how the files fit together, and where to start reading.";
const LEGACY =
  "[code thread — teach] local@8cf5234 deploy/docker-compose.yml:1-1\n" + QUESTION +
  "\n\nanswer as a short lesson in markdown so the portal can walk the reader through it:\n# <lesson title>\n> <one-line summary>\n## Steps\n1. **<step title>** (L<start>-<end>) <what>\n" +
  "plain prose is still accepted; this structure just turns it into a guided walkthrough.\n\n" +
  "reply via POST /api/code/threads/" + TID + "/messages with your agent id as actor_agent_id\n" +
  "view/reply in the portal: /code?path=deploy/docker-compose.yml&thread=" + TID;
const LINK = "/code?path=deploy/docker-compose.yml&thread=" + TID;

const RAW = {
  container: { id: "c1", name: "Orcha", status: "active", autonomy_level: "plan" },
  agents: [
    { id: "a1", alias: "atlas", kind: "ai", status: "idle" },
    { id: "h1", alias: "kedar", kind: "human", status: "idle" },
  ],
  tasks: [],
  requests: [
    // legacy row: the old combined wake text in payload
    { id: "q1", type: "info", status: "open", priority: 100, requester_id: "h1", target_id: "a1", created_at: iso(-30), payload: LEGACY },
    // new row: clean payload + detail
    { id: "q2", type: "info", status: "answered", priority: 100, requester_id: "h1", target_id: "a1", created_at: iso(-20), responded_at: iso(-10),
      payload: QUESTION, response: "# Deploy tour\n> Compose runs the stack.\n\nThe folder holds the compose file and env templates.",
      detail: { display_title: "Teach · Tour of the deploy/ folder — docker-compose.yml L1", code_thread: { thread_id: TID, kind: "teach", path: "deploy/docker-compose.yml", start_line: 1, end_line: 1, link: LINK } } },
    // a plain answered question (no thread)
    { id: "q3", type: "info", status: "answered", priority: 100, requester_id: "h1", target_id: "a1", created_at: iso(-15), responded_at: iso(-5),
      payload: "What's the ETA for the scheduler fix?", response: "Today, after the migration lands. See /tasks?task=abcdef12-0000-4000-8000-000000000000 for progress." },
    // a work request answered: Convert stays primary
    { id: "q4", type: "task", status: "answered", priority: 100, requester_id: "h1", target_id: "a1", created_at: iso(-12), responded_at: iso(-4),
      payload: "Build the export", response: "Can't — needs a spec.", detail: { title: "Build the export", definition_of_done: "Export works" } },
    // auto-resolved by its code thread
    { id: "q5", type: "info", status: "closed", priority: 100, requester_id: "h1", target_id: "a1", created_at: iso(-60), responded_at: iso(-50),
      payload: "Why is this retried?", response: "Because the API is flaky.",
      detail: { auto_resolved: "thread_answered", code_thread: { thread_id: TID, kind: "why", path: "src/a.ts", start_line: 3, end_line: 9, link: "/code?path=src/a.ts&thread=" + TID } } },
  ],
};

let posts: { url: string; body: unknown }[] = [];
beforeEach(() => {
  posts = [];
  window.scrollTo = vi.fn();
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (init?.method === "POST") {
      posts.push({ url, body: init.body ? JSON.parse(String(init.body)) : null });
      return { ok: true, status: 200, json: async () => ({ request_id: "new" }) } as Response;
    }
    if (url === "/api/containers") return { ok: true, status: 200, json: async () => [{ id: "c1", status: "active" }] } as Response;
    if (url.startsWith("/api/containers/c1")) return { ok: true, status: 200, json: async () => RAW } as Response;
    return { ok: true, status: 200, json: async () => ({}) } as Response;
  }));
});
afterEach(() => { _resetResolves(); _resetPendingAnswers(); cleanup(); vi.unstubAllGlobals(); localStorage.clear(); });

function mount(path: string) {
  return render(
    <ToastProvider>
      <SnapshotProvider>
        <MemoryRouter initialEntries={[path]}>
          <RequestsPage />
        </MemoryRouter>
      </SnapshotProvider>
    </ToastProvider>,
  );
}
const detail = () => document.querySelector("#detailMain") as HTMLElement;
const openDetail = () => waitFor(() => { expect(detail()).toBeTruthy(); return detail(); });

describe("human-facing request text (agent instructions never shown)", () => {
  it("a legacy combined code-thread row reads as a clean title + the question, with an Open-thread chip", async () => {
    mount("/requests?req=q1");
    const d = await openDetail();
    await waitFor(() => expect(d.querySelector(".wk-dtitle")?.textContent).toBe("Teach · Tour of the deploy/ folder — docker-compose.yml L1"));
    const text = d.textContent || "";
    expect(text).toContain("Give me a tour of the deploy/ folder");
    for (const leak of ["[code thread", "reply via POST", "actor_agent_id", "<lesson title>", "answer as a short lesson", "view/reply in the portal"]) {
      expect(text).not.toContain(leak);
    }
    const chip = within(d).getByRole("link", { name: "Open thread in Code" });
    expect(chip.getAttribute("href")).toBe(LINK);
    // the list row carries the same clean title
    const row = document.querySelector('.rq-row[data-id="q1"], [id="q1"]') as HTMLElement | null;
    if (row) expect(row.textContent).not.toContain("[code thread");
  });

  it("a new row uses detail.display_title and links the thread", async () => {
    mount("/requests?req=q2");
    const d = await openDetail();
    await waitFor(() => expect(d.querySelector(".wk-dtitle")?.textContent).toBe("Teach · Tour of the deploy/ folder — docker-compose.yml L1"));
    expect(within(d).getByRole("link", { name: "Open thread in Code" })).toBeInTheDocument();
    expect(d.querySelector(".rq-src-path")?.textContent).toBe("deploy/docker-compose.yml L1");
  });

  it("portal paths inside request/answer text render as named link chips, not raw URLs", async () => {
    mount("/requests?req=q3");
    const d = await openDetail();
    const chip = await waitFor(() => within(d).getByRole("link", { name: /Open task abcdef12/ }));
    expect(chip.getAttribute("href")).toBe("/tasks?task=abcdef12-0000-4000-8000-000000000000");
    expect(chip.className).toMatch(/plink/);
  });
});

describe("answered question card", () => {
  it("pure: only your own answered NON-task request is an answered question", () => {
    const h = { id: "h1", alias: "kedar", kind: "human" } as never;
    const base = { id: "x", type: "info", status: "answered", requester_id: "h1" } as never;
    expect(isAnsweredQuestion(base, h)).toBe(true);
    expect(isAnsweredQuestion({ ...(base as object), type: "task" } as never, h)).toBe(false);
    expect(isAnsweredQuestion({ ...(base as object), requester_id: "a1" } as never, h)).toBe(false);
    expect(isAnsweredQuestion({ ...(base as object), status: "open" } as never, h)).toBe(false);
    expect(isAnsweredQuestion(base, null)).toBe(false);
  });

  it("shows the answer excerpt + Open thread; Resolve is one click (no dialog), deferred, and Undo cancels it", async () => {
    mount("/requests?req=q2");
    const card = await waitFor(() => within(detail()).getByRole("region", { name: "atlas answered" }));
    expect(card.textContent).toContain("Compose runs the stack.");
    expect(within(card).getByRole("link", { name: /Open thread/ }).getAttribute("href")).toBe(LINK);
    // a code-thread question follows up IN its thread
    expect(within(card).getByRole("link", { name: /Ask a follow-up/ }).getAttribute("href")).toBe(LINK);

    fireEvent.click(within(card).getByRole("button", { name: /^Resolve$/ }));
    expect(screen.queryByRole("dialog")).toBeNull();
    const done = await waitFor(() => within(detail()).getByRole("region", { name: "Resolved" }));
    expect(posts.filter((p) => p.url.endsWith("/close"))).toHaveLength(0); // deferred for Undo
    // Undo is offered twice: in the toast and in the card
    expect(await screen.findAllByRole("button", { name: "Undo" })).toHaveLength(2);

    fireEvent.click(within(done).getByRole("button", { name: "Undo" }));
    await waitFor(() => within(detail()).getByRole("region", { name: "atlas answered" }));
    act(() => { flushResolves(); });
    expect(posts.filter((p) => p.url.endsWith("/close"))).toHaveLength(0); // undone: nothing sent
  });

  it("Resolve sends the requester's own close (no reason) once the undo window passes", async () => {
    mount("/requests?req=q3");
    const card = await waitFor(() => within(detail()).getByRole("region", { name: "atlas answered" }));
    fireEvent.click(within(card).getByRole("button", { name: /^Resolve$/ }));
    await waitFor(() => within(detail()).getByRole("region", { name: "Resolved" }));
    await act(async () => { flushResolves(); });
    await waitFor(() => expect(posts.find((p) => p.url === "/api/requests/q3/close")).toBeTruthy());
    expect(posts.find((p) => p.url === "/api/requests/q3/close")!.body).toEqual({ requester_agent_id: "h1" });
  });

  it("Ask a follow-up (no thread) sends a chained question to whoever answered, then resolves this one", async () => {
    mount("/requests?req=q3");
    const card = await waitFor(() => within(detail()).getByRole("region", { name: "atlas answered" }));
    fireEvent.click(within(card).getByRole("button", { name: /Ask a follow-up/ }));
    const box = await screen.findByRole("textbox", { name: /Follow-up to atlas/ });
    fireEvent.change(box, { target: { value: "Which migration?" } });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Send follow-up" })); });
    await waitFor(() => expect(posts.map((p) => p.url)).toEqual(["/api/containers/c1/requests", "/api/requests/q3/close"]));
    expect(posts[0].body).toEqual({ requester_agent_id: "h1", target_agent_id: "a1", payload: "Which migration?", parent_request_id: "q3" });
  });

  it("a WORK request answered keeps 'Convert to task' as the primary action", async () => {
    mount("/requests?req=q4");
    const card = await waitFor(() => within(detail()).getByRole("region", { name: "atlas answered — convert or close" }));
    expect(within(card).getByRole("button", { name: /Convert to task/ }).className).toMatch(/primary/);
    expect(within(card).queryByRole("button", { name: /^Resolve$/ })).toBeNull();
  });

  it("a request auto-resolved by its code thread says so, with the thread link", async () => {
    mount("/requests?req=q5");
    const d = await openDetail();
    await waitFor(() => expect(d.textContent).toContain("Resolved automatically — answered in the code thread"));
    expect(d.textContent).toContain("Because the API is flaky.");
  });
});
