/**
 * Workflow-driven exploration (#426, `docs/workflow-exploration.md`): the shapes the page reads
 * (the App model, the ranked flow queue, the walks) and the pure helpers that turn them into
 * what the page says ("Walking: Log a bottle feed, step 3 of 5", the reason chips, the counts).
 * Rows come from migration 138 through the two read routes; every reader here is defensive, so
 * a row written by an older or newer worker never breaks the page.
 */

export type Pairing = "classic" | "workflow";
export type Criticality = "critical" | "high" | "normal" | "low";
export type FlowStatus = "queued" | "walking" | "passed" | "failed" | "unreachable" | "skipped";
export type WalkStatus = "walking" | "passed" | "failed" | "unreachable" | "abandoned";
export type BlockedKind = "needs_sign_in" | "needs_data" | "needs_permission" | "blocked" | "crash" | "other";
export type ModelSource = "study" | "briefing" | "plan" | "walks" | "person";

export interface FlowStep {
  text: string;
  screen?: string | null;
  route?: string | null;
  /** What to verify right after the step (a test's check along the way,). */
  check?: string | null;
  /** The step that proves the flow's point: a walk passes only once it is checked. */
  outcome?: boolean;
  /** An outcome step that only restates what the flow's name promises: its steps never said how. */
  from_name?: boolean;
}

/** One ranked flow of a session's queue (`drafting_flows`). */
export interface DraftingFlow {
  id: string;
  session_id: string;
  project_id: string;
  flow_key: string;
  name: string;
  persona: string | null;
  criticality: Criticality;
  steps: FlowStep[];
  data: Record<string, unknown>;
  code_ref: string | null;
  source: "plan" | "model" | "both";
  rank: number;
  score: number;
  rank_reasons: string[];
  status: FlowStatus;
  target_kind: string | null;
  claimed_by: string | null;
  walk_id: string | null;
  created_at: string;
  updated_at: string;
}

/** One step the explorer reported on a walk (contract §4). */
export interface WalkStep {
  index: number;
  text: string;
  reached: boolean;
  result: string | null;
  checked: string[];
  finding_id: number | null;
  screen_id: string | null;
  frame: string | null;
  seq: number | null;
  at: string | null;
}

/** One walk of one flow (`flow_walks`). */
export interface FlowWalk {
  id: string;
  session_id: string;
  flow_id: string;
  project_id: string;
  flow_key: string;
  explorer_request_id: string | null;
  run_id: string | null;
  target_kind: string | null;
  persona: string | null;
  status: WalkStatus;
  reason: string | null;
  blocked_kind: BlockedKind | null;
  steps: WalkStep[];
  data_used: Record<string, unknown>;
  start_seq: number | null;
  end_seq: number | null;
  scenario_id: string | null;
  /**
   * What the walk filed. A number is one of the explorer's `capture_evidence` numbers (or
   * a finding walk to scenario filed itself, from `FINDING_SEQ_BASE`), never a finding's own
   * number; a string is a `findings.id`, resolved when the exploration finished. Read both
   * through `walkFindingsOf`.
   */
  finding_ids: (number | string)[];
  started_at: string;
  finished_at: string | null;
  updated_at: string;
}

/** A draft or catching scenario a walk produced, as the page names it. */
export interface WalkScenario {
  id: string;
  name: string;
  status: string;
  /** When it was made and last changed: a scenario older than the walk was matched, not drafted. */
  created_at?: string | null;
  updated_at?: string | null;
}

/** A finding of a walk's run, with the captures it cites (`findings.evidence_seqs`). */
export interface WalkFinding {
  id: string;
  run_id: string;
  seq: number;
  title: string;
  severity: string;
  evidence_seqs: number[];
}

/** `GET /api/explorations/[id]/walks`. `scenarios` and `findings` name what the walks link to. */
export interface WalksPayload {
  pairing: Pairing | null;
  session_id: string | null;
  /**
   * Whether an explorer joined the drafting session (`explorer_joined_at`). An explorer that
   * never joined never saw the queue. Null without a session; absent from older payloads.
   */
  explorer_joined?: boolean | null;
  flows: DraftingFlow[];
  walks: FlowWalk[];
  scenarios: Record<string, WalkScenario>;
  /** The findings of the walks' runs, by `findings.id`; `walkFindingsOf` picks a walk's own. */
  findings: Record<string, WalkFinding>;
}

export interface Persona {
  key: string;
  name: string;
  goal?: string | null;
}

export interface CoreJob {
  key: string;
  name: string;
  why?: string | null;
}

export interface ModelEvidence {
  routes: string[];
  screens: string[];
  tests: { file: string; title: string }[];
  docs: string[];
  code: string[];
  scenarios: string[];
  runs: { run_id: string; walk_id: string; status: string; at: string }[];
}

export interface ModelWorkflow {
  key: string;
  name: string;
  persona: string | null;
  job: string | null;
  criticality: Criticality;
  steps: FlowStep[];
  data: Record<string, unknown>;
  evidence: ModelEvidence;
  risk: { never_walked: boolean; failed_recently: boolean; changed_at: string | null; covered_by: number };
  status: "unwalked" | "passed" | "failed" | "unreachable";
  last_walk: { walk_id: string; status: string; reason: string | null; at: string } | null;
  sources: string[];
}

export interface AppModel {
  purpose: string;
  personas: Persona[];
  core_jobs: CoreJob[];
  workflows: ModelWorkflow[];
  built_from: { map_build_id: string | null; tests: number; docs: number; scenarios: number };
}

export interface AppModelVersion {
  version: number;
  source: ModelSource;
  summary: string | null;
  created_at: string;
}

/** `GET /api/projects/[id]/app-model`. */
export interface AppModelPayload {
  model: AppModel | null;
  version: number | null;
  source: ModelSource | null;
  summary: string | null;
  created_at: string | null;
  versions: AppModelVersion[];
}

// ---------- reading rows ----------

function json(v: unknown): unknown {
  if (typeof v !== "string") return v;
  try {
    return JSON.parse(v);
  } catch {
    return null;
  }
}
const obj = (v: unknown): Record<string, unknown> => {
  const p = json(v);
  return p && typeof p === "object" && !Array.isArray(p) ? (p as Record<string, unknown>) : {};
};
const arr = (v: unknown): unknown[] => {
  const p = json(v);
  return Array.isArray(p) ? p : [];
};
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() && Number.isFinite(Number(v)) ? Number(v) : null);
const strs = (v: unknown): string[] => arr(v).filter((x): x is string => typeof x === "string" && x.trim() !== "");

const CRITICALITY: readonly Criticality[] = ["critical", "high", "normal", "low"];
const crit = (v: unknown): Criticality => (CRITICALITY.includes(v as Criticality) ? (v as Criticality) : "normal");

function flowSteps(v: unknown): FlowStep[] {
  const out: FlowStep[] = [];
  for (const s of arr(v)) {
    if (typeof s === "string") {
      if (s.trim()) out.push({ text: s });
    } else if (s && typeof s === "object") {
      const o = s as Record<string, unknown>;
      const text = String(o.text ?? "");
      if (!text.trim()) continue;
      const step: FlowStep = { text, screen: str(o.screen), route: str(o.route) };
      if (str(o.check)) step.check = str(o.check);
      if (o.outcome === true) step.outcome = true;
      if (o.from_name === true) step.from_name = true;
      out.push(step);
    }
  }
  return out;
}

/** A step that only opens a screen ("Open Settings", "Go to Profile", "Navigate to Baby management"). */
const NAV_ONLY = /^(?:open|go to|navigate to|visit)\b/i;

/**
 * What a flow's steps say about its outcome, for the queue: `named` when its steps only
 * opened screens and the walk must do and check what its name promises (the last step says so);
 * `screens` for a flow queued before that whose steps only open screens and check nothing (a
 * walk of them proved only navigation). Null when the steps say what to do and check.
 */
export function flowOutcomeNote(flow: Pick<DraftingFlow, "steps">): { kind: "named" | "screens"; label: string; hint: string } | null {
  const steps = flow.steps;
  if (steps.some((s) => s.from_name)) {
    return {
      kind: "named",
      label: "Outcome from its name",
      hint: "Its steps only open screens, so the walk has to do what the flow's name promises and check it before it can pass.",
    };
  }
  if (steps.length && steps.every((s) => NAV_ONLY.test(s.text.trim()) && !s.check && !s.outcome)) {
    return {
      kind: "screens",
      label: "Screens only",
      hint: "Its steps only open screens and check nothing the flow's name promises.",
    };
  }
  return null;
}

export function parseFlowRow(row: Record<string, unknown>): DraftingFlow {
  return {
    ...(row as unknown as DraftingFlow),
    criticality: crit(row.criticality),
    steps: flowSteps(row.steps),
    data: obj(row.data),
    rank: num(row.rank) ?? 0,
    score: num(row.score) ?? 0,
    rank_reasons: strs(row.rank_reasons),
    status: (str(row.status) ?? "queued") as FlowStatus,
  };
}

export function parseWalkStep(raw: unknown, i: number): WalkStep {
  const s = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  return {
    index: num(s.index) ?? i + 1,
    text: str(s.text) ?? "",
    reached: s.reached === true || s.reached === 1 || s.reached === "true",
    result: str(s.result),
    checked: strs(s.checked),
    finding_id: num(s.finding_id),
    screen_id: str(s.screen_id),
    frame: str(s.frame),
    seq: num(s.seq),
    at: str(s.at),
  };
}

/** A walk's finding ref: a capture number, or a findings id once resolved (`FlowWalk.finding_ids`). */
function findingRef(v: unknown): number | string | null {
  if (typeof v === "string" && v.trim() && !/^\d+$/.test(v.trim())) return v.trim();
  return num(v);
}

export function parseWalkRow(row: Record<string, unknown>): FlowWalk {
  return {
    ...(row as unknown as FlowWalk),
    status: (str(row.status) ?? "walking") as WalkStatus,
    steps: arr(row.steps).map(parseWalkStep).sort((a, b) => a.index - b.index),
    data_used: obj(row.data_used),
    finding_ids: arr(row.finding_ids).map(findingRef).filter((n): n is number | string => n != null),
    start_seq: num(row.start_seq),
    end_seq: num(row.end_seq),
  };
}

function evidenceOf(v: unknown): ModelEvidence {
  const e = obj(v);
  return {
    routes: strs(e.routes),
    screens: strs(e.screens),
    tests: arr(e.tests)
      .map((t) => obj(t))
      .filter((t) => str(t.file) || str(t.title))
      .map((t) => ({ file: String(t.file ?? ""), title: String(t.title ?? "") })),
    docs: strs(e.docs),
    code: strs(e.code),
    scenarios: strs(e.scenarios),
    runs: arr(e.runs)
      .map((r) => obj(r))
      .map((r) => ({ run_id: String(r.run_id ?? ""), walk_id: String(r.walk_id ?? ""), status: String(r.status ?? ""), at: String(r.at ?? "") })),
  };
}

const WF_STATUS = ["unwalked", "passed", "failed", "unreachable"] as const;

/** The App model JSON (contract §3), with every missing part filled with its empty value. */
export function normalizeAppModel(raw: unknown): AppModel | null {
  const m = obj(raw);
  if (Object.keys(m).length === 0) return null;
  const built = obj(m.built_from);
  return {
    purpose: str(m.purpose) ?? "",
    personas: arr(m.personas)
      .map((p) => obj(p))
      .filter((p) => str(p.key) || str(p.name))
      .map((p) => ({ key: String(p.key ?? p.name), name: String(p.name ?? p.key), goal: str(p.goal) })),
    core_jobs: arr(m.core_jobs)
      .map((j) => obj(j))
      .filter((j) => str(j.key) || str(j.name))
      .map((j) => ({ key: String(j.key ?? j.name), name: String(j.name ?? j.key), why: str(j.why) })),
    workflows: arr(m.workflows)
      .map((w) => obj(w))
      .filter((w) => str(w.key) || str(w.name))
      .map((w) => {
        const risk = obj(w.risk);
        const last = obj(w.last_walk);
        return {
          key: String(w.key ?? w.name),
          name: String(w.name ?? w.key),
          persona: str(w.persona),
          job: str(w.job),
          criticality: crit(w.criticality),
          steps: flowSteps(w.steps),
          data: obj(w.data),
          evidence: evidenceOf(w.evidence),
          risk: {
            never_walked: risk.never_walked !== false,
            failed_recently: risk.failed_recently === true,
            changed_at: str(risk.changed_at),
            covered_by: num(risk.covered_by) ?? 0,
          },
          status: (WF_STATUS as readonly string[]).includes(String(w.status)) ? (w.status as ModelWorkflow["status"]) : "unwalked",
          last_walk: str(last.walk_id) || str(last.status) ? { walk_id: String(last.walk_id ?? ""), status: String(last.status ?? ""), reason: str(last.reason), at: String(last.at ?? "") } : null,
          sources: strs(w.sources),
        };
      }),
    built_from: {
      map_build_id: str(built.map_build_id),
      tests: num(built.tests) ?? 0,
      docs: num(built.docs) ?? 0,
      scenarios: num(built.scenarios) ?? 0,
    },
  };
}

/** A finding row of a walk's run as the walks route reads it (`evidence_seqs` parsed). */
export function parseWalkFinding(row: Record<string, unknown>): WalkFinding {
  return {
    id: String(row.id ?? ""),
    run_id: String(row.run_id ?? ""),
    seq: num(row.seq) ?? 0,
    title: String(row.title ?? ""),
    severity: String(row.severity ?? "info"),
    evidence_seqs: arr(row.evidence_seqs).map(num).filter((n): n is number => n != null),
  };
}

/** Walk to scenario numbers a finding it files itself from here (`to_scenario.FINDING_SEQ_BASE`). */
export const FINDING_SEQ_BASE = 900;

/**
 * The findings a walk filed, and the captures still waiting for one. The explorer names
 * a capture (`capture_evidence` number) in `walk_step`: it is the finding of the walk's run that
 * cites it (`evidence_seqs`), never the finding numbered the same (evidence 2 was finding 1 on
 * Snugly). A number from `FINDING_SEQ_BASE` up is a finding walk to scenario filed; a string is
 * a findings id the worker resolved when the exploration finished. Mirrors
 * `workflows.walks.resolve_finding_refs`. `pending` are captures no finding cites yet: written
 * up when the run ends, so the page says so only while it runs.
 */
export function walkFindingsOf(
  walk: Pick<FlowWalk, "run_id" | "finding_ids" | "steps">,
  findings: Record<string, WalkFinding>,
): { found: WalkFinding[]; pending: number[] } {
  const refs = [...walk.finding_ids, ...walk.steps.map((s) => s.finding_id).filter((x): x is number => x != null)];
  const ofRun = Object.values(findings).filter((f) => f.run_id === walk.run_id);
  const found = new Map<string, WalkFinding>();
  const pending: number[] = [];
  for (const ref of refs) {
    if (typeof ref === "string") {
      const f = findings[ref];
      if (f) found.set(f.id, f);
      continue;
    }
    let citing = ofRun.filter((f) => f.evidence_seqs.includes(ref));
    if (citing.length === 0 && ref >= FINDING_SEQ_BASE) citing = ofRun.filter((f) => f.seq === ref);
    if (citing.length === 0) {
      if (!pending.includes(ref)) pending.push(ref);
      continue;
    }
    for (const f of citing) found.set(f.id, f);
  }
  return { found: [...found.values()], pending };
}

/**
 * Why a failed walk failed, for a walk that reached every step: its meta line otherwise read as a
 * clean pass ("4 of 4 steps reached · 10 checks held", QA 2026-10-28). `problems` counts what it
 * found ("1 problem found"), `step` is the step the problem was captured on. Both null when a
 * step was missed (the card says "Failed at step N") or the walk did not fail.
 */
export function failedWalkWhy(
  walk: Pick<FlowWalk, "status" | "steps" | "reason">,
  found: number,
  pending: number,
): { problems: string | null; step: WalkStep | null } {
  if (walk.status !== "failed" || walk.steps.some((s) => !s.reached)) return { problems: null, step: null };
  const n = found || pending || (walk.reason ? 1 : 0);
  return {
    problems: n ? `${n} problem${n === 1 ? "" : "s"} found` : null,
    step: walk.steps.find((s) => s.finding_id != null) ?? null,
  };
}

/**
 * A scenario a walk links to that was there before the walk began: the walk matched it (the
 * person's own scenario, maybe accepted long ago) rather than drafting it. Unknown dates read as
 * new.
 */
export function scenarioPredates(scenario: Pick<WalkScenario, "created_at"> | undefined, walk: Pick<FlowWalk, "started_at">): boolean {
  const made = Date.parse(scenario?.created_at ?? "");
  const began = Date.parse(walk.started_at ?? "");
  return Number.isFinite(made) && Number.isFinite(began) && made < began;
}

const dayOf = (iso: string) => new Date(iso).toDateString();

/**
 * When the person's scenario became what it is, as "Accepted Oct 28". Scenarios keep no accept
 * date: when the scenario was made and last changed on the same day, that is the day it was
 * accepted; otherwise the page says when it was added ("Accepted · added Oct 21").
 */
export function scenarioSince(scenario: WalkScenario, stateWord: string, fmt: (iso: string) => string): string {
  const made = scenario.created_at;
  if (!made || !Number.isFinite(Date.parse(made))) return stateWord;
  const changed = scenario.updated_at && Number.isFinite(Date.parse(scenario.updated_at)) ? scenario.updated_at : null;
  if (scenario.status === "validated" && changed && dayOf(changed) === dayOf(made)) return `${stateWord} ${fmt(changed)}`;
  return `${stateWord} · added ${fmt(made)}`;
}

// ---------- what the page says ----------

/** A persona key ("new-parent") as the model names it, else the key in words ("New parent"). */
export function personaName(key: string | null | undefined, personas: readonly Persona[] = []): string | null {
  if (!key) return null;
  const hit = personas.find((p) => p.key === key || p.name === key);
  if (hit) return hit.name;
  const words = key.replace(/[-_]+/g, " ").trim();
  return words ? words[0].toUpperCase() + words.slice(1) : null;
}

export type ReasonTone = "new" | "fail" | "critical" | "changed" | "plain";

/**
 * A rank reason as a chip. The queue writes reasons in words ("never walked", "critical",
 * "changed 3 days ago"); the known ones get a short label and a colour, anything else is shown
 * as written. Plain criticality ("normal", "low") is not a reason to go first, so it is left out.
 */
export function reasonChip(reason: string): { label: string; tone: ReasonTone } | null {
  const r = reason.trim();
  const l = r.toLowerCase();
  if (!r) return null;
  if (l.includes("never")) return { label: "Never walked", tone: "new" };
  if (l.includes("fail")) return { label: "Failed recently", tone: "fail" };
  if (l.includes("critical")) return { label: "Critical", tone: "critical" };
  if (l.startsWith("high")) return { label: "High value", tone: "plain" };
  if (l.includes("changed")) return { label: r[0].toUpperCase() + r.slice(1), tone: "changed" };
  if (l.includes("covered") || l.includes("no scenario")) return { label: "Covered by nothing", tone: "plain" };
  if (l.includes("both")) return { label: "Found in code and model", tone: "plain" };
  if (l === "normal" || l === "low" || l.startsWith("normal ") || l.startsWith("low ")) return null;
  return { label: r[0].toUpperCase() + r.slice(1), tone: "plain" };
}

/** Queue-time reasons that stop being true once the flow is walked, said as history instead:
 * a passed walk next to "Never walked" read as a contradiction (QA 2026-10-28). */
const WALKED_REASON: Record<string, { label: string; tone: ReasonTone }> = {
  "Never walked": { label: "First walk", tone: "new" },
  "Failed recently": { label: "Failed before", tone: "plain" },
  "Covered by nothing": { label: "Had no scenario", tone: "plain" },
};

/** Whether a flow has a walk outcome (its queue-time reasons are history). */
export function flowWalked(status: FlowStatus): boolean {
  return status === "passed" || status === "failed" || status === "unreachable";
}

export function reasonChips(reasons: readonly string[], opts: { walked?: boolean } = {}): { label: string; tone: ReasonTone }[] {
  const seen = new Set<string>();
  const out: { label: string; tone: ReasonTone }[] = [];
  for (const r of reasons) {
    const raw = reasonChip(r);
    const c = raw && opts.walked ? (WALKED_REASON[raw.label] ?? raw) : raw;
    if (!c || seen.has(c.label)) continue;
    seen.add(c.label);
    out.push(c);
  }
  return out;
}

/** A flow's pill: its status, or what an ended exploration makes of it: `cut_off`, a flow
 * left "walking" when the exploration ended; `requeued`, a flow queued again after its walk stopped. */
export type FlowPill = FlowStatus | WalkStatus | "cut_off" | "requeued";

export const FLOW_STATUS_LABEL: Record<FlowPill, string> = {
  queued: "Queued",
  walking: "Walking",
  passed: "Passed",
  failed: "Failed",
  unreachable: "Unreachable",
  skipped: "Skipped",
  abandoned: "Stopped",
  cut_off: "Cut off",
  requeued: "Queued again",
};

/**
 * What a flow's pill says. Only a running exploration has a flow "Walking": once it ended, a
 * flow still marked walking was cut off (its walk never got an outcome), and a flow its explorer
 * began and left is "Queued again", never just "Queued" as if nobody had touched it.
 */
export function flowPill(flow: Pick<DraftingFlow, "status">, walk: Pick<FlowWalk, "status"> | null | undefined, live: boolean): FlowPill {
  if (flow.status === "walking" && !live) return "cut_off";
  if (flow.status === "queued" && walk?.status === "abandoned") return "requeued";
  return flow.status;
}

/**
 * The words for a walk that stopped without an outcome, from why it stopped (`flow_walks.reason`,
 * `walks.CUT_OFF` and `lifecycle.stop_reason` in the worker, or the wording workers used before
 *). The time running out is said as such ("Cut off by time"), and the flow's fate with it.
 */
export function stoppedWalk(reason: string | null | undefined): { word: string; why: string } {
  const r = (reason ?? "").trim();
  const again = " The flow is queued again for the next exploration.";
  if (!r) return { word: "Cut off", why: "The exploration ended before this walk finished." };
  if (/cut off by time|ran out of time|out of time|explorer ended \(completed\)/i.test(r)) {
    return { word: "Cut off by time", why: `The exploration's time ran out before this walk finished.${again}` };
  }
  if (/was stopped|\(cancelled\)/i.test(r)) return { word: "Stopped", why: `The exploration was stopped before this walk finished.${again}` };
  if (/exploration failed|explorer ended \((failed|error)\)/i.test(r)) {
    return { word: "Stopped", why: `The exploration failed before this walk finished.${again}` };
  }
  const sentence = r.charAt(0).toUpperCase() + r.slice(1);
  return { word: "Stopped", why: /[.!?]$/.test(sentence) ? sentence : `${sentence}.` };
}

export const BLOCKED_LABEL: Record<BlockedKind, string> = {
  needs_sign_in: "Needs sign-in",
  needs_data: "Needs data",
  needs_permission: "Needs a permission",
  blocked: "Blocked",
  crash: "The app crashed",
  other: "Could not reach it",
};

/** The flows in queue order: by rank (rank 0 = not ranked yet, last), then name. */
export function queueOrder(flows: readonly DraftingFlow[]): DraftingFlow[] {
  return [...flows].sort((a, b) => (a.rank || 1e9) - (b.rank || 1e9) || a.name.localeCompare(b.name));
}

/** The walk in progress (the newest `walking` one), or null. */
export function currentWalk(walks: readonly FlowWalk[]): FlowWalk | null {
  const live = walks.filter((w) => w.status === "walking");
  if (live.length === 0) return null;
  return [...live].sort((a, b) => b.started_at.localeCompare(a.started_at))[0];
}

/**
 * Finished walks, newest first. Once the exploration ended (`live` false) a walk still marked
 * walking is one too: it was cut off, and lands as stopped rather than "Walking" forever.
 */
export function finishedWalks(walks: readonly FlowWalk[], live = true): FlowWalk[] {
  return walks
    .filter((w) => w.status !== "walking" || !live)
    .map((w) => (w.status === "walking" ? { ...w, status: "abandoned" as const } : w))
    .sort((a, b) => (b.finished_at ?? b.updated_at ?? b.started_at).localeCompare(a.finished_at ?? a.updated_at ?? a.started_at));
}

/**
 * The steps of a walk as the rail shows them: every step of the flow, each with what the
 * explorer reported for it (or nothing yet). Steps the explorer reported beyond the flow's own
 * list (it found an extra screen on the way) are kept, in order.
 */
export interface RailStep {
  index: number;
  text: string;
  report: WalkStep | null;
  state: "done" | "missed" | "now" | "next";
}

export function railSteps(flow: Pick<DraftingFlow, "steps"> | null, walk: Pick<FlowWalk, "steps" | "status">): RailStep[] {
  const planned = flow?.steps ?? [];
  const byIndex = new Map(walk.steps.map((s) => [s.index, s]));
  const total = Math.max(planned.length, ...walk.steps.map((s) => s.index), 0);
  const out: RailStep[] = [];
  let nowGiven = false;
  for (let i = 1; i <= total; i++) {
    const report = byIndex.get(i) ?? null;
    const text = report?.text || planned[i - 1]?.text || `Step ${i}`;
    let state: RailStep["state"];
    if (report) state = report.reached ? "done" : "missed";
    else if (walk.status === "walking" && !nowGiven) {
      state = "now";
      nowGiven = true;
    } else state = "next";
    out.push({ index: i, text, report, state });
  }
  return out;
}

/** The step being walked (1-based) and the flow's length: "step 3 of 5". */
export function walkPosition(flow: Pick<DraftingFlow, "steps"> | null, walk: Pick<FlowWalk, "steps" | "status">): { at: number; total: number } {
  const rail = railSteps(flow, walk);
  const total = rail.length;
  const now = rail.find((s) => s.state === "now");
  const reported = walk.steps.length ? Math.max(...walk.steps.map((s) => s.index)) : 0;
  return { at: now ? now.index : Math.max(1, Math.min(total, reported)), total };
}

/** "Walking: Log a bottle feed, step 3 of 5" (or "Walking: Log a bottle feed" with no steps known). */
export function walkHeadline(flowName: string, pos: { at: number; total: number }): string {
  return pos.total > 0 ? `Walking: ${flowName}, step ${pos.at} of ${pos.total}` : `Walking: ${flowName}`;
}

export interface QueueCounts {
  total: number;
  walked: number;
  passed: number;
  failed: number;
  unreachable: number;
  queued: number;
  walking: number;
}

export function queueCounts(flows: readonly DraftingFlow[]): QueueCounts {
  const c: QueueCounts = { total: flows.length, walked: 0, passed: 0, failed: 0, unreachable: 0, queued: 0, walking: 0 };
  for (const f of flows) {
    if (f.status === "passed") c.passed++;
    else if (f.status === "failed") c.failed++;
    else if (f.status === "unreachable") c.unreachable++;
    else if (f.status === "walking") c.walking++;
    else if (f.status === "queued") c.queued++;
  }
  c.walked = c.passed + c.failed + c.unreachable;
  return c;
}

/** "3 of 7 walked: 1 passed, 1 failed, 1 unreachable" (only the outcomes that happened). */
export function countsLine(c: QueueCounts): string {
  if (c.total === 0) return "No flows yet";
  const parts = [
    c.passed ? `${c.passed} passed` : null,
    c.failed ? `${c.failed} failed` : null,
    c.unreachable ? `${c.unreachable} unreachable` : null,
  ].filter(Boolean);
  return `${c.walked} of ${c.total} walked${parts.length ? `: ${parts.join(", ")}` : ""}`;
}

/**
 * An ended workflow pairing whose explorer walked none of its queue: Slate's deep dive
 * on 2026-10-28 queued 3 flows and the explorer, which never joined the session, explored on its
 * own for 8 minutes. `waiting` is the flows left queued, `stopped` the walks it began and left,
 * `joined` whether an explorer joined the session at all. Null while it runs, when nothing was
 * queued, or once any walk reached an outcome (passed, failed or unreachable).
 */
export interface UnwalkedQueue {
  waiting: number;
  stopped: number;
  joined: boolean | null;
}

export function unwalkedQueue(
  flows: readonly Pick<DraftingFlow, "status">[],
  walks: readonly Pick<FlowWalk, "status">[],
  live: boolean,
  joined: boolean | null | undefined,
): UnwalkedQueue | null {
  if (live || flows.length === 0) return null;
  if (walks.some((w) => w.status === "passed" || w.status === "failed" || w.status === "unreachable")) return null;
  const waiting = flows.filter((f) => f.status === "queued" || f.status === "walking").length;
  if (waiting === 0) return null;
  return { waiting, stopped: walks.filter((w) => w.status === "abandoned").length, joined: joined ?? null };
}

/** What the page says about a queue nobody walked: plainly, with no claim that the pairing ran. */
export function unwalkedCopy(u: UnwalkedQueue): { title: string; body: string; after: string } {
  const flows = u.waiting === 1 ? "1 flow was" : `${u.waiting} flows were`;
  const them = u.waiting === 1 ? "it" : "them";
  let body: string;
  if (u.joined === false) {
    body = `${flows} queued for it, but the explorer never joined the drafting session, so it never saw ${them} and explored on its own.`;
  } else if (u.stopped > 0) {
    const began = u.stopped === 1 ? "began one walk" : `began ${u.stopped} walks`;
    body = `${flows} queued for it. The explorer ${began} and stopped before the end, and explored on its own otherwise.`;
  } else {
    body = `${flows} queued for it, and the explorer explored on its own instead of walking ${them}.`;
  }
  return {
    title: "The explorer did not walk the flow queue",
    body,
    after: "This report's findings come from that exploring, and no walk became a draft scenario.",
  };
}

/** The test data a walk types, as short "name: value" pairs (never JSON). */
export function dataPairs(data: Record<string, unknown>, max = 4): string[] {
  return Object.entries(data)
    .filter(([, v]) => v != null && v !== "" && (typeof v === "string" || typeof v === "number" || typeof v === "boolean"))
    .slice(0, max)
    .map(([k, v]) => `${k.replace(/[_-]+/g, " ")}: ${String(v)}`);
}

export type EvidenceKind = "screens" | "routes" | "tests" | "docs" | "code" | "scenarios" | "runs";

/** How much backs a workflow, by kind, leaving out the empty kinds. */
export function evidenceTally(e: ModelEvidence): { kind: EvidenceKind; count: number }[] {
  const kinds: EvidenceKind[] = ["screens", "routes", "tests", "docs", "code", "scenarios", "runs"];
  return kinds.map((kind) => ({ kind, count: e[kind].length })).filter((x) => x.count > 0);
}

const CRIT_ORDER: Record<Criticality, number> = { critical: 0, high: 1, normal: 2, low: 3 };
const STATUS_ORDER: Record<ModelWorkflow["status"], number> = { failed: 0, unwalked: 1, unreachable: 2, passed: 3 };

/** The model's workflows in the order that matters: by criticality, then what needs a walk most. */
export function rankModelWorkflows(workflows: readonly ModelWorkflow[]): ModelWorkflow[] {
  return [...workflows].sort((a, b) => CRIT_ORDER[a.criticality] - CRIT_ORDER[b.criticality] || STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || a.name.localeCompare(b.name));
}

export const SOURCE_LABEL: Record<ModelSource, string> = {
  study: "Built by the study",
  briefing: "From the explorer's briefing",
  plan: "From the drafter's flows",
  walks: "From walks",
  person: "Edited by a person",
};
