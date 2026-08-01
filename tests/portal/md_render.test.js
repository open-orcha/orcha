/* ============================================================================
   Markdown renderer (Orcha.mdText, modules/app-text.js) — feat/chat-markdown.

   Field bug: an agent's long reply painted literal #, **bold**, ---, and
   backticks as plain text. mdText is now a full chat-scale BLOCK renderer:
   headings h1–h4, bold/italic, inline + fenced code, nested ul/ol, blockquotes,
   [text](https://…) links + bare-URL autolink, --- rules, GFM pipe tables,
   paragraphs/<br>. The security invariant is unchanged and non-negotiable:
   esc() FIRST — authored text can NEVER inject html; only renderer-built tags
   are emitted; link targets are http(s) only.

   PART A  XSS — script tags, event-handler attrs, injection via link text/url,
           javascript:/data: URLs rejected, forged NUL stash sentinels inert.
   PART B  every construct renders (h1–h4 + clamp, bold, italic, inline code,
           ul/ol + nesting + start=, blockquote, hr, links, autolink,
           image-as-link, paragraphs + line breaks, tables).
   PART C  fenced code is verbatim — no formatting runs inside a fence.
   PART D  no false positives (snake_case, lone *, prose pipes, null-safety).

   Dependency-free: the REAL modules/app-text.js in a vm sandbox.
   Run: node tests/portal/md_render.test.js
   ========================================================================== */
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const STATIC = path.join(
  __dirname, "..", "..",
  "orcha-cli", "orcha_cli", "templates", "portal", "static"
);

let failures = 0;
function assert(cond, msg) {
  if (cond) console.log("  ✓ " + msg);
  else { failures++; console.error("  ✗ " + msg); }
}

/* ---- sandbox: app-text.js only, with the task-roster dependency stubbed ---- */
const sandbox = { console };
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
// app-text's taskByRef reads the live roster via tasks() (app-data.js in the browser)
vm.runInContext('var tasks = () => [{ id: "e4b77f3f-0000-4000-8000-000000000000", title: "Ship it" }];', sandbox);
vm.runInContext(fs.readFileSync(path.join(STATIC, "modules", "app-text.js"), "utf8"),
  sandbox, { filename: "modules/app-text.js" });
const M = (s) => vm.runInContext("mdText(" + JSON.stringify(s) + ")", sandbox);
const LF = (s) => vm.runInContext("linkify(" + JSON.stringify(s) + ")", sandbox);

/* ---------------- PART A — XSS: authored text can never inject html -------- */
console.log("\nPART A — escaping\n");
{
  const a = M("<script>alert(1)</script>");
  assert(a.indexOf("<script") === -1 && a.indexOf("&lt;script&gt;") !== -1,
    "script tags are neutralized, shown as text");
  const b = M('<img src=x onerror=alert(1)>');
  assert(b.indexOf("<img") === -1 && b.indexOf("&lt;img") !== -1,
    "img/onerror payloads are neutralized");
  const c = M("[<b>evil</b>](https://x.io/a)");
  assert(c.indexOf("<b>") === -1 && c.indexOf("&lt;b&gt;") !== -1 && c.indexOf('href="https://x.io/a"') !== -1,
    "html in LINK TEXT stays escaped inside the anchor");
  const d = M('[x](https://x.io/"onmouseover="alert(1))');
  assert(d.indexOf('href="https://x.io/&quot;onmouseover=') !== -1,
    "a quote in the link URL cannot break out of the href attribute (stays &quot;)");
  const e = M("[click me](javascript:alert(1))");
  assert(e.indexOf("<a") === -1 && e.indexOf("javascript:alert(1)") !== -1,
    "javascript: link targets are REJECTED — left as literal text");
  const f = M("![pic](data:text/html,<script>alert(1)</script>)");
  assert(f.indexOf("<a") === -1 && f.indexOf("<script") === -1,
    "data: image targets are rejected too (and their html stays escaped)");
  const g = M("\u0000" + "0" + "\u0000 and `code`");
  assert(g.indexOf("\u0000") === -1 && g.indexOf('<code class="md-code">code</code>') !== -1,
    "a forged NUL stash sentinel in the input is stripped, never resolves a slot");
  const h = M("# <script>x</script>heading");
  assert(h.indexOf("<script") === -1 && h.indexOf("<h1>") !== -1,
    "escaping holds inside headings");
  // GH #202 review: the balanced-paren URL fix must not open an href-injection path — a
  // quote/tag inside a URL's balanced (...) group still has to come out escaped, and the
  // link syntax's own trailing `)` still has to close the href, not get glued into it.
  const i = M('[x](https://x.io/(a)"onmouseover="alert(1))');
  assert(i.indexOf('href="https://x.io/(a)&quot;onmouseover=&quot;alert(1)"') !== -1 && i.indexOf('onmouseover="alert') === -1,
    "a quote alongside a balanced-paren URL segment still can't break out of the href attribute");
  const j = M('[x](https://x.io/(<script>alert(1)</script>))');
  assert(j.indexOf("<script>") === -1 && j.indexOf("&lt;script&gt;") !== -1,
    "an html tag inside a balanced-paren URL segment still stays escaped, never live markup");
  // GH #202 review round 2: the balance-aware punctuation trim in splitUrlTail() is now
  // shared by the PLAIN bare-URL lane too (mdText's bare-URL pass + linkify()) — re-run the
  // same adversarial probes through that lane so the fix doesn't reopen href/tag injection.
  const k = M('https://x.io/(a)"onmouseover="alert(1)');
  assert(k.indexOf('href="https://x.io/(a)&quot;onmouseover=&quot;alert(1)"') !== -1 && k.indexOf('onmouseover="alert') === -1,
    "bare URL (mdText): a quote alongside a balanced-paren segment still can't break out of the href attribute");
  const l = M('https://x.io/(<script>alert(1)</script>)');
  assert(l.indexOf("<script>") === -1 && l.indexOf("&lt;script&gt;") !== -1,
    "bare URL (mdText): an html tag inside a balanced-paren segment still stays escaped, never live markup");
  const kL = LF('https://x.io/(a)"onmouseover="alert(1)');
  assert(kL.indexOf('href="https://x.io/(a)&quot;onmouseover=&quot;alert(1)"') !== -1 && kL.indexOf('onmouseover="alert') === -1,
    "bare URL (linkify): a quote alongside a balanced-paren segment still can't break out of the href attribute");
  const lL = LF('https://x.io/(<script>alert(1)</script>)');
  assert(lL.indexOf("<script>") === -1 && lL.indexOf("&lt;script&gt;") !== -1,
    "bare URL (linkify): an html tag inside a balanced-paren segment still stays escaped, never live markup");
}

/* ---------------- PART B — every construct renders ------------------------- */
console.log("\nPART B — constructs\n");
{
  assert(M("# One") === "<h1>One</h1>", "# -> h1");
  assert(M("## Two") === "<h2>Two</h2>", "## -> h2");
  assert(M("### Three") === "<h3>Three</h3>", "### -> h3");
  assert(M("#### Four") === "<h4>Four</h4>", "#### -> h4");
  assert(M("##### Five") === "<h4>Five</h4>", "h5/h6 clamp to chat-scale h4");
  assert(M("hi **there**") === '<div class="md-p">hi <strong>there</strong></div>', "bold");
  assert(M("a *word* b").indexOf("<em>word</em>") !== -1, "italic");
  assert(M("use `a * b`").indexOf('<code class="md-code">a * b</code>') !== -1, "inline code keeps stars");
  assert(M("- a\n- b") === "<ul><li>a</li><li>b</li></ul>", "unordered list");
  assert(M("1. a\n2. b") === "<ol><li>a</li><li>b</li></ol>", "ordered list");
  assert(M("3. a\n4. b").indexOf('<ol start="3">') === 0, "ordered list keeps its start number");
  // GH #202 review: the nested sub-list must render INSIDE its parent <li>, not as a
  // sibling of it — <li>a</li><ul>… is invalid list structure and breaks accessibility
  // trees. Correct shape nests the child <ul> inside <li>a…</li> before it closes.
  assert(M("- a\n  - b\n- c") === "<ul><li>a<ul><li>b</li></ul></li><li>c</li></ul>",
    "NESTED list — child <ul> nests INSIDE the parent <li>, dedent closes back out to a sibling <li>");
  assert(M("- a\n  1. b\n- c").indexOf("<ol><li>b</li></ol>") !== -1, "ordered list nests under a bullet");
  assert(M("> quoted") === '<blockquote class="md-quote"><div class="md-p">quoted</div></blockquote>', "blockquote");
  assert(M("> a\n> b").indexOf("a<br>b") !== -1, "multi-line blockquote keeps its lines");
  // GH #202 review: "> ".repeat(5000)+"deep" is 10,004 chars (well under the 100k conversation
  // limit) and used to throw RangeError — one recursive block-render call per nesting level.
  // Quote depth is now capped at a safe max; deeper input degrades to literal text instead of
  // crashing. This is the accepted-size regression test for that report.
  {
    let deepOut, threw = false;
    try { deepOut = M("> ".repeat(5000) + "deep"); } catch (e) { threw = true; }
    assert(!threw, "a 5000-deep blockquote run does not throw (was: RangeError, stack overflow)");
    assert(!threw && deepOut.indexOf("<blockquote") !== -1 && deepOut.indexOf("deep") !== -1,
      "…and still renders quote markup with the trailing text intact");
  }
  assert(M("a\n---\nb").indexOf("<hr>") !== -1, "--- renders a horizontal rule");
  assert(M("***").indexOf("<hr>") !== -1 && M("___").indexOf("<hr>") !== -1, "*** and ___ rules too");
  const L = M("see [the docs](https://x.io/docs) now");
  assert(L.indexOf('<a class="lnk" href="https://x.io/docs" target="_blank" rel="noopener noreferrer">the docs</a>') !== -1,
    "[text](url) link — target=_blank rel=noopener");
  // GH #202 review: a URL with a balanced (...) group — e.g. a Wikipedia article title like
  // Function_(mathematics) — must keep the whole group in the href, not truncate at the
  // inner `)` and leave the final `)` dangling outside the link as text.
  const PAREN = M("see [docs](https://en.wikipedia.org/wiki/Function_(mathematics)) now");
  assert(PAREN.indexOf('href="https://en.wikipedia.org/wiki/Function_(mathematics)"') !== -1,
    "[text](url) link with a balanced-paren URL keeps the whole URL in the href");
  assert(PAREN.indexOf(">docs</a>) now") === -1 && PAREN.indexOf(">docs</a> now") !== -1,
    "…and the link's own closing paren is consumed by the markdown syntax, not left dangling in the text");
  const AU = M("see https://x.io/a. done");
  assert(AU.indexOf('href="https://x.io/a"') !== -1 && AU.indexOf("</a>.") !== -1,
    "bare URL autolinks; trailing period stays outside the link");
  // GH #202 review round 2: splitUrlTail()'s balance-scan correctly kept a legitimate
  // trailing ")" (e.g. …Function_(mathematics)), but the punctuation-trim step that ran
  // right after it stripped that same balanced ")" back off — regressing the PLAIN pasted
  // URL lane (both mdText's bare-URL pass and the standalone linkify() helper) even though
  // the [text](url) lane above was fixed. Pin both lanes directly.
  const BARE_MD = M("see https://en.wikipedia.org/wiki/Function_(mathematics) now");
  assert(BARE_MD.indexOf('href="https://en.wikipedia.org/wiki/Function_(mathematics)"') !== -1,
    "mdText(): a PLAIN pasted URL with a balanced-paren tail keeps the whole URL in the href");
  assert(BARE_MD.indexOf(">https://en.wikipedia.org/wiki/Function_(mathematics)</a> now") !== -1,
    "…and nothing is left dangling as text after the anchor closes");
  const BARE_LINKIFY = LF("https://en.wikipedia.org/wiki/Function_(mathematics)");
  assert(BARE_LINKIFY === '<a class="lnk" href="https://en.wikipedia.org/wiki/Function_(mathematics)" target="_blank" rel="noopener noreferrer">https://en.wikipedia.org/wiki/Function_(mathematics)</a>',
    "linkify(): same plain-URL balanced-paren case, exact output");
  // sentence-level parens around a plain URL still work: the OUTER paren was never part of
  // the URL match to begin with, so it stays outside regardless of the URL's own parens.
  const BARE_SENTENCE = M("(see https://en.wikipedia.org/wiki/Function_(mathematics))");
  assert(BARE_SENTENCE.indexOf('href="https://en.wikipedia.org/wiki/Function_(mathematics)"') !== -1
    && BARE_SENTENCE.indexOf("</a>)</div>") !== -1,
    "a plain URL with its own balanced paren, itself inside a sentence's parens, splits at the right boundary");
  // genuinely unbalanced trailing close(s) on a plain URL still get peeled off, in both lanes.
  const UNBAL_MD = M("https://x.io/a))");
  assert(UNBAL_MD.indexOf('href="https://x.io/a"') !== -1 && UNBAL_MD.indexOf("</a>))") !== -1,
    "mdText(): an unbalanced trailing )) on a plain URL is still peeled off, not swallowed");
  const UNBAL_LINKIFY = LF("https://x.io/a))");
  assert(UNBAL_LINKIFY.indexOf('href="https://x.io/a"') !== -1 && UNBAL_LINKIFY.indexOf("</a>))") !== -1,
    "linkify(): same unbalanced-trailing-)) case");
  const IMG = M("![diagram](https://x.io/d.png)");
  assert(IMG.indexOf("<img") === -1 && IMG.indexOf(">diagram</a>") !== -1,
    "images render as plain LINKS (alt as text), never <img>");
  assert(M("a\n\nb") === '<div class="md-p">a</div><div class="md-p">b</div>', "blank line = new paragraph");
  assert(M("a\nb") === '<div class="md-p">a<br>b</div>', "single newline = <br> inside a paragraph");
  const TBL = M("| Name | Role |\n|------|:----:|\n| **Frame** | `eng` |\n| Tim | pm |");
  assert(TBL.indexOf('<table class="md-table">') !== -1 && TBL.indexOf("<th>Name</th>") !== -1
    && TBL.indexOf("text-align:center") !== -1 && TBL.indexOf("<strong>Frame</strong>") !== -1
    && TBL.indexOf('class="md-code">eng</code>') !== -1 && TBL.indexOf("\n") === -1,
    "GFM table renders (alignment + inline formatting in cells, single line)");
  assert(M("| a | b |\n|---|---|\n| 1 |").indexOf("<td></td>") !== -1, "ragged table row padded");
  assert(M("fixed in e4b77f3f").indexOf('class="tref"') !== -1, "bare task-id still becomes a task chip (ISS-82)");
  const MIX = M("# Plan\nintro\n\n- step one\n- step two\n\n```sh\nls -la\n```");
  assert(MIX.indexOf("<h1>Plan</h1>") === 0 && MIX.indexOf("<ul>") !== -1 && MIX.indexOf('<pre class="md-pre">') !== -1,
    "a realistic mixed reply renders all blocks in order");
}

/* ---------------- PART C — fenced code is verbatim ------------------------- */
console.log("\nPART C — fences\n");
{
  const F = M("```js\nconst a = 1 < 2 && **not bold**;\n# not a heading\n- not a bullet\n```");
  assert(F.indexOf('<pre class="md-pre"><code>const a = 1 &lt; 2 &amp;&amp; **not bold**;\n# not a heading\n- not a bullet</code></pre>') !== -1,
    "fence contents are VERBATIM — escaped, but no md formatting runs inside");
  assert(F.indexOf("<strong>") === -1 && F.indexOf("<h1>") === -1 && F.indexOf("<ul>") === -1,
    "…no bold/heading/list leaked out of the fence");
  assert(M("```\nx*y\n```").indexOf("<code>x*y</code>") !== -1, "unlabelled fence works");
}

/* ---------------- PART D — no false positives ------------------------------ */
console.log("\nPART D — false positives\n");
{
  assert(M("call my_func_name") === '<div class="md-p">call my_func_name</div>', "snake_case untouched");
  assert(M("2 * 3 = 6") === '<div class="md-p">2 * 3 = 6</div>', "lone star untouched");
  assert(M("use a | b for OR") === '<div class="md-p">use a | b for OR</div>', "pipe in prose is not a table");
  assert(M("version 1.2 shipped") === '<div class="md-p">version 1.2 shipped</div>',
    "a version number mid-sentence is not an ordered list");
  assert(M(null) === "" && M(undefined) === "" && M("") === "", "null/undefined/empty safe");
}

console.log("");
if (failures) { console.error(failures + " FAILURE(S)"); process.exit(1); }
console.log("ALL PASS");
