/**
 * Plain-language words for every QA state the API returns (never a raw enum on screen),
 * plus the status-glyph each one borrows from the shared StatusIcon set.
 */
import type {
  BlockedKind, EvidenceStatus, FindingStatus, MapSource, MissionStatus, NodeState, Platform, ScenarioStatus,
  SessionKind, SessionStatus, Severity, SuggestionStatus, Verdict, WalkStatus,
} from "./qaApi";

const words = <K extends string>(map: Record<K, string>) => (k: K | string | null | undefined): string =>
  (k && (map as Record<string, string>)[k]) || (k ? String(k).replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase()) : "—");

export const platformWord = words<Platform>({ ios: "iOS", android: "Android", web: "Web" });

/** What each platform runs on, for copy ("a simulator", "an emulator", "a browser"). */
export const platformDeviceWord = words<Platform>({ ios: "a simulator", android: "an emulator", web: "a browser" });

export const nodeStateWord = words<NodeState>({ seen: "Seen", declared: "Not reached yet", blocked: "Blocked" });

/** What each state means, for tooltips. */
export const nodeStateHint = words<NodeState>({
  seen: "An agent has been on this screen on a device or in a browser.",
  declared: "Known from the code or the plan, but no agent has reached it yet.",
  blocked: "An agent tried to reach this screen and could not.",
});

export const blockedKindWord = words<BlockedKind>({
  needs_sign_in: "Needs sign-in",
  needs_data: "Needs data",
  needs_permission: "Needs a permission",
  paywall: "Behind a paywall",
  external: "Leaves the app",
  crash: "Crashes",
  other: "Dead end",
});

export const sourceWord = words<MapSource>({ code: "Code", tests: "Tests", live: "Device", crawl: "Crawl", agent: "Agent" });

export const scenarioStatusWord = words<ScenarioStatus>({ draft: "Draft", validated: "Approved", paused: "Paused", retired: "Retired" });

export const scenarioStatusHint = words<ScenarioStatus>({
  draft: "Proposed by an agent. A person reviews it before it's checked.",
  validated: "Approved by a person. Agents check it on every QA run.",
  paused: "Kept, but agents skip it for now.",
  retired: "No longer checked. Kept for the record.",
});

export const scenarioSourceWord = words<"authored" | "generated" | "walk">({
  authored: "Written by a person",
  generated: "Drafted from the code",
  walk: "Drafted from a walk through the app",
});

export const evidenceWord = words<EvidenceStatus>({ verified: "Seen on screen", unconfirmed: "Not confirmed", code_only: "Code only" });

export const sessionKindWord = words<SessionKind>({ map: "Mapping", explore: "Exploration", draft: "Drafting", check: "Check run" });

export const sessionStatusWord = words<SessionStatus>({ running: "Running", done: "Finished", failed: "Failed", cancelled: "Stopped", abandoned: "Stopped responding" });

export const missionStatusWord = words<MissionStatus>({ active: "In progress", covered: "Covered", partial: "Partly covered", blocked: "Blocked", bug: "Bug found" });

export const walkStatusWord = words<WalkStatus>({ walking: "Walking", passed: "Passed", failed: "Failed", unreachable: "Couldn't reach", abandoned: "Abandoned" });

export const severityWord = words<Severity>({ blocker: "Blocker", major: "Major", minor: "Minor", trivial: "Trivial" });

export const findingStatusWord = words<FindingStatus>({ open: "Open", filed: "Filed as task", dismissed: "Dismissed" });

export const suggestionStatusWord = words<SuggestionStatus>({ proposal: "Waiting for review", accepted: "Accepted", dismissed: "Dismissed" });

export const verdictWord = words<Verdict>({ pass: "Pass", fail: "Fail", blocked: "Blocked", inconclusive: "Inconclusive" });

/* ---- glyphs: each QA state borrows a StatusIcon status (same shapes everywhere) ---- */
const glyph = <K extends string>(map: Record<K, string>) => (k: K | string | null | undefined): string =>
  (k && (map as Record<string, string>)[k]) || "unknown";

export const nodeStateGlyph = glyph<NodeState>({ seen: "completed", declared: "ready", blocked: "blocked" });
export const scenarioStatusGlyph = glyph<ScenarioStatus>({ draft: "pending", validated: "completed", paused: "paused", retired: "cancelled" });
export const sessionStatusGlyph = glyph<SessionStatus>({ running: "running", done: "completed", failed: "failed", cancelled: "cancelled", abandoned: "orphaned" });
export const missionStatusGlyph = glyph<MissionStatus>({ active: "in_progress", covered: "completed", partial: "needs_verification", blocked: "blocked", bug: "failed" });
export const walkStatusGlyph = glyph<WalkStatus>({ walking: "in_progress", passed: "completed", failed: "failed", unreachable: "blocked", abandoned: "cancelled" });
export const verdictGlyph = glyph<Verdict>({ pass: "completed", fail: "failed", blocked: "blocked", inconclusive: "pending" });
export const findingStatusGlyph = glyph<FindingStatus>({ open: "open", filed: "converted_to_task", dismissed: "closed" });

/** Chip dot tone for a finding's severity. */
export function severityTone(s: Severity | string | null | undefined): "danger" | "warn" | "neutral" {
  return s === "blocker" || s === "major" ? "danger" : s === "minor" ? "warn" : "neutral";
}

/** Chip dot tone for a criterion's evidence. */
export function evidenceTone(s: EvidenceStatus | string | null | undefined): "ok" | "warn" | "neutral" {
  return s === "verified" ? "ok" : s === "code_only" ? "neutral" : "warn";
}

/** Plain words for a web page event. */
export function webEventWord(e: { kind: string; status: number | null }): string {
  if (e.kind === "console") return "Console error";
  if (e.kind === "pageerror") return "Page error";
  if (e.kind === "requestfailed") return "Request failed";
  if (e.kind === "crash") return "Page crashed";
  if (e.kind === "response") return e.status === 404 ? "Page not found (404)" : `Server error${e.status ? ` (${e.status})` : ""}`;
  return "Event";
}

export function plural(n: number, one: string, many = one + "s"): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** "12 min" / "1 h 5 min" for a session's budget or run time. */
export function minutesWord(min: number | null | undefined): string {
  if (min == null || !Number.isFinite(min) || min <= 0) return "—";
  const m = Math.round(min);
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ""}`;
}

/** Minutes between two timestamps (null when either is missing). */
export function minutesBetween(a: string | null | undefined, b: string | null | undefined): number | null {
  if (!a || !b) return null;
  const d = (new Date(b).getTime() - new Date(a).getTime()) / 60000;
  return Number.isFinite(d) && d >= 0 ? d : null;
}

/** A screen key like "settings/profile" or "ProfileView" as a readable fallback label ("/" → "Home"). */
export function screenLabel(n: { label?: string | null; key: string }): string {
  if (n.label && n.label.trim()) return n.label.trim();
  if (n.key.startsWith("/")) {
    const segs = n.key.split(/[?#]/)[0].split("/").filter((x) => x && !/^[:[{]/.test(x));
    if (!segs.length) return "Home";
    const last = segs[segs.length - 1].replace(/[_-]+/g, " ");
    return last.charAt(0).toUpperCase() + last.slice(1);
  }
  const k = n.key.replace(/[_/.-]+/g, " ").replace(/([a-z])([A-Z])/g, "$1 $2").replace(/\s*(View|Screen|Activity|Fragment|Page)$/, "").trim();
  return k ? k.charAt(0).toUpperCase() + k.slice(1) : n.key;
}
