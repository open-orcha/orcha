/**
 * Project mode — "code" | "general" (portal_backend/templates_routes.py, mig 060).
 *
 * General is for non-code work (marketing, operations, research, support…). It is a
 * PRESENTATION flag: the server never gates on it, so plan approval, verification,
 * autonomy and wakes are unchanged. What changes in the portal:
 *   - the Code and GitHub project tabs are hidden (nothing is unbound or deleted —
 *     switching back to Code shows them again, intact);
 *   - the autonomy level "Build to PR" reads "Execute";
 *   - work is worded as deliverables, not pull requests / diffs.
 *
 * INTEGRATION SEAM (the integrator wires these; this module never imports the shell):
 *   - nav:       `sectionsForMode(projectSections(), mode)` in ProjectTabs / palette;
 *   - autonomy:  `autonomyLabelFor(level, fallback, mode)` in Shell's execution chip and
 *                AgentsPage's autonomy picker;
 *   - wording:   `modeWords(mode)` wherever a PR/diff noun is shown for task results;
 *   - read it:   `useProjectMode(cid)` (one fetch per project, shared by every caller,
 *                refreshed after `saveProjectMode` or an `orcha:project-mode` event).
 * Unknown / not loaded / old backend without the endpoint ⇒ "code" (today's behaviour),
 * reported as `known: false` so nothing claims a mode it hasn't read.
 */
import { useEffect, useState } from "react";
import { getJSON, sendJSON } from "../api/client";
import { registerTestReset } from "./testResets";

export type ProjectMode = "code" | "general";
export const PROJECT_MODES: ProjectMode[] = ["code", "general"];

/** Project tabs that only make sense for a code project. */
export const CODE_ONLY_SECTIONS = ["code", "github"] as const;

export interface DodPreset {
  id: string;
  name: string;
  body: string;
  source: string;
}

export interface ProjectProfile {
  container_id: string;
  mode: ProjectMode;
  dod_presets: DodPreset[];
  template_key: string | null;
  template_name: string | null;
  last_applied_at: string | null;
}

export function normalizeMode(v: unknown): ProjectMode {
  return v === "general" ? "general" : "code";
}

export const MODE_LABEL: Record<ProjectMode, string> = { code: "Code", general: "General" };
export const MODE_DESC: Record<ProjectMode, string> = {
  code: "Software work: agents deliver through branches and pull requests.",
  general: "Non-code work: agents deliver documents, plans and reports. Code and GitHub tabs are hidden.",
};

/** Drop the code-only project tabs in General mode (order preserved). */
export function sectionsForMode<T extends { key: string }>(sections: T[], mode: ProjectMode): T[] {
  if (mode !== "general") return sections;
  return sections.filter((s) => !(CODE_ONLY_SECTIONS as readonly string[]).includes(s.key));
}

/** Is this section hidden for the mode? (route guards / deep links) */
export function isSectionHidden(key: string, mode: ProjectMode): boolean {
  return mode === "general" && (CODE_ONLY_SECTIONS as readonly string[]).includes(key);
}

/** The autonomy level's label: "Build to PR" reads "Execute" in General mode. */
export function autonomyLabelFor(level: string, fallback: string, mode: ProjectMode): string {
  if (mode === "general" && level === "pr") return "Execute";
  return fallback;
}

/** Autonomy descriptions that mention PRs, reworded for General mode. */
export function autonomyDescFor(level: string, fallback: string, mode: ProjectMode): string {
  if (mode !== "general") return fallback;
  if (level === "plan") return "Agents propose a plan and wait for your approval before doing the work.";
  if (level === "pr") return "Agents do the work and hand the deliverable to a human to verify.";
  if (level === "full") return "Agents do the work end to end; a human still verifies before it counts as done.";
  return fallback;
}

export interface ModeWords {
  /** what a finished piece of work is called */
  deliverable: string;
  deliverables: string;
  /** the execute step's verb (autonomy level "pr") */
  execute: string;
  /** "Changed N files" card title in General mode */
  changesTitle: string;
  /** empty state for a task's output */
  noOutput: string;
  /** a run's diff section on the task / verify view ("Code changes" in Code mode) */
  runChanges: string;
  /** the evidence line when no run recorded a diff */
  noRunChanges: string;
}

export function modeWords(mode: ProjectMode): ModeWords {
  return mode === "general"
    ? { deliverable: "deliverable", deliverables: "Deliverables", execute: "Execute", changesTitle: "Deliverables",
        noOutput: "No deliverable attached yet.", runChanges: "Changes", noRunChanges: "No file changes" }
    : { deliverable: "pull request", deliverables: "Changes", execute: "Build to PR", changesTitle: "Changes",
        noOutput: "No changes yet.", runChanges: "Code changes", noRunChanges: "No code diff" };
}

/* ---- data: one shared fetch per project ------------------------------------ */

export const PROJECT_MODE_EVENT = "orcha:project-mode";

interface Entry { profile: ProjectProfile | null; error: string | null; at: number; inflight: Promise<void> | null }
const cache = new Map<string, Entry>();
const listeners = new Set<() => void>();
const STALE_MS = 60_000;

function notify() { listeners.forEach((l) => l()); }

export function profileUrl(cid: string): string {
  return "/api/containers/" + encodeURIComponent(cid) + "/project-profile";
}

export function fetchProjectProfile(cid: string, signal?: AbortSignal): Promise<ProjectProfile> {
  return getJSON<ProjectProfile>(profileUrl(cid), signal).then((p) => ({ ...p, mode: normalizeMode(p.mode) }));
}

function load(cid: string, force = false): Promise<void> {
  const e = cache.get(cid);
  if (e?.inflight) return e.inflight;
  if (!force && e && Date.now() - e.at < STALE_MS) return Promise.resolve();
  const entry: Entry = e || { profile: null, error: null, at: 0, inflight: null };
  entry.inflight = fetchProjectProfile(cid)
    .then((p) => { entry.profile = p; entry.error = null; })
    .catch((err: unknown) => { entry.error = (err as { message?: string })?.message || "unavailable"; })
    .finally(() => { entry.at = Date.now(); entry.inflight = null; notify(); });
  cache.set(cid, entry);
  return entry.inflight;
}

/** Drop cached profiles (tests; a project reset). */
export function resetProjectModeCache(): void { cache.clear(); notify(); }
registerTestReset(() => cache.clear());

/** Re-read one project's profile now (after a template apply, say). */
export function refreshProjectMode(cid: string): Promise<void> { return load(cid, true); }

export interface ProjectModeState {
  mode: ProjectMode;
  /** true once the server answered — false means "code" is only the default */
  known: boolean;
  profile: ProjectProfile | null;
  error: string | null;
}

export function projectModeState(cid: string | null | undefined): ProjectModeState {
  const p = cid ? cache.get(cid)?.profile ?? null : null;
  return { mode: p ? p.mode : "code", known: !!p, profile: p, error: cid ? cache.get(cid)?.error ?? null : null };
}

export function useProjectMode(cid: string | null | undefined): ProjectModeState {
  const [, bump] = useState(0);
  useEffect(() => {
    const l = () => bump((n) => n + 1);
    listeners.add(l);
    const onEvt = (ev: Event) => {
      const d = (ev as CustomEvent<{ cid?: string }>).detail;
      if (cid && (!d?.cid || d.cid === cid)) void load(cid, true);
    };
    window.addEventListener(PROJECT_MODE_EVENT, onEvt);
    if (cid) void load(cid);
    return () => { listeners.delete(l); window.removeEventListener(PROJECT_MODE_EVENT, onEvt); };
  }, [cid]);
  return projectModeState(cid);
}

/** PUT the mode (human; owner or manage_autonomy) and update every consumer. */
export async function saveProjectMode(cid: string, mode: ProjectMode, actorId: string | null): Promise<ProjectProfile> {
  const p = await sendJSON<ProjectProfile>("PUT", profileUrl(cid), { mode, actor_agent_id: actorId });
  const prof = { ...p, mode: normalizeMode(p.mode) };
  cache.set(cid, { profile: prof, error: null, at: Date.now(), inflight: null });
  notify();
  announceProjectMode(cid);
  return prof;
}

/** Tell other mounted consumers (and other bundles in the page) to re-read. */
export function announceProjectMode(cid: string): void {
  try { window.dispatchEvent(new CustomEvent(PROJECT_MODE_EVENT, { detail: { cid } })); } catch { /* no window */ }
}
