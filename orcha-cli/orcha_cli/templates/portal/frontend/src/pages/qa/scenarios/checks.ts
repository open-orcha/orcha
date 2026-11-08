/**
 * `Check:` line grammar, mirrored from `orcha_cli/qa/checks.py` so the site can validate and
 * normalise a check before saving it. Evaluation happens only in the harness; this file never
 * matches anything against a screen.
 *
 *   check   = subject [matcher] ["within" N "s"] ["[warning]"]
 *   matcher = visible | appears (a transient state, watched for its window) | absent | ...
 *   subject = text PAT | ROLE PAT | id=IDENT | url | title | count ROLE [PAT] | screen
 *   PAT     = "exact" | ~"substring" | /regex/flags
 */

import { parseDeltaCheck } from "./delta-checks";
import { looksLikeSaved, parseSavedCheck } from "./saved-checks";

export const ROLE_WORDS = [
  "Button", "Cell", "Dialog", "Heading", "Image", "Key", "Link", "MenuItem", "Picker", "PickerWheel",
  "Radio", "SearchField", "SecureTextField", "SegmentedControl", "Slider", "StaticText", "Stepper",
  "Switch", "Tab", "TabBar", "TextField", "TextView", "Toggle",
] as const;

const ROLE_SET = new Set<string>(ROLE_WORDS);
const ELEMENT_MATCHERS = new Set([
  "visible", "appears", "absent", "enabled", "disabled", "checked", "unchecked", "selected", "focused",
  "value", "contains", "matches", "equals",
]);
const COUNT_OPS = new Set(["==", ">=", "<="]);
const MAX_TIMEOUT_S = 60;

interface Pat {
  kind: "exact" | "contains" | "regex";
  text: string;
  flags: string;
}

function renderPat(p: Pat): string {
  if (p.kind === "regex") return `/${p.text}/${p.flags}`;
  if (p.kind === "contains") return `~"${p.text}"`;
  return `"${p.text}"`;
}

function tokens(text: string): string[] {
  const out: string[] = [];
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (c === '"' || (c === "~" && text[i + 1] === '"')) {
      const start = i;
      i += c === "~" ? 2 : 1;
      while (i < n && text[i] !== '"') i += text[i] === "\\" ? 2 : 1;
      i++;
      out.push(text.slice(start, i));
      continue;
    }
    if (c === "/") {
      const start = i;
      i++;
      while (i < n && text[i] !== "/") i += text[i] === "\\" ? 2 : 1;
      i++;
      while (i < n && /[a-z]/i.test(text[i])) i++;
      out.push(text.slice(start, i));
      continue;
    }
    if (c === "[") {
      let j = text.indexOf("]", i);
      if (j === -1) j = n - 1;
      out.push(text.slice(i, j + 1));
      i = j + 1;
      continue;
    }
    const start = i;
    while (i < n && !/\s/.test(text[i])) i++;
    out.push(text.slice(start, i));
  }
  return out;
}

function pat(tok: string | undefined): Pat | null {
  if (!tok) return null;
  if (tok.startsWith('~"') && tok.endsWith('"') && tok.length >= 3) return { kind: "contains", text: tok.slice(2, -1), flags: "" };
  if (tok.startsWith('"') && tok.endsWith('"') && tok.length >= 2) return { kind: "exact", text: tok.slice(1, -1), flags: "" };
  const m = /^\/([\s\S]*)\/([a-z]*)$/.exec(tok);
  if (m) return { kind: "regex", text: m[1], flags: m[2] };
  return null;
}

export type CheckParse = { ok: true; normalised: string } | { ok: false; error: string };

/** Parse one check line (the `Check:` prefix is optional) into its normalised form. */
export function parseCheck(line: string): CheckParse {
  const raw = line.replace(/^\s*check:\s*/i, "").trim();
  // Delta checks (`api …`/`query … increases by N`, #191) have their own grammar.
  const delta = parseDeltaCheck(raw);
  if (delta) return delta;
  // `Saved:` read-backs (`saved …`, #266) are stored among the checks and have their own grammar.
  if (looksLikeSaved(line)) return parseSavedCheck(line);
  let toks = tokens(raw);
  const problems: string[] = [];
  let warning = false;
  let timeout: number | null = null;
  if (toks.length && toks[toks.length - 1].toLowerCase() === "[warning]") {
    warning = true;
    toks = toks.slice(0, -1);
  }
  if (toks.length >= 2 && toks[toks.length - 2].toLowerCase() === "within") {
    const m = /^(\d+(?:\.\d+)?)s$/i.exec(toks[toks.length - 1]);
    if (m) timeout = Math.min(Number(m[1]), MAX_TIMEOUT_S);
    else problems.push(`within needs a number of seconds like 10s, got ${toks[toks.length - 1]}`);
    toks = toks.slice(0, -2);
  }
  if (!toks.length) return { ok: false, error: "empty check" };
  const [head, ...restIn] = toks;
  let rest = restIn;
  const parts: string[] = [];
  let subject = "";
  if (head === "text") {
    subject = "text";
    const p = pat(rest[0]);
    if (!p) problems.push('text needs a quoted string, ~"substring" or /regex/');
    else parts.push("text", renderPat(p));
    rest = rest.slice(1);
  } else if (head.startsWith("id=")) {
    subject = "id";
    if (head.length <= 3) problems.push("id= needs an identifier");
    parts.push(head);
  } else if (head === "url" || head === "title" || head === "screen") {
    subject = head;
    parts.push(head);
  } else if (head === "count") {
    subject = "count";
    const role = rest[0];
    if (!role || !ROLE_SET.has(role)) problems.push(`count needs a role word (${ROLE_WORDS.join(", ")})`);
    parts.push("count", role ?? "");
    rest = rest.slice(1);
    const p = pat(rest[0]);
    if (p) {
      parts.push(renderPat(p));
      rest = rest.slice(1);
    }
  } else if (ROLE_SET.has(head)) {
    subject = "role";
    const p = pat(rest[0]);
    if (!p) problems.push(`${head} needs a label: a quoted string, ~"substring" or /regex/`);
    else parts.push(head, renderPat(p));
    rest = rest.slice(1);
  } else {
    problems.push(`unknown subject ${head}: use text, id=, url, title, count, screen or a role (${ROLE_WORDS.join(", ")})`);
  }
  let matcher = "visible";
  if (rest.length) {
    const word = rest[0];
    if (COUNT_OPS.has(word)) {
      matcher = word;
      if (!/^\d+$/.test(rest[1] ?? "")) problems.push(`${word} needs a whole number`);
      else parts.push(word, rest[1]);
      rest = rest.slice(2);
    } else if (word === "value" || word === "contains" || word === "matches" || word === "equals") {
      matcher = word;
      const p = pat(rest[1]);
      if (!p || (word === "matches" && p.kind !== "regex")) {
        problems.push(`${word} needs ${word === "matches" ? "a /regex/" : "a quoted string, ~substring or /regex/"}`);
      } else parts.push(word, renderPat(p));
      rest = rest.slice(2);
    } else {
      matcher = word;
      if (word !== "visible" || subject === "screen") parts.push(word);
      rest = rest.slice(1);
    }
  }
  if (rest.length) problems.push(`unexpected text after the matcher: ${rest.join(" ")}`);
  if (!problems.length) {
    if (subject === "count" && !COUNT_OPS.has(matcher)) problems.push("count needs ==, >= or <= and a number");
    else if (subject !== "count" && COUNT_OPS.has(matcher)) problems.push(`${matcher} only applies to count`);
    else if (subject === "screen" && matcher !== "unchanged" && matcher !== "changed") problems.push("screen needs unchanged or changed");
    else if ((subject === "url" || subject === "title") && !["contains", "matches", "equals"].includes(matcher)) {
      problems.push(`${subject} needs contains, matches or equals`);
    } else if ((subject === "text" || subject === "role" || subject === "id") && !ELEMENT_MATCHERS.has(matcher)) {
      problems.push(`unknown matcher ${matcher}`);
    }
  }
  if (problems.length) return { ok: false, error: problems.join("; ") };
  if (timeout !== null) parts.push(`within ${Number.isInteger(timeout) ? timeout : timeout}s`);
  if (warning) parts.push("[warning]");
  return { ok: true, normalised: parts.filter(Boolean).join(" ") };
}

export interface ScenarioChecks {
  criteria: Record<string, string[]>;
  scenario: string[];
}

/** A normalised element line's subject, label (lower-cased, spaces collapsed) and matcher. */
function labelOf(line: string): { subject: string; key: string; matcher: string } | null {
  const toks = tokens(line);
  if (toks.length < 2 || !(toks[0] === "text" || ROLE_SET.has(toks[0]))) return null;
  const p = pat(toks[1]);
  if (!p || p.kind === "regex") return null;
  const matcher = toks[2] && ELEMENT_MATCHERS.has(toks[2]) ? toks[2] : "visible";
  return { subject: toks[0], key: p.text.replace(/\s+/g, " ").trim().toLowerCase(), matcher };
}

/**
 * Pairs of one criterion's lines that can never hold together (mirrors `checks.contradictions`,
 * #226): a label checked as shown and the same label checked `absent`. `appears` with `absent` is
 * a state that shows, then goes: not a contradiction.
 */
export function contradictions(lines: readonly string[]): Array<[string, string]> {
  const parsed = lines.map((l) => ({ line: l, at: labelOf(l) }));
  const out: Array<[string, string]> = [];
  for (const a of parsed) {
    if (!a.at || a.at.matcher === "absent" || a.at.matcher === "appears") continue;
    for (const b of parsed) {
      if (!b.at || b.at.matcher !== "absent" || b.at.key !== a.at.key) continue;
      // Gone as text is gone under every role; gone as a Button says nothing of a text.
      if (b.at.subject === "text" || (a.at.subject !== "text" && a.at.subject === b.at.subject)) out.push([a.line, b.line]);
    }
  }
  return out;
}

export type ChecksValidation = { ok: true; checks: ScenarioChecks } | { ok: false; error: string };

/**
 * Validate a `scenarios.checks` payload; every line must parse. A save (`strict`, the default) also
 * refuses a criterion that checks a label both shown and `absent` (#226); reading a stored row
 * (`parseScenarioChecks`) keeps them, so the editor can show what to fix.
 */
export function validateChecks(value: unknown, { strict = true }: { strict?: boolean } = {}): ChecksValidation {
  if (value === null || value === undefined) return { ok: true, checks: { criteria: {}, scenario: [] } };
  if (typeof value !== "object" || Array.isArray(value)) return { ok: false, error: "checks must be an object" };
  const v = value as Record<string, unknown>;
  const out: ScenarioChecks = { criteria: {}, scenario: [] };
  const crit = v.criteria ?? {};
  if (typeof crit !== "object" || crit === null || Array.isArray(crit)) return { ok: false, error: "checks.criteria must be an object" };
  for (const [key, lines] of Object.entries(crit as Record<string, unknown>)) {
    if (!/^\d+$/.test(key)) return { ok: false, error: `criteria keys are 0-based indexes, got ${key}` };
    if (!Array.isArray(lines) || !lines.every((l) => typeof l === "string")) {
      return { ok: false, error: "each criterion's checks must be a list of strings" };
    }
    const good: string[] = [];
    for (const l of lines as string[]) {
      if (!l.trim()) continue;
      const r = parseCheck(l);
      if (!r.ok) return { ok: false, error: `criterion ${Number(key) + 1}: ${r.error}` };
      good.push(r.normalised);
    }
    const both = strict ? contradictions(good) : [];
    if (both.length) {
      return { ok: false, error: `criterion ${Number(key) + 1}: ${both[0][0]} and ${both[0][1]} can never both hold; keep one` };
    }
    if (good.length) out.criteria[String(Number(key))] = good;
  }
  const scen = v.scenario ?? [];
  if (!Array.isArray(scen)) return { ok: false, error: "checks.scenario must be a list" };
  for (const l of scen) {
    if (typeof l !== "string" || !l.trim()) continue;
    const r = parseCheck(l);
    if (!r.ok) return { ok: false, error: `scenario: ${r.error}` };
    out.scenario.push(r.normalised);
  }
  return { ok: true, checks: out };
}

export function parseScenarioChecks(json: unknown): ScenarioChecks {
  const v = typeof json === "string" ? (() => { try { return JSON.parse(json) as unknown; } catch { return null; } })() : json;
  const r = validateChecks(v, { strict: false });
  return r.ok ? r.checks : { criteria: {}, scenario: [] };
}
