"""ISS-44 — URLs in authored text are clickable (shared linkify), safely.

Every body/payload/reason/result/thread/conversation surface used to render via esc()
as escaped plain text, so a PR/issue/doc link an agent or human posted couldn't be
clicked. The shared linkify (esc FIRST, then linkify the escaped text; ONLY http(s)://;
emit target=_blank rel="noopener noreferrer") now lives in the React frontend at
frontend/src/lib/format.ts, applied via the <Linkified>/<Md> components (ui.tsx).
The esc-first ordering is the security invariant — authored text can never inject HTML.

MIGRATED (portal React migration Phase 7): the vanilla static/{app.js,*.html} greps
are repointed at the React SOURCE; the node behavioral harness moved to Vitest —
frontend/src/lib/format.iss44.test.ts (plus foundation.test.ts's esc-first case).
"""
import pathlib
import re

REPO = pathlib.Path(__file__).resolve().parent.parent
PORTAL = REPO / "orcha-cli" / "orcha_cli" / "templates" / "portal"
SRC = PORTAL / "frontend" / "src"


def test_linkify_is_applied_to_authored_text_surfaces():
    fmt = (SRC / "lib" / "format.ts").read_text()
    assert "export const linkify" in fmt, "linkify not defined/exported"
    # the shared render components run the authored text through linkify/mdText
    ui = (SRC / "components" / "ui.tsx").read_text()
    assert "linkify(text" in ui and "mdText(text" in ui, "Linkified/Md don't render via linkify/mdText"
    # request payload/response/rejection reason are linkified
    # V2: payload/response/reason render through PayloadView (requestPayload.tsx) —
    # prose via <Md> (mdText linkifies), short field values via <Linkified>.
    reqs = (SRC / "pages" / "requests" / "RequestsPage.tsx").read_text()
    for field in ("r.payload", "r.response", "r.rejection_reason"):
        assert re.search(r"<PayloadView value=\{[^}]*" + re.escape(field), reqs), f"request {field} not rendered via PayloadView"
    rp = (SRC / "pages" / "requests" / "requestPayload.tsx").read_text()
    assert "<Md text={value}" in rp and "<Linkified text={v}" in rp, \
        "request payload prose / short values not linkified"
    tasks = "".join((SRC / "pages" / "tasks" / f).read_text() for f in ("TasksPage.tsx", "TaskDetail.tsx"))
    # V2: thread messages / plan bodies / results render as markdown via <Md> (mdText,
    # which runs the esc-first linkifier), so URLs stay clickable.
    assert 'text={m.body} tasks={snap?.tasks}' in tasks and '<Md className="bubble wk-md" text={m.body}' in tasks, \
        "task thread message not linkified"
    # Linear round 3: the plan body passes through stripPlanHeading (drops only a
    # leading "## Plan" line — test_b10_plan_approval pins that behaviorally).
    assert re.search(r'<ClampedMd text=\{stripPlanHeading\(pm\?\.body \|\| ""\)\}', tasks) \
        and "<ResultView r={t.result}" in tasks, \
        "plan body / result not linkified (verification gate)"
    # BOTH task-result surfaces must linkify: the verification-gate result AND the normal
    # task-detail Result block — and neither may regress back to bare esc(). Since #66 the
    # result passes through resultText() first (JSONB results are normalized to text so
    # structured results never render as [object Object]) — the pin follows the wrap.
    # V2: both result surfaces go through ResultView — prose → ClampedMd (<Md>), JSONB
    # objects → the shared Payload primitive (never [object Object] / raw JSON).
    assert tasks.count("<ResultView r={t.result}") >= 2, "normal task-detail Result not linkified"
    assert 'return <ClampedMd text={r} tasks={tasks} what="result" />' in tasks and "<Payload value={r}" in tasks, \
        "ResultView doesn't render prose via Md / objects via Payload"
    assert "esc(t.result)" not in tasks, "a task-result surface regressed to bare esc()"
    conv = (SRC / "pages" / "agents" / "Conversation.tsx").read_text()
    # conversation turns render via mdText (rich markdown), which still linkifies URLs —
    # so authored-link coverage is preserved (foundation.test.ts pins the link case).
    assert '<Md className="tx md" text={t.content' in conv, "conversation turn content not rendered (mdText)"
    home = (SRC / "pages" / "home" / "HomePage.tsx").read_text()
    # the dashboard plan-approval card renders the FULL plan body → linkify (the last
    # full-text authored surface; "URLs clickable everywhere").
    assert "<Linkified text={planText(t)}" in home, "home dashboard plan-text not linkified"
    # ...but the update-feed preview text MUST NOT be linkified: it is a clipped one-line
    # preview next to the task link (Linear Pulse, D10) — the full, linkified text lives in
    # the task thread. It renders as plain JSX (auto-escaped), never <Linkified>.
    assert "function FeedEvent" in home, "update feed row missing"
    assert "<Linkified text={e.text}" not in home, "activity-feed text must stay plain (it's inside a row anchor)"
    # cloud: styles.css is an @import entrypoint; .lnk lives in the styles/ modules
    css_dir = PORTAL / "static"
    blobs = [(css_dir / "styles.css").read_text()]
    blobs += [f.read_text() for f in (css_dir / "styles").glob("*.css")]
    assert any(".lnk" in b for b in blobs), "no link styling"


def test_linkify_behavior_is_safe_and_correct():
    """The behavioral cases (esc-first neutralization, http(s)-only schemes, trailing
    punctuation, null-safety) moved to Vitest: frontend/src/lib/format.iss44.test.ts.
    Here we pin the wire-visible security invariant in the SOURCE: linkify escapes
    FIRST, only then rewrites http(s) URLs, and anchors are hardened."""
    fmt = (SRC / "lib" / "format.ts").read_text()
    # esc runs before the URL rewrite (the esc-first security ordering)
    assert "esc(s == null" in fmt and "https?:\\/\\/" in fmt, "linkify doesn't escape before matching http(s) URLs"
    assert 'target="_blank" rel="noopener noreferrer"' in fmt, "linkify anchors not hardened"
