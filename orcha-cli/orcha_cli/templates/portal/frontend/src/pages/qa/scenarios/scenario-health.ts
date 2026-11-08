/**
 * The suspicious-scenario rule (#188), ported from `orcha.scenarios.scenario_health.suspicious_reasons`
 * so Home can leave agent tasks out of "Needs you" without spawning Python. Both are asserted
 * against `db/scenario-health-cases.json`; change them together.
 *
 * A scenario is suspicious when it reads like an agent task rather than a user outcome: a task
 * id or hash in its name ("Orcha 3c96e42c ·", "JIRA-1423"), work-order prose ("open a PR",
 * "do not merge", a name that starts with "Fix"), or criteria that are instructions ("Write unit
 * tests for the board"). Pure; no React, no database.
 */

export type SuspiciousCode = "task_id" | "work_order" | "instructions";

export interface SuspiciousReason {
  code: SuspiciousCode;
  matched: string[];
}

const TASK_PREFIX_RE = /^\s*([A-Za-z][\w.-]{1,24})\s+([0-9a-f]{6,40})\s*[·•:|–—-]/i;
const HASH_RE = /(?<![\w-])(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,40}(?![\w-])/i;
const TICKET_RE = /(?<![\w-])[A-Z][A-Z0-9]{1,9}-\d{1,6}(?![\w-])/;

const WORK_ORDER_PHRASES = [
  "open a pr", "open the pr", "open pr", "open a pull request", "pull request", "do not merge",
  "don't merge", "dont merge", "local branch", "feature branch", "new branch", "push to",
  "push the branch", "and push", "commit the", "commit and", "commit your", "qa issues",
  "merge the pr", "merge to main", "merge into main", "against main", "code review",
  "unit tests", "the codebase",
];
const WORK_ORDER_VERBS = ["fix", "fixes", "refactor", "implement", "investigate", "rework", "cleanup", "clean up", "wire up"];
const INSTRUCTION_VERBS = ["implement", "refactor", "fix", "write", "add", "create", "update", "build", "open", "run", "commit", "push", "merge", "deploy", "rename", "remove", "delete", "install", "wire"];
const DEV_NOUNS_RE =
  /\b(component|components|endpoint|endpoints|unit tests?|e2e tests?|tests|test suite|the code|codebase|repo|repository|pull request|pr|commit|lint|linter|ci)\b/i;

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const PHRASE_RES = WORK_ORDER_PHRASES.map((p) => [p, new RegExp(`(?<![a-z])${escapeRe(p)}(?![a-z])`)] as const);

function phraseHits(text: string): string[] {
  const low = ` ${text.toLowerCase().replace(/\s+/g, " ")} `;
  return PHRASE_RES.filter(([, re]) => re.test(low)).map(([p]) => p);
}

function startsWith(text: string, words: readonly string[]): string | null {
  const low = text.toLowerCase().replace(/^[ \-*•(]+/, "");
  return words.find((w) => low === w || low.startsWith(`${w} `)) ?? null;
}

function criterionText(c: unknown): string {
  if (typeof c === "string") return c;
  if (c && typeof c === "object") {
    const o = c as Record<string, unknown>;
    return String(o.text ?? o.criterion ?? "");
  }
  return String(c ?? "");
}

/** A criterion that tells someone what to do to the code, not what the app should show. */
export function isInstruction(criterion: string): boolean {
  const text = (criterion ?? "").trim();
  if (!text) return false;
  if (phraseHits(text).length > 0) return true;
  return Boolean(startsWith(text, INSTRUCTION_VERBS) && DEV_NOUNS_RE.test(text));
}

/** Why a scenario looks like an agent task (`task_id`, `work_order`, `instructions`), or []. */
export function suspiciousReasons(name: string | null | undefined, description?: string | null, criteria?: readonly unknown[] | null): SuspiciousReason[] {
  const n = name ?? "";
  const out: SuspiciousReason[] = [];
  const m = TASK_PREFIX_RE.exec(n);
  let task = m && /\d/.test(m[2]) ? `${m[1]} ${m[2]}` : null;
  if (!task) task = (HASH_RE.exec(n) ?? TICKET_RE.exec(n))?.[0] ?? null;
  if (task) out.push({ code: "task_id", matched: [task] });
  const words = [...phraseHits(n), ...phraseHits(description ?? "")];
  for (const seg of n.split(/[·•:|–—]/).map((s) => s.trim()).filter(Boolean)) {
    const verb = startsWith(seg, WORK_ORDER_VERBS);
    if (verb) words.push(verb);
  }
  if (words.length > 0) out.push({ code: "work_order", matched: [...new Set(words)] });
  const instructions = (criteria ?? []).map(criterionText).filter(isInstruction);
  if (instructions.length > 0) out.push({ code: "instructions", matched: instructions.slice(0, 3) });
  return out;
}

export function isSuspicious(s: { name: string | null; description?: string | null; criteria?: unknown }): boolean {
  let criteria: unknown = s.criteria;
  if (typeof criteria === "string") {
    try {
      criteria = JSON.parse(criteria);
    } catch {
      criteria = [];
    }
  }
  return suspiciousReasons(s.name, s.description ?? null, Array.isArray(criteria) ? criteria : []).length > 0;
}
