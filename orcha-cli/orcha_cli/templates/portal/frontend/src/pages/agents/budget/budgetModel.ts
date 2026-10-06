/**
 * Monthly budgets — client model for budget_routes (GET/PUT /api/agents/{aid}/budget,
 * GET /api/containers/{cid}/budgets, PUT /api/containers/{cid}/budget).
 *
 * Accounting doctrine (same as the backend and the Metrics page): dollars are the cost
 * each run REPORTED; a run that reported no dollar figure (subscription billing, Codex,
 * an unpriced model) is "not metered" — never shown as $0 of spend. Tokens = input +
 * output + cache-read + cache-creation. Budget month = the UTC calendar month.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { Health } from "../../../components/primitives";

export type BudgetState = "none" | "ok" | "warning" | "exceeded";

export interface BudgetUsage {
  spend_usd: number;
  metered_runs: number;
  unmetered_runs: number;
  unmetered_tokens: number;
  tokens: number;
  runs: number;
  in_flight_runs: number;
}

export interface BudgetOverride {
  active: boolean;
  granted_by: string | null;
  granted_at: string | null;
  note: string | null;
}

export interface BudgetScope {
  limits: { usd: number | null; tokens: number | null };
  usage: BudgetUsage;
  state: BudgetState;
  usd_ratio: number | null;
  token_ratio: number | null;
  limits_reached: string[];
  paused: boolean;
  override: BudgetOverride;
  updated_at: string | null;
  reason?: string | null;
}

export interface AgentBudgetStatus extends BudgetScope {
  agent_id: string;
  alias: string | null;
  blocked_by: "agent" | "project" | null;
  reason: string | null;
}

export interface AgentBudget extends AgentBudgetStatus {
  period: string;
  starts_at: string;
  resets_at: string;
  project: BudgetScope;
}

export interface ContainerBudgets {
  period: string;
  starts_at: string;
  resets_at: string;
  project: BudgetScope;
  agents: AgentBudgetStatus[];
}

export interface BudgetUpdate {
  actor_agent_id?: string | null;
  monthly_limit_usd?: number | null;
  monthly_limit_tokens?: number | null;
  override?: "grant" | "revoke";
  note?: string | null;
}

/* ---- formatting --------------------------------------------------------- */

export function fmtUsd(n: number | null | undefined): string {
  const v = Number(n) || 0;
  return "$" + v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function fmtTok(n: number | null | undefined): string {
  const v = Number(n) || 0;
  if (v >= 1_000_000) return (v / 1_000_000).toFixed(v >= 10_000_000 ? 0 : 1).replace(/\.0$/, "") + "M";
  if (v >= 1_000) return (v / 1_000).toFixed(v >= 10_000 ? 0 : 1).replace(/\.0$/, "") + "k";
  return String(Math.round(v));
}

/** "Oct 1" — the UTC day the budget month resets. */
export function fmtReset(iso: string | null | undefined): string {
  if (!iso) return "next month";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "next month";
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

/** "October 2026" from the 'YYYY-MM' period key. */
export function fmtPeriod(period: string | null | undefined): string {
  const m = /^(\d{4})-(\d{2})$/.exec(period || "");
  if (!m) return period || "";
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, 1));
  return d.toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
}

/** Bar fill 0–100 from a ratio (capped — an overspend reads as a full bar + the red tone). */
export function meterPct(ratio: number | null | undefined): number {
  if (ratio == null || !Number.isFinite(ratio)) return ratio == null ? 0 : 100;
  return Math.max(0, Math.min(100, ratio * 100));
}

export function pctLabel(ratio: number | null | undefined): string {
  if (ratio == null) return "";
  if (ratio >= 9.99) return ">999%";
  return Math.round(ratio * 100) + "%";
}

/** Health chip for a scope — from the REAL verdict, never a default "On track". */
export function budgetHealth(s: Pick<BudgetScope, "state" | "paused" | "override">): { health: Health; label: string } | null {
  switch (s.state) {
    case "ok":
      return { health: "on_track", label: "Within budget" };
    case "warning":
      return { health: "at_risk", label: "Near limit" };
    case "exceeded":
      return s.paused ? { health: "off_track", label: "Paused" } : { health: "off_track", label: "Over · override" };
    default:
      return null;
  }
}

/** The meter tone class suffix: ok | warn | over. */
export function meterTone(ratio: number | null | undefined): "ok" | "warn" | "over" {
  if (ratio == null) return "ok";
  if (ratio >= 1) return "over";
  if (ratio >= 0.8) return "warn";
  return "ok";
}

/** Nothing metered but runs happened: the USD figure is unknown, not $0. */
export function spendUnknown(u: BudgetUsage): boolean {
  return u.metered_runs === 0 && u.unmetered_runs > 0;
}

/** Parse an input: blank → null (no limit); invalid/negative → undefined (reject). */
export function parseLimit(raw: string, integer: boolean): number | null | undefined {
  const t = raw.trim().replace(/[$,\s]/g, "");
  if (!t) return null;
  const n = Number(t);
  if (!Number.isFinite(n) || n < 0) return undefined;
  return integer ? Math.round(n) : Math.round(n * 100) / 100;
}

/* ---- data --------------------------------------------------------------- */

async function readJSON<T>(r: Response): Promise<T> {
  if (!r.ok) {
    let detail = "";
    try {
      const body = (await r.json()) as { detail?: unknown };
      detail = typeof body?.detail === "string" ? body.detail : "";
    } catch {
      /* non-JSON error body */
    }
    const e = new Error(detail || "HTTP " + r.status) as Error & { status?: number };
    e.status = r.status;
    throw e;
  }
  return (await r.json()) as T;
}

export function fetchAgentBudget(aid: string, signal?: AbortSignal): Promise<AgentBudget> {
  return fetch("/api/agents/" + encodeURIComponent(aid) + "/budget", signal ? { signal } : undefined).then((r) => readJSON<AgentBudget>(r));
}

export function putAgentBudget(aid: string, body: BudgetUpdate): Promise<AgentBudget> {
  return fetch("/api/agents/" + encodeURIComponent(aid) + "/budget", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }).then((r) => readJSON<AgentBudget>(r));
}

export function fetchContainerBudgets(cid: string, signal?: AbortSignal): Promise<ContainerBudgets> {
  return fetch("/api/containers/" + encodeURIComponent(cid) + "/budgets", signal ? { signal } : undefined).then((r) => readJSON<ContainerBudgets>(r));
}

export function putContainerBudget(cid: string, body: BudgetUpdate): Promise<ContainerBudgets> {
  return fetch("/api/containers/" + encodeURIComponent(cid) + "/budget", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }).then((r) => readJSON<ContainerBudgets>(r));
}

export const BUDGET_REFRESH_MS = 60_000;

/** Fired on window after any budget write succeeds, so every budget reader on the page
 *  (the roster's "Budget paused" chips, Metrics) re-reads at once instead of in ≤60 s. */
export const BUDGET_CHANGED_EVENT = "orcha:budget-changed";
export function announceBudgetChange(): void {
  try {
    window.dispatchEvent(new Event(BUDGET_CHANGED_EVENT));
  } catch {
    /* no window (SSR / tests without DOM) */
  }
}

function isScope(x: unknown): x is BudgetScope {
  const s = x as BudgetScope | null;
  return !!s && typeof s === "object" && !!s.limits && !!s.usage && typeof s.state === "string";
}
export function isContainerBudgets(x: unknown): x is ContainerBudgets {
  const d = x as ContainerBudgets | null;
  return !!d && Array.isArray(d.agents) && isScope(d.project) && d.agents.every(isScope);
}
export function isAgentBudget(x: unknown): x is AgentBudget {
  return isScope(x) && typeof (x as AgentBudget).period === "string";
}

/**
 * The project's budgets, refreshed every 60s (budgets move slowly — never on the 3s tick).
 * `unsupported` is true when the server has no budgets route yet (404): callers then render
 * nothing rather than an error. Mount points that show an agent's status (roster, board,
 * header) can use this + `agentBudgetOf` to show the pause reason.
 */
export function useContainerBudgets(cid: string | null | undefined) {
  const [data, setData] = useState<ContainerBudgets | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [unsupported, setUnsupported] = useState(false);
  const tok = useRef(0);
  const load = useCallback(() => {
    if (!cid) return;
    const my = ++tok.current;
    fetchContainerBudgets(cid)
      .then((d) => {
        if (my !== tok.current) return;
        // an older / foreign answer without the budgets shape is "unsupported", never a crash
        if (!isContainerBudgets(d)) {
          setUnsupported(true);
          return;
        }
        setData(d);
        setError(null);
      })
      .catch((e: Error & { status?: number }) => {
        if (my !== tok.current) return;
        if (e.status === 404 || e.status === 405) setUnsupported(true);
        else setError(e.message);
      });
  }, [cid]);
  useEffect(() => {
    setData(null);
    setError(null);
    setUnsupported(false);
    if (!cid) return;
    load();
    const iv = setInterval(load, BUDGET_REFRESH_MS);
    window.addEventListener(BUDGET_CHANGED_EVENT, load);
    return () => {
      clearInterval(iv);
      window.removeEventListener(BUDGET_CHANGED_EVENT, load);
      tok.current++;
    };
  }, [cid, load]);
  return { data, error, unsupported, reload: load, setData };
}

export function agentBudgetOf(data: ContainerBudgets | null | undefined, agentId: string | null | undefined): AgentBudgetStatus | null {
  if (!data || !agentId) return null;
  return data.agents.find((a) => String(a.agent_id) === String(agentId)) || null;
}

/** Paused agents by id (only the paused ones) — what the roster / board / header chips read. */
export function pausedById(data: ContainerBudgets | null | undefined): Record<string, AgentBudgetStatus> {
  const out: Record<string, AgentBudgetStatus> = {};
  for (const a of data?.agents ?? []) if (a.paused) out[String(a.agent_id)] = a;
  return out;
}

/** The project-cap scope's one-line status for a project-level notice, or null when
 *  the project cap is not what's stopping new runs. */
export function projectPauseLine(data: ContainerBudgets | null | undefined): string | null {
  const p = data?.project;
  if (!p || !p.paused) return null;
  return p.reason || "Project monthly budget reached — new runs are paused until " + fmtReset(data!.resets_at) + ".";
}
