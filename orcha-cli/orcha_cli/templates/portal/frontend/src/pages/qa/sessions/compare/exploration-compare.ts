/**
 * Compare two explorations: A is the earlier one ("before"), B the later
 * ("after"). Findings match on their `fingerprint`, which the backend keeps stable across runs
 * (lens, feature or route, element, kind or normalized title). Pure: the compare page and the
 * tests call it with two `ExplorationResult`s.
 */
import {
  LENSES,
  type Exploration,
  type ExplorationResult,
  type Lens,
  type LensGrade,
  type ResultFinding,
  type ResultSeverity,
} from "../explorations";

export interface LensDelta {
  lens: Lens;
  /** null when that exploration did not look through this lens. */
  a: number | null;
  b: number | null;
  /** b - a, null unless both looked. */
  delta: number | null;
  gradeA: LensGrade | null;
  gradeB: LensGrade | null;
}

export interface CountDelta {
  a: number;
  b: number;
  delta: number;
}

export interface JourneyChange {
  name: string;
  a: string | null;
  b: string | null;
}

export interface ExplorationComparison {
  score: CountDelta;
  lenses: LensDelta[];
  /** In A, not in B, and B looked through that finding's lens: fixed. */
  fixed: ResultFinding[];
  /** In B, not in A. */
  added: ResultFinding[];
  /** In both (B's copy, the current one). */
  persisting: ResultFinding[];
  /** In A under a lens B did not pick, or on a screen B never reached: B cannot say whether they are fixed. */
  unchecked: ResultFinding[];
  charter: { total: CountDelta; covered: CountDelta; blocked: CountDelta; bug: CountDelta };
  journeys: { passed: CountDelta; total: CountDelta; changes: JourneyChange[] };
  screens: CountDelta;
  steps: CountDelta;
}

const SEVERITY_RANK: Readonly<Record<ResultSeverity, number>> = { blocker: 0, major: 1, minor: 2, cosmetic: 3, info: 4 };

/** Most serious first, then by title, so both columns read the same way. */
export function bySeverity(a: ResultFinding, b: ResultFinding): number {
  return SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || a.title.localeCompare(b.title);
}

function count(a: number | undefined, b: number | undefined): CountDelta {
  const x = a ?? 0;
  const y = b ?? 0;
  return { a: x, b: y, delta: y - x };
}

/** One finding per fingerprint (the first wins), so a duplicate never counts twice. */
function byFingerprint(findings: readonly ResultFinding[]): Map<string, ResultFinding> {
  const out = new Map<string, ResultFinding>();
  for (const f of findings) if (f.fingerprint && !out.has(f.fingerprint)) out.set(f.fingerprint, f);
  return out;
}

export function compareResults(a: ExplorationResult, b: ExplorationResult): ExplorationComparison {
  const lensA = new Map(a.lenses.map((l) => [l.lens, l]));
  const lensB = new Map(b.lenses.map((l) => [l.lens, l]));
  const lenses: LensDelta[] = LENSES.filter((l) => lensA.has(l) || lensB.has(l)).map((lens) => {
    const x = lensA.get(lens);
    const y = lensB.get(lens);
    return {
      lens,
      a: x ? x.score : null,
      b: y ? y.score : null,
      delta: x && y ? Math.round(y.score - x.score) : null,
      gradeA: x?.grade ?? null,
      gradeB: y?.grade ?? null,
    };
  });

  const fa = byFingerprint(a.findings);
  const fb = byFingerprint(b.findings);
  const fixed: ResultFinding[] = [];
  const unchecked: ResultFinding[] = [];
  const persisting: ResultFinding[] = [];
  const added: ResultFinding[] = [];
  // A finding on a screen the later run never reached is not fixed: nobody looked.
  const reachedB = new Set(b.findings.map((f) => f.screen).filter(Boolean));
  const looked = (f: ResultFinding) => lensB.has(f.lens) && (!f.screen || reachedB.size === 0 || reachedB.has(f.screen));
  for (const [fp, f] of fa) {
    if (fb.has(fp)) persisting.push(fb.get(fp)!);
    else if (looked(f)) fixed.push(f);
    else unchecked.push(f);
  }
  for (const [fp, f] of fb) if (!fa.has(fp)) added.push(f);

  const ja = new Map((a.journeys ?? []).map((j) => [j.name, j.outcome]));
  const jb = new Map((b.journeys ?? []).map((j) => [j.name, j.outcome]));
  const changes: JourneyChange[] = [];
  for (const name of new Set([...ja.keys(), ...jb.keys()])) {
    const x = ja.get(name) ?? null;
    const y = jb.get(name) ?? null;
    if (x !== y) changes.push({ name, a: x, b: y });
  }
  const passed = (m: Map<string, string>) => [...m.values()].filter((o) => o === "passed").length;

  return {
    score: count(Math.round(a.score), Math.round(b.score)),
    lenses,
    fixed: fixed.sort(bySeverity),
    added: added.sort(bySeverity),
    persisting: persisting.sort(bySeverity),
    unchecked: unchecked.sort(bySeverity),
    charter: {
      total: count(a.charter.total, b.charter.total),
      covered: count(a.charter.covered, b.charter.covered),
      blocked: count(a.charter.blocked, b.charter.blocked),
      bug: count(a.charter.bug, b.charter.bug),
    },
    journeys: { passed: count(passed(ja), passed(jb)), total: count(ja.size, jb.size), changes },
    screens: count(a.screens, b.screens),
    steps: count(a.steps, b.steps),
  };
}

/** Why two explorations cannot be compared yet, or null when they can. */
export function notComparableReason(a: Pick<Exploration, "result" | "status" | "name">, b: Pick<Exploration, "result" | "status" | "name">): string | null {
  for (const e of [a, b]) {
    if (e.result) continue;
    if (e.status === "done") return `"${e.name}" ran before explorations had scores, so there is nothing to line up yet. Run it again to compare.`;
    if (e.status === "failed" || e.status === "cancelled") return `"${e.name}" did not finish, so it has no result to compare.`;
    return `"${e.name}" is still running. Compare it once it has a result.`;
  }
  return null;
}

/** The pair in time order: the earlier exploration is A. */
export function orderPair<T extends Pick<Exploration, "created_at">>(x: T, y: T): [T, T] {
  return x.created_at <= y.created_at ? [x, y] : [y, x];
}
