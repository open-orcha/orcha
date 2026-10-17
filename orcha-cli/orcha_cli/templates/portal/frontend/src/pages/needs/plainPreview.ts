/**
 * Markdown → one flat, readable preview line for list-row subtitles (plan
 * bodies, message bodies): strips headings, list bullets, emphasis, code
 * ticks and link syntax, and collapses whitespace. List items / lines keep a
 * visible "; " separator so "- A\n- B" never runs together as "A B". Payload objects go through
 * the shared primitives' payloadTitle / payloadText instead (D4).
 */
export function plainPreview(md: string | null | undefined, opts: { dropHeadings?: boolean } = {}): string {
  if (!md) return "";
  const src = opts.dropHeadings ? md.replace(/^\s{0,3}#{1,6}\s+.*$/gm, "") : md;
  return src
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/^\s*(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?/gm, "\u0001")
    .replace(/\*\*(.+?)\*\*|__(.+?)__/g, "$1$2")
    .replace(/(^|\W)[*_](\S[^*_]*?)[*_](?=\W|$)/g, "$1$2")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/\s+/g, " ")
    // list-item boundaries: "; " between items, nothing before the first one
    // and no doubled punctuation after a sentence/lead-in ("Steps: A; B")
    .replace(/^[\s\u0001]+/, "")
    .replace(/([:;.!?,])\s*\u0001\s*/g, "$1 ")
    .replace(/\s*\u0001\s*/g, "; ")
    .trim();
}
