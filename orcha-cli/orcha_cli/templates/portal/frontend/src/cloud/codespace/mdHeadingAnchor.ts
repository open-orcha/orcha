/**
 * Rendered-markdown thread anchoring (item 2, "Discuss this document"):
 * Rendered mode (Md, lib/format.ts's mdText) collapses every heading level
 * (#, ##, ###) to a flat `<span class="md-h">` with no id/line info — mdText
 * is a SHARED house component (also used by ThreadView/Conversation) so it
 * cannot grow anchor metadata without touching unrelated surfaces. This
 * module instead resolves a rendered heading back to its SOURCE line by
 * matching against the raw file content Code Space already has fetched
 * (filePayload.content), independently of the render.
 *
 * Matching rule (conservative — a wrong anchor is worse than no anchor):
 *  - Extract every heading LINE from the raw markdown, in source order
 *    (same `#{1,3}` regex mdText itself matches on).
 *  - The rendered `.md-h` spans appear in the SAME order mdText emits them
 *    (mdText is a single top-to-bottom regex pass — it never reorders or
 *    drops a matched heading), so the Nth rendered heading corresponds
 *    POSITIONALLY to the Nth extracted source line.
 *  - That positional correspondence is trusted ONLY when both the count and
 *    the normalized text agree — any mismatch (a raw heading mdText didn't
 *    actually match, inline markup normalizing differently than expected,
 *    etc.) is treated as ambiguous for that heading and falls back to the
 *    file-level anchor rather than risk anchoring to the wrong line.
 */

export interface HeadingLine {
  line: number; // 1-based, matches the gutter/thread anchor convention
  text: string; // raw heading text, `#` markers and surrounding whitespace stripped
}

// Same heading match as lib/format.ts's mdText: up to 3 leading spaces, 1-3
// `#`, then required whitespace before the text — kept in sync deliberately
// (duplicating the regex, not importing it, since mdText's is inlined in a
// larger replace chain with no exported standalone matcher).
const HEADING_RE = /^\s{0,3}#{1,3}\s+(.+)$/;

export function extractHeadingLines(raw: string): HeadingLine[] {
  if (typeof raw !== "string" || !raw) return [];
  const out: HeadingLine[] = [];
  const lines = raw.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const m = HEADING_RE.exec(lines[i]);
    if (m) out.push({ line: i + 1, text: m[1] });
  }
  return out;
}

// Strip the same inline markup mdText applies (bold/italic/code) plus any
// leftover markdown punctuation, collapse whitespace, lowercase — so
// "**Bold** Title" (source) compares equal to the rendered span's flattened
// textContent "Bold Title".
export function normalizeHeadingText(text: string): string {
  return text
    .replace(/`([^`\n]+)`/g, "$1")
    .replace(/\*\*(?!\s)([^\n]+?)\*\*/g, "$1")
    .replace(/__(?!\s)([^\n_]+?)__/g, "$1")
    .replace(/(^|[^*])\*(?!\s)([^*\n]+?)\*(?!\*)/g, "$1$2")
    .replace(/(^|[^_\w])_(?!\s)([^_\n]+?)_(?![\w_])/g, "$1$2")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

export type HeadingResolution =
  | { resolved: true; line: number }
  | { resolved: false; reason: "count_mismatch" | "text_mismatch" | "index_out_of_range" };

/**
 * Resolve the `domIndex`-th (0-based, DOM/render order) rendered heading to
 * its source line, given the raw file content and that same heading's
 * rendered (flattened) text — e.g. a `.md-h` span's `.textContent`.
 */
export function resolveHeadingLine(
  raw: string,
  domIndex: number,
  renderedText: string,
): HeadingResolution {
  const extracted = extractHeadingLines(raw);
  if (domIndex < 0 || domIndex >= extracted.length) return { resolved: false, reason: "index_out_of_range" };
  const candidate = extracted[domIndex];
  if (normalizeHeadingText(candidate.text) !== normalizeHeadingText(renderedText)) {
    return { resolved: false, reason: "text_mismatch" };
  }
  return { resolved: true, line: candidate.line };
}
