import type { CSSProperties } from "react";
import { ArrowRight, History, RefreshCw, TrendingDown, TrendingUp } from "../../../map/kit/icons";
import { Button } from "../../../map/kit";
import { cn } from "../../../map/kit";
import { CoverageSteps } from "../coverage-states";
import { ago } from "../panel-model";
import { daysSince, growthSteps, overallSegments, pointsWords, remeasureWords, shortDate } from "./growth-model";
import styles from "./growth.module.css";
import { useTween } from "./motion";
import { TRIGGER_WORDS, type CoverageGrowth } from "./types";

/** `--from` for a bar that grows from its baseline tick: the tick's share of the bar's width. */
export function fromTick(before: number | null, now: number): CSSProperties {
  if (before === null || now <= 0) return { "--from": 0 } as CSSProperties;
  return { "--from": Math.min(3, Math.max(0, before / now)).toFixed(3) } as CSSProperties;
}

/**
 * The headline of Coverage › Growth: where coverage started, where it is now (the number climbs
 * from the baseline's figure), the points, and one meter of every screen with the baseline's
 * tick. "Measure again" tells its story here: the steps run under the meter while a band sweeps
 * it, and the landing says what changed.
 */
export function GrowthHero({ report, now, measuring, landed, rebaseOpen, onMeasure, onRebaseline }: {
  report: CoverageGrowth;
  now: number;
  measuring: boolean;
  /** The previous figure, once a fresh measurement landed (the landing chip says what changed). */
  landed: { before: number | null } | null;
  rebaseOpen: boolean;
  onMeasure: () => void;
  onRebaseline: () => void;
}) {
  const g = report.growth!;
  const base = report.baseline!;
  const o = g.overall;
  const t = report.now.totals;
  const pct = useTween(o.now.pct, { from: o.before.pct ?? 0, duration: 1200, delay: 250 });
  const seg = overallSegments(report);
  const nowPct = seg.yours + seg.orcha;
  const days = daysSince(base.taken_at, now);
  const points = o.points;
  const tone = points === null ? "flat" : points > 0 ? "up" : points < 0 ? "down" : "flat";
  const landing = landed ? remeasureWords(landed.before, o.now.pct) : null;
  const tip = `${o.now.covered} of ${o.now.screens} screens covered now: your tests ${o.now.by_your_tests}, Embodent ${o.now.by_orcha}${o.before.pct !== null ? `. ${o.before.pct}% at the baseline on ${shortDate(base.taken_at)}` : ""}.`;

  return (
    <section className={cn(styles.hero, "p-5 md:p-6")} aria-labelledby="growth-headline" data-growth-hero>
      <div className="flex flex-col gap-5 lg:flex-row lg:items-start lg:justify-between">
        <div className="min-w-0">
          <p className="text-xs font-medium uppercase tracking-[0.08em] text-muted">
            Since {shortDate(base.taken_at)}, {TRIGGER_WORDS[base.trigger]}
            {days !== null && days > 0 ? <span className="normal-case tracking-normal"> · {days} {days === 1 ? "day" : "days"}</span> : null}
          </p>
          <h2 id="growth-headline" className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-2" data-growth-headline>
            <span className="sr-only">{g.headline}</span>
            <span aria-hidden className="flex items-baseline gap-3">
              <span className={cn(styles.beforeNum, "text-muted")} title="At the baseline">
                {o.before.pct === null ? "?" : `${o.before.pct}%`}
              </span>
              <ArrowRight className="size-5 self-center text-muted" strokeWidth={1.75} />
              <span className={cn(styles.bigNum, "text-fg")} data-growth-now-pct>
                {pct === null ? "unknown" : `${pct}%`}
              </span>
            </span>
            <span
              aria-hidden
              className={cn(styles.pill, tone === "up" ? styles.pillUp : tone === "down" ? styles.pillDown : styles.pillFlat, styles.landed)}
              style={{ animationDelay: "900ms" }}
              data-growth-points-total
            >
              {tone === "up" ? <TrendingUp className="size-3.5" aria-hidden /> : tone === "down" ? <TrendingDown className="size-3.5" aria-hidden /> : null}
              {pointsWords(points)}
            </span>
          </h2>
          <p className="mt-2 text-sm text-fg-2" data-growth-now>
            <span className="font-medium tabular-nums text-fg">{o.now.covered}</span> of {o.now.screens} {o.now.screens === 1 ? "screen" : "screens"} covered: <span className="tabular-nums">{o.now.by_your_tests}</span> by your tests,{" "}
            <span className="tabular-nums">{o.now.by_orcha}</span> by Embodent
            {t.at_risk ? <span className={styles.risk}>, {t.at_risk} at risk</span> : null}.
          </p>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2 lg:justify-end">
          <span className="text-xs text-muted" aria-live="polite">
            {measuring ? "Measuring now…" : `Measured ${ago(report.computed_at, now) || "just now"}${report.refreshing ? ", updating…" : ""}`}
          </span>
          <Button onClick={onMeasure} disabled={measuring} aria-busy={measuring} data-growth-recompute>
            <RefreshCw className={measuring ? "animate-spin" : undefined} /> Measure again
          </Button>
          <Button onClick={onRebaseline} aria-expanded={rebaseOpen} data-growth-rebaseline>
            <History /> Re-baseline
          </Button>
        </div>
      </div>

      <div className="mt-8" role="img" aria-label={tip}>
        <div className={styles.meter}>
          {nowPct > 0 ? (
            <span className={styles.meterFill} style={{ width: `${nowPct}%`, ...fromTick(seg.before, nowPct) }}>
              {seg.yours > 0 ? <span style={{ width: `${(seg.yours / nowPct) * 100}%`, background: "var(--g-yours)" }} /> : null}
              {seg.orcha > 0 ? (
                <span style={{ width: `${(seg.orcha / nowPct) * 100}%`, background: "var(--g-orcha)", boxShadow: seg.yours > 0 ? "-2px 0 0 0 var(--color-panel)" : undefined }} />
              ) : null}
            </span>
          ) : null}
          {seg.before !== null ? (
            <span className={styles.meterTick} style={{ left: `${seg.before}%` }}>
              <span className={styles.meterTickLabel}>Baseline {seg.before}%</span>
            </span>
          ) : null}
          {measuring ? <span className={styles.scan} aria-hidden /> : null}
        </div>
        <div className="mt-2.5 flex flex-wrap items-center justify-between gap-x-4 gap-y-1 text-xs text-fg-2" aria-hidden>
          <span className="flex flex-wrap items-center gap-x-4 gap-y-1">
            <span className="inline-flex items-center gap-1.5">
              <span className={cn(styles.swatch, styles.swatchYours)} /> Your tests <span className="tabular-nums text-muted">{o.now.by_your_tests}</span>
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span className={cn(styles.swatch, styles.swatchOrcha)} /> Added by Embodent <span className="tabular-nums text-muted">{Math.max(0, o.now.covered - o.now.by_your_tests)}</span>
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span className={styles.swatchBefore} /> At the baseline
            </span>
          </span>
          <span className="tabular-nums text-muted">100% = {o.now.screens} screens</span>
        </div>
      </div>

      <div className="mt-3 min-h-6" aria-live="polite">
        {measuring ? (
          <div className="py-0.5" data-growth-measuring>
            <CoverageSteps steps={growthSteps({ screens: t.screens, flows: report.now.flows.length })} compact row />
          </div>
        ) : landing ? (
          <p
            key={report.computed_at}
            className={cn(styles.landed, "inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium", landing.tone === "up" ? styles.pillUp : landing.tone === "down" ? styles.pillDown : styles.pillFlat)}
            data-growth-landed={landing.tone}
          >
            {landing.text}
          </p>
        ) : report.weekly ? (
          <p className="flex items-center gap-1.5 text-sm text-fg-2" data-growth-weekly>
            <TrendingUp className="size-3.5 text-[var(--g-orcha)]" aria-hidden />
            {report.weekly}
          </p>
        ) : (
          <p className="text-xs text-muted" data-growth-weekly="none">
            This week&apos;s change shows here once a daily point is a week old.
          </p>
        )}
        {!base.same_rules ? <p className="mt-1 text-xs text-muted">The baseline was measured with older rules, so this comparison is approximate.</p> : null}
      </div>
    </section>
  );
}
