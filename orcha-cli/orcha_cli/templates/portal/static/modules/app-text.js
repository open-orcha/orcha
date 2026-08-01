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
// GH #202 review (round 2): a URL that legitimately contains a balanced `(...)` group — e.g.
// a Wikipedia article title like Function_(mathematics) — must keep that group INSIDE the
// URL; only a genuinely unbalanced trailing `)` (closing a surrounding markdown/sentence
// paren) gets peeled off. Count parens left-to-right and stop the URL at the first `)`
// that would go negative (nothing left open to close), same rule the [text](url) balanced
// matcher below (URL_IN_PARENS) encodes structurally. Shared by bare-URL autolinking (mdText + linkify).
//
// Round-1 fix only did the depth-scan above; round 2 found that the trailing-punctuation
// trim that followed re-stripped the very `)` the scan had just kept, because it matched
// `)` unconditionally. The trim below is now balance-aware: walking right-to-left, a `)`
// is only peeled off when it is UNBALANCED in what's left of `url` (no earlier `(` to match
// it) — the same rule as the scan. Every other character in the punctuation class still
// trims unconditionally.
function splitUrlTail(m) {
  let depth = 0, cut = m.length;
  for (let i = 0; i < m.length; i++) {
    const c = m[i];
    if (c === "(") depth++;
    else if (c === ")") { if (depth === 0) { cut = i; break; } depth--; }
  }
  let url = m.slice(0, cut), tail = m.slice(cut);
  let end = url.length;                   // (text is escaped, so quotes/apostrophes are entities)
  while (end > 0 && /[)\].,;:!?]/.test(url[end - 1])) {
    if (url[end - 1] === ")") {
      let bal = 0;
      for (let i = 0; i < end; i++) { if (url[i] === "(") bal++; else if (url[i] === ")") bal--; }
      if (bal >= 0) break;                // balanced (or no opener at all) — keep it, stop trimming
    }
    end--;
  }
  if (end < url.length) { tail = url.slice(end) + tail; url = url.slice(0, end); }
  return [url, tail];
}
// ISS-44: make URLs in authored text clickable. SAFETY: esc() FIRST (so the text can never
// inject HTML), THEN linkify the escaped string — only http(s):// URLs, emitting an anchor
// with target=_blank + rel=noopener noreferrer. Returns trusted HTML (already escaped).
// Trailing sentence punctuation / a closing bracket is left OUTSIDE the link, never swallowed
// — but a BALANCED `(...)` group inside the URL (e.g. …Function_(mathematics)) stays in the
// href (GH #202 review).
// ISS-82: after URL-linkify, run taskRefs so bare task-id mentions become [task name] chips
// too (anchor-aware, so a task-id inside a linked URL is left alone).
const linkify = (s) => taskRefs(esc(s == null ? "" : String(s)).replace(/https?:\/\/[^\s<]+/g, (m) => {
  const [url, tail] = splitUrlTail(m);
  return `<a class="lnk" href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>${tail}`;
}));
// Render SAFE markdown for agent-authored chat text — the full chat-scale subset:
// headings h1–h4, bold/italic, `code` + fenced blocks, ordered/unordered (nested) lists,
// blockquotes, [text](https://…) links + bare-URL autolink, --- rules, GFM pipe tables,
// and paragraphs/line breaks. SECURITY: esc() FIRST so authored text can never inject
// HTML — every pass below operates on the escaped string and only renderer-built tags
// are emitted. NO raw-html passthrough; images render as plain links (no <img>: remote
// fetches are a tracking/spoofing vector); link targets are http(s) ONLY, so
// javascript:/data: URLs stay literal text. Code spans/fences and anchors are stashed
// behind a NUL sentinel (stripped from the input first, so a forged sentinel can't
// address the stash) before emphasis runs, keeping their literal *_` and URLs intact.
// Output is BLOCK html — pair with the `md` container class (styles/markdown.css).
const mdText = (src) => {
  let s = esc(src == null ? "" : String(src)).replace(/\u0000/g, "");
  const stash = [];
  const Z = String.fromCharCode(0);   // sentinel — just stripped from the input, so it never collides
  const keep = (html) => { stash.push(html); return Z + (stash.length - 1) + Z; };
  const anchor = (url, text) => keep(`<a class="lnk" href="${url}" target="_blank" rel="noopener noreferrer">${text}</a>`);
  // fenced code block  ```lang\n…```  — contents verbatim (already escaped), never formatted
  s = s.replace(/```[^\n`]*\n?([\s\S]*?)```/g, (m, code) => keep(`<pre class="md-pre"><code>${code.replace(/\n+$/, "")}</code></pre>`));
  // inline code  `…`
  s = s.replace(/`([^`\n]+)`/g, (m, code) => keep(`<code class="md-code">${code}</code>`));
  // ![alt](url) images -> plain links, then [text](url) links — http(s) only. GH #202 review:
  // the url may contain ONE level of balanced (...) — e.g. …Function_(mathematics) — which
  // must stay inside the href rather than truncating at the inner `)`.
  const URL_IN_PARENS = "https?:\\/\\/(?:[^\\s()]|\\([^\\s()]*\\))*";
  s = s.replace(new RegExp("!\\[([^\\]\\n]*)\\]\\((" + URL_IN_PARENS + ")\\)", "g"), (m, alt, url) => anchor(url, alt || url));
  s = s.replace(new RegExp("\\[([^\\]\\n]+)\\]\\((" + URL_IN_PARENS + ")\\)", "g"), (m, text, url) => anchor(url, text));
  // bare URLs — trailing sentence punctuation / a closing bracket stays OUTSIDE the link,
  // but a balanced (...) group inside the URL stays IN it (GH #202 review; see splitUrlTail).
  s = s.replace(/https?:\/\/[^\s<]+/g, (m) => {
    const [url, tail] = splitUrlTail(m);
    return anchor(url, url) + tail;
  });
  // bold (before italic, so ** isn't eaten by the single-* rule)
  s = s.replace(/\*\*(?!\s)([^\n]+?)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/__(?!\s)([^\n_]+?)__/g, "<strong>$1</strong>");
  // italic — non-space inner edges + word-boundary for _ so snake_case is left alone
  s = s.replace(/(^|[^*])\*(?!\s)([^*\n]+?)\*(?!\*)/g, "$1<em>$2</em>");
  s = s.replace(/(^|[^_\w])_(?!\s)([^_\n]+?)_(?![\w_])/g, "$1<em>$2</em>");

  /* ---- block pass: line groups -> tables/headings/hr/quotes/lists/paragraphs ---- */
  const SLOT_LINE = new RegExp("^" + Z + "(\\d+)" + Z + "$");
  const LIST_RE = /^(\s*)(?:([-*+])|(\d{1,9})[.)])\s+(\S.*)$/;
  const splitRow = (line) => line.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
  const isDelim = (line) => line != null && /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)+\|?\s*$/.test(line);
  const cell = (c, tag, al) => `<${tag}${al ? ` style="text-align:${al}"` : ""}>${c}</${tag}>`;
  // GH #202 review: quote nesting depth is attacker-controlled ("> ".repeat(5000)+"deep" is
  // one line with 5000 leading markers) and blocks() recurses once per level, so an uncapped
  // depth throws RangeError (stack overflow) well under the 100k conversation char limit.
  // MAX_QUOTE_DEPTH bounds the recursion to a trivially-safe depth; a run nested deeper than
  // that renders its excess `>` markers as literal text in the innermost quote instead of
  // opening more <blockquote> levels — never crashes, degrades to a safe, readable fallback.
  const MAX_QUOTE_DEPTH = 32;
  const blocks = (lines, depth) => {
    depth = depth || 0;
    const out = [], para = [];
    const flushP = () => { if (para.length) { out.push(`<div class="md-p">${para.join("<br>")}</div>`); para.length = 0; } };
    for (let i = 0; i < lines.length; i++) {
      const ln = lines[i];
      // GFM table: header row + |---|:--:| delimiter + data rows, rendered as ONE line.
      // Cells already carry inline formatting; code is stashed, so a `pipe|in|code`
      // span can't be mistaken for columns. Checked before hr so |---| isn't a rule.
      if (ln.indexOf("|") >= 0 && isDelim(lines[i + 1])) {
        flushP();
        const head = splitRow(ln);
        const aligns = splitRow(lines[i + 1]).map((c) => {
          const L = c.startsWith(":"), R = c.endsWith(":");
          return L && R ? "center" : R ? "right" : L ? "left" : "";
        });
        const rows = []; let j = i + 2;
        for (; j < lines.length && lines[j].indexOf("|") >= 0 && lines[j].trim() !== ""; j++) rows.push(splitRow(lines[j]));
        const thead = "<tr>" + head.map((c, k) => cell(c, "th", aligns[k])).join("") + "</tr>";
        const tbody = rows.map((r) => "<tr>" + head.map((_, k) => cell(r[k] == null ? "" : r[k], "td", aligns[k])).join("") + "</tr>").join("");
        out.push(`<table class="md-table"><thead>${thead}</thead><tbody>${tbody}</tbody></table>`);
        i = j - 1; continue;
      }
      if (!ln.trim()) { flushP(); continue; }                     // blank line = paragraph break
      const slot = ln.trim().match(SLOT_LINE);                    // a fenced block alone on its line
      if (slot && stash[+slot[1]].startsWith("<pre")) { flushP(); out.push(ln.trim()); continue; }
      const h = ln.match(/^\s{0,3}(#{1,6})\s+(.+)$/);             // headings — h5/h6 clamp to chat-scale h4
      if (h) { flushP(); const lvl = Math.min(h[1].length, 4); out.push(`<h${lvl}>${h[2].trim()}</h${lvl}>`); continue; }
      if (/^\s{0,3}(?:-{3,}|_{3,}|\*{3,})\s*$/.test(ln)) { flushP(); out.push("<hr>"); continue; }
      if (/^\s{0,3}&gt;/.test(ln)) {                              // blockquote run (a literal > is &gt; post-esc)
        flushP();
        const inner = [];
        while (i < lines.length && /^\s{0,3}&gt;/.test(lines[i])) { inner.push(lines[i].replace(/^\s{0,3}&gt;\s?/, "")); i++; }
        i--;
        // at the depth cap, stop recursing: render the collected lines (any further leading
        // &gt; markers left inside them) as literal quote content, not another nested level.
        out.push(depth + 1 >= MAX_QUOTE_DEPTH
          ? `<blockquote class="md-quote"><div class="md-p">${inner.join("<br>")}</div></blockquote>`
          : `<blockquote class="md-quote">${blocks(inner, depth + 1)}</blockquote>`);
        continue;
      }
      if (LIST_RE.test(ln)) {                                     // list run — nested via 2-space indent steps
        flushP();
        const items = [];
        while (i < lines.length) {
          const im = lines[i].match(LIST_RE);
          if (!im) break;
          items.push({ ind: im[1].replace(/\t/g, "  ").length, ol: im[3] != null, num: im[3] ? +im[3] : 0, text: im[4].trim() });
          i++;
        }
        i--;
        // GH #202 review: a nested sub-list must render INSIDE its parent <li>, not as a
        // sibling of it (the old code always closed a parent's <li> immediately, so a
        // deeper item's <ul>/<ol> landed after </li> — invalid list structure that breaks
        // accessibility trees). Track whether the current level's <li> is still open and
        // only close it right before a same-level sibling <li>, or when the list itself closes
        // — a deeper indent opens its nested list INSIDE the still-open parent <li>.
        const stack = []; let lh = "";
        const open = (it) => { lh += it.ol ? (it.num > 1 ? `<ol start="${it.num}">` : "<ol>") : "<ul>"; stack.push({ ind: it.ind, ol: it.ol, liOpen: false }); };
        const closeLi = () => { if (stack.length && stack[stack.length - 1].liOpen) { lh += "</li>"; stack[stack.length - 1].liOpen = false; } };
        const close = () => { closeLi(); lh += stack.pop().ol ? "</ol>" : "</ul>"; };
        items.forEach((it) => {
          if (!stack.length || it.ind >= stack[stack.length - 1].ind + 2) open(it);
          else {
            while (stack.length > 1 && it.ind <= stack[stack.length - 1].ind - 2) close();
            if (stack[stack.length - 1].ol !== it.ol) { close(); open(it); }
            else closeLi();
          }
          lh += `<li>${it.text}`;
          stack[stack.length - 1].liOpen = true;
        });
        while (stack.length) close();
        out.push(lh); continue;
      }
      para.push(ln);
    }
    flushP();
    return out.join("");
  };
  s = blocks(s.split("\n"));
  // ISS-82: linkify bare task-id refs last — code spans/fences and URLs are already stashed,
  // so they're protected; block/emphasis tags are skipped by taskRefs' tag-aware split.
  s = taskRefs(s);
  // un-stash (bounded loop: a markdown link's text may itself hold an inline-code slot)
  for (let g = 0; g < 5 && s.indexOf(Z) >= 0; g++) s = s.replace(new RegExp(Z + "(\\d+)" + Z, "g"), (m, i) => stash[+i]);
  return s;
};
