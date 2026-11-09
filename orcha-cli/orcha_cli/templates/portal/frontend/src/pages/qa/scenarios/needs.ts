/** The `Needs:` line: comma-separated items, each read as a known need or free text. Pure. */

export type NeedKind = "reset" | "launch_hook" | "fixture" | "seed_api" | "cleanup" | "sandbox" | "writes" | "signed_in" | "other";

export interface Need {
  kind: NeedKind;
  text: string;
  value: string | null;
}

export const MAX_NEEDS = 12;
export const MAX_NEED_LENGTH = 80;

const ALIASES: ReadonlyArray<[RegExp, NeedKind, string | null]> = [
  [/^(?:a\s+)?(?:fresh(?:\s+(?:install|app|start|state|data))?|reset|app\s+reset|clean\s+(?:app|start|install)|reinstall)$/i, "reset", null],
  [/^launch\s+hook$/i, "launch_hook", null],
  [/^fixture\s+["“]?(.+?)["”]?$/i, "fixture", null],
  [/^(?:seeds?|seed\s+(?:api|data)|seed\s+and\s+cleanup\s+api|api)$/i, "seed_api", null],
  [/^(?:clean\s*-?\s*up|cleanup(?:\s+or\s+reset)?)$/i, "cleanup", null],
  [/^(?:(?:in-app\s+)?purchases?(?:\s+sandbox)?|storekit(?:\s+configuration)?|play\s+billing|subscriptions?\s+sandbox)$/i, "sandbox", "purchases"],
  [/^(?:payments?(?:\s+sandbox)?|stripe(?:\s+test\s+keys)?)$/i, "sandbox", "payments"],
  [/^(?:e-?mail(?:\s+(?:sandbox|sink|inbox))?)$/i, "sandbox", "email"],
  [/^(?:sms(?:\s+sandbox)?|text\s+messages?)$/i, "sandbox", "sms"],
  [/^(?:writes?|write\s+access|writable\s+data|data\s+writes)$/i, "writes", null],
  [/^(?:signed\s+in|sign-?in|logged\s+in|an?\s+account)$/i, "signed_in", null],
];

/** Comma-separated items; a comma inside quotes stays (`fixture "a, b"`). */
function split(line: string): string[] {
  const out: string[] = [];
  let buf = "";
  let quoted = false;
  for (const ch of line) {
    if (ch === '"' || ch === "“" || ch === "”") {
      quoted = ch === '"' ? !quoted : ch === "“";
      buf += ch;
    } else if ((ch === "," || ch === ";") && !quoted) {
      out.push(buf);
      buf = "";
    } else {
      buf += ch;
    }
  }
  out.push(buf);
  return out.map((s) => s.replace(/\s+/g, " ").trim()).filter(Boolean);
}

export function parseNeed(text: string): Need {
  const item = String(text ?? "").replace(/\s+/g, " ").trim().replace(/\.+$/, "");
  for (const [re, kind, value] of ALIASES) {
    const m = re.exec(item);
    if (m) return kind === "fixture" ? { kind, text: item, value: m[1].trim() } : { kind, text: item, value };
  }
  return { kind: "other", text: item, value: null };
}

/** A `Needs:` line, or the `scenarios.needs` column, as needs in order, each once. */
export function parseNeeds(value: unknown): Need[] {
  let items: string[] = [];
  if (typeof value === "string") {
    const s = value.trim();
    if (s.startsWith("[")) {
      try {
        const parsed: unknown = JSON.parse(s);
        items = Array.isArray(parsed) ? parsed.map(String) : [s];
      } catch {
        items = [s];
      }
    } else {
      items = split(s);
    }
  } else if (Array.isArray(value)) {
    items = value.map(String);
  }
  const out: Need[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    const need = parseNeed(item);
    if (!need.text) continue;
    const key = `${need.kind}:${need.kind === "fixture" || need.kind === "other" ? (need.value ?? need.text).toLowerCase() : (need.value ?? "")}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(need);
  }
  return out;
}

/** The list as one line of text. */
export function needsToText(needs: readonly string[] | null | undefined): string {
  return (needs ?? []).join(", ");
}

/** The editor's text as the column's list (null when empty). */
export function needsFromText(text: string): string[] | null {
  const list = parseNeeds(text).map((n) => n.text);
  return list.length > 0 ? list : null;
}

/** Why the editor's Needs text cannot be saved, or null. */
export function needsError(text: string): string | null {
  const needs = parseNeeds(text);
  if (needs.length > MAX_NEEDS) return `At most ${MAX_NEEDS} needs.`;
  const long = needs.find((n) => n.text.length > MAX_NEED_LENGTH);
  return long ? `"${long.text.slice(0, 40)}…" is longer than ${MAX_NEED_LENGTH} characters.` : null;
}

/** The needs Orcha knows, as written in a Needs line: what a free-text need is checked against. */
const KNOWN_NEEDS = [
  "fresh install", "reset", "launch hook", "seed api", "cleanup", "purchases sandbox", "payments sandbox",
  "email sandbox", "SMS sandbox", "writes", "signed in",
];

function distance(a: string, b: string): number {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length];
}

/** A warning for a free-text need that looks like a misspelled known one ("purchses sandbox"),
 * or null. Free-text needs stay allowed: they are checked by a person, not by Orcha. */
export function needsWarning(text: string): string | null {
  for (const n of parseNeeds(text)) {
    if (n.kind !== "other") continue;
    const t = n.text.toLowerCase();
    const near = KNOWN_NEEDS.find((k) => distance(t, k.toLowerCase()) <= Math.max(1, Math.floor(k.length / 6)));
    if (near) return `"${n.text}" isn't a need Embodent knows. Did you mean "${near}"?`;
  }
  return null;
}

