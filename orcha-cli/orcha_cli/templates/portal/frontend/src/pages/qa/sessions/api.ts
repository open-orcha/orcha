/**
 * The session calls qaApi does not have: a session's steps, stopping a session, and one read of
 * what the history's cards need (each recent session's findings, walks and screenshots).
 */
import type { Conditions } from "../conditions/conditions";
import { getJSON, sendJSON } from "../../../api/client";
import { listOf, type Platform, type QaFinding, type QaMeasured, type QaScenario, type QaSession, type QaWalk, type Severity } from "../qaApi";
import type { AppModelPayload } from "./workflows/workflows";

const enc = encodeURIComponent;

export interface QaStep {
  id?: string;
  seq: number;
  kind: string;
  args: Record<string, unknown> | null;
  result: string | null;
  screen_key: string | null;
  screen_hash: string | null;
  frame_id: string | null;
  at: string | null;
}

export const listSteps = async (sid: string, signal?: AbortSignal): Promise<QaStep[]> =>
  listOf<QaStep>(await getJSON<unknown>(`/api/qa/sessions/${enc(sid)}/steps?limit=2000`, signal), "steps");

/** Ends a running session from the page ("Stop"): its open walks go back to the queue. */
export const stopSession = (sid: string, actor: string | null) =>
  sendJSON<QaSession>("PATCH", `/api/qa/sessions/${enc(sid)}`, { status: "cancelled", actor_agent_id: actor });

/** What a history card shows of one session. */
export interface SessionDigest {
  findings: QaFinding[];
  walks: QaWalk[];
  drafts: Pick<QaScenario, "id" | "name" | "status" | "category">[];
  /** Its screenshot steps, oldest first. */
  shots: { seq: number; frame_id: string; screen_hash: string | null }[];
  steps_count: number;
  measured?: QaMeasured[];
}

export const listDigests = async (cid: string, platform: Platform, signal?: AbortSignal): Promise<Record<string, SessionDigest>> => {
  const r = await getJSON<{ digests?: Record<string, SessionDigest> }>(`/api/containers/${enc(cid)}/qa/session-digests?platform=${enc(platform)}`, signal);
  return r?.digests ?? {};
};

/** What a person keeps on a session: its name, notes, archived, pinned. */
export const keepSession = (sid: string, actor: string | null, patch: { name?: string; notes?: string; archived?: boolean; pinned?: boolean }) =>
  sendJSON<QaSession>("PATCH", `/api/qa/sessions/${enc(sid)}/keep`, { ...patch, actor_agent_id: actor });

export type QueuedSession = QaSession & { task_id: string; session_id: string };

/** The same work again, queued, in the same series. */
export const runSessionAgain = (sid: string, actor: string | null) => sendJSON<QueuedSession>("POST", `/api/qa/sessions/${enc(sid)}/again`, { actor_agent_id: actor });

/** A copy of the work, queued, as a new series. */
export const duplicateSession = (sid: string, actor: string | null) => sendJSON<QueuedSession>("POST", `/api/qa/sessions/${enc(sid)}/duplicate`, { actor_agent_id: actor });

/** A person's call on a finding's severity; what the agent said stays beside it. */
export const setFindingSeverity = (fid: string, actor: string | null, severity: Severity, reason: string | null) =>
  sendJSON<QaFinding>("PATCH", `/api/qa/findings/${enc(fid)}/severity`, { severity, reason, actor_agent_id: actor });

export interface FindingScenarioDraft {
  name: string;
  description?: string | null;
  criteria: string[];
  category?: string | null;
  persona?: string | null;
}

/** The finding's one draft scenario: a second call returns the first. */
export const draftScenarioFromFinding = (fid: string, actor: string | null, draft: FindingScenarioDraft) =>
  sendJSON<{ scenario: QaScenario; created: boolean }>("POST", `/api/qa/findings/${enc(fid)}/scenario`, { ...draft, actor_agent_id: actor });

/** The App model, the newest version unless one is picked. */
export const getAppModel = (cid: string, platform: Platform, version: number | null, signal?: AbortSignal) =>
  getJSON<AppModelPayload>(`/api/containers/${enc(cid)}/qa/app-model?platform=${enc(platform)}${version != null ? `&version=${version}` : ""}`, signal);

/** A scenario from a next step no finding stands behind. */
export const proposeNextStep = async (cid: string, body: FindingScenarioDraft & { platform: Platform; actor_agent_id: string | null }) => {
  const r = await sendJSON<{ scenario: QaScenario }>("POST", `/api/containers/${enc(cid)}/qa/scenarios`, { ...body, source: "generated" });
  return r.scenario;
};

/** The session a Run check task will become, so it shows as queued from the first moment. */
export const queueSession = (cid: string, body: { kind: string; platform: Platform; task_id: string; goal: string | null; budget_minutes: number | null; agent_id: string | null; draft_sources?: "code" | "exploration" | "both" | null; conditions?: Conditions | null; actor_agent_id: string | null }) =>
  sendJSON<QaSession>("POST", `/api/containers/${enc(cid)}/qa/sessions/queue`, body);
