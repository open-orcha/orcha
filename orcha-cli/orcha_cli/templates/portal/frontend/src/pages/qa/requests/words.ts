/** Plain words for QA requests and settings: never a raw enum on screen. */
import type { Platform, QaRequestKind } from "../qaApi";
import { platformWord } from "../qaWords";
import type { QaAutoTriage, QaOnFail, QaRequest, QaRequestStatus, QaTrigger } from "./api";

const word = <K extends string>(map: Record<K, string>, k: K | string | null | undefined): string =>
  (k && (map as Record<string, string>)[k]) || (k ? String(k).replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase()) : "—");

export const REQUEST_STATUS: Record<QaRequestStatus, string> = {
  requested: "Waiting", running: "Running", passed: "Passed", failed: "Failed", blocked: "Blocked", cancelled: "Cancelled",
};
/** A triage that confirms a bug did its job: it never reads as failed. */
const TRIAGE_STATUS: Record<string, string> = { failed: "Bug confirmed", passed: "Nothing to fix" };

export const requestStatusWord = (s: string | null | undefined, kind?: string | null) =>
  (kind === "triage" && s && TRIAGE_STATUS[s]) || word(REQUEST_STATUS, s);

export function requestStatusGlyph(s: string | null | undefined): string {
  return ({ requested: "pending", running: "in_progress", passed: "completed", failed: "failed", blocked: "blocked", cancelled: "cancelled" } as Record<string, string>)[s ?? ""] ?? "unknown";
}

/** Chip dot tone for a request's status. */
export function requestTone(s: string | null | undefined): "ok" | "danger" | "warn" | "neutral" {
  return s === "passed" ? "ok" : s === "failed" ? "danger" : s === "blocked" || s === "running" ? "warn" : "neutral";
}

const KIND: Record<QaRequestKind, string> = { map: "Map the app", explore: "Explore", draft: "Draft scenarios", check: "Check scenarios", triage: "Triage" };
export const requestKindWord = (k: string | null | undefined) => word(KIND, k);

/** A request as a line of text: its focus, else what it asked for. */
export function requestTitle(r: Pick<QaRequest, "focus" | "kind" | "platform">): string {
  if (r.focus?.trim()) return r.focus.trim();
  const app = r.platform ? ` on ${platformWord(r.platform as Platform)}` : "";
  return `${requestKindWord(r.kind)}${app}`;
}

const ORIGIN: Record<string, string> = { handoff: "Sent to QA", trigger: "A finished task", workflow: "A workflow step", reopen: "A fix round", recheck: "A fixed finding", auto_triage: "A failed run" };
export const requestOriginWord = (o: string | null | undefined) => word(ORIGIN, o);

export const ON_FAIL: { key: QaOnFail; label: string; hint: string }[] = [
  { key: "report", label: "Report back", hint: "The result comes back to the task. Nothing else changes." },
  { key: "reopen", label: "Send the task back", hint: "The task goes back to its agent with the findings, and QA runs again when it returns." },
];
export const onFailWord = (k: string | null | undefined) => ON_FAIL.find((o) => o.key === k)?.label ?? "Report back";

export const TRIGGERS: { key: QaTrigger; label: string; hint: string }[] = [
  { key: "manual", label: "When asked", hint: "QA runs when a person or an agent sends work to it." },
  { key: "ui_changes", label: "UI changes", hint: "A finished task that changed screens goes to QA by itself." },
  { key: "always", label: "Every task", hint: "Every finished task goes to QA by itself." },
];

export const AUTO_TRIAGE: { key: QaAutoTriage; label: string; hint: string }[] = [
  { key: "off", label: "Off", hint: "Each run holds a device and spends model time, so a person starts it." },
  { key: "critical", label: "Blockers and majors", hint: "A failed run's blocker and major findings are triaged by themselves." },
  { key: "all", label: "Every finding", hint: "Every finding of a failed run is triaged by itself." },
];

export const roundWord = (round: number, max?: number | null) => (max ? `Round ${round} of ${max}` : `Round ${round}`);
