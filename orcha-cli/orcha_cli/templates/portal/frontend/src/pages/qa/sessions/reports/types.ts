import type { Finding, Severity, TargetKind } from "../explorations";

export type { Finding, Severity };
/** What the measured-report reader reads: a session's audit as a report of one app version. */

/**
 * `qa.audit_kind` — every check the audit can run. Each is mechanical: it takes a
 * screenshot and an element tree and returns a number or a boolean.
 */
export type AuditKind =
  | "dark_mode_text_vanishes"
  | "dark_mode_no_change"
  | "dark_mode_element_missing"
  | "dark_mode_image_vanishes"
  | "low_contrast"
  | "clipped_text"
  | "off_screen"
  | "overlapping_controls"
  | "tap_target_too_small"
  | "under_system_inset"
  | "inconsistent_screen"
  | "empty_label"
  | "label_equals_identifier"
  | "image_without_label"
  | "missing_identifier";

export const AUDIT_KINDS: readonly AuditKind[] = [
  "dark_mode_text_vanishes",
  "dark_mode_no_change",
  "dark_mode_element_missing",
  "dark_mode_image_vanishes",
  "low_contrast",
  "clipped_text",
  "off_screen",
  "overlapping_controls",
  "tap_target_too_small",
  "under_system_inset",
  "inconsistent_screen",
  "empty_label",
  "label_equals_identifier",
  "image_without_label",
  "missing_identifier",
];

/** `qa.exploration_note_kind` — what sort of judgement a note carries. */
export type ExplorationNoteKind =
  | "impression"
  | "usability"
  | "idea"
  | "improvement"
  | "needs_info";

export const EXPLORATION_NOTE_KINDS: readonly ExplorationNoteKind[] = [
  "impression",
  "usability",
  "idea",
  "improvement",
  "needs_info",
];

/** One session's audit, by the numbers. */
export interface ExplorationReport {
  id: string;
  project_id: string;
  target_id: string | null;
  run_id: string | null;
  build_id: string | null;
  /** Copied from the build, never joined: a build can be rebuilt, the report must not change. */
  app_version: string | null;
  git_commit: string | null;
  git_branch: string | null;
  /** Append-only: re-exploring the same version makes revision 2, never an overwrite. */
  revision: number;
  target_kind: TargetKind | null;
  /** Which appearances were walked, e.g. `["dark", "light"]`. */
  appearances: string[];
  screens_seen: number;
  summary_md: string | null;
  created_at: string;
}

/**
 * One measured claim.
 *
 * `rect` is `[x1, y1, x2, y2]` in **image pixels** of `frame_path`, so rendering a
 * crop means scaling against the screenshot's natural size, not the CSS box.
 *
 * `confident === false` means the measurement is sound but the *interpretation* is
 * not — text over a photo or a gradient makes a single foreground/background sample
 * unreliable. Those are "needs a look", never failures: presenting an honest
 * estimate as a verdict is how this feature would start lying.
 */
export interface ExplorationFinding {
  id: string;
  report_id: string;
  kind: AuditKind;
  severity: Severity;
  summary: string;
  /** What was measured, in `unit` (e.g. a 2.9:1 contrast ratio, a 31 pt tap target). */
  measured: number | null;
  /** What it had to clear to pass, in the same `unit`. */
  threshold: number | null;
  unit: string | null;
  confident: boolean;
  screen_hash: string | null;
  step_seq: number | null;
  frame_path: string | null;
  /** `[x1, y1, x2, y2]` in image pixels. */
  rect: number[] | null;
  element_index: number | null;
  element_label: string | null;
  element_identifier: string | null;
  appearance: string | null;
  detail: Record<string, unknown>;
  created_at: string;
}

/** One judged claim. Never mixed into findings. */
export interface ExplorationNote {
  id: string;
  report_id: string;
  kind: ExplorationNoteKind;
  title: string;
  body: string | null;
  frame_path: string | null;
  screen_hash: string | null;
  created_at: string;
}

/** A report plus its findings and notes — everything the detail view renders. */
export interface ExplorationReportDetail {
  report: ExplorationReport;
  /** Measured by the audit (contrast, labels, tap targets…). */
  findings: ExplorationFinding[];
  /** The agent's impressions and ideas; no severity. */
  notes: ExplorationNote[];
  /** What the agent judged to be a defect while walking (`findings` of the report's run), with
   * the agent's severity. Kept apart from the measured findings: an opinion with a grade is
   * still an opinion. */
  judged: Finding[];
}

/** A report in a list, with the counts that make it worth opening. */
export interface ExplorationReportSummary {
  report: ExplorationReport;
  /** Findings per severity, including `info`. */
  bySeverity: Record<Severity, number>;
  /** Findings per audit kind — the numbers that trend across versions. */
  byKind: Record<string, number>;
  /** Total findings, confident and not. */
  findings: number;
  /** Findings where the measurement is sound but the interpretation is not. */
  needsLook: number;
  notes: number;
  /** The agent's own findings (judged, graded by the agent), never mixed into `findings`. */
  judged: number;
  judgedBySeverity: Record<Severity, number>;
}
