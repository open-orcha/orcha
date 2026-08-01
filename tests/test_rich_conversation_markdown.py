"""Rich conversation messages — render SAFE markdown (Orcha.mdText).

Agent turns are full of **bold**, `code`, fenced ```blocks```, # headings, - bullets,
--- rules and [text](url) links; rendered as raw text they look squishy (the field bug:
literal #/**/---/backticks in the chat). mdText() is a BLOCK renderer for the chat-scale
subset — headings h1–h4, lists (nested ul/ol), blockquotes, hr, links, tables, paragraphs.
The security invariant is the same as linkify: esc() FIRST, then format the escaped
string — authored text can never inject HTML; link targets are http(s) only. Wired into
the conversation turn body (conversation.js) and the other agent-authored surfaces (task
thread, plan bodies, request payloads); styled by the shared styles/markdown.css (.md).
The deeper per-construct/XSS matrix lives in tests/portal/md_render.test.js.
"""
import pathlib
import shutil
import subprocess
import pytest
from portal_source import page_source, script_source, style_source

REPO = pathlib.Path(__file__).resolve().parent.parent
STATIC = REPO / "orcha-cli" / "orcha_cli" / "templates" / "portal" / "static"


def test_mdtext_is_defined_exported_and_wired():
    app = script_source("app.js")
    assert "const mdText" in app and "mdText," in app, "mdText not defined/exported"
    # esc-first (reuses esc), and code spans are stashed before emphasis runs
    assert "esc(src == null" in app, "mdText doesn't escape first"
    conv = script_source("conversation.js")
    assert "O().mdText(t.content" in conv, "conversation turn body not rendered via mdText"
    # shared markdown stylesheet (tokens only), loaded by the pages that render md
    css = style_source("styles/markdown.css")
    assert ".md .md-code" in css and ".md .md-pre" in css, "no markdown code styling"
    assert ".md .md-table" in css, "no table styling"
    assert ".md h1" in css and ".md h4" in css, "no chat-scale heading styling"
    assert ".md hr" in css and ".md-quote" in css, "no hr/blockquote styling"
    for page in ("agents.html", "tasks.html", "requests.html", "home.html"):
        assert 'styles/markdown.css' in page_source(page), f"{page} does not load markdown.css"


@pytest.mark.skipif(shutil.which("node") is None, reason="node not available")
def test_mdtext_is_safe_and_formats_the_subset():
    app_js = script_source("app.js")
    harness = r"""
global.window = {}; global.location = { search: "" }; global.localStorage = { getItem: () => null, setItem: () => {} };
global.document = { documentElement:{setAttribute(){}}, addEventListener(){}, getElementById:()=>null,
  createElement:()=>({classList:{add(){},remove(){}},addEventListener(){},style:{},appendChild(){}}), body:{appendChild(){}} };
__APPJS__
const M = window.Orcha.mdText;
const LF = window.Orcha.linkify;
const A = (name, cond) => { if (!cond) { console.error("FAIL: " + name); process.exit(1); } };

// SECURITY: html is neutralized, never emitted raw
A("escapes html", M("<img src=x onerror=alert(1)>").indexOf("<img") === -1 && M("<b>x</b>").indexOf("&lt;b&gt;") !== -1);
A("javascript: link rejected", M("[x](javascript:alert(1))").indexOf("<a") === -1);
// formatting — block output (paragraphs), inline subset inside
A("bold", M("hi **there**") === '<div class="md-p">hi <strong>there</strong></div>');
A("bold underscore", M("__x__") === '<div class="md-p"><strong>x</strong></div>');
A("italic", M("a *word* b") === '<div class="md-p">a <em>word</em> b</div>');
A("inline code keeps stars", M("use `a * b`").indexOf('<code class="md-code">a * b</code>') !== -1);
A("fenced block", M("```\nx*y\n```").indexOf('<pre class="md-pre"><code>x*y</code></pre>') !== -1);
A("autolink", M("see https://x.io/a.").indexOf('<a class="lnk" href="https://x.io/a"') !== -1);
A("md link", M("[docs](https://x.io/d)").indexOf('href="https://x.io/d"') !== -1);
// GH #202 review: a URL with a balanced (...) group (e.g. a Wikipedia article title) must
// keep the whole group in the href, not truncate at the inner `)`.
A("md link with balanced-paren URL", M("[docs](https://en.wikipedia.org/wiki/Function_(mathematics))").indexOf('href="https://en.wikipedia.org/wiki/Function_(mathematics)"') !== -1);
// GH #202 review round 2: the [text](url) lane above was fixed first, but a PLAIN pasted
// URL (no markdown link syntax) went through splitUrlTail()'s balance-scan AND a second,
// balance-UNAWARE punctuation trim that stripped the very ")" the scan had just kept —
// regressing the bare-URL autolink lane specifically. Pin it directly.
A("bare URL with balanced-paren tail keeps the whole URL in the href",
  M("see https://en.wikipedia.org/wiki/Function_(mathematics) now").indexOf('href="https://en.wikipedia.org/wiki/Function_(mathematics)"') !== -1);
A("bare URL with unbalanced trailing )) still peels the )) off",
  M("https://x.io/a))").indexOf('href="https://x.io/a"') !== -1 && M("https://x.io/a))").indexOf("</a>))") !== -1);
// same balance-aware trim is shared by the standalone linkify() helper (thread messages,
// request payloads, plan bodies) — pin it there too, not just inside mdText's bare-URL pass.
A("linkify(): bare URL with balanced-paren tail keeps the whole URL in the href",
  LF("https://en.wikipedia.org/wiki/Function_(mathematics)") === '<a class="lnk" href="https://en.wikipedia.org/wiki/Function_(mathematics)" target="_blank" rel="noopener noreferrer">https://en.wikipedia.org/wiki/Function_(mathematics)</a>');
// GH #202 review: "> ".repeat(5000)+"deep" is 10,004 chars (under the 100k conversation
// limit) and used to throw RangeError via recursive quote parsing; it must render safely.
A("deep blockquote does not throw", (() => { try { return M("> ".repeat(5000) + "deep").indexOf("<blockquote") !== -1; } catch (e) { return false; } })());
A("heading", M("# Title") === "<h1>Title</h1>");
A("heading scale caps at h4", M("##### deep") === "<h4>deep</h4>");
A("bullet list", M("- item") === "<ul><li>item</li></ul>");
A("ordered list", M("1. a\n2. b") === "<ol><li>a</li><li>b</li></ol>");
// GH #202 review: the child <ul> nests INSIDE its parent <li>, not as a sibling of it —
// <li>a</li><ul>… was invalid list structure that broke accessibility trees.
A("nested list", M("- a\n  - b") === "<ul><li>a<ul><li>b</li></ul></li></ul>");
A("blockquote", M("> q") === '<blockquote class="md-quote"><div class="md-p">q</div></blockquote>');
A("hr", M("a\n---\nb").indexOf("<hr>") !== -1);
A("paragraphs", M("a\n\nb") === '<div class="md-p">a</div><div class="md-p">b</div>');
A("line break", M("a\nb") === '<div class="md-p">a<br>b</div>');
// GFM tables
const TBL = M("| Name | Role |\n|------|:----:|\n| **Frame** | `eng` |\n| Tim | pm |");
A("table rendered", TBL.indexOf("<table class=\"md-table\">") !== -1 && TBL.indexOf("<thead>") !== -1 && TBL.indexOf("<tbody>") !== -1);
A("table header cells", TBL.indexOf("<th>Name</th>") !== -1);
A("table alignment", TBL.indexOf('text-align:center') !== -1);
A("inline formatting inside cells", TBL.indexOf("<strong>Frame</strong>") !== -1 && TBL.indexOf('class="md-code">eng</code>') !== -1);
A("ragged row padded", M("| a | b |\n|---|---|\n| 1 |").indexOf("<td></td>") !== -1);
A("table is one line (no inner newlines)", TBL.indexOf("\n") === -1);
// no false positives
A("snake_case untouched", M("call my_func_name") === '<div class="md-p">call my_func_name</div>');
A("digits not clobbered", M("I have 3 apples and 5 pears") === '<div class="md-p">I have 3 apples and 5 pears</div>');
A("lone star untouched", M("2 * 3 = 6") === '<div class="md-p">2 * 3 = 6</div>');
A("pipe in prose is not a table", M("use a | b for OR") === '<div class="md-p">use a | b for OR</div>');
A("null safe", M(null) === "" && M(undefined) === "");
console.log("OK");
"""
    out = subprocess.run(["node", "-e", harness.replace("__APPJS__", app_js)], capture_output=True, text=True)
    assert out.returncode == 0, (out.stdout + out.stderr)
    assert out.stdout.strip().splitlines()[-1] == "OK", out.stdout
