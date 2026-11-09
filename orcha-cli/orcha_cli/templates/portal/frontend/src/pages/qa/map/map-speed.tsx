import { useEffect, useState, type CSSProperties } from "react";
import { ArrowRight, Gauge } from "./kit/icons";
import { cn, CountUp, Link } from "./kit";
import type { Platform } from "../qaApi";
import { HEAT_LABEL, fmtMetric, heatByScreen, type HeatLevel, type SlowScreen } from "./perf/perf";
import { loadSlowest } from "./perf/api";
import styles from "./map-speed.module.css";

const HEAT_COLOR: Record<HeatLevel, string> = { slow: "var(--color-danger)", warm: "var(--color-warning)", ok: "var(--color-success)" };

/** What a screen card shows when the speed overlay is on: its heat and its newest time. */
export interface HeatMark {
  heat: HeatLevel;
  label: string;
  title: string;
}

export function heatMark(s: SlowScreen): HeatMark {
  const value = fmtMetric(s.metric, s.latest);
  const usual = s.baseline ? `, usually ${fmtMetric(s.metric, s.baseline.median)}` : "";
  return { heat: s.heat, label: value, title: `${HEAT_LABEL[s.heat]}: ${value}${usual}` };
}

/**
 * The Map's speed overlay: each screen's heat from Slowest screens, read when the overlay
 * is turned on (and again when the platform changes). Null while off or loading.
 */
export function useSpeedHeat(cid: string, on: boolean, platform: Platform | null): Map<string, HeatMark> | null {
  const [marks, setMarks] = useState<Map<string, HeatMark> | null>(null);
  useEffect(() => {
    if (!on || !cid) return;
    const ctl = new AbortController();
    loadSlowest(cid, 30, null, ctl.signal)
      .then((data) => {
        if (!ctl.signal.aborted) setMarks(new Map([...heatByScreen(data.screens, platform)].map(([k, s]) => [k, heatMark(s)])));
      })
      .catch(() => undefined);
    return () => ctl.abort();
  }, [cid, on, platform]);
  return on ? marks : null;
}

/**
 * A timed screen card's speed: a glow of its heat behind the card and its newest time as a
 * badge. The glow fades in after a delay taken from the card's place on the map (`x`), so turning
 * the overlay on sweeps across the map from the left. The word is the badge's title and
 * screen-reader text; the colour is never the only signal.
 */
export function SpeedMark({ mark, x = 0 }: { mark: HeatMark; x?: number }) {
  const style = { "--hd": `${Math.round(Math.min(1100, Math.max(0, x) * 0.11))}ms` } as CSSProperties;
  return (
    <>
      <span aria-hidden className={styles.glow} data-heat={mark.heat} style={style} data-map-heat-glow />
      <span className={styles.badge} data-heat={mark.heat} title={mark.title} style={style} data-map-heat>
        <span className="sr-only">{mark.title}</span>
        <span aria-hidden className={styles.badgeDot} />
        <span aria-hidden>{mark.label}</span>
      </span>
    </>
  );
}

export function SpeedChip({ on, onToggle, count }: { on: boolean; onToggle: () => void; count: number | null }) {
  return (
    <button
      type="button"
      aria-pressed={on}
      onClick={onToggle}
      title={on ? "Hide screen speed" : "Colour each screen by how fast it appears"}
      className={cn(
        "inline-flex h-7 items-center gap-1 rounded-lg border border-border bg-raised px-2 text-sm shadow-[var(--shadow-sm)] transition-colors",
        on ? "bg-selected text-fg" : "text-fg-2 hover:text-fg",
      )}
      data-map-speed-chip
    >
      <Gauge className={cn("size-3.5 transition-colors", on && "text-danger")} aria-hidden />
      Speed
      {on && count !== null ? <span className="tabular-nums text-muted">{count}</span> : null}
    </button>
  );
}

/** The overlay's key, floating over the canvas's top left while it is on: what the glow means,
 * each heat's count and one bar of all three, and the way to the ranked list. */
export function SpeedLegend({ marks, href = null, top = 56 }: { marks: Map<string, HeatMark> | null; href?: string | null; top?: number }) {
  const counts: Record<HeatLevel, number> = { slow: 0, warm: 0, ok: 0 };
  for (const m of marks?.values() ?? []) counts[m.heat] += 1;
  const total = counts.slow + counts.warm + counts.ok;
  return (
    <div
      className="v-pop absolute left-4 z-10 w-[296px] rounded-xl border border-border bg-raised/95 px-3 py-2.5 text-xs text-fg-2 shadow-[var(--shadow-md)] backdrop-blur-sm"
      style={{ top }}
      data-map-speed-legend
      aria-live="polite"
    >
      <p className="mb-2 flex items-center gap-1.5 font-medium text-fg">
        <Gauge className="size-3.5 text-fg-2" aria-hidden />
        Screen speed
        <span className="font-normal text-muted">· last 30 days</span>
      </p>
      {marks === null ? (
        <div className="flex flex-col gap-2" aria-label="Reading screen timings">
          <span className="v-skeleton block h-1.5 w-full rounded-full" aria-hidden />
          <span className="text-muted">Reading screen timings…</span>
        </div>
      ) : marks.size === 0 ? (
        <p className="text-muted">No screen timed in the last 30 days yet. Each run times the screens it reaches; they glow here once timed.</p>
      ) : (
        <>
          <span className="flex h-1.5 w-full gap-0.5 overflow-hidden rounded-full" aria-hidden>
            {(["slow", "warm", "ok"] as const)
              .filter((h) => counts[h] > 0)
              .map((h, i) => (
                <span key={h} className={cn("h-full rounded-full", styles.legendBar)} style={{ width: `${(counts[h] / total) * 100}%`, background: HEAT_COLOR[h], "--d": `${120 + i * 140}ms` } as CSSProperties} />
              ))}
          </span>
          <dl className="mt-2 grid grid-cols-3 gap-3">
            {(["slow", "warm", "ok"] as const).map((h) => (
              <div key={h} className="min-w-0">
                <dt className="flex items-center gap-1 truncate text-[11px]">
                  <span aria-hidden className="size-2 shrink-0 rounded-full" style={{ background: HEAT_COLOR[h], boxShadow: `0 0 6px ${HEAT_COLOR[h]}` }} />
                  {HEAT_LABEL[h]}
                </dt>
                <dd className={cn("pl-3 text-base font-semibold tabular-nums leading-5", counts[h] && h === "slow" ? "text-danger" : counts[h] && h === "warm" ? "text-warning" : "text-fg")}>
                  <CountUp value={String(counts[h])} duration={600} delay={200} />
                </dd>
              </div>
            ))}
          </dl>
          {href ? (
            <Link href={href} className="mt-2 inline-flex items-center gap-1 font-medium text-fg-2 hover:text-fg" data-map-speed-list>
              Slowest screens
              <ArrowRight className="size-3" aria-hidden />
            </Link>
          ) : null}
        </>
      )}
    </div>
  );
}
