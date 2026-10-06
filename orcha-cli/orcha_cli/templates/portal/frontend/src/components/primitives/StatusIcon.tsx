/**
 * D8 — the ONE Linear-style status glyph set, used everywhere (lists, detail,
 * board, sidebar, overview, group headers, the legacy `Pill`).
 *
 * Every Orcha task / request / agent status in lib/status.ts STAT has its own
 * glyph; the visible/accessible label is ALWAYS the exact STAT label
 * (statusMeta(status).l — "Needs verification", "Waiting", "Converted", …), so the
 * status is never colour-only and never renamed.
 *
 *   ready              empty ring (todo)                 grey
 *   pending            dashed ring (waiting on deps)     grey
 *   idle               dotted ring                       faint grey
 *   in_progress/working ring + half pie                  yellow
 *   awaiting_request   ring + pause bars ("Waiting")     amber
 *   awaiting_human     ring + dot ("Needs human")        amber
 *   needs_verification ring + ¾ pie ("Needs verification")     green
 *   completed/answered filled circle + check             green
 *   blocked            ring + bar (no-entry)             red
 *   failed             filled circle + ×                 red
 *   terminated         ring + stop square                red
 *   rejected           ring + ×                          red
 *   escalated          ring + up arrow                   red
 *   cancelled          filled circle + slash             grey
 *   closed             filled circle + check             grey
 *   open (request)     ring + dot                        neutral
 *   accepted           ring + check                      accent
 *   converted_to_task  filled circle + arrow             accent
 *   unknown            faint ring (label = raw status)
 */
import type { ReactNode } from "react";
import { statusMeta } from "../../lib/status";

export type StatusShape =
  | "todo" | "dashed" | "dotted" | "progress" | "paused" | "attention" | "review" | "done"
  | "blocked" | "failed" | "stopped" | "rejected" | "escalated" | "cancelled" | "closed"
  | "open" | "accepted" | "converted" | "unknown";

export type StatusColor = "todo" | "faint" | "progress" | "warn" | "review" | "done" | "danger" | "muted" | "accent";

const SHAPE: Record<string, [StatusShape, StatusColor]> = {
  ready: ["todo", "todo"],
  pending: ["dashed", "todo"],
  idle: ["dotted", "faint"],
  offline: ["dotted", "faint"],
  in_progress: ["progress", "progress"],
  working: ["progress", "progress"],
  active: ["progress", "progress"],
  live: ["progress", "progress"],
  running: ["progress", "progress"],
  awaiting_request: ["paused", "warn"],
  awaiting_human: ["attention", "warn"],
  needs_verification: ["review", "review"],
  completed: ["done", "done"],
  answered: ["done", "done"],
  verified: ["done", "done"],
  blocked: ["blocked", "danger"],
  failed: ["failed", "danger"],
  error: ["failed", "danger"],
  terminated: ["stopped", "danger"],
  rejected: ["rejected", "danger"],
  escalated: ["escalated", "danger"],
  cancelled: ["cancelled", "muted"],
  archived: ["cancelled", "muted"],
  stopped: ["cancelled", "muted"],
  closed: ["closed", "muted"],
  open: ["open", "todo"],
  accepted: ["accepted", "accent"],
  converted_to_task: ["converted", "accent"],
  // parity r1 (SG-06 / TSK run statuses): these fell through to "unknown"
  paused: ["paused", "warn"], // a paused project / run
  rate_limited: ["paused", "warn"], // a run parked by the provider's rate limit
  not_ready: ["dashed", "todo"], // on hold: same family as pending
  orphaned: ["stopped", "muted"], // a run whose process vanished
  killed: ["cancelled", "muted"], // a run a human stopped — not a failure
};

export function statusShape(status: string | null | undefined): StatusShape {
  return (SHAPE[status || ""] || ["unknown"])[0];
}
export function statusColor(status: string | null | undefined): StatusColor {
  return (SHAPE[status || ""] || ["unknown", "faint"])[1];
}
/** The exact STAT label ("Needs verification", "Waiting" …); unknown statuses keep their raw value. */
export function statusLabel(status: string | null | undefined): string {
  return statusMeta(status).l;
}

// 14×14 grid, centre (7,7). Ring r=5.5 stroke 1.5; inner pie r=2.6; fill r=6.25.
const RING = { cx: 7, cy: 7, r: 5.5, fill: "none", stroke: "currentColor", strokeWidth: 1.5 } as const;
const CUT = "var(--v2-si-cut, var(--v2-canvas))";
const LINE = { fill: "none", strokeWidth: 1.5, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };

function Filled({ children }: { children?: ReactNode }) {
  return (
    <>
      <circle cx={7} cy={7} r={6.25} fill="currentColor" />
      {children}
    </>
  );
}

function Shape({ s }: { s: StatusShape }) {
  switch (s) {
    case "todo":
      return <circle {...RING} />;
    case "dashed":
      return <circle {...RING} strokeDasharray="2.05 1.9" />;
    case "dotted":
      return <circle {...RING} strokeDasharray="0.01 2.85" strokeLinecap="round" strokeWidth={1.6} />;
    case "progress":
      return (
        <>
          <circle {...RING} />
          <path d="M7 7V4.4A2.6 2.6 0 0 1 7 9.6z" fill="currentColor" />
        </>
      );
    case "review":
      return (
        <>
          <circle {...RING} />
          <path d="M7 7V4.4A2.6 2.6 0 1 1 4.4 7z" fill="currentColor" />
        </>
      );
    case "paused":
      return (
        <>
          <circle {...RING} />
          <path d="M5.8 5.3v3.4M8.2 5.3v3.4" stroke="currentColor" {...LINE} strokeWidth={1.3} />
        </>
      );
    case "attention":
    case "open":
      return (
        <>
          <circle {...RING} />
          <circle cx={7} cy={7} r={2} fill="currentColor" />
        </>
      );
    case "done":
    case "closed":
      return (
        <Filled>
          <path d="M4.4 7.2 6.2 9 9.6 5.2" stroke={CUT} {...LINE} />
        </Filled>
      );
    case "failed":
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
    case "converted":
      return (
        <Filled>
          <path d="M4.3 7h5.2M7.4 4.9 9.5 7 7.4 9.1" stroke={CUT} {...LINE} strokeWidth={1.4} />
        </Filled>
      );
    case "blocked":
      return (
        <>
          <circle {...RING} />
          <path d="M4.6 7h4.8" stroke="currentColor" {...LINE} strokeWidth={1.6} />
        </>
      );
    case "stopped":
      return (
        <>
          <circle {...RING} />
          <rect x={5.1} y={5.1} width={3.8} height={3.8} rx={0.8} fill="currentColor" />
        </>
      );
    case "rejected":
      return (
        <>
          <circle {...RING} />
          <path d="M5.3 5.3l3.4 3.4M8.7 5.3 5.3 8.7" stroke="currentColor" {...LINE} strokeWidth={1.4} />
        </>
      );
    case "escalated":
      return (
        <>
          <circle {...RING} />
          <path d="M7 9.4V4.8M5 6.6 7 4.6l2 2" stroke="currentColor" {...LINE} strokeWidth={1.4} />
        </>
      );
    case "accepted":
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

export interface StatusIconProps {
  status: string | null | undefined;
  /** Pixel size (default 14; 12 in dense chips, 16 in detail headers). */
  size?: number;
  /** Override the STAT label (rare — e.g. a container status). */
  label?: string;
  /** Print the label next to the glyph (default false: label is sr-only + tooltip). */
  showLabel?: boolean;
  /** Glyph only, aria-hidden (when the exact label is printed elsewhere in the same control). */
  decorative?: boolean;
  className?: string;
}

/** Bare glyph svg (no wrapper) — for places that already carry the label. */
export function StatusGlyph({ status, size = 14, className }: { status: string | null | undefined; size?: number; className?: string }) {
  return (
    <svg
      className={`v2-si v2-si-c-${statusColor(status)}${className ? " " + className : ""}`}
      data-shape={statusShape(status)}
      width={size}
      height={size}
      viewBox="0 0 14 14"
      aria-hidden="true"
      focusable="false"
    >
      <Shape s={statusShape(status)} />
    </svg>
  );
}

export function StatusIcon({ status, size = 14, label, showLabel = false, decorative = false, className }: StatusIconProps) {
  const text = label ?? statusLabel(status);
  if (decorative) return <StatusGlyph status={status} size={size} className={className} />;
  return (
    <span
      className={`v2-si-wrap${showLabel ? " has-label" : ""}${className ? " " + className : ""}`}
      title={text}
      data-status={status || "unknown"}
    >
      <StatusGlyph status={status} size={size} />
      <span className={showLabel ? "v2-si-label" : "v2-sr"}>{text}</span>
    </span>
  );
}
