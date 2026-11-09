/**
 * What a finding card says about its severity (migration 125, `orcha.severity`): Orcha's review
 * rates every blocker, major and minor finding again after the run, its rating is the final one,
 * and the explorer's stays beside it. A person can change either.
 *
 * Pure, so the run page's card, the exploration report and the issue page say it the same way.
 */
import type { Finding, Severity } from "../explorations";

type SeverityBy = NonNullable<Finding["severity_by"]>;

/** The levels a person can pick, most severe first (the rubric's four; info is evidence). */
export const LEVELS = ["blocker", "major", "minor", "cosmetic"] as const satisfies readonly Severity[];
export type Level = (typeof LEVELS)[number];

/** One line per level, from the rubric (`orcha.severity.rubric`), for the change dialog. */
export const LEVEL_HINTS: Record<Level, string> = {
  blocker: "A crash, lost data, nobody gets past it on a main path, or a security or privacy breach.",
  major: "A feature does not do its job, or someone is stuck and nothing will free them.",
  minor: "It works, with friction people get past on their own. Nothing lost or stuck.",
  cosmetic: "Visual or copy only. Nothing behaves differently.",
};

/** The rubric's questions as the card names them (`orcha.severity.rubric.DIMENSIONS`). */
export const DIMENSION_LABELS: Record<string, string> = {
  task: "finish the task",
  stuck: "stuck, no way out",
  data: "data lost or wrong",
  purpose: "core purpose broken",
  reach: "how many it reaches",
  workaround: "workaround",
  security: "security or privacy",
  looks: "visual or copy only",
};

export type SeverityFields = Pick<Finding, "severity"> & Partial<Pick<Finding, "severity_reported" | "severity_by" | "severity_reason" | "severity_review">>;

export type SeverityState =
  /** The review is running now (the run's sync). */
  | "reviewing"
  /** Orcha's review set it. */
  | "orcha"
  /** A person set it. */
  | "person"
  /** The review did not run for it (off, no model, the cap, out of time, failed): the explorer's. */
  | "skipped"
  /** The explorer's, from before the review existed or not reviewed (cosmetic, info). */
  | "explorer";

export interface SeverityLine {
  state: SeverityState;
  severity: Severity;
  /** Who the line names: "Orcha", "You", or null (no line). */
  who: "Embodent" | "You" | null;
  reason: string | null;
  /** The explorer's rating, only when it differs from the final one. */
  explorerSaid: Severity | null;
  dimensions: string[];
  /** Why the review did not rate it, for `skipped`. */
  note: string | null;
}

function clean(text: string | null | undefined): string | null {
  const s = (text ?? "").replace(/\s*[—–]\s*/g, ", ").trim().replace(/\.$/, "");
  return s || null;
}

/** Lower-case the first letter unless it starts a name or an acronym ("The agent" -> "the agent"). */
function sentenceTail(text: string): string {
  return /^[A-Z][a-z]/.test(text) ? text[0].toLowerCase() + text.slice(1) : text;
}

export function severityLine(f: SeverityFields): SeverityLine {
  const review = f.severity_review ?? null;
  const by: SeverityBy = f.severity_by ?? "explorer";
  const explorerSaid = f.severity_reported && f.severity_reported !== f.severity ? f.severity_reported : null;
  const dimensions = (review?.dimensions ?? []).filter((d) => d in DIMENSION_LABELS);
  const base = { severity: f.severity, explorerSaid, dimensions };
  if (by === "person") {
    return { ...base, state: "person", who: "You", reason: clean(f.severity_reason), note: null, dimensions: [] };
  }
  if (review?.status === "reviewing" || review?.status === "queued") {
    return { ...base, state: "reviewing", who: null, reason: null, note: null };
  }
  if (by === "orcha") {
    return { ...base, state: "orcha", who: "Embodent", reason: clean(f.severity_reason ?? review?.reason), note: null };
  }
  if (review && (review.status === "skipped" || review.status === "failed")) {
    const why = review.status === "failed" ? "the review could not finish" : clean((review as { reason?: string | null }).reason) ?? "the review did not run";
    return { ...base, state: "skipped", who: null, reason: null, note: `The explorer's rating. Embodent did not rate it: ${why}.` };
  }
  return { ...base, state: "explorer", who: null, reason: null, note: null };
}

/** The reason as the card shows it after "Orcha: ", or null. */
export function displayReason(line: SeverityLine): string | null {
  return line.reason ? sentenceTail(line.reason) : null;
}

/** The line as one sentence: "major · Orcha: the agent stays blocked (the explorer said minor)". */
export function severityText(line: SeverityLine): string | null {
  if (line.state === "reviewing") return "Embodent is rating its severity…";
  if (line.state === "skipped") return line.note;
  if (!line.who) return null;
  const said = line.explorerSaid ? ` (the explorer said ${line.explorerSaid})` : "";
  const reason = displayReason(line);
  return `${line.severity} · ${line.who}${reason ? `: ${reason}` : ""}${said}`;
}

/** Whether any finding is still being rated (the card listens for the result). */
export function anyReviewing(findings: readonly SeverityFields[]): boolean {
  return findings.some((f) => severityLine(f).state === "reviewing");
}

/** A severity call a person made (`severity_overrides`, migration 125): a calibration example. */
export interface SeverityExample {
  id: string;
  subject: "finding" | "issue";
  title: string;
  from_severity: string;
  to_severity: string;
  reported: string | null;
  reason: string | null;
  run_id: string | null;
  finding_seq: number | null;
  issue_id: string | null;
  created_at: string;
}
