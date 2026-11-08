// @vitest-environment jsdom
import { createElement as h } from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { withScenarios } from "../test-wrap";
import { actionsFor, HealthBoard } from "./health-board";
import { resetHealthStore } from "./health-store";
import type { HealthAudit } from "./types";


const ORCHA = "Embodent 3c96e42c · Build the Questions board (website only, local branch)";
const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const C = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

function auditWith(scenarios: HealthAudit["scenarios"]): HealthAudit {
  return { project_id: "p1", computed_at: new Date().toISOString(), total: 40, counts: {}, scenarios };
}

const flagged = auditWith([
  { id: A, name: ORCHA, status: "validated", target_kind: null, flags: [{ scenario_id: A, kind: "suspicious", reason: "Looks like an agent task.", action: "drafts" }] },
  { id: B, name: "Sign in with e-mail", status: "validated", target_kind: "web", flags: [{ scenario_id: B, kind: "duplicate", reason: 'Same name as "Sign in with email".', action: "merge", detail: { duplicate_of: C } }] },
  { id: C, name: "Search", status: "validated", target_kind: null, flags: [{ scenario_id: C, kind: "env_failing", reason: "Failed the same way.", action: "fix_env", dismissed_at: "2026-10-16T10:00:00Z" }] },
]);

beforeAll(() => {
  HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) {
    this.setAttribute("open", "");
  };
  HTMLDialogElement.prototype.close ??= function (this: HTMLDialogElement) {
    this.removeAttribute("open");
  };
});
beforeEach(() => resetHealthStore());
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function mount(responses: HealthAudit[]) {
  const calls: { url: string; body?: unknown }[] = [];
  let i = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      if (url.endsWith("/scenario-health/actions")) return new Response(JSON.stringify({ ok: true, changed: 1 }));
      const audit = responses[Math.min(i, responses.length - 1)];
      i += 1;
      return new Response(JSON.stringify(audit));
    }),
  );
  const view = render(withScenarios(h(HealthBoard, { scenarios: [{ id: C, name: "Sign in with email", target_kind: "web", status: "validated" }], onScenario: () => {}, onMap: () => {}, onApps: () => {} })));
  return { calls, view };
}

async function settle(ms = 20) {
  await act(async () => {
    await new Promise((r) => setTimeout(r, ms));
  });
}

describe("HealthBoard (#188)", () => {
  it("shows the live checking view, then the board grouped by flag with counts", async () => {
    const { view } = mount([flagged]);
    expect(view.container.querySelector("[data-health-checking]")).not.toBeNull();
    await settle();
    expect(view.container.querySelector("[data-health-summary]")!.textContent).toContain("40 scenarios checked");
    expect(view.container.querySelector("[data-health-summary]")!.textContent).toContain("2 scenarios need a look.");
    const groups = [...view.container.querySelectorAll("[data-health-group]")].map((g) => g.getAttribute("data-health-group"));
    expect(groups).toEqual(["suspicious", "duplicate"]);
    expect(view.container.querySelector('[data-health-count="suspicious"]')!.textContent).toContain("1");
    // The dismissed flag waits in the fold, not in a group.
    expect(view.container.querySelector("[data-health-kept]")!.textContent).toContain("Kept by you (1)");
  });

  it("moves a suspicious scenario to drafts in one click and checks again", async () => {
    const healthy = auditWith([]);
    const { calls, view } = mount([flagged, healthy]);
    await settle();
    const row = view.container.querySelector(`[data-health-row="${A}"]`)!;
    fireEvent.click(row.querySelector('[data-health-action="drafts"]')!);
    await settle(400);
    expect(calls.find((c) => c.url.endsWith("/scenario-health/actions"))!.body).toEqual({ actor_agent_id: "h1", action: "drafts", ids: [A] });
    expect(calls.filter((c) => c.url.endsWith("/scenario-health")).length).toBe(2);
    expect(view.container.querySelector("[data-health-healthy]")).not.toBeNull();
    expect(screen.getByText("All scenarios look healthy")).toBeTruthy();
  });

  it("bulk-selects a group and archives it", async () => {
    const { calls, view } = mount([flagged]);
    await settle();
    fireEvent.click(view.container.querySelector('[data-health-group="suspicious"] input[type="checkbox"]')!);
    const bar = view.container.querySelector("[data-health-bulk]")!;
    expect(bar.textContent).toContain("1 scenario selected");
    fireEvent.click(bar.querySelector('[data-health-bulk-action="archive"]')!);
    await settle();
    expect(calls.find((c) => c.url.endsWith("/scenario-health/actions"))!.body).toEqual({ actor_agent_id: "h1", action: "archive", ids: [A] });
  });

  it("merges a duplicate into the scenario the audit pointed at", async () => {
    const { calls, view } = mount([flagged]);
    await settle();
    fireEvent.click(view.container.querySelector(`[data-health-row="${B}"] [data-health-action="merge"]`)!);
    fireEvent.click(document.querySelector("[data-health-merge-save]")!);
    await settle();
    expect(calls.find((c) => c.url.endsWith("/scenario-health/actions"))!.body).toEqual({ actor_agent_id: "h1", action: "merge", ids: [B], into: C });
  });

  it("renames starting from a plain name for the task", async () => {
    const { calls, view } = mount([flagged]);
    await settle();
    fireEvent.click(view.container.querySelector(`[data-health-row="${A}"] [data-health-action="rename"]`)!);
    const input = document.querySelector("[data-health-rename-input]") as HTMLInputElement;
    expect(input.value).toBe("Questions board");
    fireEvent.click(document.querySelector("[data-health-rename-save]")!);
    await settle();
    expect(calls.find((c) => c.url.endsWith("/scenario-health/actions"))!.body).toEqual({ actor_agent_id: "h1", action: "rename", ids: [A], name: "Questions board" });
  });

  it("says when there are no scenarios at all", async () => {
    const { view } = mount([{ ...auditWith([]), total: 0 }]);
    await settle();
    expect(view.container.querySelector("[data-health-no-scenarios]")).not.toBeNull();
  });
});

describe("actionsFor", () => {
  it("puts the recommended action first and drops Move to drafts for a draft", () => {
    const row = (status: "draft" | "validated") => ({ key: "k", scenario: { id: A, name: ORCHA, status, target_kind: null, flags: [] }, flag: { scenario_id: A, kind: "suspicious" as const, reason: "", action: "drafts" as const } });
    expect(actionsFor(row("validated"))).toEqual(["drafts", "rename", "archive", "dismiss"]);
    expect(actionsFor(row("draft"))).toEqual(["archive", "rename", "dismiss"]);
  });
});
