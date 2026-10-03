/**
 * Notification preferences (mig 063) — the portal's model of
 * GET/PUT /api/containers/{cid}/notification-prefs[/defaults].
 *
 * The server is the source of truth for the vocabulary (categories, channels,
 * scopes, presets, locks) and runs the ONE decision (notification_prefs.
 * should_notify) on every delivery path. This module only mirrors the layering
 * (built-in ← your defaults ← this project) so the UI can update optimistically,
 * plus a few pure helpers (presets, pause choices, labels) that are unit-tested.
 */
import { getJSON, sendJSON } from "../../../api/client";

export type Scope = "all" | "mine" | "off";
export type ChannelKey = "in_app" | "desktop" | "push" | "slack";
export interface Rule { scope: Scope; channels: Record<ChannelKey, boolean> }
export type PartialRule = { scope?: Scope; channels?: Partial<Record<ChannelKey, boolean>> };
export type Rules = Record<string, Rule>;
export interface Pause { until: number | null }
export interface QuietHours { start: string; end: string; tz: string }

export interface Catalog {
  categories: { key: string; label: string; description: string }[];
  channels: { key: ChannelKey; label: string; alert: boolean }[];
  scopes: { key: Scope; label: string }[];
  presets: { key: string; label: string; description: string; rules: Rules }[];
  locks: { category: string; channel: ChannelKey; reason: string }[];
}

export interface PrefsPayload {
  member: { id: string; alias: string; member_role?: string | null };
  catalog: Catalog;
  channels: Record<ChannelKey, { available: boolean; reason: string | null }>;
  defaults: { rules: Rules; pause: Pause | null; quiet_hours: QuietHours | null; stored: boolean };
  project: { rules: Record<string, PartialRule>; muted: boolean; stored: boolean };
  effective: { rules: Rules; pause: Pause | null; quiet_hours: QuietHours | null; muted: boolean; paused_now: boolean; quiet_now?: boolean };
  editable: boolean;
}

export const prefsUrl = (cid: string, defaults = false) =>
  "/api/containers/" + encodeURIComponent(cid) + "/notification-prefs" + (defaults ? "/defaults" : "");

export function fetchPrefs(cid: string, actorId: string | null): Promise<PrefsPayload> {
  return getJSON<PrefsPayload>(prefsUrl(cid) + (actorId ? "?actor_agent_id=" + encodeURIComponent(actorId) : ""));
}

export function putProject(cid: string, actorId: string | null, body: { rules?: Record<string, PartialRule>; muted?: boolean }): Promise<PrefsPayload> {
  return sendJSON<PrefsPayload>("PUT", prefsUrl(cid), { ...body, ...(actorId ? { actor_agent_id: actorId } : {}) });
}

export function putDefaults(cid: string, actorId: string | null, body: { rules?: Rules; pause?: Pause | null; quiet_hours?: QuietHours | null }): Promise<PrefsPayload> {
  return sendJSON<PrefsPayload>("PUT", prefsUrl(cid, true), { ...body, ...(actorId ? { actor_agent_id: actorId } : {}) });
}

export function resetProject(cid: string, actorId: string | null): Promise<PrefsPayload> {
  return sendJSON<PrefsPayload>("DELETE", prefsUrl(cid) + (actorId ? "?actor_agent_id=" + encodeURIComponent(actorId) : ""));
}

/* ---------------------------------------------------------------- pure ---- */

export function mergeRule(base: Rule, over?: PartialRule | null): Rule {
  const out: Rule = { scope: base.scope, channels: { ...base.channels } };
  if (over) {
    if (over.scope) out.scope = over.scope;
    Object.assign(out.channels, over.channels || {});
  }
  return out;
}

/** built-in ⊕ defaults (server-resolved) ⊕ this project's override, locks forced on. */
export function effectiveRules(p: Pick<PrefsPayload, "defaults" | "project" | "catalog">): Rules {
  const out: Rules = {};
  for (const c of p.catalog.categories) {
    const base = p.defaults.rules[c.key];
    if (!base) continue;
    out[c.key] = mergeRule(base, p.project.rules[c.key]);
  }
  for (const l of p.catalog.locks) if (out[l.category]) out[l.category].channels[l.channel] = true;
  return out;
}

/** Recompute `effective` after an optimistic edit (mirrors notification_prefs.resolve). */
export function withEffective(p: PrefsPayload, now = Date.now()): PrefsPayload {
  const pause = p.defaults.pause;
  return {
    ...p,
    effective: {
      ...p.effective,
      rules: effectiveRules(p),
      pause,
      quiet_hours: p.defaults.quiet_hours,
      muted: p.project.muted,
      paused_now: isPaused(pause, now),
    },
  };
}

export function isPaused(pause: Pause | null | undefined, now = Date.now()): boolean {
  if (!pause) return false;
  return pause.until == null || now / 1000 < pause.until;
}

export function isLocked(cat: Catalog, category: string, channel: ChannelKey): string | null {
  return cat.locks.find((l) => l.category === category && l.channel === channel)?.reason ?? null;
}

/** Which preset (if any) the rules match exactly. */
export function matchingPreset(cat: Catalog, rules: Rules): string | null {
  for (const p of cat.presets) {
    const same = cat.categories.every((c) => {
      const a = rules[c.key], b = p.rules[c.key];
      if (!a || !b || a.scope !== b.scope) return false;
      return cat.channels.every((ch) => !!a.channels[ch.key] === !!b.channels[ch.key]);
    });
    if (same) return p.key;
  }
  return null;
}

export type PauseChoice = "1h" | "tomorrow" | "forever";
export const PAUSE_LABEL: Record<PauseChoice, string> = {
  "1h": "For 1 hour",
  tomorrow: "Until tomorrow",
  forever: "Until I turn it back on",
};

/** The `pause` value for a snooze choice. "Until tomorrow" = 8:00 tomorrow, local time. */
export function pauseFor(choice: PauseChoice, now: Date = new Date()): Pause {
  if (choice === "forever") return { until: null };
  if (choice === "1h") return { until: Math.round(now.getTime() / 1000) + 3600 };
  const t = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 8, 0, 0, 0);
  return { until: Math.round(t.getTime() / 1000) };
}

/** "Paused until 3:40 PM" / "Paused until tomorrow, 8:00 AM" / "Paused until you turn them back on". */
export function pauseText(pause: Pause | null | undefined, now: Date = new Date()): string | null {
  if (!isPaused(pause, now.getTime())) return null;
  if (!pause || pause.until == null) return "Paused until you turn them back on";
  const d = new Date(pause.until * 1000);
  const time = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  const sameDay = d.toDateString() === now.toDateString();
  const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).toDateString() === d.toDateString();
  if (sameDay) return "Paused until " + time;
  if (tomorrow) return "Paused until tomorrow, " + time;
  return "Paused until " + d.toLocaleDateString([], { month: "short", day: "numeric" }) + ", " + time;
}

export function localTimeZone(): string {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"; } catch { return "UTC"; }
}

const FALLBACK_ZONES = [
  "UTC", "America/Los_Angeles", "America/Denver", "America/Chicago", "America/New_York", "America/Sao_Paulo",
  "Europe/London", "Europe/Paris", "Europe/Berlin", "Africa/Nairobi", "Asia/Dubai", "Asia/Kolkata",
  "Asia/Singapore", "Asia/Tokyo", "Australia/Sydney", "Pacific/Auckland",
];

export function timeZones(current?: string | null): string[] {
  let list: string[] = FALLBACK_ZONES;
  try {
    const sv = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf;
    if (typeof sv === "function") list = sv("timeZone");
  } catch { /* older engines */ }
  const out = list.slice();
  for (const z of [current, localTimeZone()]) if (z && out.indexOf(z) < 0) out.unshift(z);
  return out;
}

/** A failed save, in plain words (never a status code or URL). */
export function prefsErrText(e: unknown): string {
  const err = e as { status?: unknown; message?: unknown } | null;
  const msg = err && typeof err.message === "string" ? err.message : "";
  const m = /→\s*(\d{3})(?::\s*([\s\S]*))?$/.exec(msg);
  const status = m ? Number(m[1]) : err && typeof err.status === "number" ? err.status : 0;
  const own = (e as { detail?: unknown } | null)?.detail;
  const detail = typeof own === "string" && own ? own : m && m[2] ? m[2].trim() : "";
  if (detail && detail[0] !== "{" && detail[0] !== "[") return detail;
  if (!status) return "Embodent couldn't be reached";
  if (status === 401 || status === 403) return "you can only change your own notification settings";
  if (status === 422) return "that setting isn't valid";
  if (status >= 500) return "Embodent hit an error — try again";
  return "the server refused the change";
}
