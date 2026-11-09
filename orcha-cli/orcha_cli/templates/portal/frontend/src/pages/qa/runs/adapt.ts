/**
 * One QA session as the run page reads it: the document `GET /api/qa/sessions/{id}/run` returns, in
 * the shapes the run screens take. A step's time is its distance from the session's start; a frame
 * "path" is its stored id; a check run's per-criterion rows (`qa_verdicts`, newest wins) roll up to
 * one result per scenario, each criterion spanning the steps since the verdict before it.
 */
import { viewportWord, type QaFinding, type QaScenario, type QaVerdict } from "../qaApi";
import type { QaStep } from "../sessions/api";
import { charterOf, explorationOf, explorationStatus, frameKind } from "../sessions/adapt";
import { toRunExploration, type RunExploration } from "../sessions/exploration-link";
import { actionRangeToStepSeqRange, buildReplayModel } from "./replay/model";
import type { ScenarioResultRow } from "./replay/scenario-results";
import type { RunDetailHeaderProps } from "./replay/run-detail-header";
import type { RunDoc } from "./api";
import type { FailureExplanation } from "./parts/failure-explainer";
import { runCounters } from "./lib/run-counters";
import { resultText, runVerdict, tallyOutcomes } from "./lib/run-list";
import type { Evidence, Finding, Json, RunStatus, RunWithTarget, Scenario, ScenarioOutcome, Severity, Step, TargetKind } from "./types";
import type { TheaterData } from "./theater/types";

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

const RUN_STATUS: Record<string, RunStatus> = { running: "running", done: "completed", failed: "failed", abandoned: "failed", cancelled: "cancelled" };
const MODE_LABEL: Record<string, string> = { map: "Mapping", explore: "Exploration", draft: "Drafting", check: "Scenario check" };
/** A verdict in the source's outcome words: a blocked criterion is one it could not process. */
const OUTCOME: Record<QaVerdict["verdict"], ScenarioOutcome> = { pass: "pass", fail: "fail", blocked: "blocked", inconclusive: "inconclusive" };

/** Milliseconds between two stored times, never negative; 0 when either is missing. */
function msBetween(from: string | null | undefined, to: string | null | undefined): number {
  const a = from ? Date.parse(from) : NaN;
  const b = to ? Date.parse(to) : NaN;
  return Number.isFinite(a) && Number.isFinite(b) ? Math.max(0, b - a) : 0;
}

/** The page or screen a step landed on: its URL path, its title, its stored key. */
function foregroundOf(s: QaStep): string | null {
  // A note's title is what the agent wrote, never a page.
  if (s.kind === "note") return null;
  const a = isObj(s.args) ? s.args : {};
  return str(a.url) || str(a.title) || str(a.route) || s.screen_key || null;
}

/** What the source calls a step's kind, for what ours differ in. */
export function stepsOf(rows: readonly QaStep[], startedAt: string | null): Step[] {
  const start = startedAt ?? rows[0]?.at ?? null;
  return rows.map((s) => ({
    seq: s.seq,
    kind: s.kind,
    args: (s.args ?? {}) as Json,
    result: s.result,
    foreground: foregroundOf(s),
    // A note repeats the screen before it: the player has one frame per screen.
    frame_path: s.kind === "note" ? null : s.frame_id,
    at_ms: msBetween(start, s.at),
    screen_key: s.screen_key,
    screen_hash: s.screen_hash,
  }));
}

/** A raw step seq as an action number: the actions up to and including it. */
function actionNumber(actionSeqs: readonly number[], seq: number | null | undefined): number | null {
  if (seq == null) return null;
  return Math.max(1, actionSeqs.filter((s) => s <= seq).length);
}

function fixPrompt(f: QaFinding, repro: readonly string[]): string {
  const lines = [`Fix this bug: ${f.title}`];
  if (f.expected) lines.push(`Expected: ${f.expected}`);
  if (f.actual) lines.push(`Actual: ${f.actual}`);
  if (f.screen_key) lines.push(`Screen: ${f.screen_key}`);
  if (repro.length) lines.push("Steps to reproduce:", ...repro.map((r, i) => `${i + 1}. ${r}`));
  return lines.join("\n");
}

export interface RunRows {
  steps: Step[];
  findings: Finding[];
  evidence: Evidence[];
  results: ScenarioResultRow[];
  scenarios: Scenario[];
}

const VERDICT_RANK: Record<QaVerdict["verdict"], number> = { fail: 0, blocked: 1, inconclusive: 2, pass: 3 };

/**
 * Each criterion's verdict, by `scenario:criterion`. An Examples table runs a criterion once per
 * row: each row keeps its newest verdict, and the criterion is as bad as its worst row, so a row
 * that passes never hides one that failed.
 */
export function worstVerdicts(verdicts: readonly QaVerdict[]): Map<string, QaVerdict> {
  const perRow = new Map<string, QaVerdict>();
  for (const v of verdicts) perRow.set(`${v.scenario_id}:${v.criterion_index}:${v.example_row ?? ""}`, v);
  const worst = new Map<string, QaVerdict>();
  for (const v of perRow.values()) {
    const key = `${v.scenario_id}:${v.criterion_index}`;
    const held = worst.get(key);
    if (!held || VERDICT_RANK[v.verdict] < VERDICT_RANK[held.verdict]) worst.set(key, v);
  }
  return worst;
}

/** How a check run went by scenario: one passed only when each of its criteria did. */
export function checkTally(verdicts: readonly QaVerdict[]): { passed: number; total: number } | null {
  const ok = new Map<string, boolean>();
  for (const v of worstVerdicts(verdicts).values()) ok.set(v.scenario_id, (ok.get(v.scenario_id) ?? true) && v.verdict === "pass");
  if (!ok.size) return null;
  return { passed: [...ok.values()].filter(Boolean).length, total: ok.size };
}

/** Findings and verdict frames as the replay's evidence rows, findings first in report order. */
function evidenceOf(findings: readonly QaFinding[], verdicts: readonly QaVerdict[]): { rows: Evidence[]; byFrame: Map<string, number> } {
  const rows: Evidence[] = [];
  const byFrame = new Map<string, number>();
  const add = (frame: string, label: string, severity: Evidence["severity"], note: string | null, expected: string | null, actual: string | null) => {
    if (byFrame.has(frame)) return;
    const seq = rows.length + 1;
    byFrame.set(frame, seq);
    // A finding's repro is stored in step numbers, so no evidence row has to correct it.
    rows.push({ seq, step_seq: null, severity, label, png_path: frame, note, expected, actual });
  };
  for (const f of findings) for (const frame of f.frame_ids ?? []) add(frame, f.title, f.severity as Severity, f.detail, f.expected, f.actual);
  for (const v of verdicts) for (const frame of v.frame_ids ?? []) add(frame, v.scenario_name ?? "Verdict", "info", v.note, null, null);
  return { rows, byFrame };
}

/** The step a verdict was recorded at: the `note` step `verdict` writes beside its row. */
function verdictSeqs(steps: readonly QaStep[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const s of steps) {
    const a = isObj(s.args) ? s.args : null;
    if (s.kind === "note" && a && typeof a.scenario_id === "string" && typeof a.criterion_index === "number") out.set(`${a.scenario_id}:${a.criterion_index}`, s.seq);
  }
  return out;
}

const ROLLUP_ORDER: ScenarioOutcome[] = ["fail", "blocked", "inconclusive"];

/**
 * One result per scenario: its criteria in order, each with its newest verdict. A check run sets
 * out to check every scenario, so one with no verdict yet stays in the list while the run goes;
 * while running, the criterion in hand reads `running`.
 */
export function resultsOf(doc: Pick<RunDoc, "session" | "verdicts" | "scenarios" | "steps">, actionSeqs: readonly number[], byFrame: Map<string, number>): ScenarioResultRow[] {
  const running = doc.session.status === "running";
  const at = verdictSeqs(doc.steps);
  const newest = worstVerdicts(doc.verdicts);
  let lastSeq = 0;
  const seqOf = (k: string) => at.get(k) ?? null;
  // Criteria are checked in order, so one spans from just after the verdict recorded before it.
  const ordered = [...at.entries()].sort((a, b) => a[1] - b[1]);
  const startOf = new Map<string, number>();
  for (const [k, seq] of ordered) {
    startOf.set(k, lastSeq + 1);
    lastSeq = seq;
  }
  const out: ScenarioResultRow[] = [];
  let handed = false;
  for (const sc of doc.scenarios) {
    const criteria = (sc.criteria ?? []).map((text, i) => {
      const key = `${sc.id}:${i}`;
      const v = newest.get(key);
      const seq = seqOf(key);
      let outcome: ScenarioOutcome | null = v ? OUTCOME[v.verdict] : null;
      if (!v && running && !handed) {
        outcome = "running";
        handed = true;
      }
      // The run ended and this one got no verdict: said as such, never as a judgement.
      const silent = !v && !running;
      if (silent) outcome = "inconclusive";
      const frames = (v?.frame_ids ?? []).map((f) => byFrame.get(f)).filter((n): n is number => n != null);
      return {
        text,
        outcome,
        ...(silent ? { not_reported: true } : {}),
        from_step: seq != null ? actionNumber(actionSeqs, startOf.get(key) ?? seq) : null,
        to_step: seq != null ? actionNumber(actionSeqs, seq) : null,
        ...(v?.note ? { actual: v.note, explanation: v.note } : {}),
        ...(frames.length ? { evidence_seq: frames[0] } : {}),
      };
    });
    const seen = criteria.map((c) => c.outcome).filter((o): o is ScenarioOutcome => o != null);
    if (!running && !doc.verdicts.some((v) => v.scenario_id === sc.id)) continue;
    const outcome: ScenarioOutcome = seen.includes("running") || (running && seen.length < criteria.length)
      ? "running"
      : ROLLUP_ORDER.find((o) => seen.includes(o)) ?? "pass";
    out.push({ run_id: doc.session.id, scenario_id: sc.id, outcome, reason: null, finding_seqs: [], criteria: criteria as unknown as Json, scenarios: { id: sc.id, name: sc.name, category: sc.category } });
  }
  return out;
}

/** The exploration a session is, for its way back: a map or explore session explores, a drafting
 * one drafts. A check run belongs to no exploration. */
export function explorationLinkOf(doc: Pick<RunDoc, "session" | "findings" | "walks" | "drafts" | "steps_count">): RunExploration | null {
  const s = doc.session;
  if (s.kind === "check") return null;
  const e = explorationOf(s, { findings: doc.findings, walks: doc.walks, drafted: doc.drafts.length, steps: doc.steps_count ?? undefined });
  return toRunExploration({ ...e }, s.kind === "draft" ? "drafter" : "explorer");
}

export function scenarioOf(s: QaScenario, kind: TargetKind): Scenario {
  return { id: s.id, name: s.name, category: s.category, description: s.description, criteria: s.criteria ?? [], status: s.status, depends_on: [], position: null, target_kind: kind };
}

function failureOf(s: RunDoc["session"]): FailureExplanation | null {
  const r = isObj(s.result) ? s.result : {};
  const why = str(r.error) || str(r.reason);
  if (s.status === "cancelled") return { category: "cancelled", sentence: why || "Stopped before it finished.", code: null };
  if (s.status === "failed") return { category: "failed", sentence: why || "It ended before it finished.", code: null };
  return null;
}

/** The session's document as the theater's. */
export function theaterOf(doc: RunDoc): TheaterData & { rows: RunRows } {
  const s = doc.session;
  const kind = frameKind(s) as TargetKind;
  const steps = stepsOf(doc.steps, s.started_at);
  const { rows: evidence, byFrame } = evidenceOf(doc.findings, doc.verdicts);
  const { actionSeqs } = buildReplayModel(steps, [], []);
  const describe = (seq: number | null | undefined) => actionNumber(actionSeqs, seq);
  const findings: Finding[] = doc.findings.map((f, i) => {
    const x = f as QaFinding & { start_seq?: number | null; end_seq?: number | null };
    const from = describe(x.start_seq);
    const to = describe(x.end_seq);
    const range = actionRangeToStepSeqRange(actionSeqs, from, to);
    const repro = range ? steps.filter((st) => st.seq >= range[0] && st.seq <= range[1] && st.kind !== "screen" && st.kind !== "note").map((st) => st.result || st.kind) : [];
    return {
      run_id: s.id,
      seq: i + 1,
      severity: f.severity as Severity,
      title: f.title,
      repro_from_step: from,
      repro_to_step: to,
      evidence_seqs: (f.frame_ids ?? []).map((id) => byFrame.get(id)).filter((n): n is number => n != null),
      note: f.detail,
      expected: f.expected,
      actual: f.actual,
      fix_prompt: fixPrompt(f, repro),
    };
  });
  const scenarios = doc.scenarios.map((sc) => scenarioOf(sc, kind));
  const results = resultsOf(doc, actionSeqs, byFrame);
  const status = RUN_STATUS[s.status] ?? "failed";
  const open = doc.findings.filter((f) => f.status !== "dismissed");
  const counts: RunWithTarget["counts"] = {};
  for (const f of open) counts[f.severity as Severity] = (counts[f.severity as Severity] ?? 0) + 1;
  const durationS = s.started_at && s.ended_at ? msBetween(s.started_at, s.ended_at) / 1000 : null;
  const scenarioRun = s.kind === "check" || results.length > 0;
  const run: RunWithTarget = {
    id: s.id,
    mode: scenarioRun ? "scenarios" : "exploratory",
    status,
    started_at: s.started_at,
    ended_at: s.ended_at,
    duration_s: durationS,
    step_count: doc.steps_count ?? steps.length,
    device_name: s.platform === "web" ? null : s.device_name,
    device: null,
    screen_w: null,
    screen_h: null,
    report_md: s.report_md,
    counts,
    targets: { id: null, kind, locator: s.app_id ?? "", label: s.app_id },
  };
  const abandoned = s.status === "abandoned";
  const verdict = runVerdict(abandoned ? "failed" : status, results.map((r) => r.outcome));
  const live = s.status === "running";
  const waiting = live && !!s.queued_at && !s.claimed_at;
  const counters = runCounters(steps, null);
  const header: RunDetailHeaderProps = {
    run,
    title: `${MODE_LABEL[s.kind] ?? "Run"} · ${s.started_at ? new Date(s.started_at).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : ""}`.replace(/ · $/, ""),
    verdict,
    // In line for a device or an agent: not running yet, and not holding anything.
    verdictResult: waiting ? "Waiting" : resultText(verdict, tallyOutcomes(results.map((r) => r.outcome))),
    kind: s.platform,
    modeLabel: MODE_LABEL[s.kind] ?? s.kind,
    counters,
    live,
    abandoned,
    agent: s.agent_alias ?? null,
    deviceLabel: waiting ? null : s.platform === "web" ? viewportWord(s.device_name) : s.device_name?.replace(/_/g, " ") ?? null,
    task: s.task_title ?? null,
    taskId: s.task_id ?? null,
    failure: failureOf(s),
  };
  const r = isObj(s.result) ? s.result : {};
  return {
    runId: s.id,
    live,
    defaultTab: scenarioRun ? "scenarios" : "steps",
    budgetMinutes: s.budget_minutes,
    charter: charterOf(s.charter, live),
    detail: {
      run,
      kind,
      steps,
      findings,
      evidence,
      logs: doc.logs,
      scenarioResults: results,
      scenarios,
      criterionFeedback: doc.feedback,
      abandoned,
      mapRows: doc.steps,
      mapFindings: doc.findings,
      platform: s.platform,
      sessionDevice: s.device_name,
    },
    header,
    abandonedReason: abandoned ? str(r.error) || str(r.reason) || "it stopped responding." : null,
    phase: explorationStatus(s, doc.drafts.length),
    exploration: explorationLinkOf(doc),
    rows: { steps, findings, evidence, results, scenarios },
  };
}
