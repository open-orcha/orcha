/**
 * The Explore tab's pure parts: what exploring has found so far (the header's figures), the
 * route each exploration took (its screenshots in order) and the days the history groups by. Every
 * figure comes from rows the database already holds; nothing is estimated.
 */
import { qaHref } from "../../parts";
import { sessionsView } from "../links";
import { isLive, noDevice, type Exploration, type ResultSeverity } from "../explorations";

export const SEVERITY_ORDER: readonly ResultSeverity[] = ["blocker", "major", "minor", "cosmetic", "info"];

function worse(a: ResultSeverity | null, b: ResultSeverity): ResultSeverity {
  if (!a) return b;
  return SEVERITY_ORDER.indexOf(b) < SEVERITY_ORDER.indexOf(a) ? b : a;
}

// Time --------------------------------------------------------------------------------

/** How long an exploration ran: started to finished, else its result's own duration. Null for
 * one that never started or is still going. */
export function ranSeconds(e: Pick<Exploration, "started_at" | "finished_at" | "result">): number | null {
  if (e.started_at && e.finished_at) {
    const s = (Date.parse(e.finished_at) - Date.parse(e.started_at)) / 1000;
    if (Number.isFinite(s) && s >= 0) return s;
  }
  const d = e.result?.duration_s;
  return typeof d === "number" && d >= 0 ? d : null;
}

/** "42 s", "3 min 31 s", "12 min", "1 h 5 min". */
export function formatSeconds(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 10) return s % 60 ? `${m} min ${s % 60} s` : `${m} min`;
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  return m % 60 ? `${h} h ${m % 60} min` : `${h} h`;
}

/** "0:42", "3:31", "1:05:09" for a live clock. */
export function clock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

// The header's figures ----------------------------------------------------------------

export interface ExploreStats {
  /** Explorations in the history (archived ones left out). */
  explorations: number;
  /** Going now. */
  live: number;
  /** Distinct issues the agent reported across every result (the same bug found twice counts once). */
  issues: number;
  bySeverity: Partial<Record<ResultSeverity, number>>;
  /** Distinct automatic checks that fell short (contrast, tap size): measured, never an issue. */
  measured: number;
  /** Seconds spent across the ones that ran. */
  seconds: number;
  /** How many of them ran long enough to have a duration. */
  timed: number;
  /** Status of each, newest first, for the header's ticker. */
  ticker: Exploration["status"][];
}

/** "260 measured checks", the automatic ones, so they never read as bugs. */
export const measuredWords = (n: number): string => `${n} measured ${n === 1 ? "check" : "checks"}`;

export function exploreStats(rows: readonly Exploration[]): ExploreStats {
  // A session that never got a device explored nothing: it is no run to count.
  const shown = rows.filter((e) => !e.archived_at && !noDevice(e));
  const seen = new Map<string, ResultSeverity>();
  const measured = new Set<string>();
  let seconds = 0;
  let timed = 0;
  for (const e of shown) {
    for (const f of e.result?.findings ?? []) {
      const key = f.fingerprint || `${e.id}:${f.title}`;
      if (f.source !== "agent") measured.add(key);
      else seen.set(key, worse(seen.get(key) ?? null, f.severity));
    }
    if (isLive(e.status)) continue;
    const s = ranSeconds(e);
    if (s != null) {
      seconds += s;
      timed += 1;
    }
  }
  const bySeverity: Partial<Record<ResultSeverity, number>> = {};
  for (const sev of seen.values()) bySeverity[sev] = (bySeverity[sev] ?? 0) + 1;
  return {
    explorations: shown.length,
    live: shown.filter((e) => isLive(e.status)).length,
    issues: seen.size,
    bySeverity,
    measured: measured.size,
    seconds,
    timed,
    ticker: shown.map((e) => e.status),
  };
}

// Routes ------------------------------------------------------------------------------

export interface RouteFrame {
  seq: number;
  path: string;
}

export interface ExplorationRoute {
  /** The screens in the order the explorer reached them (repeats in a row folded), sampled
   * down to `ROUTE_MAX` with the first and last kept. */
  frames: RouteFrame[];
  /** Distinct screens it captured; null when the screen fingerprints cannot tell them apart
   * (an app whose accessibility tree is empty gets one fingerprint for every screen). */
  screens: number | null;
  /** Screenshots it took in all. */
  captured: number;
}

/** "15 screens", or "21 screenshots" when the screens cannot be told apart. */
export function routeSize(route: Pick<ExplorationRoute, "screens" | "captured">): string {
  if (route.screens != null) return `${route.screens} ${route.screens === 1 ? "screen" : "screens"}`;
  return `${route.captured} ${route.captured === 1 ? "screenshot" : "screenshots"}`;
}

export const ROUTE_MAX = 18;

/** Up to `n` items spread evenly, first and last kept. */
export function spread<T>(items: readonly T[], n: number): T[] {
  if (items.length <= n) return [...items];
  if (n <= 1) return items.slice(0, Math.max(0, n));
  const out: T[] = [];
  for (let i = 0; i < n; i++) out.push(items[Math.round((i * (items.length - 1)) / (n - 1))]);
  return out;
}

/** A run's screenshot steps (any order) as its route. */
export function routeOf(steps: readonly { seq: number; frame_path: string | null; screen_hash?: string | null }[], max = ROUTE_MAX): ExplorationRoute {
  const shots = steps.filter((s): s is typeof s & { frame_path: string } => Boolean(s.frame_path)).sort((a, b) => a.seq - b.seq);
  // One fingerprint for many screenshots means the fingerprint is blind (an empty accessibility
  // tree), not that the explorer stood still: then every screenshot counts.
  const hashes = new Set(shots.map((s) => s.screen_hash).filter(Boolean));
  const telling = hashes.size > 1 || shots.length <= 1;
  const distinct = new Set<string>();
  const folded: RouteFrame[] = [];
  let last: string | null = null;
  for (const s of shots) {
    const id = (telling && s.screen_hash) || s.frame_path;
    distinct.add(id);
    if (id === last) continue;
    last = id;
    folded.push({ seq: s.seq, path: s.frame_path });
  }
  return { frames: spread(folded, max), screens: telling ? distinct.size : null, captured: shots.length };
}

/** Index of the frame a step belongs to: the last frame taken at or before it. */
export function frameIndexFor(frames: readonly RouteFrame[], seq: number): number {
  let at = -1;
  for (let i = 0; i < frames.length; i++) {
    if (frames[i].seq <= seq) at = i;
    else break;
  }
  return Math.max(0, at);
}

// Days --------------------------------------------------------------------------------

export interface DayGroup<T> {
  key: string;
  label: string;
  rows: T[];
}

function dayKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** "Today", "Yesterday", "Sun, Oct 26" (with the year when it is not this one), in the
 * machine's time zone. */
export function dayLabel(iso: string, now: number): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "Earlier";
  const today = new Date(now);
  const yesterday = new Date(now - 86_400_000);
  if (dayKey(d) === dayKey(today)) return "Today";
  if (dayKey(d) === dayKey(yesterday)) return "Yesterday";
  const options: Intl.DateTimeFormatOptions = { weekday: "short", month: "short", day: "numeric" };
  if (d.getFullYear() !== today.getFullYear()) options.year = "numeric";
  return d.toLocaleDateString("en-US", options);
}

/** Rows grouped by the day they were made, in the order given (newest first from the loader). */
export function dayGroups<T extends { created_at: string }>(rows: readonly T[], now: number): DayGroup<T>[] {
  const out: DayGroup<T>[] = [];
  for (const r of rows) {
    const d = new Date(r.created_at);
    const key = Number.isNaN(d.getTime()) ? "earlier" : dayKey(d);
    const g = out[out.length - 1];
    if (g && g.key === key) g.rows.push(r);
    else out.push({ key, label: dayLabel(r.created_at, now), rows: [r] });
  }
  return out;
}

/** "16:41" in the machine's time zone. */
export function timeOfDay(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
}

/** The session's page. */
export function sessionHref(e: Pick<Exploration, "id" | "platform">): string {
  return qaHref({ view: sessionsView(), platform: e.platform === "ios" ? null : e.platform, session: e.id });
}
