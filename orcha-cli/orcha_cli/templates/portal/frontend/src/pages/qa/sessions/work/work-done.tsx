import { useLayoutEffect, useRef, type CSSProperties, type ReactNode } from "react";
import { CountUp } from "../../map/kit";
import { cn } from "../../map/kit";
import styles from "./work.module.css";

export interface WorkTile {
  label: string;
  value: string;
  /** A quiet line under the value. */
  hint?: string;
}

/**
 * The top of every job's done view: the ring (a score, or how much of the output is
 * reviewed), the verdict line, an aside (an exploration's lens bars), and one row of tiles in
 * the same shape everywhere. Rings fill and numbers count up once; under reduced motion they
 * simply appear.
 */
export function WorkSummary({
  ring,
  verdict,
  aside,
  tiles,
  note,
  className,
}: {
  ring: ReactNode;
  verdict: ReactNode;
  aside?: ReactNode;
  tiles: readonly WorkTile[];
  /** A banner above the summary (stopped early, needs setup). */
  note?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-col gap-3", className)} data-work-summary>
      {note}
      <div className="flex flex-col gap-4 rounded-lg border border-border bg-panel p-4 sm:flex-row sm:items-center" data-scoreboard>
        <div className={cn("flex items-center gap-4", aside ? "sm:w-[46%]" : "flex-1")}>
          {ring}
          <div className="min-w-0 text-lg font-semibold leading-7 text-fg" data-verdict>
            {verdict}
          </div>
        </div>
        {aside ? <div className="min-w-0 flex-1">{aside}</div> : null}
      </div>
      {tiles.length > 0 ? <WorkTiles tiles={tiles} /> : null}
    </div>
  );
}

export function WorkTiles({ tiles, className }: { tiles: readonly WorkTile[]; className?: string }) {
  return (
    <dl
      className={cn("grid grid-cols-2 gap-2", tiles.length >= 4 ? "sm:grid-cols-4" : tiles.length === 3 ? "sm:grid-cols-3" : "", tiles.length > 4 && "lg:grid-cols-6", className)}
      data-work-tiles
    >
      {tiles.map((t, i) => (
        <div key={t.label} className={cn("flex min-w-0 flex-col gap-0.5 rounded-lg border border-border bg-panel px-3 py-2", styles.cascade)} style={{ "--i": i } as CSSProperties} data-work-tile={t.label}>
          <dt className="truncate text-xs text-muted">{t.label}</dt>
          <dd className="truncate text-base font-semibold tabular text-fg">
            <CountUp value={t.value} delay={i * 60} />
          </dd>
          {t.hint ? <span className="truncate text-2xs text-muted">{t.hint}</span> : null}
        </div>
      ))}
    </dl>
  );
}

function reducedMotion(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return true;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/**
 * A count against a whole as a ring ("4 of 16 accepted"), for jobs whose output is a pile to
 * review rather than a score. Neutral ink, never the red of a poor score.
 */
export function CountRing({
  value,
  of,
  label,
  size = 96,
  stroke = 6,
}: {
  value: number;
  of: number;
  /** What the count is ("accepted"), for the caption and screen readers. */
  label: string;
  size?: number;
  stroke?: number;
}) {
  const ref = useRef<SVGCircleElement>(null);
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const frac = of > 0 ? Math.max(0, Math.min(1, value / of)) : 0;
  const offset = c * (1 - frac);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || reducedMotion() || typeof el.animate !== "function") return;
    const anim = el.animate([{ strokeDashoffset: String(c) }, { strokeDashoffset: String(offset) }], { duration: 900, easing: "cubic-bezier(0.3, 0.6, 0.2, 1)" });
    return () => anim.cancel();
  }, [c, offset]);
  return (
    <span role="img" aria-label={`${value} of ${of} ${label}`} className="relative inline-flex shrink-0 items-center justify-center" style={{ width: size, height: size }} data-count-ring={`${value}/${of}`}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden className="-rotate-90">
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--color-border)" strokeWidth={stroke} />
        <circle
          ref={ref}
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke="var(--color-primary)"
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={c}
          strokeDashoffset={offset}
        />
      </svg>
      <span className="absolute inset-0 flex flex-col items-center justify-center leading-none" aria-hidden>
        <span className="text-2xl font-semibold tabular text-fg">
          <CountUp value={String(value)} />
        </span>
        <span className="mt-1 text-2xs text-muted">
          of {of} {label}
        </span>
      </span>
    </span>
  );
}

/** One section of a done view: the same heading everywhere ("What Orcha learned", "Outputs"). */
export function WorkSection({ title, count, id, children, action }: { title: string; count?: ReactNode; id: string; children: ReactNode; action?: ReactNode }) {
  return (
    <section className="flex flex-col gap-3" aria-labelledby={`sec-${id}`} data-report-section={id} data-work-section={id}>
      <h2 id={`sec-${id}`} className="flex items-baseline gap-2 text-base font-semibold text-fg">
        {title}
        {count != null ? <span className="text-sm font-normal tabular text-muted">{count}</span> : null}
        {action ? <span className="ml-auto self-center text-sm font-normal">{action}</span> : null}
      </h2>
      {children}
    </section>
  );
}

export interface WorkOutput {
  key: string;
  icon: ReactNode;
  title: string;
  detail?: ReactNode;
  /** Its next step: Review drafts, Open findings, Run suites. */
  action?: ReactNode;
  /** Extra data attributes for the card (tests, deep links). */
  data?: Record<`data-${string}`, string>;
}

/** What the job produced, each with its next step, as one row of cards. */
export function WorkOutputs({ items, className }: { items: readonly WorkOutput[]; className?: string }) {
  if (items.length === 0) return null;
  return (
    <ul className={cn("grid grid-cols-1 gap-2 sm:grid-cols-2", items.length >= 3 && "xl:grid-cols-3", className)} data-work-outputs>
      {items.map((o, i) => (
        <li key={o.key} className={cn("flex flex-col gap-2 rounded-lg border border-border bg-panel p-3", styles.cascade)} style={{ "--i": i } as CSSProperties} data-work-output={o.key} {...o.data}>
          <span className="flex items-start gap-2">
            <span aria-hidden className="mt-0.5 shrink-0 text-fg-2 [&_svg]:size-4">
              {o.icon}
            </span>
            <span className="flex min-w-0 flex-col gap-0.5">
              <span className="text-sm font-medium text-fg">{o.title}</span>
              {o.detail ? <span className="text-xs text-muted">{o.detail}</span> : null}
            </span>
          </span>
          {o.action ? <span className="flex flex-wrap items-center gap-1.5">{o.action}</span> : null}
        </li>
      ))}
    </ul>
  );
}

/** The page body of every job: the same width and gutters, so moving from one job to another
 * never jumps. */
export function WorkPage({ children, className, ...rest }: { children: ReactNode; className?: string } & Record<`data-${string}`, string | undefined>) {
  return (
    <div className={cn("mx-auto flex w-full max-w-[1480px] flex-col gap-6 px-5 py-5 max-[720px]:px-4 max-[720px]:py-4", className)} data-work-page {...rest}>
      {children}
    </div>
  );
}
