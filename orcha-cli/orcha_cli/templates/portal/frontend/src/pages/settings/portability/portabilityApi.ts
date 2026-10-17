/**
 * Portable project templates — API + pure helpers (Settings → General › Template).
 *
 * Server (portal_backend/project_export_routes.py, project_export_library_routes.py):
 *   POST /api/containers/{cid}/template/export   {actor_agent_id, include_budgets}
 *   POST /api/containers/{cid}/template/preview  {actor_agent_id, bundle, options}
 *   POST /api/containers/{cid}/template/import   {…, confirm: true, preview_digest}
 *   POST /api/template/preview-new               {bundle, options} (a project that doesn't exist yet)
 *   GET/POST /api/containers/{cid}/dod-presets · PATCH/DELETE /api/dod-presets/{id}
 *   GET/POST /api/containers/{cid}/skills      · PATCH/DELETE /api/skills/{id}
 * Everything shown comes from those responses — nothing is inferred client-side.
 */
import { getJSON, sendJSON } from "../../../api/client";

export type SectionKey = "roster" | "routines" | "dod_presets" | "skills" | "budgets";
export const SECTION_KEYS: SectionKey[] = ["roster", "routines", "dod_presets", "skills", "budgets"];
export const SECTION_LABEL: Record<SectionKey | "reporting_lines", string> = {
  roster: "Agents",
  reporting_lines: "Reporting lines",
  routines: "Routines",
  dod_presets: "DoD presets",
  skills: "Skills",
  budgets: "Budgets",
};

export interface Bundle {
  format: string;
  version: number;
  exported_at?: string;
  source?: { project_name?: string | null };
  roster?: unknown[];
  routines?: unknown[];
  dod_presets?: unknown[];
  skills?: unknown[];
  budgets?: unknown;
  scrub?: { redactions: { field: string; kinds: string[] }[]; never_exported: string[] };
  digest?: string;
  [k: string]: unknown;
}

export interface CollisionChoice { action: "rename" | "skip"; rename_to?: string | null }
export interface ImportOptions {
  sections: Partial<Record<SectionKey, boolean>>;
  collisions: Record<string, CollisionChoice>;
  human_seats: "me" | "unassigned";
  enable_routines: boolean;
}
export const DEFAULT_OPTIONS: ImportOptions = { sections: {}, collisions: {}, human_seats: "me", enable_routines: false };

export interface RosterItem {
  alias: string;
  final_alias: string;
  action: "create" | "rename" | "skip";
  collision: boolean;
  suggested_alias: string | null;
  notes: string[];
  role?: string;
  model?: string;
  reasoning_effort?: string | null;
  autonomy_override?: string | null;
  auto_wake_interval_secs?: number | null;
}
export interface LineItem { alias: string; action: "set" | "skip"; manager: { label: string } | null; note: string | null }
export interface RoutineItem { title: string; action: "create" | "skip"; assignee: { alias: string } | null; enabled: boolean; cron: string; timezone: string; notes: string[] }
export interface NamedItem { name: string; final_name: string; action: "create" | "rename" | "skip"; notes: string[] }
export interface BudgetItem { scope: "project" | "agent"; alias?: string; action: "set" | "skip"; monthly_limit_usd: number | null; monthly_limit_tokens: number | null; note: string | null }
export interface Count { create: number; skip: number }

export interface Preview {
  bundle: {
    format: string; version: number; project_name: string | null; exported_at: string | null;
    digest_ok: boolean | null; has_budgets: boolean; counts: Record<SectionKey, number>;
  };
  sections: {
    roster: RosterItem[]; reporting_lines: LineItem[]; routines: RoutineItem[];
    dod_presets: NamedItem[]; skills: NamedItem[]; budgets: BudgetItem[];
  };
  included: Record<SectionKey, boolean>;
  counts: Record<SectionKey | "reporting_lines", Count>;
  errors: { section: string; alias?: string; message: string }[];
  warnings: string[];
  changes: number;
  /** template agents that report to a person (the "managers who were people" choice) */
  human_seat_lines?: number;
  preview_digest: string | null;
  target?: "new";
}

export interface ImportResult {
  applied: Record<string, Count>;
  agents: { alias: string; agent_id: string; from_alias: string }[];
  routines: { routine_id: string; title: string; enabled: boolean }[];
  dod_presets: { id: string; name: string }[];
  skills: { id: string; name: string }[];
  budgets: { scope: string; alias?: string | null }[];
  reporting_lines: { alias: string; reports_to: string }[];
}

const enc = encodeURIComponent;

export function exportTemplate(cid: string, actor: string | null, includeBudgets: boolean): Promise<Bundle> {
  return sendJSON<Bundle>("POST", `/api/containers/${enc(cid)}/template/export`, { actor_agent_id: actor, include_budgets: includeBudgets });
}

export function previewImport(cid: string, actor: string | null, bundle: Bundle, options: ImportOptions): Promise<Preview> {
  return sendJSON<Preview>("POST", `/api/containers/${enc(cid)}/template/preview`, { actor_agent_id: actor, bundle, options });
}

export function previewNewProject(bundle: Bundle, options: ImportOptions): Promise<Preview> {
  return sendJSON<Preview>("POST", "/api/template/preview-new", { bundle, options });
}

export function applyImport(cid: string, actor: string | null, bundle: Bundle, options: ImportOptions, digest: string): Promise<ImportResult> {
  return sendJSON<ImportResult>("POST", `/api/containers/${enc(cid)}/template/import`, {
    actor_agent_id: actor, bundle, options, confirm: true, preview_digest: digest,
  });
}

export function createProject(name: string): Promise<{ container_id: string; human_agent_id: string | null; name?: string }> {
  return sendJSON("POST", "/api/containers", { name, additional: true });
}

// ---- library ---------------------------------------------------------------
export interface LibraryItem {
  id: string; name: string; body: string; description?: string | null;
  source: "manual" | "template_import"; updated_at: string; updated_by_alias?: string | null;
}
export type LibraryKind = "dod-presets" | "skills";
export function listLibrary(cid: string, kind: LibraryKind): Promise<{ items: LibraryItem[] }> {
  return getJSON(`/api/containers/${enc(cid)}/${kind}`);
}
export function createLibraryItem(cid: string, kind: LibraryKind, body: Record<string, unknown>): Promise<LibraryItem> {
  return sendJSON("POST", `/api/containers/${enc(cid)}/${kind}`, body);
}
export function updateLibraryItem(kind: LibraryKind, id: string, body: Record<string, unknown>): Promise<LibraryItem> {
  return sendJSON("PATCH", `/api/${kind}/${enc(id)}`, body);
}
export function deleteLibraryItem(kind: LibraryKind, id: string, actor: string | null): Promise<unknown> {
  return sendJSON("DELETE", `/api/${kind}/${enc(id)}${actor ? "?actor_agent_id=" + enc(actor) : ""}`);
}

// ---- pure helpers (tested) -------------------------------------------------

/** A filesystem-safe download name: "<project>-template-YYYY-MM-DD.json". */
export function templateFileName(project: string | null | undefined, when: Date = new Date()): string {
  const slug = (project || "project").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "project";
  const d = when.toISOString().slice(0, 10);
  return `${slug}-template-${d}.json`;
}

const plural = (n: number, one: string, many = one + "s") => `${n} ${n === 1 ? one : many}`;

/** "3 agents · 1 routine · 2 DoD presets · 1 skill" from a bundle (zero parts dropped). */
export function bundleSummary(b: Pick<Bundle, "roster" | "routines" | "dod_presets" | "skills" | "budgets">): string {
  const parts = [
    plural((b.roster || []).length, "agent"),
    plural((b.routines || []).length, "routine"),
    plural((b.dod_presets || []).length, "DoD preset"),
    plural((b.skills || []).length, "skill"),
  ].filter((p) => !p.startsWith("0 "));
  if (b.budgets) parts.push("budgets");
  return parts.length ? parts.join(" · ") : "nothing to carry yet";
}

/** Parse a picked file's text into a bundle, or a plain-words error. */
export function parseBundleText(text: string): { bundle: Bundle | null; error: string | null } {
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { return { bundle: null, error: "This file isn't valid JSON." }; }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { bundle: null, error: "This file isn't a Embodent project template." };
  const b = raw as Bundle;
  if (b.format !== "orcha.project-template") return { bundle: null, error: "This file isn't a Embodent project template." };
  if (typeof b.version !== "number") return { bundle: null, error: "This template has no version." };
  return { bundle: b, error: null };
}

/** The short outcome chip for one planned item. */
export function actionLabel(action: string, finalName?: string, original?: string): { text: string; tone: "ok" | "neutral" | "warn" } {
  if (action === "create" || action === "set") return { text: "New", tone: "ok" };
  if (action === "rename") return { text: finalName && finalName !== original ? "As " + finalName : "Renamed", tone: "warn" };
  return { text: "Skip", tone: "neutral" };
}

/** "Import 7 changes" / "Nothing to import". */
export function importButtonLabel(changes: number): string {
  return changes > 0 ? `Import ${plural(changes, "change")}` : "Nothing to import";
}

/** One line describing what an import did, for the toast / status line. */
export function importResultText(r: ImportResult): string {
  const parts: string[] = [];
  if (r.agents.length) parts.push(plural(r.agents.length, "agent"));
  if (r.routines.length) {
    const paused = r.routines.filter((x) => !x.enabled).length;
    parts.push(plural(r.routines.length, "routine") + (paused === r.routines.length ? " (paused)" : paused ? ` (${paused} paused)` : ""));
  }
  if (r.dod_presets.length) parts.push(plural(r.dod_presets.length, "DoD preset"));
  if (r.skills.length) parts.push(plural(r.skills.length, "skill"));
  if (r.budgets.length) parts.push(plural(r.budgets.length, "budget"));
  return parts.length ? "Imported " + parts.join(", ") + "." : "Nothing was imported — everything was already here.";
}

/** Do two plans do the same thing (virtual new-project preview vs the real one)? */
export function sameCounts(a: Preview["counts"], b: Preview["counts"]): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** A picked file's text (Blob.text where available, FileReader otherwise). */
export function readFileText(f: Blob): Promise<string> {
  if (typeof (f as Blob & { text?: unknown }).text === "function") return f.text();
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result ?? ""));
    r.onerror = () => reject(r.error);
    r.readAsText(f);
  });
}

/** Download a JSON object as a file (browser only). */
export function downloadJSON(obj: unknown, filename: string): void {
  const blob = new Blob([JSON.stringify(obj, null, 2) + "\n"], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
