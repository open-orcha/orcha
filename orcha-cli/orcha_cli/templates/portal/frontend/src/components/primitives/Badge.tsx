/**
 * Badge + StatusDot. Status is never color-only: StatusDot always carries the
 * exact label from lib/status.ts STAT (visible or screen-reader text) and a
 * distinct GLYPH SHAPE per status family — failed ≠ blocked, cancelled ≠
 * completed stay distinguishable in label and glyph.
 */
import type { ReactNode } from "react";
import { statusMeta } from "../../lib/status";
import { StatusGlyph } from "./StatusIcon";

export type Tone = "neutral" | "ok" | "warn" | "danger" | "info" | "accent";

export function Badge({ tone = "neutral", children, title, className }: {
  tone?: Tone; children: ReactNode; title?: string; className?: string;
}) {
  return (
    <span className={`v2-badge v2-tone-${tone}${className ? " " + className : ""}`} title={title}>
      {children}
    </span>
  );
}

/** Numeric count (tabular). `null` renders nothing — unknown is not zero. */
export function Count({ n, suffix, title, tone = "neutral" }: {
  n: number | null | undefined; suffix?: string; title?: string; tone?: Tone;
}) {
  if (n == null) return null;
  return <span className={`v2-count v2-tone-${tone}`} title={title}>{n}{suffix ?? ""}</span>;
}

/** Shape per status (a11y: shape + label, not hue alone). */
export type Glyph = "ring" | "dot" | "check" | "cross" | "bar" | "tri" | "play" | "arrow" | "dash";

const GLYPH_BY_STATUS: Record<string, Glyph> = {
  working: "dot", in_progress: "dot", active: "dot", live: "dot", running: "dot",
  idle: "ring", pending: "ring", ready: "play",
  blocked: "bar", failed: "cross", terminated: "cross", rejected: "cross", error: "cross",
  awaiting_request: "tri", awaiting_human: "tri", needs_verification: "tri", open: "tri", escalated: "tri",
  completed: "check", answered: "check", accepted: "check", verified: "check",
  cancelled: "dash", closed: "dash", archived: "dash", stopped: "dash",
  converted_to_task: "arrow",
};
const TONE_BY_CLASS: Record<string, Tone> = {
  "s-working": "info", "s-ok": "ok", "s-done": "ok", "s-ready": "info", "s-info": "info",
  "s-attn": "warn", "s-warn": "warn", "s-bad": "danger", "s-acc": "accent", "s-idle": "neutral",
};

export function statusGlyph(status: string | null | undefined): Glyph {
  return GLYPH_BY_STATUS[status || ""] || "ring";
}
export function statusTone(status: string | null | undefined): Tone {
  // failed / blocked / cancelled keep their own tones: cancelled is neutral, never "done"
  if (status === "cancelled" || status === "closed") return "neutral";
  return TONE_BY_CLASS[statusMeta(status).c] || "neutral";
}

/**
 * Status glyph + label. `label` overrides the STAT label (e.g. a container
 * status "active"). With showLabel=false the label is still in the DOM for
 * screen readers and the tooltip. Renders the ONE D8 glyph set
 * (StatusIcon.tsx `StatusGlyph`); `statusGlyph()` stays as the legacy
 * shape-family helper.
 */
export function StatusDot({ status, label, showLabel = true, className }: {
  status: string | null | undefined; label?: string; showLabel?: boolean; className?: string;
}) {
  const text = label ?? statusMeta(status).l;
  return (
    <span className={`v2-status v2-tone-${statusTone(status)}${className ? " " + className : ""}`} title={text} data-status={status || "unknown"}>
      <StatusGlyph status={status} size={12} className="v2-glyph" />
      <span className={showLabel ? "v2-status-label" : "v2-sr"}>{text}</span>
    </span>
  );
}
