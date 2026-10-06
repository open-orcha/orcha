/**
 * Manager review handoff (mig 057) — portal side.
 *  - pure helpers: route line, AI pre-review line, Needs-you brief, the org walk
 *  - verification gate: "Reviewer: hussein · via probe’s manager" + "atlas (manager)
 *    recommends approval: …"; a sent-back task offers "Accept anyway" (verify approve)
 *  - Needs you: the manager-routed review is the reviewer's own item with the brief
 *  - Org chart: the manager's card counts reviews waiting; the panel lists them
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mapSnapshot } from "../../api/client";
import { ToastProvider } from "../../components/ui";
import { SnapshotProvider } from "../../state/SnapshotProvider";
import { _resetProjectsForTests } from "../../state/projects";
import type { Agent, Task } from "../../types";
import {
  managerReviewLine, predictRoute, reviewBrief, reviewLoad, reviewRouteLine, reviewVia,
} from "../../lib/reviewRoute";
import { NeedsPage, _resetNeedsHistory } from "../needs/NeedsPage";
import { buildOrgForest, type OrgAuthority } from "../org/orgModel";
import { OrgCanvas } from "../org/OrgPage";
import { GateSurface } from "./TaskDetail";

const AGENTS = [
  { id: "h1", alias: "hussein", kind: "human", status: "idle", member_role: "owner", reports_to: null },
  { id: "h2", alias: "maya", kind: "human", status: "idle", member_role: "member", reports_to: null },
  { id: "h3", alias: "vera", kind: "human", status: "idle", member_role: "viewer", reports_to: null },
  { id: "a1", alias: "atlas", kind: "ai", role: "Lead", status: "idle", reports_to: "h1" },
  { id: "a2", alias: "probe", kind: "ai", role: "QA", status: "idle", reports_to: "a1" },
  { id: "a3", alias: "forge", kind: "ai", role: "Backend", status: "idle", reports_to: "h3" },
];
const base = { created_by_agent_id: "h1", definition_of_done: "It works", message_summary: { count: 1, last: null }, priority: 50, created_at: "2026-09-01T00:00:00Z" };
const routed = {
  ...base, id: "t1", title: "Login form", status: "needs_verification", assignees: ["probe"], result: "Added validation",
  reviewer_agent_id: "h1", reviewer: { agent_id: "h1", alias: "hussein" },
  review_routing: { routed_via: "reports_to", reviewer_alias: "hussein", assignee_alias: "probe", manager_depth: 2, pre_review_by: "atlas" },
  manager_review: { status: "approved", manager_agent_id: "a1", manager_alias: "atlas", recommendation: "approve", reasons: "covers the DoD", decided_at: "2026-09-01T00:00:00Z" },
};
const other = {
  ...base, id: "t2", title: "Docs", status: "needs_verification", assignees: ["forge"], result: "Wrote docs",
  reviewer_agent_id: "h2", reviewer: { agent_id: "h2", alias: "maya" }, review_routing: { routed_via: "manual", set_by_alias: "hussein" }, manager_review: null,
};
const sentBack = {
  ...base, id: "t3", title: "API", status: "in_progress", assignees: ["probe"], result: "v1",
  reviewer_agent_id: "h1", reviewer: { agent_id: "h1", alias: "hussein" },
  review_routing: { routed_via: "reports_to", reviewer_alias: "hussein", assignee_alias: "probe", manager_depth: 2 },
  manager_review: { status: "sent_back", manager_agent_id: "a1", manager_alias: "atlas", recommendation: "send_back", reasons: "no 404 test" },
};
const RAW = () => ({
  container: { id: "c1", name: "Orcha", status: "active", autonomy_level: "plan", review_route: "manager_chain", ai_manager_prereview: true },
  agents: structuredClone(AGENTS), tasks: structuredClone([routed, other, sentBack]), requests: [],
});

afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); localStorage.clear(); });

describe("reviewRoute helpers", () => {
  it("names the route and the AI recommendation", () => {
    const s = mapSnapshot(RAW() as never);
    const t1 = s.tasks.find((t) => t.id === "t1")!;
    expect(reviewVia(t1)).toBe("via probe’s manager chain");
    expect(reviewRouteLine(t1)).toBe("Reviewer: hussein · via probe’s manager chain");
    expect(reviewRouteLine({ ...t1, review_routing: { ...t1.review_routing!, manager_depth: 1 } })).toBe("Reviewer: hussein · via probe’s manager");
    expect(managerReviewLine(t1.manager_review)).toEqual({ text: "atlas (manager) recommends approval: covers the DoD", tone: "ok" });
    expect(managerReviewLine({ status: "pending", manager_alias: "atlas" })?.tone).toBe("pending");
    expect(managerReviewLine({ status: "sent_back", manager_alias: "atlas", reasons: "x" })?.text).toBe("atlas (manager) sent it back: x");
    expect(managerReviewLine(null)).toBeNull();
    expect(reviewBrief(t1)).toBe("atlas recommends approval");
    expect(reviewBrief({ ...t1, manager_review: null })).toBe("via probe’s manager chain");
    const t2 = s.tasks.find((t) => t.id === "t2")!;
    expect(reviewRouteLine(t2)).toBe("Reviewer: maya · set by hussein");
    expect(reviewBrief(t2)).toBe("");
    expect(reviewRouteLine({ ...t2, review_routing: { routed_via: "fallback", assignee_alias: "forge" }, reviewer: null })).toBe(
      "Reviewer: anyone · no manager in forge’s chain can verify — anyone may",
    );
    expect(reviewRouteLine({ ...t2, review_routing: null } as Task)).toBeNull();
  });

  it("walks the org like the backend: AI pre-reviewer, nearest human who can verify, viewers skipped", () => {
    const s = mapSnapshot(RAW() as never);
    const r = predictRoute(s, "a2");
    expect(r.human?.alias).toBe("hussein");
    expect(r.preReviewer?.alias).toBe("atlas");
    expect(predictRoute(s, "a3").human).toBeNull(); // forge → vera (viewer) → nobody
    const off = { ...s, container: { ...s.container!, ai_manager_prereview: false } };
    expect(predictRoute(off, "a2").preReviewer).toBeNull();
    const owner = { ...s, container: { ...s.container!, review_route: "owner" as const } };
    expect(predictRoute(owner, "a2").human).toBeNull();
    const h = reviewLoad(s, "h1");
    expect(h.covers.map((a) => a.alias).sort()).toEqual(["atlas", "probe"]);
    expect(h.pending.map((t) => t.id)).toEqual(["t1"]); // the sent-back task is not waiting
    expect(reviewLoad(s, "a1").covers.map((a) => a.alias)).toEqual(["probe"]);
    expect(reviewLoad(s, "h3").covers).toEqual([]); // a viewer never reviews
  });
});

describe("verification gate", () => {
  beforeEach(() => { _resetProjectsForTests(); });

  function stub(calls: { url: string; method: string; body: unknown }[]) {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method || "GET";
      calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      const res = (d: unknown, status = 200) => ({ ok: status < 400, status, json: async () => d }) as Response;
      if (url === "/api/containers") return res([{ id: "c1", name: "Orcha", status: "active" }]);
      if (url.startsWith("/api/containers/c1")) return res(RAW());
      if (url.startsWith("/api/me")) return res({ identity: null, trusted: false });
      if (/\/runs$/.test(url)) return res([]);
      return res({ ok: true });
    }));
  }

  it("shows the manager route and the AI recommendation (advisory — Accept stays the human's)", async () => {
    stub([]);
    const t = mapSnapshot(RAW() as never).tasks.find((x) => x.id === "t1")!;
    render(<ToastProvider><SnapshotProvider><MemoryRouter><GateSurface t={t} acted={false} onActed={() => {}} /></MemoryRouter></SnapshotProvider></ToastProvider>);
    const gate = await waitFor(() => {
      const el = document.querySelector("#gate-t1") as HTMLElement | null;
      expect(el).toBeTruthy();
      return el!;
    });
    const row = gate.querySelector('[data-review-route="reports_to"]') as HTMLElement;
    expect(row.textContent).toContain("Reviewer: hussein · via probe’s manager chain");
    expect(row.querySelector('[data-manager-review="approved"]')!.textContent).toContain("atlas (manager) recommends approval: covers the DoD");
    expect(within(gate).getByRole("button", { name: "Accept" })).toBeTruthy();
  });

  it("a task the AI manager sent back can still be accepted by a person", async () => {
    const calls: { url: string; method: string; body: unknown }[] = [];
    stub(calls);
    const t = mapSnapshot(RAW() as never).tasks.find((x) => x.id === "t3")!;
    const onActed = vi.fn();
    render(<ToastProvider><SnapshotProvider><MemoryRouter><GateSurface t={t} acted={false} onActed={onActed} /></MemoryRouter></SnapshotProvider></ToastProvider>);
    const note = await screen.findByRole("note");
    expect(note.textContent).toContain("atlas (manager) sent this back");
    expect(note.textContent).toContain("no 404 test");
    const btn = within(note).getByRole("button", { name: "Accept anyway" });
    await waitFor(() => expect((btn as HTMLButtonElement).disabled).toBe(false));
    await act(async () => { fireEvent.click(btn); });
    const v = calls.find((c) => c.url === "/api/tasks/t3/verify");
    expect(v?.method).toBe("POST");
    expect(v?.body).toEqual({ approve: true, actor_agent_id: "h1" });
    expect(onActed).toHaveBeenCalledWith("t3");
  });
});

describe("Needs you", () => {
  beforeEach(() => {
    _resetNeedsHistory();
    _resetProjectsForTests();
    window.scrollTo = vi.fn();
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      const res = (d: unknown) => ({ ok: true, status: 200, json: async () => d }) as Response;
      if (url === "/api/containers") return res([{ id: "c1", name: "Orcha", status: "active" }]);
      if (url.startsWith("/api/containers/c1")) return res(RAW());
      if (/\/runs$/.test(url)) return res([]);
      return res({ ok: true });
    }));
  });

  it("a manager-routed review is the reviewer's own item, with the AI recommendation", async () => {
    render(<ToastProvider><SnapshotProvider pollMs={60000}><MemoryRouter initialEntries={["/needs"]}><NeedsPage /></MemoryRouter></SnapshotProvider></ToastProvider>);
    const mine = await waitFor(() => {
      const el = document.querySelector('[data-id="verify:t1"]') as HTMLElement | null;
      expect(el).toBeTruthy();
      return el!;
    });
    expect(mine.textContent).toContain("atlas recommends approval");
    // hussein is an owner: maya's review is listed normally too, but t1 is not "assigned to" anyone else
    expect(mine.textContent).not.toContain("assigned to");
    // the sent-back task is not a verification item
    expect(document.querySelector('[data-id="verify:t3"]')).toBeNull();
  });
});

describe("Org chart", () => {
  it("the manager's card counts reviews waiting and the panel lists them", async () => {
    const s = mapSnapshot(RAW() as never);
    const KEDAR = { id: "h1", alias: "hussein", kind: "human" } as Agent;
    const CAN: OrgAuthority = { can: true, human: KEDAR, pending: false, reason: null };
    render(
      <ToastProvider><MemoryRouter initialEntries={["/org"]}>
        <OrgCanvas snap={s} forest={buildOrgForest(s)} auth={CAN} onSet={() => {}} gate={{ approve: null, decline: null }} onDecide={async () => {}} />
      </MemoryRouter></ToastProvider>,
    );
    const card = document.querySelector('[data-org-card][data-agent="hussein"]') as HTMLElement;
    const fact = card.querySelector(".org-reviews") as HTMLElement;
    expect(fact.textContent).toBe("1 to review");
    expect(fact.getAttribute("data-reviews-for")).toBe("2");
    expect(fact.getAttribute("title")).toBe("Reviews finished work for 2 agents · 1 waiting now");
    const atlas = document.querySelector('[data-org-card][data-agent="atlas"] .org-reviews') as HTMLElement;
    expect(atlas.textContent).toBe("1"); // pre-reviews probe, nothing waiting (title explains)
    await act(async () => { fireEvent.click(card); });
    const panel = await screen.findByTestId("org-p-reviews");
    expect(panel.textContent).toContain("Verifies finished work from");
    const link = panel.querySelector('[data-review-task="t1"]') as HTMLAnchorElement;
    expect(link.getAttribute("href")).toBe("/tasks?task=t1");
    expect(link.textContent).toContain("atlas recommends approval");
  });
});
