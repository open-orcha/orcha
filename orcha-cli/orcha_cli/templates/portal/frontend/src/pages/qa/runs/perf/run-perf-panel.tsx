import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { AlertTriangle, ChevronDown, Play, RotateCcw } from "../../map/kit/icons";
import { Button } from "../../map/kit";
import { CountUp } from "../../map/kit";
import { Skeleton } from "../../map/kit";
import { Table, TBody, TD, TH, THead, TR } from "../parts/table";
import {
  METRIC_LABEL,
  METRIC_SHORT,
  NOISE_LABEL,
  RUN_COLUMNS,
  deltaShort,
  deltaText,
  fmtMetric,
  fmtSeconds,
  headlineMetric,
  isTimeMetric,
  platformName,
  settleBreakdownText,
  type LiveTiming,
  type PerfMetric,
  type PerfNoise,
  type RunPerfResponse,
  type RunPerfScreen,
} from "../../map/perf/perf";
import { cn } from "../../map/kit";
import { PerfTeachingEmpty, StopwatchGlyph, VsUsualBar } from "../../map/perf/perf-ui";
import { usePlayClock } from "../../map/perf/perf-motion";
import { SlowdownReplay, stopwatch, type ReplaySpec } from "../../map/perf/slowdown-replay";
import { Waterfall, WaterfallClock, WaterfallLegend, rowEnd, shortUrl, wfScale, type WfHeat, type WfRow } from "./perf-waterfall";
import { LIVE_POLL_MS } from "../../sessions/detail/use-session-live";
import { loadRunPerf } from "./api";
import motion from "../../map/perf/perf.module.css";

type Load = { state: "loading" } | { state: "error"; message: string } | { state: "ready"; data: RunPerfResponse };

/**
 * The run page's Performance tab (#414): each screen the run timed as a waterfall from the action
 * to the screen appearing and settling, with the calls it waited on, against its usual time and
 * its budget, played like a stopwatch; the run's performance findings on top, each with a replay
 * against its usual; every metric in a table below. While the run is live each action lands as a
 * row that plays at real speed; the per-screen comparison follows once the run ends.
 */
export function RunPerfPanel({ runId, live = false, className }: { runId: string; live?: boolean; className?: string }) {
  const [load, setLoad] = useState<Load>({ state: "loading" });
  const [version, setVersion] = useState(0);
  useEffect(() => {
    if (!live) return;
    const timer = setInterval(() => setVersion((v) => v + 1), LIVE_POLL_MS);
    return () => clearInterval(timer);
  }, [live]);

  useEffect(() => {
    const ctl = new AbortController();
    loadRunPerf(runId, ctl.signal)
      .then((data) => setLoad({ state: "ready", data }))
      .catch((e: unknown) => {
        if (ctl.signal.aborted) return;
        setLoad((cur) => (cur.state === "ready" ? cur : { state: "error", message: e instanceof Error ? e.message : String(e) }));
      });
    return () => ctl.abort();
    // `live` flipping to false (the run ended) re-reads the finished view.
  }, [runId, version, live]);

  if (load.state === "loading") return <PanelSkeleton className={className} />;
  if (load.state === "error") {
    return (
      <p className="py-6 text-center text-sm text-danger" data-perf-error>
        Could not load the timings: {load.message}
      </p>
    );
  }
  const data = load.data;
  if (data.state === "live" || (data.state === "none" && data.live.length > 0)) {
    return <LiveTimings rows={data.live} running={data.state === "live"} device={data.device} platform={data.platform} className={className} />;
  }
  if (data.state === "none") {
    return (
      <div className={className}>
        <PerfTeachingEmpty
          compact
          title="No timings for this run"
          body="Embodent times every action on every run: how long until the next screen appears, and on the web the page's own load timings. This run recorded none, usually because it finished before any action reached the app or it ran before screens were timed."
        />
      </div>
    );
  }
  return <Done data={data} className={className} />;
}

/** The headline metric a screen is judged on, and the cell for it. */
function headOf(platform: string, s: RunPerfScreen): PerfMetric | null {
  if (platform !== "web" && !s.cells.appear && s.cells.launch) return "launch";
  const m = headlineMetric(platform, (x) => Boolean(s.cells[x]));
  return s.cells[m] ? m : null;
}

function heatOfScreen(s: RunPerfScreen, head: PerfMetric | null, pct: number): WfHeat {
  const c = head ? s.cells[head] : undefined;
  if (s.finding || c?.over || (c?.delta != null && c.delta >= pct)) return "slow";
  if (c?.delta != null && c.delta >= pct / 2) return "warm";
  return "ok";
}

/** A finding or a slow screen's replay: its usual against this run, when it has a usual. */
function replayOfScreen(s: RunPerfScreen, head: PerfMetric | null, platform: string, device: string | null): ReplaySpec | null {
  const c = head ? s.cells[head] : undefined;
  if (!head || !c?.baseline || c.value <= c.baseline.median * 1.1) return null;
  return {
    screen: s.label,
    platform,
    metric: head,
    frame: s.frame ?? null,
    usualMs: c.baseline.median,
    usualNote: `median of its last ${c.baseline.n} clean samples`,
    nowMs: c.value,
    nowLabel: "This run",
    nowNote: `${c.n > 1 ? `median of ${c.n} visits` : "one visit"}${device ? ` · ${device}` : ""}`,
    address: platform === "web" ? s.key : undefined,
  };
}

const MARKS: [PerfMetric, string][] = [
  ["ttfb", "first byte"],
  ["dcl", "DOM ready"],
  ["lcp", "main content"],
  ["load", "load"],
];

function rowsOf(data: RunPerfResponse): { rows: WfRow[]; screens: Map<string, { head: PerfMetric | null; replay: ReplaySpec | null }> } {
  const platform = data.platform ?? "web";
  const pct = data.settings.regression_pct / 100;
  const meta = new Map<string, { head: PerfMetric | null; replay: ReplaySpec | null }>();
  const rows = data.screens.map((s): WfRow => {
    const head = headOf(platform, s);
    const c = head ? s.cells[head] : undefined;
    const heat = heatOfScreen(s, head, pct);
    // Offered where it tells something: a screen slower than usual or getting there.
    const replay = heat === "ok" ? null : replayOfScreen(s, head, platform, data.device);
    meta.set(s.key, { head, replay });
    const delta = c && c.delta !== null && Math.abs(c.delta) >= 0.1 ? deltaShort(c.delta) : null;
    const extras = (["cpu", "memory", "long_tasks", "heap"] as PerfMetric[]).filter((m) => s.cells[m]);
    return {
      id: s.key,
      title: s.label,
      heat,
      value: c?.value ?? null,
      appear: s.cells.appear?.value ?? s.cells.launch?.value ?? null,
      settle: s.cells.settle?.value ?? null,
      marks: platform === "web" ? MARKS.filter(([m]) => s.cells[m]).map(([m, label]) => ({ label, at: s.cells[m]!.value })) : [],
      calls: s.slowCalls,
      usual: c?.baseline ?? null,
      budget: c?.budget ?? null,
      replay,
      sub: (
        <>
          {c?.baseline ? <>usually {fmtSeconds(c.baseline.median)}</> : <span className="text-muted">no history yet</span>}
          {delta ? <span className={cn("ml-1 font-medium", c && c.delta! < 0 ? "text-success" : heat === "slow" ? "text-danger" : heat === "warm" ? "text-warning" : "text-fg-2")}>{delta}</span> : null}
          {c && c.n > 1 ? <span className="text-muted"> · {c.n} visits</span> : null}
        </>
      ),
      detail: extras.length ? (
        <p className="flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-fg-2">
          {extras.map((m) => (
            <span key={m}>
              <span className="text-muted">{METRIC_LABEL[m]}</span> <span className="tabular text-fg">{fmtMetric(m, s.cells[m]!.value)}</span>
            </span>
          ))}
        </p>
      ) : null,
    };
  });
  return { rows, screens: meta };
}

function Done({ data, className }: { data: RunPerfResponse; className?: string }) {
  const [playKey, setPlayKey] = useState(0);
  const [table, setTable] = useState(false);
  const { rows, screens } = useMemo(() => rowsOf(data), [data]);
  const max = useMemo(() => wfScale(Math.max(1000, ...rows.map((r) => Math.max(rowEnd(r), r.usual?.p90 ?? 0)))), [rows]);
  const slow = rows.filter((r) => r.heat === "slow").length;
  const platform = data.platform ?? "web";
  const slowest = [...rows].sort((a, b) => (b.value ?? 0) - (a.value ?? 0))[0];
  return (
    <div className={cn("@container flex min-h-0 flex-1 flex-col gap-4", className)} data-perf-panel>
      <section className="v-rise flex flex-wrap items-center gap-x-4 gap-y-3 rounded-xl border border-border bg-panel px-4 py-3 shadow-[var(--shadow-panel)]" aria-label="This run's timings" data-perf-summary>
        <span className={cn("flex size-9 shrink-0 items-center justify-center rounded-full", slow ? "bg-danger/10 text-danger" : "bg-success/10 text-success")}>
          <StopwatchGlyph className="size-[18px]" />
        </span>
        <div className="min-w-[13rem] flex-1">
          <p className="text-sm font-semibold text-fg">
            <CountUp value={String(rows.length)} /> screen{rows.length === 1 ? "" : "s"} timed
            <span className="font-normal text-fg-2">
              {" "}
              on {platform === "web" ? platformName("web") : (data.device ?? platformName(platform))}
            </span>
          </p>
          <p className="text-xs text-fg-2">
            {slow ? (
              <span className="font-medium text-danger">
                {slow} slower than usual or over budget
              </span>
            ) : (
              <span className="text-success">Every screen as fast as usual</span>
            )}
            {slowest?.value != null ? (
              <>
                {" "}
                · slowest <span className="text-fg">{slowest.title}</span> <span className="tabular">{fmtSeconds(slowest.value)}</span>
              </>
            ) : null}
          </p>
        </div>
        <div className="ml-auto flex items-center gap-3">
          <WaterfallClock max={max} end={Math.max(...rows.map(rowEnd))} playKey={playKey} />
          <Button size="sm" variant="secondary" onClick={() => setPlayKey((k) => k + 1)} data-perf-play>
            <RotateCcw aria-hidden />
            Play again
          </Button>
        </div>
      </section>

      {data.findings.length > 0 ? <Regressions data={data} screens={screens} /> : null}

      <section aria-label="Timings per screen" className="v-rise rounded-xl border border-border bg-panel px-4 pb-2 pt-3 shadow-[var(--shadow-panel)]" style={{ "--d": "80ms" } as CSSProperties} data-perf-screens>
        <div className="mb-2 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
          <h3 className="text-[13px] font-semibold text-fg">From the action to the screen</h3>
          <WaterfallLegend web={platform === "web"} />
        </div>
        <Waterfall rows={rows} max={max} playKey={playKey} label="Each screen's timeline, from the action" />
      </section>

      <section aria-label="Every metric" className="flex flex-col gap-2">
        <button
          type="button"
          onClick={() => setTable((t) => !t)}
          aria-expanded={table}
          className="inline-flex w-fit items-center gap-1 rounded px-1 text-xs font-medium text-fg-2 outline-none hover:text-fg focus-visible:ring-2 focus-visible:ring-primary/60"
          data-perf-table-toggle
        >
          <ChevronDown className={cn("size-3.5 transition-transform duration-200", !table && "-rotate-90")} aria-hidden />
          {table ? "Hide every metric" : "Every metric, screen by screen"}
        </button>
        {table ? <ScreenTable data={data} /> : null}
      </section>
      <NoiseNote noise={data.noise} />
    </div>
  );
}

function Regressions({ data, screens }: { data: RunPerfResponse; screens: Map<string, { head: PerfMetric | null; replay: ReplaySpec | null }> }) {
  return (
    <section aria-label="Performance findings" className="flex flex-col gap-2" data-perf-findings>
      <h3 className="px-1 text-xs font-medium text-muted">Slower than usual or over budget</h3>
      <ul className="flex flex-col gap-2">
        {data.findings.map((f, i) => {
          const replay = f.screen_key ? (screens.get(f.screen_key)?.replay ?? null) : null;
          const major = f.severity === "major" || f.severity === "blocker";
          return (
            <li
              key={f.seq}
              className={cn("v-rise flex items-start gap-3 rounded-xl border border-border bg-panel px-3.5 py-3 shadow-[var(--shadow-panel)]", motion.slowRow)}
              style={{ "--i": i } as CSSProperties}
              data-perf-finding={f.seq}
            >
              <AlertTriangle className={cn("mt-0.5 size-4 shrink-0", major ? "text-danger" : "text-warning")} aria-hidden />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-fg">{f.title}</p>
                <p className="mt-0.5 text-xs text-fg-2">
                  <span className="capitalize">{f.severity}</span>
                  {f.reason ? <> · {f.reason === "regression" ? "slower than its usual" : "over its budget"}</> : null}
                  {f.confidence ? <> · {f.confidence} confidence</> : null}
                </p>
              </div>
              <div className="flex shrink-0 flex-wrap items-center justify-end gap-x-3 gap-y-1 text-xs">
                {replay ? (
                  <SlowdownReplay
                    spec={replay}
                    trigger={(open) => (
                      <Button size="sm" variant="secondary" onClick={open} data-perf-finding-replay>
                        <Play aria-hidden className="fill-current" />
                        Replay
                      </Button>
                    )}
                  />
                ) : null}
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function ScreenTable({ data }: { data: RunPerfResponse }) {
  const platform = data.platform ?? "web";
  const columns = (RUN_COLUMNS[platform] ?? RUN_COLUMNS.web).filter((m) => data.screens.some((s) => s.cells[m]));
  return (
    <div className="v-rise min-w-0 overflow-x-auto rounded-xl border border-border bg-panel" data-perf-table>
      <Table>
        <THead>
          <TR>
            <TH scope="col">Screen</TH>
            {columns.map((m) => (
              <TH key={m} scope="col" className="whitespace-nowrap text-right" title={METRIC_LABEL[m]}>
                {METRIC_SHORT[m]}
                <span className="sr-only"> ({METRIC_LABEL[m]})</span>
              </TH>
            ))}
          </TR>
        </THead>
        <TBody>
          {data.screens.map((s) => (
            <TR key={s.key} data-perf-screen={s.key} data-slow={s.finding ? "true" : undefined}>
              <TD className="max-w-[220px]">
                <div className="flex flex-col">
                  <span className="truncate font-medium text-fg" title={s.label}>
                    {s.label}
                  </span>
                  <span className="truncate font-mono text-[11px] text-muted" title={s.key}>
                    {s.key}
                  </span>
                  {s.slowCalls[0] ? (
                    <span className="truncate text-[11px] text-fg-2" title={`${s.slowCalls[0].method ?? ""} ${s.slowCalls[0].url ?? ""}`}>
                      Slowest call {fmtSeconds(s.slowCalls[0].ms)}: {s.slowCalls[0].method} {shortUrl(s.slowCalls[0].url)}
                    </span>
                  ) : null}
                </div>
              </TD>
              {columns.map((m) => (
                <TD key={m} className="text-right align-top">
                  <Cell screen={s} metric={m} regressionPct={data.settings.regression_pct} />
                </TD>
              ))}
            </TR>
          ))}
        </TBody>
      </Table>
    </div>
  );
}

function Cell({ screen, metric, regressionPct }: { screen: RunPerfScreen; metric: PerfMetric; regressionPct: number }) {
  const c = screen.cells[metric];
  if (!c) return <span className="text-muted">–</span>;
  const pct = regressionPct / 100;
  const delta = isTimeMetric(metric) && c.delta !== null && Math.abs(c.delta) >= 0.1 ? deltaShort(c.delta) : null;
  const slow = c.over || (c.delta !== null && c.delta >= pct);
  const warm = !slow && c.delta !== null && c.delta >= pct / 2;
  return (
    <div className="flex flex-col items-end gap-1 whitespace-nowrap" data-perf-cell={metric} title={c.baseline && delta ? `${deltaText(c.delta)}` : undefined}>
      <span className={cn("tabular font-medium", slow ? "text-danger" : "text-fg")}>
        {fmtMetric(metric, c.value)}
        {c.n > 1 ? <span className="ml-1 text-[11px] font-normal text-muted">×{c.n}</span> : null}
      </span>
      {isTimeMetric(metric) ? <VsUsualBar value={c.value} usual={c.baseline?.median ?? null} budget={c.budget} /> : null}
      <span className="text-[11px] text-muted">
        {c.baseline ? `usual ${fmtMetric(metric, c.baseline.median)}` : "no history yet"}
        {delta && c.delta !== null ? <span className={cn("ml-1", c.delta < 0 ? "text-success" : slow ? "text-danger" : warm ? "text-warning" : "text-fg-2")}>{delta}</span> : null}
      </span>
      {c.over && c.budget ? <span className="text-[11px] text-danger">over {fmtSeconds(c.budget)} budget</span> : null}
    </div>
  );
}

function NoiseNote({ noise }: { noise: Partial<Record<PerfNoise, number>> }) {
  const parts = (Object.entries(noise) as [PerfNoise, number][]).filter(([, n]) => n > 0);
  if (!parts.length) return null;
  return (
    <p className="px-1 text-xs text-muted" data-perf-noise>
      Left out of the comparison: {parts.map(([k, n]) => `${n} sample${n === 1 ? "" : "s"} (${NOISE_LABEL[k]})`).join(", ")}. They stay visible here and never count toward a screen&apos;s usual time.
    </p>
  );
}

/** The live view: each action lands as a waterfall row, newest on top, and plays at real speed. */
function LiveTimings({ rows, running, device, platform, className }: { rows: readonly LiveTiming[]; running: boolean; device: string | null; platform: string | null; className?: string }) {
  // The rows already there when the tab opened stand still; each one that arrives after plays,
  // from its first frame (so it never shows finished, then starts over).
  const [initial] = useState(() => new Set(rows.map((r) => r.seq)));
  const fresh = useMemo(() => new Set(rows.map((r) => r.seq).filter((s) => !initial.has(s))), [rows, initial]);

  if (!rows.length) {
    return (
      <div className={className} data-perf-live="waiting">
        <PerfTeachingEmpty
          compact
          title={running ? "Timing each screen as the run goes" : "Waiting for the run's timings"}
          body="Each action the run takes is timed until the next screen appears. They show here as they happen; once the run ends, every screen is compared with its usual time."
          action={
            running ? (
              <span className="inline-flex items-center gap-1.5 text-sm text-fg-2">
                <StopwatchGlyph running className="text-primary" />
                Waiting for the first action
              </span>
            ) : null
          }
        />
      </div>
    );
  }
  const newest = rows[rows.length - 1];
  const max = wfScale(Math.max(1000, ...rows.map((r) => Math.max(r.settle_ms, r.appear_ms ?? 0, ...(r.calls ?? []).map((c) => (c.start_ms ?? 0) + c.ms)))));
  const wf: WfRow[] = [...rows].reverse().map((r) => ({
    id: String(r.seq),
    title: r.screen ?? (r.appear_ms === null ? "No new screen" : "Next screen"),
    sub: (
      <>
        <span className="text-muted">
          #{r.seq} · {r.kind}
        </span>
        {r.appear_ms === null ? <span className="text-muted"> · the screen did not change</span> : null}
        {settleBreakdownText(r) ? <span className="text-muted" data-perf-settle> · {settleBreakdownText(r)}</span> : null}
      </>
    ),
    heat: "live",
    value: r.appear_ms ?? r.settle_ms,
    appear: r.appear_ms,
    settle: r.settle_ms,
    marks: [],
    calls: r.calls ?? [],
    usual: null,
    budget: null,
    fresh: fresh.has(r.seq),
  }));
  return (
    <section aria-label="Live timings" className={cn("@container flex flex-col gap-4", className)} data-perf-live="rows">
      <div className="v-rise flex flex-wrap items-center gap-x-4 gap-y-3 rounded-xl border border-primary/30 bg-panel px-4 py-3 shadow-[var(--shadow-panel)]">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
          <StopwatchGlyph running={running} className="size-[18px]" />
        </span>
        <div className="min-w-[13rem] flex-1" aria-live="polite">
          <p className="text-sm font-semibold text-fg">
            {running ? "Timing each screen as the run goes" : "Timed while the run went"}
            <span className="font-normal text-fg-2">{device && platform !== "web" ? ` on ${device}` : ""}</span>
          </p>
          <p className="text-xs text-fg-2">
            <span className="tabular">{rows.length}</span> action{rows.length === 1 ? "" : "s"} timed so far.{" "}
            {running ? "Each screen is compared with its usual time when the run ends." : "The comparison shows once a screen has been timed."}
          </p>
        </div>
        <LiveNewest key={newest.seq} row={newest} animate={fresh.has(newest.seq)} />
      </div>
      <section className="rounded-xl border border-border bg-panel px-4 pb-2 pt-3 shadow-[var(--shadow-panel)]" aria-label="Each action, newest first">
        <div className="mb-2 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
          <h3 className="text-[13px] font-semibold text-fg">Each action, newest first</h3>
          <WaterfallLegend web={platform === "web"} />
        </div>
        <Waterfall rows={wf} max={max} playKey={0} realTime label="Each action's timeline, newest first" />
      </section>
    </section>
  );
}

/** The newest action's stopwatch: it runs at real speed to the time the action took. */
function LiveNewest({ row, animate }: { row: LiveTiming; animate: boolean }) {
  const end = row.appear_ms ?? row.settle_ms;
  const clock = usePlayClock(end, { autoPlay: animate });
  const shown = animate ? clock.ms : end;
  return (
    <div className="ml-auto flex flex-col items-end" data-perf-live-newest={row.seq}>
      <span className="text-[11px] text-muted">{row.screen ? `${row.screen}` : "Latest action"}</span>
      <span className={cn("font-mono text-xl font-semibold tabular-nums", animate && clock.running ? "text-primary" : "text-fg")}>{stopwatch(shown)}</span>
    </div>
  );
}

function PanelSkeleton({ className }: { className?: string }) {
  return (
    <div className={cn("flex flex-col gap-4", className)} aria-hidden data-perf-skeleton>
      <div className="flex items-center gap-3 rounded-xl border border-border bg-panel px-4 py-3">
        <Skeleton className="size-9 rounded-full" />
        <div className="flex flex-1 flex-col gap-1.5">
          <Skeleton className="h-3.5 w-48" />
          <Skeleton className="h-2.5 w-64 opacity-70" />
        </div>
        <Skeleton className="h-6 w-24" />
      </div>
      <div className="flex flex-col gap-3 rounded-xl border border-border bg-panel px-4 py-4">
        {[0, 1, 2, 3, 4].map((i) => (
          <div key={i} className="flex items-center gap-3">
            <div className="flex w-40 flex-col gap-1">
              <Skeleton className="h-3 w-28" delay={i * 70} />
              <Skeleton className="h-2.5 w-20 opacity-70" delay={i * 70} />
            </div>
            <Skeleton className="h-2 rounded-full" style={{ width: `${62 - ((i * 17) % 40)}%` }} delay={i * 70} />
          </div>
        ))}
      </div>
    </div>
  );
}
