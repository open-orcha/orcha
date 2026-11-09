/**
 * Orcha's QA data as the shapes the session screens take. A session is an exploration: its phase
 * comes from what it stored (running without a briefing is still studying, with one it explores),
 * a check run is checking, a map crawl explores from its first step, a drafting run reads until
 * the first draft lands. Everything is read from rows; a field a row does not have stays empty.
 */
import type { QaFinding, QaFlow, QaMeasured, QaSession, QaWalk, SessionDetail } from "../qaApi";
import { isMobileViewport, missionsOf, splitWebEvents, walkName } from "../qaApi";
import type { QaStep } from "./api";
import { composeResult, type WalkedFlow } from "./compose";
import {
  isLens,
  MEASURED_KIND_LENS,
  shortDate,
  scopeLabel,
  studyScreenFromStep,
  type BriefingSource,
  type CharterItem,
  type CharterStatus,
  type Exploration,
  type ExplorationBriefing,
  type ExplorationStatus,
  type Finding,
  type Journey,
  type Lens,
  type ResultFinding,
  type Severity,
  type StudyScreen,
  type WalkCounts,
} from "./explorations";
import type { LiveState } from "./detail/model";
import { fixPromptFor } from "./findings/issue-fix-prompt";
import { describeAction } from "./walked/tree-model";

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

/** Orcha's four severities on the five-step scale: its lightest is the cosmetic one. */
export function severityOf(s: string | null | undefined): Severity {
  return s === "blocker" || s === "major" || s === "minor" ? s : "cosmetic";
}

/**
 * The phase a session is in, from what is stored. Running: a check run is checking; a map crawl
 * has no briefing, so it explores from the start; a drafting run reads until its first draft; an
 * exploration studies until its briefing lands. Ended: done, failed or cancelled, and one that
 * stopped responding reads as failed (its error says so).
 */
export function explorationStatus(s: Pick<QaSession, "kind" | "status" | "briefing" | "queued_at" | "claimed_at">, drafted = 0): ExplorationStatus {
  if (s.status === "running" && s.queued_at && !s.claimed_at) return "queued";
  switch (s.status) {
    case "done":
      return "done";
    case "cancelled":
      return "cancelled";
    case "failed":
    case "abandoned":
      return "failed";
  }
  if (s.kind === "check") return "checking";
  if (s.kind === "map") return "exploring";
  if (s.kind === "draft") return drafted > 0 ? "exploring" : "studying";
  return s.briefing ? "exploring" : "studying";
}

/** Why it ended, in a line, when it did not finish. */
export function endedError(s: Pick<QaSession, "status" | "result">): string | null {
  const r = isObj(s.result) ? s.result : {};
  const why = str(r.error) || str(r.reason);
  if (s.status === "abandoned") return why || "It stopped responding.";
  if (s.status === "failed" || s.status === "cancelled") return why || null;
  return null;
}

function sourcesOf(v: unknown): BriefingSource[] {
  if (!Array.isArray(v)) return [];
  return v.filter(isObj).filter((x) => str(x.ref)).map((x) => ({ kind: (str(x.kind) || "code") as BriefingSource["kind"], ref: str(x.ref), ...(str(x.note) ? { note: str(x.note) } : {}) }));
}

function journeysOf(v: unknown): Journey[] {
  if (!Array.isArray(v)) return [];
  return v.filter(isObj).filter((j) => str(j.name)).map((j, i) => ({
    id: str(j.id) || `j${i + 1}`,
    name: str(j.name),
    ...(str(j.persona) ? { persona: str(j.persona) } : {}),
    steps: (Array.isArray(j.steps) ? j.steps : []).map((x) => (typeof x === "string" ? x.trim() : isObj(x) ? str(x.text) : "")).filter(Boolean),
    ...(Array.isArray(j.features) ? { features: j.features.filter((f): f is string => typeof f === "string") } : {}),
  }));
}

/** A stored briefing, tolerant: it is the agent's JSON, and an unknown field is ignored. */
export function briefingOf(raw: unknown): ExplorationBriefing | null {
  if (!isObj(raw)) return null;
  const read = isObj(raw.sources_read) ? raw.sources_read : {};
  const n = (k: string) => (typeof read[k] === "number" ? (read[k] as number) : 0);
  return {
    app_summary: str(raw.app_summary),
    personas: (Array.isArray(raw.personas) ? raw.personas : []).map((p) => (isObj(p) ? { name: str(p.name), goal: str(p.goal) } : { name: str(p), goal: "" })).filter((p) => p.name),
    journeys: journeysOf(raw.journeys),
    risks: (Array.isArray(raw.risks) ? raw.risks : []).map((r) => (isObj(r) ? { area: str(r.area), why: str(r.why) } : { area: str(r), why: "" })).filter((r) => r.area),
    sources_read: { files: n("files"), tests: n("tests"), scenarios: n("scenarios"), docs: n("docs"), context: read.context === true },
    sources: sourcesOf(raw.sources),
    ...(str(raw.suggested_name) ? { suggested_name: str(raw.suggested_name) } : {}),
  };
}

/**
 * The charter's missions. A mission starts `active` when the briefing is stored, so while the run
 * goes the first one still active is the one in hand and the others are planned; once it ended,
 * one never settled stays planned too. A mission keeps its lens when it has one, else Works right.
 */
export function charterOf(raw: unknown, running: boolean): CharterItem[] {
  const list = Array.isArray(raw) ? raw : isObj(raw) && Array.isArray(raw.missions) ? raw.missions : [];
  const missions = missionsOf(raw);
  let inHand = false;
  return missions.map((m, i) => {
    const r = (list.filter(isObj)[i] ?? {}) as Obj;
    let status: CharterStatus = m.status === "active" ? "planned" : (m.status as CharterStatus);
    if (m.status === "active" && running && !inHand) {
      status = "active";
      inHand = true;
    }
    return {
      id: m.id,
      title: m.title,
      why: m.why ?? "",
      lens: isLens(r.lens) ? r.lens : "works",
      ...(str(r.feature) ? { feature: str(r.feature) } : {}),
      ...(str(r.journey_id) ? { journey_id: str(r.journey_id) } : {}),
      ...(sourcesOf(r.sources).length ? { sources: sourcesOf(r.sources) } : {}),
      status,
      ...(m.note ? { note: m.note } : {}),
      finding_ids: (m.finding_ids ?? []).map(String),
      ...(typeof r.step_seq === "number" ? { step_seq: r.step_seq } : {}),
    };
  });
}

/** The finding as the report lists it: the stored row's id is its fingerprint. */
export function resultFindingOf(f: QaFinding, charter: readonly CharterItem[]): ResultFinding {
  const mission = charter.find((m) => m.finding_ids?.includes(f.id));
  const step = (f as QaFinding & { end_seq?: number | null }).end_seq;
  return {
    fingerprint: f.id,
    lens: isLens(f.lens) ? f.lens : (mission?.lens ?? "works"),
    severity: severityOf(f.severity),
    title: f.title,
    source: "agent",
    ...(mission?.feature ? { feature: mission.feature } : {}),
    ...(f.screen_key ? { screen: f.screen_key } : {}),
    ...(typeof step === "number" ? { step_seq: step } : {}),
    ref_id: f.id,
    ...(f.frame_ids?.[0] ? { evidence: f.frame_ids[0] } : {}),
  };
}

/** What the audit measured, as the report lists it. A measurement it is not sure of stays out of the score. */
export function measuredFindingOf(m: QaMeasured): ResultFinding {
  return {
    fingerprint: m.fingerprint,
    lens: MEASURED_KIND_LENS[m.kind] ?? "visual",
    severity: (["blocker", "major", "minor", "cosmetic", "info"].includes(m.severity) ? m.severity : "info") as ResultFinding["severity"],
    title: m.summary,
    source: "measured",
    ...(m.screen_key ? { screen: m.screen_key } : {}),
    ...(m.step_seq != null ? { step_seq: m.step_seq } : {}),
    ref_id: m.id,
    ...(m.frame_id ? { evidence: m.frame_id } : {}),
  };
}

/** The finding as the run recorded it: `detail`'s prose is its note, its web events stay on the row. */
export function findingOf(f: QaFinding, seq: number, platform?: string | null): Finding {
  const x = f as QaFinding & { start_seq?: number | null; end_seq?: number | null };
  return {
    id: f.id,
    run_id: f.session_id,
    seq,
    title: f.title,
    severity: severityOf(f.severity),
    expected: f.expected,
    actual: f.actual,
    note: splitWebEvents(f.detail, f.events).text || null,
    fix_prompt: fixPromptFor(f.fix_prompt, { title: f.title, expected: f.expected, actual: f.actual, reproFrom: x.start_seq ?? null, reproTo: x.end_seq ?? null, runId: f.session_id, screen: f.screen_key, platform }).text,
    severity_reported: f.severity_reported ? severityOf(f.severity_reported) : null,
    severity_by: f.severity_by === "person" ? "person" : "explorer",
    severity_reason: f.severity_reason ?? null,
    repro_from_step: x.start_seq ?? null,
    repro_to_step: x.end_seq ?? null,
    qa: f,
  };
}

/** One flow of the session as the result counts it. */
export function flowOf(w: QaWalk, flows?: QaFlow[] | null): WalkedFlow {
  return { name: walkName(w, flows) || "Flow", status: w.status, steps: (w.steps ?? []).map((s) => s.text), finding_ids: (w.finding_ids ?? []).map(String) };
}

export function walkCountsOf(walks: readonly QaWalk[]): WalkCounts {
  const c: WalkCounts = { total: walks.length, walked: 0, passed: 0, failed: 0, unreachable: 0, left: 0 };
  for (const w of walks) {
    if (w.status === "passed" || w.status === "failed" || w.status === "unreachable") {
      c[w.status] += 1;
      c.walked += 1;
    } else c.left += 1;
  }
  return c;
}

export interface SessionRows {
  findings: readonly QaFinding[];
  walks: readonly QaWalk[];
  drafted?: number;
  steps?: number;
  flows?: QaFlow[] | null;
  measured?: readonly QaMeasured[];
}

/** Word for the session's name: what the job is and the day it ran. */
export function sessionName(s: Pick<QaSession, "kind" | "started_at" | "briefing" | "name">): string {
  if (s.name?.trim()) return s.name.trim();
  const suggested = isObj(s.briefing) ? str(s.briefing.suggested_name) : "";
  if (suggested) return suggested;
  const day = s.started_at ? shortDate(s.started_at) : "";
  return [scopeLabel(s.kind), day].filter(Boolean).join(" · ");
}

/** A session and its rows as an exploration, with its result once it ended. */
export function explorationOf(s: QaSession, rows: SessionRows): Exploration {
  const running = s.status === "running";
  const status = explorationStatus(s, rows.drafted ?? 0);
  const charter = charterOf(s.charter, running);
  const briefing = briefingOf(s.briefing);
  const measured = (rows.measured ?? []).filter((m) => m.confident).map(measuredFindingOf);
  const lenses: Lens[] = [...new Set([...charter.map((m) => m.lens), ...measured.map((m) => m.lens)])];
  const stored = isObj(s.result) ? s.result : {};
  const steps = rows.steps ?? (typeof stored.steps === "number" ? stored.steps : 0);
  const open = rows.findings.filter((f) => f.status !== "dismissed");
  const duration = s.started_at && s.ended_at ? Math.max(0, (Date.parse(s.ended_at) - Date.parse(s.started_at)) / 1000) : 0;
  // What a stopped session got done is kept: its report sits under the ended state.
  const composed = status === "done" || (!running && (open.length > 0 || rows.walks.length > 0 || steps > 0))
    ? composeResult({
        lenses: lenses.length ? lenses : ["works"],
        charter,
        briefing,
        findings: [...open.map((f) => resultFindingOf(f, charter)), ...measured],
        flows: rows.walks.map((w) => flowOf(w, rows.flows)),
        screens: typeof stored.screens === "number" ? stored.screens : 0,
        steps,
        durationS: duration,
      })
    : null;
  return {
    id: s.id,
    project_id: "",
    series_id: s.series_id ?? s.id,
    name: sessionName(s),
    name_is_custom: !!s.name?.trim(),
    description: s.notes ?? null,
    recipe: s.kind,
    minutes: s.budget_minutes,
    lenses: lenses.length ? lenses : ["works"],
    goal: s.goal?.trim() || null,
    targets: [],
    context: null,
    target_id: null,
    environment_id: null,
    platform: s.platform,
    status,
    request_id: null,
    run_id: s.id,
    report_id: null,
    briefing,
    charter,
    result: composed,
    study: null,
    error: endedError(s),
    started_at: s.started_at,
    study_done_at: null,
    finished_at: s.ended_at,
    archived_at: s.archived_at ?? null,
    pinned_at: s.pinned_at ?? null,
    created_at: s.queued_at ?? s.started_at ?? "",
    updated_at: s.last_seen_at ?? s.started_at ?? "",
  };
}

/** The live state of an open session: its findings and the frames and screens of its steps. */
export function liveStateOf(d: SessionDetail, steps: readonly QaStep[], flows?: QaFlow[] | null): LiveState {
  const exploration = explorationOf(d.session, { findings: d.findings, walks: d.walks, drafted: d.drafts.length, steps: d.steps_count ?? steps.length, flows, measured: d.measured });
  const frames = steps.filter((x) => x.frame_id).map((x) => ({ seq: x.seq, frame_path: x.frame_id as string }));
  const screens: StudyScreen[] = [];
  for (const x of steps) {
    const sc = studyScreenFromStep({ seq: x.seq, kind: x.kind, args: x.args, frame_path: x.frame_id });
    if (sc) screens.push(sc);
  }
  return { exploration, findings: d.findings.map((f, i) => findingOf(f, i + 1, d.session.platform)), frames, screens, steps: d.steps_count ?? steps.length, withheld: false };
}

/** What the session did, newest last, as lines for the activity log. */
export function activityLines(steps: readonly QaStep[]): string[] {
  return steps.map((x) => {
    if (x.kind === "note") return str(x.result) || "Note";
    if (x.kind === "screen") {
      const a = isObj(x.args) ? x.args : {};
      return `Screen: ${str(a.title) || str(a.route) || x.screen_key || "unnamed"}`;
    }
    return describeAction({ kind: x.kind, args: x.args as never, result: x.result });
  });
}

/** The steps to reproduce a finding: the actions between its first and last step. */
export function reproOf(f: Finding, steps: readonly QaStep[]): string[] {
  if (f.repro_from_step == null || f.repro_to_step == null) return [];
  return steps.filter((x) => x.seq >= (f.repro_from_step as number) && x.seq <= (f.repro_to_step as number) && x.kind !== "screen" && x.kind !== "note" && x.kind !== "wait").map((x) => describeAction({ kind: x.kind, args: x.args as never, result: x.result }));
}

/** Is a session's screenshot phone-shaped? A web session's is, on a phone-sized viewport. */
export function frameKind(s: Pick<QaSession, "platform" | "device_name">): "ios" | "android" | "web" {
  if (s.platform === "web" && isMobileViewport(s.device_name)) return "ios";
  return s.platform;
}

