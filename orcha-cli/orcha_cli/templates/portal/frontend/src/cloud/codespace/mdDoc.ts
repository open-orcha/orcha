/**
 * Code Space's rendered-markdown document HTML (screen review r3): the shared
 * house renderer (lib/format.ts's mdText, also used by chat/threads) only
 * links bare http URLs and collapses #/##/### into one flat `.md-h`. A
 * repository README needs two more things, added here WITHOUT touching
 * mdText (a shared component other surfaces depend on):
 *
 *  1. `[text](href)` links. They're lifted out of the source BEFORE mdText
 *     runs (outside fenced/inline code), replaced by an inert placeholder,
 *     and re-inserted as escape-safe anchors afterwards:
 *       - http(s):// and mailto: → external anchor (new tab, noopener)
 *       - a repo-relative path (docs/a.md, ./x, ../y, /root.md) → an anchor
 *         carrying data-md-path=<resolved repo path>; MdRenderedPane opens it
 *         in Code Space (?path=) instead of navigating the browser
 *       - anything else (javascript:, data:, #fragment, a path escaping the
 *         repo root) → the link TEXT only, never an anchor
 *  2. Heading levels: each `.md-h` gets `md-h1|2|3` + data-level from the
 *     source, in order (fenced code skipped, like mdText's own stash).
 *
 * Output is TRUSTED html (mdText escapes first; link text/hrefs are escaped
 * here) for dangerouslySetInnerHTML.
 */
import { esc, mdText } from "../../lib/format";

const PH_OPEN = "\u0001QZ";
const PH_CLOSE = "\u0001";
// Placeholder index digits drawn from non-hex letters so mdText's task-ref
// matcher (8 hex chars) and emphasis rules can never touch them.
const DIGITS = "ghijklmnopqrstuvwxyz";
const encIdx = (n: number): string => {
  let s = "";
  do { s = DIGITS[n % DIGITS.length] + s; n = Math.floor(n / DIGITS.length); } while (n > 0);
  return s;
};
const decIdx = (s: string): number => [...s].reduce((acc, c) => acc * DIGITS.length + DIGITS.indexOf(c), 0);

// [text](href "optional title") — text without brackets/newlines, href without spaces/parens.
const LINK_RE = /(!?)\[([^\]\n]+)\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"\n]*")?\s*\)/g;
// Regions mdText treats as code: fenced blocks, then inline code spans.
const CODE_RE = /```[^\n`]*\n?[\s\S]*?```|`[^`\n]+`/g;

/** Resolve a markdown link target against the directory of `fromPath`.
 *  Returns a clean repo-relative path, or null when it escapes the root. */
export function resolveRepoPath(fromPath: string, href: string): string | null {
  let target = href.replace(/[?#].*$/, "");
  try { target = decodeURIComponent(target); } catch { /* keep raw */ }
  if (!target) return null;
  const base = target.startsWith("/") ? [] : fromPath.split("/").slice(0, -1);
  const parts = [...base];
  for (const seg of target.split("/")) {
    if (!seg || seg === ".") continue;
    if (seg === "..") {
      if (!parts.length) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.length ? parts.join("/") : null;
}

export type MdLinkTarget =
  | { kind: "external"; href: string }
  | { kind: "path"; path: string }
  | { kind: "none" };

export function classifyHref(fromPath: string, href: string): MdLinkTarget {
  const h = href.trim();
  if (/^https?:\/\//i.test(h) || /^mailto:[^\s]+$/i.test(h)) return { kind: "external", href: h };
  // any other scheme (javascript:, data:, vbscript:, file:, ftp:…) or protocol-relative → text only
  if (/^[a-z][a-z0-9+.-]*:/i.test(h) || h.startsWith("//")) return { kind: "none" };
  if (h.startsWith("#")) return { kind: "none" };
  const p = resolveRepoPath(fromPath, h);
  return p ? { kind: "path", path: p } : { kind: "none" };
}

function linkHtml(fromPath: string, text: string, href: string): string {
  const t = classifyHref(fromPath, href);
  const label = esc(text);
  if (t.kind === "external") {
    return `<a class="lnk" href="${esc(t.href)}" target="_blank" rel="noopener noreferrer">${label}</a>`;
  }
  if (t.kind === "path") {
    return `<a class="lnk md-path" href="?path=${esc(encodeURIComponent(t.path))}" data-md-path="${esc(t.path)}" title="${esc(t.path)}">${label}</a>`;
  }
  return label;
}

/** Source heading levels (1-3) in document order, skipping fenced code —
 *  the same #{1,3} rule mdText applies. */
export function headingLevels(src: string): number[] {
  const out: number[] = [];
  const noFences = src.replace(/```[^\n`]*\n?[\s\S]*?```/g, "");
  for (const line of noFences.split("\n")) {
    const m = /^\s{0,3}(#{1,3})\s+\S/.exec(line);
    if (m) out.push(m[1].length);
  }
  return out;
}

export function renderMdDoc(src: string, fromPath: string): string {
  const links: string[] = [];
  const lift = (seg: string) =>
    seg.replace(LINK_RE, (_m, _bang: string, text: string, href: string) => {
      links.push(linkHtml(fromPath, text, href));
      return PH_OPEN + encIdx(links.length - 1) + PH_CLOSE;
    });
  // Only lift links OUTSIDE code regions.
  let prepared = "";
  let last = 0;
  for (const m of src.matchAll(CODE_RE)) {
    prepared += lift(src.slice(last, m.index)) + m[0];
    last = (m.index ?? 0) + m[0].length;
  }
  prepared += lift(src.slice(last));

  let html = mdText(prepared);
  html = html.replace(new RegExp(PH_OPEN + "([" + DIGITS + "]+)" + PH_CLOSE, "g"), (_m, i: string) => links[decIdx(i)] ?? "");

  const levels = headingLevels(src);
  let n = 0;
  html = html.replace(/<span class="md-h">/g, () => {
    const lvl = levels[n++] ?? 2;
    return `<span class="md-h md-h${lvl}" data-level="${lvl}">`;
  });
  return html;
}
