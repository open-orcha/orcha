/**
 * A session's flows and walks as the workflow screens read them. Orcha's queue is the platform's,
 * so an ended session shows the flows it could have walked (the ones queued before it ended), each
 * standing where this session left it; a running one shows the queue as it stands.
 */
import { type QaFlow, type QaWalk, type SessionDetail } from "../../qaApi";
import { severityOf } from "../adapt";
import { parseFlowRow, type DraftingFlow, type FlowStatus, type FlowWalk, type WalkFinding, type WalkScenario, type WalkStep, type WalksPayload } from "./workflows";

const CRITICALITY: Readonly<Record<string, DraftingFlow["criticality"]>> = { high: "high", medium: "normal", low: "low" };

function flowStatusIn(f: QaFlow, walks: readonly QaWalk[], live: boolean): FlowStatus {
  if (live) return (f.status ?? "queued") as FlowStatus;
  const walk = walks.filter((w) => w.flow_id === f.id).at(-1);
  if (!walk) return "queued";
  return walk.status === "abandoned" ? "queued" : (walk.status as FlowStatus);
}

function flowOf(f: QaFlow, i: number, d: SessionDetail, live: boolean): DraftingFlow {
  const mine = d.walks.filter((w) => w.flow_id === f.id).at(-1);
  return parseFlowRow({
    id: f.id,
    session_id: d.session.id,
    project_id: "",
    flow_key: f.key,
    name: f.name,
    persona: f.persona,
    criticality: CRITICALITY[f.criticality ?? "medium"] ?? "normal",
    steps: f.steps,
    data: f.data ?? {},
    code_ref: typeof f.data?.code_ref === "string" ? f.data.code_ref : null,
    source: "plan",
    rank: i + 1,
    score: f.score ?? 0,
    rank_reasons: f.rank_reasons ?? [],
    status: flowStatusIn(f, d.walks, live),
    target_kind: f.platform,
    claimed_by: null,
    walk_id: mine?.id ?? (live ? f.last_walk_id ?? null : null),
    created_at: f.created_at ?? "",
    updated_at: f.updated_at ?? "",
  });
}

function walkOf(w: QaWalk, flow: QaFlow | undefined, d: SessionDetail, seqOf: ReadonlyMap<string, number>): FlowWalk {
  const steps: WalkStep[] = (w.steps ?? []).map((s) => ({
    index: s.index + 1,
    text: s.text ?? "",
    reached: !!s.reached,
    result: s.result ?? null,
    checked: s.checked ?? [],
    finding_id: s.finding_id ? (seqOf.get(String(s.finding_id)) ?? null) : null,
    screen_id: s.screen_key ?? null,
    frame: s.frame_id ?? null,
    seq: s.seq ?? null,
    at: s.at ?? null,
  }));
  return {
    id: w.id,
    session_id: d.session.id,
    flow_id: w.flow_id ?? "",
    project_id: "",
    flow_key: flow?.key ?? w.flow?.key ?? w.flow_name ?? "",
    explorer_request_id: null,
    run_id: d.session.id,
    target_kind: d.session.platform,
    persona: flow?.persona ?? null,
    status: w.status,
    reason: w.reason,
    blocked_kind: w.blocked_kind === "paywall" || w.blocked_kind === "external" ? "blocked" : w.blocked_kind,
    steps: steps.sort((a, b) => a.index - b.index),
    data_used: flow?.data ?? {},
    start_seq: null,
    end_seq: null,
    scenario_id: w.scenario_id,
    finding_ids: (w.finding_ids ?? []).map(String),
    started_at: w.started_at ?? "",
    finished_at: w.ended_at,
    updated_at: w.ended_at ?? w.started_at ?? "",
  };
}

/** The flows this session can speak for: all of them while it runs; once it ended, those queued before. */
function flowsFor(d: SessionDetail, flows: readonly QaFlow[], live: boolean): QaFlow[] {
  if (live) return [...flows];
  const walked = new Set(d.walks.map((w) => w.flow_id));
  const ended = d.session.ended_at ?? "";
  return flows.filter((f) => walked.has(f.id) || (f.created_at != null && ended !== "" && Date.parse(f.created_at) <= Date.parse(ended)));
}

export function walksPayloadOf(d: SessionDetail, flows: readonly QaFlow[] | null): WalksPayload {
  const live = d.session.status === "running";
  const all = flows ?? [];
  const seqOf = new Map(d.findings.map((f, i) => [f.id, i + 1]));
  const byId = new Map(all.map((f) => [f.id, f]));
  const walkFlows = d.walks.flatMap((w) => (w.flow_id && !byId.has(w.flow_id) ? [{ id: w.flow_id, platform: d.session.platform, key: w.flow?.key ?? w.flow_name ?? w.flow_id, name: w.flow?.name ?? w.flow_name ?? "Flow", persona: null, criticality: null, status: null } satisfies QaFlow] : []));
  const rows = flowsFor(d, [...all, ...walkFlows], live);
  const scenarios: Record<string, WalkScenario> = {};
  for (const s of d.drafts) scenarios[s.id] = { id: s.id, name: s.name, status: s.status, created_at: s.created_at, updated_at: s.updated_at };
  const findings: Record<string, WalkFinding> = {};
  for (const f of d.findings) {
    const seq = seqOf.get(f.id) ?? 0;
    findings[f.id] = { id: f.id, run_id: d.session.id, seq, title: f.title, severity: severityOf(f.severity), evidence_seqs: [seq] };
  }
  return {
    pairing: rows.length || d.walks.length ? "workflow" : "classic",
    session_id: d.session.id,
    explorer_joined: true,
    flows: rows.map((f, i) => flowOf(f, i, d, live)),
    walks: d.walks.map((w) => walkOf(w, w.flow_id ? byId.get(w.flow_id) : undefined, d, seqOf)),
    scenarios,
    findings,
  };
}
