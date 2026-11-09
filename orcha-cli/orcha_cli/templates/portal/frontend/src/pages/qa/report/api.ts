/**
 * Quality reports (`qa_report_routes.py`): a task's report as a file (Markdown for a Jira ticket,
 * a zip bundle with its screenshots), and someone else's report imported here. An imported report
 * is what they reported, never proof for this project.
 */
import { cleanConditions, type Conditions } from "../conditions/conditions";
import { getJSON, sendJSON } from "../../../api/client";
import type { Platform } from "../qaApi";

export type ReportVerdict = "pass" | "fail" | "blocked" | "inconclusive" | null;

export interface ReportCheck { index: number; text: string; verdict: ReportVerdict; note?: string | null; frame_ids: string[] }
export interface ReportScenario { id: string; name: string; platform: Platform; tags: string[]; persona?: string | null; verdict: ReportVerdict; checks: ReportCheck[]; criteria?: string[]; conditions?: Conditions | null }
export interface ReportFinding { id: string; severity: string; title: string; expected?: string | null; actual?: string | null; status: string; frame_ids: string[] }
export interface ReportScreen { platform: Platform; key: string; label: string; feature?: string | null; frame_id?: string | null }
export interface ReportRun { id: string; kind: string; platform: Platform; device?: string | null; app_build?: string | null; agent?: string | null; status: string; started_at?: string | null; conditions?: Conditions | null }

export interface ReportData {
  schema: "orcha-quality-report";
  version: number;
  generated_at: string;
  task: { id: string; title: string; status: string; project: string; definition_of_done?: string };
  result: ReportVerdict;
  build: { branch?: string; commit?: string; url?: string; app_path?: string };
  runs: ReportRun[];
  setup: { platforms: Platform[]; apps: Record<string, { app_id?: string | null; app_name?: string | null }>; devices: string[]; accounts: { persona?: string | null; needs?: string | null }[] };
  lines: ReportCheck[];
  scenarios: ReportScenario[];
  findings: ReportFinding[];
  screens: ReportScreen[];
  features: string[];
  gaps: { id: string; name: string; platform: Platform }[];
  gaps_total: number;
  tally: { scenarios: number; passed: number; failed: number; blocked: number; findings: number };
  /** The screenshots that came in the bundle. */
  frames?: string[];
}

export interface ImportedReport {
  id: string;
  title: string;
  file_name: string | null;
  imported_by: string | null;
  created_at: string;
  data: ReportData;
  /** Each reported scenario's id here, or null when this project has no such scenario. */
  matched: Record<string, string | null>;
}

export interface ReportRow {
  id: string; title: string; file_name: string | null; imported_by: string | null; created_at: string;
  result: ReportVerdict; tally: ReportData["tally"] | null; platforms: Platform[]; project?: string | null;
}

const enc = encodeURIComponent;

/** Save the task's report: `md` to attach to a ticket, `zip` with its screenshots. */
export async function downloadReport(tid: string, format: "md" | "zip"): Promise<void> {
  const r = await fetch(`/api/tasks/${enc(tid)}/qa/report.${format}`);
  if (!r.ok) {
    const body = await r.json().catch(() => null) as { detail?: unknown } | null;
    throw new Error(typeof body?.detail === "string" ? body.detail : "The report could not be made.");
  }
  const name = /filename="([^"]+)"/.exec(r.headers.get("content-disposition") ?? "")?.[1] ?? `quality-report.${format}`;
  const url = URL.createObjectURL(await r.blob());
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export async function importReport(cid: string, file: File, actorId: string | null): Promise<ImportedReport> {
  const q = new URLSearchParams({ file_name: file.name, ...(actorId ? { actor_agent_id: actorId } : {}) });
  const r = await fetch(`/api/containers/${enc(cid)}/qa/reports?${q}`, { method: "POST", body: file });
  if (!r.ok) {
    const body = await r.json().catch(() => null) as { detail?: unknown } | null;
    throw new Error(typeof body?.detail === "string" ? body.detail : "This file could not be imported.");
  }
  return r.json() as Promise<ImportedReport>;
}

export const listReports = (cid: string, signal?: AbortSignal) =>
  getJSON<{ reports: ReportRow[] }>(`/api/containers/${enc(cid)}/qa/reports`, signal).then((d) => d.reports);
export const getReport = (rid: string, signal?: AbortSignal) => getJSON<ImportedReport>(`/api/qa/reports/${enc(rid)}`, signal);
export const addReportDrafts = (rid: string, actorId: string | null) =>
  sendJSON<{ created: string[] }>("POST", `/api/qa/reports/${enc(rid)}/drafts`, { actor_agent_id: actorId });
export const deleteReport = (rid: string, actorId: string | null) =>
  sendJSON<{ deleted: string }>("DELETE", `/api/qa/reports/${enc(rid)}${actorId ? `?actor_agent_id=${enc(actorId)}` : ""}`);

/** A screenshot that came in the bundle, or null when the import had none (a Markdown file). */
export function reportFrameSrc(report: Pick<ImportedReport, "id" | "data">, fid: string | null | undefined): string | null {
  return fid && (report.data.frames ?? []).includes(fid) ? `/api/qa/reports/${enc(report.id)}/frames/${enc(fid)}` : null;
}

/** "3 scenarios: 2 passed, 1 failed · 1 finding" */
export function tallyWords(t: ReportData["tally"] | null | undefined): string {
  if (!t) return "";
  const parts = [`${t.scenarios} ${t.scenarios === 1 ? "scenario" : "scenarios"}`];
  const said = [t.passed ? `${t.passed} passed` : null, t.failed ? `${t.failed} failed` : null, t.blocked ? `${t.blocked} blocked` : null].filter(Boolean);
  const head = said.length ? `${parts[0]}: ${said.join(", ")}` : parts[0];
  return t.findings ? `${head} · ${t.findings} ${t.findings === 1 ? "finding" : "findings"}` : head;
}

/** The scenario ids a re-run here can take: the reported ones this project has, per platform, with
 * the conditions the reported run was under, so the re-run recreates them. */
export function rerunIds(report: Pick<ImportedReport, "data" | "matched">): { platform: Platform; ids: string[]; conditions: Conditions | null }[] {
  const by = new Map<Platform, string[]>();
  for (const s of report.data.scenarios) {
    const here = report.matched[s.id];
    if (here) by.set(s.platform, [...(by.get(s.platform) ?? []), here]);
  }
  return [...by.entries()].map(([platform, ids]) => ({
    platform, ids, conditions: cleanConditions(report.data.runs.find((r) => r.platform === platform && cleanConditions(r.conditions))?.conditions),
  }));
}
