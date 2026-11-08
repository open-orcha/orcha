/**
 * Tracking-event expectations on a scenario (`scenarios.events`, `orcha.verdicts.events`): one line
 * per event the flow must fire, e.g. `network: POST /v1/track "checkout_started"`. The Python
 * side (`scenarios/suite.validate_events`) is the authority; this mirrors its shape check so a
 * typo is caught when the scenario is saved rather than silently never matching.
 */

export const MAX_EVENT_LINES = 10;
export const ANY_ORDER = "any order";
const SOURCES = ["network", "console", "device", "any"] as const;
const WARNING_SUFFIX_RE = /\s*\[warning\]\s*$/i;

/** Split the editor's textarea into lines, dropping blank ones. */
export function eventsFromText(text: string): string[] {
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
}

export function eventsToText(events: readonly string[] | null | undefined): string {
  return (events ?? []).join("\n");
}

/** Why one line is not an expectation, or null when it is. */
export function eventLineError(line: string): string | null {
  const text = line.trim();
  if (text.toLowerCase() === ANY_ORDER) return null;
  const body = text.replace(WARNING_SUFFIX_RE, "");
  const colon = body.indexOf(":");
  const source = colon === -1 ? "" : body.slice(0, colon).trim().toLowerCase();
  if (!(SOURCES as readonly string[]).includes(source)) {
    return `"${text}" must start with network:, console:, device: or any:`;
  }
  if (eventTerms(body.slice(colon + 1)).length === 0) return `"${text}" names no terms to look for`;
  return null;
}

const REGEX_TERM_RE = /(?:^|\s)\/((?:\\\/|[^/])+)\/(?=\s|$)/g;

/**
 * POSIX-shell-style word split (Python's `shlex.split`): quotes group and are removed, a
 * backslash escapes outside single quotes. Null on an unbalanced quote or trailing backslash.
 */
export function shellSplit(text: string): string[] | null {
  const words: string[] = [];
  let word = "";
  let inWord = false;
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote === "'") {
      if (ch === "'") quote = null;
      else word += ch;
    } else if (quote === '"') {
      if (ch === '"') quote = null;
      else if (ch === "\\" && i + 1 < text.length && '"\\$`\n'.includes(text[i + 1])) word += text[++i];
      else word += ch;
    } else if (ch === "'" || ch === '"') {
      quote = ch;
      inWord = true;
    } else if (ch === "\\") {
      if (i + 1 >= text.length) return null;
      word += text[++i];
      inWord = true;
    } else if (/\s/.test(ch)) {
      if (inWord) words.push(word);
      word = "";
      inWord = false;
    } else {
      word += ch;
      inWord = true;
    }
  }
  if (quote) return null;
  if (inWord) words.push(word);
  return words;
}

/**
 * The non-empty terms after `<source>:` the way `orcha.verdicts.events.parse` finds them: `/regex/`
 * terms first, then shell-split words (falling back to a whitespace split on a bad quote),
 * quotes stripped. `network: ""` has none, so it is rejected like the Python side rejects it.
 */
export function eventTerms(rest: string): string[] {
  const trimmed = rest.trim();
  const regexes = [...trimmed.matchAll(REGEX_TERM_RE)].map((m) => m[1]);
  const remaining = trimmed.replace(REGEX_TERM_RE, " ");
  const words = shellSplit(remaining) ?? remaining.split(/\s+/);
  return [...regexes, ...words.filter(Boolean)];
}

export type EventsValidation = { ok: true; events: string[] } | { ok: false; error: string };

/**
 * Validate a scenario's event lines: blank lines are dropped, at most `MAX_EVENT_LINES`
 * remain, and each is `<source>: <terms>` (optionally ending in `[warning]`) or exactly
 * `any order` (normalised to lower case, as the Python side stores it).
 */
export function validateEvents(value: unknown): EventsValidation {
  if (!Array.isArray(value) || value.some((v) => typeof v !== "string")) {
    return { ok: false, error: "events must be a list of strings." };
  }
  const lines = (value as string[]).map((l) => l.trim()).filter(Boolean);
  if (lines.length > MAX_EVENT_LINES) {
    return { ok: false, error: `At most ${MAX_EVENT_LINES} tracking events per scenario.` };
  }
  for (const line of lines) {
    const error = eventLineError(line);
    if (error) return { ok: false, error };
  }
  return { ok: true, events: lines.map((l) => (l.toLowerCase() === ANY_ORDER ? ANY_ORDER : l)) };
}
