"""FT-SURFACE (S1 + S4 + S5-presence) — conversation panel on the agent view.

S1 mounts the turn-based chat for one agent into #convWrap (a sibling of #detailMain, so
the 3s Orcha.patch repaint never wipes the composer). It renders turns from the Vault
conv-store (#115), sends a human turn, and replays each agent turn's work log via the
SHARED run engine (startRunStream keyed by turn.run_id). S4 = a `/` skill palette in the
composer. S5-presence = a header pill derived from agent.status. The live token stream +
Stop + permission/ask-human cards are PR2 (Forge E4) — built forward-compatible here.
The live visual is verified in the portal; the automatable surface is wiring + the
conv-store contract round-trip.
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


# ---------- serves + boots ----------

async def test_agents_loads_conversation_module(client):
    r = await client.get("/agents")
    assert r.status_code == 200, r.text
    assert "/assets/conversation.js" in r.text, "agents page doesn't load conversation.js"
    assert 'id="convWrap"' in r.text, "no #convWrap mount point (panel must live outside the 3s patch)"
    # the D3 'coming soon' placeholder is gone
    assert "convo-hold" not in r.text, "the held placeholder wasn't replaced"
    a = await client.get("/assets/conversation.js")
    assert a.status_code == 200, "conversation.js not served from /assets"


def test_agents_mounts_the_panel_outside_the_patched_panel():
    html = (STATIC / "agents.html").read_text()
    # mounted into #convWrap (a sibling of #detailMain), remounted only on agent change
    assert "OrchaConvo.mount($(\"convWrap\")" in html, "panel not mounted into #convWrap"
    assert "OrchaConvo.teardown()" in html, "panel not torn down on agent change"
    assert "a.id === convAgent" in html, "panel remounts every tick (should only on agent change)"


# ---------- static guards on the conversation module ----------

def test_conversation_module_wires_the_conv_store_contract():
    js = (STATIC / "conversation.js").read_text()
    assert "OrchaConvo" in js and "mount" in js and "teardown" in js, "OrchaConvo.mount/teardown not exposed"
    # S1 read + send against Vault's stable conv-store (#115)
    assert "/api/agents/" in js and "/conversation?limit=" in js, "doesn't load the agent's conversation"
    assert "/turns?after_seq=" in js, "doesn't poll new turns by seq"
    assert 'role: "human", author_agent_id: h.id, content: v' in js, "human send doesn't POST the turn contract"
    assert "actor_agent_id: h.id" in js, "conversation create doesn't pass the acting human"
    # per-turn work log reuses the SHARED run engine, keyed by turn.run_id
    assert "startRunStream(logEl, agentId, rid)" in js, "work log doesn't reuse the shared run stream by run_id"
    # S4: the slash skill palette
    assert 'v.startsWith("/")' in js and "SKILLS" in js, "no slash skill palette"
    # S5: presence derived from agent.status (not a stored field)
    assert "presenceOf" in js and "a.status" in js, "presence not derived from agent.status"
    # S2 forward-compat: cards switch on turn.meta.type (light up with E4)
    assert 'meta.type === "permission_request"' in js and 'meta.type === "ask_human"' in js, "permission/ask cards not forward-compatible"
    # review P2: arrow-key nav must redraw WITHOUT refiltering (else slashIdx snaps to 0)
    assert "function filterSlash" in js and "function renderSlash" in js, "slash filtering not split from rendering"
    assert "slashIdx = (slashIdx + 1) % slashItems.length; renderSlash()" in js, "ArrowDown doesn't redraw without refiltering"
    assert "openSlash(" not in js, "arrow nav still re-filters via openSlash (resets the highlight)"


def test_conversation_caches_turns_no_reload_on_tab_switch():
    """ISS-68: switching agent tabs and back must NOT reload the thread from scratch (flicker +
    lost scroll). A fresh per-agent cache is painted instantly + delta-refreshed; only a missing
    or stale (TTL) cache triggers a full load()."""
    js = (STATIC / "conversation.js").read_text()
    assert "convCache" in js and "CONV_CACHE_TTL_MS" in js, "no per-agent conversation cache"
    assert "function cacheConv" in js, "conversation state isn't snapshotted into the cache"
    # mount paints from a fresh cache (no full reload) and delta-refreshes; stale/missing -> load()
    m = re.search(r"function mount\(el, aid\) \{.*?pollTimer = setInterval", js, re.S).group(0)
    assert "convCache[aid]" in m and "CONV_CACHE_TTL_MS" in m, "mount doesn't consult the cache TTL"
    assert "renderList(); renderPresence();" in m and "poll();" in m, "mount doesn't paint-from-cache + delta-refresh"
    assert "load();" in m, "mount lost the full-load fallback for a stale/missing cache"
    # the cache is kept current as turns load + arrive
    assert js.count("cacheConv()") >= 2, "cache not refreshed on load + poll"


# ---------- the conv-store contract the panel depends on (round-trip) ----------

async def test_conversation_contract_round_trip(client, make_agent):
    human = await make_agent("Boss", kind="human")
    worker = await make_agent("Worker", kind="ai")
    aid = worker["agent_id"]
    # get-or-create the active conversation
    c = await client.post(f"/api/agents/{aid}/conversations", json={"actor_agent_id": human["agent_id"]})
    assert c.status_code in (200, 201), c.text
    conv = c.json().get("conversation", c.json())
    cid = conv["id"]
    # a human turn
    t = await client.post(f"/api/conversations/{cid}/turns",
                          json={"role": "human", "author_agent_id": human["agent_id"], "content": "hello"})
    assert t.status_code in (200, 201), t.text
    # read it back via the panel's initial-load endpoint
    g = await client.get(f"/api/agents/{aid}/conversation?limit=50")
    assert g.status_code == 200, g.text
    body = g.json()
    assert body["conversation"] and body["conversation"]["id"] == cid
    turns = body["turns"]
    assert turns and turns[-1]["content"] == "hello" and turns[-1]["role"] == "human"
    assert "seq" in turns[-1] and "run_id" in turns[-1] and "meta" in turns[-1]   # shapes the panel renders


# ---------- presence derivation (node) ----------

@pytest.mark.skipif(shutil.which("node") is None, reason="node not available to exercise client JS")
def test_presence_derived_from_agent_status():
    js = (STATIC / "conversation.js").read_text()
    harness = r"""
global.window = {};
global.fetch = () => Promise.reject("no fetch in test");
global.setInterval = () => 0;
__CONVJS__
let STATUS = "idle";
global.window.Orcha = { agentById: () => ({ alias: "Frame", status: STATUS }) };
const C = window.OrchaConvo;
const out = {};
STATUS = "working"; out.working = C.presenceOf().k;
STATUS = "needs_verification"; out.replied = C.presenceOf().k;
STATUS = "awaiting_request"; out.waking = C.presenceOf().k;
STATUS = "idle"; out.idle = C.presenceOf().k;
STATUS = "terminated"; out.offline = C.presenceOf().k;
console.log(JSON.stringify(out));
"""
    out = subprocess.run(["node", "-e", harness.replace("__CONVJS__", js)], capture_output=True, text=True)
    assert out.returncode == 0, out.stderr
    res = json.loads(out.stdout.strip().splitlines()[-1])
    assert res == {"working": "working", "replied": "replied", "waking": "waking", "idle": "idle", "offline": "offline"}, res


# ---------- S1/S4 polish (#118 follow-ups) ----------

def test_conversation_shows_thinking_indicator_on_send():
    """After the human sends a turn, a transient 'thinking…' indicator shows until the
    agent's reply turn lands (immediate feedback that the agent is working)."""
    js = (STATIC / "conversation.js").read_text()
    assert "function thinkingBubble" in js, "no thinking indicator"
    assert "awaiting = true; renderList()" in js, "send doesn't raise the thinking indicator"
    assert 'fresh.some((t) => t.role === "agent")' in js and "awaiting = false" in js, \
        "the indicator isn't cleared when the agent reply lands"
    # the indicator's CSS lives on the agent page
    assert ".conv-thinking" in (STATIC / "agents.html").read_text(), "no .conv-thinking style"
    # review P2: the module-level awaiting flag must reset on mount/teardown so a pending
    # "thinking…" can't leak to a different agent on a panel switch.
    assert js.count("awaiting = false") >= 3, "awaiting not reset on mount + teardown (would leak between agents)"


def test_slash_shortcut_guarded_when_an_input_is_focused():
    """The global '/' search shortcut must NOT fire while the user is typing in a field
    (composer, reason box, any input/textarea/select/contenteditable) — else typing '/'
    steals the keystroke + focus into the search bar (#118 S4 follow-up)."""
    app = (STATIC / "app.js").read_text()
    assert "function isEditableTarget" in app, "no editable-target guard helper"
    assert 'e.key === "/" && !isEditableTarget(document.activeElement)' in app, \
        "the '/' shortcut isn't guarded against a focused input"


def test_run_card_relabels_tmux_as_live_tab():
    """Feed display polish: the run-card wake_kind label shows 'live tab' for a tmux run
    (display-only — the stored wake_kind value is unchanged). Other kinds render verbatim."""
    app = (STATIC / "app.js").read_text()
    assert 'run.wake_kind === "tmux" ? "live tab"' in app, "tmux not relabeled 'live tab' in the run card"
