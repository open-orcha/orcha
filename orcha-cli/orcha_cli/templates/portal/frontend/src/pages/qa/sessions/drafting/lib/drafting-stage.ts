/**
 * Pure helpers behind the drafting stage (`drafting-stage.tsx`): what to put on screen while
 * scenarios are drafted, derived from the drafter's activity log (`qa_drafting.py`, `_activity`).
 */
import type { TargetKind } from "./types";

/** One exploration screenshot the stage can show. */
export interface StageFrame {
  path: string;
  kind: TargetKind;
  run_id: string;
}

export interface StageTile {
  key: string;
  /** A screenshot of the app, or a file the agent is reading. */
  type: "frame" | "file";
  kind: TargetKind | null;
  path: string;
  /** File tiles: the directory and the file name, split for display. */
  dir?: string;
  name?: string;
}

/** `Reading src/app/page.tsx` → `src/app/page.tsx`; null for any other note. */
export function readPath(note: string): string | null {
  const m = /^Reading (.+)$/.exec(note.trim());
  if (!m) return null;
  const p = m[1].trim();
  if (!p || p.startsWith("the ") || p.startsWith("a ")) return null;
  return p;
}

/** `Drafting: Sign in with valid credentials` → the title; null otherwise. */
export function draftTitle(note: string): string | null {
  const m = /^Drafting: (.+)$/.exec(note.trim());
  return m ? m[1].trim() : null;
}

/** The scenario titles drafted so far, oldest first, without repeats. */
export function draftedTitles(recent: readonly string[]): string[] {
  const out: string[] = [];
  for (const line of recent) {
    const t = draftTitle(line);
    if (t && !out.includes(t)) out.push(t);
  }
  return out;
}

/** The files the agent read, oldest first, without repeats. */
export function readFiles(recent: readonly string[]): string[] {
  const out: string[] = [];
  for (const line of recent) {
    const p = readPath(line);
    if (p && !out.includes(p)) out.push(p);
  }
  return out;
}

export function splitPath(path: string): { dir: string; name: string } {
  const i = path.lastIndexOf("/");
  return i < 0 ? { dir: "", name: path } : { dir: path.slice(0, i), name: path.slice(i + 1) };
}

/**
 * The strip of tiles: exploration screenshots when there are any (what the agent walked),
 * otherwise the files it is reading, newest last. Capped so the strip stays a strip.
 */
export function stageTiles(frames: readonly StageFrame[], recent: readonly string[], max = 10): StageTile[] {
  if (frames.length > 0) {
    return frames.slice(0, max).map((f) => ({ key: `frame:${f.path}`, type: "frame", kind: f.kind, path: f.path }));
  }
  const files = readFiles(recent).slice(-max);
  return files.map((p) => {
    const { dir, name } = splitPath(p);
    return { key: `file:${p}`, type: "file", kind: null, path: p, dir, name };
  });
}

/** `n` indices spread evenly over `0..total-1` (always including the first). */
export function evenIndices(total: number, n: number): number[] {
  if (total <= 0 || n <= 0) return [];
  if (total <= n) return Array.from({ length: total }, (_, i) => i);
  const step = total / n;
  const out: number[] = [];
  for (let i = 0; i < n; i++) out.push(Math.min(total - 1, Math.floor(i * step)));
  return Array.from(new Set(out));
}

/** Width of a tile for its platform at `height` px: phones are tall, browsers wide. */
export function tileWidth(kind: TargetKind | null, height: number): number {
  if (kind === "web") return Math.round(height * 1.5);
  if (kind === null) return Math.round(height * 0.78);
  return Math.round(height / 2.1);
}
