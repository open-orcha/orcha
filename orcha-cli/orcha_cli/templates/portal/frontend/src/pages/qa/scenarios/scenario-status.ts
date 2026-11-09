/**
 * Scenario lifecycle status: the one place Quality decides how a status reads. Stored in
 * `qa_scenarios.status` as draft | validated | paused | retired; the screens show an *effective*
 * status that adds `quarantined` (a validated scenario in flaky quarantine, `quarantined_at`).
 *
 * - draft: proposed, not reviewed. Runs only when picked.
 * - validated: trusted, runs on every check, counts for coverage, a failure fails the check.
 * - quarantined: flaky; runs and covers, never fails a check. Leaves on its own after clean passes.
 * - paused: skipped by check runs, listed as skipped; keeps its coverage; a person can still pick
 *   it. Resumes on its own when `status_until` arrives or its task finishes.
 * - retired: obsolete, kept for history, never runs, hidden from default lists; restorable.
 */

export type EffectiveStatus = "draft" | "validated" | "quarantined" | "paused" | "retired";

/** Menu order: the everyday two first, then the three that set a scenario aside. */
export const EFFECTIVE_STATUSES: readonly EffectiveStatus[] = ["draft", "validated", "quarantined", "paused", "retired"];

/** Statuses that need a reason (and open the inline form). */
export const NEEDS_REASON: ReadonlySet<EffectiveStatus> = new Set(["quarantined", "paused", "retired"]);

export interface StatusRow {
  id?: string;
  name?: string;
  status?: string | null;
  quarantined_at?: string | null;
  quarantine_reason?: string | null;
  status_reason?: string | null;
  status_until?: string | null;
  status_issue?: string | null;
  replaced_by?: string | null;
}

export const STATUS_LABEL: Record<EffectiveStatus, string> = {
  draft: "Draft",
  validated: "Validated",
  quarantined: "Quarantined",
  paused: "Paused",
  retired: "Retired",
};

/** The one-line meaning shown under each menu row. */
export const STATUS_MEANING: Record<EffectiveStatus, string> = {
  draft: "Proposed, not reviewed. Runs only when picked.",
  validated: "Trusted. Every check run covers it.",
  quarantined: "Flaky. Runs, never fails a check.",
  paused: "Skipped for now. Resumes on a date or when a task finishes.",
  retired: "Obsolete. Kept for history, never runs.",
};

export function effectiveStatus(s: StatusRow): EffectiveStatus {
  if (s.status === "retired") return "retired";
  if (s.status === "paused") return "paused";
  if (s.status === "validated") return s.quarantined_at ? "quarantined" : "validated";
  return "draft";
}

export const isRetired = (s: StatusRow) => effectiveStatus(s) === "retired";

/** Covers what it tests (coverage, the map's "covered by"): validated, quarantined or paused. */
export function countsForCoverage(s: StatusRow): boolean {
  const e = effectiveStatus(s);
  return e === "validated" || e === "quarantined" || e === "paused";
}

/** A failure fails the check run: validated only. */
export const gates = (s: StatusRow) => effectiveStatus(s) === "validated";

/** Runs in a standing selection ("All validated", a suite's rules, a schedule, a PR check). */
export const runsInBatch = (s: StatusRow) => {
  const e = effectiveStatus(s);
  return e === "validated" || e === "quarantined";
};

/** "Flag off until 2026-11-01", "Checkout crash until #42 closes"; "" when nothing to say. */
export function statusDetail(s: StatusRow): string {
  const e = effectiveStatus(s);
  if (e === "draft" || e === "validated") return "";
  let reason = String(s.status_reason ?? "").trim();
  if (e === "quarantined") reason = String(s.quarantine_reason ?? "").trim() || "flaky";
  const bits = reason ? [reason] : [];
  if (e === "paused") {
    const until = String(s.status_until ?? "").slice(0, 10);
    const issue = String(s.status_issue ?? "").trim();
    if (until) bits.push(`until ${until}`);
    if (issue) bits.push(until ? `or ${issue} closes` : `until ${issue} closes`);
  }
  return bits.join(" ");
}

/** Null when it runs, else why not. `picked`: a person chose it for this run. `drafts`: drafts
 * run too (an explicit list, a suite with `include_drafts`). */
export function skipReason(s: StatusRow, opts: { picked?: boolean; drafts?: boolean } = {}): string | null {
  const e = effectiveStatus(s);
  if (e === "retired") return "retired";
  if (e === "paused" && !opts.picked) {
    const why = statusDetail(s);
    return why ? `paused: ${why}` : "paused";
  }
  if (e === "draft" && !(opts.picked || opts.drafts)) return "draft";
  return null;
}

export const runnable = (s: StatusRow, opts: { picked?: boolean; drafts?: boolean } = {}) => skipReason(s, opts) === null;

/** "Skipped (paused: Flag off until 2026-11-01)". */
export const skippedLabel = (reason: string) => `Skipped (${reason})`;

export type IssueRef = { kind: "task"; id: string } | { kind: "github"; repo: string | null; number: number };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const GITHUB_URL_RE = /github\.com\/([\w.-]+\/[\w.-]+)\/(?:issues|pull)\/(\d+)/i;
const GITHUB_REF_RE = /^(?:([\w.-]+\/[\w.-]+))?#(\d+)$/;

/** A task id, `#42`, `owner/repo#42` or a GitHub issue URL; null otherwise. */
export function parseIssueRef(text: unknown): IssueRef | null {
  const t = String(text ?? "").trim();
  if (!t) return null;
  if (UUID_RE.test(t)) return { kind: "task", id: t.toLowerCase() };
  let m = GITHUB_URL_RE.exec(t);
  if (m) return { kind: "github", repo: m[1], number: Number(m[2]) };
  m = GITHUB_REF_RE.exec(t);
  if (m) return { kind: "github", repo: m[1] ?? null, number: Number(m[2]) };
  return null;
}

/** Paused with an until date that has arrived (`today` is `YYYY-MM-DD`). */
export function dueByDate(s: StatusRow, today: string): boolean {
  const until = String(s.status_until ?? "");
  return effectiveStatus(s) === "paused" && /^\d{4}-\d{2}-\d{2}/.test(until) && until.slice(0, 10) <= today;
}

/** Today as `YYYY-MM-DD` (UTC, like the worker's resume tick). */
export const todayIso = (now: Date = new Date()) => now.toISOString().slice(0, 10);

// ---------- what a run skipped ----------

export interface StatusSkipped {
  id: string;
  name: string;
  status: EffectiveStatus;
  /** "paused: Flag off until 2026-11-01", "retired". */
  reason: string;
}

/** The scenarios a run left out for their status (`status_skipped` in a session's summary): paused ones in a standing selection, retired ones anywhere. */
export function statusSkippedOf(summary: unknown): StatusSkipped[] {
  if (!summary || typeof summary !== "object") return [];
  const raw = (summary as Record<string, unknown>).status_skipped;
  if (!Array.isArray(raw)) return [];
  const out: StatusSkipped[] = [];
  for (const e of raw) {
    if (!e || typeof e !== "object") continue;
    const r = e as Record<string, unknown>;
    const status = EFFECTIVE_STATUSES.includes(r.status as EffectiveStatus) ? (r.status as EffectiveStatus) : "paused";
    if (typeof r.id !== "string") continue;
    out.push({ id: r.id, name: typeof r.name === "string" && r.name ? r.name : r.id, status, reason: typeof r.reason === "string" && r.reason ? r.reason : status });
  }
  return out;
}
