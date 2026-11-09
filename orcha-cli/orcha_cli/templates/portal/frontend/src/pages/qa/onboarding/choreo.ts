/**
 * The Map cinematic's timeline. Each snapshot adds what is new to a plan of start times (a
 * file lights up, flies along a curve onto its screens, the screen draws in; then the tests
 * sweep in framework by framework; then the live pass reaches screens one by one), and the
 * renderer samples the plan at the frame's time. The beats never overlap: tests wait for the
 * code, the live pass waits for the tests, so even a snapshot that arrives finished plays as a
 * story instead of all at once.
 *
 * Reduced motion keeps the same order but nothing moves: things appear in a few still steps,
 * no curves fly, and `sample*` only ever answers 0 or 1.
 */
import type { MapScreen, OnboardingMap } from "./contract";

export const FLIGHT_MS = 900;
export const APPEAR_MS = 420;
export const GLOW_MS = 900;
export const LIVE_MS = 700;
/** Reduced motion: how far apart the still steps are, and how many there are per beat. */
export const STILL_STEP_MS = 320;
export const STILL_STEPS = 5;

export interface Flight {
  path: string;
  id: string;
  start: number;
}

export interface Plan {
  reduced: boolean;
  fileIn: Map<string, number>;
  nodeIn: Map<string, number>;
  flights: Flight[];
  badgeIn: Map<string, number>;
  testIn: Map<string, number>;
  /** Which framework lit each screen first (its glow takes that framework's badge colour). */
  testBy: Map<string, string>;
  liveIn: Map<string, number>;
  liveOrder: string[];
  draftIn: Map<string, number>;
  resultIn: Map<string, number>;
  /** Where each beat's queue ends: the next new item starts after it. */
  codeEnd: number;
  testsEnd: number;
  liveEnd: number;
  /** When the last thing scheduled is finished: the renderer stops its loop after it. */
  end: number;
}

export function emptyPlan(reduced: boolean): Plan {
  return {
    reduced,
    fileIn: new Map(),
    nodeIn: new Map(),
    flights: [],
    badgeIn: new Map(),
    testIn: new Map(),
    testBy: new Map(),
    liveIn: new Map(),
    liveOrder: [],
    draftIn: new Map(),
    resultIn: new Map(),
    codeEnd: 0,
    testsEnd: 0,
    liveEnd: 0,
    end: 0,
  };
}

/** The gap between items so `count` new ones take about `budget` ms, within bounds. */
function stagger(count: number, budget: number, min: number, max: number): number {
  if (count <= 0) return 0;
  return Math.max(min, Math.min(max, budget / count));
}

/** Reduced motion: item `k` of `count` lands on one of a few still steps. */
function still(k: number, count: number): number {
  const per = Math.max(1, Math.ceil(count / STILL_STEPS));
  return Math.floor(k / per) * STILL_STEP_MS;
}

/**
 * Adds what `map` shows that the plan has not seen yet, starting no earlier than `now`.
 * Returns a new plan (the old one is untouched). `instant` puts everything new at `now`, done:
 * a remount of a finished map (Coverage, Back) shows it settled rather than replaying it.
 */
export function advancePlan(prev: Plan, map: Pick<OnboardingMap, "files" | "screens" | "found">, now: number, instant = false): Plan {
  const plan: Plan = {
    ...prev,
    fileIn: new Map(prev.fileIn),
    nodeIn: new Map(prev.nodeIn),
    flights: [...prev.flights],
    badgeIn: new Map(prev.badgeIn),
    testIn: new Map(prev.testIn),
    testBy: new Map(prev.testBy),
    liveIn: new Map(prev.liveIn),
    liveOrder: [...prev.liveOrder],
    draftIn: new Map(prev.draftIn),
    resultIn: new Map(prev.resultIn),
  };
  const done = now - 10_000;
  const reduced = plan.reduced;

  // 1. Code: files light up one after another and fly onto their screens.
  const newFiles = map.files.filter((f) => !plan.fileIn.has(f.path));
  const fileGap = stagger(newFiles.length, 3600, 12, 120);
  let t = Math.max(now, plan.codeEnd);
  newFiles.forEach((f, k) => {
    const at = instant ? done : reduced ? Math.max(now, plan.codeEnd) + still(k, newFiles.length) : t;
    plan.fileIn.set(f.path, at);
    for (const id of f.screen_ids) {
      if (!reduced) plan.flights.push({ path: f.path, id, start: at + 120 });
      const lands = reduced ? at : at + 120 + FLIGHT_MS * 0.82;
      const cur = plan.nodeIn.get(id);
      if (cur === undefined || lands < cur) plan.nodeIn.set(id, lands);
    }
    t += fileGap;
  });
  // Screens no file leads to (found by the live pass alone) appear where the queue is.
  const orphans = map.screens.filter((s) => !plan.nodeIn.has(s.id));
  orphans.forEach((s, k) => {
    const at = instant ? done : reduced ? Math.max(now, plan.codeEnd) + still(k, orphans.length) : t + k * 40;
    plan.nodeIn.set(s.id, at);
  });
  if (!instant && (newFiles.length || orphans.length)) {
    plan.codeEnd = reduced ? Math.max(now, plan.codeEnd) + STILL_STEPS * STILL_STEP_MS : t + orphans.length * 40 + FLIGHT_MS;
  }
  // Old flights are kept only while they can still be drawn.
  plan.flights = plan.flights.filter((f) => f.start + FLIGHT_MS > now - 50);

  // 2. Tests: each framework's badge sweeps in, then the screens its tests reach light up.
  const byFw = new Map<string, MapScreen[]>();
  for (const s of map.screens) {
    for (const test of s.tests) {
      const list = byFw.get(test.framework) ?? [];
      if (!list.includes(s)) list.push(s);
      byFw.set(test.framework, list);
    }
  }
  const order = [...map.found.tests.map((x) => x.framework as string), ...byFw.keys()].filter((fw, i, a) => byFw.has(fw) && a.indexOf(fw) === i);
  let tt = Math.max(now, plan.testsEnd, plan.codeEnd + (reduced ? 0 : 250));
  let any = false;
  for (const fw of order) {
    const fresh = (byFw.get(fw) ?? []).filter((s) => !plan.testIn.has(s.id));
    if (!plan.badgeIn.has(fw)) {
      plan.badgeIn.set(fw, instant ? done : tt);
      tt += reduced ? 0 : 180;
    }
    // About four seconds for every framework together, however many there are.
    const gap = stagger(fresh.length, Math.max(450, 3600 / Math.max(1, order.length)), 8, 140);
    fresh.forEach((s, k) => {
      const at = instant ? done : reduced ? tt + still(k, fresh.length) : tt + 300 + k * gap;
      plan.testIn.set(s.id, at);
      plan.testBy.set(s.id, fw);
    });
    if (fresh.length) {
      any = true;
      tt += reduced ? STILL_STEPS * STILL_STEP_MS : 200 + fresh.length * gap + 120;
    }
  }
  if (!instant && any) plan.testsEnd = tt;

  // 3. Live: screens the device reached turn solid, in the order they were reached.
  const liveNew = map.screens.filter((s) => s.source !== "code" && !plan.liveIn.has(s.id));
  let lt = Math.max(now, plan.liveEnd, plan.testsEnd, plan.codeEnd);
  const liveGap = stagger(liveNew.length, 2600, 30, 420);
  liveNew.forEach((s, k) => {
    const at = instant ? done : reduced ? lt + still(k, liveNew.length) : lt + k * liveGap;
    plan.liveIn.set(s.id, at);
    plan.liveOrder.push(s.id);
  });
  if (!instant && liveNew.length) {
    lt += reduced ? STILL_STEPS * STILL_STEP_MS : liveNew.length * liveGap;
    plan.liveEnd = lt;
  }

  // 4. Drafts and the first run's verdict land on their screens as they come.
  const drafts = map.screens.filter((s) => s.scenarios.some((x) => x.status === "draft") && !plan.draftIn.has(s.id));
  drafts.forEach((s, k) => plan.draftIn.set(s.id, instant ? done : now + (reduced ? still(k, drafts.length) : k * stagger(drafts.length, 1400, 20, 120))));
  for (const s of map.screens) {
    if (s.first_run && (s.first_run.verdict === "pass" || s.first_run.verdict === "fail" || s.first_run.verdict === "error") && !plan.resultIn.has(s.id)) {
      plan.resultIn.set(s.id, instant ? done : now);
    }
  }

  const tail = reduced ? 0 : Math.max(FLIGHT_MS, GLOW_MS, LIVE_MS) + 120;
  const last = Math.max(
    plan.end,
    ...[...plan.nodeIn.values(), ...plan.testIn.values(), ...plan.liveIn.values(), ...plan.draftIn.values(), ...plan.resultIn.values(), ...plan.badgeIn.values()].map((v) => v + tail),
  );
  plan.end = Number.isFinite(last) ? last : plan.end;
  return plan;
}

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
/** Ease out (quint): fast start, long calm landing. */
export const easeOut = (v: number) => 1 - Math.pow(1 - clamp01(v), 5);
export const easeInOut = (v: number) => {
  const x = clamp01(v);
  return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;
};

/** 0 to 1: how far something that starts at `start` and takes `ms` is at `now` (0 or 1 when reduced). */
export function progress(plan: Plan, start: number | undefined, now: number, ms: number): number {
  if (start === undefined) return 0;
  if (plan.reduced) return now >= start ? 1 : 0;
  return clamp01((now - start) / ms);
}

/** A glow that rises and fades (0 before, peaks early, 0 after); never in reduced motion. */
export function pulse(plan: Plan, start: number | undefined, now: number, ms = GLOW_MS): number {
  if (plan.reduced || start === undefined) return 0;
  const v = (now - start) / ms;
  if (v < 0 || v > 1) return 0;
  return Math.sin(Math.PI * Math.pow(v, 0.6));
}

/** The flights in the air at `now`, with how far along each is. */
export function activeFlights(plan: Plan, now: number): { flight: Flight; t: number }[] {
  if (plan.reduced) return [];
  const out: { flight: Flight; t: number }[] = [];
  for (const f of plan.flights) {
    const v = (now - f.start) / FLIGHT_MS;
    if (v > 0 && v < 1) out.push({ flight: f, t: easeInOut(v) });
  }
  return out;
}

/** Where the device is during the live pass: between the last screen it reached and the next. */
export function deviceAt(plan: Plan, now: number): { from: string; to: string; t: number } | null {
  if (plan.reduced || plan.liveOrder.length === 0) return null;
  const first = plan.liveIn.get(plan.liveOrder[0])!;
  const last = plan.liveIn.get(plan.liveOrder[plan.liveOrder.length - 1])!;
  if (now < first - 400 || now > last + LIVE_MS) return null;
  for (let i = 0; i < plan.liveOrder.length; i++) {
    const at = plan.liveIn.get(plan.liveOrder[i])!;
    if (now < at) {
      const prevId = plan.liveOrder[Math.max(0, i - 1)];
      const prevAt = i === 0 ? at - 400 : plan.liveIn.get(prevId)!;
      return { from: prevId, to: plan.liveOrder[i], t: easeInOut((now - prevAt) / Math.max(1, at - prevAt)) };
    }
  }
  const id = plan.liveOrder[plan.liveOrder.length - 1];
  return { from: id, to: id, t: 1 };
}

/** Whether anything is still moving at `now` (the renderer stops its loop when nothing is). */
export function animating(plan: Plan, now: number): boolean {
  return !plan.reduced ? now < plan.end : now < plan.end + STILL_STEP_MS;
}

/** The file rows lit at `now`: 1 while the file is being read, settling to a quiet "read". */
export function fileGlow(plan: Plan, path: string, now: number): number {
  const at = plan.fileIn.get(path);
  if (at === undefined || now < at) return 0;
  if (plan.reduced) return 0.4;
  const v = (now - at) / 1100;
  return v < 1 ? 1 - 0.6 * easeOut(v) : 0.4;
}
