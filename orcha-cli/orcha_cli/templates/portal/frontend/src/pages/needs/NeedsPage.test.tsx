/**
 * Needs you queue: actionable vs assigned-to-someone-else vs informational,
 * advance after a successful decision (with session history), a failed
 * decision keeps its input and stays selected, request actions, history view,
 * all-projects scope (server needs_you, "unavailable" when missing), and the
 * honest empty / no-longer-waiting states.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "../../components/ui";
import { SnapshotProvider } from "../../state/SnapshotProvider";
import { _resetProjectsForTests } from "../../state/projects";
import { NeedsPage, _dropNeedsHistoryMemory, _resetNeedsHistory, deciderLabel, historyFor } from "./NeedsPage";

const base = { assignees: ["forge"], created_by_agent_id: "h1", definition_of_done: "It works", message_summary: { count: 1, last: null } };
let SNAP: Record<string, unknown>;
let failVerify = false;
let calls: { url: string; method: string; body: unknown }[] = [];
let loc = { search: "" };

function jsonRes(data: unknown, status = 200) {
  return { ok: status < 300, status, json: async () => data } as Response;
}

beforeEach(() => {
  calls = [];
  failVerify = false;
  _resetNeedsHistory();
  _resetProjectsForTests();
  SNAP = {
    container: { id: "c1", name: "Orcha", status: "active", autonomy_level: "plan" },
    agents: [
      { id: "h1", alias: "kedar", kind: "human", status: "idle", member_role: "member" },
      { id: "h2", alias: "sam", kind: "human", status: "idle", member_role: "owner" },
      { id: "a1", alias: "forge", kind: "ai", status: "working" },
    ],
    tasks: [
      { ...base, id: "t1", title: "Plan me", status: "in_progress", priority: 10, created_at: "2026-08-01T00:00:00Z", started_at: "2026-08-01T01:00:00Z", plan_message: { body: "Step 1: do it", author_alias: "forge", at: "2026-08-01T02:00:00Z" } },
      { ...base, id: "t2", title: "Verify me", status: "needs_verification", priority: 20, created_at: "2026-08-02T00:00:00Z", result: "Done it" },
      { ...base, id: "t3", title: "Sam reviews this", status: "needs_verification", priority: 20, created_at: "2026-08-03T00:00:00Z", reviewer_agent_id: "h2", reviewer: { agent_id: "h2", alias: "sam" } },
      { ...base, id: "t4", title: "Old plan", status: "in_progress", priority: 30, created_at: "2026-07-01T00:00:00Z", plan_message: { body: "x", author_alias: "forge" }, plan_decision: { decision: "approve", actor: "kedar", at: "2026-07-02T00:00:00Z" } },
    ],
    requests: [
      { id: "r1", type: "question", status: "open", priority: 30, requester_id: "a1", target_id: null, payload: "Which DB?", created_at: "2026-08-04T00:00:00Z" },
      { id: "r2", type: "question", status: "answered", priority: 30, requester_id: "h1", target_id: "a1", payload: "Status?", response: "All green", created_at: "2026-08-04T00:00:00Z", responded_at: "2026-08-05T00:00:00Z" },
    ],
  };
  window.scrollTo = vi.fn();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init && init.method) || "GET";
      const body = init && typeof init.body === "string" ? JSON.parse(init.body) : undefined;
      calls.push({ url, method, body });
      if (url === "/api/containers") return jsonRes([{ id: "c1", name: "Orcha", status: "active", needs_you: 3 }, { id: "c2", name: "Website", status: "active" }]);
      if (url.startsWith("/api/containers/c1")) return jsonRes(SNAP);
      if (/\/runs$/.test(url)) return jsonRes([]);
      if (/\/verify$/.test(url)) return failVerify ? jsonRes({ detail: "stale task" }, 409) : jsonRes({ ok: true });
      if (url === "/api/decisions") return jsonRes({ ok: true });
      if (/\/respond$/.test(url)) return jsonRes({ ok: true });
      return jsonRes({});
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
});

function Probe() {
  loc = { search: useLocation().search };
  return null;
}
function mount(entry = "/needs") {
  return render(
    <ToastProvider>
      <SnapshotProvider>
        <MemoryRouter initialEntries={[entry]}>
          <NeedsPage />
          <Probe />
        </MemoryRouter>
      </SnapshotProvider>
    </ToastProvider>,
  );
}
const rowKeys = (label: string) =>
  Array.from(screen.getByRole("group", { name: new RegExp("^" + label) }).querySelectorAll("[data-v2-row]")).map((r) => r.getAttribute("data-id"));
const item = () => new URLSearchParams(loc.search).get("item");

describe("NeedsPage", () => {
  it("separates waiting-on-you, assigned-to-someone-else and informational follow-ups", async () => {
    mount();
    await waitFor(() => expect(screen.getByRole("group", { name: /^Waiting on you \(3\)/ })).toBeInTheDocument());
    expect(rowKeys("Waiting on you")).toEqual(["plan:t1", "verify:t2", "request:r1"]);
    expect(rowKeys("Assigned to someone else")).toEqual(["verify:t3"]);
    expect(rowKeys("Follow-ups")).toEqual(["followup:r2"]);
    // the assigned-to-someone-else row is de-emphasised and says who
    expect(document.querySelector('[data-id="verify:t3"]')?.className).toContain("is-dim");
    expect(document.querySelector('[data-id="verify:t3"]')?.textContent).toContain("assigned to sam");
    // wave-4: the Waiting pill always carries its count (as Requests' "All 12" does),
    // selected or not — the unique entities waiting on you only
    expect(screen.getByRole("radio", { name: /^Waiting\s*3/ })).toBeInTheDocument();
  });

  it("approving a plan posts the decision, then advances to the next item and records history", async () => {
    mount();
    await waitFor(() => expect(document.querySelector("#gate-t1")).toBeTruthy());
    expect(document.querySelector("#gate-t1")!.textContent).toContain("Step 1: do it");
    fireEvent.click(document.querySelector('#gate-t1 [data-act="approve"]')!);
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByText("Approve plan"));
    await waitFor(() => expect(calls.some((c) => c.url === "/api/decisions" && (c.body as { subject_id: string }).subject_id === "t1")).toBe(true));
    await waitFor(() => expect(item()).toBe("verify:t2"));
    expect(document.querySelector("#gate-t2")).toBeTruthy();
    expect(document.querySelector("#needsAnnounce")?.textContent).toContain("Plan approved. Next: Verification — Verify me");
    fireEvent.click(screen.getByRole("radio", { name: "History" }));
    const hist = await screen.findByRole("region", { name: "Decided in this session" });
    expect(hist.textContent).toContain("Plan me");
    expect(hist.textContent).toContain("Plan approved");
    // snapshot history includes the older recorded plan decision
    expect(screen.getByRole("region", { name: "Recent decisions in this project" }).textContent).toContain("Old plan");
  });

  it("a failed verification keeps the reason, stays selected and stays in the queue", async () => {
    failVerify = true;
    mount("/needs?item=verify:t2");
    await waitFor(() => expect(document.querySelector("#gate-t2")).toBeTruthy());
    fireEvent.click(document.querySelector('#gate-t2 [data-act="reject"]')!);
    fireEvent.change(document.querySelector("#rt-t2")!, { target: { value: "not done" } });
    fireEvent.click(document.querySelector("#cr-t2")!);
    await screen.findByText(/Decision not recorded/);
    expect((document.querySelector("#rt-t2") as HTMLTextAreaElement).value).toBe("not done");
    expect(item()).toBe("verify:t2");
    expect(rowKeys("Waiting on you")).toContain("verify:t2");
  });

  it("answering a request uses the Requests action and advances", async () => {
    mount("/needs?item=request:r1");
    fireEvent.click(await screen.findByRole("button", { name: /^Answer$/ }));
    fireEvent.change(await screen.findByPlaceholderText(/forge sees it verbatim/), { target: { value: "Postgres" } });
    fireEvent.click(screen.getByRole("button", { name: /Send answer/ }));
    await waitFor(() => {
      const c = calls.find((x) => x.url === "/api/requests/r1/respond");
      expect(c?.body).toEqual({ responder_agent_id: "h1", response: "Postgres" });
    });
    await waitFor(() => expect(item()).not.toBe("request:r1"));
  });

  it("an item that is no longer waiting says so instead of showing something else", async () => {
    mount("/needs?item=verify:gone");
    expect(await screen.findByText("No longer waiting")).toBeInTheDocument();
  });

  it("all-projects scope shows the server count, labelled, and 'unavailable' when missing", async () => {
    mount("/needs?scope=all");
    const table = await screen.findByRole("table");
    await waitFor(() => expect(table.textContent).toContain("Website"));
    expect(table.textContent).toContain("unavailable");
    // the measure is explained behind an info mark, not a banner (D12)
    expect(screen.getByRole("img", { name: /plan approvals are not included/ })).toBeInTheDocument();
    expect(screen.queryByRole("note")).toBeNull();
    // every status reads the same way (chip with a word), and the current
    // project row has an action too
    expect(table.textContent).toContain("Active");
    fireEvent.click(screen.getByRole("link", { name: "Open queue for Orcha" }));
    await waitFor(() => expect(loc.search).toBe(""));
  });

  it("empty queue explains why, including autonomy gating", async () => {
    SNAP = { ...SNAP, container: { id: "c1", name: "Orcha", status: "active", autonomy_level: "full" }, tasks: [], requests: [] };
    mount();
    expect(await screen.findByText("Nothing needs you in Orcha")).toBeInTheDocument();
    expect(screen.getByText(/not required at autonomy “full”/)).toBeInTheDocument();
  });

  it("never shows raw JSON: object payloads render their title in rows, follow-ups and history", async () => {
    SNAP = {
      ...SNAP,
      requests: [
        { id: "r1", type: "question", status: "open", priority: 30, requester_id: "a1", target_id: null, payload: { question: "What's the ETA?", eta_hint: "friday" }, created_at: "2026-08-04T00:00:00Z" },
        { id: "r2", type: "question", status: "answered", priority: 30, requester_id: "h1", target_id: "a1", payload: '{"question":"Status?"}', response: { answer: "All green" }, created_at: "2026-08-04T00:00:00Z", responded_at: "2026-08-05T00:00:00Z" },
      ],
    };
    mount();
    await waitFor(() => expect(document.querySelector('[data-id="request:r1"]')).toBeTruthy());
    const list = document.getElementById("nlist")!;
    expect(list.textContent).toContain("What's the ETA?");
    expect(list.textContent).toContain("Status?");
    expect(list.textContent).not.toMatch(/[{}]|\[object Object\]/);
    fireEvent.click(screen.getByRole("radio", { name: "History" }));
    const past = await screen.findByRole("region", { name: "Recent decisions in this project" });
    expect(past.textContent).toContain("Status?");
    expect(past.textContent).not.toMatch(/[{}]/);
  });

  it("the detail shows the title once (large, in the pane) and the header never repeats it", async () => {
    mount("/needs?item=verify:t2");
    await waitFor(() => expect(document.querySelector("#gate-t2")).toBeTruthy());
    const crumbText = () => Array.from(document.querySelectorAll(".v2-header nav, .v2-header-crumbs")).map((n) => n.textContent).join(" ");
    expect(crumbText()).not.toContain("Verify me");
    expect(screen.getByRole("heading", { level: 1, name: "Verify me" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("radio", { name: "History" }));
    await screen.findByRole("region", { name: "Decided in this session" });
    expect(crumbText()).not.toContain("Verify me");
    expect(document.querySelector("#detailMain")).toBeNull(); // no stale detail on History
  });

  it("one view switcher (Waiting · History · All projects), project name in the tooltip, help behind an info mark", async () => {
    mount();
    const waiting = await screen.findByRole("radio", { name: /^Waiting/ });
    expect(waiting).toHaveAttribute("title", "Waiting on you in Orcha");
    expect(screen.queryByText(/^Counts one item per task/)).toBeNull();
    expect(screen.getByRole("img", { name: /How this queue counts/ })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("radio", { name: "All projects" }));
    await waitFor(() => expect(new URLSearchParams(loc.search).get("scope")).toBe("all"));
    fireEvent.click(screen.getByRole("radio", { name: /^Waiting/ }));
    await waitFor(() => expect(loc.search).toBe(""));
  });

  it("the pager walks the queue in list order", async () => {
    mount("/needs?item=plan:t1");
    const pos = await screen.findByRole("group", { name: "item 1 of 5" });
    expect(pos).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Previous item" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Next item" }));
    await waitFor(() => expect(item()).toBe("verify:t2"));
    expect(screen.getByRole("group", { name: "item 2 of 5" })).toBeInTheDocument();
  });

  it("rows are inbox items: title line + one muted 'what happened' line, avatar and age", async () => {
    mount();
    await waitFor(() => expect(document.querySelector('[data-id="plan:t1"]')).toBeTruthy());
    const r = document.querySelector('[data-id="plan:t1"]')!;
    expect(r.querySelector(".nd-title")?.textContent).toBe("Plan me");
    expect(r.querySelector(".nd-sub")?.textContent).toBe("Plan approval · Step 1: do it");
    expect(r.querySelector(".v2-av")).toBeTruthy();
  });

  it("activity lists only real timestamped events", async () => {
    mount("/needs?item=plan:t1");
    const act = await screen.findByRole("region", { name: "Activity" });
    expect(act.textContent).toContain("forge");
    expect(act.textContent).toContain("proposed a plan");
    expect(act.textContent).toContain("started work");
  });

  it("the comment composer posts to the task thread as the acting human", async () => {
    mount("/needs?item=plan:t1");
    const box = await screen.findByRole("textbox", { name: "Comment on Plan me" });
    fireEvent.change(box, { target: { value: "Looks good, one question" } });
    fireEvent.click(screen.getByRole("button", { name: "Post comment" }));
    await waitFor(() => {
      const c = calls.find((x) => x.url === "/api/tasks/t1/messages" && x.method === "POST");
      expect(c?.body).toEqual({ body: "Looks good, one question", author_agent_id: "h1" });
    });
  });

  it("after a decision every count agrees immediately (tab and group header)", async () => {
    mount("/needs?item=verify:t2");
    await waitFor(() => expect(document.querySelector('#gate-t2 [data-act="approve"]')).toBeTruthy());
    fireEvent.click(document.querySelector('#gate-t2 [data-act="approve"]')!);
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByText("Accept"));
    await waitFor(() => expect(screen.getByRole("group", { name: /^Waiting on you \(2\)/ })).toBeInTheDocument());
    // on History the pill carries the (updated) count, since no band shows it
    fireEvent.click(screen.getByRole("radio", { name: "History" }));
    await waitFor(() => expect(screen.getByRole("radio", { name: /^Waiting\s*2$/ })).toBeInTheDocument());
    // session history names who decided (the acting human), not the item kind
    const hist = await screen.findByRole("region", { name: "Decided in this session" });
    expect(hist.textContent).toContain("Accepted");
    expect(hist.textContent).not.toContain("Accepted · completed");
    // the acting human is "you", as on Requests / Activity
    expect(hist.textContent).toContain("by you");
    expect(hist.textContent).not.toContain("by kedar");
    expect(hist.textContent).not.toContain("by Verification");
  });

  it("j/k move the selection through the queue (not only focus); arrows follow list focus", async () => {
    mount("/needs?item=plan:t1");
    await waitFor(() => expect(document.querySelector("#gate-t1")).toBeTruthy());
    fireEvent.keyDown(document.body, { key: "j" });
    await waitFor(() => expect(item()).toBe("verify:t2"));
    fireEvent.keyDown(document.body, { key: "j" });
    await waitFor(() => expect(item()).toBe("request:r1"));
    fireEvent.keyDown(document.body, { key: "k" });
    await waitFor(() => expect(item()).toBe("verify:t2"));
    // ArrowDown inside the list: List moves focus, the page selects that row
    const row = document.querySelector<HTMLElement>('[data-id="verify:t2"]')!;
    row.focus();
    fireEvent.keyDown(row, { key: "ArrowDown" });
    await waitFor(() => expect(item()).toBe("request:r1"));
    // typing in the composer never navigates
    const box = screen.queryByRole("textbox");
    if (box) {
      fireEvent.keyDown(box, { key: "j" });
      expect(item()).toBe("request:r1");
    }
  });

  it("Escape closes an empty inline reject form before it closes the detail", async () => {
    mount("/needs?item=verify:t2");
    await waitFor(() => expect(document.querySelector("#gate-t2")).toBeTruthy());
    fireEvent.click(document.querySelector('#gate-t2 [data-act="reject"]')!);
    await waitFor(() => expect(document.querySelector("#reason-t2")?.className).toContain("show"));
    fireEvent.keyDown(document.body, { key: "Escape" });
    await waitFor(() => expect(document.querySelector("#reason-t2")?.className).not.toContain("show"));
    expect(item()).toBe("verify:t2"); // the detail stays open
    fireEvent.keyDown(document.body, { key: "Escape" });
    await waitFor(() => expect(item()).toBeNull());
  });

  it("an escalated request you cannot answer is titled truthfully (never 'Nothing needed')", async () => {
    SNAP = {
      ...SNAP,
      agents: [...(SNAP.agents as object[]), { id: "a2", alias: "lead", kind: "ai", status: "working" }],
      requests: [
        { id: "r9", type: "review", status: "escalated", escalated: true, priority: 1, requester_id: "a1", target_id: "a2", from: "forge", to: "lead", payload: { summary: "Blocked on missing credentials" }, created_at: "2026-08-04T00:00:00Z" },
      ],
    };
    mount("/needs?item=request:r9");
    await screen.findByRole("heading", { level: 1, name: "Blocked on missing credentials" });
    // the card is titled by who owns the next step (RequestDetail): a legacy
    // escalated request is counted as yours, so the card says so — never
    // "waiting on lead" and never "Nothing needed" on a counted item
    await waitFor(() => expect(document.querySelector(".nd-req")?.textContent).toMatch(/Escalated to you/i));
    expect(document.querySelector(".nd-req")?.textContent).not.toMatch(/waiting on lead/i);
    expect(document.body.textContent).not.toContain("Nothing needed from you");
    // the ID is shown once — in the detail header — not again in Details
    expect(document.querySelectorAll(".nd-id").length).toBe(1);
  });

  it("a long request question: short title, the rest once as the description", async () => {
    SNAP = {
      ...SNAP,
      requests: [
        { id: "r7", type: "question", status: "open", priority: 1, requester_id: "a1", target_id: null, payload: { question: "Should the billing migration run during business hours, or wait for the Saturday 02:00 UTC window? Month-end invoicing overlaps the weekday option." }, created_at: "2026-08-04T00:00:00Z" },
      ],
    };
    mount("/needs?item=request:r7");
    const h1 = await screen.findByRole("heading", { level: 1, name: /^Should the billing migration/ });
    expect(h1.textContent).toBe("Should the billing migration run during business hours, or wait for the Saturday 02:00 UTC window?");
    // the rest shows once (RequestDetail's body, title dropped from it)
    await waitFor(() => expect(document.body.textContent).toContain("Month-end invoicing overlaps the weekday option."));
    const body = document.querySelector(".nd-dbody")!;
    expect(body.textContent!.split("Month-end invoicing overlaps").length - 1).toBe(1);
    expect(document.querySelector(".nd-req")?.textContent).not.toContain("Should the billing migration");
  });

  it("session history survives a reload (sessionStorage per project) and names you", async () => {
    mount("/needs?item=verify:t2");
    await waitFor(() => expect(document.querySelector('#gate-t2 [data-act="approve"]')).toBeTruthy());
    fireEvent.click(document.querySelector('#gate-t2 [data-act="approve"]')!);
    fireEvent.click(within(await screen.findByRole("dialog")).getByText("Accept"));
    await waitFor(() => expect(historyFor("c1").length).toBe(1));
    cleanup();
    _dropNeedsHistoryMemory(); // as a page reload would
    expect(historyFor("c1").map((e) => e.key)).toEqual(["verify:t2"]);
    mount("/needs?view=history");
    const hist = await screen.findByRole("region", { name: "Decided in this session" });
    expect(hist.textContent).toContain("Verify me");
    expect(hist.textContent).toContain("by you");
    // snapshot history: kedar (acting) decided the old plan → "you"
    const past = screen.getByRole("region", { name: "Recent decisions in this project" });
    expect(past.textContent).toContain("Plan approved · by you");
  });

  it("deciderLabel maps only the acting human to 'you'", () => {
    expect(deciderLabel("kedar", "kedar")).toBe("you");
    expect(deciderLabel("@kedar", "kedar")).toBe("you");
    expect(deciderLabel("lead", "kedar")).toBe("lead");
    expect(deciderLabel(null, "kedar")).toBeNull();
  });

  it("detail meta states each fact once: no 'waiting …' age; names the assigned reviewer when it isn't you", async () => {
    SNAP = { ...SNAP, agents: (SNAP.agents as { alias: string }[]).map((a) => (a.alias === "kedar" ? { ...a, member_role: "owner" } : a)) };
    mount("/needs?item=verify:t3");
    await waitFor(() => expect(document.querySelector("#gate-t3")).toBeTruthy());
    const meta = document.querySelector(".nd-meta")!;
    expect(meta.textContent).toContain("review: sam");
    expect(meta.textContent).not.toMatch(/waiting/);
  });

  it("the header ID is a copy button with a copy icon; the header title is not a second h1", async () => {
    mount("/needs?item=verify:t2");
    await waitFor(() => expect(document.querySelector("#gate-t2")).toBeTruthy());
    const id = screen.getByRole("button", { name: /^Copy ID / });
    expect(id.querySelector(".nd-id-copy")).toBeTruthy();
    expect(screen.getAllByRole("heading", { level: 1 }).map((h) => h.textContent)).toEqual(["Verify me"]);
  });

  it("All projects: each row shows the project's icon (D14 — default glyph, never initials)", async () => {
    mount("/needs?scope=all");
    const table = await screen.findByRole("table");
    await waitFor(() => expect(table.querySelectorAll("tbody tr").length).toBe(2));
    const icons = Array.from(table.querySelectorAll<HTMLElement>("tbody .v2-picon"));
    expect(icons.length).toBe(2);
    icons.forEach((el) => { expect(el).toHaveAttribute("data-icon", "default"); expect(el.textContent).toBe(""); });
    expect(table.querySelector("tbody .v2-av-project")).toBeNull();
  });
});
