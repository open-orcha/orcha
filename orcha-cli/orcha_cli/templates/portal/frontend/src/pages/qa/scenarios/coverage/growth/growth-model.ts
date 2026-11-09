/**
 * Coverage › Growth's view model (#413): the words and geometry the view draws from a report,
 * pure so it is tested without a browser. Every number here is one Python measured
 * (`orcha.coverage_growth`); nothing is rounded up or invented.
 */
import { runtimeTimeZone, zonedDay } from "./viewer-tz";
import type { CoverageGrowth, GrowthArea, SeriesPoint, Side } from "./types";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * The calendar day (`YYYY-MM-DD`) a value names on the viewer's clock (#461): an ISO time (a
 * baseline's `taken_at`, growth's `since`) in `zone`, the browser's by default, never its UTC
 * date (01:33 UTC on Oct 29 is Oct 28 in New York); a plain day (a point of the chart, which
 * Python keys on the person's day) is already theirs. Null when it names no day.
 */
export function viewerDay(value: string | null | undefined, zone: string = runtimeTimeZone()): string | null {
  const s = value ?? "";
  if (/^\d{4}-\d{2}-\d{2}T/.test(s)) {
    const t = Date.parse(s);
    if (Number.isFinite(t)) return zonedDay(t, zone);
  }
  return /^(\d{4}-\d{2}-\d{2})/.exec(s)?.[1] ?? null;
}

/** `2026-10-02…` -> `Oct 2`, on the viewer's clock (`viewerDay`). */
export function shortDate(value: string | null | undefined, zone?: string): string {
  const day = viewerDay(value, zone);
  if (!day) return value ?? "";
  return `${MONTHS[Number(day.slice(5, 7)) - 1]} ${Number(day.slice(8, 10))}`;
}

/** `+45 points`, `−3 points`, `No change`; `Evidence unknown` without a figure on either side. */
export function pointsWords(points: number | null): string {
  if (points === null) return "Evidence unknown";
  if (points === 0) return "No change";
  const n = Math.abs(points);
  return `${points > 0 ? "+" : "−"}${n} ${n === 1 ? "point" : "points"}`;
}

export function pctWords(pct: number | null): string {
  return pct === null ? "unknown" : `${pct}%`;
}

/** The now bar in two parts: screens your tests cover, then what Orcha covers on top. */
export function nowSegments(now: Side): { yours: number; orcha: number } {
  if (!now.screens) return { yours: 0, orcha: 0 };
  const yours = (now.by_your_tests / now.screens) * 100;
  const orcha = (Math.max(0, now.covered - now.by_your_tests) / now.screens) * 100;
  return { yours, orcha };
}

/** Areas worth a row: every area with screens on either side, most points first (Python's order).
 * Once anything is covered, the areas nothing covers (then or now) leave the chart for one line
 * (`untestedAreas`), so a project with a hundred small areas does not read as a wall of 0%. */
export function chartAreas(g: CoverageGrowth["growth"], limit = 12): GrowthArea[] {
  const rows = (g?.areas ?? []).filter((a) => a.before.screens > 0 || a.now.screens > 0 || a.now.evidence === "unknown");
  const touched = rows.filter((a) => !isUntested(a));
  return (touched.length ? touched : rows).slice(0, limit);
}

function isUntested(a: GrowthArea): boolean {
  return a.now.screens > 0 && !a.now.covered && !a.before.covered && !a.points && a.now.evidence !== "unknown";
}

/** The areas nothing covers, then or now, when some other area is covered (they are left off the chart). */
export function untestedAreas(g: CoverageGrowth["growth"]): GrowthArea[] {
  const all = g?.areas ?? [];
  return all.some((a) => !isUntested(a) && (a.now.screens > 0 || a.before.screens > 0)) ? all.filter(isUntested) : [];
}

export interface Plot {
  points: { x: number; y: number; day: string; pct: number; kind: SeriesPoint["kind"] }[];
  path: string;
  baselineX: number | null;
  /** Where the screen count changed (#467): the first point on today's count after one on an
   * older count that could not be recounted (its index in `points`); null when every point is on
   * one count. */
  countX: number | null;
  countAt: number | null;
}

/**
 * The words for a screen count that changed under the figures (#467): only when some points could
 * not be recounted ("Screen counting changed on Oct 29; points before this use the old count").
 * A recount that worked changes nothing a person needs to read: every figure is on one count.
 */
export function countNote(count: { day: string; oldCount: readonly string[] } | null | undefined): string | null {
  if (!count || count.oldCount.length === 0) return null;
  return `Screen counting changed on ${shortDate(count.day)}; points before this use the old count.`;
}

/** The line of `area` (null: every screen) over the series, in a `w` x `h` box (0..100% on y);
 * `left` keeps room for the axis labels. */
export function linePlot(series: SeriesPoint[], area: string | null, w: number, h: number, pad = 8, left = pad): Plot {
  const known = series
    .map((p) => ({ day: p.day, kind: p.kind, pct: area === null ? p.pct : (p.areas[area] ?? null), old: p.oldCount === true }))
    .filter((p): p is { day: string; kind: SeriesPoint["kind"]; pct: number; old: boolean } => p.pct !== null);
  if (known.length === 0) return { points: [], path: "", baselineX: null, countX: null, countAt: null };
  const t0 = Date.parse(known[0].day);
  const t1 = Date.parse(known[known.length - 1].day);
  const span = Math.max(1, t1 - t0);
  // One day only (a baseline taken today, maybe with today's figure after it): the middle.
  const x = (day: string) => (t1 === t0 ? (left + w - pad) / 2 : left + ((Date.parse(day) - t0) / span) * (w - pad - left));
  const y = (pct: number) => pad + (1 - pct / 100) * (h - pad * 2);
  const points = known.map((p) => ({ x: x(p.day), y: y(p.pct), day: p.day, pct: p.pct, kind: p.kind }));
  const path = points.map((p, i) => `${i ? "L" : "M"}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ");
  const base = points.find((p) => p.kind === "baseline");
  const changed = known.findIndex((p, i) => !p.old && i > 0 && known[i - 1].old);
  return { points, path, baselineX: base ? base.x : null, countX: changed > 0 ? points[changed].x : null, countAt: changed > 0 ? changed : null };
}

/** The three "Orcha added" tiles. */
export function addedTiles(g: CoverageGrowth["growth"]): { key: string; value: number; label: string; hint: string }[] {
  const a = g?.overall.added ?? { scenarios: 0, variations: 0, screens_reached: 0 };
  return [
    { key: "scenarios", value: a.scenarios, label: a.scenarios === 1 ? "scenario" : "scenarios", hint: "validated and passing now, new since the baseline" },
    { key: "variations", value: a.variations, label: a.variations === 1 ? "data variation" : "data variations", hint: "rows Embodent suggested that you approved" },
    { key: "screens", value: a.screens_reached, label: a.screens_reached === 1 ? "screen reached" : "screens reached", hint: "newly seen by explorations and crawls" },
  ];
}

/** What measuring goes through, in order (the live view while it runs). */
export function growthSteps(prev?: { screens: number; flows: number } | null, last: "compare" | "freeze" = "compare"): { key: string; label: string }[] {
  return [
    { key: "screens", label: prev?.screens ? `Reading ${prev.screens} screens from the map` : "Reading the screens from the map" },
    { key: "tests", label: "Tying your tests to their screens" },
    { key: "results", label: "Checking which scenarios passed recently" },
    { key: "depth", label: prev?.flows ? `Counting data variations across ${prev.flows} flows` : "Counting data variations" },
    last === "freeze" ? { key: "freeze", label: "Freezing it as the baseline" } : { key: "compare", label: "Comparing with the baseline" },
  ];
}

/** The page's state: what to draw. */
export function growthMode(r: CoverageGrowth): "no_map" | "no_baseline" | "growth" {
  if (r.baseline && r.growth) return "growth";
  if (r.now.totals.screens === 0 && r.now.areas.length === 0) return "no_map";
  return "no_baseline";
}

// ---------------------------------------------------------------- the modernized view (Oct 27)

/** The three dates the page says: `Oct 6`, or `Oct 6, 2025` when it is not this year. */
export function longDate(value: string | null | undefined, now = Date.now(), zone: string = runtimeTimeZone()): string {
  const day = viewerDay(value, zone);
  if (!day) return value ?? "";
  return day.slice(0, 4) === zonedDay(now, zone).slice(0, 4) ? shortDate(day) : `${shortDate(day)}, ${day.slice(0, 4)}`;
}

/** Calendar days from the baseline to `now` on the viewer's clock (#461): 0 on its own day, 1
 * the next morning, however few hours later (a baseline at 21:33 is not "taken today" at 01:00). */
export function daysSince(iso: string | null | undefined, now = Date.now(), zone: string = runtimeTimeZone()): number | null {
  const t = Date.parse(iso ?? "");
  if (!Number.isFinite(t)) return null;
  const from = Date.parse(zonedDay(t, zone));
  const to = Date.parse(zonedDay(now, zone));
  return Math.max(0, Math.round((to - from) / 86_400_000));
}

/** One frame of the time-lapse: a day of the series, the areas' figures that day, and the areas
 * that rose since the frame before (they glow). Only days with a figure; nothing is interpolated. */
export interface Frame {
  day: string;
  kind: SeriesPoint["kind"];
  pct: number;
  areas: Record<string, number | null>;
  rose: string[];
}

export function timelapseFrames(series: SeriesPoint[]): Frame[] {
  const out: Frame[] = [];
  for (const p of series) {
    if (p.pct === null) continue;
    const prev = out[out.length - 1];
    const rose = prev ? Object.keys(p.areas).filter((k) => (p.areas[k] ?? 0) > (prev.areas[k] ?? 0)) : [];
    out.push({ day: p.day, kind: p.kind, pct: p.pct, areas: p.areas, rose });
  }
  return out;
}

/** The time-lapse's mini map: the areas with screens, biggest first, as tiles for `layoutMap`. */
export function mapAreas(r: CoverageGrowth, limit = 24): { key: string; name: string; screens: number }[] {
  return r.now.areas
    .filter((a) => a.screens > 0)
    .map((a) => ({ key: a.key, name: a.name, screens: a.screens }))
    .sort((a, b) => b.screens - a.screens || a.name.localeCompare(b.name))
    .slice(0, limit);
}

/** Your tests, then Orcha on top, as shares of every screen (the headline meter). */
export function overallSegments(r: CoverageGrowth): { yours: number; orcha: number; before: number | null } {
  const g = r.growth;
  const now = g ? g.overall.now : { screens: r.now.totals.screens, covered: r.now.totals.covered, by_your_tests: r.now.totals.by_your_tests } as Side;
  const s = nowSegments(now as Side);
  return { ...s, before: g?.overall.before.pct ?? null };
}

/** What a fresh measurement changed, in words, for the landing moment of "Measure again". */
export function remeasureWords(before: number | null, after: number | null): { text: string; tone: "up" | "down" | "same" | "unknown" } {
  if (before === null || after === null) return { text: after === null ? "Measured: evidence still unknown" : `Measured: ${after}% now`, tone: "unknown" };
  const d = after - before;
  if (d === 0) return { text: "Measured: no change since the last time", tone: "same" };
  const n = Math.abs(d);
  return { text: `Measured: ${d > 0 ? "+" : "−"}${n} ${n === 1 ? "point" : "points"} since the last time`, tone: d > 0 ? "up" : "down" };
}

/** The flows whose data depth grew between two reports (rows were just added): id -> partitions before. */
export function depthGrew(before: { id: string; depth: { partitions: number } }[], after: { id: string; depth: { partitions: number } }[]): Record<string, number> {
  const old = new Map(before.map((f) => [f.id, f.depth.partitions]));
  const out: Record<string, number> = {};
  for (const f of after) {
    const was = old.get(f.id);
    if (was !== undefined && f.depth.partitions > was) out[f.id] = was;
  }
  return out;
}

/** The Coverage map's headline split for project Home: "7 of 55 areas tested. 48 never tested…"
 * (`covered` is the headline's count; a report before #236 said "covered" for it). */
export function areasHeadline(headline: string): { covered: number; total: number; rest: string } | null {
  const m = /^(\d+) of (\d+) areas? (?:tested|covered)\.\s*(.*)$/.exec(headline.trim());
  return m ? { covered: Number(m[1]), total: Number(m[2]), rest: m[3] } : null;
}
