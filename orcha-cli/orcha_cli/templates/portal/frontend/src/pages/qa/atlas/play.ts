/**
 * "Play the app" (atlas-play.tsx), pure: the tour's steps and the camera's track. The tour walks
 * the storyboard as it is filtered, area by area in its order, each area's screens in the order a
 * person walks them, and shows only what runs have seen: a screen with no screenshot on any shown
 * platform is left out (a tour of wireframes says nothing), and so is a look taken behind a sign-in.
 * Between two screens it names the move that joins them when the app's flows have one
 * ("Tap Sign in"); when none does it says nothing rather than invent one.
 */
import { FRAME, frameKind, lookKind, moveWords, type AreaRow, type FrameKind, type Shapes } from "./model";
import type { Atlas, AtlasArea, AtlasScreen, Platform } from "./types";

export interface PlayShot {
  platform: Platform;
  src: string;
  kind: FrameKind;
  /** The screenshot's size, when the atlas knows it, so its fit is set before it loads. */
  shot: { w: number | null; h: number | null } | null;
}

export type PlayStep =
  | { kind: "area"; key: string; area: AtlasArea; index: number; screens: number; shown: number; seen: number }
  | {
      kind: "screen";
      key: string;
      screen: AtlasScreen;
      area: AtlasArea;
      /** 1-based among the tour's screens. */
      n: number;
      shots: PlayShot[];
      /** The move from the screen before it, in words, when a flow joins them. */
      move: string | null;
    }
  | { kind: "end"; key: string; screens: number; areas: number };

/** How long each step holds while playing. */
export const HOLD_MS = { area: 1700, screen: 2800, end: 0 } as const;

/** The shots a screen shows on the tour: each shown platform with a screenshot of the screen itself. */
export function shotsOf(s: AtlasScreen, platforms: readonly Platform[], shapes?: Shapes): PlayShot[] {
  const out: PlayShot[] = [];
  for (const p of platforms) {
    const v = s.variants[p];
    if (!v?.frame_url || v.signin_only) continue;
    // The frame of the device that took it (an iPad's shot in an iPad), else the column's.
    out.push({ platform: p, src: v.frame_url, kind: lookKind(p, v.device) ?? frameKind(p, shapes), shot: v.device ? { w: v.device.w, h: v.device.h } : null });
  }
  return out;
}

export function playSteps(atlas: Pick<Atlas, "flows">, rows: readonly AreaRow[], platforms: readonly Platform[], shapes?: Shapes): PlayStep[] {
  const moves = new Map<string, string>();
  for (const f of atlas.flows) if (!moves.has(`${f.from}>${f.to}`)) moves.set(`${f.from}>${f.to}`, f.label);
  const steps: PlayStep[] = [];
  let n = 0;
  let areas = 0;
  let prev: string | null = null;
  rows.forEach((row) => {
    const shown = row.screens.map((s) => ({ s, shots: shotsOf(s, platforms, shapes) })).filter((x) => x.shots.length);
    if (!shown.length) return;
    areas += 1;
    steps.push({
      kind: "area",
      key: `area:${row.area.key}`,
      area: row.area,
      index: areas,
      screens: row.area.screens.length,
      shown: shown.length,
      seen: row.screens.filter((s) => !s.never_seen).length,
    });
    for (const { s, shots } of shown) {
      n += 1;
      const label = prev ? moves.get(`${prev}>${s.id}`) : undefined;
      steps.push({ kind: "screen", key: `screen:${s.id}`, screen: s, area: row.area, n, shots, move: label ? moveWords(label) : null });
      prev = s.id;
    }
  });
  if (n) steps.push({ kind: "end", key: "end", screens: n, areas });
  return steps;
}

/** The gap between two shots of a screen, and between two steps on the track (room for the move). */
export const SHOT_GAP = 28;
export const STEP_GAP = 210;
/** An area's title card and the closing card are this wide. */
export const CARD_W = 360;

/** The scale the tour draws frames at, so the tallest fits `height`. */
export function playScale(height: number, shots: readonly PlayShot[]): number {
  const tallest = Math.max(FRAME.phone.h, ...shots.map((s) => FRAME[s.kind].h));
  return Math.max(1, Math.min(2.4, height / tallest));
}

export function stepWidth(step: PlayStep, scale: number): number {
  if (step.kind !== "screen") return CARD_W;
  return step.shots.reduce((w, s) => w + Math.round(FRAME[s.kind].w * scale), 0) + SHOT_GAP * (step.shots.length - 1);
}

/** Where each step sits on the track (its left edge and width) and the track's length. */
export function trackOf(steps: readonly PlayStep[], scale: number): { x: number[]; w: number[]; length: number } {
  const x: number[] = [];
  const w: number[] = [];
  let at = 0;
  for (const s of steps) {
    const width = stepWidth(s, scale);
    x.push(at);
    w.push(width);
    at += width + STEP_GAP;
  }
  return { x, w, length: Math.max(0, at - STEP_GAP) };
}

/** The camera's offset that puts step `i` in the middle of a window `view` wide. */
export function cameraAt(track: { x: number[]; w: number[] }, i: number, view: number): number {
  if (!track.x.length) return 0;
  const k = Math.max(0, Math.min(track.x.length - 1, i));
  return Math.round(view / 2 - (track.x[k] + track.w[k] / 2));
}

/** The step to start from (or jump to) for an area: its title card. */
export function areaStart(steps: readonly PlayStep[], key: string): number {
  return Math.max(0, steps.findIndex((s) => s.kind === "area" && s.area.key === key));
}

/** What a screen reader hears as a step comes on. */
export function stepWords(step: PlayStep, total: number): string {
  if (step.kind === "area") return `${step.area.name}: ${step.shown} of ${step.screens} ${step.screens === 1 ? "screen" : "screens"} seen live.`;
  if (step.kind === "end") return `The end of the tour: ${step.screens} ${step.screens === 1 ? "screen" : "screens"} in ${step.areas} ${step.areas === 1 ? "area" : "areas"}.`;
  return `Screen ${step.n} of ${total}: ${step.screen.name}, in ${step.area.name}.${step.move ? ` ${step.move}.` : ""}`;
}
