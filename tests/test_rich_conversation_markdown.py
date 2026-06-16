"""Rich conversation messages — render a SAFE inline-markdown subset (Orcha.mdText).

Agent turns are full of **bold**, `code`, fenced ```blocks```, and - bullets; rendered as
raw text they look squishy. mdText() formats a curated subset. The security invariant is the
same as linkify: esc() FIRST, then format the escaped string — authored text can never inject
HTML. Wired into the conversation turn body (conversation.js); task threads keep linkify.
"""
import pathlib
import re
import shutil
import subprocess
import pytest

REPO = pathlib.Path(__file__).resolve().parent.parent
STATIC = REPO / "orcha-cli" / "orcha_cli" / "templates" / "portal" / "static"


def test_mdtext_is_defined_exported_and_wired():
    app = (STATIC / "app.js").read_text()
    assert "const mdText" in app and "mdText," in app, "mdText not defined/exported"
    # esc-first (reuses esc), and code spans are stashed before emphasis runs
    assert "esc(src == null" in app, "mdText doesn't escape first"
    conv = (STATIC / "conversation.js").read_text()
    assert "O().mdText(t.content" in conv, "conversation turn body not rendered via mdText"
    css = (STATIC / "agents.html").read_text()
    assert ".tx.md .md-code" in css and ".tx.md .md-pre" in css, "no markdown styling"
    assert ".tx.md .md-table" in css, "no table styling"


@pytest.mark.skipif(shutil.which("node") is None, reason="node not available")
def test_mdtext_is_safe_and_formats_the_subset():
    app_js = (STATIC / "app.js").read_text()
    harness = r"""
global.window = {}; global.location = { search: "" }; global.localStorage = { getItem: () => null, setItem: () => {} };
global.document = { documentElement:{setAttribute(){}}, addEventListener(){}, getElementById:()=>null,
  createElement:()=>({classList:{add(){},remove(){}},addEventListener(){},style:{},appendChild(){}}), body:{appendChild(){}} };
__APPJS__
const M = window.Orcha.mdText;
const A = (name, cond) => { if (!cond) { console.error("FAIL: " + name); process.exit(1); } };

// SECURITY: html is neutralized, never emitted raw
A("escapes html", M("<img src=x onerror=alert(1)>").indexOf("<img") === -1 && M("<b>x</b>").indexOf("&lt;b&gt;") !== -1);
// formatting
A("bold", M("hi **there**") === "hi <strong>there</strong>");
A("bold underscore", M("__x__") === "<strong>x</strong>");
A("italic", M("a *word* b") === "a <em>word</em> b");
A("inline code keeps stars", M("use `a * b`").indexOf('<code class="md-code">a * b</code>') !== -1);
A("fenced block", M("```\nx*y\n```").indexOf('<pre class="md-pre"><code>x*y</code></pre>') !== -1);
A("link", M("see https://x.io/a.").indexOf('<a class="lnk" href="https://x.io/a"') !== -1);
A("heading", M("# Title").indexOf('<span class="md-h">Title</span>') !== -1);
A("bullet", M("- item").indexOf('<span class="md-li">item</span>') !== -1);
// GFM tables
const TBL = M("| Name | Role |\n|------|:----:|\n| **Frame** | `eng` |\n| Tim | pm |");
A("table rendered", TBL.indexOf("<table class=\"md-table\">") !== -1 && TBL.indexOf("<thead>") !== -1 && TBL.indexOf("<tbody>") !== -1);
A("table header cells", TBL.indexOf("<th>Name</th>") !== -1);
A("table alignment", TBL.indexOf('text-align:center') !== -1);
A("inline formatting inside cells", TBL.indexOf("<strong>Frame</strong>") !== -1 && TBL.indexOf('class="md-code">eng</code>') !== -1);
A("ragged row padded", M("| a | b |\n|---|---|\n| 1 |").indexOf("<td></td>") !== -1);
A("table is one line (no inner newlines)", TBL.indexOf("\n") === -1);
// no false positives
A("snake_case untouched", M("call my_func_name") === "call my_func_name");
A("digits not clobbered", M("I have 3 apples and 5 pears") === "I have 3 apples and 5 pears");
A("lone star untouched", M("2 * 3 = 6") === "2 * 3 = 6");
A("pipe in prose is not a table", M("use a | b for OR") === "use a | b for OR");
A("null safe", M(null) === "" && M(undefined) === "");
console.log("OK");
"""
    out = subprocess.run(["node", "-e", harness.replace("__APPJS__", app_js)], capture_output=True, text=True)
    assert out.returncode == 0, (out.stdout + out.stderr)
    assert out.stdout.strip().splitlines()[-1] == "OK", out.stdout
