/**
 * Metrics page — React port of static/metrics.html + pages/metrics-state.js
 * (pure formatters/builders) + pages/metrics-render.js (fetch/patch glue).
 *
 * Data: GET /api/containers/{cid}/metrics?days=7|30 — the one aggregate
 * endpoint added for this page (container_metrics_routes). Cadence: the shared
 * 3s snapshot poll keeps the shell chrome live; the AGGREGATE endpoint is
 * heavier and changes slowly, so it refreshes on load, on range toggle, and on
 * a 60s timer — never on the 3s tick.
 *
 * Chart discipline (dataviz): single-series magnitude everywhere → one hue (the
 * token accent), no legend, text in text tokens with tabular-nums only inside
 * table columns, bars ≤24px with a 4px rounded data-end and a square baseline,
 * 2px surface gaps, honest zero bars.
 *
 * Agent spend drilldown (agent_spend_routes): clicking a per-agent row opens a
 * detail view on THIS page (deep-linkable `/metrics?agent=<id>`, back link to
 * return) fed by GET .../metrics/agents/{aid}/spend?window=5h|7d|all — its own
 * window switcher, independent of the 7/30-day aggregate above. Below the
 * per-task table, GET .../metrics/insights?window=7d|all renders a rule-based
 * (no LLM) "How to reduce spending" card. Accounting doctrine (repeated at each
 * read site by design): total_tokens sums input+output+cache_read+cache_creation
 * — that's the quota signal; total_cost_usd is the dollar figure, surfaced
 * separately, never folded into the token sum.
 *
 * V2 (parity M-01…M-03): small summary row instead of stat cards, an explicit
 * scope line (project · window · UTC days), sortable detail tables, and
 * MISSING-COST honesty — a run that reported no dollar figure (subscription
 * billing, unpriced model, Codex) is never shown as $0: when no run in scope
 * reported cost the figure reads "not reported", and a per-row $0 is shown as
 * "not reported" unless every run in the window reported cost.
 *
 * Linear pass (D5/D8/D10/D12): the window pills live in the panel toolbar
 * (FilterPills + a circular info button), the summary is ONE compact card
 * (figures + the runs-per-day sparkline side by side), and the per-agent /
 * per-task tables are Initiatives-style: muted column headers, borderless
 * 40px rows with hover, agent + model stacked in the name cell, run health as
 * a HealthChip derived from the REAL failed-run ratio (never a default "On
 * track"), and status as the shared D8 glyph set.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { Shell } from "../../shell/Shell";
import { PageHeader, PageToolbar } from "../../shell/PageChrome";
import {
  Avatar, Button, ButtonLink, Chip, EmptyState, HEALTH_LABEL, HEALTH_RULE, HealthChip, healthFromFailures, IconButton, MenuButton, Popover, RawPayload,
  Skeleton, StatusIcon, humanizeKey, type Health, type MenuItemSpec,
} from "../../components/primitives";
import { FilterPills } from "../../components/primitives";
import { useSnapshot } from "../../state/SnapshotProvider";
import { useModelName } from "../../lib/models";
import { BudgetBars } from "./BudgetBars";
import { PerformanceSection } from "./performance/PerformanceSection";
import { isAccessDenied } from "./performance/performanceModel";
import "./metrics.css";

/* ---- payload shape (container_metrics_routes) --------------------------- */
export interface MxTotals {
  runs: number;
  runs_with_cost: number;
  est_cost_usd: number;
  sandbox_seconds: number;
  tokens_in: number;
  tokens_out: number;
  tasks_completed: number;
  tasks_verified: number;
}
export interface MxDay { date: string; runs: number; est_cost_usd: number }
export interface MxAgent {
  agent_id: string;
  alias: string | null;
  model: string | null;
  runs: number;
  ok_runs: number;
  failed_runs: number;
  sandbox_seconds: number;
  tokens_in: number;
  tokens_out: number;
  est_cost_usd: number;
  /** runs that reported token counts (newer servers); absent on older ones */
  runs_with_tokens?: number;
}

/** M02b: did this agent's runs report tokens at all (pure, tested)? A missing
 *  count is summed as 0 server-side — "0 in · 0 out" would claim zero usage.
 *  Uses runs_with_tokens when the server sends it; otherwise a row with runs
 *  but exactly zero tokens both ways is read as "not reported". */
export function tokensReported(a: Pick<MxAgent, "runs" | "tokens_in" | "tokens_out" | "runs_with_tokens">): boolean {
  if (typeof a.runs_with_tokens === "number") return a.runs_with_tokens > 0;
  return !(a.runs > 0 && !a.tokens_in && !a.tokens_out);
}
export interface MxPayload {
  days: number;
  totals: MxTotals;
  daily: MxDay[];
  per_agent: MxAgent[];
}

/* ---- spend drilldown payload shape (agent_spend_routes) ------------------ */
export type SpendWindow = "5h" | "7d" | "30d" | "all";
export interface SpTotals {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
  total_tokens: number;
  total_cost_usd: number;
  runs: number;
  /** additive (V2 QA): runs that recorded a cost; absent on older backends */
  runs_with_cost?: number;
}
export interface SpTaskRow extends SpTotals {
  task_id: string | null;
  title: string | null;
  status: string | null;
  first_run_at: string | null;
  last_run_at: string | null;
}
export interface SpPayload {
  agent: { id: string; alias: string | null; model: string | null; reasoning_effort: string | null };
  window: SpendWindow;
  totals: SpTotals;
  tasks: SpTaskRow[];
}

/* ---- insights payload shape (agent_spend_routes) -------------------------- */
export type InsightWindow = "7d" | "all";
export interface Insight {
  id: string;
  severity: "high" | "medium" | "info";
  title: string;
  detail: string;
  evidence: Record<string, unknown>;
  action: string;
}
export interface InsightsPayload {
  window: InsightWindow;
  insights: Insight[];
}

/* ---- formatters (metrics-state.js, verbatim behavior) ------------------- */
export function fmtUsd(n: unknown): string {
  const v = Number(n) || 0;
  if (v !== 0 && v < 0.01) return "$" + v.toFixed(4);
  if (v < 1000) return "$" + v.toFixed(2);
  return "$" + Math.round(v).toLocaleString("en-US");
}
export function fmtTokens(n: unknown): string {
  const v = Number(n) || 0;
  if (v < 1000) return String(v);
  if (v < 1e6) return (v / 1e3).toFixed(1).replace(/\.0$/, "") + "K";
  return (v / 1e6).toFixed(1).replace(/\.0$/, "") + "M";
}
export function fmtDuration(secs: unknown): string {
  let s0 = Math.round(Number(secs) || 0);
  if (s0 <= 0) return "0s";
  const d = Math.floor(s0 / 86400), h = Math.floor((s0 % 86400) / 3600);
  const m = Math.floor((s0 % 3600) / 60), s = s0 % 60;
  if (d) return d + "d " + h + "h";
  if (h) return h + "h " + m + "m";
  if (m) return m + "m " + (s ? s + "s" : "");
  return s + "s";
}
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export function fmtDay(iso: string | null | undefined): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || "");
  return m ? MONTHS[Number(m[2]) - 1] + " " + Number(m[3]) : String(iso || "");
}
export const NO_COST_CAPTION = "No run reported cost — tokens are the usage signal";
export function costCaption(totals: MxTotals): string {
  const n = totals.runs_with_cost || 0, m = totals.runs || 0;
  if (!m) return "no runs in this window";
  if (!n) return NO_COST_CAPTION;
  return "estimated · " + n + " of " + m + " run" + (m === 1 ? "" : "s") + " reported cost";
}

/** One-line tile caption (D12: captions never wrap) — the full sentence from
 *  costCaption() rides along as the tooltip. Unit-tested. */
export function costCaptionShort(totals: Pick<MxTotals, "runs" | "runs_with_cost">): string {
  const n = totals.runs_with_cost || 0, m = totals.runs || 0;
  if (!m) return "no runs";
  if (!n) return "see tokens";
  return n >= m ? "all runs reported" : "from " + n + " of " + m + " runs";
}

/** No run in scope reported a dollar figure → the cost is UNKNOWN, not $0. */
export function costUnreported(totals: Pick<MxTotals, "runs" | "runs_with_cost">): boolean {
  return (totals.runs || 0) > 0 && (totals.runs_with_cost || 0) === 0;
}
/** Every run in the window reported cost → a row's $0 really is $0. */
export function costComplete(totals: Pick<MxTotals, "runs" | "runs_with_cost">): boolean {
  return (totals.runs || 0) > 0 && (totals.runs_with_cost || 0) >= (totals.runs || 0);
}
export const NOT_REPORTED = "not reported";
const NOT_REPORTED_TIP = "No cost was recorded for these runs (subscription billing, an unpriced model, or a runtime that reports tokens only). This is not $0 — the token counts are the usage signal.";

/** A row's dollar cell: "$x" when known, else "not reported" (never a fake $0.00). */
function UsdCell({ v, known }: { v: number; known: boolean }) {
  if (v > 0 || known) return <>{fmtUsd(v)}</>;
  return <span className="mx-none" title={NOT_REPORTED_TIP}>{NOT_REPORTED}</span>;
}

/* ---- sortable tables ------------------------------------------------------ */
type Dir = "asc" | "desc";
export function sortRows<T>(rows: T[], key: (r: T) => number | string, dir: Dir): T[] {
  const m = dir === "asc" ? 1 : -1;
  return [...rows].sort((a, b) => {
    const x = key(a), y = key(b);
    if (typeof x === "number" && typeof y === "number") return (x - y) * m;
    return String(x).localeCompare(String(y)) * m;
  });
}
function SortTh({ label, col, sort, onSort, title, num }: {
  label: string; col: string; sort: { col: string; dir: Dir }; onSort: (col: string) => void; title?: string; num?: boolean;
}) {
  const on = sort.col === col;
  return (
    <th aria-sort={on ? (sort.dir === "asc" ? "ascending" : "descending") : "none"} title={title} className={num ? "num" : undefined}>
      <button type="button" className={"mx-sort" + (on ? " on" : "")} onClick={() => onSort(col)}>
        {label}<span aria-hidden="true" className="mx-sort-i">{on ? (sort.dir === "asc" ? "↑" : "↓") : ""}</span>
      </button>
    </th>
  );
}
type SortState = { col: string; dir: Dir };
const naturalDir = (col: string): Dir => (col === "agent" || col === "task" ? "asc" : "desc");
function useSort(initial: SortState) {
  const [sort, setSort] = useState(initial);
  const onSort = (col: string) =>
    setSort((s) => (s.col === col ? { col, dir: s.dir === "asc" ? "desc" : "asc" } : { col, dir: naturalDir(col) }));
  const setDir = (dir: Dir) => setSort((s) => ({ ...s, dir }));
  return { sort, onSort, setDir };
}

/** Phone sort control (≤600px, where the column headers are hidden and rows
 *  stack): one rounded pill "Sort: Est. cost ↓" opening a radio menu of the
 *  same sortable columns + direction. Hidden by CSS on wider screens, where the
 *  column headers themselves sort. */
function SortPill({ cols, sort, onSort, setDir, label }: {
  cols: { col: string; label: string }[]; sort: SortState; onSort: (col: string) => void; setDir: (d: Dir) => void; label: string;
}) {
  const cur = cols.find((c) => c.col === sort.col)?.label ?? "";
  const items: (MenuItemSpec | "separator")[] = [
    ...cols.map((c) => ({
      label: c.label,
      checked: c.col === sort.col,
      onSelect: () => { if (c.col !== sort.col) onSort(c.col); },
    })),
    "separator",
    { label: "Descending", checked: sort.dir === "desc", onSelect: () => setDir("desc") },
    { label: "Ascending", checked: sort.dir === "asc", onSelect: () => setDir("asc") },
  ];
  return (
    <span className="mx-sortpill">
      <MenuButton
        size="sm"
        variant="ghost"
        label="Sort"
        value={<>{cur} <span aria-hidden="true">{sort.dir === "asc" ? "↑" : "↓"}</span></>}
        items={items}
        menuLabel={label}
        placement="bottom-end"
        title={`Sorted by ${cur}, ${sort.dir === "asc" ? "ascending" : "descending"}`}
      />
    </span>
  );
}

/* ---- compact summary card (figures + runs-per-day sparkline) ------------- */
function Stat({ label, value, sub, subTitle, title, unknown }: {
  label: string; value: string; sub?: string | null; subTitle?: string | null; title?: string; unknown?: boolean;
}) {
  return (
    <div className="mx-tile" title={title}>
      <div className="l">{label}</div>
      <div className={"v" + (unknown ? " is-unknown" : "")}>{value}</div>
      {sub ? <div className="s" title={subTitle ?? sub}>{sub}</div> : null}
    </div>
  );
}

function StatCards({ d }: { d: MxPayload }) {
  const t = d.totals;
  const unreported = costUnreported(t);
  const agents = (d.per_agent || []).length;
  return (
    <>
      <Stat
        label="Est. cost (USD)"
        value={unreported ? "Not reported" : fmtUsd(t.est_cost_usd)}
        sub={costCaptionShort(t)}
        subTitle={costCaption(t)}
        title={unreported ? NOT_REPORTED_TIP : undefined}
        unknown={unreported}
      />
      <Stat label="Runs" value={String(t.runs)} sub={agents ? "across " + agents + " agent" + (agents === 1 ? "" : "s") : null} />
      <Stat label="Tokens (in · out)" value={fmtTokens(t.tokens_in) + " · " + fmtTokens(t.tokens_out)} sub="excl. cache" subTitle="Excludes cache reads/writes" />
      <Stat label="Sandbox compute" value={fmtDuration(t.sandbox_seconds)} sub="wall-clock" subTitle="Container wall-clock time" />
      <Stat label="Tasks" value={String(t.tasks_completed) + " done"} sub={String(t.tasks_verified) + " human-verified"} />
    </>
  );
}

/* ---- daily activity — CSS column sparkline (one series: runs) ----------- */
function DailyBars({ d }: { d: MxPayload }) {
  const days = d.daily || [];
  const max = days.reduce((m, x) => Math.max(m, x.runs), 0);
  const first = days.length ? fmtDay(days[0].date) : "";
  const last = days.length ? fmtDay(days[days.length - 1].date) : "";
  return (
    <div className="mx-chart">
      <div className="mx-chart-h">
        <span className="mx-chart-t">Runs per UTC day</span>
        {/* scale: the tallest bar's value, so heights read as magnitudes */}
        <span className="mx-spark-max">peak {max}</span>
      </div>
      <div className="mx-spark" role="img" aria-label={`Runs per day over the last ${d.days} days, peak ${max}`}>
        {days.map((x, i) => {
          const pct = max ? Math.round((x.runs / max) * 100) : 0;
          const cost = x.est_cost_usd > 0 || costComplete(d.totals) ? fmtUsd(x.est_cost_usd) : "cost " + NOT_REPORTED;
          const tip = fmtDay(x.date) + " · " + x.runs + " run" + (x.runs === 1 ? "" : "s")
            + (x.runs ? " · " + cost : "");
          return (
            <div key={i} className="mx-col" title={tip} aria-label={tip}>
              {/* honest zero: a 1px tick, never a fake bar */}
              {x.runs ? <div className="mx-bar" style={{ height: pct + "%" }} /> : <div className="mx-tick" />}
            </div>
          );
        })}
      </div>
      <div className="mx-spark-x"><span>{first}</span><span>{last}</span></div>
    </div>
  );
}

/* ---- per-agent table (rows open the spend drilldown) ---------------------- */
const AGENT_SORT: Record<string, (a: MxAgent) => number | string> = {
  agent: (a) => (a.alias || "").toLowerCase(), runs: (a) => a.runs, compute: (a) => a.sandbox_seconds,
  tokens: (a) => a.tokens_in + a.tokens_out, cost: (a) => a.est_cost_usd,
  health: (a) => (a.runs ? a.failed_runs / a.runs : -1),
};
const MODEL_UNKNOWN_TIP = "This runtime didn't record which model it ran (e.g. Codex or a custom worker).";

/* model display names come from the ONE shared catalog helper (lib/models:
 * GET /api/models once per page, catalog name else a readable id) — the same
 * names Onboarding and Agents show; the raw id stays in the tooltip. */

/** Cost magnitude bar width (0–100) — null when there is nothing honest to draw:
 *  cost unknown for the row, or under 1% of the largest cost (no stray slivers). */
export function costBarPct(cost: number, maxCost: number, known: boolean): number | null {
  if (!(maxCost > 0) || !(cost > 0 || known)) return null;
  const pct = Math.round((cost / maxCost) * 100);
  return pct < 1 ? null : pct;
}

/** Run health from the REAL failed-run ratio (Initiatives-style health chip):
 *  no runs → no_data; under 5% failed → on_track (a single failure in 71 runs
 *  is not "at risk"); 5% up to 20% → at_risk; 20% or more → off_track. The chip prints the Initiatives verdict ("On track" / "At risk" /
 *  "Off track") and the literal counts ride in the tooltip — the Runs column
 *  beside it shows "ok / total", so the count is never hidden. Unit-tested. */
export function runHealth(a: Pick<MxAgent, "runs" | "ok_runs" | "failed_runs">): { health: Health; label: string; title: string } {
  const runs = a.runs || 0, failed = a.failed_runs || 0;
  if (!runs) return { health: "no_data", label: "No runs", title: "No runs in this window" };
  const counts = `${a.ok_runs} of ${runs} run${runs === 1 ? "" : "s"} succeeded` + (failed ? ` · ${failed} failed` : "");
  const health = healthFromFailures(failed, runs);
  return { health, label: HEALTH_LABEL[health], title: counts + " — " + HEALTH_RULE };
}

/** Rule text re-exported from the ONE shared primitive definition (HealthChip). */
export { HEALTH_RULE };

const AGENT_COLS = [
  { col: "cost", label: "Est. cost" }, { col: "tokens", label: "Tokens" }, { col: "runs", label: "Runs" },
  { col: "compute", label: "Compute" }, { col: "health", label: "Health" }, { col: "agent", label: "Name" },
];

/** "Cost & activity by agent" section — owns the sort so the phone sort pill
 *  and the desktop column headers drive the same state. */
function AgentSection({ d, onSelect }: { d: MxPayload; onSelect: (agentId: string) => void }) {
  const unreported = costUnreported(d.totals);
  // no dollar figure in scope → sorting by cost is meaningless; lead with tokens
  const { sort, onSort, setDir } = useSort({ col: unreported ? "tokens" : "cost", dir: "desc" });
  const n = (d.per_agent || []).length;
  return (
    <section className="mx-sec mx-sec-flush" aria-labelledby="mxAgentsH">
      <div className="mx-sec-h"><h2 id="mxAgentsH">Cost &amp; activity by agent</h2>
        <span className="count" title={n + " agent" + (n === 1 ? "" : "s") + " with runs in this window"}>
          {n}{unreported ? <span title={NOT_REPORTED_TIP}> · sorted by tokens (no cost reported)</span> : null}
        </span>
        <SortPill cols={AGENT_COLS} sort={sort} onSort={onSort} setDir={setDir} label="Sort agents" />
      </div>
      <div className="mx-scroll">
        <AgentTable d={d} onSelect={onSelect} sort={sort} onSort={onSort} />
      </div>
    </section>
  );
}

function AgentTable({ d, onSelect, sort, onSort }: {
  d: MxPayload; onSelect: (agentId: string) => void; sort: SortState; onSort: (col: string) => void;
}) {
  const modelName = useModelName();
  const rows = sortRows(d.per_agent || [], AGENT_SORT[sort.col] || AGENT_SORT.cost, sort.dir);
  const maxCost = rows.reduce((m, a) => Math.max(m, a.est_cost_usd), 0);
  const complete = costComplete(d.totals);
  return (
    <table className="mx-tbl mx-agent-tbl">
      <caption className="v2-sr">Cost and activity per agent, last {d.days} days. Select a row for the agent&rsquo;s spend by task.</caption>
      <thead>
        <tr>
          <SortTh label="Agent" col="agent" sort={sort} onSort={onSort} />
          <SortTh label="Health" col="health" sort={sort} onSort={onSort} title="Failed runs out of all runs in this window" />
          <SortTh label="Runs" col="runs" sort={sort} onSort={onSort} num />
          <SortTh label="Compute" col="compute" sort={sort} onSort={onSort} title="Sandbox wall-clock time" num />
          <SortTh label="Tokens (in · out)" col="tokens" sort={sort} onSort={onSort} title="Input and output tokens, excluding cache reads/writes" num />
          <SortTh label="Est. cost (USD)" col="cost" sort={sort} onSort={onSort} num />
        </tr>
      </thead>
      <tbody>
        {rows.map((a) => {
          const pct = costBarPct(a.est_cost_usd, maxCost, a.est_cost_usd > 0 || complete);
          const h = runHealth(a);
          return (
            <tr
              key={a.agent_id}
              data-agent={a.agent_id}
              className="mx-row-click"
              tabIndex={0}
              role="button"
              aria-label={"View spend detail for " + (a.alias || "agent")}
              onClick={() => onSelect(a.agent_id)}
              onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onSelect(a.agent_id); } }}
            >
              <td className="mx-c-name">
                <span className="mx-agent" title={a.alias || undefined}>
                  <Avatar alias={a.alias} kind="ai" size={24} decorative />
                  <span className="mx-agent-txt">
                    <span className="nm">{a.alias || "?"}</span>
                    {a.model
                      ? <span className="mx-model" title={a.model}>{modelName(a.model) || a.model}</span>
                      : <span className="mx-model mx-none" title={MODEL_UNKNOWN_TIP}>Model not recorded</span>}
                  </span>
                </span>
              </td>
              <td className="mx-c-health"><HealthChip health={h.health} label={h.label} title={h.title} /></td>
              <td className="tnum num mx-c-runs" data-label="Runs" title={h.title}>
                {a.ok_runs}<span className="mx-of"> / </span>{a.runs}
              </td>
              <td className="tnum num mx-c-compute" data-label="Compute">{fmtDuration(a.sandbox_seconds)}</td>
              <td className="tnum num mx-c-tokens" data-label="Tokens">
                {tokensReported(a)
                  ? <>{fmtTokens(a.tokens_in)}<span className="mx-of"> in · </span>{fmtTokens(a.tokens_out)}<span className="mx-of"> out</span></>
                  : <span className="mx-none" title="These runs didn't report token counts (e.g. Codex or a subscription runtime) — unknown, not 0.">not reported</span>}
              </td>
              <td className="mx-cost tnum num mx-c-cost">
                <span className="mx-cost-in">
                  {pct != null ? (
                    <span className="mx-costtrack" aria-hidden="true">
                      <span className="mx-costbar" style={{ "--w": pct + "%" } as CSSProperties} />
                    </span>
                  ) : null}
                  <span className="v"><UsdCell v={a.est_cost_usd} known={complete} /></span>
                </span>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

/* ---- honest empty state --------------------------------------------------- */
function NoRunsState({ days }: { days: number }) {
  return (
    <div className="mx-empty">
      <EmptyState
        icon="chart"
        title={`No agent runs in the last ${days} days`}
        body="Figures appear once agents wake and record usage."
      />
    </div>
  );
}

/** Load failure: human copy, a Retry, and the raw status as a muted detail. */
function LoadError({ title, error, onRetry }: { title: string; error: string; onRetry: () => void }) {
  return (
    <div className="mx-empty mx-error">
      <EmptyState
        icon="alert"
        tone="danger"
        title={title}
        body={<>
          Couldn&rsquo;t reach the metrics service. Your data is unaffected.
          <span className="mx-error-detail">{error}</span>
        </>}
        action={<Button icon="refresh" onClick={onRetry}>Retry</Button>}
      />
    </div>
  );
}

/** Loading placeholder shaped like the page (summary row + table rows). */
function MxSkeleton({ label, rows = 5 }: { label: string; rows?: number }) {
  return (
    <div className="mx-skel">
      <Skeleton lines={rows} label={label} />
    </div>
  );
}

/* ---- whole-body composition (metrics-state.js bodyHtml) ------------------- */
function MxBody({ payload, days, error, onSelectAgent, onRetry }: {
  payload: MxPayload | null; days: number; error: string | null; onSelectAgent: (agentId: string) => void; onRetry: () => void;
}) {
  if (error) return <LoadError title="Metrics are temporarily unavailable" error={error} onRetry={onRetry} />;
  if (!payload) return <MxSkeleton label="Loading metrics" rows={6} />;
  if (!payload.totals || !payload.totals.runs) return <NoRunsState days={payload.days ?? days} />;
  const unreported = costUnreported(payload.totals);
  return (
    <>
      <section className="mx-summary" aria-label="Summary">
        <div className="mx-cards" role="group" aria-label="Summary figures">
          <StatCards d={payload} />
        </div>
        <DailyBars d={payload} />
      </section>
      {/* remount when cost availability flips so the default sort follows it */}
      <AgentSection key={unreported ? "tok" : "cost"} d={payload} onSelect={onSelectAgent} />
    </>
  );
}

/* =========================================================================
 * Agent spend drilldown — GET .../metrics/agents/{aid}/spend?window=5h|7d|all
 * ========================================================================= */

// ONE window vocabulary for the summary and the drilldown (r3): the summary's
// "7 days · 30 days" are both here, so a 30-day summary follows into a 30-day
// drilldown; the drilldown adds the quota-shaped extremes (5 hours, All time).
// The window rides in the URL (&window=) both ways.
const SPEND_WINDOWS: SpendWindow[] = ["5h", "7d", "30d", "all"];
const SPEND_WINDOW_LABEL: Record<SpendWindow, string> = { "5h": "5 hours", "7d": "7 days", "30d": "30 days", all: "All time" };
export const SUMMARY_WINDOWS: SpendWindow[] = ["7d", "30d"];
/** URL `window` → a known window (null for absent / unknown). */
export function parseWindow(raw: string | null | undefined): SpendWindow | null {
  return raw && (SPEND_WINDOWS as string[]).includes(raw) ? (raw as SpendWindow) : null;
}
/** The summary's day count for a window (the aggregate endpoint takes days). */
export function summaryDays(w: SpendWindow | null): 7 | 30 { return w === "30d" ? 30 : 7; }
/** Insights only have 7d / all: 5h → 7d, 30d → all (the card names its window when it differs). */
export function insightsWindowFor(w: SpendWindow): InsightWindow { return w === "5h" || w === "7d" ? "7d" : "all"; }

// Status labels come from the shared STAT map (StatusIcon → statusLabel) — every
// task status (failed, awaiting_human, …) reads as a human label, never an enum.
// D8: the shared glyph set, label in the tooltip + accessible name.
function TaskStatusGlyph({ status }: { status: string | null }) {
  if (!status) {
    return (
      <span className="mx-noglyph" title="Chat and inbox drains that weren't tied to a task">
        {/* a muted chat bubble — never the empty circle, which means "todo" everywhere else */}
        <svg aria-hidden="true" className="mx-noglyph-g" viewBox="0 0 16 16" width="14" height="14" fill="none"
          stroke="currentColor" strokeWidth={1.4} strokeLinecap="round" strokeLinejoin="round">
          <path d="M3 3.5h10a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1H7.5L4.5 14v-2.5H3a1 1 0 0 1-1-1v-6a1 1 0 0 1 1-1Z" />
        </svg>
        <span className="v2-sr">No task</span>
      </span>
    );
  }
  return <StatusIcon status={status} />;
}

function cacheHitPct(row: { input_tokens: number; cache_read_input_tokens: number }): number | null {
  const denom = row.input_tokens + row.cache_read_input_tokens;
  return denom > 0 ? Math.round((row.cache_read_input_tokens / denom) * 1000) / 10 : null;
}

/** Sub-caption for the drilldown Cost tile — mirrors the summary strip's
 *  "n of m runs reported cost" disclosure (unit-tested). */
export function spendCostCaption(t: Pick<SpTotals, "runs" | "total_cost_usd" | "runs_with_cost">): string | null {
  if (!t.runs) return null;
  const st = spendCostState(t);
  if (st === "none") return "no run reported a cost";
  if (st === "full") return null;
  return t.runs_with_cost != null
    ? `partial · ${t.runs_with_cost} of ${t.runs} run${t.runs === 1 ? "" : "s"} reported cost`
    : "partial · some runs reported no cost";
}

/* ---- drilldown totals: compact summary card + token mix ------------------- */
const TOKEN_MIX: { key: keyof SpTotals; label: string; tip: string }[] = [
  { key: "input_tokens", label: "In", tip: "Input tokens" },
  { key: "output_tokens", label: "Out", tip: "Output tokens" },
  { key: "cache_read_input_tokens", label: "Cache read", tip: "Cache-read input tokens" },
  { key: "cache_creation_input_tokens", label: "Cache write", tip: "Cache-creation input tokens" },
];
function SpendTotalsStrip({ t }: { t: SpTotals }) {
  const st = spendCostState(t);
  const costUnknown = t.runs > 0 && st === "none";
  const sub = spendCostCaption(t);
  const costTip = costUnknown ? NOT_REPORTED_TIP
    : st === "partial" ? "Only runs that recorded a dollar cost are summed — the rest are not reported (not $0)."
      : "Recorded dollar cost, separate from tokens";
  const sum = TOKEN_MIX.reduce((m, x) => m + (Number(t[x.key]) || 0), 0);
  return (
    <section className="mx-summary mx-sp-summary" aria-label="Spend totals (tokens and USD)">
      <div className="mx-cards" role="group" aria-label="Spend figures">
        <Stat label="Cost (USD)" value={costUnknown ? "Not reported" : fmtUsd(t.total_cost_usd)} title={costTip}
          sub={sub ? sub.replace(/ reported cost$/, "") : null} subTitle={sub} unknown={costUnknown} />
        <Stat label="Total tokens" value={fmtTokens(t.total_tokens)} title="In + out + cache read + cache write — the quota signal" />
        <Stat label="Runs" value={String(t.runs)} title="Measured runs in this window" />
      </div>
      <div className="mx-mix" role="group" aria-label="Token mix">
        <div className="mx-chart-h"><span className="mx-chart-t">Token mix</span></div>
        {/* part-to-whole: one hue, four steps; the labelled figures below are the legend */}
        {sum > 0 ? (
          <div className="mx-mixbar" aria-hidden="true">
            {TOKEN_MIX.map((x, i) => {
              const v = Number(t[x.key]) || 0;
              return v > 0 ? <span key={x.key} className={"mx-mixseg s" + i} style={{ flexGrow: v }} title={x.tip + " · " + fmtTokens(v)} /> : null;
            })}
          </div>
        ) : null}
        <dl className="mx-mixkv">
          {TOKEN_MIX.map((x, i) => (
            <div key={x.key} title={x.tip}>
              <dt><span className={"mx-mixsw s" + i} aria-hidden="true" />{x.label}</dt>
              <dd>{fmtTokens(t[x.key])}</dd>
            </div>
          ))}
        </dl>
      </div>
    </section>
  );
}

/** Per-row cost honesty for the spend drilldown (unit-tested): "full" when
 *  every run recorded a cost, "partial" when only some did, "none" when no
 *  run did (or the backend cannot say and the sum is 0) — never a fake $0. */
export function spendCostState(row: Pick<SpTotals, "runs" | "total_cost_usd" | "runs_with_cost">): "full" | "partial" | "none" {
  const n = row.runs_with_cost;
  if (n == null) return row.total_cost_usd > 0 ? "partial" : "none"; // older backend: cannot prove completeness
  if (n <= 0) return "none";
  return n >= row.runs ? "full" : "partial";
}
function SpendUsdCell({ row }: { row: SpTotals }) {
  const st = spendCostState(row);
  if (st === "none") return <span className="mx-none" title={NOT_REPORTED_TIP}>{NOT_REPORTED}</span>;
  if (st === "full") return <>{fmtUsd(row.total_cost_usd)}</>;
  const tip = row.runs_with_cost != null
    ? `Only ${row.runs_with_cost} of ${row.runs} runs recorded a cost — the rest are not reported (not $0).`
    : "Recorded cost only — runs that reported no cost are not included (not $0).";
  return <span title={tip}>{fmtUsd(row.total_cost_usd)}<span className="mx-none"> · partial</span></span>;
}

/* ---- drilldown per-task table --------------------------------------------- */
const TASK_SORT: Record<string, (r: SpTaskRow) => number | string> = {
  task: (r) => (r.title || "").toLowerCase(), runs: (r) => r.runs, in: (r) => r.input_tokens, out: (r) => r.output_tokens,
  cached: (r) => r.cache_read_input_tokens + r.cache_creation_input_tokens, total: (r) => r.total_tokens, cost: (r) => r.total_cost_usd,
};
const TASK_COLS = [
  { col: "total", label: "Total tokens" }, { col: "cost", label: "USD" }, { col: "runs", label: "Runs" },
  { col: "in", label: "In" }, { col: "out", label: "Out" }, { col: "cached", label: "Cached" }, { col: "task", label: "Task" },
];
function SpendTaskTable({ tasks, sort, onSort }: { tasks: SpTaskRow[]; sort: SortState; onSort: (col: string) => void }) {
  const rows = sortRows(tasks, TASK_SORT[sort.col] || TASK_SORT.total, sort.dir);
  return (
    <table className="mx-tbl mx-sp-tbl">
      <caption className="v2-sr">Spend by task: tokens by category and recorded cost in USD.</caption>
      <thead>
        <tr>
          <SortTh label="Task" col="task" sort={sort} onSort={onSort} />
          <SortTh label="Runs" col="runs" sort={sort} onSort={onSort} num />
          <SortTh label="In" col="in" sort={sort} onSort={onSort} title="Input tokens" num />
          <SortTh label="Out" col="out" sort={sort} onSort={onSort} title="Output tokens" num />
          <SortTh label="Cached" col="cached" sort={sort} onSort={onSort} title="Cache read + cache write tokens" num />
          <th className="num" title="Cache reads ÷ (input + cache reads)">Cache hit</th>
          <SortTh label="Total" col="total" sort={sort} onSort={onSort} title="All four token categories" num />
          <SortTh label="USD" col="cost" sort={sort} onSort={onSort} title="Recorded cost in US dollars" num />
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => {
          const hit = cacheHitPct(row);
          const cacheTip = fmtTokens(row.cache_read_input_tokens) + " read · "
            + fmtTokens(row.cache_creation_input_tokens) + " write";
          const title = row.title || (row.task_id ? "Untitled task" : "Conversation (no task)");
          return (
            <tr key={row.task_id ?? "__conversation__"}>
              <td className="mx-c-name">
                <span className="mx-task">
                  <TaskStatusGlyph status={row.status} />
                  {row.task_id ? (
                    <Link className="mx-tasklink" to={"/tasks?task=" + encodeURIComponent(row.task_id)} title={title}>
                      {title}
                    </Link>
                  ) : (
                    <span className="mx-conv" title={title}>{title}</span>
                  )}
                </span>
              </td>
              <td className="tnum num" data-label="Runs">{row.runs}</td>
              <td className="tnum num" data-label="In">{fmtTokens(row.input_tokens)}</td>
              <td className="tnum num" data-label="Out">{fmtTokens(row.output_tokens)}</td>
              <td className="tnum num" data-label="Cached" title={cacheTip}>
                {fmtTokens(row.cache_read_input_tokens + row.cache_creation_input_tokens)}
              </td>
              <td className="tnum num" data-label="Cache hit">
                {hit == null
                  ? <span className="mx-none" title="No input tokens were recorded, so there is no cache ratio">n/a</span>
                  : hit + "%"}
              </td>
              <td className="tnum num" data-label="Total"
                title={"In " + fmtTokens(row.input_tokens) + " · Out " + fmtTokens(row.output_tokens) + " · Cached " + cacheTip}>
                {fmtTokens(row.total_tokens)}
              </td>
              <td className="tnum num mx-c-cost"><SpendUsdCell row={row} /></td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function SpendTaskSection({ tasks, runs }: { tasks: SpTaskRow[]; runs: number }) {
  const { sort, onSort, setDir } = useSort({ col: "total", dir: "desc" });
  const n = tasks.length;
  return (
    <section className="mx-sec mx-sec-flush" aria-labelledby="mxTasksH">
      <div className="mx-sec-h"><h2 id="mxTasksH">Spend by task</h2>
        <span className="count" title={n + " row" + (n === 1 ? "" : "s") + " · finished runs with recorded usage"}>{n}</span>
        {runs > 0 ? <SortPill cols={TASK_COLS} sort={sort} onSort={onSort} setDir={setDir} label="Sort tasks" /> : null}
      </div>
      {runs === 0 ? (
        <p className="mx-quiet">
          <b>No measured runs in this window.</b> Try a wider window.
        </p>
      ) : (
        <div className="mx-scroll">
          <SpendTaskTable tasks={tasks} sort={sort} onSort={onSort} />
        </div>
      )}
    </section>
  );
}

/* ---- "how to reduce spending" insights card -------------------------------- */
const SEV_TONE: Record<Insight["severity"], "danger" | "warn" | "neutral"> = {
  high: "danger", medium: "warn", info: "neutral",
};
// severity is never colour-only
const SEV_LABEL: Record<Insight["severity"], string> = { high: "High", medium: "Medium", info: "Info" };

/** Evidence → readable "Label value" chips (never "[object Object]"): ratios
 *  read as percents, token/cost keys use the page formatters; nested values are
 *  split out into a collapsible raw block. Unit-tested. */
// M11: the backend's evidence keys → short labels. Ids and the task title are
// never chips (the insight's text names the task; "Open task" links to it).
const EVIDENCE_LABEL: Record<string, string> = {
  agent_alias: "Agent",
  agent: "Agent",
  cache_read_input_tokens: "Cache reads",
  cache_creation_input_tokens: "Cache writes",
  tiny_runs: "Tiny runs",
  total_runs: "Runs",
  tiny_fraction: "Tiny share",
  median_output_tokens: "Median output",
  task_cost_usd: "Task cost",
  window_cost_usd: "Window total",
  fraction: "Share of spend",
  read_to_creation_ratio: "Reads per write",
  total_cost_usd: "Total cost",
};
const EVIDENCE_HIDDEN = new Set(["task", "task_id", "task_title", "agent_id"]);

export function fmtEvidence(evidence: Record<string, unknown> | null | undefined): { items: string[]; nested: Record<string, unknown> | null } {
  const items: string[] = [];
  const nested: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(evidence || {})) {
    if (v === null || v === undefined || v === "") continue;
    if (EVIDENCE_HIDDEN.has(k)) continue;
    if (typeof v === "object") { nested[k] = v; continue; }
    const mapped = EVIDENCE_LABEL[k];
    let label = mapped || humanizeKey(k).replace(/ usd$/i, "");
    let val: string;
    if (typeof v === "number") {
      if (k === "read_to_creation_ratio") {
        val = Math.round(v * 10) / 10 + "×";
      } else if (/(_ratio|^ratio|fraction|_share)$/.test(k) && v >= 0 && v <= 1) {
        val = Math.round(v * 1000) / 10 + "%";
        if (!mapped) label = label.replace(/ ratio$| fraction$/i, "") || label;
      } else if (/_pct$|_percent$/.test(k)) {
        val = v + "%";
        label = label.replace(/ pct$| percent$/i, "");
      } else if (/(^|_)usd$|^cost$|cost_usd/.test(k)) val = fmtUsd(v);
      else if (/tokens/.test(k)) val = fmtTokens(v);
      else if (/seconds$/.test(k)) val = fmtDuration(v);
      else val = Number.isInteger(v) ? v.toLocaleString("en-US") : String(Math.round(v * 100) / 100);
    } else if (typeof v === "boolean") val = v ? "yes" : "no";
    else val = String(v);
    items.push(label + " " + val);
  }
  return { items, nested: Object.keys(nested).length ? nested : null };
}

/** Where an insight's action can be taken — a deep link, when one exists. */
export function insightLink(i: Pick<Insight, "id" | "action" | "evidence">): { to: string; label: string } | null {
  const [kind, ref] = String(i.id || "").split(":");
  const ev = i.evidence || {};
  const alias = (ev.agent_alias ?? ev.agent) as string | undefined;
  if (/Models? (&|and) providers/i.test(i.action || "")) return { to: "/settings#tab=provider-keys", label: "Open Models & providers" };
  if (kind === "context-bloat" && ref) return { to: "/tasks?task=" + encodeURIComponent(ref), label: "Open task" };
  if (typeof ev.task_id === "string" && ev.task_id) return { to: "/tasks?task=" + encodeURIComponent(ev.task_id), label: "Open task" };
  if (typeof alias === "string" && alias && (/agent/i.test(i.action || "") || ["cold-context", "wake-churn", "heavy-model-small-talk", "subscription-loop"].includes(kind))) {
    return { to: "/agents?agent=" + encodeURIComponent(alias), label: "Open " + alias };
  }
  return null;
}

/** Insight kinds scoped to ONE agent (their id is "<kind>:<agent_id>"). */
const AGENT_INSIGHT_KINDS = new Set(["cold-context", "wake-churn", "heavy-model-small-talk", "subscription-loop"]);

/**
 * The insights that concern ONE agent (pure, tested) — the drilldown must not
 * list suggestions about other agents or the whole window. Agent-scoped rules
 * match by id / evidence alias; task-scoped rules (context-bloat,
 * concentration) match when the task is one this agent spent on in the window;
 * window-wide rules (cache-write-churn) stay on the project summary.
 */
export function insightsForAgent(
  insights: Insight[] | null, agentId: string, alias: string | null | undefined, taskIds: (string | null | undefined)[],
): Insight[] | null {
  if (!insights) return insights;
  const tasks = new Set(taskIds.filter(Boolean).map(String));
  return insights.filter((i) => {
    const [kind, ref] = String(i.id || "").split(":");
    const ev = i.evidence || {};
    if (AGENT_INSIGHT_KINDS.has(kind)) {
      const evAlias = (ev.agent_alias ?? ev.agent) as unknown;
      return (!!ref && ref === String(agentId)) || (!!alias && evAlias === alias);
    }
    const tid = typeof ev.task_id === "string" ? ev.task_id : kind === "context-bloat" || kind === "concentration" ? ref : null;
    return !!tid && tasks.has(tid);
  });
}

function InsightRow({ i }: { i: Insight }) {
  const { items, nested } = fmtEvidence(i.evidence);
  const link = insightLink(i);
  return (
    <li className="mx-insight" data-severity={i.severity}>
      <div className="mx-insight-top">
        <Chip size="sm" dot={SEV_TONE[i.severity]} className="mx-sev">{SEV_LABEL[i.severity]}</Chip>
        <span className="mx-insight-title">{i.title}</span>
        {link ? <ButtonLink to={link.to} variant="ghost" size="sm" iconRight="arrow" className="mx-insight-go">{link.label}</ButtonLink> : null}
      </div>
      <div className="mx-insight-detail">{i.detail}</div>
      <div className="mx-insight-action"><span className="mx-insight-k">Suggested</span>{i.action}</div>
      {items.length ? (
        <ul className="mx-insight-evidence" aria-label="Evidence">
          {items.map((t) => <li key={t}><Chip size="sm">{t}</Chip></li>)}
        </ul>
      ) : null}
      {nested ? <RawPayload value={nested} label="More evidence" /> : null}
    </li>
  );
}
function InsightsCard({ insights, window, differs, loading, error, onRetry, empty }: {
  insights: Insight[] | null; window: InsightWindow; differs: boolean; loading: boolean; error: string | null; onRetry: () => void;
  /** what an empty list says (the drilldown names the agent + links the project summary) */
  empty?: ReactNode;
}) {
  const scope = window === "7d" ? "last 7 days" : "all time";
  return (
    <section className="mx-sec" aria-labelledby="mxInsH">
      <div className="mx-sec-h">
        <h2 id="mxInsH" title={"Rule-based suggestions (no AI) · " + scope}>How to reduce spending</h2>
        {/* the window only needs saying when it differs from the pill above (5 hours → 7 days) */}
        {differs ? <span className="count" title="Insights need at least 7 days of signal">{scope}</span> : null}
      </div>
      <div>
        {error ? (
          <div className="mx-inline-err" role="alert">
            <span>Insights are temporarily unavailable <span className="mx-error-detail">{error}</span></span>
            <Button size="sm" icon="refresh" onClick={onRetry}>Retry</Button>
          </div>
        ) : loading || insights == null ? (
          <MxSkeleton label="Loading insights" rows={3} />
        ) : insights.length === 0 ? (
          empty ?? (
            <p className="mx-quiet" title="Each rule needs a few runs of real signal before it speaks up.">
              No insights yet.
            </p>
          )
        ) : (
          <ul className="mx-insights">
            {insights.map((i) => <InsightRow key={i.id} i={i} />)}
          </ul>
        )}
      </div>
    </section>
  );
}

const NO_30D = "window 30d unsupported";
const ACCESS_DENIED = "access denied";

/** An "HTTP <status>" error that keeps the status, so a 401/403 can be told apart. */
function httpError(status: number): Error & { status: number } {
  return Object.assign(new Error("HTTP " + status), { status });
}
const NOT_FOUND = "agent not found";

/** GET …/metrics/insights for one window (shared by the summary and the drilldown). */
function useInsights(cid: string | null | undefined, window: InsightWindow) {
  const [insights, setInsights] = useState<Insight[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [attempt, setAttempt] = useState(0);
  const [denied, setDenied] = useState(false);
  useEffect(() => {
    if (!cid) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetch(`/api/containers/${encodeURIComponent(cid)}/metrics/insights?window=${window}`)
      .then((r) => { if (!r.ok) throw httpError(r.status); return r.json() as Promise<InsightsPayload>; })
      .then((data) => { if (!cancelled) { setInsights(data.insights); setDenied(false); setLoading(false); } })
      .catch((e) => {
        if (cancelled) return;
        // 401/403 (not a member): the shell already says so — hide, never a useless Retry (AP-30)
        if (isAccessDenied(e)) setDenied(true);
        else setError(e instanceof Error ? e.message : String(e));
        setLoading(false);
      });
    return () => { cancelled = true; };
  }, [cid, window, attempt]);
  return { insights, error, loading, denied, retry: () => setAttempt((n) => n + 1) };
}

/* ---- drilldown page body ---------------------------------------------------- */
function AgentSpendDrilldown({ cid, agentId, onBack, shell, window: window_, onWindow, known }: {
  cid: string; agentId: string; onBack: () => void;
  /** the agent is in this project's roster or metrics rows (a stale link otherwise) */
  known: boolean;
  /** the spend window — owned by the URL (&window=), carried from the summary */
  window: SpendWindow; onWindow: (w: SpendWindow) => void;
  /** Shell framing (page/title/ctx/crumbs) — the drilldown owns its own toolbar (spend window). */
  shell: { ctx?: string; crumb: string };
}) {
  const modelName = useModelName();
  const [payload, setPayload] = useState<SpPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [spendTry, setSpendTry] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setPayload(null);
    setError(null);
    fetch(`/api/containers/${encodeURIComponent(cid)}/metrics/agents/${encodeURIComponent(agentId)}/spend?window=${window_}`)
      .then((r) => {
        // an older server only knows 5h / 7d / all: say so plainly instead of a generic failure
        if (r.status === 422 && window_ === "30d") throw new Error(NO_30D);
        // agent_spend_routes: 404 = no such agent in this project, 400 = not an agent id
        if (r.status === 404 || r.status === 400) throw new Error(NOT_FOUND);
        if (isAccessDenied(r)) throw new Error(ACCESS_DENIED);
        if (!r.ok) throw new Error("HTTP " + r.status);
        return r.json() as Promise<SpPayload>;
      })
      .then((data) => {
        if (cancelled) return;
        // never paint a fabricated page: an answer with no agent name for an
        // id the project doesn't know is a stale link, not "$0.00 · 0 runs"
        if (!data?.agent?.alias && !known) { setError(NOT_FOUND); return; }
        setPayload(data);
      })
      .catch((e) => { if (!cancelled) setError(e instanceof Error ? e.message : String(e)); });
    return () => { cancelled = true; };
  }, [cid, agentId, window_, spendTry, known]);

  const insightsWindow: InsightWindow = insightsWindowFor(window_);
  const { insights, error: insightsError, loading: insightsLoading, denied: insightsDenied, retry: retryInsights } = useInsights(cid, insightsWindow);

  const toolbar = (
    <PageToolbar label="Spend filters" end={<CostInfo />}>
      <IconButton icon="arrow-left" variant="outline" label="Back to metrics" onClick={onBack} className="mx-back" />
      <FilterPills
        label="Spend window"
        className="mx-range"
        value={window_}
        onChange={(k) => onWindow(k as SpendWindow)}
        items={SPEND_WINDOWS.map((w) => ({ key: w, label: SPEND_WINDOW_LABEL[w] }))}
      />
    </PageToolbar>
  );

  return (
    <Shell page="metrics" title="Metrics" ctx={shell.ctx} crumbs={[{ label: shell.crumb }]} toolbar={toolbar} flush>
      <div className="mx-wrap">
        {error === NOT_FOUND ? (
          <div className="mx-empty mx-error" id="mxAgentNotFound">
            <EmptyState
              icon="person"
              title="Agent not found"
              body="This agent isn’t in this project — it may have been removed, or the link is out of date."
              action={<Button icon="arrow-left" onClick={onBack}>All agents</Button>}
            />
          </div>
        ) : error === NO_30D ? (
          <div className="mx-empty mx-error">
            <EmptyState
              icon="clock"
              title="30-day spend detail isn’t available on this server yet"
              body="Update Embodent to break an agent’s spend down by 30 days, or pick another window."
              action={<Button onClick={() => onWindow("7d")}>Show 7 days</Button>}
            />
          </div>
        ) : error === ACCESS_DENIED ? (
          null /* not a member: the shell's single not-a-member line is the whole story */
        ) : error ? (
          <LoadError title="Spend detail is temporarily unavailable" error={error} onRetry={() => setSpendTry((n) => n + 1)} />
        ) : !payload ? (
          <MxSkeleton label="Loading spend detail" rows={6} />
        ) : (
          <>
            <PageHeader
              className="mx-sp-head"
              glyph={<Avatar alias={payload.agent.alias} kind="ai" size={32} decorative />}
              title={payload.agent.alias || "Agent"}
              trailing={
                <span className="mx-sp-chips">
                  {payload.agent.model
                    ? <Chip size="sm" className="mx-model-chip" title={"Model · " + payload.agent.model}>{modelName(payload.agent.model) || payload.agent.model}</Chip>
                    : <span className="mx-none" title={MODEL_UNKNOWN_TIP}>Model not recorded</span>}
                  {payload.agent.reasoning_effort ? <span className="mx-sub">{payload.agent.reasoning_effort} effort</span> : null}
                </span>
              }
            />

            <SpendTotalsStrip t={payload.totals} />

            {/* this agent's monthly budget vs month-to-date spend (hidden when none is set) */}
            <BudgetBars cid={cid} agentId={agentId} />

            <SpendTaskSection tasks={payload.tasks} runs={payload.totals.runs} />

            {insightsDenied ? null : <InsightsCard
              insights={insightsForAgent(insights, agentId, payload.agent.alias, payload.tasks.map((t) => t.task_id))}
              window={insightsWindow} differs={insightsWindow !== window_} loading={insightsLoading} error={insightsError}
              onRetry={retryInsights}
              empty={insights && insights.length > 0 ? (
                <p className="mx-quiet" id="mxInsEmptyAgent">
                  No suggestions for {payload.agent.alias || "this agent"}.{" "}
                  <button type="button" className="mx-link" onClick={onBack}>See the project summary</button>
                </p>
              ) : undefined}
            />}
          </>
        )}
      </div>
    </Shell>
  );
}

const COST_EXPLAINER = "Usage and estimated spend per agent — runs, sandbox compute, tokens and cost, parsed from each run's recorded usage. Dollar figures are estimates: only runs whose worker reported cost contribute (the caption says how many did); runs that reported no cost are shown as “not reported”, never as $0.";

function CostInfo({ scope }: { scope?: string }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLButtonElement | null>(null);
  return (
    <>
      <IconButton
        ref={ref}
        icon="info"
        variant="outline"
        label="How cost is estimated"
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => setOpen((o) => !o)}
      />
      <Popover anchor={ref} open={open} onClose={() => setOpen(false)} role="dialog" label="How cost is estimated" className="mx-info-pop">
        <div className="mx-info-t">How cost is estimated</div>
        {scope ? <p className="mx-info-scope">{scope}</p> : null}
        <p>{COST_EXPLAINER}</p>
      </Popover>
    </>
  );
}
export function MetricsPage() {
  const { snap, cid } = useSnapshot();
  const location = useLocation();
  const navigate = useNavigate();
  const [payload, setPayload] = useState<MxPayload | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  // 401/403 on the metrics read = not a member: the shell already says so once (AP-30)
  const [denied, setDenied] = useState(false);
  const reqTok = useRef(0);
  const havePayload = useRef(false);
  havePayload.current = payload != null;

  // drilldown selection AND the window are deep-linkable:
  // `/metrics?window=30d`, `/metrics?agent=<id>&window=30d` (other params kept).
  const params = useMemo(() => new URLSearchParams(location.search), [location.search]);
  const selectedAgent = params.get("agent");
  const urlWindow = parseWindow(params.get("window"));
  const days = summaryDays(urlWindow);
  const go = (patch: Record<string, string | null>, replace = false) => {
    const next = new URLSearchParams(location.search);
    for (const [k, v] of Object.entries(patch)) { if (v == null) next.delete(k); else next.set(k, v); }
    const q = next.toString();
    navigate("/metrics" + (q ? "?" + q : ""), { replace });
  };
  // the summary's window is carried into the drilldown (7 days → 7 days, 30 days → 30 days)
  const selectAgent = (agentId: string) => go({ agent: agentId, window: days === 30 ? "30d" : "7d" });
  // …and back: a 7/30-day drilldown window returns to that summary; 5 hours / All time → the 7-day default
  const backToMetrics = () => go({ agent: null, window: urlWindow === "30d" ? "30d" : null });

  // Request token (QA): only the LATEST request may apply. The old in-flight
  // guard dropped a 30-day request issued while a 7-day one was loading, so the
  // 7-day payload then rendered under "last 30 days".
  const load = useCallback(async (id: string, d: number) => {
    const my = ++reqTok.current;
    try {
      const r = await fetch("/api/containers/" + encodeURIComponent(id) + "/metrics?days=" + d);
      if (!r.ok) throw httpError(r.status);
      const data = (await r.json()) as MxPayload;
      if (my !== reqTok.current) return;
      setPayload(data);
      setLoadError(null);
      setDenied(false);
    } catch (e) {
      if (my !== reqTok.current) return;
      if (isAccessDenied(e as { status?: number })) { setDenied(true); setLoadError(null); return; }
      // keep showing the last good payload; only surface the error cold
      if (!havePayload.current) setLoadError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  // load on cid arrival + range change; refresh on a 60s timer (never the 3s tick).
  // Paused while the drilldown is open — it's a different fetch cadence entirely.
  useEffect(() => {
    if (!cid || selectedAgent) return;
    void load(cid, days);
    const iv = setInterval(() => void load(cid, days), 60000);
    return () => clearInterval(iv);
  }, [cid, days, load, selectedAgent]);

  const toggle = (next: number) => {
    if (!next || next === days) return;
    go({ window: next === 30 ? "30d" : null }, true);
    setPayload(null); // stale window — show Loading, not old numbers
    setLoadError(null);
  };
  const retry = () => {
    if (!cid) return;
    setLoadError(null);
    void load(cid, days);
  };

  const projectName = snap?.container?.name || "this project";
  // hooks run before the drilldown's early return; no fetch while it is open
  const summaryInsWindow: InsightWindow = days === 30 ? "all" : "7d";
  const summaryInsights = useInsights(selectedAgent ? null : cid, summaryInsWindow);
  const knownAlias = selectedAgent
    ? (snap?.agents ?? []).find((a) => String(a.id) === String(selectedAgent))?.alias
      || payload?.per_agent.find((a) => a.agent_id === selectedAgent)?.alias || null
    : null;
  const agentKnown = !!knownAlias;
  const agentAlias = selectedAgent ? knownAlias || "Agent" : null;

  if (selectedAgent && cid) {
    return (
      <AgentSpendDrilldown
        key={selectedAgent}
        cid={cid}
        agentId={selectedAgent}
        onBack={backToMetrics}
        window={urlWindow ?? "all"}
        onWindow={(w) => go({ window: w }, true)}
        known={agentKnown}
        shell={{ ctx: snap?.container?.name, crumb: agentAlias || "Agent" }}
      />
    );
  }

  const toolbar = (
    <PageToolbar label="Metrics filters" end={<CostInfo scope={`${projectName} · all agents with runs · UTC calendar days`} />}>
      <FilterPills
        label="Metrics window"
        className="mx-range"
        value={String(days)}
        onChange={(k) => toggle(Number(k))}
        items={[7, 30].map((d) => ({ key: String(d), label: d + " days" }))}
      />
    </PageToolbar>
  );

  return (
    <Shell page="metrics" title="Metrics" ctx={snap?.container?.name} toolbar={toolbar} flush>
      <div className="mx-wrap">
        {/* D12: the project (header) and window (pill) are already on screen —
            the full scope stays for assistive tech and in the ⓘ popover */}
        <p className="v2-sr" id="mxScope">
          {projectName} · all agents with runs · last {payload?.days ?? days} days (UTC calendar days)
        </p>
        <div id="mxBody" className="mx-body">
          {denied ? null : <MxBody payload={payload} days={days} error={loadError} onSelectAgent={selectAgent} onRetry={retry} />}
        </div>
        {/* monthly budgets: spend vs budget per agent + the optional project cap (UTC month) */}
        {cid ? <PerformanceSection cid={cid} defaultRange={days === 30 ? "30d" : "7d"} /> : null}
        {cid ? <BudgetBars cid={cid} /> : null}
        {/* the project-wide suggestions (every agent, task and window rule) — the
            drilldown shows only its agent's, and links back here for the rest */}
        {denied || summaryInsights.denied ? null : (
          <InsightsCard
            insights={summaryInsights.insights}
            window={summaryInsWindow} differs={summaryInsWindow === "all"}
            loading={summaryInsights.loading} error={summaryInsights.error} onRetry={summaryInsights.retry}
          />
        )}
      </div>
    </Shell>
  );
}
