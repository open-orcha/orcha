/**
 * Day grouping for the Activity timeline (directive D10 — Linear Pulse /
 * activity style: "Today", "Yesterday", then dated sections). Pure helpers so
 * the grouping is unit-tested without rendering.
 *
 * Items keep their incoming order (callers pass newest-first lists); an item
 * without a parseable timestamp lands in a final "Date unknown" group rather
 * than being dropped or silently filed under today (truthful data, brief §3).
 */

export interface DayGroup<T> {
  /** stable key: "YYYY-MM-DD" (local) or "unknown" */
  key: string;
  label: string;
  items: T[];
}

const pad = (n: number) => String(n).padStart(2, "0");
const localKey = (d: Date) => d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());

/** "Today" · "Yesterday" · "Mon, Sep 22" (this year) · "Sep 22, 2025" (older years). */
export function dayLabel(iso: string | null | undefined, now: number = Date.now()): string {
  const t = iso ? Date.parse(iso) : NaN;
  if (!Number.isFinite(t)) return "Date unknown";
  const d = new Date(t);
  const today = new Date(now);
  if (localKey(d) === localKey(today)) return "Today";
  const y = new Date(now);
  y.setDate(y.getDate() - 1);
  if (localKey(d) === localKey(y)) return "Yesterday";
  const sameYear = d.getFullYear() === today.getFullYear();
  return sameYear
    ? d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" })
    : d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

export function groupByDay<T>(items: T[], at: (item: T) => string | null | undefined, now: number = Date.now()): DayGroup<T>[] {
  const out: DayGroup<T>[] = [];
  const idx = new Map<string, DayGroup<T>>();
  let unknown: DayGroup<T> | null = null;
  for (const it of items) {
    const iso = at(it);
    const t = iso ? Date.parse(iso) : NaN;
    if (!Number.isFinite(t)) {
      if (!unknown) unknown = { key: "unknown", label: "Date unknown", items: [] };
      unknown.items.push(it);
      continue;
    }
    const k = localKey(new Date(t));
    let g = idx.get(k);
    if (!g) {
      g = { key: k, label: dayLabel(iso, now), items: [] };
      idx.set(k, g);
      out.push(g);
    }
    g.items.push(it);
  }
  if (unknown) out.push(unknown);
  return out;
}
