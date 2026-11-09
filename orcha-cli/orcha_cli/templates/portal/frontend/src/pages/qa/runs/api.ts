/** The run page's calls: `qa_runs_routes.py`. */
import { getJSON, sendJSON } from "../../../api/client";
import { normalizeScenario, type QaFinding, type QaScenario, type QaSession, type QaVerdict, type QaWalk, type SessionDetail } from "../qaApi";
import type { QaStep } from "../sessions/api";
import { toApiRequestRow, type ApiRequestRow } from "./lib/api-requests";
import type { CriterionFeedback, CriterionFeedbackStatus, RunLog } from "./types";

const enc = encodeURIComponent;

/** `GET /api/qa/sessions/{id}/run`: everything the page shows of one session. */
export interface RunDoc extends SessionDetail {
  session: QaSession;
  findings: QaFinding[];
  walks: QaWalk[];
  verdicts: QaVerdict[];
  steps: QaStep[];
  logs: RunLog[];
  scenarios: QaScenario[];
  feedback: CriterionFeedback[];
}

export const getRun = async (sid: string, signal?: AbortSignal): Promise<RunDoc> => {
  const doc = await getJSON<RunDoc>(`/api/qa/sessions/${enc(sid)}/run`, signal);
  return { ...doc, scenarios: (doc.scenarios ?? []).map(normalizeScenario) };
};

export const listRequests = async (sid: string, signal?: AbortSignal): Promise<ApiRequestRow[]> => {
  const r = await getJSON<{ requests?: Record<string, unknown>[] }>(`/api/qa/sessions/${enc(sid)}/requests`, signal);
  return (r?.requests ?? []).map((x) => toApiRequestRow({ ...x, ms: x.duration_ms, failed: x.failure != null }));
};

export const putFeedback = (sid: string, body: { scenario_id: string; criterion_index: number; status: CriterionFeedbackStatus; note: string | null }, actor: string | null) =>
  sendJSON<unknown>("PUT", `/api/qa/sessions/${enc(sid)}/feedback`, { ...body, actor_agent_id: actor });

export const patchScenario = (scid: string, body: { name: string }, actor: string | null) =>
  sendJSON<unknown>("PATCH", `/api/qa/scenarios/${enc(scid)}`, { ...body, actor_agent_id: actor });

/** One tile of `GET C/qa/live`. */
export interface LiveTile {
  session: QaSession;
  frame_id: string | null;
  last_step: QaStep | null;
  steps_count: number;
  findings: string[];
  verdicts: string[];
}

export const getLive = async (cid: string, platform: string | null, signal?: AbortSignal): Promise<LiveTile[]> => {
  const q = platform ? `?platform=${enc(platform)}` : "";
  const r = await getJSON<{ tiles?: LiveTile[] }>(`/api/containers/${enc(cid)}/qa/live${q}`, signal);
  return r?.tiles ?? [];
};
