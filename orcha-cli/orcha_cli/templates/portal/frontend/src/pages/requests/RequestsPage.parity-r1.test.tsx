/**
 * Parity round 1 fixes (/requests + RequestDetail):
 *  - REQ-071/100: an escalation made from this tab reads as escalated (the snapshot has no flag);
 *  - REQ-107: at ≤900px, Back from the detail returns to the list (in-app and browser Back);
 *  - task_link is always the SPAWNED task; an accepted task request has an "accepted" event;
 *  - a viewer sees the read-only reason, never "pick an acting human";
 *  - the numeric priority is visible inline; stamps older than today carry the date;
 *  - a failed dialog submit returns focus into the dialog so Escape still closes it;
 *  - the answered request keeps its place in the list while it stays picked;
 *  - a task_id payload value renders as a task chip.
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, useLocation, useNavigate } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "../../components/ui";
import { extensions, type Identity } from "../../extensions";
import { SnapshotProvider, _setActingAuth, _setActingIdentity } from "../../state/SnapshotProvider";
import { RequestsPage, _resetLocalEscalations, _resetPendingAnswers, isEscalated, noHumanReqReason, stampText } from "./RequestsPage";
import { PayloadView } from "./requestPayload";
import type { OrchaRequest } from "../../types";

const iso = (m: number) => new Date(Date.now() + m * 60_000).toISOString();
const baseRaw = () => ({
  container: { id: "c1", name: "Orcha", status: "active", autonomy_level: "plan" },
  agents: [
    { id: "a1", alias: "forge", kind: "ai", status: "working" },
    { id: "a2", alias: "quill", kind: "ai", status: "idle" },
    { id: "h1", alias: "kedar", kind: "human", status: "idle" },
  ],
  tasks: [{ id: "t1aaaaaa-0000-4000-8000-000000000001", title: "Wire the export", status: "in_progress", assignees: ["quill"], priority: 2 }],
  requests: [
    { id: "r1", type: "question", status: "open", priority: 4, requester_id: "h1", target_id: "a1", created_at: iso(-60), payload: "Which region for staging?" },
    { id: "r2", type: "task", status: "accepted", priority: 100, requester_id: "a1", target_id: "a2", created_at: iso(-50), responded_at: iso(-45),
      payload: "Take the export task", response: "On it",
      task_link: { task_id: "t1aaaaaa-0000-4000-8000-000000000001", title: "Wire the export", status: "in_progress" } },
    { id: "r3", type: "question", status: "open", priority: 100, requester_id: "a1", target_id: "h1", created_at: iso(-40), payload: "Ship on Friday?" },
    { id: "r4", type: "question", status: "open", priority: 100, requester_id: "a2", target_id: "h1", created_at: iso(-30), payload: "Rename the bucket?" },
  ],
});

let RAW: Omit<ReturnType<typeof baseRaw>, "requests"> & { requests: Record<string, unknown>[] };
let posts: { url: string; body: unknown }[] = [];
let failClose = false;
let loc = { pathname: "", search: "" };
let nav: ReturnType<typeof useNavigate> | null = null;
let narrow = false;

beforeEach(() => {
  RAW = baseRaw();
  posts = [];
  failClose = false;
  narrow = false;
  window.scrollTo = vi.fn();
  window.matchMedia = ((q: string) => ({
    matches: narrow && q.includes("max-width: 900px"), media: q, onchange: null,
    addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (init?.method === "POST") {
      posts.push({ url, body: init.body ? JSON.parse(String(init.body)) : null });
      if (failClose && url.endsWith("/close")) return { ok: false, status: 422, json: async () => ({ detail: "reason required" }), text: async () => "reason required" } as unknown as Response;
      return { ok: true, status: 200, json: async () => ({}) } as Response;
    }
    if (url === "/api/containers") return { ok: true, status: 200, json: async () => [{ id: "c1", status: "active" }] } as Response;
    if (url.startsWith("/api/containers/c1")) return { ok: true, status: 200, json: async () => RAW } as Response;
    return { ok: true, status: 200, json: async () => ({}) } as Response;
  }));
});
afterEach(() => {
  _resetPendingAnswers();
  _resetLocalEscalations();
  cleanup();
  vi.unstubAllGlobals();
  localStorage.clear();
  delete extensions.identity;
  _setActingIdentity(null);
  _setActingAuth({ pending: false, trusted: false });
});

function Probe() {
  const l = useLocation();
  loc = { pathname: l.pathname, search: l.search };
  nav = useNavigate();
  return null;
}
function mount(path = "/requests") {
  return render(
    <ToastProvider>
      <SnapshotProvider>
        <MemoryRouter initialEntries={[path]}>
          <RequestsPage />
          <Probe />
        </MemoryRouter>
      </SnapshotProvider>
    </ToastProvider>,
  );
}
const detail = () => document.querySelector("#detailMain") as HTMLElement | null;
const rowIds = () => Array.from(document.querySelectorAll(".qrow")).map((r) => r.getAttribute("data-id"));

describe("REQ-071/100 — an escalation from this tab is shown as escalated", () => {
  it("after POST /escalate the request reads 'escalated' in the row, the card and the Activity", async () => {
    mount("/requests?req=r1");
    await waitFor(() => expect(detail()).toBeTruthy());
    fireEvent.click(await screen.findByRole("button", { name: "More request actions" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: /Escalate to human…/ }));
    const dlg = await screen.findByRole("dialog");
    fireEvent.click(within(dlg).getByRole("button", { name: "Escalate" }));
    await waitFor(() => expect(posts.some((p) => p.url.endsWith("/r1/escalate"))).toBe(true));
    // the backend re-targets at a human and keeps status "open" (no flag in the snapshot)
    RAW = { ...RAW, requests: RAW.requests.map((r) => (r.id === "r1" ? { ...r, target_id: "h1" } : r)) };
    await waitFor(() => expect(within(detail()!).getByText(/escalated to/)).toBeInTheDocument());
    expect(document.querySelector('.qrow[data-id="r1"]')?.textContent).toContain("escalated");
    // never inferred for a request nobody escalated here
    expect(isEscalated({ id: "r3", status: "open" } as OrchaRequest)).toBe(false);
  });
});

describe("REQ-107 — narrow layout returns to the list", () => {
  it("in-app Back clears the selection and shows the list", async () => {
    narrow = true;
    mount();
    await waitFor(() => expect(rowIds().length).toBe(4));
    expect(detail()).toBeNull();
    fireEvent.click(document.querySelector('.qrow[data-id="r3"]')!);
    await waitFor(() => expect(detail()).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Back to requests" }));
    await waitFor(() => expect(detail()).toBeNull());
    expect(new URLSearchParams(loc.search).get("req")).toBeNull();
  });

  it("browser Back (history pop) also returns to the list", async () => {
    narrow = true;
    mount();
    await waitFor(() => expect(rowIds().length).toBe(4));
    fireEvent.click(document.querySelector('.qrow[data-id="r3"]')!);
    await waitFor(() => expect(detail()).toBeTruthy());
    act(() => { nav!(-1); });
    await waitFor(() => expect(detail()).toBeNull());
  });
});

describe("task link + accepted task request", () => {
  it("labels the link 'Spawned task' and adds an 'accepted the task' event", async () => {
    mount("/requests?req=r2");
    await waitFor(() => expect(detail()).toBeTruthy());
    const rail = within(detail()!).getByRole("complementary", { name: "Request details" });
    expect(within(rail).getByText("Spawned task")).toBeInTheDocument();
    expect(within(rail).queryByText("In service of")).toBeNull();
    const act0 = within(detail()!).getByRole("region", { name: "Activity" });
    expect(act0.textContent).toMatch(/quill\s*accepted the task/);
  });
});

describe("viewer copy", () => {
  it("pure: a read-only reason wins over 'pick an acting human'", () => {
    expect(noHumanReqReason({ readOnly: true, pending: false, reason: "Your role is viewer (read-only)" })).toBe("Your role is viewer (read-only)");
    expect(noHumanReqReason({ readOnly: false, pending: false, reason: "x" })).toMatch(/^Pick an acting human/);
  });

  it("a viewer's decision card says the role, not 'Pick an acting human'", async () => {
    extensions.identity = async () => ({ agent_id: "h1", alias: "kedar", member_role: "viewer" }) as Identity;
    mount("/requests?req=r3");
    await waitFor(() => expect(within(detail()!).getByText("Your role is viewer (read-only)")).toBeInTheDocument());
    expect(detail()!.textContent).not.toMatch(/Pick an acting human/);
  });
});

describe("rail facts", () => {
  it("shows the exact numeric priority inline", async () => {
    mount("/requests?req=r1");
    await waitFor(() => expect(detail()).toBeTruthy());
    expect(detail()!.querySelector(".rq-prio")?.textContent).toMatch(/P4/);
  });

  it("stampText: clock only for today; the date is added for older stamps", () => {
    const now = new Date("2026-09-28T15:00:00");
    expect(stampText(new Date("2026-09-28T09:05:00").toISOString(), now)).not.toMatch(/Sep/);
    expect(stampText(new Date("2026-09-25T09:05:00").toISOString(), now)).toMatch(/Sep\s*25/);
  });
});

describe("dialog Escape after a failed submit", () => {
  it("focus returns into the dialog after a 422, and Escape closes it", async () => {
    failClose = true;
    mount("/requests?req=r3");
    await waitFor(() => expect(detail()).toBeTruthy());
    fireEvent.click(await within(detail()!).findByRole("button", { name: /Close…/ }));
    const dlg = await screen.findByRole("dialog");
    // r2: the button needs a reason on someone else's request; the server still 422s here
    fireEvent.change(within(dlg).getByLabelText("Reason"), { target: { value: "stale" } });
    const submit = within(dlg).getByRole("button", { name: "Close request" });
    submit.focus();
    fireEvent.click(submit);
    // a browser drops focus out of the dialog when the focused busy button disables
    // (jsdom keeps it on the disabled button) — stand that in with an outside element
    const outside = document.createElement("button");
    document.body.appendChild(outside);
    outside.focus();
    expect(dlg.contains(document.activeElement)).toBe(false);
    await waitFor(() => expect(within(dlg).getByRole("alert")).toBeInTheDocument());
    await waitFor(() => expect(dlg.contains(document.activeElement)).toBe(true));
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });
});

describe("answered request keeps its place", () => {
  it("answering the picked request does not re-sort it away from under the cursor", async () => {
    mount("/requests?req=r3");
    await waitFor(() => expect(rowIds().length).toBe(4));
    const before = rowIds();
    RAW = { ...RAW, requests: RAW.requests.map((r) => (r.id === "r3" ? { ...r, status: "answered", response: "Yes", responded_at: iso(0) } : r)) };
    fireEvent.click(await within(detail()!).findByRole("button", { name: /^Answer$/ }));
    fireEvent.change(await screen.findByRole("textbox", { name: /Your answer to forge/ }), { target: { value: "Yes" } });
    fireEvent.click(screen.getByRole("button", { name: /Send answer/ }));
    await waitFor(() => expect(document.querySelector('.qrow[data-id="r3"] .rq-rowst')?.innerHTML).toBeTruthy());
    await waitFor(() => expect(posts.some((p) => p.url.endsWith("/r3/respond"))).toBe(true));
    expect(rowIds()).toEqual(before);
  });
});

describe("requestPayload task chip", () => {
  it("a task_id value renders as a task chip labelled 'Task', not '[title]' under 'Task id'", () => {
    const tasks = [{ id: "b1aaaaaa-0000-4000-8000-000000000001", title: "Review PR #212", status: "in_progress" }] as never;
    const { container } = render(<PayloadView value={{ summary: "Blocked", task_id: "b1aaaaaa" }} tasks={tasks} />);
    const a = container.querySelector("a.rq-tasklink");
    expect(a?.getAttribute("href")).toBe("/tasks?task=b1aaaaaa-0000-4000-8000-000000000001");
    expect(a?.textContent).toContain("Review PR #212");
    expect(container.textContent).not.toContain("[Review PR #212]");
    expect(container.querySelector("dt")?.textContent).toBe("Task");
  });
});
