/**
 * <PerformanceSection cid={cid} /> — Metrics → "Agent performance" (evals-lite).
 *
 * Initiatives-style table (D10): the project total first, then one row per AI agent —
 * Verified (count + per-bucket sparkline) · First pass · Rework · Time to verified ·
 * Cost / verified · Plan approval · Escalations. Its own range pills (7 · 30 · 90 days ·
 * All time); fetched on mount, on range change and every 60s (never the 3s tick).
 *
 * Truthful (brief §3): figures below the server's min_sample read "Not enough data",
 * cost with no metered task reads "Not metered" (never $0), a zero count is a real zero,
 * and nothing is coloured "good" without enough data. See performanceModel.ts.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Avatar, Button, EmptyState, FilterPills, HelpTip, Skeleton } from "../../../components/primitives";
import {
  costFigure, DEFINITIONS, fetchPerformance, firstPassFigure, firstPassTone, medianFigure, PERF_RANGE_LABEL,
  PERF_RANGES, PERF_REFRESH_MS, planFigure, reworkTip, isAccessDenied, isMetrics,
  type Figure, type PerfBucket, type PerfMetrics, type PerfRange, type PerformancePayload,
} from "./performanceModel";
import { PerfSparkline } from "./PerfSparkline";
import "./performance.css";

function FigureCell({ f, tone, label }: { f: Figure; tone?: string | null; label: string }) {
  return (
    <td className={"tnum num" + (f.known ? "" : " pf-unknown")} data-label={label} title={f.sub + " — " + f.tip}>
      <span className={tone ? "pf-tone-" + tone : undefined}>{f.text}</span>
    </td>
  );
}

function MetricCells({ m, min, series, bucketDays, name }: {
  m: PerfMetrics; min: number; series: PerfBucket[]; bucketDays: number; name: string;
}) {
  return (
    <>
      <td className="tnum num pf-c-verified">
        <span className="pf-verified">
          <PerfSparkline series={series} bucketDays={bucketDays} label={name + ": verified tasks"} />
          <span className="pf-count">{m.tasks_verified}</span>
        </span>
      </td>
      <FigureCell label="First pass" f={firstPassFigure(m, min)} tone={firstPassTone(m)} />
      <td className="tnum num" data-label="Rework" title={reworkTip(m)}>{m.rework.total}</td>
      <FigureCell label="Time to verified" f={medianFigure(m, min)} />
      <FigureCell label="Cost / verified" f={costFigure(m, min)} />
      <FigureCell label="Plan approval" f={planFigure(m, min)} />
      <td className="tnum num" data-label="Escalations">{m.escalations}</td>
    </>
  );
}

function hasAny(m: PerfMetrics): boolean {
  return !!(m.tasks_verified || m.rework.total || m.escalations || m.plan_approval_rate.denominator);
}

export function PerformanceTable({ d }: { d: PerformancePayload }) {
  const rows = [...d.agents].sort((a, b) =>
    b.metrics.tasks_verified - a.metrics.tasks_verified || a.alias.localeCompare(b.alias));
  const unit = d.bucket_days <= 1 ? "day" : d.bucket_days === 7 ? "week" : d.bucket_days + " days";
  return (
    <table className="mx-tbl pf-tbl">
      <caption className="v2-sr">
        Agent performance, {PERF_RANGE_LABEL[d.range].toLowerCase()}: the project total, then each AI agent.
        Sparklines show verified tasks per {unit}.
      </caption>
      <thead>
        <tr>
          <th scope="col">Agent</th>
          <th scope="col" className="num" title={DEFINITIONS[0].d}>Verified</th>
          <th scope="col" className="num" title={DEFINITIONS[1].d}>First pass</th>
          <th scope="col" className="num" title={DEFINITIONS[2].d}>Rework</th>
          <th scope="col" className="num" title={DEFINITIONS[3].d}>Time to verified</th>
          <th scope="col" className="num" title={DEFINITIONS[4].d}>Cost / verified</th>
          <th scope="col" className="num" title={DEFINITIONS[5].d}>Plan approval</th>
          <th scope="col" className="num" title={DEFINITIONS[6].d}>Escalations</th>
        </tr>
      </thead>
      <tbody>
        <tr className="pf-total" data-scope="project">
          <th scope="row" className="mx-c-name">
            <span className="mx-agent">
              <span className="pf-proj-ico" aria-hidden="true">Σ</span>
              <span className="mx-agent-txt"><span className="nm">All agents</span>
                <span className="mx-model">{d.project.name || "This project"}</span></span>
            </span>
          </th>
          <MetricCells m={d.project.metrics} min={d.min_sample} series={d.project.series} bucketDays={d.bucket_days} name="All agents" />
        </tr>
        {rows.map((a) => (
          <tr key={a.agent_id} data-agent={a.agent_id}>
            <th scope="row" className="mx-c-name">
              <span className="mx-agent" title={a.alias}>
                <Avatar alias={a.alias} kind="ai" size={24} decorative />
                <span className="mx-agent-txt">
                  <span className="nm">{a.alias}</span>
                  <span className="mx-model">{a.retired ? "Retired" : a.role || "Agent"}</span>
                </span>
              </span>
            </th>
            <MetricCells m={a.metrics} min={d.min_sample} series={a.series} bucketDays={d.bucket_days} name={a.alias} />
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function PerformanceSection({ cid, defaultRange = "7d" }: { cid: string; defaultRange?: PerfRange }) {
  const [range, setRange] = useState<PerfRange>(defaultRange);
  // AP-31: the Metrics page window (7 · 30 days) drives this section's range whenever it
  // changes; the section's own pills still pick 90 days / All time in between.
  const [followed, setFollowed] = useState<PerfRange>(defaultRange);
  if (followed !== defaultRange) { setFollowed(defaultRange); setRange(defaultRange); }
  const [d, setD] = useState<PerformancePayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [unsupported, setUnsupported] = useState(false);
  const tok = useRef(0);

  const load = useCallback((r: PerfRange) => {
    const my = ++tok.current;
    fetchPerformance(cid, r)
      .then((p) => {
        if (my !== tok.current) return;
        if (!p || !isMetrics(p.project?.metrics)) { setUnsupported(true); return; }
        setD(p); setError(null);
      })
      .catch((e: Error & { status?: number }) => {
        if (my !== tok.current) return;
        if (e.status === 404 || e.status === 405 || isAccessDenied(e)) setUnsupported(true);
        else setError(e.message);
      });
  }, [cid]);

  useEffect(() => {
    setD(null); setError(null); setUnsupported(false);
    load(range);
    const iv = setInterval(() => { if (!document.hidden) load(range); }, PERF_REFRESH_MS);
    return () => { clearInterval(iv); tok.current++; };
  }, [load, range]);

  if (unsupported) return null;
  const help = (
    <span className="pf-defs">
      {DEFINITIONS.map((x) => <span key={x.k} className="pf-def"><b>{x.k}</b> — {x.d}</span>)}
      <span className="pf-def">Rates, times and costs need at least {d?.min_sample ?? 3} samples; below that they read “Not enough data”.</span>
    </span>
  );

  let body;
  if (error && !d) {
    body = (
      <div className="mx-empty">
        <EmptyState compact icon="alert" tone="danger" title="Performance is temporarily unavailable"
          body={<span className="pf-err">{error}</span>}
          action={<Button icon="refresh" size="sm" onClick={() => load(range)}>Retry</Button>} />
      </div>
    );
  } else if (!d) {
    body = <div className="mx-skel"><Skeleton lines={4} label="Loading agent performance" /></div>;
  } else if (!hasAny(d.project.metrics) && d.agents.every((a) => !hasAny(a.metrics))) {
    body = (
      <div className="mx-empty">
        <EmptyState compact icon="chart" title={`No verified work ${d.range === "all" ? "yet" : "in the last " + PERF_RANGE_LABEL[d.range].toLowerCase()}`}
          body="Figures appear once a human verifies an agent's task." />
      </div>
    );
  } else {
    body = <div className="mx-scroll"><PerformanceTable d={d} /></div>;
  }

  return (
    <section className="mx-sec mx-sec-flush pf-sec" id="mxPerf" aria-labelledby="mxPerfH">
      <div className="mx-sec-h pf-h">
        <h2 id="mxPerfH">Agent performance</h2>
        {d ? <span className="count" title="AI agents in this project">{d.agents.length}</span> : null}
        <HelpTip tip={help} label="How agent performance is measured" />
        <span className="pf-grow" />
        <FilterPills
          label="Performance range"
          size="sm"
          className="pf-range"
          value={range}
          onChange={(k) => setRange(k as PerfRange)}
          items={PERF_RANGES.map((r) => ({ key: r, label: PERF_RANGE_LABEL[r] }))}
        />
      </div>
      {body}
    </section>
  );
}

