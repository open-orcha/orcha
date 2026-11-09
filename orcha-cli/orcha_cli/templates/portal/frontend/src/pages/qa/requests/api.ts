/**
 * QA requests (the handoff record) and QA settings: docs/orcha-qa-plan.md "Handoff and workflow
 * integration"; portal_backend/qa_handoff.py; /openapi.json is the source of truth.
 *
 * A request is what an agent or a person asks QA to do, with the task or workflow it came from and
 * the result that comes back. Readers stay tolerant, like the rest of the QA API: JSON columns may be
 * null, lists may arrive bare or wrapped, and unknown fields are ignored (never shown raw).
 */
import type { Conditions } from "../conditions/conditions";
import { getJSON, sendJSON } from "../../../api/client";
import { listOf, type Platform, type QaFinding, type QaRequestKind, type Verdict } from "../qaApi";
import { normalizeDiagnoses, type DiagnosisRow } from "../triage/api";

export type QaRequestStatus = "requested" | "running" | "passed" | "failed" | "blocked" | "cancelled";
export type QaOnFail = "report" | "reopen";
export type QaTrigger = "manual" | "ui_changes" | "always";

export interface QaRequestBuild {
  branch?: string | null;
  commit?: string | null;
  url?: string | null;
  app_path?: string | null;
  notes?: string | null;
}

/** One acceptance line and what QA said about it. */
export interface QaLineResult {
  index: number;
  text: string;
  verdict: Verdict | null;
  note: string | null;
  frame_ids: string[];
  session_id: string | null;
}

export interface QaScenarioResult {
  scenario_id: string;
  name: string | null;
  verdict: Verdict | null;
  note: string | null;
  frame_ids: string[];
}

export interface QaRequestResult {
  summary: string | null;
  lines: QaLineResult[];
  scenarios: QaScenarioResult[];
  finding_ids: string[];
  draft_ids: string[];
  session_ids: string[];
  /** What the run found, kept on the result. */
  findings: QaFinding[];
  /** A triage request: each finding's diagnosis, and what goes on. */
  diagnoses: DiagnosisRow[];
  confirmed_ids: string[];
  decision: string | null;
  /** The run's own facts, as the server gave them: read through `runTask/model`, never shown raw. */
  facts?: Record<string, unknown>;
}

/** How a request came to be: a handoff, a trigger on task completion, a workflow step, a fix round, a re-check. */
export type QaRequestOrigin = "handoff" | "trigger" | "workflow" | "reopen" | "recheck" | "auto_triage";

export interface QaRequest {
  id: string;
  container_id: string | null;
  kind: QaRequestKind;
  /** A triage request: the findings it judges. */
  finding_ids: string[];
  platform: Platform | null;
  origin: QaRequestOrigin;
  previous_request_id: string | null;
  source_task_id: string | null;
  source_task_title: string | null;
  source_workflow_id: string | null;
  source_workflow_title: string | null;
  source_agent_id: string | null;
  source_agent_alias: string | null;
  requested_by_agent_id: string | null;
  requested_by_alias: string | null;
  approved_by_alias: string | null;
  qa_task_id: string | null;
  qa_task_title: string | null;
  round: number;
  max_rounds: number | null;
  scenario_ids: string[];
  tags: string[];
  focus: string | null;
  acceptance: string[];
  build: QaRequestBuild | null;
  on_fail: QaOnFail;
  status: QaRequestStatus;
  result: QaRequestResult | null;
  /** Verdicts so far, while `result` is null (detail read only). */
  live_lines: QaLineResult[];
  created_at: string | null;
  finished_at: string | null;
  /** The session that is running or ran it, when the server joins it. */
  session_id: string | null;
  session_status: string | null;
  /** Detail read only: the findings it led to, and every round of its chain, oldest first. */
  findings: QaFinding[];
  rounds: QaRound[];
}

export interface QaRound { id: string; round: number; status: QaRequestStatus; summary: string | null }

export interface QaSettings {
  agent_id: string | null;
  agent_alias: string | null;
  /** `set` a person chose it, `role` its role says QA, `none` no QA agent yet. */
  agent_source: "set" | "role" | "none";
  default_platform: Platform | null;
  trigger: QaTrigger;
  on_fail: QaOnFail;
  max_rounds: number;
  /** Triage a failed run's findings by itself: each one holds a device and spends model time. */
  auto_triage: QaAutoTriage;
  max_per_run: number;
  /** Work may finish with no person when everything is proven (`runTask/finishing`). Off by default. */
  finish_when_proven: boolean;
  /** Who turned that on, and when. */
  finish_enabled_by: string | null;
  finish_enabled_at: string | null;
}

export type QaAutoTriage = "off" | "critical" | "all";
export const DEFAULT_MAX_PER_RUN = 2;
export const DEFAULT_QA_SETTINGS: QaSettings = { agent_id: null, agent_alias: null, agent_source: "none", default_platform: null, trigger: "manual", on_fail: "report", max_rounds: 3, auto_triage: "off", max_per_run: DEFAULT_MAX_PER_RUN, finish_when_proven: false, finish_enabled_by: null, finish_enabled_at: null };
export const MIN_ROUNDS = 1;
export const MAX_ROUNDS = 10;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);
const text = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v : null);
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && !!x.trim()) : []);
const frames = (o: Obj): string[] => {
  const single = text(o.frame_id);
  return [...strings(o.frame_ids), ...(single ? [single] : [])];
};
const verdict = (o: Obj): Verdict | null => text(o.verdict) as Verdict | null;

/** An acceptance line: a bare string or `{text}`. */
function lineText(v: unknown): string | null {
  return typeof v === "string" ? text(v) : isObj(v) ? text(v.text) ?? text(v.line) : null;
}

function normalizeLine(raw: unknown, i: number, acceptance: readonly string[]): QaLineResult | null {
  if (!isObj(raw)) return null;
  const index = typeof raw.line_index === "number" ? raw.line_index : typeof raw.index === "number" ? raw.index : typeof raw.line === "number" ? raw.line : i;
  return {
    index,
    text: text(raw.text) ?? (typeof raw.line === "string" ? raw.line : null) ?? acceptance[index] ?? `Line ${index + 1}`,
    verdict: verdict(raw),
    note: text(raw.note),
    frame_ids: frames(raw),
    session_id: text(raw.session_id),
  };
}

/** A result column: per-line and per-scenario verdicts, ids, the summary. */
export function normalizeResult(raw: unknown, acceptance: readonly string[] = []): QaRequestResult | null {
  if (!isObj(raw)) return null;
  const rawLines = raw.lines ?? raw.line_verdicts ?? raw.acceptance;
  const rawScenarios = raw.scenarios ?? raw.scenario_verdicts;
  return {
    summary: text(raw.summary),
    lines: listOf<unknown>(rawLines).map((l, i) => normalizeLine(l, i, acceptance)).filter((l): l is QaLineResult => !!l),
    scenarios: listOf<unknown>(rawScenarios).filter(isObj).map((s) => ({
      scenario_id: String(s.scenario_id ?? s.id ?? ""),
      name: text(s.scenario_name) ?? text(s.name),
      verdict: verdict(s),
      note: text(s.note),
      frame_ids: frames(s),
    })),
    finding_ids: strings(raw.finding_ids),
    draft_ids: strings(raw.draft_ids),
    session_ids: strings(raw.session_ids),
    findings: listOf<QaFinding>(raw.findings),
    diagnoses: normalizeDiagnoses(raw.diagnoses),
    confirmed_ids: strings(raw.confirmed_ids),
    decision: text(raw.decision),
    facts: raw,
  };
}

export function normalizeRequest(raw: unknown): QaRequest {
  const r = isObj(raw) ? (isObj(raw.request) ? { ...raw, ...raw.request } as Obj : raw) : {};
  const acceptance = listOf<unknown>(r.acceptance).map(lineText).filter((l): l is string => !!l);
  const rolled = normalizeResult(r.result, acceptance);
  const result = rolled ? { ...rolled, decision: rolled.decision ?? text(r.decision) } : null;
  // Verdicts as they land, while `result` is still null. The newest row for a line wins.
  const live = new Map<number, QaLineResult>();
  listOf<unknown>(r.line_verdicts).forEach((l, i) => { const n = normalizeLine(l, i, acceptance); if (n) live.set(n.index, n); });
  const session = isObj(r.session) ? r.session : null;
  return {
    id: String(r.id ?? ""),
    container_id: text(r.container_id),
    kind: (text(r.kind) ?? "explore") as QaRequestKind,
    finding_ids: strings(r.finding_ids),
    platform: text(r.platform) as Platform | null,
    origin: (text(r.origin) ?? "handoff") as QaRequestOrigin,
    previous_request_id: text(r.previous_request_id),
    source_task_id: text(r.source_task_id),
    source_task_title: text(r.source_task_title),
    source_workflow_id: text(r.source_workflow_id),
    source_workflow_title: text(r.source_workflow_title),
    source_agent_id: text(r.source_agent_id),
    source_agent_alias: text(r.source_agent_alias),
    requested_by_agent_id: text(r.requested_by_agent_id),
    requested_by_alias: text(r.requested_by_alias),
    approved_by_alias: text(r.approved_by_alias),
    qa_task_id: text(r.qa_task_id),
    qa_task_title: text(r.qa_task_title),
    round: typeof r.round === "number" ? r.round : 1,
    max_rounds: typeof r.max_rounds === "number" ? r.max_rounds : null,
    scenario_ids: strings(r.scenario_ids),
    tags: strings(r.tags),
    focus: text(r.focus),
    acceptance,
    build: isObj(r.build) ? (r.build as QaRequestBuild) : null,
    on_fail: r.on_fail === "reopen" ? "reopen" : "report",
    status: (text(r.status) ?? "requested") as QaRequestStatus,
    result,
    live_lines: [...live.values()],
    created_at: text(r.created_at),
    finished_at: text(r.finished_at),
    session_id: text(r.session_id) ?? (session ? text(session.id) : null) ?? result?.session_ids[0] ?? null,
    session_status: text(r.session_status) ?? (session ? text(session.status) : null),
    findings: listOf<QaFinding>(r.findings),
    rounds: listOf<unknown>(r.rounds).filter(isObj).map((x) => ({ id: String(x.id ?? ""), round: typeof x.round === "number" ? x.round : 1, status: (text(x.status) ?? "requested") as QaRequestStatus, summary: text(x.summary) })),
  };
}

export function normalizeSettings(raw: unknown): QaSettings {
  const r = isObj(raw) ? (isObj(raw.settings) ? raw.settings : raw) : {};
  const rounds = typeof r.max_rounds === "number" ? Math.min(MAX_ROUNDS, Math.max(MIN_ROUNDS, Math.round(r.max_rounds))) : DEFAULT_QA_SETTINGS.max_rounds;
  const agent = text(r.agent_id);
  return {
    agent_id: agent,
    agent_alias: text(r.agent_alias),
    agent_source: r.agent_source === "set" || r.agent_source === "role" ? r.agent_source : agent ? "set" : "none",
    default_platform: text(r.default_platform) as Platform | null,
    trigger: r.trigger === "ui_changes" || r.trigger === "always" ? r.trigger : "manual",
    on_fail: r.on_fail === "reopen" ? "reopen" : "report",
    max_rounds: rounds,
    auto_triage: r.auto_triage === "critical" || r.auto_triage === "all" ? r.auto_triage : "off",
    max_per_run: typeof r.max_per_run === "number" && r.max_per_run >= 1 ? Math.round(r.max_per_run) : DEFAULT_MAX_PER_RUN,
    finish_when_proven: r.final_decision === "quality",
    finish_enabled_by: text(r.final_decision_by_alias),
    finish_enabled_at: text(r.final_decision_at),
  };
}

/** The body of a handoff (`POST /api/tasks/{tid}/qa/requests`, `POST C/requests`). */
export interface QaRequestInput {
  kind: QaRequestKind;
  platform: Platform | null;
  focus?: string | null;
  acceptance?: string[];
  scenario_ids?: string[];
  tags?: string[];
  build?: QaRequestBuild | null;
  on_fail?: QaOnFail;
  /** What the run must be under (an OS version, a language, an account...). */
  conditions?: Conditions | null;
}

const enc = encodeURIComponent;
const C = (cid: string) => `/api/containers/${enc(cid)}/qa`;

/** The readable fields of a build, or null when none is filled in. */
export function cleanBuild(b: QaRequestBuild | null | undefined): QaRequestBuild | null {
  const out: QaRequestBuild = {};
  for (const k of ["branch", "commit", "url", "app_path", "notes"] as const) {
    const v = (b?.[k] ?? "").trim();
    if (v) out[k] = v;
  }
  return Object.keys(out).length ? out : null;
}

export async function sendTaskToQa(taskId: string, actor: string | null, input: QaRequestInput) {
  const res = await sendJSON<unknown>("POST", `/api/tasks/${enc(taskId)}/qa/requests`, { ...input, actor_agent_id: actor });
  return { request: normalizeRequest(res), qa_task_id: isObj(res) ? text(res.qa_task_id) : null };
}

export interface RequestFilter { kind?: string | null; source_task_id?: string | null; source_workflow_id?: string | null; status?: string | null; limit?: number }

export async function listRequests(cid: string, f: RequestFilter = {}, signal?: AbortSignal): Promise<QaRequest[]> {
  const q = Object.entries({ limit: 200, ...f }).filter(([, v]) => v != null && v !== "").map(([k, v]) => `${k}=${enc(String(v))}`).join("&");
  // A row with no kind is not a QA request: it is never shown as one.
  const rows = listOf<unknown>(await getJSON<unknown>(`${C(cid)}/requests?${q}`, signal), "requests").filter((r) => isObj(r) && typeof r.kind === "string").map(normalizeRequest);
  // Narrow here too: a server may read only some of the filters.
  return rows.filter((r) => (!f.source_task_id || r.source_task_id === f.source_task_id) && (!f.source_workflow_id || r.source_workflow_id === f.source_workflow_id));
}

export const getRequest = async (id: string, signal?: AbortSignal) =>
  normalizeRequest(await getJSON<unknown>(`/api/qa/requests/${enc(id)}`, signal));

export const cancelRequest = async (id: string, actor: string | null) =>
  normalizeRequest(await sendJSON<unknown>("POST", `/api/qa/requests/${enc(id)}/cancel`, { actor_agent_id: actor }));

export const getQaSettings = async (cid: string, signal?: AbortSignal) =>
  normalizeSettings(await getJSON<unknown>(`${C(cid)}/settings`, signal));

/** Saves a chosen agent only: an agent found by its role stays found by its role. */
export const saveQaSettings = async (cid: string, actor: string | null, s: QaSettings) =>
  normalizeSettings(await sendJSON<unknown>("PUT", `${C(cid)}/settings`, {
    actor_agent_id: actor, agent_id: s.agent_source === "set" ? s.agent_id : null, default_platform: s.default_platform, trigger: s.trigger, on_fail: s.on_fail, max_rounds: s.max_rounds, auto_triage: s.auto_triage, max_per_run: s.max_per_run, final_decision: s.finish_when_proven ? "quality" : "person",
  }));

/** The server's workflow presets. `draft` is a workflow draft on the wire. */
export interface QaWorkflowPreset { key: string; name: string; description: string | null; draft: Record<string, unknown> }

/** A Quality workflow a person can add: `tails` is what the step after it waits for, `closing` the step it brings when nothing follows. */
export interface QaWorkflowBlock extends QaWorkflowPreset { tails?: string[]; closing?: Record<string, unknown> | null }

/** The one catalogue. A whole-workflow preset is a Build step plus one of these. */
export const listWorkflowBlocks = async (cid: string, signal?: AbortSignal): Promise<QaWorkflowBlock[]> =>
  listOf<QaWorkflowBlock>(await getJSON<unknown>(`${C(cid)}/workflow-blocks`, signal), "blocks");
