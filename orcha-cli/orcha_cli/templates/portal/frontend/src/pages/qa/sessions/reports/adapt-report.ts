/**
 * A session's audit as the measured-report reader reads it: its measurements as findings, its
 * agent's impressions as notes, what it judged, and the session before it in the series as the
 * previous revision.
 */
import type { QaMeasured, QaSession, SessionDetail } from "../../qaApi";
import { findingOf, severityOf } from "../adapt";
import type { QaStep, SessionDigest } from "../api";
import { summarize } from "./exploration";
import type { Finding } from "../explorations";
import type { ExplorationFinding, ExplorationNote, ExplorationNoteKind, ExplorationReport, ExplorationReportDetail, ExplorationReportSummary } from "./types";

const NOTE_KINDS: readonly string[] = ["impression", "usability", "idea", "improvement", "needs_info"];

export function measuredOf(m: QaMeasured): ExplorationFinding {
  return {
    id: m.id,
    report_id: m.session_id,
    kind: m.kind as ExplorationFinding["kind"],
    severity: m.severity as ExplorationFinding["severity"],
    summary: m.summary,
    measured: m.measured,
    threshold: m.threshold,
    unit: m.unit,
    confident: m.confident,
    screen_hash: m.screen_key ?? m.screen_hash,
    step_seq: m.step_seq,
    frame_path: m.frame_id,
    rect: m.rect,
    element_index: null,
    element_label: m.element_label,
    element_identifier: m.element_identifier,
    appearance: m.appearance,
    detail: m.extra ?? {},
    created_at: m.created_at,
  };
}

/** The impressions the agent left (`note` steps that are not a finding). */
export function notesOf(sessionId: string, steps: readonly QaStep[]): ExplorationNote[] {
  return steps.flatMap((s) => {
    const a = (s.args ?? {}) as Record<string, unknown>;
    if (s.kind !== "note" || a.finding || typeof a.title !== "string") return [];
    const kind = (NOTE_KINDS.includes(String(a.kind)) ? a.kind : "impression") as ExplorationNoteKind;
    return [{ id: s.id ?? `${sessionId}-${s.seq}`, report_id: sessionId, kind, title: a.title, body: typeof a.body === "string" ? a.body : null, frame_path: s.frame_id, screen_hash: s.screen_key ?? s.screen_hash, created_at: s.at ?? "" }];
  });
}

function reportOf(s: QaSession, screens: number, revision: number): ExplorationReport {
  return {
    id: s.id,
    project_id: "",
    target_id: null,
    run_id: s.id,
    build_id: null,
    app_version: s.app_id,
    git_commit: null,
    git_branch: null,
    revision,
    target_kind: s.platform,
    appearances: [],
    screens_seen: screens,
    summary_md: s.report_md,
    created_at: s.started_at ?? "",
  };
}

export function reportDetailOf(d: SessionDetail, steps: readonly QaStep[], revision = 1): ExplorationReportDetail {
  const r = (d.session.result ?? {}) as { screens?: unknown };
  return {
    report: reportOf(d.session, typeof r.screens === "number" ? r.screens : 0, revision),
    findings: (d.measured ?? []).map(measuredOf),
    notes: notesOf(d.session.id, steps),
    judged: d.findings.filter((f) => f.status !== "dismissed").map((f, i) => ({ ...findingOf(f, i + 1, d.session.platform), severity: severityOf(f.severity) })),
  };
}

export function previousOf(d: SessionDetail): { summary: ExplorationReportSummary; detail: ExplorationReportDetail } {
  const detail = reportDetailOf(d, []);
  return { summary: summarize(detail.report, detail.findings, detail.notes, detail.judged), detail };
}

/** Another session of the series, as the rail lists it. */
export function summaryOfDigest(s: QaSession, d: SessionDigest | undefined, revision = 1): ExplorationReportSummary {
  const judged: Finding[] = (d?.findings ?? []).filter((f) => f.status !== "dismissed").map((f, i) => findingOf(f, i + 1, s.platform));
  return summarize(reportOf(s, 0, revision), (d?.measured ?? []).map(measuredOf), [], judged);
}
