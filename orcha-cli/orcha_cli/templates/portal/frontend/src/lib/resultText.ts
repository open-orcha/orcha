/**
 * Port of the cloud vanilla's resultText (static/pages/tasks-detail.js).
 *
 * open-orcha#209 (cloud port): tasks.result is JSONB and /done accepts any
 * JSON, but the render sites string-interpolate — an agent posting a
 * structured result (e.g. {"result": "PR #203 opened…"}) showed the verifying
 * human literally "[object Object]" at the verification gate. Normalize every
 * shape to text: strings pass through; objects with a conventional text field
 * yield that field; anything else becomes a readable "Key: value" list, one
 * field per line (V2 D4: never raw JSON / "{…}" in the UI — the structured
 * view is the shared <Payload> primitive's job).
 */
import { humanizeKey } from "../components/primitives/Payload";

const MAX_DEPTH = 3;

function scalar(v: unknown): string | null {
  if (v == null) return "—";
  if (typeof v === "string") return v.trim() ? v.replace(/\s+/g, " ").trim() : "—";
  if (typeof v === "number") return String(v);
  if (typeof v === "boolean") return v ? "yes" : "no";
  return null;
}

function lines(v: unknown, prefix: string, depth: number, out: string[]): void {
  const s = scalar(v);
  if (s != null) { out.push(prefix ? prefix + ": " + s : s); return; }
  if (Array.isArray(v)) {
    const flat = v.map(scalar);
    if (flat.every((x) => x != null)) { out.push((prefix ? prefix + ": " : "") + (flat.length ? flat.join(", ") : "none")); return; }
    if (depth >= MAX_DEPTH) { out.push((prefix ? prefix + ": " : "") + v.length + " items"); return; }
    v.forEach((x, i) => lines(x, (prefix ? prefix + " › " : "") + "#" + (i + 1), depth + 1, out));
    return;
  }
  if (typeof v === "object") {
    const entries = Object.entries(v as Record<string, unknown>);
    if (!entries.length) { out.push((prefix ? prefix + ": " : "") + "—"); return; }
    if (depth >= MAX_DEPTH) { out.push((prefix ? prefix + ": " : "") + entries.length + " fields"); return; }
    for (const [k, x] of entries) lines(x, (prefix ? prefix + " › " : "") + humanizeKey(k), depth + 1, out);
    return;
  }
  out.push((prefix ? prefix + ": " : "") + String(v));
}

/** Structured value → readable "Key: value" lines (never JSON). */
export function readableText(v: unknown): string {
  const out: string[] = [];
  lines(v, "", 0, out);
  return out.join("\n");
}

export function resultText(r: unknown): string {
  if (r == null) return "";
  if (typeof r === "string") return r;
  if (typeof r === "object") {
    for (const k of ["result", "summary", "text", "message"]) {
      const v = (r as Record<string, unknown>)[k];
      if (typeof v === "string" && v.trim()) return v;
    }
    try {
      return readableText(r);
    } catch {
      return "";
    }
  }
  return String(r);
}
