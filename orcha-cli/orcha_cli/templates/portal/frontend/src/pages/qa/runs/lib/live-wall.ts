/**
 * The live wall (`/runs/live`): every running run's device screen at once. Pure helpers shared
 * by the batched endpoint (`GET /api/runs/live`, `lib/data/live-wall.ts`) and the grid
 * (`components/runs/live-wall`): the tile model, the grid layout for a tile count, each tile's
 * screen shape, and how one poll's answer merges into what is on screen (a finished run stays a
 * few seconds with its result, then leaves).
 */
import { elapsedSince, fmtClock } from "./run-counters";
import type { TargetKind } from "../types";

/** `preparing`: claimed, no run yet (booting, installing). `finishing`: judging, syncing or stopping. */
export type WallStatus = "queued" | "preparing" | "running" | "finishing";
export type WallResult = "passed" | "failed" | "stopped";
export type WallShape = "phone" | "tablet" | "wide";

/** One tile as the endpoint answers it. */
export interface WallTile {
  /** The session id. Stable across polls. */
  key: string;
  runId: string | null;
  /** Where the tile opens: the session's run page. */
  href: string;
  status: WallStatus;
  /** Scenario name, else what the run does ("Exploration"). */
  name: string;
  project: string | null;
  kind: TargetKind;
  /** "iPhone 17 Pro", "Chromium 1280x800". */
  device: string;
  /** True when `device` is the worker's default ("Any booted simulator"). */
  deviceIsDefault: boolean;
  /** When the run clock starts: the session's first screen (its first step). Null until then:
   * building, installing, preflight and the device session coming up are not run time (#200);
   * `phaseSince` times them instead. */
  since: string | null;
  /** Actions so far, as the run header counts them: every step but a screen read (#170). */
  actions: number;
  /** The newest step in one line (`tap target=text:"General"`). */
  action: string | null;
  /** `qa-runs` path of the newest frame, and its step. */
  framePath: string | null;
  frameSeq: number | null;
  /** What preparation is doing now ("Booting iPad Pro…"), while there is no frame yet. */
  phase: string | null;
  /** When that preparation stage began (`progress.prep_events`), for its own clock. */
  phaseSince?: string | null;
}

/** A run that ended moments ago: the grid shows its result on the tile it already had. */
export interface WallEnded {
  key: string;
  result: WallResult;
}

export interface WallPayload {
  tiles: WallTile[];
  ended: WallEnded[];
  /** Server clock (ISO), for the record. */
  at: string;
}

/** How long a finished run stays on the wall with its result. */
export const ENDED_LINGER_MS = 5000;
/** The exit animation's length, after the linger. */
export const EXIT_MS = 320;
/** How often the wall asks for fresh frames, by default. */
export const DEFAULT_WALL_INTERVAL_MS = 1000;

/** The grid for `count` tiles: 1 large, 2 side by side, 2x2, 3x2, 3x3, then rows that scroll. */
export function wallLayout(count: number, opts: { narrow?: boolean; wide?: boolean } = {}): { cols: number; rows: number; scroll: boolean } {
  const n = Math.max(0, Math.floor(count));
  if (n <= 1) return { cols: 1, rows: 1, scroll: false };
  if (opts.narrow) {
    const rows = Math.ceil(n / 2);
    return { cols: 2, rows, scroll: rows > 2 };
  }
  if (n === 2) return { cols: 2, rows: 1, scroll: false };
  if (n <= 4) return { cols: 2, rows: 2, scroll: false };
  if (n <= 6) return { cols: 3, rows: 2, scroll: false };
  if (n <= 9) return { cols: 3, rows: 3, scroll: false };
  const cols = opts.wide ? 4 : 3;
  return { cols, rows: Math.ceil(n / cols), scroll: true };
}

/** A tile's screen shape before a frame says otherwise: a phone is tall, a tablet squarer, a
 * browser wide. `tablet`: the tile's `formFactor` says so, else its device name is a tablet's
 * (`isTabletDeviceName`). */
export function wallShape(kind: TargetKind, tablet: boolean): WallShape {
  if (kind === "web" || kind === "desktop") return "wide";
  return tablet ? "tablet" : "phone";
}

const SHAPE_ASPECT: Record<WallShape, number> = { phone: 9 / 19.5, tablet: 3 / 4, wide: 16 / 10 };

/** Width / height of a tile's screen: the frame's own once it has loaded, else its shape's. */
export function screenAspect(shape: WallShape, natural?: { w: number; h: number } | null): number {
  if (natural && natural.w > 0 && natural.h > 0) return natural.w / natural.h;
  return SHAPE_ASPECT[shape];
}

/** "4 running · 2 queued"; preparing and finishing count as running. */
export function wallCounts(tiles: readonly Pick<WallTile, "status">[]): string {
  const queued = tiles.filter((t) => t.status === "queued").length;
  const running = tiles.length - queued;
  const parts = [`${running} running`];
  if (queued > 0) parts.push(`${queued} queued`);
  return parts.join(" · ");
}

/** A queued tile's one line: "Queued · waiting for iPad Pro 13-inch (M5)". */
export function queuedLine(tile: Pick<WallTile, "device" | "deviceIsDefault" | "kind">): string {
  if (tile.deviceIsDefault) return `Queued · waiting for ${tile.kind === "web" ? "a browser" : "a device"}`;
  return `Queued · waiting for ${tile.device}`;
}

/** The tile's device line: a preparing tile whose lane is not known yet is picking one, not
 * running on "Any booted simulator". */
export function deviceLine(tile: Pick<WallTile, "status" | "device" | "deviceIsDefault" | "kind">): string {
  if (tile.status === "preparing" && tile.deviceIsDefault && tile.kind !== "web") return "Picking a device…";
  return tile.device;
}

/** A tile's run clock start, never later than the one already on screen for the same run. A
 * tile that had no run clock (queued, or preparing without a run) starts it at the run's start:
 * the clock starts with the session, not with the claim (#200). */
export function steadySince(prev: Pick<WallTile, "since" | "status" | "runId"> | null | undefined, next: Pick<WallTile, "since" | "runId">): string | null {
  if (!prev || prev.status === "queued" || !prev.runId || prev.runId !== next.runId || !prev.since || !next.since) return next.since;
  const a = Date.parse(prev.since);
  const b = Date.parse(next.since);
  return Number.isFinite(a) && Number.isFinite(b) && a < b ? prev.since : next.since;
}

/** The tile's run clock in milliseconds, or null while there is nothing to time yet: queued,
 * still preparing (building, installing, preflight), or a run whose device session has not shown
 * its first screen; `waitingLine` times those stages on their own (#200). */
export function runClockMs(tile: Pick<WallTile, "status" | "runId" | "since">, now: number): number | null {
  if (tile.status === "queued" || !tile.runId) return null;
  return elapsedSince(tile.since, now);
}

/** What a tile with no frame yet says it is doing; the preparation stage with how long it has
 * taken ("Building the Android app · 6:19") when `now` is given and the stage's start is known. */
export function waitingLine(
  tile: Pick<WallTile, "status" | "phase" | "device" | "deviceIsDefault" | "kind"> & { phaseSince?: string | null },
  now?: number,
): string {
  if (tile.status === "queued") return queuedLine(tile);
  if (tile.phase) {
    const stage = now != null ? elapsedSince(tile.phaseSince, now) : null;
    return stage != null ? `${tile.phase} · ${fmtClock(stage)}` : tile.phase;
  }
  if (tile.status === "preparing") return tile.kind === "web" ? "Opening the browser…" : `Getting ${tile.deviceIsDefault ? "the device" : tile.device} ready…`;
  return "Waiting for the first screen…";
}

/** A tile on screen: the endpoint's tile plus what the grid tracks about it. */
export interface ShownTile extends WallTile {
  /** Set once the run ended: the result badge, and when it ended (client clock). */
  result: WallResult | null;
  endedAt: number | null;
  /** In its exit animation. */
  leaving: boolean;
  /** When it first appeared (client clock): new tiles animate in. */
  enteredAt: number;
}

/**
 * Merges one poll into the tiles on screen. Live tiles take the new data and keep their slot (a
 * request's `req:` tile becomes its run's tile in place); new ones are appended. A run that is no
 * longer listed stays in its slot with its result (from `ended`) for `ENDED_LINGER_MS`, then
 * leaves through `EXIT_MS`. A request that vanished before it had a run (cancelled) just leaves.
 * Queued placeholders always sit at the end.
 */
export function mergeWall(prev: readonly ShownTile[], payload: Pick<WallPayload, "tiles" | "ended">, now: number): ShownTile[] {
  const endedBy = new Map(payload.ended.map((e) => [e.key, e.result]));
  const fresh = new Map(payload.tiles.map((t) => [t.key, t]));
  const placed = new Set<string>();
  const out: ShownTile[] = [];
  for (const p of prev) {
    const next = fresh.get(p.key);
    if (next && p.endedAt == null) {
      if (placed.has(next.key)) continue;
      placed.add(next.key);
      out.push({ ...next, since: steadySince(p, next), result: null, endedAt: null, leaving: false, enteredAt: p.enteredAt });
      continue;
    }
    if (p.endedAt == null && !p.runId) continue;
    const endedAt = p.endedAt ?? now;
    if (now - endedAt >= ENDED_LINGER_MS + EXIT_MS) continue;
    out.push({ ...p, result: p.result ?? endedBy.get(p.key) ?? null, endedAt, leaving: now - endedAt >= ENDED_LINGER_MS });
  }
  for (const t of payload.tiles) {
    if (placed.has(t.key) || out.some((o) => o.key === t.key)) continue;
    out.push({ ...t, result: null, endedAt: null, leaving: false, enteredAt: now });
  }
  const isQueued = (t: ShownTile) => t.status === "queued" && t.endedAt == null;
  return [...out.filter((t) => !isQueued(t)), ...out.filter(isQueued)];
}

/** The tile a keyboard arrow moves to in a `cols`-wide grid of `count` tiles. */
export function moveFocus(index: number, key: string, cols: number, count: number): number {
  if (count <= 0) return -1;
  const i = Math.min(Math.max(index, 0), count - 1);
  switch (key) {
    case "ArrowRight":
      return Math.min(i + 1, count - 1);
    case "ArrowLeft":
      return Math.max(i - 1, 0);
    case "ArrowDown":
      return i + cols < count ? i + cols : i;
    case "ArrowUp":
      return i - cols >= 0 ? i - cols : i;
    case "Home":
      return 0;
    case "End":
      return count - 1;
    default:
      return i;
  }
}
