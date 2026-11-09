/** A request's acceptance lines, each with the verdict that came back for it. */
import type { QaLineResult, QaRequest } from "./api";

export function linesOf(r: Pick<QaRequest, "acceptance" | "result" | "live_lines">): QaLineResult[] {
  const results = r.result?.lines.length ? r.result.lines : r.live_lines;
  const lines: QaLineResult[] = r.acceptance.map((text, index) => {
    const hit = results.find((l) => l.index === index) ?? results.find((l) => l.text.trim().toLowerCase() === text.trim().toLowerCase());
    return hit ? { ...hit, text, index } : { index, text, verdict: null, note: null, frame_ids: [], session_id: null };
  });
  // A verdict on a line the request did not list is still shown, never dropped.
  for (const l of results) if (!lines.some((x) => x.text.trim().toLowerCase() === l.text.trim().toLowerCase())) lines.push(l);
  return lines;
}
