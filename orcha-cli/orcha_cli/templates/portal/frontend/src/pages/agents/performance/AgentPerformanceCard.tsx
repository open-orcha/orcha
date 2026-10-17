/**
 * <AgentPerformanceCard agent={a} /> — the agent Configuration tab's "Performance" card
 * (evals-lite): a verified-per-period sparkline + seven figures for one AI agent over a
 * selectable range. Self-contained: reads the project from the snapshot, fetches
 * GET /api/containers/{cid}/metrics/performance/agents/{aid}?range=… on mount, on range
 * change and every 60s. Read-only for everyone (it is a read; viewers included).
 *
 * Truthful (brief §3): below the server's min_sample a figure reads "Not enough data"
 * with its sample size; cost with nothing metered reads "Not metered" (never $0); counts
 * are real counts. Definitions live in the "?" tooltip, not in the layout (D12).
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { Button, FilterPills, HelpTip } from "../../../components/primitives";
import { useSnapshot } from "../../../state/SnapshotProvider";
import type { Agent } from "../../../types";
import {
  costFigure, DEFINITIONS, fetchAgentPerformance, firstPassFigure, firstPassTone, isAccessDenied, isMetrics, medianFigure,
  PERF_RANGE_LABEL, PERF_RANGES, PERF_REFRESH_MS, planFigure, reworkTip,
  type AgentPerformancePayload, type Figure, type PerfRange,
} from "../../../cloud/metrics/performance/performanceModel";
import { PerfSparkline } from "../../../cloud/metrics/performance/PerfSparkline";
import "../../../cloud/metrics/performance/performance.css";
import "./agentPerformance.css";

export function AgentPerformanceCard({ agent, defaultRange = "7d" }: {
  agent: Pick<Agent, "id" | "alias" | "kind">;
  defaultRange?: PerfRange;
}) {
  const { cid } = useSnapshot();
  if (agent.kind === "human" || !cid) return null;
  return <AgentPerformancePanel cid={cid} agentId={String(agent.id)} alias={agent.alias || "This agent"} defaultRange={defaultRange} />;
}

function Tile({ label, f, tone, id }: { label: string; f: Figure; tone?: string | null; id: string }) {
  return (
    <div className="apf-tile" data-fig={id} title={f.tip}>
      <div className="apf-l">{label}</div>
      <div className={"apf-v" + (f.known ? "" : " is-unknown") + (tone ? " pf-tone-" + tone : "")}>{f.text}</div>
      <div className="apf-s">{f.sub}</div>
    </div>
  );
}

function CountTile({ label, n, sub, tip, id }: { label: string; n: number; sub: string; tip: string; id: string }) {
  return (
    <div className="apf-tile" data-fig={id} title={tip}>
      <div className="apf-l">{label}</div>
      <div className="apf-v">{n}</div>
      <div className="apf-s">{sub}</div>
    </div>
  );
}

export function AgentPerformancePanel({ cid, agentId, alias, defaultRange = "7d" }: {
  cid: string; agentId: string; alias: string; defaultRange?: PerfRange;
}) {
  const [range, setRange] = useState<PerfRange>(defaultRange);
  const [d, setD] = useState<AgentPerformancePayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [unsupported, setUnsupported] = useState(false);
  const tok = useRef(0);

  const load = useCallback((r: PerfRange) => {
    const my = ++tok.current;
    fetchAgentPerformance(cid, agentId, r)
      .then((p) => {
        if (my !== tok.current) return;
        if (!p || !isMetrics(p.agent?.metrics)) { setUnsupported(true); return; }
        setD(p); setError(null);
      })
      .catch((e: Error & { status?: number }) => {
        if (my !== tok.current) return;
        if (e.status === 404 || e.status === 405 || isAccessDenied(e)) setUnsupported(true);
        else setError(e.message);
      });
  }, [cid, agentId]);

  useEffect(() => {
    setD(null); setError(null); setUnsupported(false);
    load(range);
    const iv = setInterval(() => { if (!document.hidden) load(range); }, PERF_REFRESH_MS);
    return () => { clearInterval(iv); tok.current++; };
  }, [load, range]);

  if (unsupported) return null;
  const min = d?.min_sample ?? 3;
  const help = (
    <span className="pf-defs">
      {DEFINITIONS.map((x) => <span key={x.k} className="pf-def"><b>{x.k}</b> — {x.d}</span>)}
      <span className="pf-def">Rates, times and costs need at least {min} samples; below that they read “Not enough data”.</span>
    </span>
  );
  const unit = d ? (d.bucket_days <= 1 ? "day" : d.bucket_days === 7 ? "week" : d.bucket_days + " days") : "day";

  let body;
  if (error && !d) {
    body = (
      <div className="apf-card apf-msg" role="alert">
        <span className="apf-msg-t">Couldn&rsquo;t load performance. <span className="apf-err">{error}</span></span>
        <Button size="sm" icon="refresh" onClick={() => load(range)}>Retry</Button>
      </div>
    );
  } else if (!d) {
    body = <div className="apf-card apf-msg" role="status" aria-label="Loading performance"><span className="apf-msg-t">Loading…</span></div>;
  } else {
    const m = d.agent.metrics;
    body = (
      <div className="apf-card">
        <div className="apf-chart">
          <div className="apf-chart-h">
            <span className="apf-chart-t">Verified per {unit}</span>
            <span className="apf-chart-n">{m.tasks_verified} in {PERF_RANGE_LABEL[d.range].toLowerCase()}</span>
          </div>
          <PerfSparkline series={d.agent.series} bucketDays={d.bucket_days} label={alias + ": verified tasks per " + unit} size="md" />
        </div>
        <div className="apf-grid" role="group" aria-label={alias + " performance figures"}>
          <CountTile id="verified" label="Verified" n={m.tasks_verified} sub="by a human" tip={DEFINITIONS[0].d} />
          <Tile id="first_pass" label="First pass" f={firstPassFigure(m, min)} tone={firstPassTone(m)} />
          <CountTile id="rework" label="Rework" n={m.rework.total}
            sub={`${m.rework.human_rejections} rejected · ${m.rework.manager_send_backs} sent back`} tip={reworkTip(m)} />
          <Tile id="time" label="Time to verified" f={medianFigure(m, min)} />
          <Tile id="cost" label="Cost / verified" f={costFigure(m, min)} />
          <Tile id="plan" label="Plan approval" f={planFigure(m, min)} />
          <CountTile id="escalations" label="Escalations" n={m.escalations} sub={m.escalations === 1 ? "ask sent to a human" : "asks sent to a human"} tip={DEFINITIONS[6].d} />
        </div>
      </div>
    );
  }

  return (
    <section className="ag-sec apf" aria-labelledby={"apfH-" + agentId}>
      <div className="apf-h">
        <h3 className="apf-t" id={"apfH-" + agentId}>Performance</h3>
        <HelpTip tip={help} label="How performance is measured" />
        <span className="apf-grow" />
        <FilterPills
          label="Performance range"
          size="sm"
          value={range}
          onChange={(k) => setRange(k as PerfRange)}
          items={PERF_RANGES.map((r) => ({ key: r, label: PERF_RANGE_LABEL[r] }))}
        />
      </div>
      {body}
      <Link className="apf-link" to="/metrics#mxPerf">Compare agents in Metrics</Link>
    </section>
  );
}
