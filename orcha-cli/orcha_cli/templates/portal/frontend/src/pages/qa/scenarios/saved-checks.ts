/**
 * `Saved:` read-backs: what the record a criterion creates or
 * edits must hold, read back from the API, the database, the app's own screen or the device
 * storage, so a save that stores the wrong thing fails even when the screen looks right.
 *
 *   saved POST /api/events -> {"type": "feeding", "side": "left", "amount_oz": null}
 *   saved record "Feeding" after relaunch -> Feeding Type is "Left Breast", Amount empty
 *   saved storage select amountOz from events order by createdAt desc limit 1 -> amountOz empty
 *
 * Stored among a criterion's checks as `saved …` (a scenario file writes `Saved: …`). Mirrors the
 * Python grammar so the editor validates and normalises them before saving.
 */

const LINE_RE = /^\s*(?:check:\s*)?saved:?\s+/i;
const RELAUNCH_RE = /\s*\bafter\s+(?:a\s+)?relaunch\b/gi;
const SOURCE_SPLIT_RE = /\s+or\s+(?=(?:POST|PUT|PATCH|GET|query|storage|record)\b)/i;
const NUMBER_RE = /^[+-]?\d+(?:[.,]\d+)?$/;

export type SavedParse = { ok: true; normalised: string } | { ok: false; error: string };

export function looksLikeSaved(line: string): boolean {
  return LINE_RE.test(line);
}

/** Split at `sep` matches outside double quotes, braces and brackets. */
function splitOutside(text: string, sep: RegExp): string[] {
  const out: string[] = [];
  let depth = 0;
  let quoted = false;
  let start = 0;
  const sticky = new RegExp(sep.source, sep.flags.replace("g", "") + "y");
  for (let i = 0; i < text.length; ) {
    const c = text[i];
    if (c === "\\" && quoted) {
      i += 2;
      continue;
    }
    if (c === '"') quoted = !quoted;
    else if (!quoted && (c === "{" || c === "[")) depth++;
    else if (!quoted && (c === "}" || c === "]")) depth = Math.max(0, depth - 1);
    else if (!quoted && depth === 0) {
      sticky.lastIndex = i;
      const m = sticky.exec(text);
      if (m && m[0].length > 0) {
        out.push(text.slice(start, i));
        i += m[0].length;
        start = i;
        continue;
      }
    }
    i++;
  }
  out.push(text.slice(start));
  return out;
}

/** A value as the Python side renders it; a number keeps the digits it was written with. */
function literal(v: unknown, raw?: string): string {
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "number") return raw !== undefined ? raw.replace(",", ".") : String(v);
  return JSON.stringify(String(v));
}

type Clause = { text: string } | { error: string };

function clause(raw: string): Clause | null {
  const t = raw.trim();
  if (!t) return null;
  const field = (s: string) => {
    const f = s.trim();
    return f.length >= 2 && f.startsWith('"') && f.endsWith('"') ? f.slice(1, -1).trim() : f;
  };
  const empty = /^(.+?)\s+(?:is\s+)?(not\s+empty|empty)$/i.exec(t);
  if (empty) return { text: `${field(empty[1])} ${/^not/i.test(empty[2]) ? "not empty" : "empty"}` };
  const m = /^(.+?)\s+(is|=|contains)\s+(.+)$/i.exec(t) ?? /^(.+?)\s*(=)\s*(.+)$/.exec(t);
  if (!m) return { error: `"${t}": write FIELD empty, FIELD not empty, FIELD is VALUE or FIELD contains VALUE` };
  const name = field(m[1]);
  const op = m[2].toLowerCase() === "contains" ? "contains" : "is";
  const v = m[3].trim();
  let value: unknown;
  if (v.startsWith('"')) {
    try {
      value = JSON.parse(v);
    } catch {
      return { error: `${name}: unterminated quoted value ${v}` };
    }
    if (typeof value !== "string") return { error: `${name}: bad quoted value ${v}` };
  } else if (/^(null|nothing|none)$/i.test(v)) value = null;
  else if (/^(true|false)$/i.test(v)) value = v.toLowerCase() === "true";
  else if (NUMBER_RE.test(v)) value = Number(v.replace(",", "."));
  else value = v;
  if (!name) return { error: `"${t}": a field name is missing` };
  if (op === "contains") {
    if (value === null || typeof value === "boolean") return { error: `${name} contains needs a value` };
    return { text: `${name} contains ${literal(String(value))}` };
  }
  if (value === null || (typeof value === "string" && !value.trim())) return { text: `${name} empty` };
  return { text: `${name} is ${literal(value, typeof value === "number" ? v : undefined)}` };
}

function expects(raw: string): { clauses: string[]; errors: string[] } {
  const t = raw.trim();
  if (t.startsWith("{")) {
    let obj: unknown;
    try {
      obj = JSON.parse(t);
    } catch {
      return { clauses: [], errors: ["the expected fields are not valid JSON"] };
    }
    if (!obj || typeof obj !== "object" || Array.isArray(obj) || Object.keys(obj).length === 0) {
      return { clauses: [], errors: ["the expected fields must be a JSON object with at least one field"] };
    }
    const clauses: string[] = [];
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      if (v === null || v === "") clauses.push(`${k} empty`);
      else if (typeof v === "object") return { clauses: [], errors: [`${k}: compare one value per field (use metadata.${k} style paths for nested ones)`] };
      else clauses.push(`${k} is ${literal(v)}`);
    }
    return { clauses, errors: [] };
  }
  const clauses: string[] = [];
  const errors: string[] = [];
  for (const part of splitOutside(t, /\s*,\s*|\s+and\s+/i)) {
    const c = clause(part);
    if (!c) continue;
    if ("error" in c) errors.push(c.error);
    else clauses.push(c.text);
  }
  if (!clauses.length && !errors.length) errors.push("say what was saved: FIELD empty, FIELD is VALUE, ... or a JSON object");
  return { clauses, errors };
}

function source(raw: string): { text: string; kind: string } | { error: string } {
  const t = raw.trim();
  let m = /^(POST|PUT|PATCH|GET)\s+(\S+)\s*$/i.exec(t);
  if (m) {
    const method = m[1].toUpperCase();
    if (!m[2].startsWith("/") && !/^https?:\/\//.test(m[2])) return { error: `${method} needs a path starting with / (or a full http(s) URL), got ${m[2]}` };
    return { text: `${method} ${m[2]}`, kind: method === "GET" ? "get" : "write" };
  }
  m = /^(query|storage)\s+([\s\S]+)$/i.exec(t);
  if (m) {
    const kind = m[1].toLowerCase();
    if (!/^\s*(select|with)\b/i.test(m[2])) return { error: `${kind} needs a read-only select or with statement` };
    return { text: `${kind} ${m[2].trim()}`, kind };
  }
  m = /^record\s+"((?:[^"\\]|\\.)+)"\s*$/i.exec(t);
  if (m) return { text: `record "${m[1].trim()}"`, kind: "record" };
  if (/^record\b/i.test(t)) return { error: 'record needs the quoted title of the record\'s screen, e.g. record "Feeding"' };
  return { error: `"${t}" is not a read-back source: use POST|PUT|PATCH <path>, GET <path>, query <select>, storage <select> or record "<name>"` };
}

/** Parse one read-back line (`Saved:` or `saved` prefix optional) into its stored form `saved …`. */
export function parseSavedCheck(line: string): SavedParse {
  let text = line.replace(LINE_RE, "").trim();
  let warning = false;
  if (/\[warning\]$/i.test(text)) {
    warning = true;
    text = text.slice(0, -"[warning]".length).trimEnd();
  }
  const relaunch = RELAUNCH_RE.test(text);
  RELAUNCH_RE.lastIndex = 0;
  text = text.replace(RELAUNCH_RE, "").trim();
  if (!text) return { ok: false, error: "empty Saved: line" };
  let halves = splitOutside(text, /\s*(?:->|→)\s*/);
  if (halves.length < 2) halves = splitOutside(text, /\s+has\s+/i);
  if (halves.length < 2) return { ok: false, error: "write the source, then -> and what was saved: saved POST /api/events -> amount_oz empty" };
  const left = halves[0];
  const right = halves.slice(1).join(" -> ");
  const errors: string[] = [];
  const sources: { text: string; kind: string }[] = [];
  for (const part of left.trim().split(SOURCE_SPLIT_RE)) {
    const s = source(part);
    if ("error" in s) errors.push(s.error);
    else sources.push(s);
  }
  const ex = expects(right);
  errors.push(...ex.errors);
  if (relaunch && !sources.some((s) => s.kind === "record")) errors.push('after relaunch applies to the app\'s own read-back: add record "<name>"');
  if (errors.length) return { ok: false, error: errors.join("; ") };
  const parts = [sources.map((s) => s.text).join(" or ")];
  if (relaunch) parts.push("after relaunch");
  parts.push("->", ex.clauses.join(", "));
  if (warning) parts.push("[warning]");
  return { ok: true, normalised: `saved ${parts.join(" ")}` };
}

// ---------- `no-readback` : the same rule as the scenario lint ----------

const WRITES =
  /\b(?:sav(?:e|es|ed|ing)|add(?:s|ed|ing)?|creat(?:e|es|ed|ing)|log(?:s|ged|ging)?|edit(?:s|ed|ing)?|updat(?:e|es|ed|ing)|renam(?:e|es|ed|ing)|submit(?:s|ted|ting)?|book(?:s|ed|ing)?|register(?:s|ed|ing)?|upload(?:s|ed|ing)?|record(?:s|ed|ing)?)\b/gi;
const LOG_IN = /\blog(?:s|ged|ging)?\s+(?:in|out|on|off)\b|\bsign(?:s|ed|ing)?\s+(?:in|up|out)\b/gi;
const NEGATION = /\b(?:not|no|never|cannot|nothing|without)\b|n't\b/i;
const PASSIVE = /\b(?:is|was|were|are|been|be|it's)\s+(?:\w+\s+)?$/i;
const NOTHING_SAVED =
  /\b(?:nothing|not|never|no\s+\w+)\s+(?:is\s+|was\s+|gets\s+)?(?:saved|added|created|logged|recorded|submitted)\b|\bwithout\s+(?:saving|adding)\b/i;
const QUOTED = /"([^"]{2,})"|“([^”]{2,})”/g;

/** Whether a criterion creates or edits a record: a making or editing word that is not a
 * sign-in, not UI copy in quotes, not a control's capitalised name inside the sentence, not
 * negated before it, and not a passive description ("the time it was logged"). */
export function writesData(text: string): boolean {
  const blank = (m: string) => " ".repeat(m.length);
  const t = text.replace(LOG_IN, blank).replace(QUOTED, blank);
  if (NOTHING_SAVED.test(t)) return false;
  const lead = t.length - t.trimStart().length;
  for (const m of t.matchAll(WRITES)) {
    const word = m[0];
    const at = m.index ?? 0;
    if (word[0] !== word[0].toLowerCase() && at !== lead) continue;
    const before = t.slice(0, at);
    if (NEGATION.test(before)) continue;
    if (word.toLowerCase().endsWith("ed") && PASSIVE.test(before)) continue;
    return true;
  }
  return false;
}

/** The `no-readback` hint for one criterion: it writes data and none of its check lines reads
 * the record back. Null when no hint applies. */
export function readbackHint(criterion: string, checkLines: string): string | null {
  if (!writesData(criterion)) return null;
  if (checkLines.split("\n").some((l) => looksLikeSaved(l.trim()))) return null;
  return "Creates or edits data with no read-back. Add a Saved: line so a save that stores the wrong values fails, even when the screen looks right.";
}
