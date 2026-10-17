/**
 * Parity round 1 — Tasks fixer regressions (compare-r1 + wave-4 review):
 *  MEM-REV reviewer delegation (assign_reviewers grant), viewers never offered
 *  as reviewer, viewer reasons instead of "pick an acting human", Cancel task
 *  disabled for viewers, scope pills unknown until loaded, Back clears the
 *  selection, Esc from the diff full view keeps the detail, list scroll per
 *  history entry, custom numeric priority, assignee → agent link, /done result
 *  envelope unwrapped, decision markers as structured events, "Changes
 *  requested" after a reject, plan text never twice, a human-stopped run is
 *  "cancelled", tool input behind Details, Plan waiting by EFFECTIVE autonomy,
 *  the board without the root task, and the detail CSS fixes.
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, useLocation, useNavigate } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "../../components/ui";
import { SnapshotProvider } from "../../state/SnapshotProvider";
import { extensions, type Identity } from "../../extensions";
import { TasksPage } from "./TasksPage";
import { canAssignReviewer, latestRejection, parseThreadMarker, unwrapDoneResult } from "./TaskDetail";
import { taskDetailCss } from "./detailCss";
import { tasksListCss } from "./tasksListCss";
import type { Agent } from "../../types";

function task(id: string, title: string, status: string, priority: number, extra: Record<string, unknown> = {}) {
  return {
    id,
    title,
    status,
    priority,
    assignees: ["forge"],
    created_by_agent_id: "h1",
    created_at: "2026-08-01T00:00:00Z",
    definition_of_done: "DoD for " + title,
    message_summary: { count: 0, last: null },
    ...extra,
  };
}

let SNAP: Record<string, unknown>;
let RUNS: unknown[] = [];
let MSGS: unknown[] = [];
let holdSnapshot = false;
let calls: { url: string; method: string; body: unknown }[] = [];
const jsonRes = (data: unknown, status = 200) => ({ ok: status < 300, status, json: async () => data }) as Response;

beforeEach(() => {
  calls = [];
  RUNS = [];
  MSGS = [];
  holdSnapshot = false;
  SNAP = {
    container: { id: "c1", name: "Orcha", status: "active", autonomy_level: "plan" },
    agents: [
      { id: "h1", alias: "kedar", kind: "human", status: "idle", member_role: "owner" },
      { id: "h2", alias: "amina", kind: "human", status: "idle", member_role: "member" },
      { id: "h3", alias: "tomas", kind: "human", status: "idle", member_role: "viewer" },
      { id: "a1", alias: "forge", kind: "ai", status: "working" },
      { id: "a2", alias: "infra", kind: "ai", status: "working", effective_autonomy: "full" },
    ],
    tasks: [
      task("t1aaaaaa", "Verify me", "needs_verification", 10, { result: { result: "Shipped the export", by_agent_id: "859a6f85-0000-4000-8000-000000000000" } }),
      task("t2bbbbbb", "Second task", "in_progress", 50, { created_at: "2026-08-02T00:00:00Z", started_at: "2026-08-02T01:00:00Z" }),
      task("t3cccccc", "Third task", "ready", 30, { created_at: "2026-08-03T00:00:00Z" }),
      task("t0rootxx", "The project", "in_progress", 100, { is_root: true, assignees: [] }),
    ],
    requests: [],
  };
  window.scrollTo = vi.fn();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init && init.method) || "GET";
      let body: unknown;
      if (init && typeof init.body === "string") body = JSON.parse(init.body);
      calls.push({ url, method, body });
      if (url === "/api/containers") return jsonRes([{ id: "c1", status: "active" }]);
      if (url.startsWith("/api/containers/c1") && method === "GET") {
        if (holdSnapshot) return new Promise<Response>(() => undefined);
        return jsonRes(SNAP);
      }
      if (/\/api\/containers\/c1\/tasks$/.test(url) && method === "POST") return jsonRes({ task_id: "tnew0000", status: "ready" });
      if (/\/messages$/.test(url) && method === "GET") return jsonRes({ messages: MSGS });
      if (/\/runs$/.test(url)) return jsonRes(RUNS);
      if (/\/close-implications$/.test(url))
        return jsonRes({
          downstream_tasks: [],
          in_flight_agents: [],
          spawned_from_request: null,
          open_requests_from_assignees: [],
          summary: { downstream_total: 0, would_unblock: 0, still_blocked: 0, in_flight_agents: 0, open_requests: 0, completes_container: false },
        });
      return jsonRes({});
    }),
  );
});

afterEach(() => {
  cleanup();
  delete extensions.identity;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  try {
    localStorage.clear();
    sessionStorage.clear();
  } catch {
    /* jsdom */
  }
});

let nav: ReturnType<typeof useNavigate> | null = null;
let loc: ReturnType<typeof useLocation> | null = null;
function Probe() {
  nav = useNavigate();
  loc = useLocation();
  return null;
}
function renderPage(entries: string[] | string, index?: number) {
  const list = Array.isArray(entries) ? entries : [entries];
  return render(
    <ToastProvider>
      <SnapshotProvider>
        <MemoryRouter initialEntries={list} initialIndex={index ?? list.length - 1}>
          <Probe />
          <TasksPage />
        </MemoryRouter>
      </SnapshotProvider>
    </ToastProvider>,
  );
}
const pane = () => document.querySelector("#detailMain .td-pane") as HTMLElement;
const asIdentity = (id: Partial<Identity> & { grants?: string[] }) => {
  extensions.identity = async () => id as Identity;
};

/* ---- MEM-REV + e2e-permissions-21: reviewer ------------------------------- */
describe("reviewer picker", () => {
  it("a member holding assign_reviewers may change the reviewer (server accepts it)", async () => {
    asIdentity({ agent_id: "h2", alias: "amina", member_role: "member", grants: ["assign_reviewers"] });
    renderPage("/tasks?task=t3cccccc");
    await waitFor(() => expect(pane().querySelector('[data-act="reviewer"]')).toBeTruthy());
  });
  it("a member without the grant, and a viewer, see the reviewer read-only", async () => {
    asIdentity({ agent_id: "h2", alias: "amina", member_role: "member", grants: [] });
    renderPage("/tasks?task=t3cccccc");
    await waitFor(() => expect(pane()?.querySelector(".td-rev")).toBeTruthy());
    expect(pane().querySelector('[data-act="reviewer"]')).toBeNull();
  });
  it("canAssignReviewer: owner yes · granted member yes · member no · viewer no · read-only no · trust-off falls back to member_role", () => {
    const h = { id: "h2", alias: "amina", kind: "human", member_role: "member" } as unknown as Agent;
    expect(canAssignReviewer({ member_role: "owner" }, h, false)).toBe(true);
    expect(canAssignReviewer({ member_role: "member", grants: ["assign_reviewers"] }, h, false)).toBe(true);
    expect(canAssignReviewer({ member_role: "member", grants: ["manage_keys"] }, h, false)).toBe(false);
    expect(canAssignReviewer({ member_role: "viewer", grants: ["assign_reviewers"] }, h, false)).toBe(false);
    expect(canAssignReviewer({ member_role: "owner" }, h, true)).toBe(false);
    expect(canAssignReviewer(null, h, false)).toBe(false);
    expect(canAssignReviewer(null, { ...h, member_role: "owner" } as Agent, false)).toBe(true);
  });
  it("the owner's picker never offers a viewer (the server refuses a read-only reviewer)", async () => {
    renderPage("/tasks?task=t3cccccc");
    const btn = await waitFor(() => {
      const b = pane().querySelector('[data-act="reviewer"]') as HTMLElement;
      expect(b).toBeTruthy();
      return b;
    });
    fireEvent.click(btn);
    const menu = await screen.findByRole("menu", { name: "Reviewer" });
    const labels = within(menu).getAllByRole("menuitemradio").map((i) => i.textContent);
    expect(labels.join("|")).toContain("kedar");
    expect(labels.join("|")).toContain("amina");
    expect(labels.join("|")).not.toContain("tomas");
  });
});

/* ---- e2e-permissions-10/12: viewer reasons + disabled Cancel / composer --- */
describe("viewer (read-only)", () => {
  it("New task, Cancel task… and the comment composer are disabled with the viewer reason", async () => {
    asIdentity({ agent_id: "h3", alias: "tomas", member_role: "viewer" });
    renderPage("/tasks?task=t3cccccc");
    const cancel = await waitFor(() => {
      const b = pane().querySelector('[data-act="cancel"]') as HTMLButtonElement;
      expect(b).toBeTruthy();
      return b;
    });
    await waitFor(() => expect(cancel.disabled).toBe(true));
    expect(cancel.title).toContain("viewer");
    const newBtn = document.querySelector('[data-newtask="true"]') as HTMLButtonElement;
    expect(newBtn.disabled).toBe(true);
    expect(newBtn.title).toContain("viewer");
    expect(newBtn.title).not.toMatch(/acting human/i);
    const reply = document.querySelector("#reply") as HTMLTextAreaElement;
    expect(reply.disabled).toBe(true);
    // the ⋯ menu's Cancel task… is disabled too
    fireEvent.click(within(pane()).getByRole("button", { name: "Task actions" }));
    const item = await screen.findByRole("menuitem", { name: /Cancel task/ });
    expect(item.getAttribute("aria-disabled")).toBe("true");
  });
});

/* ---- e2e-scope-live-6: unknown ≠ 0 ------------------------------------------ */
describe("scope pills", () => {
  it("show no counts while the snapshot has not landed", async () => {
    holdSnapshot = true;
    renderPage("/tasks");
    const pills = await screen.findByRole("radiogroup", { name: "Task scope" });
    expect(pills.querySelector(".v2-pill-count")).toBeNull();
  });
  it("show counts once it has", async () => {
    renderPage("/tasks");
    const pills = await screen.findByRole("radiogroup", { name: "Task scope" });
    await waitFor(() => expect(pills.querySelector(".v2-pill-count")).toBeTruthy());
  });
});

/* ---- e2e-scope-live-8: 403 / 404 are not an outage ------------------------ */
describe("a project the viewer can't read", () => {
  it("403 says 'not a member' (no Retry) — not 'backend did not answer'", async () => {
    type F = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
    const f = vi.mocked(globalThis.fetch as F);
    const orig = f.getMockImplementation() as F;
    f.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).startsWith("/api/containers/c1") && !(init && init.method && init.method !== "GET")) return jsonRes({ detail: "not a member of this project" }, 403);
      return orig(input, init);
    });
    renderPage("/tasks");
    await waitFor(() => expect(screen.getByText("You're not a member of this project")).toBeTruthy(), { timeout: 4000 });
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
    expect(document.body.textContent).not.toContain("did not answer");
  });
});

/* ---- e2e-scope-live-23: Back clears the selection ---------------------------- */
describe("Back from a pushed detail", () => {
  it("dropping ?task= (browser Back) returns the board instead of keeping the full view", async () => {
    renderPage(["/tasks?view=board", "/tasks?view=board&task=t3cccccc&full=1"]);
    await waitFor(() => expect(pane()?.className).toContain("is-full"));
    act(() => nav!(-1));
    await waitFor(() => expect(document.querySelector("#detailMain")).toBeNull());
    expect(document.querySelector(".tl-board")).toBeTruthy();
  });
});

/* ---- TSK-129: Esc from the diff full view -------------------------------- */
describe("Escape with the diff full view open", () => {
  it("collapses only the diff — the task detail and ?task= stay", async () => {
    renderPage("/tasks?task=t3cccccc");
    await waitFor(() => expect(pane()).toBeTruthy());
    // a FilesChanged full view whose own Escape handler removes it first
    const dfv = document.createElement("div");
    dfv.className = "dfv dfv-full";
    document.body.appendChild(dfv);
    const removeFirst = (e: KeyboardEvent) => {
      if (e.key === "Escape") dfv.remove();
    };
    document.addEventListener("keydown", removeFirst);
    try {
      fireEvent.keyDown(document.body, { key: "Escape" });
      await new Promise((r) => setTimeout(r, 30));
      expect(new URLSearchParams(loc!.search).get("task")).toBe("t3cccccc");
      expect(pane()).toBeTruthy();
      // the next Escape (no overlay) closes the detail as before
      fireEvent.keyDown(document.body, { key: "Escape" });
      await waitFor(() => expect(new URLSearchParams(loc!.search).get("task")).toBeNull());
    } finally {
      document.removeEventListener("keydown", removeFirst);
    }
  });
});

/* ---- e2e-scope-live-22: list scroll per history entry --------------------- */
describe("list scroll restore", () => {
  it("Back to a Tasks entry restores its saved list scroll once the rows render", async () => {
    sessionStorage.setItem("orcha:v2:tasks:scroll:default", "300");
    renderPage("/tasks");
    await waitFor(() => expect(document.querySelectorAll(".trow").length).toBeGreaterThan(0));
    await waitFor(() => expect(window.scrollTo).toHaveBeenCalledWith(expect.objectContaining({ top: 300 })));
  });
});

/* ---- TSK-035: numeric priority ---------------------------------------------- */
describe("New task — custom numeric priority", () => {
  const fill = async () => {
    const dialog = await screen.findByRole("dialog", { name: /New task/ });
    fireEvent.change(dialog.querySelector("#nt_title")!, { target: { value: "Ship it" } });
    fireEvent.change(dialog.querySelector("#nt_dod")!, { target: { value: "It ships" } });
    fireEvent.click(dialog.querySelector("#nt_pri")!);
    const pm = await screen.findByRole("menu", { name: "Priority" });
    fireEvent.click(within(pm).getByRole("menuitemradio", { name: /Custom/ }));
    return dialog;
  };
  it("POSTs the exact integer", async () => {
    renderPage("/tasks?new=1");
    const dialog = await fill();
    const n = (await waitFor(() => {
      const el = dialog.querySelector("#nt_pri_n");
      expect(el).toBeTruthy();
      return el;
    })) as HTMLInputElement;
    expect(n.value).toBe("100"); // starts from the preset it replaced
    fireEvent.change(n, { target: { value: "30" } });
    fireEvent.click(within(dialog).getByRole("button", { name: /Create task/ }));
    await waitFor(() => {
      const c = calls.find((x) => x.method === "POST" && /\/tasks$/.test(x.url));
      expect(c?.body).toMatchObject({ priority: 30, title: "Ship it" });
    });
  });
  it("refuses a value below 1 without posting", async () => {
    renderPage("/tasks?new=1");
    const dialog = await fill();
    const n = (await waitFor(() => dialog.querySelector("#nt_pri_n"))) as HTMLInputElement;
    fireEvent.change(n, { target: { value: "0" } });
    fireEvent.click(within(dialog).getByRole("button", { name: /Create task/ }));
    await waitFor(() => expect(dialog.textContent).toContain("Priority must be a whole number"));
    expect(calls.some((x) => x.method === "POST" && /\/tasks$/.test(x.url))).toBe(false);
  });
});

/* ---- TSK-046: assignee → agent ---------------------------------------------- */
describe("assignee link", () => {
  it("an assignable task keeps a link to its agent beside the picker (rail + ⋯ menu)", async () => {
    renderPage("/tasks?task=t2bbbbbb&full=1");
    await waitFor(() => expect(pane().querySelector('[data-open-agent="forge"]')).toBeTruthy());
    expect(pane().querySelector('[data-open-agent="forge"]')!.getAttribute("href")).toBe("/agents?agent=forge");
    fireEvent.click(within(pane()).getByRole("button", { name: "Task actions" }));
    const item = await screen.findByRole("menuitem", { name: /Open agent/ });
    expect(item).toBeTruthy();
  });
});

/* ---- /done envelope ------------------------------------------------------------ */
describe("result envelope", () => {
  it("unwrapDoneResult strips {result, by_agent_id} and keeps any other object", () => {
    expect(unwrapDoneResult({ result: "x", by_agent_id: "a" })).toBe("x");
    expect(unwrapDoneResult({ result: { summary: "s" } })).toEqual({ summary: "s" });
    expect(unwrapDoneResult({ summary: "s", result: "x" })).toEqual({ summary: "s", result: "x" });
    expect(unwrapDoneResult("plain")).toBe("plain");
  });
  it("the verify gate shows the result text, never 'Result | Result' or a raw agent id", async () => {
    renderPage("/tasks?task=t1aaaaaa");
    const gate = await waitFor(() => {
      const g = document.querySelector("#gate-t1aaaaaa") as HTMLElement;
      expect(g).toBeTruthy();
      return g;
    });
    expect(gate.textContent).toContain("Shipped the export");
    expect(gate.textContent).not.toContain("859a6f85");
    expect(gate.textContent).not.toMatch(/By agent/i);
  });
});

/* ---- markers + reject feedback --------------------------------------------- */
describe("activity markers and a rejected attempt", () => {
  it("parses the backend markers", () => {
    expect(parseThreadMarker("[DECISION · plan_approval = APPROVED by kedar]")).toEqual({ kind: "decision", subject: "plan_approval", approved: true, actor: "kedar", reason: "" });
    expect(parseThreadMarker("[DECISION · plan_approval = REJECTED by kedar] — too broad")).toMatchObject({ approved: false, reason: "too broad" });
    expect(parseThreadMarker("[verification rejected] Tests fail")).toEqual({ kind: "verify_rejected", feedback: "Tests fail" });
    expect(parseThreadMarker("hello")).toBeNull();
    // mig 068: the Verdikt auto-fix loop's system lines
    expect(parseThreadMarker("[Verdikt auto-fix] Verdikt failed this task on attempt 2 of 3. Embodent sent it back…\n\nFailed criteria:\n1. The error text is red\n   Actual: black\n   Screenshot: /api/x.png\n\nReport: /x"))
      .toEqual({ kind: "autofix_rework", attempt: 2, max: 3, detail: "1. The error text is red\n   Actual: black" });
    expect(parseThreadMarker("[Verdikt auto-fix] Stopped: Verdikt passed on attempt 3 of 3 — ready for your review"))
      .toEqual({ kind: "autofix_stopped", reason: "Verdikt passed on attempt 3 of 3 — ready for your review" });
    expect(latestRejection([
      { id: "1", is_human: false, from: "system", body: "[verification rejected] old", at: "2026-08-02T00:00:00Z", attachments: [] },
      { id: "2", is_human: false, from: "system", body: "[verification rejected] new", at: "2026-08-03T00:00:00Z", attachments: [] },
    ])?.feedback).toBe("new");
  });
  it("renders markers as events, shows 'Changes requested' near the top and marks the old result", async () => {
    const tasks = SNAP.tasks as Record<string, unknown>[];
    tasks[1] = { ...tasks[1], result: "First attempt", plan_decision: { decision: "approve", actor: "kedar", at: "2026-08-02T02:00:00Z" }, message_summary: { count: 2, last: null } };
    MSGS = [
      { message_id: "m1", author_id: "h1", is_human: true, body: "[DECISION · plan_approval = APPROVED by kedar]", created_at: "2026-08-02T02:00:00Z" },
      { message_id: "m2", author_id: null, is_human: false, body: "[verification rejected] The export drops the header row", created_at: "2026-08-02T05:00:00Z" },
    ];
    renderPage("/tasks?task=t2bbbbbb");
    const card = await waitFor(() => {
      const c = pane().querySelector("[data-changes-requested]") as HTMLElement;
      expect(c).toBeTruthy();
      return c;
    });
    expect(card.textContent).toContain("The export drops the header row");
    expect(pane().querySelector("[data-result-rejected]")?.textContent).toContain("Previous result · rejected");
    const tl = pane().querySelector(".td-tl") as HTMLElement;
    expect(tl.textContent).not.toContain("[DECISION");
    expect(tl.textContent).not.toContain("[verification rejected]");
    expect(tl.textContent).toContain("Verification rejected");
    // the decision appears ONCE (the marker), not also from plan_decision
    expect(tl.textContent!.match(/approved the plan/g)?.length).toBe(1);
  });
});

/* ---- plan text never twice --------------------------------------------------- */
describe("plan message in Activity", () => {
  it("collapses to one line while the gate shows the plan", async () => {
    const tasks = SNAP.tasks as Record<string, unknown>[];
    tasks[1] = { ...tasks[1], plan_message: { body: "1. Do the thing carefully", author_alias: "forge", at: "2026-08-02T01:30:00Z" }, message_summary: { count: 1, last: null } };
    MSGS = [{ message_id: "p1", author_id: "a1", author_alias: "forge", is_human: false, body: "1. Do the thing carefully", created_at: "2026-08-02T01:30:00Z" }];
    renderPage("/tasks?task=t2bbbbbb");
    await waitFor(() => expect(pane().querySelector("#gate-t2bbbbbb")).toBeTruthy());
    await waitFor(() => expect(pane().querySelector(".td-tl")?.textContent).toContain("posted the plan"));
    expect(pane().querySelector(".td-tl")!.textContent).not.toContain("Do the thing carefully");
  });
});

describe("an undecided opening message is not a plan", () => {
  it("a failed task's first agent note stays in Activity only — no 'opening plan' disclosure, no 'posted the plan'", async () => {
    const tasks = SNAP.tasks as Record<string, unknown>[];
    tasks[2] = { ...tasks[2], status: "failed", plan_message: { body: "Could not reproduce in 40 runs", author_alias: "forge", at: "2026-08-03T01:00:00Z" }, message_summary: { count: 1, last: null } };
    MSGS = [{ message_id: "n1", author_id: "a1", author_alias: "forge", is_human: false, body: "Could not reproduce in 40 runs", created_at: "2026-08-03T01:00:00Z" }];
    renderPage("/tasks?task=t3cccccc");
    await waitFor(() => expect(pane().querySelector(".td-tl")?.textContent).toContain("Could not reproduce in 40 runs"));
    expect(pane().querySelector(".td-plan")).toBeNull();
    expect(pane().querySelector(".td-tl")!.textContent).not.toContain("posted the plan");
  });
});

describe("comment draft", () => {
  it("an unsent comment survives leaving the task (project switch / remount) and clears once posted", async () => {
    const first = renderPage("/tasks?task=t3cccccc");
    const reply = (await waitFor(() => {
      const r = document.querySelector("#reply") as HTMLTextAreaElement;
      expect(r).toBeTruthy();
      return r;
    })) as HTMLTextAreaElement;
    fireEvent.change(reply, { target: { value: "half-typed thought" } });
    first.unmount();
    renderPage("/tasks?task=t3cccccc");
    const again = (await waitFor(() => {
      const r = document.querySelector("#reply") as HTMLTextAreaElement;
      expect(r?.value).toBe("half-typed thought");
      return r;
    })) as HTMLTextAreaElement;
    fireEvent.click(document.querySelector("#replyBtn")!);
    await waitFor(() => expect(calls.some((c) => c.method === "POST" && /\/messages$/.test(c.url))).toBe(true));
    await waitFor(() => expect(again.value).toBe(""));
    expect(sessionStorage.getItem("orcha:v2:taskDraft:t3cccccc")).toBeNull();
  });
});

/* ---- runs ------------------------------------------------------------------------ */
describe("runs", () => {
  it("a human-stopped run is a cancelled glyph, tool input sits behind Details", async () => {
    RUNS = [
      {
        run_id: "r1",
        agent: "forge",
        status: "killed",
        kill_reason: JSON.stringify({ cause: "human_stop" }),
        exit_code: 137,
        started_at: "2026-08-02T03:00:00Z",
        ended_at: "2026-08-02T03:05:00Z",
        output: JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "Bash", input: { command: "pytest tests/x.py", description: "run" } }] } }),
      },
    ];
    renderPage("/tasks?task=t2bbbbbb&tab=runs");
    const log = await waitFor(() => {
      const l = pane().querySelector(".wk-runs .log") as HTMLElement;
      expect(l?.querySelector(".ln")).toBeTruthy();
      return l;
    });
    const det = log.querySelector("details.det-x") as HTMLDetailsElement;
    expect(det).toBeTruthy();
    expect(det.open).toBe(false);
    expect(det.textContent).toContain('"command"');
    const ev = pane().querySelector(".td-tl") as HTMLElement;
    await waitFor(() => expect(ev.textContent).toContain("Stopped"));
    const glyphs = Array.from(ev.querySelectorAll("[data-shape]")).map((g) => g.getAttribute("data-shape"));
    expect(glyphs).toContain("cancelled");
    expect(glyphs).not.toContain("failed");
  });
});

/* ---- Plan waiting by effective autonomy + board root ------------------------- */
describe("list chips and board", () => {
  it("'Plan waiting' only when the plan author's effective autonomy is plan", async () => {
    const tasks = SNAP.tasks as Record<string, unknown>[];
    tasks[1] = { ...tasks[1], plan_message: { body: "plan A", author_alias: "forge" } };
    tasks[2] = { ...tasks[2], status: "in_progress", assignees: ["infra"], plan_message: { body: "progress note", author_alias: "infra" } };
    renderPage("/tasks");
    await waitFor(() => expect(document.querySelector('.trow[data-id="t2bbbbbb"]')?.textContent).toContain("Plan waiting"));
    expect(document.querySelector('.trow[data-id="t3cccccc"]')?.textContent).not.toContain("Plan waiting");
  });
  it("the board leaves out the root task", async () => {
    renderPage("/tasks?view=board");
    await waitFor(() => expect(document.querySelector(".tl-board")?.textContent).toContain("Second task"));
    expect(document.querySelector(".tl-board")!.textContent).not.toContain("The project");
  });
});

/* ---- full view meta line + CSS ---------------------------------------------- */
describe("detail layout", () => {
  it("the full view carries a compact meta line for the stacked layout", async () => {
    renderPage("/tasks?task=t2bbbbbb&full=1");
    const meta = await waitFor(() => {
      const m = pane().querySelector(".td-meta.td-meta-full") as HTMLElement;
      expect(m).toBeTruthy();
      return m;
    });
    expect(meta.textContent).toContain("forge");
    expect(meta.querySelector('[data-act="assign"]')).toBeNull(); // one assignee editor (the rail)
  });
  it("CSS: Activity takes the free rows, the rail assignee never max-content, reviewer chip hidden on phones", () => {
    expect(taskDetailCss).toMatch(/grid-template-rows:\s*auto 1fr/);
    expect(taskDetailCss).not.toMatch(/\.td-assign-rail \.td-assign-btn \{[^}]*max-content/);
    expect(taskDetailCss).toMatch(/\.td-meta\.td-meta-full \{ display: none; \}/);
    expect(tasksListCss).toMatch(/\.tl-row \.tl-revchip \{ display: none; \}/);
  });
});
