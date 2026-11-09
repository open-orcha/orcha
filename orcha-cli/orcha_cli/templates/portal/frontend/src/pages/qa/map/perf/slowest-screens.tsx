import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { CircleCheck, Play, Settings2 } from "../kit/icons";
import { Button, buttonVariants, cn, CountUp, fmtDate, fmtMs, Link, Skeleton } from "../kit";
import { qaHref } from "../../parts";
import type { QaNav } from "../../QaPage";
import { loadSlowest } from "./api";
import {
  HEAT_LABEL,
  METRIC_LABEL,
  NOISE_LABEL,
  deltaText,
  fmtMetric,
  fmtSeconds,
  platformName,
  type HeatLevel,
  type PerfNoise,
  type RunningTimings,
  type SlowestResponse,
  type SlowScreen,
} from "./perf";
import { HEAT_FILL, HeatBadge, PerfSparkline, PerfTeachingEmpty, RankBar, StopwatchGlyph } from "./perf-ui";
import { useFlip } from "./perf-motion";
import { SlowdownReplay, type ReplaySpec } from "./slowdown-replay";
import motion from "./perf.module.css";

/** How often the live strip re-reads a session in progress. */
const LIVE_POLL_MS = 3000;

const WINDOWS = [7, 30, 90] as const;

type Load = { state: "loading" } | { state: "error"; message: string } | { state: "ready"; data: SlowestResponse };

/**
 * Map › Slowest screens: every screen Orcha has timed, slowest first. A pulse on top says what
 * changed (the screen that got slower, and how many are slow, getting slow and fast enough); each
 * row is the screen's newest time on one shared scale against its usual band, its trend over the
 * last runs and its heat, and a slow screen with a history can be replayed against its usual. The
 * page reads again with the QA page (`nonce`), every few seconds while a session is timing: rows
 * that moved slide to their new rank and the ones a run just timed light up.
 */
export function SlowestScreens({ cid, nav }: { cid: string; nav: QaNav }) {
  const [days, setDays] = useState<number>(30);
  const [platform, setPlatform] = useState<string | null>(null);
  const [load, setLoad] = useState<Load>({ state: "loading" });
  const [version, setVersion] = useState(0);
  const [fresh, setFresh] = useState(false);
  const samples = useRef<number | null>(null);

  useEffect(() => {
    const ctl = new AbortController();
    loadSlowest(cid, days, platform, ctl.signal)
      .then((json) => {
        if (ctl.signal.aborted) return;
        if (samples.current !== null && json.total_samples > samples.current) setFresh(true);
        samples.current = json.total_samples;
        setLoad({ state: "ready", data: json });
      })
      .catch((e: unknown) => {
        if (!ctl.signal.aborted) setLoad({ state: "error", message: e instanceof Error ? e.message : String(e) });
      });
    return () => ctl.abort();
  }, [cid, days, platform, version, nav.nonce]);

  // A session in progress records as it goes: re-read while one is running.
  const running = load.state === "ready" ? (load.data.running ?? []) : [];
  const live = running.length > 0;
  useEffect(() => {
    if (!live) return;
    const t = setTimeout(() => setVersion((v) => v + 1), LIVE_POLL_MS);
    return () => clearTimeout(t);
  }, [live, version]);

  useEffect(() => {
    if (!fresh) return;
    const t = setTimeout(() => setFresh(false), 2500);
    return () => clearTimeout(t);
  }, [fresh]);

  const settingsHref = qaHref({ view: "map", platform: nav.platform === "ios" ? null : nav.platform, sub: "budgets" });
  const runsHref = qaHref({ view: "sessions", platform: nav.platform === "ios" ? null : nav.platform });
  return (
    <div className="@container mx-auto flex w-full max-w-[1100px] flex-col gap-4 px-4 py-5 sm:px-6" data-slowest>
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <h1 className="flex items-center gap-2 text-[15px] font-semibold text-fg">
            <StopwatchGlyph className="text-fg-2" running={live} />
            Slowest screens
          </h1>
          <p className="mt-0.5 max-w-[640px] text-sm text-fg-2">
            Every screen Embodent timed on its runs, slowest first. Each is compared with its own history, so a screen that got slower stands out even when it is not the slowest.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Segmented label="Window" value={String(days)} options={WINDOWS.map((d) => ({ value: String(d), label: `${d} days` }))} onChange={(v) => setDays(Number(v))} />
          {load.state === "ready" && load.data.platforms.length > 1 ? (
            <Segmented
              label="Platform"
              value={platform ?? ""}
              options={[{ value: "", label: "All" }, ...load.data.platforms.map((p) => ({ value: p, label: platformName(p) }))]}
              onChange={(v) => setPlatform(v || null)}
            />
          ) : null}
          <Link href={settingsHref} className={buttonVariants({ variant: "secondary", size: "sm" })} data-slowest-settings>
            <Settings2 aria-hidden />
            Budgets
          </Link>
        </div>
      </header>

      <p className="flex items-center gap-2 text-xs text-muted" aria-live="polite" data-slowest-live="on">
        <span aria-hidden className={cn("size-1.5 v-live text-success", !fresh && "[&::before]:hidden")} />
        {fresh ? "Updated with a run that just finished" : "Live: updates as runs finish"}
      </p>

      {running.map((r) => (
        <LiveRunStrip key={r.run_id} run={r} href={qaHref({ view: "sessions", platform: nav.platform === "ios" ? null : nav.platform, session: r.run_id })} />
      ))}
      {load.state === "loading" ? <SlowestSkeleton /> : null}
      {load.state === "error" ? <p className="py-6 text-center text-sm text-danger">Could not load the timings: {load.message}</p> : null}
      {load.state === "ready" && load.data.screens.length === 0 ? (
        <PerfTeachingEmpty
          title={live ? "Timing its first screens now" : load.data.total_samples > 0 ? "Every timing so far was noise" : "No screens timed yet"}
          body={
            live
              ? "The run above times every screen it reaches. When it ends, each screen it timed shows here with its time, and after a few runs each one has a usual time to be compared with."
              : load.data.total_samples > 0
                ? allNoise(load.data)
                : "Every run times each screen it reaches: how long until it appears, and on the web how long until it holds still. After a few runs each screen has a usual time, and a screen that gets slower, or crosses a budget, stands out here and on the map."
          }
          action={
            live ? null : load.data.total_samples > 0 ? (
              <Link href={settingsHref} className={buttonVariants({ variant: "secondary" })} data-slowest-noise-cta>
                <Settings2 aria-hidden />
                Noise settings
              </Link>
            ) : (
              <Link href={runsHref} className={buttonVariants({ variant: "primary" })} data-slowest-cta>
                Go to runs
              </Link>
            )
          }
        />
      ) : null}
      {load.state === "ready" && load.data.screens.length > 0 ? <Ranked data={load.data} fresh={fresh} /> : null}
    </div>
  );
}

/** Why a window with samples shows no screen: each one was noise, said with its reasons. */
function allNoise(data: SlowestResponse): string {
  const parts = (Object.entries(data.noise) as [PerfNoise, number][]).filter(([, n]) => n > 0).map(([k, n]) => `${n} ${NOISE_LABEL[k]}`);
  const busy = (data.noise.under_load ?? 0) > 0 ? ` A busy machine makes every screen look slow, so a sample taken while the load was over ${data.settings.load_limit} per core never counts.` : "";
  return `Embodent timed ${data.total_samples} sample${data.total_samples === 1 ? "" : "s"} in this window and left every one out of the comparison (${parts.join(", ")}).${busy} The next clean runs give each screen its usual time.`;
}

/** A round number just over `v` for the shared scale: 1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10 s… */
export function niceMax(v: number): number {
  const steps = [500, 1000, 1500, 2000, 2500, 3000, 4000, 5000, 6000, 8000, 10000, 15000, 20000, 30000, 60000];
  return steps.find((s) => s >= v) ?? Math.ceil(v / 10000) * 10000;
}

/** The replay of a screen that got slower: its usual (a baseline) against its newest time. */
export function replayOf(s: SlowScreen): ReplaySpec | null {
  if (!s.baseline || s.latest <= s.baseline.median * 1.1 || s.metric === "heap" || s.metric === "memory" || s.metric === "cpu") return null;
  return {
    screen: s.label,
    platform: s.platform,
    metric: s.metric,
    frame: s.frame ?? null,
    usualMs: s.baseline.median,
    usualNote: `median of its last ${s.baseline.n} clean samples`,
    nowMs: s.latest,
    nowLabel: "Latest run",
    nowNote: `${fmtDate(s.latest_at)} · ${s.platform === "web" ? platformName(s.platform, s.device_class) : (s.device ?? platformName(s.platform))}`,
    address: s.platform === "web" ? s.key : undefined,
  };
}

function Ranked({ data, fresh }: { data: SlowestResponse; fresh: boolean }) {
  const listRef = useRef<HTMLOListElement | null>(null);
  const screens = data.screens;
  const order = screens.map((s) => `${s.platform}:${s.device_class}:${s.key}`).join("|");
  useFlip(listRef, order);
  // The rows a run just timed (their newest run changed since the last read) light up once.
  const seen = useRef<Map<string, string>>(new Map());
  const [lit, setLit] = useState<Set<string>>(new Set());
  useEffect(() => {
    const next = new Map(screens.map((s) => [`${s.platform}:${s.device_class}:${s.key}`, s.latest_run_id]));
    if (seen.current.size && fresh) {
      setLit(new Set([...next].filter(([k, run]) => seen.current.get(k) !== run).map(([k]) => k)));
    }
    seen.current = next;
  }, [screens, fresh]);
  const max = useMemo(() => niceMax(Math.max(...screens.map((s) => Math.max(s.latest, s.baseline?.p90 ?? 0)), 1)), [screens]);
  const multi = data.platforms.length > 1;
  return (
    <>
      <Pulse data={data} />
      <section aria-label="Screens, slowest first" className="overflow-hidden rounded-xl border border-border bg-panel shadow-[var(--shadow-panel)]">
        <div className="hidden items-end gap-x-4 border-b border-border px-4 pb-2 pt-3 text-[11px] font-medium text-muted @2xl:grid @2xl:grid-cols-[1.75rem_minmax(0,1fr)_8.5rem_6.75rem_8.5rem] @4xl:grid-cols-[1.75rem_minmax(0,1fr)_minmax(10rem,14rem)_8.5rem_6.75rem_8.5rem]" aria-hidden>
          <span />
          <span>Screen</span>
          <span className="hidden @4xl:block">
            <span className="flex justify-between gap-2 tabular">
              <span>0 s</span>
              <span className="truncate">latest against its usual</span>
              <span>{fmtSeconds(max)}</span>
            </span>
          </span>
          <span>Last runs</span>
          <span className="text-right">Latest</span>
          <span className="text-right">How fast</span>
        </div>
        <ol ref={listRef} className="flex flex-col divide-y divide-border">
          {screens.map((s, i) => {
            const k = `${s.platform}:${s.device_class}:${s.key}`;
            return <ScreenRow key={k} flip={k} s={s} rank={i + 1} max={max} lit={lit.has(k)} multi={multi} />;
          })}
        </ol>
      </section>
      <Footnote data={data} />
    </>
  );
}

/** What changed, in one line, and the heat of every screen as counts and one bar. */
function Pulse({ data }: { data: SlowestResponse }) {
  const counts: Record<HeatLevel, number> = { slow: 0, warm: 0, ok: 0 };
  for (const s of data.screens) counts[s.heat] += 1;
  const total = data.screens.length;
  const pct = data.settings.regression_pct / 100;
  const slow = data.screens.filter((s) => s.heat === "slow");
  const regressed = slow.filter((s) => s.delta !== null && s.delta >= pct).sort((a, b) => (b.delta ?? 0) - (a.delta ?? 0));
  const overBudget = slow.filter((s) => s.budget !== null && s.latest > s.budget);
  const lead = regressed[0] ?? overBudget[0] ?? slow[0] ?? null;
  const spec = lead ? replayOf(lead) : null;
  return (
    <section aria-label="Speed at a glance" className="v-rise grid gap-4 rounded-xl border border-border bg-panel p-4 shadow-[var(--shadow-panel)] @3xl:grid-cols-[minmax(0,1fr)_minmax(16rem,22rem)]" data-slowest-pulse>
      <div className="flex min-w-0 items-start gap-3">
        <span
          aria-hidden
          className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-full"
          style={{ background: `color-mix(in srgb, ${lead ? HEAT_FILL.slow : HEAT_FILL.ok} 12%, transparent)`, color: lead ? HEAT_FILL.slow : HEAT_FILL.ok }}
        >
          {lead ? <StopwatchGlyph className="size-[18px]" /> : <CircleCheck className="size-[18px]" />}
        </span>
        <div className="min-w-0">
          {lead ? (
            <>
              <p className="text-[15px] font-semibold text-fg" data-slowest-headline>
                {lead.delta !== null && lead.delta >= pct ? `${lead.label} got slower` : lead.budget !== null && lead.latest > lead.budget ? `${lead.label} is over its budget` : `${lead.label} is slow`}
              </p>
              <p className="mt-0.5 text-sm text-fg-2">
                <span className="font-semibold text-danger tabular">{fmtMetric(lead.metric, lead.latest)}</span> on its latest run
                {lead.baseline ? <>, usually <span className="tabular">{fmtSeconds(lead.baseline.median)}</span></> : null}
                {lead.budget !== null && lead.latest > lead.budget ? <> · budget {fmtSeconds(lead.budget)}</> : null}
                {slow.length > 1 ? <span className="text-muted"> · and {slow.length - 1} more slow</span> : null}
              </p>
              {spec ? (
                <div className="mt-2.5">
                  <SlowdownReplay
                    spec={spec}
                    trigger={(open) => (
                      <Button size="sm" variant="secondary" onClick={open} data-slowest-replay-lead>
                        <Play aria-hidden className="fill-current" />
                        Replay the slowdown
                      </Button>
                    )}
                  />
                </div>
              ) : null}
            </>
          ) : (
            <>
              <p className="text-[15px] font-semibold text-fg" data-slowest-headline>
                Every screen is as fast as usual
              </p>
              <p className="mt-0.5 text-sm text-fg-2">
                {counts.warm ? `${counts.warm} getting slow: within ${data.settings.regression_pct}% of its usual but closer to its line than the rest.` : "None got slower or crossed a budget in this window."}
              </p>
            </>
          )}
        </div>
      </div>
      <div className="flex flex-col justify-center gap-2.5">
        <dl className="grid grid-cols-3 gap-2">
          {(["slow", "warm", "ok"] as const).map((h, i) => (
            <div key={h} className="min-w-0" data-slowest-count={h}>
              <dt className="flex items-center gap-1.5 truncate text-[11px] text-muted">
                <span aria-hidden className="size-1.5 shrink-0 rounded-full" style={{ background: HEAT_FILL[h] }} />
                {HEAT_LABEL[h]}
              </dt>
              <dd className={cn("text-2xl font-semibold leading-8 tabular", counts[h] && h !== "ok" ? (h === "slow" ? "text-danger" : "text-warning") : "text-fg")}>
                <CountUp value={String(counts[h])} delay={120 + i * 80} />
              </dd>
            </div>
          ))}
        </dl>
        <div className="flex h-1.5 w-full gap-0.5 overflow-hidden rounded-full" aria-hidden>
          {(["slow", "warm", "ok"] as const)
            .filter((h) => counts[h] > 0)
            .map((h, i) => (
              <span key={h} className="v-grow-x h-full rounded-full" style={{ width: `${(counts[h] / Math.max(1, total)) * 100}%`, background: HEAT_FILL[h], "--i": i, "--d": "200ms" } as CSSProperties} />
            ))}
        </div>
      </div>
    </section>
  );
}

/** A run of this project timing screens right now: its stopwatch, how many actions so far and
 * the newest ones as they land. Its screens join the list once it ends and syncs. */
function LiveRunStrip({ run, href }: { run: RunningTimings; href: string }) {
  const where = run.platform ? platformName(run.platform) + (run.device && run.platform !== "web" ? ` · ${run.device}` : "") : null;
  const elapsed = useElapsed(run.started_at);
  return (
    <section aria-label="A run timing screens now" className="v-rise overflow-hidden rounded-xl border border-primary/30 bg-panel shadow-[var(--shadow-panel)]" data-slowest-running={run.run_id}>
      <div aria-hidden className="relative h-0.5 overflow-hidden bg-[color-mix(in_srgb,var(--color-primary)_14%,transparent)]">
        <span className={cn("absolute inset-y-0 left-0 w-1/3 bg-primary", motion.sweep)} />
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2.5 px-4 py-3">
        <div className="flex min-w-0 items-center gap-2.5">
          <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
            <StopwatchGlyph running className="size-[18px]" />
          </span>
          <div className="min-w-0" aria-live="polite">
            <p className="text-sm font-medium text-fg">Timing a run now</p>
            <p className="text-xs text-fg-2">
              {run.timed === 0 ? "waiting for its first action" : `${run.timed} action${run.timed === 1 ? "" : "s"} timed`}
              {where ? ` · ${where}` : ""}
              {elapsed ? <span className="tabular text-muted"> · {elapsed} in</span> : null}
            </p>
          </div>
        </div>
        <ol className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5" aria-label="Newest timings">
          {run.latest.map((r) => (
            <li key={r.seq} className={cn("inline-flex max-w-[240px] items-center gap-1.5 rounded-lg border border-border bg-raised px-2 py-1 text-xs shadow-[var(--shadow-sm)]", motion.tick)} data-slowest-tick={r.seq}>
              <span className="truncate text-fg-2">{r.screen ?? "next screen"}</span>
              <span className="tabular font-semibold text-fg">{r.appear_ms !== null ? fmtSeconds(r.appear_ms) : "no change"}</span>
            </li>
          ))}
        </ol>
        <Link href={href} className={buttonVariants({ variant: "secondary", size: "sm" })} data-slowest-watch>
          Watch it live
        </Link>
      </div>
    </section>
  );
}

/** "1:24" since the run started, ticking once a second while it runs. */
function useElapsed(startedAt: string | null): string | null {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!startedAt) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [startedAt]);
  if (!startedAt) return null;
  const t = new Date(startedAt).getTime();
  return Number.isFinite(t) && now >= t ? fmtMs(now - t) : null;
}

function ScreenRow({ s, rank, max, lit, flip, multi }: { s: SlowScreen; rank: number; max: number; lit: boolean; flip: string; multi: boolean }) {
  const platformParam = s.platform === "ios" ? null : s.platform;
  const delta = deltaText(s.delta);
  const spec = s.heat !== "ok" ? replayOf(s) : null;
  const showDelta = delta && s.delta !== null && Math.abs(s.delta) >= 0.1;
  const deltaTone = s.delta !== null && s.delta < 0 ? "text-success" : s.heat === "slow" ? "text-danger" : s.heat === "warm" ? "text-warning" : "text-fg-2";
  const label = `${s.label}: ${s.trend.map((v) => fmtSeconds(v)).join(", ")} over its last ${s.trend.length} run${s.trend.length === 1 ? "" : "s"}${s.baseline ? `; usually ${fmtSeconds(s.baseline.median)}` : ""}`;
  return (
    <li
      data-flip={flip}
      className={cn(
        "relative grid items-center gap-x-4 gap-y-2 px-4 py-3.5 transition-colors hover:bg-[var(--color-hover)]",
        "grid-cols-[1.5rem_minmax(0,1fr)_auto]",
        "@2xl:grid-cols-[1.75rem_minmax(0,1fr)_8.5rem_6.75rem_8.5rem]",
        "@4xl:grid-cols-[1.75rem_minmax(0,1fr)_minmax(10rem,14rem)_8.5rem_6.75rem_8.5rem]",
        s.heat === "slow" && motion.slowRow,
        s.heat === "warm" && motion.warmRow,
        lit && motion.fresh,
        "v-rise",
      )}
      style={{ "--i": Math.min(rank - 1, 12) } as CSSProperties}
      data-slow-screen={s.key}
      data-heat={s.heat}
    >
      <span className={cn("self-start pt-0.5 text-right font-mono text-xs tabular", s.heat === "slow" ? "font-semibold text-danger" : "text-muted")}>{rank}</span>
      <div className="min-w-0 self-start">
        <Link href={qaHref({ view: "map", platform: platformParam, screen: s.node ?? null })} className="block truncate text-sm font-medium text-fg hover:underline" title={`${s.label} on the map`}>
          {s.label}
        </Link>
        <p className="truncate text-xs text-fg-2">
          {multi || s.platform === "web" ? `${platformName(s.platform, s.device_class)}` : platformName(s.platform)}
          {s.device && s.platform !== "web" ? ` · ${s.device}` : ""} · {METRIC_LABEL[s.metric].toLowerCase()} · {s.runs} run{s.runs === 1 ? "" : "s"}
        </p>
        <RankBar value={s.latest} usual={s.baseline} budget={s.budget} max={max} heat={s.heat} index={rank - 1} className="mt-2.5 max-w-[20rem] @4xl:hidden" />
      </div>
      <div className="hidden @4xl:block" title={`${fmtMetric(s.metric, s.latest)} on its latest run${s.baseline ? `, usually ${fmtSeconds(s.baseline.median)} (most runs between ${fmtSeconds(s.baseline.median)} and ${fmtSeconds(s.baseline.p90)})` : ""}${s.budget ? `, budget ${fmtSeconds(s.budget)}` : ""}`}>
        <RankBar value={s.latest} usual={s.baseline} budget={s.budget} max={max} heat={s.heat} index={rank - 1} />
      </div>
      <div className="col-span-2 col-start-2 row-start-2 @2xl:col-span-1 @2xl:col-start-auto @2xl:row-start-auto">
        <PerfSparkline points={s.trend} usual={s.baseline} budget={s.budget} heat={s.heat} label={label} delay={Math.min(rank - 1, 12) * 45} fmt={(v) => fmtMetric(s.metric, v)} />
      </div>
      <div className="col-start-3 row-start-1 flex flex-col items-end self-start @2xl:col-start-auto @2xl:row-start-auto">
        <span className={cn("tabular text-lg font-semibold leading-6", s.heat === "slow" ? "text-danger" : s.heat === "warm" ? "text-warning" : "text-fg")}>
          <CountUp value={fmtMetric(s.metric, s.latest)} duration={700} delay={Math.min(rank - 1, 12) * 45} />
        </span>
        <span className="whitespace-nowrap text-[11px] text-muted">{s.baseline ? `usually ${fmtSeconds(s.baseline.median)}` : "no history yet"}</span>
        {showDelta ? <span className={cn("whitespace-nowrap text-[11px] font-medium", deltaTone)}>{delta}</span> : null}
      </div>
      <div className="col-start-3 row-start-2 flex flex-col items-end gap-1.5 self-start @2xl:col-start-auto @2xl:row-start-auto">
        <HeatBadge heat={s.heat} />
        <span className="flex items-center gap-2.5">
          {spec ? (
            <SlowdownReplay
              spec={spec}
              trigger={(open) => (
                <button type="button" onClick={open} className="inline-flex items-center gap-1 rounded text-[11px] font-medium text-fg-2 outline-none hover:text-fg focus-visible:ring-2 focus-visible:ring-primary/60" data-slow-replay>
                  <Play className="size-3 fill-current" aria-hidden />
                  Replay
                </button>
              )}
            />
          ) : null}
          <Link href={qaHref({ view: "sessions", platform: platformParam, session: s.latest_run_id })} className="text-[11px] text-fg-2 hover:text-fg hover:underline">
            Latest run
          </Link>
        </span>
      </div>
    </li>
  );
}

function Footnote({ data }: { data: SlowestResponse }) {
  const noise = (Object.entries(data.noise) as [PerfNoise, number][]).filter(([, n]) => n > 0);
  const s = data.settings;
  return (
    <div className="flex flex-wrap items-start gap-x-5 gap-y-2 px-1 text-xs text-muted" data-slowest-footnote>
      <span className="flex items-center gap-3" aria-hidden>
        <span className="inline-flex items-center gap-1.5">
          <span className="h-2 w-5 rounded-sm bg-[color-mix(in_srgb,var(--color-fg)_9%,transparent)]" />
          usual range
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="h-3 w-0.5 rounded-full bg-fg" />
          usual
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="h-3 w-0 border-l border-dashed border-fg-2/60" />
          budget
        </span>
      </span>
      <p className="min-w-0 flex-1 basis-[420px]">
        Slow means over budget or {s.regression_pct}% slower than usual; getting slow is two thirds of the way there. The usual time is the median of a screen&apos;s last {s.baseline_runs} clean samples.
        {noise.length ? ` Left out as noise: ${noise.map(([k, n]) => `${n} (${NOISE_LABEL[k]})`).join(", ")}.` : ""}
      </p>
    </div>
  );
}

/** The page as it will be, while it loads: the pulse and a few ranked rows. */
function SlowestSkeleton() {
  return (
    <div className="flex flex-col gap-4" aria-hidden data-slowest-skeleton>
      <div className="grid gap-4 rounded-xl border border-border bg-panel p-4 @3xl:grid-cols-[minmax(0,1fr)_minmax(16rem,22rem)]">
        <div className="flex items-start gap-3">
          <Skeleton className="size-9 shrink-0 rounded-full" />
          <div className="flex flex-1 flex-col gap-2">
            <Skeleton className="h-4 w-56" />
            <Skeleton className="h-3 w-72 opacity-70" />
          </div>
        </div>
        <div className="grid grid-cols-3 gap-2">
          {[0, 1, 2].map((i) => (
            <div key={i} className="flex flex-col gap-1.5">
              <Skeleton className="h-2.5 w-14" delay={i * 60} />
              <Skeleton className="h-6 w-8" delay={i * 60} />
            </div>
          ))}
        </div>
      </div>
      <div className="flex flex-col divide-y divide-border rounded-xl border border-border bg-panel">
        {[0, 1, 2, 3, 4].map((i) => (
          <div key={i} className="flex items-center gap-4 px-4 py-4">
            <Skeleton className="h-3 w-4" delay={i * 70} />
            <div className="flex min-w-0 flex-1 flex-col gap-1.5">
              <Skeleton className="h-3" style={{ width: `${40 - ((i * 9) % 18)}%` }} delay={i * 70} />
              <Skeleton className="h-2.5 w-1/3 opacity-70" delay={i * 70 + 40} />
            </div>
            <Skeleton className="hidden h-6 w-32 @2xl:block" delay={i * 70} />
            <Skeleton className="h-5 w-14" delay={i * 70} />
            <Skeleton className="h-4 w-20" delay={i * 70} />
          </div>
        ))}
      </div>
    </div>
  );
}

function Segmented({ label, value, options, onChange }: { label: string; value: string; options: { value: string; label: string }[]; onChange: (v: string) => void }) {
  return (
    <div role="radiogroup" aria-label={label} className="flex items-center gap-0.5 rounded-lg border border-border bg-raised p-0.5">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          onClick={() => onChange(o.value)}
          className={cn("inline-flex h-6 items-center rounded-md px-2 text-sm transition-colors", value === o.value ? "bg-selected text-fg" : "text-fg-2 hover:text-fg")}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
