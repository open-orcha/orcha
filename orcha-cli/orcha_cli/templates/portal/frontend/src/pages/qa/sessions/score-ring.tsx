import { useLayoutEffect, useRef } from "react";
import { CountUp } from "./../map/kit";
import type { LensGrade } from "./explorations";
import { cn } from "./../map/kit";

/** The contract's grade bands: good >= 80, fair >= 50, else poor; no score is unknown. */
export function gradeFor(score: number | null | undefined): LensGrade {
  if (score == null || !Number.isFinite(score)) return "unknown";
  if (score >= 80) return "good";
  if (score >= 50) return "fair";
  return "poor";
}

export const GRADE_STROKE: Readonly<Record<LensGrade, string>> = {
  good: "var(--color-success)",
  fair: "var(--color-warning)",
  poor: "var(--color-danger)",
  unknown: "var(--color-muted)",
};

function reducedMotion(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return true;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/**
 * A 0-100 score as a ring that fills while the number counts up (Web Animations API on the
 * stroke, `CountUp` for the digits). The server render is the final state, so screen readers
 * and tests read the real score; under reduced motion it simply appears. `score` null draws an
 * empty ring with a dash (not scored yet). `delta` adds "+12" or "-4" under the number.
 */
export function ScoreRing({
  score,
  size = 56,
  stroke = 5,
  grade,
  delta,
  label = "Score",
  className,
}: {
  score: number | null | undefined;
  size?: number;
  stroke?: number;
  /** Overrides the grade the score implies (a lens graded "unknown" that still has a number). */
  grade?: LensGrade;
  delta?: number | null;
  /** What the score is of, for screen readers ("Score", "Accessible"). */
  label?: string;
  className?: string;
}) {
  const ref = useRef<SVGCircleElement>(null);
  const value = score == null || !Number.isFinite(score) ? null : Math.max(0, Math.min(100, Math.round(score)));
  const g = grade ?? gradeFor(value);
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const offset = value == null ? c : c * (1 - value / 100);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || value == null || reducedMotion() || typeof el.animate !== "function") return;
    const anim = el.animate([{ strokeDashoffset: String(c) }, { strokeDashoffset: String(offset) }], {
      duration: 900,
      easing: "cubic-bezier(0.3, 0.6, 0.2, 1)",
    });
    return () => anim.cancel();
  }, [value, c, offset]);

  const d = delta == null || !Number.isFinite(delta) ? 0 : Math.round(delta);
  const deltaText = d === 0 ? null : `${d > 0 ? "+" : ""}${d}`;
  const aria =
    value == null
      ? `${label}: not scored yet`
      : `${label}: ${value} of 100${deltaText ? `, ${deltaText} since the previous one` : ""}`;

  return (
    <span
      role="img"
      aria-label={aria}
      data-score-ring={value ?? ""}
      className={cn("relative inline-flex shrink-0 items-center justify-center", className)}
      style={{ width: size, height: size }}
    >
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden className="-rotate-90">
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--color-border)" strokeWidth={stroke} />
        <circle
          ref={ref}
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke={GRADE_STROKE[g]}
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={c}
          strokeDashoffset={offset}
        />
      </svg>
      <span aria-hidden className="absolute inset-0 flex flex-col items-center justify-center leading-none">
        <span className="font-semibold tabular text-fg" style={{ fontSize: Math.max(10, Math.round(size * 0.3)) }}>
          {value == null ? "-" : <CountUp value={String(value)} />}
        </span>
        {deltaText && size >= 48 ? (
          <span className={cn("mt-0.5 text-[10px] tabular", d > 0 ? "text-success" : "text-danger")}>{deltaText}</span>
        ) : null}
      </span>
    </span>
  );
}
