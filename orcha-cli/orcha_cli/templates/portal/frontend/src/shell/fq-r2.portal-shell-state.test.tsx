/**
 * fullqa r2 (portal-shell-state): PS-30 (a malformed project id is "project
 * not found", never "offline"), VD-40 (the budget chip is glyph-only in the
 * phone header) and VD-06 (touch hit-area overrides win the cascade).
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act, cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SnapshotProvider } from "../state/SnapshotProvider";
import { ProjectBudgetChip } from "./Shell";
import { noSnapReason } from "./Sidebar";

const STYLES = resolve(__dirname, "../../../static/styles");
const css = (f: string) => readFileSync(resolve(STYLES, f), "utf8");

describe("PS-30 unknown / invalid project id", () => {
  const base = { snap: null, cid: "not-a-uuid", connection: "offline", identityTrusted: false, hasIdentity: false };
  it("a 400 (malformed id) or 422 is 'not-found', never 'offline'", () => {
    expect(noSnapReason({ ...base, error: "/api/containers/not-a-uuid → 400: invalid id" })).toBe("not-found");
    expect(noSnapReason({ ...base, error: "/api/containers/not-a-uuid → 422" })).toBe("not-found");
    expect(noSnapReason({ ...base, error: "/api/containers/c1 → 404" })).toBe("not-found");
    expect(noSnapReason({ ...base, error: "/api/containers/c1 → 401" })).toBe("not-member");
    // a gateway error / no answer is still the outage label
    expect(noSnapReason({ ...base, error: "/api/containers/c1 → 504" })).toBe("offline");
    expect(noSnapReason({ ...base, error: "Failed to fetch" })).toBe("offline");
  });
});

const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body }) as Response;
const pausedScope = {
  limits: { usd: null, tokens: 100000 },
  usage: { spend_usd: 0, metered_runs: 0, unmetered_runs: 4, unmetered_tokens: 110852, tokens: 110852, runs: 4, in_flight_runs: 0 },
  state: "exceeded", usd_ratio: null, token_ratio: 1.1, limits_reached: ["tokens"], paused: true,
  override: { active: false, granted_by: null, granted_at: null, note: null }, updated_at: null,
  reason: "Project monthly budget reached (110.9k tokens of 100k tokens)",
};
beforeEach(() => {
  global.fetch = vi.fn((input: RequestInfo | URL) => {
    const u = String(input);
    if (u === "/api/containers") return Promise.resolve(ok([{ id: "c1", status: "active" }]));
    if (u.endsWith("/budgets")) return Promise.resolve(ok({ period: "2026-09", starts_at: "2026-09-01", resets_at: "2026-10-01", project: pausedScope, agents: [] }));
    return Promise.resolve(ok({ container: { id: "c1", name: "P", status: "active", wakes_enabled: true }, agents: [], tasks: [], requests: [] }));
  }) as unknown as typeof fetch;
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

async function mount(node: React.ReactNode) {
  render(<MemoryRouter><SnapshotProvider pollMs={60_000}>{node}</SnapshotProvider></MemoryRouter>);
  await act(async () => { await new Promise((r) => setTimeout(r, 1_700)); });
}

describe("VD-40 budget chip on a phone header", () => {
  it("overflow density: glyph-only chip that keeps the reason in its accessible name + tooltip", async () => {
    await mount(<ProjectBudgetChip iconOnly />);
    const chip = await screen.findByTestId("project-budget-chip");
    expect(chip.classList.contains("is-icon")).toBe(true);
    expect(chip.getAttribute("aria-label")).toMatch(/^Budget paused — Project monthly budget reached/);
    expect(chip.getAttribute("title")).toMatch(/Project monthly budget reached/);
  });
  it("wider headers keep the worded chip", async () => {
    await mount(<ProjectBudgetChip />);
    const chip = await screen.findByTestId("project-budget-chip");
    expect(chip.classList.contains("is-icon")).toBe(false);
  });
  it("CSS: the icon chip hides its words visually; hamburger never shrinks; tabs give way first", () => {
    const s = css("v2-shell.css");
    expect(s).toMatch(/\.v2-budget-chip\.is-icon \.v2-health-text \{[^}]*clip: rect\(0 0 0 0\)/);
    expect(s).toMatch(/\.v2-header\.is-d-overflow > \.v2-hamburger \{ flex-shrink: 0; \}/);
    expect(s).toMatch(/\.v2-header\.is-d-overflow\.has-tabs > \.v2-ptabs \{ min-width: 0; \}/);
  });
});

describe("VD-06 coarse-pointer hit-area overrides win the cascade", () => {
  it("v2-primitives: the scroller padding comes AFTER the base .v2-pills rule", () => {
    const s = css("v2-primitives.css");
    const base = s.indexOf(".v2-pills { display: inline-flex;");
    const coarse = s.lastIndexOf(".v2-pills { padding-block: 10px; margin-block: -10px; }");
    expect(base).toBeGreaterThan(0);
    expect(coarse).toBeGreaterThan(base);
    // settings pills: element-qualified so settings-cards.css' `padding: 0 …` can't win
    expect(s).toMatch(/nav\.set-nav-pills \{ padding-block: 10px; margin-block: -10px; \}/);
  });
  it("v2-shell: the toolbar row's coarse padding comes AFTER the ≤560 px shorthand", () => {
    const s = css("v2-shell.css");
    const narrow = s.indexOf(".v2-toolbar-slot { padding: 6px var(--v2-space-3); }");
    const coarse = s.lastIndexOf(".v2-toolbar-slot { padding-block: 10px; }");
    expect(narrow).toBeGreaterThan(0);
    expect(coarse).toBeGreaterThan(narrow);
  });
});
