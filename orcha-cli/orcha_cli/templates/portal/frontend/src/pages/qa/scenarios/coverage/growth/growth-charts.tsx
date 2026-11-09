import { useState, type CSSProperties } from "react";
import { CountUp } from "../../../map/kit";
import { cn } from "../../../map/kit";
import { chartAreas, nowSegments, pctWords, pointsWords, shortDate, untestedAreas } from "./growth-model";
import { fromTick } from "./growth-hero";
import styles from "./growth.module.css";
import type { CoverageGrowth, GrowthArea } from "./types";

export function Legend() {
  return (
    <ul className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-fg-2" data-growth-legend>
      <li className="inline-flex items-center gap-1.5">
        <span className={cn(styles.swatch, styles.swatchYours)} aria-hidden /> Your tests
      </li>
      <li className="inline-flex items-center gap-1.5">
        <span className={cn(styles.swatch, styles.swatchOrcha)} aria-hidden /> Added by Embodent
      </li>
      <li className="inline-flex items-center gap-1.5">
        <span className={styles.swatchBefore} aria-hidden /> At the baseline
      </li>
    </ul>
  );
}

function AreaRow({ a, i, since }: { a: GrowthArea; i: number; since: string }) {
  const seg = nowSegments(a.now);
  const unknown = a.now.pct === null;
  const total = seg.yours + seg.orcha;
  const tip = unknown
    ? `${a.name}: evidence unknown. No screen here has a result Embodent can count yet.`
    : `${a.name}: ${pctWords(a.before.pct)} at the baseline, ${a.now.pct}% now. Your tests cover ${a.now.by_your_tests} of ${a.now.screens} screens; Embodent adds ${Math.max(0, a.now.covered - a.now.by_your_tests)}.`;
  return (
    <li className={cn(styles.areaRow, "grid grid-cols-[minmax(0,9rem)_1fr_auto] items-center gap-3 px-1.5 py-1.5 sm:grid-cols-[minmax(0,12rem)_1fr_auto]")} data-growth-area={a.key} title={tip}>
      <div className="min-w-0">
        <p className="truncate text-sm font-medium text-fg">{a.name}</p>
        <p className="truncate text-xs text-muted">
          {unknown ? "Evidence unknown" : `${pctWords(a.before.pct)} → ${a.now.pct}%`}
          {a.now.at_risk ? <span className={styles.risk}> · {a.now.at_risk} at risk</span> : null}
        </p>
      </div>
      <div className={styles.track} role="img" aria-label={tip}>
        {unknown ? (
          <span className={cn("absolute inset-0 rounded-[4px] border border-dashed", styles.unknown)} style={{ borderColor: "currentColor" }} />
        ) : (
          <>
            {total > 0 ? (
              <span className={styles.nowBar} style={{ width: `${total}%`, "--i": i, ...fromTick(a.before.pct, total) } as CSSProperties}>
                {seg.yours > 0 ? <span className={cn(styles.seg, styles.segYours, seg.orcha <= 0 && styles.segOnly)} style={{ left: 0, width: `${(seg.yours / total) * 100}%` }} /> : null}
                {seg.orcha > 0 ? (
                  <span className={cn(styles.seg, styles.segOrcha, seg.yours <= 0 && styles.segOnly)} style={{ left: `${(seg.yours / total) * 100}%`, width: `${(seg.orcha / total) * 100}%` }} />
                ) : null}
              </span>
            ) : null}
            {a.before.pct !== null ? <span className={styles.before} style={{ left: `${a.before.pct}%`, "--i": i } as CSSProperties} aria-hidden /> : null}
          </>
        )}
      </div>
      <span
        className={cn(
          "min-w-[5.5rem] text-right text-sm tabular-nums",
          a.points === null ? "text-muted" : a.points > 0 ? "font-semibold text-[color:color-mix(in_oklab,var(--g-orcha)_78%,var(--color-fg))]" : "text-fg-2",
        )}
        data-growth-points={a.points ?? "unknown"}
      >
        {a.points !== null && a.points !== 0 ? <CountUp value={pointsWords(a.points)} delay={500 + i * 55} duration={800} /> : pointsWords(a.points)}
      </span>
      <span className="sr-only">{since ? `since ${shortDate(since)}` : ""}</span>
    </li>
  );
}

/** Baseline against now per area: a tick where it was, the bar where it is (your tests, then Orcha on top). */
export function AreaChart({ report }: { report: CoverageGrowth }) {
  const g = report.growth;
  const rows = chartAreas(g);
  const [table, setTable] = useState(false);
  if (!g) return null;
  return (
    <section aria-labelledby="growth-areas" className="rounded-xl border border-border bg-panel p-4" data-growth-chart>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 id="growth-areas" className="text-sm font-semibold text-fg">
            Baseline vs now, per area
          </h2>
          <p className="text-xs text-muted">Share of each area&apos;s screens covered. Only scenarios that are validated and passed in the last {report.fresh_days} days count.</p>
        </div>
        <div className="flex items-center gap-3">
          <Legend />
          <button type="button" className="text-xs text-fg-2 underline-offset-2 hover:text-fg hover:underline" onClick={() => setTable((t) => !t)} aria-pressed={table} data-growth-table-toggle>
            {table ? "Show chart" : "Show as table"}
          </button>
        </div>
      </div>
      {table ? (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[560px] text-sm" data-growth-table>
            <thead>
              <tr className="border-b border-border text-left text-2xs uppercase tracking-[0.08em] text-muted">
                <th className="py-1.5 pr-3 font-medium">Area</th>
                <th className="py-1.5 pr-3 text-right font-medium">Baseline</th>
                <th className="py-1.5 pr-3 text-right font-medium">Now</th>
                <th className="py-1.5 pr-3 text-right font-medium">Change</th>
                <th className="py-1.5 pr-3 text-right font-medium">Your tests</th>
                <th className="py-1.5 pr-3 text-right font-medium">Embodent</th>
                <th className="py-1.5 text-right font-medium">At risk</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((a) => (
                <tr key={a.key} className="border-b border-border last:border-0">
                  <td className="py-1.5 pr-3 text-fg">{a.name}</td>
                  <td className="py-1.5 pr-3 text-right tabular-nums">{pctWords(a.before.pct)}</td>
                  <td className="py-1.5 pr-3 text-right tabular-nums">{pctWords(a.now.pct)}</td>
                  <td className="py-1.5 pr-3 text-right tabular-nums">{pointsWords(a.points)}</td>
                  <td className="py-1.5 pr-3 text-right tabular-nums">{a.now.by_your_tests}/{a.now.screens}</td>
                  <td className="py-1.5 pr-3 text-right tabular-nums">{a.now.by_orcha}/{a.now.screens}</td>
                  <td className="py-1.5 text-right tabular-nums">{a.now.at_risk ?? 0}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <ul className="flex flex-col">
          {rows.map((a, i) => (
            <AreaRow key={a.key} a={a} i={i} since={g.since} />
          ))}
        </ul>
      )}
      {!table ? <ChartFoot shown={rows.length} all={g.areas.length} untested={untestedAreas(g)} /> : null}
    </section>
  );
}

/** Under the chart: the areas nothing covers yet, named, and how many more the table holds. */
function ChartFoot({ shown, all, untested }: { shown: number; all: number; untested: GrowthArea[] }) {
  const more = all - shown - untested.length;
  if (!untested.length && more <= 0) return null;
  const names = untested.slice(0, 4).map((a) => a.name);
  return (
    <p className="mt-2 text-xs text-muted" data-growth-untested={untested.length}>
      {untested.length ? (
        <>
          {untested.length} {untested.length === 1 ? "area has" : "areas have"} nothing covered yet: {names.join(", ")}
          {untested.length > names.length ? `, and ${untested.length - names.length} more` : ""}.{" "}
        </>
      ) : null}
      {more > 0 ? `${more} more ${more === 1 ? "area" : "areas"} in the table view.` : untested.length ? "All of them are in the table view." : null}
    </p>
  );
}
