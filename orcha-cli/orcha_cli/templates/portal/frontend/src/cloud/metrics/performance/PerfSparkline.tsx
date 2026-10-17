/**
 * Verified-tasks-per-bucket sparkline (one series → one accent hue, no legend; the
 * surrounding label names it). Bars with a rounded data end on a square baseline, 2px
 * gaps; zero buckets show a hairline tick (an honest zero, not a missing bar). Each bar
 * has a hover/focus tooltip with its date range + counts; the whole mark has an
 * aria-label summary, and the table/card figures are the accessible data view.
 */
import type { CSSProperties } from "react";
import { bucketLabel, type PerfBucket } from "./performanceModel";

export function PerfSparkline({ series, bucketDays, label, size = "sm" }: {
  series: PerfBucket[];
  bucketDays: number;
  /** accessible name, e.g. "Forge: verified tasks per day" */
  label: string;
  size?: "sm" | "md";
}) {
  if (!series.length) {
    return <span className="pf-spark pf-spark-empty" role="img" aria-label={label + ": no activity yet"} title="No activity yet" />;
  }
  const max = series.reduce((m, b) => Math.max(m, b.verified), 0);
  const total = series.reduce((s, b) => s + b.verified, 0);
  const unit = bucketDays <= 1 ? "day" : bucketDays === 7 ? "week" : `${bucketDays} days`;
  return (
    <span
      className={"pf-spark pf-spark-" + size}
      role="img"
      aria-label={`${label}: ${total} verified across ${series.length} ${bucketDays <= 1 ? "days" : "periods"}, peak ${max} per ${unit}`}
    >
      {series.map((b) => {
        const tip = `${bucketLabel(b, bucketDays)}: ${b.verified} verified` + (b.rework ? ` · ${b.rework} rework` : "");
        return (
          <span key={b.start} className="pf-col" title={tip} data-v={b.verified}>
            {b.verified > 0
              ? <span className="pf-bar" style={{ "--h": Math.max(12, (b.verified / max) * 100) + "%" } as CSSProperties} />
              : <span className="pf-tick" />}
          </span>
        );
      })}
    </span>
  );
}
