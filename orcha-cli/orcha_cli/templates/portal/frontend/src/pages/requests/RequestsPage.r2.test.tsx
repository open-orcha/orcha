/**
 * Linear polish round 2 (/requests):
 *  - your own answered question: "<who> answered" with the answer, Resolve primary (one
 *    click, Undo), "Turn into a task" / "Ask a follow-up" secondary, Escalate only in ⋯;
 *  - legacy escalated = "Escalated to you" (Needs counts it) — covered in polish.test;
 *  - detail header = status glyph + copyable ID + type label; the flowline drops the status
 *    (statusShown) and the rail states it once; rail times are clock-only;
 *  - j/k move the selection; Esc closes and returns focus to the row (not the panel);
 *  - after "Answer sent": "Answered · syncing…" and no second Answer until the snapshot moves;
 *  - "N of M match" only for search / direction; Close dialog copy never starts with an alias.
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "../../components/ui";
import { SnapshotProvider } from "../../state/SnapshotProvider";
import { RequestsPage, _resetPendingAnswers } from "./RequestsPage";

const iso = (m: number) => new Date(Date.now() + m * 60_000).toISOString();
const RAW = {
  container: { id: "c1", name: "Orcha", status: "active", autonomy_level: "plan" },
  agents: [
    { id: "a1", alias: "forge", kind: "ai", status: "working" },
    { id: "a2", alias: "mira", kind: "ai", status: "idle" },
    { id: "h1", alias: "kedar", kind: "human", status: "idle" },
  ],
  tasks: [],
  requests: [
    { id: "r1", type: "question", status: "open", priority: 1, requester_id: "a1", target_id: "h1", created_at: iso(-60), payload: "Ship on Friday?" },
    { id: "r2", type: "question", status: "answered", priority: 100, requester_id: "h1", target_id: "a2", created_at: iso(-50),
      payload: "What's the ETA for the scheduler fix?", response: "Today.", responded_at: iso(-40) },
    { id: "r3", type: "handoff", status: "open", priority: 100, requester_id: "a2", target_id: "a1", created_at: iso(-40), payload: "API shape" },
  ],
};

let hang = false;
let posts: string[] = [];
beforeEach(() => {
  hang = false;
  posts = [];
  window.scrollTo = vi.fn();
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (init?.method === "POST") { posts.push(url); hang = true; return { ok: true, status: 200, json: async () => ({}) } as Response; }
    if (url === "/api/containers") return { ok: true, status: 200, json: async () => [{ id: "c1", status: "active" }] } as Response;
    if (url.startsWith("/api/containers/c1")) {
      if (hang) return new Promise<Response>(() => {}); // the confirming snapshot hasn't arrived yet
      return { ok: true, status: 200, json: async () => RAW } as Response;
    }
    return { ok: true, status: 200, json: async () => ({}) } as Response;
  }));
});
afterEach(() => { _resetPendingAnswers(); cleanup(); vi.unstubAllGlobals(); localStorage.clear(); });

let loc = { search: "" };
function Loc() { const l = useLocation(); loc = l; return null; }
function mount(path = "/requests") {
  return render(
    <ToastProvider>
      <SnapshotProvider>
        <MemoryRouter initialEntries={[path]}>
          <RequestsPage />
          <Loc />
        </MemoryRouter>
      </SnapshotProvider>
    </ToastProvider>,
  );
}
const detail = () => document.querySelector("#detailMain") as HTMLElement;
const openDetail = () => waitFor(() => { expect(detail()).toBeTruthy(); return detail(); });
const selParam = () => new URLSearchParams(loc.search).get("req");

describe("decision card", () => {
  it("your own answered question: '<who> answered' + the answer, Resolve primary, Escalate only in ⋯", async () => {
    mount("/requests?req=r2");
    const card = await waitFor(() => within(detail()).getByRole("region", { name: "mira answered" }));
    expect(card.textContent).toContain("Today.");
    expect(within(card).queryByRole("button", { name: /Escalate/ })).toBeNull();
    expect(within(card).getByRole("button", { name: /^Resolve$/ }).className).toMatch(/primary/);
    expect(within(card).getByRole("button", { name: /Turn into a task/ }).className).not.toMatch(/primary/);
    expect(within(card).getByRole("button", { name: /Ask a follow-up/ })).toBeInTheDocument();
    expect(within(card).queryByRole("button", { name: /Convert to task/ })).toBeNull();
    fireEvent.click(within(card).getByRole("button", { name: "More request actions" }));
    expect(await screen.findByRole("menuitem", { name: /Escalate to human/ })).toBeInTheDocument();
  });

  it("after 'Answer sent' the detail reads 'Answered · syncing…' and offers no second Answer", async () => {
    mount("/requests?req=r1");
    fireEvent.click(await within(await openDetail()).findByRole("button", { name: /^Answer$/ }));
    const box = await screen.findByRole("textbox", { name: /Your answer to forge/ });
    fireEvent.change(box, { target: { value: "Yes, Friday." } });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Send answer" })); });
    await waitFor(() => expect(posts).toContain("/api/requests/r1/respond"));
    const card = await waitFor(() => within(detail()).getByRole("region", { name: "Answered · syncing…" }));
    expect(within(detail()).queryByRole("button", { name: /^Answer$/ })).toBeNull();
    expect(card).toBeInTheDocument();
    expect(detail().textContent).toContain("Yes, Friday.");
  });
});

describe("detail header + rail", () => {
  it("header = status glyph + copyable ID + type label; the flowline has no status; the rail states it once, clock-only", async () => {
    mount("/requests?req=r3");
    await waitFor(() => expect(detail()).toBeTruthy());
    const bar = detail().querySelector(".rq-bar") as HTMLElement;
    expect(bar.querySelector(".v2-pagehead-glyph .v2-si")).toBeTruthy();
    expect(within(bar).getByRole("button", { name: /Copy request id/ })).toBeInTheDocument();
    expect(bar.textContent).toContain("Handoff request");
    expect(detail().querySelector(".rq-flowline .rq-status")).toBeNull();
    const rail = detail().querySelector(".rq-rail") as HTMLElement;
    expect(within(rail).getByText("Status")).toBeInTheDocument();
    expect(within(rail).queryByText("Type")).toBeNull(); // the header names the type
    const opened = within(rail).getByText("Opened").nextElementSibling as HTMLElement;
    expect(opened.textContent).not.toMatch(/ago/);
  });
});

describe("inbox keys + focus", () => {
  it("j/k move the selection (display order)", async () => {
    mount("/requests");
    await waitFor(() => expect(document.querySelectorAll(".qrow").length).toBe(3));
    const order = Array.from(document.querySelectorAll(".qrow")).map((r) => r.getAttribute("data-id"));
    fireEvent.click(document.querySelector(`.qrow[data-id="${order[0]}"]`)!);
    await waitFor(() => expect(selParam()).toBe(order[0]));
    fireEvent.keyDown(document.body, { key: "j" });
    await waitFor(() => expect(selParam()).toBe(order[1]));
    fireEvent.keyDown(document.body, { key: "j" });
    await waitFor(() => expect(selParam()).toBe(order[2]));
    fireEvent.keyDown(document.body, { key: "k" });
    await waitFor(() => expect(selParam()).toBe(order[1]));
  });

  it("Esc closes the detail and returns focus to the row that was open", async () => {
    mount("/requests?req=r3");
    await waitFor(() => expect(detail()).toBeTruthy());
    fireEvent.keyDown(document.body, { key: "Escape" });
    await waitFor(() => expect(detail()).toBeNull());
    await waitFor(() => expect((document.activeElement as HTMLElement | null)?.getAttribute("data-id")).toBe("r3"));
  });
});

describe("copy", () => {
  it("'N of M match' shows for search, not for a pill filter (the pill already counts)", async () => {
    mount("/requests?filter=open");
    await waitFor(() => expect(document.querySelectorAll(".qrow").length).toBe(2));
    expect(document.querySelector(".rq-listfoot")).toBeNull();
    cleanup();
    mount("/requests?q=ship");
    await waitFor(() => expect(document.querySelector(".rq-listfoot")?.textContent).toMatch(/1 of 3 requests match/));
  });

  it("the Close dialog never starts a sentence with an alias", async () => {
    mount("/requests?req=r3");
    fireEvent.click(await within(await openDetail()).findByRole("button", { name: /Close…/ }));
    const dlg = await screen.findByRole("dialog");
    expect(dlg.textContent).toMatch(/Marks it resolved; mira sees it closed/);
    expect(dlg.textContent).not.toMatch(/\. mira/);
  });
});
