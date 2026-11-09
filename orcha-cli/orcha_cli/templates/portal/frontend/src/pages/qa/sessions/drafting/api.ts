/** The drafting calls: the board route, what can be drafted from, a person's feedback. */
import { getJSON, sendJSON } from "../../../../api/client";
import { listOf, type QaScenario } from "../../qaApi";
import type { ExplorationSummary, PassFrame } from "./lib/draft-sources";
import type { StageFrame } from "./lib/drafting-stage";
import type { DraftSources, DraftingSession, RequestActivity } from "./lib/types";

const enc = encodeURIComponent;

/** A line of the board as the route sends it. */
export interface RawEvent {
  id: string;
  session_id: string | null;
  seq: number;
  board_seq?: number;
  kind: string;
  title: string;
  body: unknown;
  scenario_id: string | null;
  frame_id: string | null;
  reply_to: string | null;
  status: string | null;
  created_at: string;
}

/** One explorer of the session's task. */
export interface RawExplorer {
  id: string;
  status: string;
  session_status: string;
  device: string | null;
  target_kind: "ios" | "android" | "web";
  locator: string;
  goal: string | null;
  minutes: number | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  error: string | null;
  screens: number;
  actions: number;
  frames: PassFrame[];
  blockers: number;
  blocker_title: string | null;
  blocker_frame: string | null;
}

export interface RawEvidence {
  id: string;
  scenario_id: string;
  criterion_index: number;
  status: "verified" | "unconfirmed" | "code_only";
  frame_id: string | null;
  code_ref: string | null;
  note: string | null;
  source?: string | null;
  screen_name: string | null;
  route: string | null;
  step: number | null;
  run_id: string | null;
}

export interface DraftingBoardData {
  session: DraftingSession | null;
  explorers: RawExplorer[];
  events: RawEvent[];
  evidence: RawEvidence[];
  corrections: RawEvent[];
  feedback: Record<string, { text: string; at: string }[]>;
  explorer_drafts: QaScenario[];
  activity: RequestActivity;
  sources: DraftSources | null;
  frames: StageFrame[];
  explorations: ExplorationSummary | null;
}

/** Tolerant like every QA reader: a missing part reads as empty. */
export function normalizeBoard(raw: Partial<DraftingBoardData> | null | undefined): DraftingBoardData {
  const r = raw ?? {};
  return {
    session: r.session ?? null,
    explorers: listOf<RawExplorer>(r.explorers),
    events: listOf<RawEvent>(r.events),
    evidence: listOf<RawEvidence>(r.evidence),
    corrections: listOf<RawEvent>(r.corrections),
    feedback: r.feedback ?? {},
    explorer_drafts: listOf<QaScenario>(r.explorer_drafts),
    activity: r.activity ?? {},
    sources: r.sources ?? null,
    frames: listOf<StageFrame>(r.frames),
    explorations: r.explorations ?? null,
  };
}

export const getDraftingBoard = async (sid: string, signal?: AbortSignal) =>
  normalizeBoard(await getJSON<Partial<DraftingBoardData>>(`/api/qa/sessions/${enc(sid)}/drafting`, signal));

export const getDraftingSources = (cid: string, signal?: AbortSignal) => getJSON<ExplorationSummary & { frames?: StageFrame[] }>(`/api/containers/${enc(cid)}/qa/drafting/sources`, signal);

export const postFeedback = (scenarioId: string, text: string, actor: string | null) =>
  sendJSON<unknown>("POST", `/api/qa/scenarios/${enc(scenarioId)}/feedback`, { text, actor_agent_id: actor });
