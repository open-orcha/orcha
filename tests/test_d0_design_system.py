"""FT-SURFACE (D0) — portal design-system foundation (styles.css + the React shell).

D0 landed the shared frontend the D-series builds on: a token/theme stylesheet and an
app shell mounted data-driven against the real backend snapshot. The vanilla app.js is
retired by the React migration (docs/orcha-portal-react-migration-plan.md Phase 7): the
shell now lives in the React SOURCE at portal/frontend/src (SnapshotProvider + Shell +
useRunStream), compiled into static/dist/. The automatable surface is (a) the portal
serves the token layer + the SPA shell, (b) the foundation is data-driven (acting-as
resolves the real kind='human' agent — never a hardcoded name), (c) the live-feed
engine folds in the real SSE client. The mounted-shell behaviour that was exercised by
eval'ing app.js in node is now covered functionally by the frontend Vitest suite
(frontend/src/state/snapshot.test.ts).
"""
import pathlib
import pytest

pytestmark = pytest.mark.asyncio

REPO = pathlib.Path(__file__).resolve().parent.parent
PORTAL = REPO / "orcha-cli" / "orcha_cli" / "templates" / "portal"
STATIC = PORTAL / "static"
FRONTEND = PORTAL / "frontend" / "src"


# ---------- the portal serves the foundation ----------

async def test_assets_are_served(client):
    css = await client.get("/assets/styles.css")
    assert css.status_code == 200, css.text
    assert "text/css" in css.headers.get("content-type", "")
    assert "--accent" in css.text and "[data-theme" in css.text  # token layer + theme

    # the React SPA shell (built bundle) is served at every page route
    r = await client.get("/")
    assert r.status_code == 200, r.text
    assert "text/html" in r.headers.get("content-type", "")
    assert 'id="root"' in r.text, "no SPA mount point"
    assert "/assets/dist/" in r.text, "shell doesn't load the dist bundle"


def test_missing_static_dir_yields_404_not_crash_or_500():
    """Review P2/P3: a mis-provisioned old stack with no portal/static/ must still BOOT
    (so _serve can show its styled 503) AND a hit to /assets/* must be a harmless 404 —
    not an import-time RuntimeError (#13) and not a runtime 500 (Starlette's lazy
    check_config on a missing dir). The fix mounts ONLY when the dir exists."""
    main_py = (REPO / "orcha-cli" / "orcha_cli" / "templates" / "portal" / "main.py").read_text()
    assert "_STATIC_DIR.is_dir()" in main_py, "mount must be guarded by an is_dir() check"
    # reproduce the pattern over a non-existent dir and exercise the real request path
    from fastapi import FastAPI
    from fastapi.staticfiles import StaticFiles
    from fastapi.testclient import TestClient
    app = FastAPI()
    sdir = pathlib.Path("/no/such/orcha/static")
    if sdir.is_dir():  # mirrors main.py — skipped, so no mount, no crash
        app.mount("/assets", StaticFiles(directory=str(sdir), check_dir=False))

    @app.get("/")
    def _root():
        return {"ok": True}

    c = TestClient(app)
    assert c.get("/").status_code == 200          # the stack BOOTS
    assert c.get("/assets/styles.css").status_code == 404   # harmless 404, NOT 500


# ---------- styles.css: token layer + status system ----------

def test_styles_has_tokens_themes_and_pills():
    css = (STATIC / "styles.css").read_text()
    assert "[data-theme" in css, "no theme switch"
    assert "prefers-color-scheme" in css, "auto theme doesn't follow OS"
    for tok in ("--accent", "--amber", "--ok", "--warn", "--danger", "--violet"):
        assert tok in css, f"missing token {tok}"
    for pillcls in (".s-working", ".s-attn", ".s-done", ".s-idle"):
        assert pillcls in css, f"missing status pill class {pillcls}"


# ---------- React foundation: the D0 adaptations, now in frontend/src ----------

def test_react_foundation_is_data_driven():
    """The D0 adaptations survive the React port (frontend/src/state/SnapshotProvider.tsx):
    acting-as is DATA-DRIVEN — the real kind='human' agent, never hardcoded — and the
    shared accessors read the live snapshot."""
    sp = (FRONTEND / "state" / "SnapshotProvider.tsx").read_text()
    assert "export function actingHuman" in sp, "acting-as not data-driven"
    assert 'kind === "human"' in sp, "doesn't resolve the human from the snapshot"
    assert "Dario" not in sp, "acting-as still references the mock name"
    assert "export function agentByAlias" in sp, "agentByAlias not derived from the snapshot"
    assert "export function attnItems" in sp, "no shared attention aggregation"
    # behaviour exercised in frontend/src/state/snapshot.test.ts (Vitest)


def test_react_run_feed_folds_in_the_real_sse_client():
    """The live-feed engine (was app.js startRunStream) is hooks/useRunStream.ts: per-run
    EventSource, stream_timeout reconnect, and the monotonic seq guard against replay."""
    rs = (FRONTEND / "hooks" / "useRunStream.ts").read_text()
    assert "new EventSource(" in rs, "run feed not wired to the SSE endpoint"
    assert '"/stream"' in rs, "not the per-run stream endpoint"
    assert 'd.status === "stream_timeout"' in rs, "stream_timeout not treated as reconnectable"
    assert "d.seq <= maxSeq" in rs, "no monotonic guard against reconnect replay"
    assert "export function classifyLine" in (FRONTEND / "lib" / "classify.ts").read_text(), \
        "no shared stream-json classifier"


def test_shell_brand_and_needs_you():
    """The shell keeps the D0 action-queue affordances and renders no third-party maker
    attribution (main: the old "Developed by" footer + .ql-* mark are gone), and
    'Needs you' renders from the SHARED attention selector. V2 (arch §3): the one
    definition is state/attention.ts selectAttention/useAttention — the shell and the
    sidebar consume it instead of attnItems (GAP-01/GAP-04)."""
    shell = (FRONTEND / "shell" / "Shell.tsx").read_text()
    sidebar = (FRONTEND / "shell" / "Sidebar.tsx").read_text()
    both = shell + sidebar
    assert 'className="maker"' not in both and "v2-sb-maker" not in both, "maker attribution block is back"
    assert "ql-" not in both, "maker mark classes are back in the shell"
    assert "ef3b43" not in both.lower(), "old red brand dot is back"
    assert "Needs you" in both, "no Needs-you action queue in the shell"
    assert "useAttention" in shell and "useAttention" in sidebar, \
        "shell/sidebar don't count via the shared attention selector"
    attention = (FRONTEND / "state" / "attention.ts").read_text()
    assert "export function selectAttention" in attention
    selector_body = attention.split("export function selectAttention")[1].split("export function")[0]
    assert "task_open_total" not in selector_body and "request_open_total" not in selector_body, \
        "attention must never count open-work totals (GAP-01)"
    assert "Dario" not in both, "shell still references the mock name"


def test_theme_applied_on_load():
    """The theme is applied before the first paint and before React renders, so there is
    never a flash. V2 now has System / Light / Dark (shell/theme.ts, re-exported from
    Shell.tsx): skins stay retired (data-skin dropped), the stored orcha:theme preference
    is READ and never deleted, and index.html paints the right canvas for BOTH themes
    inline before any stylesheet loads — each matching that theme's --v2-window token."""
    import re as _re
    shell = (FRONTEND / "shell" / "Shell.tsx").read_text()
    theme = (FRONTEND / "shell" / "theme.ts").read_text()
    assert "export function initTheme" in theme, "no load-time theme initializer"
    assert "initTheme" in shell, "Shell no longer exposes initTheme"
    assert 'removeAttribute("data-skin")' in theme, "legacy skins still applied"
    assert 'THEME_KEY = "orcha:theme"' in theme and "localStorage.getItem(THEME_KEY)" in theme, \
        "stored preference no longer read"
    assert "removeItem(" not in theme, "the stored preference must not be deleted"
    main_tsx = (FRONTEND / "main.tsx").read_text()
    assert "initTheme();" in main_tsx, "main.tsx doesn't apply the theme before render"
    assert main_tsx.index("initTheme();") < main_tsx.index("createRoot"), \
        "theme applied only after the app mounts (would flash the wrong theme)"
    index_html = (PORTAL / "frontend" / "index.html").read_text().replace(" ", "").lower()
    tokens = (STATIC / "styles" / "v2-tokens.css").read_text()
    windows = _re.findall(r"--v2-window:\s*(#[0-9A-Fa-f]{6})", tokens)
    assert len(windows) >= 2, "--v2-window must be defined for dark and light"
    for w in windows[:2]:
        assert w.lower() in index_html, f"no pre-paint canvas for {w}"
