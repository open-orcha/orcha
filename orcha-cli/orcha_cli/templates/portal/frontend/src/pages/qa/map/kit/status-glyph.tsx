import type { CSSProperties, ReactNode } from "react";
import { cn } from "./cn";

/**
 * The ONE Linear-style status glyph set (shared with Orcha V2's `StatusGlyph`, D8).
 * Every status has its own SHAPE, not just its own colour, so status is never colour-only,
 * and every glyph carries an accessible name (`aria-label`, default = the status label).
 *
 *   pass           filled circle + check          success
 *   fail           filled circle + ✕              danger
 *   warning        ring + "!"                     amber (sev-minor)
 *   inconclusive   ring + centre dot              amber (sev-minor)
 *   blocked        ring + bar (⊖)                 muted
 *   unprocessable  ring + slash (⊘)               muted
 *   needs_setup    ring + plug                    info blue: could not be tested here (not a failure)
 *   running        ring + half pie, rotating      progress yellow
 *   queued         empty ring                     muted
 *   pending        dashed ring                    muted
 *   cancelled      filled circle + slash          muted
 *   flaky          ring + wave                    amber (warning)
 *   replayed       ring + check                   teal (chart-2, deterministic replay)
 *   mixed          ring + left half filled        orange (sev-major): some passed, some failed
 *   errored        ring + "!"                     danger: stopped before a verdict
 *   unknown        faint ring
 */
export type GlyphStatus =
  | "pass"
  | "fail"
  | "warning"
  | "inconclusive"
  | "blocked"
  | "unprocessable"
  | "needs_setup"
  | "running"
  | "queued"
  | "pending"
  | "cancelled"
  | "flaky"
  | "replayed"
  | "mixed"
  | "errored"
  | "unknown";

/** Aliases (verdicts, run statuses, criterion outcomes). */
const ALIASES: Record<string, GlyphStatus> = {
  pass: "pass",
  passed: "pass",
  completed: "pass",
  success: "pass",
  ok: "pass",
  fail: "fail",
  failed: "fail",
  error: "fail",
  warning: "warning",
  warn: "warning",
  inconclusive: "inconclusive",
  blocked: "blocked",
  unprocessable: "unprocessable",
  needs_setup: "needs_setup",
  running: "running",
  in_progress: "running",
  live: "running",
  queued: "queued",
  not_started: "queued",
  idle: "queued",
  pending: "pending",
  waiting: "pending",
  cancelled: "cancelled",
  canceled: "cancelled",
  stopped: "cancelled",
  skipped: "cancelled",
  flaky: "flaky",
  replayed: "replayed",
  mixed: "mixed",
  partial: "mixed",
  errored: "errored",
};

export function glyphStatus(status: string | null | undefined): GlyphStatus {
  if (!status) return "unknown";
  return ALIASES[status.toLowerCase()] ?? "unknown";
}

export const GLYPH_LABEL: Record<GlyphStatus, string> = {
  pass: "Passed",
  fail: "Failed",
  warning: "Warning",
  inconclusive: "Inconclusive",
  blocked: "Blocked",
  unprocessable: "Unprocessable",
  needs_setup: "Needs setup",
  running: "Running",
  queued: "Queued",
  pending: "Pending",
  cancelled: "Cancelled",
  flaky: "Flaky",
  replayed: "Replayed",
  mixed: "Mixed",
  errored: "Errored",
  unknown: "Unknown",
};

/** Text colour utility per status (the glyph paints with `currentColor`). */
export const GLYPH_COLOR: Record<GlyphStatus, string> = {
  pass: "text-success",
  fail: "text-danger",
  warning: "text-sev-minor",
  inconclusive: "text-sev-minor",
  blocked: "text-muted",
  unprocessable: "text-muted",
  needs_setup: "text-info",
  running: "text-progress",
  queued: "text-muted",
  pending: "text-muted",
  cancelled: "text-muted",
  flaky: "text-warning",
  replayed: "text-chart-2",
  mixed: "text-sev-major",
  errored: "text-danger",
  unknown: "text-muted",
};

// 14×14 grid, centre (7,7). Ring r=5.5 stroke 1.5; inner pie r=2.6; filled disc r=6.25.
const RING = { cx: 7, cy: 7, r: 5.5, fill: "none", stroke: "currentColor", strokeWidth: 1.5 } as const;
/** Marks knocked out of a filled disc paint with the surface the glyph sits on. */
const CUT = "var(--glyph-cut, var(--color-bg))";
const LINE = {
  fill: "none",
  strokeWidth: 1.5,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
};

/** The running pie spins about the glyph centre (static under reduced motion). */
const RUNNING_PIE_STYLE: CSSProperties = { transformOrigin: "7px 7px", transformBox: "view-box" };

function Filled({ children }: { children?: ReactNode }) {
  return (
    <>
      <circle cx={7} cy={7} r={6.25} fill="currentColor" />
      {children}
    </>
  );
}

function Shape({ s }: { s: GlyphStatus }) {
  switch (s) {
    case "pass":
      return (
        <Filled>
          <path d="M4.4 7.2 6.2 9 9.6 5.2" stroke={CUT} {...LINE} />
        </Filled>
      );
    case "fail":
      return (
        <Filled>
          <path d="M5 5l4 4M9 5 5 9" stroke={CUT} {...LINE} />
        </Filled>
      );
    case "cancelled":
      return (
        <Filled>
          <path d="M4.9 9.1 9.1 4.9" stroke={CUT} {...LINE} />
        </Filled>
      );
    case "mixed":
      return (
        <>
          <circle {...RING} />
          <path d="M7 2.6A4.4 4.4 0 0 0 7 11.4z" fill="currentColor" />
        </>
      );
    case "warning":
    case "errored":
      return (
        <>
          <circle {...RING} />
          <path d="M7 4.3v3.4" stroke="currentColor" {...LINE} strokeWidth={1.6} />
          <circle cx={7} cy={9.6} r={0.9} fill="currentColor" />
        </>
      );
    case "inconclusive":
      return (
        <>
          <circle {...RING} />
          <circle cx={7} cy={7} r={2} fill="currentColor" />
        </>
      );
    case "blocked":
      return (
        <>
          <circle {...RING} />
          <path d="M4.6 7h4.8" stroke="currentColor" {...LINE} strokeWidth={1.6} />
        </>
      );
    case "unprocessable":
      return (
        <>
          <circle {...RING} />
          <path d="M3.4 10.6 10.6 3.4" stroke="currentColor" {...LINE} />
        </>
      );
    case "needs_setup":
      return (
        <>
          <circle {...RING} />
          <path d="M5.8 4.2v1.6M8.2 4.2v1.6M4.8 5.8h4.4v1.1a2.2 2.2 0 0 1-4.4 0zM7 9.1v1.3" stroke="currentColor" {...LINE} strokeWidth={1.2} />
        </>
      );
    case "running":
      return (
        <>
          <circle {...RING} />
          <path
            d="M7 7V4.4A2.6 2.6 0 0 1 7 9.6z"
            fill="currentColor"
            className="motion-safe:animate-[spin_1.6s_linear_infinite]"
            style={RUNNING_PIE_STYLE}
          />
        </>
      );
    case "queued":
      return <circle {...RING} />;
    case "pending":
      return <circle {...RING} strokeDasharray="2.05 1.9" />;
    case "flaky":
      return (
        <>
          <circle {...RING} />
          <path d="M4.2 7.4c.7-1 1.4-1 2.1 0s1.4 1 2.1 0 1.4-1 1.4-.4" stroke="currentColor" {...LINE} strokeWidth={1.3} />
        </>
      );
    case "replayed":
      return (
        <>
          <circle {...RING} />
          <path d="M4.9 7.1 6.4 8.6 9.2 5.5" stroke="currentColor" {...LINE} strokeWidth={1.4} />
        </>
      );
    default:
      return <circle {...RING} strokeOpacity={0.6} />;
  }
}

export interface StatusGlyphProps {
  /** A status (`pass`, `failed`, `running`, `queued`, …); unknown values render a faint ring. */
  status: GlyphStatus | string | null | undefined;
  /** Accessible name; defaults to the status label ("Passed", "Running", …). */
  label?: string;
  /** Pixel size; omit to size with classes (default `size-3.5`). */
  size?: number;
  /** Hide from assistive tech — only when the exact label is printed right next to it. */
  decorative?: boolean;
  /** Override the colour utility (e.g. keep a caller's palette). */
  colorClassName?: string;
  className?: string;
}

/** Bare SVG status glyph (no wrapper). */
export function StatusGlyph({
  status,
  label,
  size,
  decorative = false,
  colorClassName,
  className,
}: StatusGlyphProps) {
  const s = glyphStatus(status);
  const name = label ?? GLYPH_LABEL[s];
  return (
    <svg
      viewBox="0 0 14 14"
      width={size}
      height={size}
      data-status-glyph={s}
      className={cn("shrink-0", size ? null : "size-3.5", colorClassName ?? GLYPH_COLOR[s], className)}
      focusable="false"
      {...(decorative
        ? { "aria-hidden": true }
        : { role: "img", "aria-label": name })}
    >
      {decorative ? null : <title>{name}</title>}
      <Shape s={s} />
    </svg>
  );
}
