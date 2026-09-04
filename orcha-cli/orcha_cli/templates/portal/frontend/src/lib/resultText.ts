/**
 * Port of the cloud vanilla's resultText (static/pages/tasks-detail.js).
 *
 * open-orcha#209 (cloud port): tasks.result is JSONB and /done accepts any
 * JSON, but the render sites string-interpolate — an agent posting a
 * structured result (e.g. {"result": "PR #203 opened…"}) showed the verifying
 * human literally "[object Object]" at the verification gate. Normalize every
 * shape to text: strings pass through; objects with a conventional text field
 * yield that field; anything else becomes readable pretty-printed JSON
 * (React escapes it downstream as usual).
 */
export function resultText(r: unknown): string {
  if (r == null) return "";
  if (typeof r === "string") return r;
  if (typeof r === "object") {
    for (const k of ["result", "summary", "text", "message"]) {
      const v = (r as Record<string, unknown>)[k];
      if (typeof v === "string" && v.trim()) return v;
    }
    try {
      return JSON.stringify(r, null, 2);
    } catch {
      return String(r);
    }
  }
  return String(r);
}
