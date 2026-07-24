/* Orcha shared portal module: text formatting, markdown, links, and task references. */
/* ---- tiny utils ------------------------------------------------------ */
const esc = (s) => (s == null ? "" : String(s)).replace(/[&<>"']/g,
  (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const trunc = (s, n) => { s = s || ""; return s.length > n ? s.slice(0, n - 1) + "…" : s; };
// ISS-82 (GH #223): agents cite tasks in free text by raw id — usually the 8-char SHORT
// prefix (e.g. `e4b77f3f`), sometimes the full UUID. Resolve such a token to the live task.
// Exact full-id wins; else a UNIQUE 8+ hex prefix. Ambiguous or absent → null (never guess),
// so request ids / message ids / commit shas simply don't resolve and are left untouched.
function taskByRef(token) {
  if (!token) return null;
  const tok = String(token).toLowerCase();
  const ts = tasks();
  const exact = ts.find((t) => String(t.id).toLowerCase() === tok);
  if (exact) return exact;
  if (tok.length >= 8 && tok.length < 36) {
    let hit = null, n = 0;
    for (const t of ts) { if (String(t.id).toLowerCase().startsWith(tok)) { hit = t; if (++n > 1) return null; } }
    if (n === 1) return hit;
  }
  return null;
}
// ISS-82: rewrite bare task-id tokens in ALREADY-ESCAPED/rendered HTML into linkified
// [task name] chips. Tag-aware (never edits the contents of a < > tag) AND anchor-aware
// (never rewrites the visible text of an existing <a>, so a task-id that happens to sit
// inside a URL stays intact). Only tokens that resolve to a real task are touched; every
// other id passes through verbatim. Callers run esc()/mdText first, so the input is trusted.
const TASK_REF_RE = /\b[0-9a-f]{8}(?:-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})?\b/gi;
function taskRefs(html) {
  if (html == null) return "";
  let inAnchor = false;
  return String(html).split(/(<[^>]*>)/).map((seg) => {
    if (seg.charAt(0) === "<") {                 // a real tag (text has its < escaped to &lt;)
      const lt = seg.toLowerCase();
      if (lt.indexOf("<a") === 0) inAnchor = true;
      else if (lt.indexOf("</a") === 0) inAnchor = false;
      return seg;
    }
    if (inAnchor) return seg;                     // visible text inside an existing link — leave it
    return seg.replace(TASK_REF_RE, (tok) => {
      const t = taskByRef(tok);
      if (!t) return tok;
      return `<a class="tref" href="/tasks?task=${encodeURIComponent(t.id)}" title="task ${esc(tok)}">[${esc(t.title)}]</a>`;
    });
  }).join("");
}
// ISS-44: make URLs in authored text clickable. SAFETY: esc() FIRST (so the text can never
// inject HTML), THEN linkify the escaped string — only http(s):// URLs, emitting an anchor
// with target=_blank + rel=noopener noreferrer. Returns trusted HTML (already escaped).
// Trailing sentence punctuation / a closing bracket is left OUTSIDE the link, never swallowed.
// ISS-82: after URL-linkify, run taskRefs so bare task-id mentions become [task name] chips
// too (anchor-aware, so a task-id inside a linked URL is left alone).
const linkify = (s) => taskRefs(esc(s == null ? "" : String(s)).replace(/https?:\/\/[^\s<]+/g, (m) => {
  let tail = "";
  const t = m.match(/[)\].,;:!?]+$/);   // (text is escaped, so quotes/apostrophes are entities)
  if (t) { tail = m.slice(m.length - t[0].length); m = m.slice(0, m.length - t[0].length); }
  return `<a class="lnk" href="${m}" target="_blank" rel="noopener noreferrer">${m}</a>${tail}`;
}));
// Render a SAFE inline-markdown subset for chat messages (agents emit lots of **bold**,
// `code`, fenced ```blocks```, lists). SECURITY: esc() FIRST so the text can never inject
// HTML, THEN format the escaped string. Code spans/fences are stashed before emphasis so
// their literal *_` survive; a NUL sentinel (impossible in input) marks the stash slots.
// Newlines are preserved by .tx { white-space: pre-wrap }.
const mdText = (src) => {
  let s = esc(src == null ? "" : String(src));
  const stash = [];
  const Z = String.fromCharCode(0);   // NUL sentinel — impossible in esc()'d input, so it never collides with real text
  const keep = (html) => { stash.push(html); return Z + (stash.length - 1) + Z; };
  // fenced code block  ```lang\n…```
  s = s.replace(/```[^\n`]*\n?([\s\S]*?)```/g, (m, code) => keep(`<pre class="md-pre"><code>${code.replace(/\n+$/, "")}</code></pre>`));
  // inline code  `…`
  s = s.replace(/`([^`\n]+)`/g, (m, code) => keep(`<code class="md-code">${code}</code>`));
  // GFM tables: a header row, a |---|:--:| delimiter row, then data rows. Rendered in place
  // (one line, no inner newlines) BEFORE the inline passes so cell text still gets bold/links;
  // runs after code stashing, so a `pipe|in|code` cell can't be mistaken for columns.
  {
    const splitRow = (line) => line.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
    const isDelim = (line) => line != null && /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)+\|?\s*$/.test(line);
    const cell = (c, tag, al) => `<${tag}${al ? ` style="text-align:${al}"` : ""}>${c}</${tag}>`;
    const lines = s.split("\n"), out = [];
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].indexOf("|") >= 0 && isDelim(lines[i + 1])) {
        const head = splitRow(lines[i]);
        const aligns = splitRow(lines[i + 1]).map((c) => {
          const L = c.startsWith(":"), R = c.endsWith(":");
          return L && R ? "center" : R ? "right" : L ? "left" : "";
        });
        const rows = []; let j = i + 2;
        for (; j < lines.length && lines[j].indexOf("|") >= 0 && lines[j].trim() !== ""; j++) rows.push(splitRow(lines[j]));
        const thead = "<tr>" + head.map((c, k) => cell(c, "th", aligns[k])).join("") + "</tr>";
        const tbody = rows.map((r) => "<tr>" + head.map((_, k) => cell(r[k] == null ? "" : r[k], "td", aligns[k])).join("") + "</tr>").join("");
        out.push(`<table class="md-table"><thead>${thead}</thead><tbody>${tbody}</tbody></table>`);
        i = j - 1;
      } else { out.push(lines[i]); }
    }
    s = out.join("\n");
  }
  // links (http/https) — same trailing-punctuation handling as linkify
  s = s.replace(/https?:\/\/[^\s<]+/g, (m) => {
    let tail = ""; const t = m.match(/[)\].,;:!?]+$/);
    if (t) { tail = m.slice(m.length - t[0].length); m = m.slice(0, m.length - t[0].length); }
    return keep(`<a class="lnk" href="${m}" target="_blank" rel="noopener noreferrer">${m}</a>`) + tail;
  });
  // bold (before italic, so ** isn't eaten by the single-* rule)
  s = s.replace(/\*\*(?!\s)([^\n]+?)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/__(?!\s)([^\n_]+?)__/g, "<strong>$1</strong>");
  // italic — non-space inner edges + word-boundary for _ so snake_case is left alone
  s = s.replace(/(^|[^*])\*(?!\s)([^*\n]+?)\*(?!\*)/g, "$1<em>$2</em>");
  s = s.replace(/(^|[^_\w])_(?!\s)([^_\n]+?)_(?![\w_])/g, "$1<em>$2</em>");
  // headings (#/##/###) and bullet lines (- / *) -> their own styled lines
  s = s.replace(/^\s{0,3}#{1,3}\s+(.+)$/gm, '<span class="md-h">$1</span>');
  s = s.replace(/^\s*[-*]\s+(.+)$/gm, '<span class="md-li">$1</span>');
  // ISS-82: linkify bare task-id refs last — code spans/fences and URLs are already stashed,
  // so they're protected; emphasis/heading tags are skipped by taskRefs' tag-aware split.
  s = taskRefs(s);
  return s.replace(new RegExp(Z + "(\\d+)" + Z, "g"), (m, i) => stash[+i]);
};
