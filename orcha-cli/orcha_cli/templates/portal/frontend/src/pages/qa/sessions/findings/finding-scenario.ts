/**
 * A draft scenario from a finding: the TypeScript side of `orcha.scenarios.finding_scenario`.
 * Both pass `db/finding-scenario-cases.json`, so the Create scenario button on a finding and Ask
 * Orcha's `propose_new_scenarios` draft the same scenario from the same finding.
 *
 * Never an empty draft: the name is the outcome to check, rewritten from the finding's title
 * (`outcomeName`,: "Future birth date accepted" names "A future birth date is refused"; the
 * title stays in the description and the link back), the criteria come from what was expected
 * (and what must no longer happen), quoted texts become checks, the steps to reproduce become the
 * starting steps. `findingSourceKey` names the finding once; the scenarios table keeps it unique
 * per project (migration 114), so one finding drafts one scenario. Pure.
 */
import type { TargetKind } from "../explorations";

type ScenarioSourceRef = FindingSource;

export interface FindingSource {
  kind: "finding" | "exploration_finding" | "next_step" | "issue" | "step";
  run_id?: string;
  seq?: number;
  /** The stored finding, when it is one: its one draft hangs off it. */
  finding_id?: string;
  step?: number | null;
  exploration_id?: string;
  fingerprint?: string;
  title?: string;
  issue_id?: string;
  frame?: string | null;
}

export interface FindingInput {
  title: string;
  expected?: string | null;
  actual?: string | null;
  note?: string | null;
  severity?: string | null;
  lens?: string | null;
  feature?: string | null;
  screen?: string | null;
  repro?: string[];
  platform?: string | null;
  source: FindingSource;
}

export interface FindingDraft {
  name: string;
  category: string;
  description: string;
  criteria: string[];
  checks: { criteria: Record<string, string[]>; scenario: string[] };
  tags: string[];
  target_kind: TargetKind | null;
  source_ref: ScenarioSourceRef & { fingerprint?: string };
  source_key: string;
}

const TARGET_KINDS = ["ios", "android", "web", "desktop"];
const MAX_NAME = 120;
const MAX_STEPS = 8;
const MAX_CHECKS = 3;
const MIN_QUOTE = 2;
const MAX_QUOTE = 80;
/** Words that join a sentence (`orcha.verdicts.named_checks.JOINERS`). */
const JOINERS = new Set(
  "a an and as at be but by for from in into is it its nor of on onto or so than that the then this to under via when where which while with without".split(" "),
);
/** Words a sentence runs on with before a quote (`named_checks._BEFORE_A_QUOTE`). */
const BEFORE_A_QUOTE = new Set(
  "a an the and or nor but with as than then that which while when where titled labelled labeled named called reading reads saying says showing shows marked".split(" "),
);
export const LENS_LABEL: Record<string, string> = {
  works: "Works right",
  looks: "Looks right",
  reads: "Reads right",
  fast: "Fast",
  safe: "Safe",
  accessible: "Accessible",
  resilient: "Resilient",
  a11y: "Accessible",
};

function clean(text: unknown, limit = 600): string {
  const s = String(text ?? "").split(/\s+/).filter(Boolean).join(" ").trim();
  return s.length <= limit ? s : s.slice(0, limit - 1).trimEnd() + "…";
}

function sentence(text: string): string {
  const t = clean(text).replace(/\.+$/, "");
  return t ? t[0].toUpperCase() + t.slice(1) : t;
}

function slug(text: unknown): string {
  return String(text ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

const isAlnum = (ch: string) => /[\p{L}\p{N}]/u.test(ch);
const isSpace = (ch: string) => /\s/.test(ch);

/** The double-quoted texts, each mark's side read from the characters around it: `“` opens, `”`
 * closes, a straight `"` opens after a space or punctuation and before a non-space, and closes
 * after a non-space and before a space, punctuation or the end. A one-character quote ("6") then
 * pairs like any other instead of shifting every later pair. Mirrors
 * `orcha.verdicts.named_checks.quote_spans`. */
export function quoteSpans(text: string): string[] {
  const s = text || "";
  const out: string[] = [];
  let start: number | null = null;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === "\n") {
      start = null;
      continue;
    }
    if (ch !== '"' && ch !== "“" && ch !== "”") continue;
    const before = i > 0 ? s[i - 1] : "";
    const after = i + 1 < s.length ? s[i + 1] : "";
    const opens = ch === "“" || (ch === '"' && !(before && isAlnum(before)) && after !== "" && !isSpace(after));
    const closes = ch === "”" || (ch === '"' && before !== "" && !isSpace(before) && !(after && isAlnum(after)));
    if (start !== null && closes) {
      out.push(s.slice(start + 1, i));
      start = null;
    } else if (opens) {
      start = i;
    }
  }
  return out;
}

/** Whether a quoted text reads as the sentence around the quotes, not a label (`named_checks.prose`). */
export function isProse(text: string): boolean {
  const t = (text || "").split(/\s+/).filter(Boolean).join(" ");
  const words = (t.match(/[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)?/gu) ?? []).map((w) => w.toLowerCase());
  // Without words it is prose only when empty or bare separators; symbols are labels ("+", "= ?").
  if (!words.length) return t.replace(/[\s,;:.]/g, "") === "";
  const first = t[0];
  if (first === first.toUpperCase()) return false;
  return JOINERS.has(words[0]) || BEFORE_A_QUOTE.has(words[words.length - 1]);
}

function quotes(text: string): string[] {
  const out: string[] = [];
  for (const inner of quoteSpans(text)) {
    const q = inner.trim();
    if (q.length >= MIN_QUOTE && q.length <= MAX_QUOTE && /[A-Za-z0-9]/.test(q) && !isProse(q) && !out.includes(q)) out.push(q);
  }
  return out.slice(0, MAX_CHECKS);
}

// ---------- the name: the outcome to check, not the bug ----------

const DETERMINERS = new Set("a an the this that these those my your our its their every each any some no".split(" "));
/** Words that make an expected outcome a sentence ("Get Started advances to the tour"), not a fragment. */
const OUTCOME_VERBS = new Set(
  (
    "is are stays stay shows show opens open returns return reads read keeps keep advances advance appears appear " +
    "lists saves save refuses refuse rejects reject fills fill follows follow leads moves gives give " +
    "says say clears clear counts matches match holds hold agrees agree works loads goes go lands land " +
    "offers asks ask explains explain warns warn tells tell blocks limits accepts accept " +
    "shown visible present exposed ticked selected"
  ).split(" "),
);
/** Words ending in -ed that describe, not happen ("Error for required Name and Email"). */
const NOT_PARTICIPLES = new Set("required expected unexpected detailed limited needed".split(" "));
const NOT_AN_OUTCOME_START = new Set("usually median p90 limit or e.g. eg".split(" "));
/** A subject that is itself negated ("Cards do not open and") is not what the title is about. */
const NEGATION = /\b(?:not|never|cannot|can't|doesn't|don't|didn't|isn't|aren't|won't)\b/i;
/** A finding filed for a failed criterion: "Not met: <criterion>", "<scenario>: <criterion>". */
const CRITERION_PREFIX = /^(?:not met|check failed|failed):\s*/i;
/** Words that only colour the bug ("still shows", "silently does nothing"). */
const FILLER = /\b(?:still|silently)\s+/gi;
/** Where a bug title's first clause ends: "...accepted; Days Tracked shows -1", "...not saved, so it...". */
const CLAUSE_END = /;|,\s*(?:so|which)\b/i;
const AFTER = String.raw`( (?:on|in|from|at|for|when|after|before|under|inside|within|while|during|until|with)\b.*| \(.*)?`;

type Shape =
  | "accepted" | "accepts" | "refused" | "has_no" | "not_shown" | "missing" | "truncated" | "nothing" | "crash" | "instead" | "not_this"
  | "lost" | "exceeds" | "cannot" | "fails_to" | "does_not" | "is_not" | "shows_no" | "shows";

/** (pattern, shape) in order; group 1 is the subject (`finding_scenario._RULES`). */
const RULES: ReadonlyArray<[RegExp, Shape]> = [
  [/^(.+?) (?:(is|are|was|were|gets|get|got) )?accepted$/i, "accepted"],
  [/^(.+?) (?:accepts|allows|permits) (.+)$/i, "accepts"],
  // "declined for a valid phone number", never "rejected with Invalid password" (the reason, not the case).
  [/^(.+?) (?:(is|are|was|were|gets|get) )?(?:declined|rejected|refused)( (?:for|on|in|at|from|when|after|before|while|during|under)\b.*| \(.*)?$/i, "refused"],
  [/^(.+?) (has|have) no (.+)$/i, "has_no"],
  [new RegExp(String.raw`^(.+?) (?:(is|are) )?(?:not shown|not visible|not displayed|not found|never shown|missing|absent)` + AFTER + "$", "i"), "not_shown"],
  [/^(.+?) (?:is |are )?missing (.+)$/i, "missing"],
  [/^(.+?) (?:(is|are|gets|get) )?(?:truncated|cut off|clipped)(?: .+)?$/i, "truncated"],
  [/^(.+?) (?:does nothing|do nothing|did nothing|ignores taps|is not tappable|does not respond|doesn't respond)( .+)?$/i, "nothing"],
  [/^(.+?) (?:crashes|crashed)( .+)?$/i, "crash"],
  [/^(.+?) (shows|displays|reads|says) (.+?) instead of (.+)$/i, "instead"],
  [/^(.+?) (shows|displays|reads|says) (.+?), not (.+?)(?:, (.+))?$/i, "not_this"],
  [/^(.+?) (?:(is|are|was|were|gets|get) )?(?:lost|cleared|discarded|wiped|erased)( .+)?$/i, "lost"],
  [/^(.+?) (?:exceeds|goes above|goes over|goes past|goes beyond) (.+)$/i, "exceeds"],
  [/^(.+?) (?:cannot|can't|can not) (.+)$/i, "cannot"],
  [/^(.+?) (?:fails|failed) to ([A-Za-z]+)( .+)?$/i, "fails_to"],
  [/^(.+?) (does not|doesn't|did not|didn't|do not|don't|never) ([A-Za-z]+)( .+)?$/i, "does_not"],
  [/^(.+?) (?:(is|are|was|were) )?not (a|an|the|[A-Za-z]+ed|[A-Za-z]+able)( .+)?$/i, "is_not"],
  [/^(.+?) (shows|displays) no (.+)$/i, "shows_no"],
  [/^(.+?) (shows|displays) (.+)$/i, "shows"],
];

const words = (text: string) => text.split(/\s+/).filter(Boolean);

function plural(subject: string): boolean {
  const w = words(subject);
  const last = (w[w.length - 1] ?? "").toLowerCase();
  return last.length > 3 && last.endsWith("s") && !["ss", "us", "is"].some((e) => last.endsWith(e));
}

function be(verb: string, subject: string): string {
  const v = verb.toLowerCase();
  if (["is", "are", "was", "were"].includes(v)) return v === "are" || v === "were" ? "are" : "is";
  return plural(subject) ? "are" : "is";
}

function thirdPerson(verb: string): string {
  const v = verb.toLowerCase();
  const irregular: Record<string, string> = { be: "is", have: "has", do: "does" };
  if (irregular[v]) return irregular[v];
  if (v.length > 1 && v.endsWith("y") && !"aeiou".includes(v[v.length - 2])) return verb.slice(0, -1) + "ies";
  if (["s", "sh", "ch", "x", "z", "o"].some((e) => v.endsWith(e))) return verb + "es";
  return verb + "s";
}

/** `a ` or `an ` before a singular noun phrase with no determiner, else ``. */
function article(phrase: string): string {
  const w = words(phrase);
  if (!w.length || DETERMINERS.has(w[0].toLowerCase()) || plural(phrase)) return "";
  const first = w[0][0];
  if ("\"“'".includes(first)) return "a ";
  if (!/\p{L}/u.test(first)) return "";
  return "aeiou".includes(first.toLowerCase()) ? "an " : "a ";
}

/** "Future birth date" -> "a future birth date"; an acronym ("MB WAY payment") stays as written. */
function withArticle(subject: string): string {
  const art = article(subject);
  const first = words(subject)[0] ?? "";
  if (!art || (first.length > 1 && first === first.toUpperCase() && first !== first.toLowerCase())) return subject;
  return art + subject.slice(0, 1).toLowerCase() + subject.slice(1);
}

function readsAsOutcome(text: string, maxWords = 14): boolean {
  const ws = text.match(/[A-Za-z][A-Za-z'-]*/g) ?? [];
  const n = words(text).length;
  const head = ws[0];
  if (n < 3 || n > maxWords || head === undefined || NOT_AN_OUTCOME_START.has(head.toLowerCase())) return false;
  return ws.some((w) => {
    const l = w.toLowerCase();
    return OUTCOME_VERBS.has(l) || (l.length > 4 && l.endsWith("ed") && !NOT_PARTICIPLES.has(l));
  });
}

function outcomeExpected(expected: string): string | null {
  const text = clean(expected).replace(/\s*\[(?:warning|critical)\]\s*$/i, "").replace(/\.+$/, "");
  return text.length <= 100 && readsAsOutcome(text) ? text : null;
}

function shaped(clause: string, good: string | null): string | null {
  for (const [pattern, shape] of RULES) {
    const m = pattern.exec(clause);
    if (!m || NEGATION.test(m[1])) continue;
    const g = Array.from(m, (x) => x ?? "");
    const s = g[1];
    switch (shape) {
      case "accepted":
        return `${withArticle(s)} ${be(g[2], s)} refused`;
      case "accepts":
        return `${s} refuses ${g[2]}`;
      case "refused":
        return `${s} ${be(g[2], s)} accepted${g[3]}`;
      case "has_no":
        return `${s} ${g[2]} ${article(g[3])}${g[3]}`;
      case "not_shown":
        return `${s} ${be(g[2], s)} shown${g[3].replace(/^ from /i, " on ")}`;
      case "missing":
        return `${s} shows ${g[2]}`;
      case "truncated":
        return `${s} ${be(g[2], s)} kept in full`;
      case "nothing":
        return good ?? `${s} responds${g[2]}`;
      case "crash":
        return `${s} does not crash${g[2]}`;
      case "instead":
        return `${s} ${g[2]} ${g[4]}`;
      case "not_this":
        return `${s} ${g[2]} ${g[4]}` + (g[5] ? ` ${g[5]}` : "");
      case "lost":
        return `${s} ${be(g[2], s)} kept${g[3]}`;
      case "exceeds":
        return `${s} stays within ${g[2]}`;
      case "cannot":
        return `${s} can ${g[2]}`;
      case "fails_to":
        return `${s} ${thirdPerson(g[2])}${g[3]}`;
      case "does_not": {
        const verb = ["do not", "don't", "never"].includes(g[2].toLowerCase()) ? g[3] : thirdPerson(g[3]);
        return `${s} ${verb}${g[4]}`;
      }
      case "is_not":
        return `${s} ${be(g[2], s)} ${g[3]}${g[4]}`;
      case "shows_no":
        return `${s} ${g[2]} ${g[3]}`;
      case "shows":
        return `${s} does not ${g[2].toLowerCase() === "shows" ? "show" : "display"} ${g[3]}`;
    }
  }
  return null;
}

function finish(name: string): string {
  const n = clean(name, MAX_NAME).replace(/\.+$/, "");
  return n.slice(0, 1).toUpperCase() + n.slice(1);
}

/**
 * The draft's name: the outcome a regression scenario checks, not the bug it found.
 * "Future birth date accepted; Days Tracked shows -1" names "A future birth date is refused".
 * A cheap, deterministic rewrite, no model: a finding filed for a failed criterion is named by
 * the criterion; any other title's first clause by the first bug-title shape it fits (`RULES`);
 * else what was expected when it reads as an outcome, else "<title> no longer happens".
 * Mirrors `orcha.scenarios.finding_scenario.outcome_name`.
 */
export function outcomeName(title: string, expected?: string | null): string {
  const text = clean(title).replace(/\.+$/, "");
  const criterion = text.replace(CRITERION_PREFIX, "");
  if (criterion !== text && readsAsOutcome(criterion, 40)) return finish(criterion);
  const at = text.indexOf(": ");
  if (at >= 0) {
    const head = text.slice(0, at);
    const tail = text.slice(at + 2);
    if (words(head).length >= 4 && /^["“A-Z]/.test(tail) && readsAsOutcome(tail, 40)) return finish(tail);
  }
  const clause = text.split(CLAUSE_END)[0].replace(FILLER, "").trim().replace(/\.+$/, "");
  const good = outcomeExpected(expected ?? "");
  return finish(shaped(clause, good) ?? good ?? `${sentence(clause)} no longer happens`);
}

export function findingSourceKey(source: FindingSource): string {
  const s = source;
  if (s.kind === "finding" && s.run_id && s.seq != null) return `finding:${s.run_id}:${Math.trunc(s.seq)}`;
  if (s.kind === "exploration_finding" && s.exploration_id && s.fingerprint) return `exploration_finding:${s.exploration_id}:${s.fingerprint}`;
  if (s.kind === "next_step" && s.exploration_id && s.title) return `next_step:${s.exploration_id}:${slug(s.title)}`;
  if (s.kind === "issue" && s.issue_id) return `issue:${s.issue_id}`;
  if (s.kind === "step" && s.run_id && s.step != null) return `step:${s.run_id}:${Math.trunc(s.step)}`;
  throw new Error("A source is a finding (run_id, seq), an exploration finding (exploration_id, fingerprint), a next step, an issue or a run step.");
}

/** The draft for `finding`; throws when it has no title. Mirrors `orcha.scenarios.finding_scenario.draft`. */
export function draftFromFinding(finding: FindingInput): FindingDraft {
  const title = clean(finding.title, MAX_NAME).replace(/\.+$/, "");
  if (!title) throw new Error("The finding has no title.");
  const expected = clean(finding.expected);
  const actual = clean(finding.actual);
  const note = clean(finding.note);
  const lens = String(finding.lens ?? "").trim().toLowerCase();
  const feature = clean(finding.feature, 60);
  const screen = clean(finding.screen, 80);
  const criteria: string[] = [];
  const checks: Record<string, string[]> = {};
  if (expected) {
    criteria.push(sentence(expected));
    const good = quotes(expected).map((q) => `text "${q}"`);
    if (good.length) checks["0"] = good;
  } else {
    criteria.push(`${sentence(title)} no longer happens`);
  }
  const seen = actual || note;
  if (seen) {
    criteria.push(`It no longer shows: ${seen.replace(/\.+$/, "")}`);
    const expectedQuotes = quotes(expected);
    const bad = quotes(seen)
      .filter((q) => !expectedQuotes.includes(q))
      .map((q) => `text "${q}" absent`);
    if (bad.length) checks[String(criteria.length - 1)] = bad;
  }
  const repro = (finding.repro ?? []).map((s) => clean(s, 200)).filter(Boolean).slice(0, MAX_STEPS);
  const where = screen ? ` on ${screen}` : "";
  const severity = String(finding.severity ?? "").trim().toLowerCase();
  const lines = [`Regression scenario for a ${severity ? severity + " " : ""}finding${where}: ${title}.`];
  if (repro.length) {
    lines.push("Starting steps:");
    repro.forEach((s, i) => lines.push(`${i + 1}. ${s}`));
  }
  const tags: string[] = [];
  for (const t of ["regression", lens ? slug(lens) : "", feature ? slug(feature) : ""]) if (t && !tags.includes(t)) tags.push(t);
  const platform = String(finding.platform ?? "").toLowerCase();
  const src = finding.source;
  const ref: Record<string, unknown> = {};
  for (const k of ["kind", "run_id", "seq", "step", "exploration_id", "fingerprint", "issue_id", "frame"] as const) {
    const v = src[k as keyof FindingSource];
    if (v !== undefined && v !== null && v !== "") ref[k] = v;
  }
  const sev = severity ? severity[0].toUpperCase() + severity.slice(1) + " " : "";
  ref.label = clean(`${sev}finding: ${title}`, 140);
  return {
    name: outcomeName(String(finding.title ?? ""), expected),
    category: LENS_LABEL[lens] ?? (feature ? feature.replace(/\b\w/g, (c) => c.toUpperCase()) : "Regression"),
    description: lines.join("\n"),
    criteria,
    checks: { criteria: checks, scenario: [] },
    tags,
    target_kind: TARGET_KINDS.includes(platform) ? (platform as TargetKind) : null,
    source_ref: ref as unknown as FindingDraft["source_ref"],
    source_key: findingSourceKey(src),
  };
}
