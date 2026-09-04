"""Rich conversation messages — render a SAFE inline-markdown subset (mdText).

Agent turns are full of **bold**, `code`, fenced ```blocks```, and - bullets; rendered as
raw text they look squishy. mdText() formats a curated subset. The security invariant is
the same as linkify: esc() FIRST, then format the escaped string — authored text can never
inject HTML.

Phase 7: vanilla app.js/conversation.js are retired. mdText lives in
frontend/src/lib/format.ts, rendered through the <Md> component (components/ui.tsx) into
the conversation turn body (pages/agents/Conversation.tsx); task threads keep <Linkified>.
The node harness that eval'd app.js moved to Vitest against the TS source:
frontend/src/lib/format.mdtext.test.ts (the full truth table: safety, the inline subset,
GFM tables, no false positives on prose).
"""
import pathlib

REPO = pathlib.Path(__file__).resolve().parent.parent
FRONTEND = REPO / "orcha-cli" / "orcha_cli" / "templates" / "portal" / "frontend" / "src"


def test_mdtext_is_defined_exported_and_wired():
    fmt = (FRONTEND / "lib" / "format.ts").read_text()
    assert "export const mdText" in fmt, "mdText not defined/exported"
    # esc-first (reuses esc), and code spans are STASHED before emphasis runs
    assert "esc(src == null" in fmt, "mdText doesn't escape first"
    body = fmt[fmt.index("export const mdText"):]
    assert body.index("md-code") < body.index("<strong>$1</strong>"), \
        "code spans not stashed before the emphasis pass (stars in code would bold)"
    # rendered through <Md> (trusted HTML seam) into the conversation turn body
    ui = (FRONTEND / "components" / "ui.tsx").read_text()
    assert "export function Md" in ui and "mdText(text" in ui, "<Md> doesn't render via mdText"
    conv = (FRONTEND / "pages" / "agents" / "Conversation.tsx").read_text()
    assert '<Md className="tx md" text={t.content' in conv, "conversation turn body not rendered via mdText"
    css = (FRONTEND / "pages" / "agents" / "agents.css").read_text()
    assert ".tx.md .md-code" in css and ".tx.md .md-pre" in css, "no markdown styling"
    assert ".tx.md .md-table" in css, "no table styling"


def test_mdtext_is_safe_and_formats_the_subset():
    """The behavioral truth table moved to Vitest against the real TS source:
    frontend/src/lib/format.mdtext.test.ts — safety (esc first, html neutralized,
    null-safe), the inline subset (bold/italic/code/fences/links/headings/bullets),
    GFM tables (thead/tbody, alignment, inline formatting in cells, ragged-row
    padding, single-line output), and no false positives on prose (snake_case,
    digits, lone stars, pipes). Here: pin the harness exists and keeps its beats."""
    t = (FRONTEND / "lib" / "format.mdtext.test.ts").read_text()
    for beat in (
        "escapes html",
        'not.toContain("<img")',
        'toContain("&lt;b&gt;")',
        'toBe("hi <strong>there</strong>")',
        'toBe("a <em>word</em> b")',
        '<code class="md-code">a * b</code>',        # inline code keeps stars
        '<pre class="md-pre"><code>x*y</code></pre>',
        '<a class="lnk" href="https://x.io/a"',
        '<span class="md-h">Title</span>',
        '<span class="md-li">item</span>',
        '<table class="md-table">',
        "<th>Name</th>",
        "text-align:center",
        "<strong>Frame</strong>",                     # inline formatting inside cells
        "<td></td>",                                  # ragged row padded
        "lone star untouched",
        "snake_case untouched",
        "pipe in prose is not a table",
        "null safe",
    ):
        assert beat in t, f"mdText truth table lost a beat: {beat}"
