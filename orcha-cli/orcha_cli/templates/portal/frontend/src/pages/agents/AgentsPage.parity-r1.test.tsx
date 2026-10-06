/**
 * Parity round 1 (agents) regression tests — one per fixed item:
 *   AA-048   Incoming / Outgoing requests sort independently (agent-req-in / -out)
 *   AA-089   the lock dims only the composer input; Pair / Maximize stay usable
 *   EXTRA    no thinking dots while the conversation is paused by a live terminal
 *   perm-10  viewer denials name the viewer reason, never "pick an acting human"
 *   perm-13  agent config (provider / model / effort) needs owner-or-manage_agents
 *   EX-18    auto-wake needs owner-or-manage_autonomy (agent_wake_policy_routes.py)
 *   perm-14  New agent is disabled with a reason without manage_agents
 *   perm-26  a viewer's conversation composer is disabled with the reason
 *   home     "Plan waiting" only when the plan author runs at plan autonomy
 *   requests presence: awaiting_request is not hidden behind "No runtime"
 *   wave-4   one live-pill precedence (a live run wins → "Working…"), Runs tab uses
 *            the Activity RunLogView, run rows show the task title (no "headless"),
 *            Requests rows drop "Info" / "from" / "to", Pair uses a terminal glyph,
 *            board column word keeps its width, board columns always peek.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { ToastProvider } from "../../components/ui";
import { extensions, type Identity } from "../../extensions";
import { mapSnapshot } from "../../api/client";
import { SnapshotProvider, _setActingIdentity } from "../../state/SnapshotProvider";
import type { Agent } from "../../types";
import { AgentsPage } from "./AgentsPage";
import { Conversation } from "./Conversation";
import { canGrant, cardLiveState, errDetail, grantDenied } from "./agentModel";
import { agentPresence } from "./presence";

const HERE = resolve(__dirname);
const css = (f: string) => readFileSync(resolve(HERE, f), "utf8");
const fresh = () => new Date().toISOString();
const ago = (m: number) => new Date(Date.now() - m * 60_000).toISOString();

const PLAN_MSG = (who: string) => ({ body: "My plan: do the thing", author_alias: who, at: ago(30) });

const SNAP = () => ({
  container: { id: "c1", name: "Orcha", status: "active", autonomy_level: "plan", last_wake_scan_at: fresh(), runtime_served: true },
  agents: [
    { id: "h1", alias: "kedar", kind: "human", role: "Founder", status: "idle", member_role: "owner" },
    { id: "a1", alias: "forge", kind: "ai", role: "Builder", status: "idle", model: "claude-opus-5", wake_enabled: true, auto_wake_interval_secs: null, prompt_preview: "You are Forge.", effective_autonomy: "plan" },
    { id: "a2", alias: "infra", kind: "ai", role: "Infra", status: "idle", model: "claude-opus-5", effective_autonomy: "full", autonomy_override: "full" },
    { id: "a3", alias: "scout", kind: "ai", role: "Research", status: "idle", model: "claude-opus-5", embodiment: "live" },
  ],
  tasks: [
    { id: "11111111-aaaa-4bbb-8ccc-000000000001", title: "Plan-gated task", status: "in_progress", priority: 50, assignees: ["forge"], created_at: ago(60), plan_message: PLAN_MSG("forge") },
    { id: "22222222-aaaa-4bbb-8ccc-000000000002", title: "Full-autonomy progress", status: "in_progress", priority: 50, assignees: ["infra"], created_at: ago(60), plan_message: PLAN_MSG("infra") },
    { id: "33333333-aaaa-4bbb-8ccc-000000000003", title: "Tune the wake scheduler", status: "in_progress", priority: 50, assignees: ["forge"], created_at: ago(90) },
  ],
  requests: [
    { id: "r-in-1", type: "info", status: "open", priority: 10, requester_id: "a2", target_id: "a1", created_at: ago(50), payload: "Old high-priority question" },
    { id: "r-in-2", type: "task", status: "open", priority: 200, requester_id: "a3", target_id: "a1", created_at: ago(5), payload: "New low-priority task ask" },
    { id: "r-out-1", type: "info", status: "open", priority: 10, requester_id: "a1", target_id: "a2", created_at: ago(40), payload: "Outgoing one" },
    { id: "r-out-2", type: "info", status: "open", priority: 90, requester_id: "a1", target_id: "a3", created_at: ago(4), payload: "Outgoing two" },
  ],
});

interface Call { url: string; init?: RequestInit }
let calls: Call[] = [];
let RUNS: unknown[] = [];
const jsonRes = (d: unknown, status = 200) => ({ ok: status < 400, status, json: async () => d }) as Response;
function stubFetch(snapshot: unknown = SNAP()) {
  calls = [];
  global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    if (url === "/api/containers") return jsonRes([{ id: "c1", status: "active" }]);
    if (url.startsWith("/api/containers/c1")) return jsonRes(snapshot);
    if (url === "/api/models") return jsonRes({ models: [] });
    if (url.includes("/digest")) return jsonRes({ digest: null });
    if (url.endsWith("/runs")) return jsonRes({ runs: RUNS });
    if (url.includes("/conversation")) return jsonRes({ conversation: { id: "cv1", status: "active" }, turns: [{ seq: 1, role: "human", content: "hi", author_agent_id: "h1" }] });
    return jsonRes({});
  }) as unknown as typeof fetch;
}
function mount(path: string, el = <AgentsPage />) {
  return render(
    <ToastProvider>
      <SnapshotProvider>
        <MemoryRouter initialEntries={[path]}>
          <Routes>
            <Route path="*" element={el} />
          </Routes>
        </MemoryRouter>
      </SnapshotProvider>
    </ToastProvider>,
  );
}
const asIdentity = (id: Partial<Identity>) => {
  extensions.identity = async () => ({ agent_id: "h1", alias: "kedar", ...id }) as Identity;
};

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  RUNS = [];
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  delete extensions.identity;
  _setActingIdentity(null);
});

describe("access model on the agent workspace (perm-13, EX-18, perm-14, perm-10)", () => {
  it("member WITHOUT manage_agents / manage_autonomy: provider, model, effort and auto-wake are locked with the grant reason; New agent is disabled", async () => {
    asIdentity({ member_role: "member", grants: [] });
    stubFetch();
    const { container } = mount("/agents?agent=forge&tab=config");
    await waitFor(() => expect(container.querySelector("#awakeSeg")).toBeTruthy());
    await waitFor(() => expect(Array.from(container.querySelectorAll<HTMLButtonElement>("#awakeSeg button")).every((b) => b.disabled)).toBe(true));
    Array.from(container.querySelectorAll<HTMLButtonElement>("#modelRuntimeSeg button")).forEach((b) => expect(b.disabled).toBe(true));
    expect(container.querySelector("#awakeSeg button")!.getAttribute("title")).toContain("manage_autonomy");
    expect(container.querySelector("#effortSeg button")!.getAttribute("title")).toContain("manage_agents");
    expect(container.querySelector("#agCtrlLock")!.textContent).toContain("Read-only");
    // New agent: visible, aria-disabled, the reason on hover — never a link to a form bound to 403
    const na = await screen.findByRole("button", { name: /New agent/ });
    expect(na.getAttribute("aria-disabled")).toBe("true");
    expect(na.getAttribute("title")).toContain("manage_agents");
    expect(document.querySelector('a[href="/onboarding?new=1"]')).toBeNull();
    // clicking a locked auto-wake chip never PATCHes
    fireEvent.click(container.querySelector("#awakeSeg button:not(.on)")!);
    await new Promise((r) => setTimeout(r, 20));
    expect(calls.some((c) => c.url.includes("/auto-wake"))).toBe(false);
  });

  it("member WITH manage_agents only: model controls unlock, auto-wake stays locked (it is an autonomy write)", async () => {
    asIdentity({ member_role: "member", grants: ["manage_agents"] });
    stubFetch();
    const { container } = mount("/agents?agent=forge&tab=config");
    await waitFor(() => expect(Array.from(container.querySelectorAll<HTMLButtonElement>("#modelRuntimeSeg button")).some((b) => !b.disabled)).toBe(true));
    Array.from(container.querySelectorAll<HTMLButtonElement>("#awakeSeg button")).forEach((b) => expect(b.disabled).toBe(true));
    expect(container.querySelector("#agCtrlLock")!.textContent).toContain("Partly read-only");
    await waitFor(() => expect(document.querySelector('a[href="/onboarding?new=1"]')).toBeTruthy());
  });

  it("member WITH manage_autonomy: auto-wake unlocks and PATCHes", async () => {
    asIdentity({ member_role: "member", grants: ["manage_autonomy"] });
    stubFetch();
    const { container } = mount("/agents?agent=forge&tab=config");
    await waitFor(() => expect(Array.from(container.querySelectorAll<HTMLButtonElement>("#awakeSeg button")).every((b) => !b.disabled)).toBe(true));
    fireEvent.click(Array.from(container.querySelectorAll<HTMLButtonElement>("#awakeSeg button")).find((b) => b.textContent === "15m")!);
    await waitFor(() => expect(calls.some((c) => c.url === "/api/agents/a1/auto-wake" && c.init?.method === "PATCH")).toBe(true));
  });

  it("viewer: the lock names the viewer role (never 'pick an acting human')", async () => {
    asIdentity({ member_role: "viewer" });
    stubFetch();
    const { container } = mount("/agents?agent=forge&tab=config");
    await waitFor(() => expect(container.querySelector("#agCtrlLock")?.getAttribute("title")).toContain("viewer"));
    expect(container.querySelector("#agCtrlLock")!.getAttribute("title")).not.toMatch(/pick an acting human/i);
    expect(container.querySelector("#effortSeg button")!.getAttribute("title")).toContain("viewer");
  });

  it("trust off (self-host, no identity): the acting human keeps every control (server lane is permissive)", async () => {
    stubFetch();
    const { container } = mount("/agents?agent=forge&tab=config");
    await waitFor(() => expect(Array.from(container.querySelectorAll<HTMLButtonElement>("#awakeSeg button")).every((b) => !b.disabled)).toBe(true));
    expect(container.querySelector("#agCtrlLock")!.textContent).toContain("Human-only");
  });

  it("grant helpers mirror identity_routes.has_grant; errDetail reads the server's reason", () => {
    const s = mapSnapshot(SNAP());
    _setActingIdentity({ agent_id: "h1", member_role: "member", grants: ["manage_agents"] });
    expect(canGrant(s, { agent_id: "h1", member_role: "member", grants: ["manage_agents"] }, "manage_agents")).toBe(true);
    expect(canGrant(s, { agent_id: "h1", member_role: "member", grants: ["manage_agents"] }, "manage_autonomy")).toBe(false);
    expect(grantDenied(s, { agent_id: "h1", member_role: "member", grants: [] }, "manage_autonomy", "x")).toContain("manage_autonomy");
    _setActingIdentity({ agent_id: "h1", member_role: "owner" });
    expect(canGrant(s, { agent_id: "h1", member_role: "owner" }, "manage_autonomy")).toBe(true);
    const e = Object.assign(new Error("/api/agents/a1/auto-wake → 403: this action requires the owner role or the 'manage_autonomy' permission"), { status: 403 });
    expect(errDetail(e)).toBe("this action requires the owner role or the 'manage_autonomy' permission");
  });
});

describe("Requests tab (AA-048 + wave-4 row meta)", () => {
  it("Incoming and Outgoing each have their own sort control and sort independently", async () => {
    // incoming by priority asc (P10 first), outgoing by newest (default time desc)
    localStorage.setItem("orcha:sort:agent-req-in", JSON.stringify({ key: "priority", dir: "asc" }));
    stubFetch();
    const { container } = mount("/agents?agent=forge&tab=requests");
    await waitFor(() => expect(container.querySelector('[data-group="in"] [data-sort="agent-req-in"]')).toBeTruthy());
    expect(container.querySelector('[data-group="out"] [data-sort="agent-req-out"]')).toBeTruthy();
    expect(container.querySelector('[data-sort="agent-req"]')).toBeNull(); // the merged control is gone
    const order = (g: string) => Array.from(container.querySelectorAll<HTMLElement>(`[data-group="${g}"] .rqrow`)).map((r) => r.getAttribute("href"));
    expect(order("in")).toEqual(["/requests?req=r-in-1", "/requests?req=r-in-2"]); // priority asc
    expect(order("out")).toEqual(["/requests?req=r-out-2", "/requests?req=r-out-1"]); // newest first (its own default)
  });

  it("rows drop the 'Info' word and the visible from/to; a task request keeps a subtle Task chip", async () => {
    stubFetch();
    const { container } = mount("/agents?agent=forge&tab=requests");
    await waitFor(() => expect(container.querySelectorAll(".rqrow").length).toBe(4));
    const rows = Array.from(container.querySelectorAll<HTMLElement>(".rqrow"));
    rows.forEach((r) => expect(r.querySelector(".rq-meta")!.textContent).not.toMatch(/\binfo\b/i));
    const taskRow = rows.find((r) => r.textContent!.includes("New low-priority task ask"))!;
    expect(taskRow.querySelector(".rq-kind")!.textContent).toBe("Task");
    // from/to only for screen readers + tooltip
    rows.forEach((r) => {
      const who = r.querySelector(".rq-who")!;
      expect(who.getAttribute("title")).toMatch(/^(From|To) /);
      expect(who.querySelector(".v2-t-meta")).toBeNull();
    });
  });
});

describe("Plan waiting respects the plan author's autonomy (home EXTRA)", () => {
  it("agent Tasks tab: a plan from a full-autonomy agent is not 'Plan waiting' / Needs you", async () => {
    stubFetch();
    const { container } = mount("/agents?agent=infra&tab=tasks");
    await waitFor(() => expect(container.querySelector(".ag-trow")).toBeTruthy());
    const detail = container.querySelector(".agents-detail")!;
    expect(detail.textContent).not.toContain("Plan waiting");
    expect(detail.querySelector('[data-group="needs"]')).toBeNull();
    expect(detail.textContent).not.toContain("Plan awaiting your approval");
  });
  it("…while a plan-autonomy agent's plan still is", async () => {
    stubFetch();
    const { container } = mount("/agents?agent=forge&tab=tasks");
    await waitFor(() => expect(container.querySelector('[data-group="needs"]')).toBeTruthy());
    expect(container.textContent).toContain("Plan waiting");
    expect(container.textContent).toContain("Plan awaiting your approval");
  });
});

describe("one live-pill precedence (wave-4) + presence", () => {
  it("a run live on the task wins over needs_verification / plan → Working… (same as the Tasks list)", () => {
    const raw = SNAP();
    raw.tasks[2] = { ...raw.tasks[2], status: "needs_verification", runs: { count: 1, latest: { run_id: "r1", status: "running" } } } as never;
    const s = mapSnapshot(raw);
    expect(cardLiveState(s, s.tasks.find((t) => t.title === "Tune the wake scheduler")!)).toBe("working");
    // no live run: needs review
    const raw2 = SNAP();
    raw2.tasks[2] = { ...raw2.tasks[2], status: "needs_verification" } as never;
    const s2 = mapSnapshot(raw2);
    expect(cardLiveState(s2, s2.tasks.find((t) => t.title === "Tune the wake scheduler")!)).toBe("needs_review");
    // a full-autonomy author's plan is not "Waiting"
    expect(cardLiveState(s2, s2.tasks.find((t) => t.title === "Full-autonomy progress")!)).not.toBe("waiting");
    expect(cardLiveState(s2, s2.tasks.find((t) => t.title === "Plan-gated task")!)).toBe("waiting");
  });
  it("awaiting_request reads Waiting even when the wake scan is stale", () => {
    const s = mapSnapshot({ ...SNAP(), container: { id: "c1", status: "active", runtime_served: false } });
    const a = { ...s.agents[1], status: "awaiting_request" } as Agent;
    expect(agentPresence(a, { snap: s }).label).toBe("Waiting");
  });
});

describe("Runs tab (wave-4)", () => {
  it("renders the shared RunLogView, the task title as link text, and no 'headless' word", async () => {
    RUNS = [
      { run_id: "r-live", status: "running", started_at: ago(3), agent_id: "a1", wake_kind: "headless", task_id: "33333333-aaaa-4bbb-8ccc-000000000003", output: "" },
      { run_id: "r-done", status: "completed", exit_code: 0, started_at: ago(70), ended_at: ago(60), agent_id: "a1", wake_kind: "headless", output: '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Bash","input":{"command":"ls"}}]}}' },
    ];
    stubFetch();
    const { container } = mount("/agents?agent=forge&tab=runs");
    await waitFor(() => expect(container.querySelectorAll(".runs-feed .run").length).toBe(2));
    const [live, done] = Array.from(container.querySelectorAll<HTMLElement>(".runs-feed .run"));
    expect(live.querySelector(".run-task")!.textContent).toContain("Tune the wake scheduler");
    expect(live.querySelector(".run-h")!.textContent).not.toContain("headless");
    expect(live.querySelector(".run-h")!.getAttribute("title")).toContain("headless");
    expect(live.querySelector(".act-log")).toBeTruthy();
    fireEvent.click(done.querySelector(".run-toggle")!);
    await waitFor(() => expect(done.querySelector(".act-ln-k")).toBeTruthy());
    // sentence-case kinds from the shared renderer — never the lowercase mono "tool"
    expect(Array.from(done.querySelectorAll(".act-ln-k")).map((k) => k.textContent)).toContain("Tool");
    expect(done.querySelector(".ln .ty")).toBeNull();
  });
});

describe("Conversation (AA-089, perm-26, lock honesty, glyph)", () => {
  const SCOUT = () => SNAP().agents.find((a) => a.alias === "scout") as unknown as Agent;

  it("agent in a live terminal: Pair stays clickable and says who holds the session; no thinking dots", async () => {
    stubFetch();
    const { container } = mount("/agents", <Conversation agent={SCOUT()} />);
    await waitFor(() => expect(container.querySelector("#convLock:not([hidden])")).toBeTruthy());
    const pair = container.querySelector<HTMLButtonElement>("#convPair")!;
    expect(pair.disabled).toBe(false);
    fireEvent.click(pair);
    await screen.findByText(/scout already holds a live session/);
    // the pending human turn gets an honest paused note, never "is thinking" dots
    await waitFor(() => expect(container.textContent).toContain("in a live terminal — the conversation is paused"));
    expect(container.querySelector(".conv-thinking")).toBeNull();
    // Pair uses a terminal glyph, not the play triangle beside Send
    expect(pair.querySelector("path")!.getAttribute("d")).not.toBe("M6 4.5 15 10l-9 5.5z");
  });

  it("the lock CSS dims only the input side — never pointer-events:none on the whole composer", () => {
    const c = css("agents.css");
    expect(c).not.toMatch(/\.conv-lock:not\(\[hidden\]\) \+ \.conv-composer\s*\{[^}]*pointer-events:\s*none/);
    expect(c).toMatch(/\.conv-lock:not\(\[hidden\]\) \+ \.conv-composer :is\(\.conv-pair, \.conv-max\) \{ opacity: 1; pointer-events: auto; \}/);
  });

  it("viewer: the composer is disabled and says why (no send, no 'pick an acting human')", async () => {
    asIdentity({ member_role: "viewer" });
    stubFetch();
    const forge = SNAP().agents.find((a) => a.alias === "forge") as unknown as Agent;
    const { container } = mount("/agents", <Conversation agent={forge} />);
    await waitFor(() => expect((container.querySelector("#convInput") as HTMLTextAreaElement).disabled).toBe(true));
    const ta = container.querySelector("#convInput") as HTMLTextAreaElement;
    expect(ta.placeholder).toContain("viewer");
    expect(ta.placeholder).not.toMatch(/pick an acting human/i);
    expect((container.querySelector("#convSend") as HTMLButtonElement).disabled).toBe(true);
  });

  it("no toast or copy still points to the old top-right header", () => {
    expect(readFileSync(resolve(HERE, "Conversation.tsx"), "utf8")).not.toContain("(top-right)");
  });
});

describe("board CSS (wave-4)", () => {
  const c = css("agentsBoard.css");
  it("the presence word keeps its width; the long name ellipsizes first", () => {
    expect(c).toMatch(/\.ab-col \.v2-bcol-status \{ flex: 0 0 auto;/);
    expect(c).toMatch(/\.ab-col-word \{[^}]*min-width: 3\.5em/);
  });
  it("columns are sized from the board width so a partial column always peeks", () => {
    expect(c).toContain("container-type: inline-size");
    expect(c).toMatch(/@container \(min-width: 1212px\) \{ \.ab-wrap \.ab-board \{ --ab-colw: clamp\(272px, calc\(\(100cqw - 88px - 48px\) \/ 4\), 400px\); \} \}/);
    expect(c).toContain("var(--ab-colw, minmax(272px, 400px))");
  });
});

describe("maximized conversation (AA-087 follow-up)", () => {
  it("the thread wrapper grows so the composer sits at the bottom of the overlay", () => {
    expect(css("agents.css")).toContain(".conv.maximized .conv-listwrap { flex: 1 1 auto; min-height: 0; display: flex; flex-direction: column; }");
  });
});
