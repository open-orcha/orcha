/**
 * Parity round 2 fixes (/requests + RequestDetail, also used by Needs you):
 *  - e2e-permissions-29: "Create agent…" on a roster suggestion is owner-or-manage_agents
 *    (Reassign / Refuse stay member-level);
 *  - a task request shows its proposed task (requests.detail title + definition of done);
 *  - an answer given BEFORE an escalation is credited to the original target, and the flowline
 *    names that target (never "you → you");
 *  - closing someone else's request: "Close request" stays disabled until a reason is typed;
 *  - the converted-to-task activity line names its actor (only the requester may convert);
 *  - the list head's four filter pills fit beside the three circular tools (CSS).
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "../../components/ui";
import { extensions, type Identity } from "../../extensions";
import { SnapshotProvider, _setActingAuth, _setActingIdentity } from "../../state/SnapshotProvider";
import { RequestsPage, _resetLocalEscalations, _resetPendingAnswers, closeNeedsReason, proposedTaskOf, responderAlias } from "./RequestsPage";
import { listCss } from "./requestsCss";
import type { Agent, OrchaRequest } from "../../types";

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
    { id: "rs", type: "info", status: "open", priority: 2, requester_id: "a1", target_id: "h1", created_at: iso(-60), payload: "Add a security auditor?",
      detail: { proposed_alias: "sentinel", proposed_role: "Security reviewer", rationale: "Auth changes lack review." } },
    { id: "rt", type: "task", status: "open", priority: 100, requester_id: "a1", target_id: "h1", created_at: iso(-50), payload: "Please take this",
      detail: { title: "Rotate Stripe test keys", definition_of_done: "New keys in vault; old revoked" } },
    // answered by quill, THEN escalated by kedar (the requester) → now routed to kedar
    { id: "re", type: "info", status: "open", priority: 100, requester_id: "h1", target_id: "h1", created_at: iso(-40), responded_at: iso(-30),
      escalated: true, escalated_at: iso(-20), escalated_from_alias: "quill", payload: "ETA for the fix?", response: "Today, PR is up." },
    { id: "rc", type: "info", status: "open", priority: 100, requester_id: "a2", target_id: "a1", created_at: iso(-35), payload: "Which queue?" },
    { id: "rv", type: "task", status: "converted_to_task", priority: 100, requester_id: "a1", target_id: "a2", created_at: iso(-25), responded_at: iso(-10),
      payload: "Write the retry suite", task_link: { task_id: "t1aaaaaa-0000-4000-8000-000000000001", title: "Wire the export", status: "in_progress" } },
  ] as Record<string, unknown>[],
});

let RAW: ReturnType<typeof baseRaw>;
let posts: { url: string; body: unknown }[] = [];

beforeEach(() => {
  RAW = baseRaw();
  posts = [];
  window.scrollTo = vi.fn();
  window.matchMedia = ((q: string) => ({
    matches: false, media: q, onchange: null,
    addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (init?.method === "POST") {
      posts.push({ url, body: init.body ? JSON.parse(String(init.body)) : null });
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
const detail = () => document.querySelector("#detailMain") as HTMLElement | null;

describe("e2e-permissions-29 — Create agent needs owner or manage_agents", () => {
  it("a member without the grant sees Create agent disabled with the reason; Reassign stays enabled", async () => {
    extensions.identity = async () => ({ agent_id: "h1", alias: "kedar", member_role: "member", grants: ["manage_keys"] }) as Identity;
    mount("/requests?req=rs");
    const create = await screen.findByRole("button", { name: "Create agent…" });
    await waitFor(() => expect(create).toBeDisabled());
    expect(create.getAttribute("title")).toBe("Requires the owner role or the manage_agents permission");
    expect(screen.getByRole("button", { name: "Reassign to existing…" })).not.toBeDisabled();
    fireEvent.click(create);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(posts.some((p) => p.url.includes("/agent-suggestions/"))).toBe(false);
  });

  it("a member WITH manage_agents (and an owner) can open the create dialog", async () => {
    extensions.identity = async () => ({ agent_id: "h1", alias: "kedar", member_role: "member", grants: ["manage_agents"] }) as Identity;
    mount("/requests?req=rs");
    const create = await screen.findByRole("button", { name: "Create agent…" });
    await waitFor(() => expect(create).not.toBeDisabled());
    fireEvent.click(create);
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
  });
});

describe("task request — proposed task", () => {
  it("pure: only a task request with a detail title has one", () => {
    const base = { id: "x", type: "task", detail: { title: " T ", definition_of_done: "D" } } as unknown as OrchaRequest;
    expect(proposedTaskOf(base)).toEqual({ title: "T", dod: "D" });
    expect(proposedTaskOf({ ...base, type: "info" })).toBeNull();
    expect(proposedTaskOf({ ...base, detail: { proposed_alias: "a" } })).toBeNull();
    expect(proposedTaskOf({ ...base, detail: { title: "T" } })).toEqual({ title: "T", dod: null });
  });

  it("renders the title and 'Done when' in the detail", async () => {
    mount("/requests?req=rt");
    const sec = await screen.findByRole("region", { name: "Proposed task" });
    expect(sec.textContent).toMatch(/Rotate Stripe test keys/);
    expect(sec.textContent).toMatch(/Done when\s*New keys in vault; old revoked/);
  });
});

describe("answered, then escalated", () => {
  it("pure: the answer belongs to the original target when it predates the escalation", () => {
    const r = { id: "q", status: "open", to: "human", escalated: true, escalated_from: "quill", responded_at: iso(-30), escalated_at: iso(-20) } as unknown as OrchaRequest;
    expect(responderAlias(r)).toBe("quill");
    expect(responderAlias({ ...r, responded_at: iso(-5) })).toBe("human"); // the human answered after
    expect(responderAlias({ ...r, escalated: false, escalated_at: null, escalated_from: null })).toBe("human");
  });

  it("credits quill, not 'you', and the flowline reads you → quill · escalated to you", async () => {
    mount("/requests?req=re");
    await waitFor(() => expect(detail()?.querySelector(".rq-flowline")).toBeTruthy());
    const flow = detail()!.querySelector(".rq-flowline")!.textContent!.replace(/\s+/g, " ");
    expect(flow).toMatch(/you.*quill.*escalated to you/);
    const act = within(screen.getByRole("region", { name: "Activity" }));
    const answer = act.getByText("Today, PR is up.").closest(".v2-tl-card, .v2-tl-comment, li, article") as HTMLElement;
    expect(answer?.textContent).toMatch(/quill/);
    expect(answer?.textContent).not.toMatch(/\byou\b.*answered/);
  });
});

describe("close reason gate", () => {
  it("pure: a reason is needed unless you are the requester", () => {
    const h = { id: "h1", alias: "kedar" } as Agent;
    expect(closeNeedsReason({ requester_id: "h1" } as OrchaRequest, h)).toBe(false);
    expect(closeNeedsReason({ requester_id: "a2" } as OrchaRequest, h)).toBe(true);
  });

  it("someone else's request: Close request is disabled until a reason is typed, then posts it", async () => {
    mount("/requests?req=rc");
    fireEvent.click(await screen.findByRole("button", { name: /^Close…$/ }));
    const dlg = await screen.findByRole("dialog");
    const btn = within(dlg).getByRole("button", { name: "Close request" });
    expect(btn).toBeDisabled();
    fireEvent.change(within(dlg).getByLabelText("Reason"), { target: { value: "Superseded" } });
    expect(btn).not.toBeDisabled();
    fireEvent.click(btn);
    await waitFor(() => expect(posts.find((p) => p.url.endsWith("/rc/close"))?.body).toMatchObject({ reason: "Superseded" }));
  });
});

describe("converted activity names the actor", () => {
  it("'forge converted it to a task'", async () => {
    mount("/requests?req=rv");
    const act = await screen.findByRole("region", { name: "Activity" });
    await waitFor(() => expect(act.textContent!.replace(/\s+/g, " ")).toMatch(/forge converted it to a task/));
  });
});

describe("list head fits", () => {
  it("pills are tightened inside the list head", () => {
    expect(listCss).toMatch(/\.rq-listhead \.v2-pills \{ gap: 4px; \}/);
    expect(listCss).toMatch(/\.rq-listhead \.v2-pills-sm \.v2-pill \{ padding: 0 8px; \}/);
  });
});
