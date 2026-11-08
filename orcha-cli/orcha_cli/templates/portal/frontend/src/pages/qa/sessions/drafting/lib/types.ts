/** What the drafting screens read from the board route (`qa_drafting.py`). */
import type { EvidenceStatus, QaScenario } from "../../../qaApi";
import type { TargetKind } from "../../../map/kit";

export type { EvidenceStatus, TargetKind };

export type DraftSources = "code" | "exploration" | "both";

/** One line on the board: a message the agents wrote, or a screen an explorer's steps recorded. */
export interface BoardEvent {
  id: string;
  seq: number;
  kind: string;
  title: string;
  body: unknown;
  scenario_id: string | null;
  /** The frame it shows, by id. */
  screenshot_path: string | null;
  status?: string | null;
  reply_to?: string | null;
  session_id?: string | null;
  author?: string | null;
  created_at: string;
}

export interface CorrectionBody {
  changes?: { index: number; before: string | null; after: string | null }[];
  screen_name?: string | null;
  reason?: string | null;
  from_screen?: boolean;
  /** The version the revision replaced. */
  before?: Partial<Pick<QaScenario, "name" | "category" | "persona" | "description" | "criteria" | "tags">> | null;
}

/** The drafter and the explorers of its task as one session; null without an explorer. */
export interface DraftingSession {
  id: string;
  status: "live" | "waiting" | "finished" | "stopped" | "code_only";
  explorer_status: "queued" | "running" | "finished" | "failed" | null;
  explorer_joined_at: string | null;
  deadline_at: string | null;
  pairing: string | null;
  note: string | null;
  updated_at?: string | null;
}

export interface ScenarioEvidence {
  id: string;
  scenario_id: string;
  criterion_index: number;
  status: EvidenceStatus;
  /** The frame that shows it, by id. */
  screenshot_path: string | null;
  screen_name: string | null;
  route: string | null;
  step: number | null;
  run_id: string | null;
  matched: string | null;
  code_ref: string | null;
  source: string | null;
  session_id?: string | null;
}

/** What the drafter is doing, from what it said. */
export interface RequestActivity {
  phase?: string | null;
  note?: string | null;
  recent?: string[] | null;
  reads?: number | null;
  searches?: number | null;
  read_files?: string[] | null;
  started_at?: string | null;
  updated_at?: string | null;
}

/** A draft as the review reads it. */
export interface Scenario extends QaScenario {
  /** Null: the review shows no platform chip (a draft belongs to its session's platform). */
  target_kind: TargetKind | null;
  feedback: { text: string }[];
  /** The session that drafted it. */
  generation_request_id: string | null;
}
