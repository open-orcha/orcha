/** Pure rules for QA requests: what is still open, the task's lines, the rounds of a step. */
import type { QaLineResult, QaRequest, QaRequestStatus, QaSettings } from "./api";

const OPEN: readonly QaRequestStatus[] = ["requested", "running"];

export const isOpenRequest = (r: Pick<QaRequest, "status">): boolean => OPEN.includes(r.status);

/** Newest first; a request without a time goes last. */
export function newestFirst(rows: readonly QaRequest[]): QaRequest[] {
  return [...rows].sort((a, b) => (b.created_at ?? "").localeCompare(a.created_at ?? ""));
}

/** A definition of done as lines to prove: list marks, checkboxes and blank lines dropped. */
export function dodLines(dod: string | null | undefined): string[] {
  return (dod ?? "")
    .split("\n")
    .map((l) => l.replace(/^\s*(?:[-*+•]|\d{1,3}[.)])\s+/, "").replace(/^\[[ xX]\]\s+/, "").trim())
    .filter((l) => l && !/^#{1,6}\s/.test(l));
}

/**
 * The project's QA agent: the one the settings name, else the only agent whose role says QA. Never
 * a guess among several.
 */
export function qaAgentOf<A extends { id: string; alias: string; role?: string | null }>(agents: readonly A[], settings: Pick<QaSettings, "agent_id"> | null | undefined): A | null {
  const named = settings?.agent_id ? agents.find((a) => a.id === settings.agent_id) : null;
  if (named) return named;
  const byRole = agents.filter((a) => /\bqa\b|quality/i.test(a.role ?? ""));
  return byRole.length === 1 ? byRole[0] : null;
}

/** Each acceptance line once, with its newest verdict across the requests (newest first). */
export function provedLines(rows: readonly QaRequest[]): (QaLineResult & { request: QaRequest })[] {
  const seen = new Map<string, QaLineResult & { request: QaRequest }>();
  for (const r of newestFirst(rows)) {
    for (const l of r.result?.lines ?? []) {
      const k = l.text.trim().toLowerCase();
      if (l.verdict && !seen.has(k)) seen.set(k, { ...l, request: r });
    }
  }
  return [...seen.values()].sort((a, b) => a.index - b.index);
}

/** The rounds of one step or task, first to last. */
export function roundsOf(rows: readonly QaRequest[]): QaRequest[] {
  return [...rows].sort((a, b) => a.round - b.round || (a.created_at ?? "").localeCompare(b.created_at ?? ""));
}

/** "2 of 3 lines passed". */
export function linesTally(r: Pick<QaRequest, "result">): string | null {
  const lines = r.result?.lines ?? [];
  if (!lines.length) return null;
  return `${lines.filter((l) => l.verdict === "pass").length} of ${lines.length} ${lines.length === 1 ? "line" : "lines"} passed`;
}
