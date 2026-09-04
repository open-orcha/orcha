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
 */
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { Shell } from "../../shell/Shell";
import { Avatar } from "../../components/ui";
import { useSnapshot } from "../../state/SnapshotProvider";
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
}
export interface MxPayload {
  days: number;
  totals: MxTotals;
  daily: MxDay[];
  per_agent: MxAgent[];
}

/* ---- spend drilldown payload shape (agent_spend_routes) ------------------ */
export type SpendWindow = "5h" | "7d" | "all";
export interface SpTotals {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
  total_tokens: number;
  total_cost_usd: number;
  runs: number;
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
export function costCaption(totals: MxTotals): string {
  const n = totals.runs_with_cost || 0, m = totals.runs || 0;
  if (!m) return "no runs in this window";
  return "estimated · " + n + " of " + m + " run" + (m === 1 ? "" : "s") + " reported cost";
}

/* ---- stat cards (KPI row) ------------------------------------------------ */
function StatCards({ d }: { d: MxPayload }) {
  const t = d.totals;
  const tile = (label: string, value: string, sub: string) => (
    <div className="card mx-tile">
      <div className="l">{label}</div>
      <div className="v">{value}</div>
      <div className="s">{sub}</div>
    </div>
  );
  return (
    <>
      {tile("Est. cost", fmtUsd(t.est_cost_usd), costCaption(t))}
      {tile("Runs", String(t.runs), "last " + String(d.days) + " days")}
      {tile("Sandbox compute", fmtDuration(t.sandbox_seconds), "container wall-clock")}
      {tile("Tasks", String(t.tasks_completed) + " done", String(t.tasks_verified) + " human-verified")}
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
    <>
      <div className="mx-spark" role="img" aria-label={`Runs per day over the last ${d.days} days`}>
        {days.map((x, i) => {
          const pct = max ? Math.round((x.runs / max) * 100) : 0;
          const tip = fmtDay(x.date) + " · " + x.runs + " run" + (x.runs === 1 ? "" : "s")
            + " · " + fmtUsd(x.est_cost_usd);
          return (
            <div key={i} className="mx-col" title={tip}>
              {x.runs ? <div className="mx-bar" style={{ height: pct + "%" }} /> : null}
            </div>
          );
        })}
      </div>
      <div className="mx-spark-x"><span>{first}</span><span>{last}</span></div>
    </>
  );
}

/* ---- per-agent table (rows open the spend drilldown) ---------------------- */
function AgentTable({ d, onSelect }: { d: MxPayload; onSelect: (agentId: string) => void }) {
  const rows = d.per_agent || [];
  const maxCost = rows.reduce((m, a) => Math.max(m, a.est_cost_usd), 0);
  return (
    <table className="tbl mx-tbl">
      <thead>
        <tr><th>Agent</th><th>Model</th><th>Runs</th><th>Compute</th><th>Tokens</th><th>Est. cost</th></tr>
      </thead>
      <tbody>
        {rows.map((a) => {
          const pct = maxCost ? Math.max(2, Math.round((a.est_cost_usd / maxCost) * 100)) : 0;
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
              <td>
                <span className="mx-agent">
                  <Avatar alias={a.alias} kind="ai" size="sm" />
                  <span className="nm">{a.alias || "?"}</span>
                </span>
              </td>
              <td>{a.model ? <span className="tag model">{a.model}</span> : <span className="mx-none">—</span>}</td>
              <td className="tnum">
                {a.runs}
                <span className="mx-sub"> {a.ok_runs} ok{a.failed_runs ? <> · <span className="bad">{a.failed_runs} failed</span></> : null}</span>
              </td>
              <td className="tnum">{fmtDuration(a.sandbox_seconds)}</td>
              <td className="tnum">{fmtTokens(a.tokens_in)} in · {fmtTokens(a.tokens_out)} out</td>
              <td className="mx-cost tnum">
                <span className="mx-costbar" style={{ "--w": pct + "%" } as CSSProperties} />
                <span className="v">{fmtUsd(a.est_cost_usd)}</span>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

/* ---- honest empty state --------------------------------------------------- */
function EmptyState({ days }: { days: number }) {
  return (
    <div className="card mx-empty">
      <div className="t1">No agent runs in the last {days} days</div>
      <div className="t2">Metrics fill in as agents wake and work — cost and token figures
        come from each run's recorded usage, so a quiet window is honestly empty
        rather than estimated.</div>
    </div>
  );
}

/* ---- whole-body composition (metrics-state.js bodyHtml) ------------------- */
function MxBody({ payload, days, error, onSelectAgent }: {
  payload: MxPayload | null; days: number; error: string | null; onSelectAgent: (agentId: string) => void;
}) {
  if (error) {
    return (
      <div className="card mx-empty"><div className="t1">Couldn’t load metrics</div>
        <div className="t2">{error}</div></div>
    );
  }
  if (!payload) return <div className="card mx-empty"><div className="t2">Loading…</div></div>;
  if (!payload.totals || !payload.totals.runs) return <EmptyState days={payload.days ?? days} />;
  return (
    <>
      <div className="mx-cards"><StatCards d={payload} /></div>
      <div className="card">
        <div className="card-h"><h2>Daily activity</h2>
          <span className="count">{payload.totals.runs} runs</span></div>
        <div className="card-b"><DailyBars d={payload} /></div>
      </div>
      <div className="card">
        <div className="card-h"><h2>Cost &amp; activity by agent</h2>
          <span className="count">{costCaption(payload.totals)}</span></div>
        <div className="card-b flush" style={{ overflowX: "auto" }}>
          <AgentTable d={payload} onSelect={onSelectAgent} />
        </div>
      </div>
    </>
  );
}

/* =========================================================================
 * Agent spend drilldown — GET .../metrics/agents/{aid}/spend?window=5h|7d|all
 * ========================================================================= */

const SPEND_WINDOWS: SpendWindow[] = ["5h", "7d", "all"];
const SPEND_WINDOW_LABEL: Record<SpendWindow, string> = { "5h": "5h", "7d": "7d", all: "All time" };

const TASK_STAT_LABEL: Record<string, string> = {
  pending: "Pending", ready: "Ready", in_progress: "In progress", blocked: "Blocked",
  needs_verification: "Needs verify", completed: "Completed", cancelled: "Cancelled",
};
const TASK_STAT_CLASS: Record<string, string> = {
  pending: "s-idle", ready: "s-ready", in_progress: "s-working", blocked: "s-bad",
  needs_verification: "s-attn", completed: "s-done", cancelled: "s-idle",
};
function TaskStatusPill({ status }: { status: string | null }) {
  if (!status) return <span className="mx-none">—</span>;
  const cls = TASK_STAT_CLASS[status] || "s-idle";
  return <span className={"pill " + cls}>{TASK_STAT_LABEL[status] || status}</span>;
}

function cacheHitPct(row: { input_tokens: number; cache_read_input_tokens: number }): number | null {
  const denom = row.input_tokens + row.cache_read_input_tokens;
  return denom > 0 ? Math.round((row.cache_read_input_tokens / denom) * 1000) / 10 : null;
}

/* ---- drilldown totals strip ------------------------------------------------ */
function SpendTotalsStrip({ t }: { t: SpTotals }) {
  const tile = (label: string, value: string) => (
    <div className="card mx-tile mx-sp-tile">
      <div className="l">{label}</div>
      <div className="v">{value}</div>
    </div>
  );
  return (
    <div className="mx-cards mx-sp-strip">
      {tile("In", fmtTokens(t.input_tokens))}
      {tile("Out", fmtTokens(t.output_tokens))}
      {tile("Cache read", fmtTokens(t.cache_read_input_tokens))}
      {tile("Cache write", fmtTokens(t.cache_creation_input_tokens))}
      {tile("Total tokens", fmtTokens(t.total_tokens))}
      {tile("Cost", fmtUsd(t.total_cost_usd))}
      {tile("Runs", String(t.runs))}
    </div>
  );
}

/* ---- drilldown per-task table --------------------------------------------- */
function SpendTaskTable({ tasks }: { tasks: SpTaskRow[] }) {
  return (
    <table className="tbl mx-tbl mx-sp-tbl">
      <thead>
        <tr>
          <th>Task</th><th>Status</th><th>Runs</th><th>In</th><th>Out</th>
          <th>Cached</th><th>Cache-hit</th><th>Total</th><th>$</th>
        </tr>
      </thead>
      <tbody>
        {tasks.map((row) => {
          const hit = cacheHitPct(row);
          const cacheTip = fmtTokens(row.cache_read_input_tokens) + " read · "
            + fmtTokens(row.cache_creation_input_tokens) + " write";
          return (
            <tr key={row.task_id ?? "__conversation__"}>
              <td>
                {row.task_id ? (
                  <a className="dlink" href={"/tasks?task=" + encodeURIComponent(row.task_id)}>
                    {row.title || "Untitled task"}
                  </a>
                ) : (
                  <span className="mx-none">{row.title}</span>
                )}
              </td>
              <td><TaskStatusPill status={row.status} /></td>
              <td className="tnum">{row.runs}</td>
              <td className="tnum">{fmtTokens(row.input_tokens)}</td>
              <td className="tnum">{fmtTokens(row.output_tokens)}</td>
              <td className="tnum" title={cacheTip}>
                {fmtTokens(row.cache_read_input_tokens + row.cache_creation_input_tokens)}
              </td>
              <td className="tnum">{hit == null ? <span className="mx-none">—</span> : hit + "%"}</td>
              <td className="tnum">{fmtTokens(row.total_tokens)}</td>
              <td className="tnum">{fmtUsd(row.total_cost_usd)}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

/* ---- "how to reduce spending" insights card -------------------------------- */
const SEV_DOT_CLASS: Record<Insight["severity"], string> = {
  high: "s-bad", medium: "s-attn", info: "s-idle",
};
function InsightRow({ i }: { i: Insight }) {
  const evidenceText = Object.entries(i.evidence)
    .filter(([, v]) => v !== null && v !== undefined)
    .map(([k, v]) => k.replace(/_/g, " ") + ": " + String(v))
    .join(" · ");
  return (
    <div className="mx-insight" data-severity={i.severity}>
      <span className={"mx-insight-dot " + SEV_DOT_CLASS[i.severity]} aria-hidden="true" />
      <div className="mx-insight-body">
        <div className="mx-insight-title">{i.title}</div>
        <div className="mx-insight-detail">{i.detail}</div>
        {evidenceText ? <div className="mx-insight-evidence">{evidenceText}</div> : null}
        <div className="mx-insight-action">{i.action}</div>
      </div>
    </div>
  );
}
function InsightsCard({ insights, window, loading, error }: {
  insights: Insight[] | null; window: InsightWindow; loading: boolean; error: string | null;
}) {
  return (
    <div className="card">
      <div className="card-h"><h2>How to reduce spending</h2>
        <span className="count">{window === "7d" ? "last 7 days" : "all time"}</span></div>
      <div className="card-b">
        {error ? (
          <div className="mx-empty"><div className="t2">Couldn’t load insights: {error}</div></div>
        ) : loading || insights == null ? (
          <div className="mx-empty"><div className="t2">Loading…</div></div>
        ) : insights.length === 0 ? (
          <div className="mx-empty">
            <div className="t2">No insights yet — each rule needs a few runs of real
              signal before it will speak up, so a quiet or healthy window is honestly quiet.</div>
          </div>
        ) : (
          <div className="mx-insights">
            {insights.map((i) => <InsightRow key={i.id} i={i} />)}
          </div>
        )}
      </div>
    </div>
  );
}

/* ---- drilldown page body ---------------------------------------------------- */
function AgentSpendDrilldown({ cid, agentId, onBack }: { cid: string; agentId: string; onBack: () => void }) {
  const [window_, setWindow] = useState<SpendWindow>("all");
  const [payload, setPayload] = useState<SpPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [insights, setInsights] = useState<Insight[] | null>(null);
  const [insightsError, setInsightsError] = useState<string | null>(null);
  const [insightsLoading, setInsightsLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setPayload(null);
    setError(null);
    fetch(`/api/containers/${encodeURIComponent(cid)}/metrics/agents/${encodeURIComponent(agentId)}/spend?window=${window_}`)
      .then((r) => { if (!r.ok) throw new Error("HTTP " + r.status); return r.json() as Promise<SpPayload>; })
      .then((data) => { if (!cancelled) setPayload(data); })
      .catch((e) => { if (!cancelled) setError(e instanceof Error ? e.message : String(e)); });
    return () => { cancelled = true; };
  }, [cid, agentId, window_]);

  const insightsWindow: InsightWindow = window_ === "5h" ? "7d" : window_;
  useEffect(() => {
    let cancelled = false;
    setInsightsLoading(true);
    setInsightsError(null);
    fetch(`/api/containers/${encodeURIComponent(cid)}/metrics/insights?window=${insightsWindow}`)
      .then((r) => { if (!r.ok) throw new Error("HTTP " + r.status); return r.json() as Promise<InsightsPayload>; })
      .then((data) => { if (!cancelled) { setInsights(data.insights); setInsightsLoading(false); } })
      .catch((e) => {
        if (!cancelled) { setInsightsError(e instanceof Error ? e.message : String(e)); setInsightsLoading(false); }
      });
    return () => { cancelled = true; };
  }, [cid, insightsWindow]);

  return (
    <div className="mx-wrap">
      <button type="button" className="cs-thread-back" onClick={onBack}>&larr; Back to metrics</button>
      {error ? (
        <div className="card mx-empty"><div className="t1">Couldn’t load spend detail</div>
          <div className="t2">{error}</div></div>
      ) : !payload ? (
        <div className="card mx-empty"><div className="t2">Loading…</div></div>
      ) : (
        <>
          <div className="mx-head mx-sp-head">
            <div className="mx-agent mx-sp-agenthead">
              <Avatar alias={payload.agent.alias} kind="ai" />
              <div>
                <h1>{payload.agent.alias || "Agent"}</h1>
                <div className="mx-sp-chips">
                  {payload.agent.model ? <span className="tag model">{payload.agent.model}</span> : null}
                  {payload.agent.reasoning_effort ? <span className="tag">{payload.agent.reasoning_effort} effort</span> : null}
                </div>
              </div>
            </div>
            <div className="grow" />
            <nav className="aut" role="radiogroup" aria-label="Spend window">
              {SPEND_WINDOWS.map((w) => (
                <span
                  key={w}
                  className={"seg" + (window_ === w ? " on" : "")}
                  role="radio"
                  tabIndex={0}
                  aria-selected={window_ === w}
                  onClick={() => setWindow(w)}
                  onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setWindow(w); } }}
                >
                  {SPEND_WINDOW_LABEL[w]}
                </span>
              ))}
            </nav>
          </div>

          <SpendTotalsStrip t={payload.totals} />

          <div className="card">
            <div className="card-h"><h2>Spend by task</h2>
              <span className="count">{payload.tasks.length} row{payload.tasks.length === 1 ? "" : "s"}</span></div>
            <div className="card-b flush" style={{ overflowX: "auto" }}>
              {payload.totals.runs === 0 ? (
                <div className="mx-empty">
                  <div className="t1">No measured runs in this window</div>
                  <div className="t2">This agent hasn’t recorded any usage in the selected window —
                    try a wider window, or check back after its next wake.</div>
                </div>
              ) : (
                <SpendTaskTable tasks={payload.tasks} />
              )}
            </div>
          </div>

          <InsightsCard insights={insights} window={insightsWindow} loading={insightsLoading} error={insightsError} />
        </>
      )}
    </div>
  );
}

export function MetricsPage() {
  const { snap, cid } = useSnapshot();
  const location = useLocation();
  const navigate = useNavigate();
  const [days, setDays] = useState(7);
  const [payload, setPayload] = useState<MxPayload | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const loading = useRef(false);
  const havePayload = useRef(false);
  havePayload.current = payload != null;

  // drilldown selection is deep-linkable: `/metrics?agent=<id>`.
  const selectedAgent = useMemo(
    () => new URLSearchParams(location.search).get("agent"),
    [location.search],
  );
  const selectAgent = (agentId: string) => navigate("/metrics?agent=" + encodeURIComponent(agentId));
  const backToMetrics = () => navigate("/metrics");

  const load = useCallback(async (id: string, d: number) => {
    if (loading.current) return;
    loading.current = true;
    try {
      const r = await fetch("/api/containers/" + encodeURIComponent(id) + "/metrics?days=" + d);
      if (!r.ok) throw new Error("HTTP " + r.status);
      const data = (await r.json()) as MxPayload;
      setPayload(data);
      setLoadError(null);
    } catch (e) {
      // keep showing the last good payload; only surface the error cold
      if (!havePayload.current) setLoadError(e instanceof Error ? e.message : String(e));
    } finally {
      loading.current = false;
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
    setDays(next);
    setPayload(null); // stale window — show Loading, not old numbers
    setLoadError(null);
  };

  if (selectedAgent && cid) {
    return (
      <Shell page="metrics" title="Metrics" ctx={snap?.container?.name}>
        <AgentSpendDrilldown cid={cid} agentId={selectedAgent} onBack={backToMetrics} />
      </Shell>
    );
  }

  return (
    <Shell page="metrics" title="Metrics" ctx={snap?.container?.name}>
      <div className="mx-wrap">
        <div className="mx-head">
          <div>
            <h1>Metrics</h1>
            <p>Usage and estimated spend per agent — runs, sandbox compute, tokens and cost,
              parsed from each run&rsquo;s recorded usage. Dollar figures are estimates: only runs
              whose worker reported cost contribute (the caption says how many did).</p>
          </div>
          <div className="grow" />
          <nav className="aut" id="mxRange" role="radiogroup" aria-label="Metrics window">
            {[7, 30].map((d) => (
              <span
                key={d}
                className={"seg" + (days === d ? " on" : "")}
                role="radio"
                tabIndex={0}
                aria-selected={days === d}
                data-days={d}
                onClick={() => toggle(d)}
              >
                {d} days
              </span>
            ))}
          </nav>
        </div>
        <div id="mxBody">
          <MxBody payload={payload} days={days} error={loadError} onSelectAgent={selectAgent} />
        </div>
      </div>
    </Shell>
  );
}
