/**
 * QA API (portal_backend/qa_routes.py — contract: docs/orcha-qa-plan.md "HTTP API";
 * /openapi.json is the source of truth once the routes land).
 *
 * Container scope C = /api/containers/{cid}/qa. Writes carry the acting human as
 * actor_agent_id (trust-off lane); under the trusted proxy the server ignores it and
 * uses the verified identity. Only a human may set a scenario's status, decide a
 * suggestion or edit targets — the server enforces, the UI only mirrors it.
 *
 * Every reader is tolerant: optional JSON columns may be null, a list may arrive as
 * `{items}` or bare, and unknown fields are ignored (never shown as raw JSON).
 */
import type { Conditions } from "./conditions/conditions";
import { getJSON, sendJSON } from "../../api/client";

export type Platform = "ios" | "android" | "web";
export const PLATFORMS: Platform[] = ["ios", "android", "web"];

/** `?platform=` → a platform (iOS when missing or unknown). */
export function parsePlatform(v: string | null | undefined): Platform {
  return v === "android" || v === "web" ? v : "ios";
}

/** The platform a page opens on with no `?platform=`: iOS when it has an app, else the first that does. */
export function defaultPlatform(targets: readonly { platform: Platform; app_id?: string | null }[] | null | undefined): Platform {
  return PLATFORMS.find((p) => targets?.some((t) => t.platform === p && t.app_id)) ?? "ios";
}

/** Web viewports (qa_targets.device_name for web). */
export type WebViewport = "desktop" | "mobile";
export const WEB_VIEWPORTS: { key: WebViewport; label: string; size: string }[] = [
  { key: "desktop", label: "Desktop", size: "1280×800" },
  { key: "mobile", label: "Mobile", size: "390×844" },
];

/** A web device_name as people read it: "Desktop (1280×800)". Unknown → the raw name. */
export function viewportWord(device: string | null | undefined): string {
  const v = WEB_VIEWPORTS.find((x) => x.key === (device || "desktop").toLowerCase());
  return v ? `${v.label} (${v.size})` : String(device);
}

/** Is a web session / target shown in a phone-shaped frame? (mobile viewport) */
export function isMobileViewport(device: string | null | undefined): boolean {
  return (device || "").toLowerCase() === "mobile";
}

export type NodeState = "seen" | "declared" | "blocked";
export type BlockedKind = "needs_sign_in" | "needs_data" | "needs_permission" | "paywall" | "external" | "crash" | "other";
export type MapSource = "code" | "tests" | "live" | "crawl" | "agent";
export type ScenarioStatus = "draft" | "validated" | "paused" | "retired";
export type EvidenceStatus = "verified" | "unconfirmed" | "code_only";
export type SessionKind = "map" | "explore" | "draft" | "check";
export type QaRequestKind = SessionKind | "triage";
export type SessionStatus = "running" | "done" | "failed" | "cancelled" | "abandoned";
export type MissionStatus = "active" | "covered" | "partial" | "blocked" | "bug";
export type WalkStatus = "walking" | "passed" | "failed" | "unreachable" | "abandoned";
export type Severity = "blocker" | "major" | "minor" | "trivial";
export type FindingStatus = "open" | "filed" | "dismissed";
export type SuggestionStatus = "proposal" | "accepted" | "dismissed";
export type Verdict = "pass" | "fail" | "blocked" | "inconclusive";

export interface QaTarget {
  platform: Platform;
  app_id: string | null;
  app_name: string | null;
  build_path: string | null;
  device_name: string | null;
  notes: string | null;
  updated_at?: string | null;
  updated_by_agent_id?: string | null;
}

export interface QaFeature {
  id: string;
  key: string;
  name: string;
  summary: string | null;
  entry: string | null;
  paths: string[] | null;
  source: string | null;
  last_explored_at: string | null;
}

export interface QaNode {
  id: string;
  platform: Platform;
  kind: "screen" | "endpoint" | "entity" | "flow";
  key: string;
  label: string | null;
  feature_key: string | null;
  state: NodeState;
  blocked_kind: BlockedKind | null;
  blocked_reason: string | null;
  sources: MapSource[] | null;
  evidence?: unknown;
  detail?: unknown;
  frame_id: string | null;
  last_seen_at: string | null;
  created_at?: string | null;
  updated_at?: string | null;
}

export interface QaEdge {
  id: string;
  platform: Platform;
  kind: "navigates" | "calls" | "reads" | "writes" | "steps";
  from_node_id: string;
  to_node_id: string;
  label: string | null;
  count: number | null;
  sources?: MapSource[] | null;
}

export interface QaMapBuild {
  id: string;
  platform: Platform;
  source: string | null;
  status: "running" | "done" | "failed";
  counts?: Record<string, number> | null;
  error: string | null;
  started_at: string | null;
  ended_at: string | null;
  agent_id?: string | null;
}

export interface QaMap {
  features: QaFeature[];
  nodes: QaNode[];
  edges: QaEdge[];
  last_build: QaMapBuild | null;
}

export interface Mission {
  id: string;
  title: string;
  why?: string | null;
  status: MissionStatus;
  note?: string | null;
  finding_ids?: string[] | null;
}

export interface QaSession {
  id: string;
  /** What this run was asked to run under. */
  conditions?: Conditions | null;
  kind: SessionKind;
  platform: Platform;
  task_id: string | null;
  task_title?: string | null;
  agent_id: string | null;
  agent_alias?: string | null;
  device_name: string | null;
  device_udid?: string | null;
  app_id: string | null;
  status: SessionStatus;
  budget_minutes: number | null;
  goal: string | null;
  /** The build it ran on, and a map session's planned crawl as it stands. */
  build_label?: string | null;
  crawl_queue?: unknown;
  briefing?: unknown;
  charter?: unknown;
  result?: unknown;
  report_md: string | null;
  started_at: string | null;
  ended_at: string | null;
  last_seen_at: string | null;
  steps_count?: number | null;
  /** What a person keeps on it. */
  name?: string | null;
  notes?: string | null;
  archived_at?: string | null;
  pinned_at?: string | null;
  /** Its series: Run again stays in it. */
  series_id?: string | null;
  previous_session_id?: string | null;
  /** Queued: waiting for its agent until `claimed_at`. */
  queued_at?: string | null;
  claimed_at?: string | null;
  /** The QA request it runs, when it came from a handoff. */
  request_id?: string | null;
  /** Why it stopped, in a sentence: only a run that did not finish has one. */
  stop_reason?: string | null;
  /** In line for a device or an agent: `status` still says running. */
  queued?: boolean;
}

export interface WalkStep {
  index: number;
  text: string;
  reached: boolean;
  result?: string | null;
  checked?: string[] | null;
  finding_id?: string | null;
  frame_id?: string | null;
  seq?: number | null;
  screen_key?: string | null;
  at?: string | null;
}

export interface QaWalk {
  id: string;
  session_id: string;
  flow_id: string | null;
  /** scenario detail joins the flow; session detail doesn't (the name comes from GET C/flows) */
  flow?: { id: string; key: string; name: string } | null;
  flow_name?: string | null;
  status: WalkStatus;
  blocked_kind: BlockedKind | null;
  reason: string | null;
  steps: WalkStep[] | null;
  scenario_id: string | null;
  finding_ids?: string[] | null;
  started_at: string | null;
  ended_at: string | null;
}

export interface QaFinding {
  id: string;
  /** What it takes to reproduce it: what it was found under, or what a person set. */
  conditions?: Conditions | null;
  /** Its session's platform (the triage inbox). */
  platform?: Platform | null;
  /** web: page events (console errors, failed requests, 5xx) — also accepted inside `detail` */
  events?: unknown;
  session_id: string;
  task_id: string | null;
  severity: Severity;
  title: string;
  detail: string | null;
  expected: string | null;
  actual: string | null;
  frame_ids: string[] | null;
  screen_key: string | null;
  status: FindingStatus;
  filed_task_id: string | null;
  filed_task_title?: string | null;
  created_at: string;
  lens?: string | null;
  fix_prompt?: string | null;
  severity_reported?: Severity | null;
  severity_by?: string | null;
  severity_reason?: string | null;
  /** The one scenario drafted from it. */
  scenario_id?: string | null;
  /** The QA request it was found under. */
  request_id?: string | null;
  /** A diagnosis once triage reached it (triage/api.normalizeDiagnosis reads it). */
  triage?: unknown;
  /** Its severity before triage re-rated it. */
  severity_original?: Severity | null;
  duplicate_of?: string | null;
}

/** What the audit measured on a screen, apart from what an agent judged. */
export interface QaMeasured {
  id: string;
  session_id: string;
  fingerprint: string;
  kind: string;
  severity: string;
  summary: string;
  measured: number | null;
  threshold: number | null;
  unit: string | null;
  rect: number[] | null;
  element_label: string | null;
  element_identifier: string | null;
  appearance: string | null;
  confident: boolean;
  extra: Record<string, unknown>;
  screen_key: string | null;
  screen_hash: string | null;
  frame_id: string | null;
  step_seq: number | null;
  created_at: string;
}

export interface QaEvidence {
  id: string;
  scenario_id?: string;
  criterion_index: number;
  status: EvidenceStatus;
  frame_id: string | null;
  code_ref: string | null;
  note: string | null;
}

export interface QaSuggestion {
  id: string;
  scenario_id: string;
  scenario_name?: string | null;
  proposed: Partial<ScenarioFields> | null;
  reason: string | null;
  status: SuggestionStatus;
  session_id?: string | null;
  agent_id?: string | null;
  agent_alias?: string | null;
  created_at?: string | null;
}

export interface QaVerdict {
  id: string;
  session_id: string;
  scenario_id: string;
  scenario_name?: string | null;
  criterion_index: number;
  /** The Examples row it is for; none when the scenario has no table. */
  example_row?: number | null;
  verdict: Verdict;
  note: string | null;
  frame_ids: string[] | null;
  created_at: string;
}

export interface ScenarioFields {
  /** What every run of it needs (`conditions/conditions.ts`). */
  conditions?: Conditions | null;
  name: string;
  category: string | null;
  persona: string | null;
  description: string | null;
  criteria: string[];
  tags: string[] | null;
}

export interface QaScenario extends ScenarioFields {
  id: string;
  platform: Platform;
  source: "authored" | "generated" | "walk" | null;
  status: ScenarioStatus;
  status_reason: string | null;
  walk_id: string | null;
  session_id: string | null;
  task_id: string | null;
  created_by_agent_id?: string | null;
  validated_by_agent_id?: string | null;
  validated_at?: string | null;
  created_at: string | null;
  updated_at: string | null;
  /** detail only (GET /api/qa/scenarios/{id}) */
  evidence?: QaEvidence[] | null;
  walk?: QaWalk | null;
  suggestions?: QaSuggestion[] | null;
  /** detail only: the latest verdict per criterion */
  verdicts?: QaVerdict[] | null;
}

export interface SessionDetail {
  session: QaSession;
  walks: QaWalk[];
  findings: QaFinding[];
  steps_count: number | null;
  drafts: QaScenario[];
  verdicts: QaVerdict[];
  measured?: QaMeasured[];
  /** A queued session's place in line. */
  queue?: { position: number | null; waiting: string | null } | null;
}

export interface QaFlow {
  id: string;
  platform: Platform;
  key: string;
  name: string;
  persona: string | null;
  criticality: "high" | "medium" | "low" | null;
  status: string | null;
  steps?: unknown;
  data?: Record<string, unknown> | null;
  source?: string | null;
  score?: number | null;
  rank_reasons?: string[] | null;
  last_walk_id?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
}

export interface PlatformOverview {
  platform: Platform;
  /** the platform's app (the overview embeds it) */
  target: QaTarget | null;
  screens: { seen: number; declared: number; blocked: number };
  features: number;
  scenarios: Partial<Record<ScenarioStatus, number>>;
  open_findings: number;
  /** findings waiting for a diagnosis: what Triage's Untriaged group lists */
  untriaged: number;
  last_sessions: Partial<Record<SessionKind, QaSession | null>>;
}

export interface TaskQa {
  sessions: QaSession[];
  findings: QaFinding[];
  scenarios: QaScenario[];
  verdicts: QaVerdict[];
  /** Raw request rows, this task as source or as QA task (normalizeRequest reads them). */
  requests: unknown[];
  /** The task is a Quality run, and what its Run result card shows (`runTask/model` reads it). */
  is_run_task?: boolean;
  run_result?: unknown;
  /** The last decision under "finish by itself" (`runTask/finishing` reads it). */
  final_decision?: unknown;
  /** The task's own "Send to Quality when finished" (`requests/on-done` reads it). */
  on_done?: unknown;
}

/* ---- tolerant readers ----------------------------------------------------- */
type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

/** A list field that may arrive bare, under a named key, or as `{items}`. */
export function listOf<T>(v: unknown, key?: string): T[] {
  if (Array.isArray(v)) return v as T[];
  if (isObj(v)) {
    if (key && Array.isArray(v[key])) return v[key] as T[];
    if (Array.isArray(v.items)) return v.items as T[];
  }
  return [];
}

/** The charter's missions: `{missions:[…]}` or a bare list (anything else → none). */
export function missionsOf(charter: unknown): Mission[] {
  const raw = listOf<Obj>(charter, "missions");
  return raw.filter(isObj).map((m, i) => ({
    id: String(m.id ?? i + 1),
    title: String(m.title ?? m.name ?? "Untitled mission"),
    why: typeof m.why === "string" ? m.why : null,
    status: (typeof m.status === "string" ? m.status : "active") as MissionStatus,
    note: typeof m.note === "string" ? m.note : null,
    finding_ids: Array.isArray(m.finding_ids) ? (m.finding_ids as string[]) : [],
  }));
}

function normPlatform(p: unknown, platform: Platform, sharedFeatures: unknown): PlatformOverview {
  const o = isObj(p) ? p : {};
  const scr = isObj(o.screens) ? o.screens : {};
  const sc = isObj(o.scenarios) ? o.scenarios : {};
  const last = isObj(o.last_sessions) ? o.last_sessions : isObj(o.last_session) ? o.last_session : {};
  // features belong to the project (the backend counts them once, at the top level)
  const feats = o.features ?? sharedFeatures;
  return {
    platform,
    target: isObj(o.target) ? (o.target as unknown as QaTarget) : null,
    screens: { seen: num(scr.seen), declared: num(scr.declared), blocked: num(scr.blocked) },
    features: Array.isArray(feats) ? feats.length : num(feats),
    scenarios: { draft: num(sc.draft), validated: num(sc.validated), paused: num(sc.paused), retired: num(sc.retired) },
    open_findings: num(o.open_findings),
    untriaged: num(o.untriaged),
    last_sessions: last as PlatformOverview["last_sessions"],
  };
}

/** `{platforms:{ios:{…}}}`, `{ios:{…}}` or `{platforms:[{platform:"ios",…}]}` → one entry per platform. */
export function normalizeOverview(raw: unknown): Record<Platform, PlatformOverview> {
  const r = isObj(raw) ? raw : {};
  const src = r.platforms ?? r;
  const out = {} as Record<Platform, PlatformOverview>;
  for (const p of PLATFORMS) {
    let entry: unknown = null;
    if (Array.isArray(src)) entry = src.find((x) => isObj(x) && x.platform === p);
    else if (isObj(src)) entry = src[p];
    out[p] = normPlatform(entry, p, r.features);
  }
  return out;
}

export function normalizeMap(raw: unknown): QaMap {
  const r = isObj(raw) ? raw : {};
  return {
    features: listOf<QaFeature>(r.features),
    nodes: listOf<QaNode>(r.nodes),
    edges: listOf<QaEdge>(r.edges),
    last_build: isObj(r.last_build) ? (r.last_build as unknown as QaMapBuild) : null,
  };
}

export function normalizeSessionDetail(raw: unknown): SessionDetail {
  const r = isObj(raw) ? raw : {};
  const session = (isObj(r.session) ? r.session : r) as unknown as QaSession;
  return {
    session,
    walks: listOf<QaWalk>(r.walks),
    findings: listOf<QaFinding>(r.findings),
    steps_count: typeof r.steps_count === "number" ? r.steps_count : session.steps_count ?? null,
    drafts: listOf<QaScenario>(r.drafts ?? r.scenarios),
    verdicts: listOf<QaVerdict>(r.verdicts),
    measured: listOf<QaMeasured>(r.measured),
    queue: isObj(r.queue) ? (r.queue as SessionDetail["queue"]) : null,
  };
}

export function normalizeScenario(raw: unknown): QaScenario {
  const r = isObj(raw) ? raw : {};
  const s = (isObj(r.scenario) ? { ...r.scenario, ...r, scenario: undefined } : r) as unknown as QaScenario;
  return {
    ...s,
    criteria: Array.isArray(s.criteria) ? s.criteria.map(String) : [],
    tags: Array.isArray(s.tags) ? s.tags : [],
    evidence: listOf<QaEvidence>(s.evidence),
    suggestions: listOf<QaSuggestion>(s.suggestions),
    verdicts: listOf<QaVerdict>(s.verdicts),
    walk: isObj(s.walk) ? s.walk : null,
  };
}

export function normalizeTaskQa(raw: unknown): TaskQa {
  const r = isObj(raw) ? raw : {};
  return {
    sessions: listOf<QaSession>(r.sessions),
    findings: listOf<QaFinding>(r.findings),
    scenarios: listOf<QaScenario>(r.scenarios ?? r.drafts),
    verdicts: listOf<QaVerdict>(r.verdicts),
    requests: listOf<unknown>(r.requests),
    is_run_task: r.is_run_task === true,
    run_result: r.run_result,
    final_decision: r.final_decision,
    on_done: r.on_done,
  };
}

export function taskQaIsEmpty(q: TaskQa | null): boolean {
  return !q || (!q.sessions.length && !q.findings.length && !q.scenarios.length && !q.verdicts.length && !q.requests.length);
}

/** A screen's route: web screens are keyed by route; any source's detail may also carry one. */
export function screenRoute(n: Pick<QaNode, "platform" | "key" | "detail">): string | null {
  const d = isObj(n.detail) ? n.detail : {};
  const parts = [d, ...Object.values(d)].filter(isObj);
  // the code's declared route first, then the routes a browser actually saw (detail.live.routes)
  for (const part of parts) if (typeof part.route === "string" && part.route.trim()) return part.route.trim();
  for (const part of parts) {
    const r = Array.isArray(part.routes) ? part.routes.find((x) => typeof x === "string" && x.trim()) : null;
    if (r) return String(r).trim();
  }
  return n.platform === "web" ? n.key : null;
}

/* ---- web page events ------------------------------------------------------- */
export type WebEventKind = "console" | "pageerror" | "requestfailed" | "response" | "crash" | "other";
export interface WebEvent { kind: WebEventKind; status: number | null; text: string }

const EVENT_LINE = /^\s*[-•*]?\s*(console\.(?:error|warn(?:ing)?)|pageerror|page error|requestfailed|request failed|response\s+(\d{3})|crash(?:ed)?)\s*:\s*(.*)$/i;
const EVENT_HEAD = /^\s*(?:page\s+)?events(?:\s+since\s+last\s+screen)?\s*(?:\(\d+\))?\s*:\s*$/i;

function eventOf(kindRaw: string, status: string | undefined, text: string): WebEvent {
  const k = kindRaw.toLowerCase();
  const kind: WebEventKind = k.startsWith("console") ? "console" : k.startsWith("page") ? "pageerror"
    : k.startsWith("request") ? "requestfailed" : k.startsWith("response") ? "response" : k.startsWith("crash") ? "crash" : "other";
  return { kind, status: status ? Number(status) : null, text: text.trim() };
}

/**
 * Split a finding's detail into its prose and the web page events it carries
 * (the original "events since last screen (N):" block: `console.error: …`, `pageerror: …`,
 * `requestfailed: GET /x net::ERR_…`, `response 500: GET /api/y`). A finding's own
 * `events` (strings or `{kind, text, status}`) are read too.
 */
export function splitWebEvents(detail: string | null | undefined, extra?: unknown): { text: string; events: WebEvent[] } {
  const events: WebEvent[] = [];
  const keep: string[] = [];
  for (const line of (typeof detail === "string" ? detail : "").split("\n")) {
    if (EVENT_HEAD.test(line)) continue;
    const m = EVENT_LINE.exec(line);
    if (m) events.push(eventOf(m[1], m[2], m[3]));
    else keep.push(line);
  }
  for (const e of Array.isArray(extra) ? extra : []) {
    if (typeof e === "string") {
      const m = EVENT_LINE.exec(e);
      events.push(m ? eventOf(m[1], m[2], m[3]) : { kind: "other", status: null, text: e });
    } else if (isObj(e)) {
      const raw = String(e.kind ?? e.type ?? "other");
      const st = typeof e.status === "number" ? String(e.status) : /\d{3}/.exec(raw)?.[0];
      events.push(eventOf(raw, st, String(e.text ?? e.message ?? e.url ?? "")));
    }
  }
  return { text: keep.join("\n").trim(), events };
}

/* ---- routes ---------------------------------------------------------------- */
const enc = encodeURIComponent;
const C = (cid: string) => `/api/containers/${enc(cid)}/qa`;

function qs(params: Record<string, string | number | null | undefined>): string {
  const p = Object.entries(params).filter(([, v]) => v != null && v !== "");
  return p.length ? "?" + p.map(([k, v]) => `${k}=${enc(String(v))}`).join("&") : "";
}

/** The frame image (members read). */
export const frameUrl = (fid: string) => `/api/qa/frames/${enc(fid)}`;

export const getOverview = async (cid: string, signal?: AbortSignal) =>
  normalizeOverview(await getJSON<unknown>(`${C(cid)}/overview`, signal));

export const listTargets = async (cid: string, signal?: AbortSignal) =>
  listOf<QaTarget>(await getJSON<unknown>(`${C(cid)}/targets`, signal), "targets");

export const saveTarget = (cid: string, platform: Platform, actor: string | null, body: Omit<QaTarget, "platform" | "updated_at" | "updated_by_agent_id">) =>
  sendJSON<QaTarget>("PUT", `${C(cid)}/targets/${enc(platform)}`, { ...body, actor_agent_id: actor });

export const getMap = async (cid: string, platform: Platform, signal?: AbortSignal) =>
  normalizeMap(await getJSON<unknown>(`${C(cid)}/map${qs({ platform })}`, signal));

export const listSessions = async (cid: string, f: { kind?: string; status?: string; task_id?: string; platform?: Platform; limit?: number } = {}, signal?: AbortSignal) =>
  listOf<QaSession>(await getJSON<unknown>(`${C(cid)}/sessions${qs({ limit: 100, ...f })}`, signal), "sessions");

export const getSession = async (sid: string, signal?: AbortSignal) =>
  normalizeSessionDetail(await getJSON<unknown>(`/api/qa/sessions/${enc(sid)}`, signal));

export const listFlows = async (cid: string, platform: Platform, signal?: AbortSignal) =>
  listOf<QaFlow>(await getJSON<unknown>(`${C(cid)}/flows${qs({ platform })}`, signal), "flows");

/** A walk's flow name: joined on the walk, else looked up in the platform's flows. */
export function walkName(w: QaWalk, flows?: QaFlow[] | null): string | null {
  return w.flow?.name || w.flow_name || (w.flow_id ? flows?.find((f) => f.id === w.flow_id)?.name ?? null : null);
}

export const listScenarios = async (cid: string, platform: Platform, signal?: AbortSignal) =>
  listOf<QaScenario>(await getJSON<unknown>(`${C(cid)}/scenarios${qs({ platform })}`, signal), "scenarios").map(normalizeScenario);

export const getScenario = async (id: string, signal?: AbortSignal) =>
  normalizeScenario(await getJSON<unknown>(`/api/qa/scenarios/${enc(id)}`, signal));

export const setScenarioStatus = (cid: string, actor: string | null, ids: string[], status: ScenarioStatus, reason?: string | null) =>
  sendJSON<unknown>("POST", `${C(cid)}/scenarios/status`, { ids, status, reason: reason || null, actor_agent_id: actor });

export const listSuggestions = async (cid: string, signal?: AbortSignal) =>
  listOf<QaSuggestion>(await getJSON<unknown>(`${C(cid)}/suggestions`, signal), "suggestions");

export const decideSuggestion = (id: string, actor: string | null, decision: "accept" | "dismiss") =>
  sendJSON<unknown>("POST", `/api/qa/suggestions/${enc(id)}`, { decision, actor_agent_id: actor });

export const fileFinding = (fid: string, actor: string | null, body: { title?: string; assignee_agent_id?: string | null } = {}) =>
  sendJSON<QaFinding & { filed_task_id?: string | null }>("PATCH", `/api/qa/findings/${enc(fid)}`, { action: "file", ...body, actor_agent_id: actor });

export const dismissFinding = (fid: string, actor: string | null) =>
  sendJSON<QaFinding>("PATCH", `/api/qa/findings/${enc(fid)}`, { action: "dismiss", actor_agent_id: actor });

export const reopenFinding = (fid: string, actor: string | null) =>
  sendJSON<QaFinding>("PATCH", `/api/qa/findings/${enc(fid)}`, { action: "reopen", actor_agent_id: actor });

export const getTaskQa = async (tid: string, signal?: AbortSignal) =>
  normalizeTaskQa(await getJSON<unknown>(`/api/tasks/${enc(tid)}/qa`, signal));
