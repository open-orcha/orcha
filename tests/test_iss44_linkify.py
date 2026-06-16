"""ISS-44 — URLs in authored text are clickable (shared linkify), safely.

Every body/payload/reason/result/thread/conversation surface used to render via esc()
as escaped plain text, so a PR/issue/doc link an agent or human posted couldn't be
clicked. This adds a shared `Orcha.linkify()` (esc FIRST, then linkify the escaped text;
ONLY http(s)://; emit target=_blank rel="noopener noreferrer") and applies it to the
full-text authored surfaces. The esc-first ordering is the security invariant — authored
text can never inject HTML.
"""
import pathlib
import shutil
import subprocess
import pytest

REPO = pathlib.Path(__file__).resolve().parent.parent
STATIC = REPO / "orcha-cli" / "orcha_cli" / "templates" / "portal" / "static"


def test_linkify_is_applied_to_authored_text_surfaces():
    app = (STATIC / "app.js").read_text()
    assert "const linkify =" in app and "linkify," in app, "linkify not defined/exported"
    # the authored full-text surfaces switched from esc() to linkify()
    reqs = (STATIC / "requests.html").read_text()
    assert reqs.count("O.linkify(") >= 3, "request payload/response/reason not linkified"
    tasks = (STATIC / "tasks.html").read_text()
    assert "O.linkify(m.body)" in tasks, "task thread message not linkified"
    assert "O.linkify(isPlan" in tasks, "plan body / result not linkified (verification gate)"
    # BOTH task-result surfaces must linkify: the verification-gate result AND the normal
    # task-detail Result block — and neither may regress back to bare esc().
    assert "O.linkify(t.result)" in tasks, "normal task-detail Result not linkified"
    assert "O.esc(t.result)" not in tasks, "a task-result surface regressed to bare esc()"
    conv = (STATIC / "conversation.js").read_text()
    # conversation turns now render via mdText (rich markdown), which still linkifies URLs —
    # so authored-link coverage is preserved (see test_rich_conversation_markdown for the link case).
    assert "O().mdText(t.content" in conv, "conversation turn content not rendered (mdText)"
    home = (STATIC / "home.html").read_text()
    # the dashboard plan-approval card renders the FULL plan body → linkify (the last
    # full-text authored surface; "URLs clickable everywhere").
    assert "O.linkify(planText(t))" in home, "home dashboard plan-text not linkified"
    # ...but the activity-feed row text MUST stay esc(): the whole row is wrapped in an
    # <a class="act"> link, so linkifying it would nest <a> inside <a> (invalid HTML).
    assert "O.esc(e.text)" in home, "activity-feed text must stay esc() (it's inside a row anchor)"
    css = (STATIC / "styles.css").read_text()
    assert ".lnk" in css, "no link styling"


@pytest.mark.skipif(shutil.which("node") is None, reason="node not available to exercise client JS")
def test_linkify_behavior_is_safe_and_correct():
    app_js = (STATIC / "app.js").read_text()
    harness = r"""
global.localStorage = { getItem: () => null, setItem: () => {} };
global.document = { documentElement:{setAttribute(){},classList:{add(){},remove(){}}}, addEventListener(){},
  getElementById:()=>null, querySelector:()=>null, querySelectorAll:()=>[],
  createElement:()=>({classList:{add(){},remove(){}},addEventListener(){},style:{},appendChild(){}}),
  body:{appendChild(){}} };
global.window = {}; global.location = { search: "" };
__APPJS__
const L = window.Orcha.linkify;
const A = (name, cond) => { if (!cond) { console.error("FAIL: " + name); process.exit(1); } };

// 1) esc-first: embedded HTML is neutralized, never emitted raw
let r = L('hi <b>bold</b> http://a.com/x?y=1&z=2 end');
A("escapes html", r.indexOf("<b>") === -1 && r.indexOf("&lt;b&gt;") !== -1);
A("links http", r.indexOf('<a class="lnk" href="http://a.com/x?y=1&amp;z=2" target="_blank" rel="noopener noreferrer">') !== -1);
A("query amp escaped in text too", r.indexOf('>http://a.com/x?y=1&amp;z=2</a>') !== -1);

// 2) https works; exactly one anchor for one url
r = L('see https://example.org/path');
A("links https", (r.match(/<a /g) || []).length === 1 && r.indexOf('href="https://example.org/path"') !== -1);

// 3) NON-http schemes are NOT linkified (no javascript:/ftp: anchors)
A("no javascript scheme", L('javascript:alert(1)').indexOf("<a ") === -1);
A("no ftp scheme", L('ftp://host/file').indexOf("<a ") === -1);

// 4) trailing sentence punctuation stays OUTSIDE the link
r = L('go http://a.com. now');
A("trailing dot outside", r.indexOf('>http://a.com</a>. now') !== -1);
r = L('(ref http://a.com)');
A("trailing paren outside", r.indexOf('>http://a.com</a>)') !== -1);

// 5) plain text without a url is just escaped, unchanged otherwise
A("plain text passes through", L('no links "here" & <ok>').indexOf("<a ") === -1);
A("plain text escaped", L('a & b').indexOf("a &amp; b") !== -1);

// 6) null/undefined safe
A("null safe", L(null) === "" && L(undefined) === "");

console.log("OK");
"""
    out = subprocess.run(["node", "-e", harness.replace("__APPJS__", app_js)],
                         capture_output=True, text=True)
    assert out.returncode == 0, (out.stdout + out.stderr)
    assert out.stdout.strip().splitlines()[-1] == "OK", out.stdout
