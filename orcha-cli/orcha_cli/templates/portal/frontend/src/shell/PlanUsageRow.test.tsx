/**
 * Sidebar plan-usage row + Settings › Interface › Plan usage (contract:
 * PLAN-USAGE-DISPLAY — off by default; Both = logo + % each; one provider =
 * logo + bar + %; warn > 75, danger > 90; optimistic PUT of the setting).
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PlanUsageRow } from "./PlanUsageRow";
import { PlanUsageSettings, PLAN_USAGE_CAPTION } from "../pages/settings/PlanUsageSettings";
import {
  latestByProvider, resetsInLabel, shownProviders, usageTone, PLAN_USAGE_POLL_MS, type PlanSnapshot,
} from "../state/planUsage";

const IN_2H = new Date(Date.now() + 2 * 3600_000 + 14 * 60_000 + 20_000).toISOString();

const SNAPSHOTS: PlanSnapshot[] = [
  {
    host: "mac-new", captured_at: "2026-10-03T10:00:00Z", updated_at: "2026-10-03T10:00:01Z",
    providers: [
      { provider: "claude", plan: "Max", headline: null, windows: [
        { key: "5h", label: "5-hour", used_pct: 34.2, resets_at: IN_2H },
        { key: "7d", label: "Weekly", used_pct: 12, resets_at: null },
      ] },
    ],
  },
  {
    host: "mac-old", captured_at: "2026-10-03T08:00:00Z", updated_at: "2026-10-03T08:00:01Z",
    providers: [
      { provider: "claude", plan: "Max", headline: null, windows: [{ key: "5h", label: "5-hour", used_pct: 99, resets_at: null }] },
      { provider: "codex", plan: "Plus", headline: null, windows: [
        { key: "5h", label: "5-hour", used_pct: 76, resets_at: null },
        { key: "7d", label: "Weekly", used_pct: 40, resets_at: null },
      ] },
    ],
  },
];

type Display = { show: boolean; providers: string; updated_at: string | null };
let display: Display;
let puts: Array<{ show: boolean; providers: string }>;
let putStatus: number;

function mockFetch() {
  global.fetch = vi.fn(async (url: string, init?: RequestInit) => {
    const u = String(url);
    if (u === "/api/plan-usage/display" && init?.method === "PUT") {
      const body = JSON.parse(String(init.body));
      puts.push(body);
      if (putStatus !== 200) return { ok: false, status: putStatus, json: async () => ({ detail: "nope" }) };
      display = { ...body, updated_at: "2026-10-03T11:00:00Z" };
      return { ok: true, status: 200, json: async () => display };
    }
    if (u === "/api/plan-usage/display") return { ok: true, status: 200, json: async () => display };
    if (u === "/api/plan-usage") return { ok: true, status: 200, json: async () => ({ snapshots: SNAPSHOTS }) };
    return { ok: false, status: 404, json: async () => ({}) };
  }) as unknown as typeof fetch;
}

beforeEach(() => {
  display = { show: false, providers: "both", updated_at: null };
  puts = [];
  putStatus = 200;
  mockFetch();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });

describe("helpers", () => {
  it("newest snapshot per provider across hosts", () => {
    const latest = latestByProvider(SNAPSHOTS);
    expect(latest.claude?.windows[0].used_pct).toBe(34.2); // mac-new wins over mac-old's 99
    expect(latest.codex?.plan).toBe("Plus"); // only mac-old has codex
  });
  it("tones: warn above 75, danger above 90", () => {
    expect(usageTone(75)).toBe("ok");
    expect(usageTone(76)).toBe("warn");
    expect(usageTone(90)).toBe("warn");
    expect(usageTone(91)).toBe("danger");
  });
  it("hidden when off; a chosen provider without data is omitted", () => {
    const latest = latestByProvider(SNAPSHOTS);
    expect(shownProviders({ show: false, providers: "both", updated_at: null }, latest)).toEqual([]);
    expect(shownProviders({ show: true, providers: "codex", updated_at: null }, { claude: latest.claude })).toEqual([]);
  });
  it("resets in …", () => {
    const now = Date.parse("2026-10-03T10:00:00Z");
    expect(resetsInLabel("2026-10-03T12:14:00Z", now)).toBe("resets in 2h 14m");
    expect(resetsInLabel("2026-10-06T14:00:00Z", now)).toBe("resets in 3d 4h");
    expect(resetsInLabel("2026-10-03T10:05:00Z", now)).toBe("resets in 5m");
    expect(resetsInLabel(null, now)).toBeNull();
  });
});

describe("sidebar PlanUsageRow", () => {
  it("is hidden by default (show=false) and never loads the snapshots", async () => {
    render(<PlanUsageRow collapsed={false} />);
    await settle();
    expect(screen.queryByTestId("sb-plan-usage")).toBeNull();
    const urls = (global.fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls.map((c) => c[0]);
    expect(urls).toContain("/api/plan-usage/display");
    expect(urls).not.toContain("/api/plan-usage");
  });

  it("Both: each provider as logo + percent of its busiest window, toned, no bar", async () => {
    display = { show: true, providers: "both", updated_at: "2026-10-03T09:00:00Z" };
    render(<PlanUsageRow collapsed={false} />);
    const row = await screen.findByTestId("sb-plan-usage");
    expect(row).toHaveAttribute("aria-label", "Usage: Claude 34%, Codex 76%");
    expect(row).toHaveTextContent("Usage");
    const claude = row.querySelector('[data-provider="claude"]')!;
    const codex = row.querySelector('[data-provider="codex"]')!;
    expect(claude.querySelector('svg[data-brand="claude"]')).not.toBeNull();
    expect(codex.querySelector('svg[data-brand="openai"]')).not.toBeNull();
    expect(claude).toHaveTextContent("34%");
    expect(codex).toHaveTextContent("76%");
    expect(codex.querySelector(".v2-pu-pct")).toHaveAttribute("data-tone", "warn");
    expect(row.querySelector(".v2-pu-bar")).toBeNull();

    // the popover lists each provider's windows: label, bar, % and "resets in …"
    fireEvent.click(row);
    const pop = await screen.findByRole("dialog", { name: "Plan usage" });
    const wins = pop.querySelectorAll(".v2-pu-win");
    expect(wins).toHaveLength(4);
    expect(wins[0]).toHaveTextContent("5-hour");
    expect(wins[0]).toHaveTextContent("34%");
    expect(wins[0]).toHaveTextContent("resets in 2h 14m");
    expect(wins[0].querySelector(".v2-pu-bar")).not.toBeNull();
  });

  it("one provider: logo + thin bar + percent of only that provider", async () => {
    display = { show: true, providers: "codex", updated_at: "2026-10-03T09:00:00Z" };
    render(<PlanUsageRow collapsed={false} />);
    const row = await screen.findByTestId("sb-plan-usage");
    expect(row).toHaveAttribute("aria-label", "Usage: Codex 76%");
    expect(row.querySelector('[data-provider="claude"]')).toBeNull();
    const one = row.querySelector('.v2-pu-one[data-provider="codex"]')!;
    expect(one.querySelector('svg[data-brand="openai"]')).not.toBeNull();
    expect(one.querySelector(".v2-pu-bar")).toHaveAttribute("data-tone", "warn");
    expect(one).toHaveTextContent("76%");
  });

  it("polls every 2 minutes while visible", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    render(<PlanUsageRow collapsed={false} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });
    const count = () => (global.fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls
      .filter((c) => c[0] === "/api/plan-usage/display").length;
    const before = count();
    display = { show: true, providers: "claude", updated_at: "2026-10-03T09:00:00Z" };
    await act(async () => { await vi.advanceTimersByTimeAsync(PLAN_USAGE_POLL_MS); });
    expect(count()).toBe(before + 1);
    vi.useRealTimers();
    expect(await screen.findByTestId("sb-plan-usage")).toHaveAttribute("aria-label", "Usage: Claude 34%");
  });
});

describe("Settings › Plan usage", () => {
  it("switch off by default, Providers disabled, caption shown", async () => {
    render(<PlanUsageSettings />);
    await settle();
    const sw = screen.getByRole("switch", { name: "Show plan usage" });
    expect(sw).toHaveAttribute("aria-checked", "false");
    expect(screen.getByText(PLAN_USAGE_CAPTION)).toBeInTheDocument();
    for (const name of ["Both", "Claude", "Codex"]) expect(screen.getByRole("radio", { name })).toBeDisabled();
    expect(screen.getByRole("radio", { name: "Both" })).toHaveAttribute("aria-checked", "true");
  });

  it("writes: the switch and the provider PUT optimistically, and the sidebar follows", async () => {
    render(<><PlanUsageSettings /><PlanUsageRow collapsed={false} /></>);
    await settle();
    fireEvent.click(screen.getByRole("switch", { name: "Show plan usage" }));
    // optimistic: checked before the PUT resolves
    expect(screen.getByRole("switch", { name: "Show plan usage" })).toHaveAttribute("aria-checked", "true");
    await waitFor(() => expect(puts).toEqual([{ show: true, providers: "both" }]));
    expect(await screen.findByTestId("sb-plan-usage")).toHaveAttribute("aria-label", "Usage: Claude 34%, Codex 76%");

    fireEvent.click(screen.getByRole("radio", { name: "Claude" }));
    expect(screen.getByRole("radio", { name: "Claude" })).toHaveAttribute("aria-checked", "true");
    await waitFor(() => expect(puts[1]).toEqual({ show: true, providers: "claude" }));
    await waitFor(() => expect(screen.getByTestId("sb-plan-usage")).toHaveAttribute("aria-label", "Usage: Claude 34%"));
  });

  it("a refused write restores the previous value and says why", async () => {
    putStatus = 403;
    render(<PlanUsageSettings />);
    await settle();
    fireEvent.click(screen.getByRole("switch", { name: "Show plan usage" }));
    expect(screen.getByRole("switch", { name: "Show plan usage" })).toHaveAttribute("aria-checked", "true");
    await waitFor(() => expect(screen.getByRole("switch", { name: "Show plan usage" })).toHaveAttribute("aria-checked", "false"));
    expect(screen.getByRole("alert")).toHaveTextContent("permission");
  });
});
