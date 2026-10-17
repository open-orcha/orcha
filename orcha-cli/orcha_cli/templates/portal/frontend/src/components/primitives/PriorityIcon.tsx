/**
 * D8 — Linear priority glyph: three ascending bars filled by level; urgent is
 * an orange rounded square with "!". Buckets come from the ONE source
 * (pages/tasks/taskQuery.ts priorityBucket: backend integer, lower = higher,
 * default 100 = Normal), so the glyph never disagrees with sorting/filters.
 * The exact backend number stays in the tooltip.
 *
 *   urgent (≤5) ■!   high (≤20) ▂▄▆ all lit   normal (≤100) ▂▄ lit   low ▂ lit
 *   "none" (only when a caller passes level="none") = three muted dashes.
 */
import { DEFAULT_PRIORITY, priorityBucket, type PriorityKey } from "../../pages/tasks/taskQuery";

export type PriorityLevel = PriorityKey | "none";

const LABEL: Record<PriorityLevel, string> = { urgent: "Urgent", high: "High", normal: "Normal", low: "Low", none: "No priority" };

export function priorityLevel(p: string | number | null | undefined): PriorityKey {
  return priorityBucket(p).k;
}

export interface PriorityIconProps {
  /** Raw backend priority (number/string/null) — bucketed via priorityBucket. */
  priority?: string | number | null;
  /** Or pass a bucket directly. Wins over `priority`. */
  level?: PriorityLevel;
  size?: number;
  /** Print the bucket word next to the glyph. */
  showLabel?: boolean;
  /** Glyph only, aria-hidden (label printed elsewhere). */
  decorative?: boolean;
  className?: string;
}

export function PriorityGlyph({ level, size = 14 }: { level: PriorityLevel; size?: number }) {
  if (level === "urgent") {
    return (
      <svg className="v2-prio-g is-urgent" width={size} height={size} viewBox="0 0 14 14" aria-hidden="true" focusable="false">
        <rect x={1} y={1} width={12} height={12} rx={3} fill="currentColor" />
        <path d="M7 3.9v3.9M7 10.1h.01" stroke="var(--v2-canvas)" strokeWidth={1.7} strokeLinecap="round" />
      </svg>
    );
  }
  if (level === "none") {
    return (
      <svg className="v2-prio-g is-none" width={size} height={size} viewBox="0 0 14 14" aria-hidden="true" focusable="false">
        {[0, 1, 2].map((i) => (
          <rect key={i} x={1.5 + i * 4} y={6.25} width={3} height={1.5} rx={0.75} fill="currentColor" />
        ))}
      </svg>
    );
  }
  const lit = level === "high" ? 3 : level === "normal" ? 2 : 1;
  return (
    <svg className={`v2-prio-g is-${level}`} width={size} height={size} viewBox="0 0 14 14" aria-hidden="true" focusable="false">
      {[0, 1, 2].map((i) => (
        <rect
          key={i}
          className={i < lit ? "on" : "off"}
          x={1.5 + i * 4}
          y={8.5 - i * 3}
          width={3}
          height={4 + i * 3}
          rx={0.9}
          fill="currentColor"
        />
      ))}
    </svg>
  );
}

export function PriorityIcon({ priority, level, size = 14, showLabel = false, decorative = false, className }: PriorityIconProps) {
  const lv: PriorityLevel = level ?? priorityLevel(priority);
  const word = LABEL[lv];
  if (decorative) return <PriorityGlyph level={lv} size={size} />;
  const num = level ? null : String(priority ?? DEFAULT_PRIORITY);
  const title = lv === "none" ? word : `Priority: ${word}${num != null ? ` (${num}, lower = higher)` : ""}`;
  return (
    <span className={`v2-prio is-${lv}${className ? " " + className : ""}`} title={title} data-priority={lv}>
      <PriorityGlyph level={lv} size={size} />
      <span className={showLabel ? "v2-prio-label" : "v2-sr"}>{lv === "none" ? word : showLabel ? word : `${word} priority`}</span>
    </span>
  );
}
