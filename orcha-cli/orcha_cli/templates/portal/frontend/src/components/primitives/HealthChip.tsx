/**
 * D8 health chip (Linear Initiatives): icon + coloured text — "On track"
 * (green), "At risk" (amber), "Off track" (red), "No data" (grey). The word is
 * always printed, and the glyph differs per state (trend up / flat arrow /
 * trend down / dash), so it is never colour-only. "At risk" is deliberately
 * NOT a check mark — a check next to "4 failed" read as a contradiction.
 *
 * The caller decides the health from REAL data (brief §3 truthful data); with
 * nothing to judge on, pass "no_data" — never default to "On track".
 */
export type Health = "on_track" | "at_risk" | "off_track" | "no_data";

export const HEALTH_LABEL: Record<Health, string> = {
  on_track: "On track",
  at_risk: "At risk",
  off_track: "Off track",
  no_data: "No data",
};

function HealthGlyph({ h }: { h: Health }) {
  const p =
    h === "on_track" ? "M3.6 9 6 6.6l1.6 1.6L10.4 5.4M8.4 5.4h2v2" :
    h === "at_risk" ? "M3.6 7h6.6M8.6 5.4 10.2 7 8.6 8.6" :
    h === "off_track" ? "M3.6 5 6 7.4l1.6-1.6 2.8 2.8M8.4 8.6h2v-2" :
    "M4.6 7h4.8";
  return (
    <svg className="v2-health-g" viewBox="0 0 14 14" width={14} height={14} aria-hidden="true" focusable="false">
      <circle cx={7} cy={7} r={6.25} fill="currentColor" opacity={0.2} />
      <path d={p} fill="none" stroke="currentColor" strokeWidth={1.4} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function HealthChip({ health, label, title, className }: { health: Health; label?: string; title?: string; className?: string }) {
  const text = label ?? HEALTH_LABEL[health];
  return (
    <span className={`v2-health is-${health}${className ? " " + className : ""}`} title={title ?? text} data-health={health}>
      <HealthGlyph h={health} />
      <span className="v2-health-text">{text}</span>
    </span>
  );
}

/** Failure-rate thresholds (review r2: one failure in 71 runs is not "At risk"). */
export const HEALTH_THRESHOLDS = { atRisk: 0.05, offTrack: 0.2 } as const;
export const HEALTH_RULE = "On track under 5% failed runs · At risk 5–20% · Off track 20% or more";

/**
 * Health from real run counts: no runs → "no_data" (never a default "On track"),
 * failure rate < 5 % → on track, 5–20 % → at risk, ≥ 20 % → off track.
 */
export function healthFromFailures(failed: number | null | undefined, total: number | null | undefined): Health {
  const t = Number(total) || 0;
  if (t <= 0) return "no_data";
  const rate = Math.max(0, Number(failed) || 0) / t;
  if (rate >= HEALTH_THRESHOLDS.offTrack) return "off_track";
  if (rate >= HEALTH_THRESHOLDS.atRisk) return "at_risk";
  return "on_track";
}
