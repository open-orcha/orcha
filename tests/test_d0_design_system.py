"""FT-SURFACE (D0) — portal design-system foundation (styles.css + app.js).

D0 lands the shared frontend the D-series builds on: a token/theme stylesheet and an
app.js shell mounted against the REAL backend snapshot.
The automatable surface is (a) the portal actually serves the two assets, (b) the
shell mounts data-driven against a real-shape snapshot — acting-as resolves the real
kind='human' agent (never a hardcoded name) and window.ORCHA is mutated in place,
(c) the live-feed engine folds in the real SSE client. The visual polish is verified
live; the pages are NOT rewritten here (that's D1-D6).
"""
import json
import pathlib
import re
import shutil
import subprocess
import pytest

pytestmark = pytest.mark.asyncio

REPO = pathlib.Path(__file__).resolve().parent.parent
STATIC = REPO / "orcha-cli" / "orcha_cli" / "templates" / "portal" / "static"


# ---------- the portal serves the foundation ----------

async def test_assets_are_served(client):
    css = await client.get("/assets/styles.css")
    assert css.status_code == 200, css.text
    assert "text/css" in css.headers.get("content-type", "")
    assert "--accent" in css.text and "[data-theme" in css.text  # token layer + theme

    js = await client.get("/assets/app.js")
    assert js.status_code == 200, js.text
    assert "javascript" in js.headers.get("content-type", "")
    assert "mountShell" in js.text


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


# ---------- app.js: the three D0 adaptations + exports ----------

def test_app_js_adaptations_and_exports():
    js = (STATIC / "app.js").read_text()
    # (1) live, in-place window.ORCHA so the captured D stays valid across the 3s poll
    assert "window.ORCHA = window.ORCHA ||" in js, "window.ORCHA not a live object"
    assert "function applySnapshot" in js, "no in-place snapshot updater"
    # (2) acting-as is DATA-DRIVEN — the real kind='human' agent, never hardcoded
    assert "function actingHuman" in js, "acting-as not data-driven"
    assert "Dario" not in js, "acting-as still references the mock name"
    assert 'a.kind === "human"' in js, "doesn't resolve the human from the snapshot"
    # (3) helpers read the snapshot fresh (no stale derived cache)
    assert "function agentByAlias" in js and "agents().find" in js, "agentByAlias not live-derived"
    # the foundation's shared helpers are all exported
    for sym in ("mountShell", "pill", "avatar", "kindBadge", "agentLink", "taskLink",
                "requestLink", "renderDiff", "runCard", "activateRuns", "modal", "toast",
                "classifyLine", "startRunStream", "applySnapshot"):
        assert re.search(r"\b" + sym + r"\b", js), f"missing/!exported helper {sym}"
    # live-feed engine folds in the real SSE client (per running run)
    assert "new EventSource(" in js, "run feed not wired to the SSE endpoint"
    assert 'd.status === "stream_timeout"' in js, "stream_timeout not treated as reconnectable"
    assert "d.seq <= maxSeq" in js, "no monotonic guard against reconnect replay"


# ---------- app.js mounts data-driven against a real-shape snapshot (node) ----------

@pytest.mark.skipif(shutil.which("node") is None, reason="node not available to exercise client JS")
def test_shell_mounts_data_driven():
    """Eval app.js against a stubbed DOM + a REAL-shape snapshot, then mountShell:
    the topbar's 'acting as' must render the snapshot's human (kedar), not a hardcoded
    name; pills resolve; agentByAlias reads live data."""
    js = (STATIC / "app.js").read_text()
    harness = r"""
const els = { sidebar: {innerHTML:""}, topbar: {innerHTML:""}, themeBtn:null };
global.localStorage = { _m:{}, getItem(k){return this._m[k]||null;}, setItem(k,v){this._m[k]=v;} };
global.document = {
  documentElement: { setAttribute(){} },
  addEventListener(){},
  getElementById(id){ return els[id] || null; },
  createElement(){ return { classList:{add(){},remove(){},toggle(){}}, addEventListener(){}, style:{}, appendChild(){} }; },
  body: { appendChild(){} },
};
global.window = {};
window.ORCHA = {
  container: { id: "c1", name: "Orcha" },
  agents: [
    { id: "h1", alias: "kedar", kind: "human", status: "idle" },
    { id: "a1", alias: "Frame", kind: "ai", status: "working" },
  ],
  tasks: [
    { id: "t1", title: "do X", status: "needs_verification", assignees: ["Frame"] },
    { id: "t2", title: "do Y", status: "in_progress", assignees: ["Frame"] },
  ],
  requests: [ { id: "r1", requester_id: "a1", target_id: null, status: "open" } ],
};
__APPJS__
const O = window.Orcha;
O.mountShell("home", { title: "Dashboard" });
const out = {
  actingHasHuman: /acting as/.test(els.topbar.innerHTML) && /kedar/.test(els.topbar.innerHTML),
  actingNotHardcoded: !/Dario/.test(els.topbar.innerHTML),
  needsYouCount: /Needs you/.test(els.sidebar.innerHTML),
  // action queue = 1 needs_verification task + 1 open request to (null=)human = 2
  attn: O.attnItems().count,
  pillAttn: /s-attn/.test(O.pill("needs_verification")),
  agentLive: (O.agentByAlias("kedar")||{}).kind === "human",
  // applySnapshot mutates in place — same object reference stays valid
  liveMutate: (function(){ const before = O.D; O.applySnapshot({ tasks: [] }); return O.D === before && O.tasks().length === 0; })(),
};
console.log(JSON.stringify(out));
"""
    src = harness.replace("__APPJS__", js)
    res = subprocess.run(["node", "-e", src], capture_output=True, text=True)
    assert res.returncode == 0, res.stderr
    out = json.loads(res.stdout.strip().splitlines()[-1])
    assert out["actingHasHuman"] is True, out      # acting-as shows the real human
    assert out["actingNotHardcoded"] is True, out  # ...not a hardcoded name
    assert out["needsYouCount"] is True, out
    assert out["attn"] == 2, out                   # 1 verify + 1 escalation
    assert out["pillAttn"] is True, out
    assert out["agentLive"] is True, out
    assert out["liveMutate"] is True, out          # window.ORCHA mutated in place


@pytest.mark.skipif(shutil.which("node") is None, reason="node not available to exercise client JS")
def test_theme_applied_on_load():
    """Review P2: app.js must set <html data-theme> at load from the saved/default
    theme — otherwise CSS's dark :root default wins until the user clicks (a saved
    'light', or 'auto' on a light OS, would flash dark)."""
    js = (STATIC / "app.js").read_text()

    def applied(saved):
        harness = r"""
const set = [];
global.document = {
  documentElement: { setAttribute(k, v) { if (k === "data-theme") set.push(v); } },
  addEventListener(){}, getElementById(){ return null; },
  createElement(){ return { classList:{add(){},remove(){}}, addEventListener(){}, style:{}, appendChild(){} }; },
  body: { appendChild(){} },
};
global.localStorage = { getItem(){ return __SAVED__; }, setItem(){} };
global.window = {};
__APPJS__
console.log(JSON.stringify({ applied: set }));
"""
        src = harness.replace("__SAVED__", json.dumps(saved)).replace("__APPJS__", js)
        res = subprocess.run(["node", "-e", src], capture_output=True, text=True)
        assert res.returncode == 0, res.stderr
        return json.loads(res.stdout.strip().splitlines()[-1])["applied"]

    assert "light" in applied("light"), "saved 'light' not applied on load"
    assert "auto" in applied(None), "default 'auto' not applied on load"
