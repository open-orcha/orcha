/**
 * Delta checks: `Check:` lines about how data changed, read
 * before the scenario acts and when the criterion is reported.
 *
 *   query select count(*) from trips where truck_id = '{{truck.id}}' increases by 1
 *   api GET /trucks/{{truck.id}} .income increases by {{rate}} within 10s
 *
 * Mirrors the Python grammar so the editor validates and normalises them before saving.
 */

const HEAD_RE = /^\s*(?:check:\s*)?(api|query)\s+/i;
const TAIL_RE = /\s+(increases|decreases|changes|unchanged)(?:\s+by\s+(\S+))?(?:\s+within\s+(\S+))?(?:\s+(\[warning\]))?\s*$/i;
const PATH_RE = /^\.[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$/;
const PLACEHOLDER_RE = /\{\{[^{}]+\}\}/;
const MAX_TIMEOUT_S = 60;

export function looksLikeDelta(line: string): boolean {
  return HEAD_RE.test(line);
}

function num(text: string): number | null {
  const cleaned = text.trim().replace(/[,_]/g, "");
  return /^[+-]?\d+(?:\.\d+)?$/.test(cleaned) ? Number(cleaned) : null;
}

function fmt(n: number): string {
  return Number.isInteger(n) ? String(n) : String(Number(n.toPrecision(12)));
}

export type DeltaParse = { ok: true; normalised: string } | { ok: false; error: string };

/** Parse one delta line; null when it is not one (it does not start with api or query). */
export function parseDeltaCheck(line: string): DeltaParse | null {
  const head = HEAD_RE.exec(line);
  if (!head) return null;
  const source = head[1].toLowerCase();
  const body = line.slice(head[0].length).trim();
  const tail = TAIL_RE.exec(` ${body}`);
  if (!tail) return { ok: false, error: "end a delta check with increases, decreases or changes (optionally by N), or unchanged" };
  const verb = tail[1].toLowerCase();
  const target = ` ${body}`.slice(0, tail.index).trim();
  const problems: string[] = [];
  let by: string | null = null;
  if (tail[2] !== undefined) {
    if (verb === "unchanged") problems.push("unchanged takes no 'by'");
    else if (PLACEHOLDER_RE.test(tail[2])) by = tail[2];
    else {
      const n = num(tail[2]);
      if (n === null) problems.push(`by needs a number, got ${tail[2]}`);
      else if ((verb === "increases" || verb === "decreases") && n < 0) problems.push(`${verb} by needs a positive number (use changes by ${fmt(n)})`);
      else by = fmt(n);
    }
  }
  let within: string | null = null;
  if (tail[3] !== undefined) {
    const m = /^(\d+(?:\.\d+)?)s$/i.exec(tail[3]);
    if (m) within = `${fmt(Math.min(Number(m[1]), MAX_TIMEOUT_S))}s`;
    else problems.push(`within needs a number of seconds like 10s, got ${tail[3]}`);
  }
  const parts: string[] = [source];
  if (source === "api") {
    let words = target.split(/\s+/).filter(Boolean);
    if (words[0]?.toUpperCase() === "GET") words = words.slice(1);
    else if (["POST", "PUT", "PATCH", "DELETE"].includes(words[0]?.toUpperCase() ?? "")) {
      problems.push("an api delta reads with GET only");
      words = words.slice(1);
    }
    if (words.length === 0) problems.push("api needs a path, e.g. api GET /cart .item_count");
    else {
      if (!words[0].startsWith("/") && !/^https?:\/\//.test(words[0])) problems.push(`api needs a path starting with /, got ${words[0]}`);
      if (words.length > 2 || (words[1] !== undefined && !PATH_RE.test(words[1]))) {
        problems.push(`after the path comes one JSON path like .income or .items.length, got ${words.slice(1).join(" ")}`);
      }
      parts.push("GET", ...words.slice(0, 2));
    }
  } else {
    if (!target) problems.push("query needs a select statement");
    else if (!/^\s*(select|with)\b/i.test(target)) problems.push("query needs a read-only select or with statement");
    parts.push(target);
  }
  if (problems.length) return { ok: false, error: problems.join("; ") };
  parts.push(verb);
  if (by !== null) parts.push("by", by);
  if (within) parts.push("within", within);
  if (tail[4]) parts.push("[warning]");
  return { ok: true, normalised: parts.join(" ") };
}
