/**
 * Triage (docs/orcha-qa-plan.md "Triage"; portal_backend/qa_triage.py): a finding is a claim, not a
 * fix order. A diagnosis says what it really is, how often it fails and why, and it drives a route.
 * Readers stay tolerant: a finding that was never triaged has no `triage`.
 */
import type { Conditions } from "../conditions/conditions";
import { getJSON, sendJSON } from "../../../api/client";
import type { QaFinding, Severity } from "../qaApi";
import { listOf } from "../qaApi";

export type Classification = "product_bug" | "test_issue" | "environment" | "flaky" | "agent_error" | "duplicate" | "not_a_bug";
export type TriageAction = "confirmed" | "backlog" | "suggested" | "quarantined" | "already_quarantined" | "no_scenario" | "blocked" | "dismissed" | "merged" | "remembered" | "kept";
export type TriageDecision = "fix" | "clear" | "needs_person";

export interface Diagnosis {
  classification: Classification;
  reproduced: boolean | null;
  attempts: number | null;
  reproductions: number | null;
  /** "fails 3 of 3" */
  rate: string | null;
  root_cause: string | null;
  note: string | null;
  evidence_frame_ids: string[];
  needs_person: boolean;
  action: TriageAction | null;
  scenario_id: string | null;
  at: string | null;
  /** Findings merged into this one as duplicates. */
  merged_from: string[];
}

/** One finding's line in a triage request's result. */
export interface DiagnosisRow extends Diagnosis {
  id: string;
  title: string;
  severity: Severity | null;
  severity_original: Severity | null;
}

export interface TriageInbox { untriaged: QaFinding[]; needs_person: QaFinding[]; decided: QaFinding[] }

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** A stored diagnosis, or null when triage has not reached this finding. */
export function normalizeDiagnosis(raw: unknown): Diagnosis | null {
  if (!isObj(raw) || typeof raw.classification !== "string") return null;
  const attempts = num(raw.attempts);
  const reproductions = num(raw.reproductions);
  return {
    classification: raw.classification as Classification,
    reproduced: typeof raw.reproduced === "boolean" ? raw.reproduced : null,
    attempts, reproductions,
    rate: str(raw.rate) ?? (attempts ? `fails ${reproductions ?? 0} of ${attempts}` : null),
    root_cause: str(raw.root_cause),
    note: str(raw.note),
    evidence_frame_ids: Array.isArray(raw.evidence_frame_ids) ? raw.evidence_frame_ids.filter((x): x is string => typeof x === "string") : [],
    needs_person: raw.needs_person === true,
    action: str(raw.action) as TriageAction | null,
    scenario_id: str(raw.scenario_id),
    at: str(raw.at),
    merged_from: Array.isArray(raw.merged_from) ? raw.merged_from.filter((x): x is string => typeof x === "string") : [],
  };
}

export function normalizeDiagnoses(raw: unknown): DiagnosisRow[] {
  return listOf<unknown>(raw).flatMap((d) => {
    const n = normalizeDiagnosis(d);
    if (!n || !isObj(d)) return [];
    return [{ ...n, id: String(d.id ?? ""), title: str(d.title) ?? "Finding", severity: str(d.severity) as Severity | null, severity_original: str(d.severity_original) as Severity | null }];
  });
}

export function normalizeInbox(raw: unknown): TriageInbox {
  const r = isObj(raw) ? raw : {};
  return { untriaged: listOf<QaFinding>(r.untriaged), needs_person: listOf<QaFinding>(r.needs_person), decided: listOf<QaFinding>(r.decided) };
}

const enc = encodeURIComponent;

export const getTriageInbox = async (cid: string, signal?: AbortSignal) =>
  normalizeInbox(await getJSON<unknown>(`/api/containers/${enc(cid)}/qa/triage`, signal));

/** Queues a triage run on one finding: it holds a device and spends model time. */
export const startTriage = (fid: string, actor: string | null, conditions?: Conditions | null) =>
  sendJSON<unknown>("POST", `/api/qa/findings/${enc(fid)}/triage-request`, { actor_agent_id: actor, ...(conditions ? { conditions } : {}) });

/** What it takes to reproduce a finding: a person's word, kept on it; null clears it. */
export const setFindingConditions = (fid: string, actor: string | null, conditions: Conditions | null) =>
  sendJSON<QaFinding>("PUT", `/api/qa/findings/${enc(fid)}/conditions`, { actor_agent_id: actor, conditions });

/** A person's call, with the reason: QA agents read it and never report this behaviour again. */
export const markNotABug = (fid: string, actor: string | null, reason: string) =>
  sendJSON<QaFinding>("POST", `/api/qa/findings/${enc(fid)}/not-a-bug`, { reason, actor_agent_id: actor });
