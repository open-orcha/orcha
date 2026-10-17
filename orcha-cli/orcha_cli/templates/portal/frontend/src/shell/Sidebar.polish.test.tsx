/**
 * Sidebar polish round 1 (screen-review findings):
 *  - (round 2, N1) the current project row shows the nav's attention count
 *    (one selector: plans included, others' reviews excluded);
 *  - the collapsed-rail count is a dot (number kept in the accessible name);
 *  - the narrow drawer uses the SAME D11 cap (3) as the desktop column (wave-4:
 *    one tree at every width).
 */
import { cleanup, render, within } from "@testing-library/react";
import { HashRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "../components/ui";
import { SnapshotProvider } from "../state/SnapshotProvider";
import { _resetProjectsForTests } from "../state/projects";
import { HomePage } from "../pages/home/HomePage";
import { projectNeedsYou } from "./Sidebar";
import { selectAttention } from "../state/attention";
import type { Snapshot } from "../types";

const now = Date.now();
const iso = (ms: number) => new Date(now - ms).toISOString();

function snapshot() {
  return {
    container: { id: "c1", name: "Website", status: "active", autonomy_level: "plan", wakes_enabled: true },
    agents: [
      { id: "h1", alias: "kedar", kind: "human", status: "idle" },
      { id: "a1", alias: "lead", kind: "ai", status: "working", last_active: iso(5_000), current_task: { task_id: "t1", title: "Plan the thing" }, effective_autonomy: "plan" },
      { id: "a2", alias: "mira", kind: "ai", status: "working", last_active: iso(6_000), current_task: { task_id: "t2", title: "Ship login" } },
      { id: "a3", alias: "nova", kind: "ai", status: "blocked", last_active: iso(9_000) },
      { id: "a4", alias: "zed", kind: "ai", status: "failed", last_active: iso(19_000) },
    ],
    tasks: [
      // a plan awaiting the human: counted by the Needs-you nav, NOT by the row measure
      { id: "t1", title: "Plan the thing", status: "in_progress", assignee: "lead", assignees: ["lead"], plan_decision: null,
        messages: [{ kind: "plan", from: "lead", at: iso(60_000), body: "## Plan\n- a" }] },
      { id: "t2", title: "Ship login", status: "needs_verification", assignees: ["mira"] },
    ],
    requests: [
      { id: "r1", status: "open", to: "human", target_id: null, from: "mira", type: "question", payload: { question: "Q?" } },
      { id: "r2", status: "open", to: "nova", target_id: "a3", from: "mira", type: "question", payload: { question: "agent-to-agent" } },
    ],
    task_total: 2, request_total: 2,
  };
}
const CONTAINERS = [
  { id: "c1", name: "Website", status: "active", needs_you: 2 },
  { id: "c2", name: "API service", status: "active", needs_you: 4 },
];
function stub() {
  const json = (data: unknown) => ({ ok: true, status: 200, json: async () => data }) as unknown as Response;
  global.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === "/api/containers") return json({ containers: CONTAINERS });
    if (url.startsWith("/api/containers/c1")) return json(snapshot());
    return json({});
  }) as unknown as typeof fetch;
}
const mount = () => render(<ToastProvider><SnapshotProvider><HashRouter><HomePage /></HashRouter></SnapshotProvider></ToastProvider>);
const sidebar = () => document.getElementById("sidebar") as HTMLElement;

describe("projectNeedsYou (the nav's attention definition — review N1)", () => {
  it("counts plans + verifications + human-facing / escalated requests, exactly like the Needs-you nav", () => {
    const s = snapshot() as unknown as Snapshot;
    // the SAME selector as the nav / Overview band / bell (the mounted test below checks the plan is in it)
    expect(projectNeedsYou(s, "h1")).toBe(selectAttention(s, "h1").count);
    const esc = { ...s, requests: [...(s.requests ?? []), { id: "r3", status: "escalated", to: "nova", target_id: "a3" }] } as unknown as Snapshot;
    expect(projectNeedsYou(esc, "h1")).toBe((projectNeedsYou(s, "h1") ?? 0) + 1);
  });
  it("is unknown (null) without a snapshot", () => {
    expect(projectNeedsYou(null)).toBeNull();
  });
});

describe("sidebar project rows — one measure", () => {
  beforeEach(() => { localStorage.clear(); _resetProjectsForTests(); document.documentElement.removeAttribute("data-sidebar"); window.location.hash = ""; stub(); });
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  it("the current project row shows exactly the nav's Needs-you count (N1: nav == row)", async () => {
    mount();
    const nav = await within(sidebar()).findByRole("link", { name: /3 decisions waiting on you in Website/ });
    expect(nav.textContent).toContain("3"); // plan + verify + request
    const web = await within(sidebar()).findByRole("link", { name: /^Website, Active, 3 decisions waiting on you, current project$/ });
    expect(web.closest("li")!.querySelector(".v2-sb-attn")!.textContent).toBe("3");
    // other projects: the server's per-project count as of the last list fetch
    const api = await within(sidebar()).findByRole("link", { name: /^API service, Active, 4 decisions waiting on you/ });
    expect(api.closest("li")!.querySelector(".v2-sb-attn")!.textContent).toBe("4");
  });

  it("the narrow drawer nests the same 3 live agents as the desktop column, with '+N more'", async () => {
    const mm = window.matchMedia;
    window.matchMedia = ((q: string) => ({ matches: q.includes("max-width: 900px"), media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false })) as unknown as typeof window.matchMedia;
    try {
      mount();
      const list = await within(sidebar()).findByRole("list", { name: "Live agents in Website", hidden: true });
      expect(list.querySelectorAll(".v2-sb-agent")).toHaveLength(3);
      expect(within(list).getByText("+1 more")).toBeTruthy();
    } finally { window.matchMedia = mm; }
  });
});
