/**
 * A finished session's result, worked out from what it stored: its charter, its findings and its
 * walks. The score, each lens's grade, the verdict line, the next steps and the feature outcomes
 * follow one set of rules, so a session reads the same wherever it is shown. Pure.
 */
import { LENS_META, missionsPhrase, walkPhrase, type CharterItem, type ExplorationBriefing, type ExplorationResult, type FeatureOutcome, type Lens, type LensGrade, type ResultFinding, type ResultSeverity, type WalkCounts } from "./explorations";

const WORKED: ReadonlySet<string> = new Set(["covered", "partial", "bug"]);
const WALKED: ReadonlySet<string> = new Set(["passed", "failed"]);
const FLOW_OUTCOMES: ReadonlySet<string> = new Set(["passed", "failed", "unreachable"]);
const SEVERITIES: readonly ResultSeverity[] = ["blocker", "major", "minor", "cosmetic", "info"];
const SEVERITY_PENALTY: Readonly<Record<ResultSeverity, number>> = { blocker: 35, major: 15, minor: 5, cosmetic: 1, info: 0 };
const GOOD_AT = 80;
const FAIR_AT = 50;
const BLOCKED_ITEM_PENALTY = 10;
const MAX_NEXT = 6;

/** A walk as the result counts it: one flow of the session, its outcome and what it filed. */
export interface WalkedFlow {
  name: string;
  status: string;
  steps?: readonly string[];
  finding_ids?: readonly string[];
}

const sevRank = (s: string) => {
  const i = SEVERITIES.indexOf(s as ResultSeverity);
  return i === -1 ? SEVERITIES.length : i;
};

/** 100 minus the penalty of each distinct finding (by fingerprint), floored at 0. */
export function scoreFindings(findings: readonly Pick<ResultFinding, "fingerprint" | "severity">[]): number {
  const seen = new Map<string, ResultSeverity>();
  for (const f of findings) if (!seen.has(f.fingerprint)) seen.set(f.fingerprint, f.severity);
  let penalty = 0;
  for (const s of seen.values()) penalty += SEVERITY_PENALTY[s] ?? 0;
  return Math.max(0, 100 - penalty);
}

export function grade(score: number, covered: boolean): LensGrade {
  if (!covered) return "unknown";
  if (score >= GOOD_AT) return "good";
  if (score >= FAIR_AT) return "fair";
  return "poor";
}

export function charterCounts(charter: readonly CharterItem[]): ExplorationResult["charter"] {
  const c = { total: charter.length, covered: 0, partial: 0, blocked: 0, bug: 0 };
  for (const m of charter) if (m.status === "covered" || m.status === "partial" || m.status === "blocked" || m.status === "bug") c[m.status] += 1;
  return c;
}

/** The session's flows by outcome; `walked` is passed + failed + unreachable, `left` the rest. */
export function walkCounts(flows: readonly WalkedFlow[]): WalkCounts {
  const c: WalkCounts = { total: flows.length, walked: 0, passed: 0, failed: 0, unreachable: 0, left: 0 };
  for (const f of flows) {
    if (f.status === "passed" || f.status === "failed" || f.status === "unreachable") {
      c[f.status] += 1;
      c.walked += 1;
    } else c.left += 1;
  }
  return c;
}

/** A lens counts as covered once a finding landed in it or a mission of it was worked; with no
 * charter, once the run took steps. A flow walked to an outcome covers Works right. */
function coveredLenses(picked: readonly Lens[], charter: readonly CharterItem[], findings: readonly ResultFinding[], steps: number, flows: readonly WalkedFlow[]): Set<Lens> {
  const covered = new Set<Lens>(findings.map((f) => f.lens));
  for (const m of charter) if (WORKED.has(m.status)) covered.add(m.lens);
  if (!charter.length && steps > 0) for (const l of picked) covered.add(l);
  if (flows.some((f) => WALKED.has(f.status))) covered.add("works");
  return new Set(picked.filter((l) => covered.has(l)));
}

/** Pass or fail per journey, from its missions. Only journeys with missions. */
export function journeyOutcomes(briefing: ExplorationBriefing | null, charter: readonly CharterItem[]): NonNullable<ExplorationResult["journeys"]> {
  const out: NonNullable<ExplorationResult["journeys"]> = [];
  for (const j of briefing?.journeys ?? []) {
    const items = charter.filter((m) => m.journey_id === j.id);
    if (!items.length) continue;
    const bug = items.find((m) => m.status === "bug");
    const blocked = items.find((m) => m.status === "blocked");
    const worked = items.filter((m) => WORKED.has(m.status));
    if (bug) out.push({ id: j.id, name: j.name, outcome: "failed", broke_at: bug.note || bug.title });
    else if (blocked) out.push({ id: j.id, name: j.name, outcome: "blocked", broke_at: blocked.note || blocked.title });
    else if (worked.length === items.length) out.push({ id: j.id, name: j.name, outcome: "passed" });
    else if (!worked.length) out.push({ id: j.id, name: j.name, outcome: "not_run" });
    else out.push({ id: j.id, name: j.name, outcome: "blocked", broke_at: items.find((m) => !WORKED.has(m.status))?.title });
  }
  return out;
}

/** "3 bugs, 1 serious · 2 of 3 journeys passed · Accessible: fair". */
export function verdictLine(findings: readonly ResultFinding[], lensRows: ExplorationResult["lenses"], counts: ExplorationResult["charter"], journeys: NonNullable<ExplorationResult["journeys"]>, walks?: WalkCounts | null): string {
  const bugs = new Map<string, ResultSeverity>();
  for (const f of findings) if (f.source === "agent" && (f.severity === "blocker" || f.severity === "major" || f.severity === "minor")) bugs.set(f.fingerprint, f.severity);
  const serious = [...bugs.values()].filter((s) => s === "blocker" || s === "major").length;
  const parts = [bugs.size ? `${bugs.size} bug${bugs.size !== 1 ? "s" : ""}${serious ? `, ${serious} serious` : ""}` : "No bugs found"];
  const walked = walkPhrase(walks);
  if (walked) parts.push(walked);
  const touched = counts.covered + counts.partial + counts.bug + counts.blocked;
  if (journeys.length) {
    const passed = journeys.filter((j) => j.outcome === "passed").length;
    parts.push(`${passed} of ${journeys.length} journey${journeys.length !== 1 ? "s" : ""} passed`);
  } else if (counts.total && (touched || !walked)) parts.push(missionsPhrase(counts));
  const grades = lensRows.filter((r) => r.lens !== "works" && r.grade !== "unknown").map((r) => `${LENS_META.find((m) => m.key === r.lens)?.label ?? r.lens}: ${r.grade}`);
  if (grades.length) parts.push(grades.join(", "));
  return parts.join(" · ");
}

/** What to do next: a scenario that guards each mission that found a bug, then a fix for each
 * serious finding no such mission covers. */
export function nextSteps(charter: readonly CharterItem[], findings: readonly ResultFinding[]): ExplorationResult["next"] {
  const out: ExplorationResult["next"] = [];
  const linked = new Set<string>();
  const byRef = new Map(findings.filter((f) => f.source === "agent" && f.ref_id).map((f) => [f.ref_id as string, f]));
  for (const m of charter) {
    if (m.status !== "bug") continue;
    const ids = (m.finding_ids ?? []).map(String);
    ids.forEach((i) => linked.add(i));
    const source = ids.map((i) => byRef.get(i)).find(Boolean);
    out.push({ kind: "scenario", title: `Add a scenario: ${m.title}`, detail: m.note || m.why, ...(m.feature ? { feature: m.feature } : {}), ...(source ? { finding: source.fingerprint } : {}) });
  }
  for (const f of [...findings].sort((a, b) => sevRank(a.severity) - sevRank(b.severity))) {
    if (f.source !== "agent" || (f.severity !== "blocker" && f.severity !== "major") || (f.ref_id && linked.has(f.ref_id))) continue;
    out.push({ kind: "fix", title: `Fix: ${f.title}`, finding: f.fingerprint, ...(f.feature ? { feature: f.feature } : {}) });
  }
  return out.slice(0, MAX_NEXT);
}

const norm = (v: unknown) => String(v ?? "").replace(/-/g, " ").toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
const names = (value: unknown, t: { key: string; name: string }) => {
  const said = norm(value);
  return Boolean(said) && (said === norm(t.key) || said === norm(t.name));
};

const FLOW_STOP = new Set(["the", "and", "for", "with", "from", "into", "that", "this", "then", "open", "tap", "click", "see", "user", "app"]);

/** The words a flow or a feature is named by, singular. */
function flowWords(text: string): Set<string> {
  const out = new Set<string>();
  for (const m of text.toLowerCase().matchAll(/[a-z][a-z0-9]+/g)) {
    let w = m[0];
    if (w.length < 3 || FLOW_STOP.has(w)) continue;
    if (w.endsWith("ies") && w.length > 4) w = `${w.slice(0, -3)}y`;
    else if (w.endsWith("s") && !w.endsWith("ss") && w.length > 3) w = w.slice(0, -1);
    out.add(w);
  }
  return out;
}

/** Which feature each flow is in: with one feature every flow is its own; with several, the one
 * whose words its name and steps use most. */
function flowsByTarget(targets: readonly { key: string; name: string }[], flows: readonly WalkedFlow[]): Map<string, WalkedFlow[]> {
  const out = new Map(targets.map((t) => [t.key, [] as WalkedFlow[]]));
  if (targets.length === 1) {
    out.set(targets[0].key, [...flows]);
    return out;
  }
  const prepared = targets.map((t) => [t.key, flowWords(`${t.name} ${t.key.replace(/-/g, " ")}`)] as const);
  for (const f of flows) {
    const said = flowWords([f.name, ...(f.steps ?? [])].join(" "));
    let best: string | null = null;
    let most = 0;
    for (const [key, words] of prepared) {
      const shared = [...words].filter((w) => said.has(w)).length;
      if (shared > most) {
        most = shared;
        best = key;
      }
    }
    if (best) out.get(best)?.push(f);
  }
  return out;
}

/** What the run did for each feature its charter named. */
export function featureOutcomes(targets: readonly { key: string; name: string }[], charter: readonly CharterItem[], findings: readonly ResultFinding[], flows: readonly WalkedFlow[]): FeatureOutcome[] {
  const only = targets.length === 1;
  const byTarget = flowsByTarget(targets, flows);
  return targets.map((t) => {
    const items = charter.filter((m) => names(m.feature, t) || (only && !m.feature));
    const worked = items.filter((m) => WORKED.has(m.status));
    const left = items.filter((m) => !WORKED.has(m.status));
    const mine = byTarget.get(t.key) ?? [];
    const walked = mine.filter((f) => WALKED.has(f.status));
    const open = mine.filter((f) => !WALKED.has(f.status));
    const walkFound = new Set(mine.flatMap((f) => (f.finding_ids ?? []).map(String)));
    const found = findings.filter((f) => f.source === "agent" && (names(f.feature, t) || (only && !f.feature) || walkFound.has(f.ref_id ?? "")));
    const outcome: FeatureOutcome["outcome"] = (worked.length || walked.length) && !left.length && !open.length && worked.every((m) => m.status !== "partial") ? "explored" : worked.length || walked.length || found.length ? "partly" : "not_reached";
    const row: FeatureOutcome = { key: t.key, name: t.name, outcome, checked: worked.map((m) => m.title).slice(0, 8), left: left.map((m) => m.title).slice(0, 8), findings: new Set(found.map((f) => f.fingerprint)).size };
    if (mine.length) {
      row.walked = mine.filter((f) => FLOW_OUTCOMES.has(f.status)).map((f) => ({ name: f.name, status: f.status as "passed" | "failed" | "unreachable" })).slice(0, 8);
      const queued = mine.filter((f) => !FLOW_OUTCOMES.has(f.status)).length;
      if (queued) row.flows_left = queued;
    }
    const worst = [...found].sort((a, b) => sevRank(a.severity) - sevRank(b.severity))[0]?.severity;
    if (worst) row.worst = worst;
    const why = left.find((m) => m.status === "blocked" && m.note)?.note;
    if (why && outcome !== "explored") row.note = why.slice(0, 200);
    return row;
  });
}

export interface ComposeInput {
  lenses: readonly Lens[];
  charter: readonly CharterItem[];
  briefing: ExplorationBriefing | null;
  findings: readonly ResultFinding[];
  flows: readonly WalkedFlow[];
  screens: number;
  steps: number;
  durationS: number;
}

/** The result of a session that ended. */
export function composeResult(i: ComposeInput): ExplorationResult {
  const findings = [...i.findings].sort((a, b) => sevRank(a.severity) - sevRank(b.severity) || a.lens.localeCompare(b.lens) || a.title.localeCompare(b.title));
  const walks = i.flows.length ? walkCounts(i.flows) : undefined;
  const covered = coveredLenses(i.lenses, i.charter, findings, i.steps, i.flows);
  const lensRows = i.lenses.map((lens) => {
    const inLens = findings.filter((f) => f.lens === lens);
    const score = scoreFindings(inLens);
    return { lens, score, grade: grade(score, covered.has(lens)), findings: inLens.length };
  });
  const counts = charterCounts(i.charter);
  const scored = lensRows.filter((r) => r.grade !== "unknown").map((r) => r.score);
  const average = scored.length ? Math.round(scored.reduce((n, s) => n + s, 0) / scored.length) : 0;
  const journeys = journeyOutcomes(i.briefing, i.charter);
  const targets: { key: string; name: string }[] = [];
  for (const m of i.charter) if (m.feature && !targets.some((t) => t.key === m.feature)) targets.push({ key: m.feature, name: m.feature });
  const result: ExplorationResult = {
    verdict: verdictLine(findings, lensRows, counts, journeys, walks),
    score: Math.max(0, average - BLOCKED_ITEM_PENALTY * counts.blocked),
    lenses: lensRows,
    charter: counts,
    findings,
    screens: i.screens,
    steps: i.steps,
    duration_s: Math.round(i.durationS * 10) / 10,
    study_s: 0,
    next: nextSteps(i.charter, findings),
  };
  if (journeys.length) result.journeys = journeys;
  if (walks) result.walks = walks;
  if (targets.length) result.features = featureOutcomes(targets, i.charter, findings, i.flows);
  return result;
}
