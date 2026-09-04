"""FT-SURFACE (S1 + S4 + S5-presence) — conversation panel on the agent view.

Phase 7: the vanilla static/{conversation.js,agents.html,app.js} surface is retired.
The React port is frontend/src/pages/agents/Conversation.tsx (+ agents.css), mounted
by AgentsPage into #convWrap keyed by agent id (`key={a.id}` = the vanilla
mount()/teardown() lifecycle — remount only on agent change, and all composer state
lives in useState so the 3s poll never clobbers typing). The '/' search-shortcut
guard lives in shell/Shell.tsx; the run-card tmux relabel in pages/agents/runlog.tsx
(+ pages/tasks/TasksPage.tsx). The conv-store contract (#115) is UNCHANGED — the API
round-trip below still runs against the live portal.

The node harnesses that eval'd conversation.js moved to Vitest, driving the REAL
component with a stubbed fetch:
  - frontend/src/pages/agents/Conversation.presence.test.tsx (presenceOf status map,
    queued-vs-thinking, the stale-load race)
  - frontend/src/pages/agents/Conversation.test.tsx (#337 attachments)
"""
import pathlib
import pytest

pytestmark = pytest.mark.asyncio

REPO = pathlib.Path(__file__).resolve().parent.parent
PORTAL = REPO / "orcha-cli" / "orcha_cli" / "templates" / "portal"
FRONTEND = PORTAL / "frontend" / "src"
AGENTS_DIR = FRONTEND / "pages" / "agents"


def _conv() -> str:
    return (AGENTS_DIR / "Conversation.tsx").read_text()


# ---------- serves + boots ----------

async def test_agents_loads_conversation_module(client):
    """The agents page serves the SPA shell; the conversation panel ships in the
    dist bundle (Conversation.tsx), not a separate /assets/conversation.js."""
    r = await client.get("/agents")
    assert r.status_code == 200, r.text
    assert "text/html" in r.headers.get("content-type", "")
    assert 'id="root"' in r.text, "no SPA mount point"
    assert "/assets/dist/" in r.text, "agents doesn't load the dist bundle"


def test_agents_mounts_the_panel_outside_the_patched_panel():
    """The panel mounts into #convWrap (a sibling of #detailMain, so the 3s snapshot
    repaint never wipes the composer) and is keyed by agent id — React remounts it
    ONLY on agent change (the vanilla mount/teardown + `a.id === convAgent` guard)."""
    page = (AGENTS_DIR / "AgentsPage.tsx").read_text()
    assert 'id="convWrap"' in page, "no #convWrap mount point"
    assert "<Conversation key={a.id}" in page, \
        "panel not keyed by agent id (would remount every tick or never teardown)"
    assert 'id="detailMain"' in page, "no #detailMain (the panel must live outside it)"


# ---------- static guards on the conversation module ----------

def test_conversation_module_wires_the_conv_store_contract():
    js = _conv()
    # S1 read + send against Vault's stable conv-store (#115)
    assert '"/api/agents/"' in js and '"/conversation?limit=' in js, "doesn't load the agent's conversation"
    assert "/turns?after_seq=" in js, "doesn't poll new turns by seq"
    assert 'role: "human", author_agent_id: h.id, content: v' in js, "human send doesn't POST the turn contract"
    assert "actor_agent_id: h.id" in js, "conversation create doesn't pass the acting human"
    # per-turn work log reuses the SHARED run engine (runlog.tsx), keyed by turn.run_id
    assert "WorkLogDetails" in js and "t.run_id" in js, "work log doesn't reuse the shared run engine by run_id"
    # S4: the slash skill palette
    assert 'draft.startsWith("/")' in js and "SKILLS" in js, "no slash skill palette"
    # S5: presence derived from agent.status (not a stored field)
    assert "presenceOf" in js and "agent.status" in js, "presence not derived from agent.status"
    # S2 forward-compat: cards switch on turn.meta.type (light up with E4)
    assert 'meta.type === "permission_request"' in js and 'meta.type === "ask_human"' in js, \
        "permission/ask cards not forward-compatible"
    # review P2 parity: arrow-key nav must redraw WITHOUT refiltering — in React the
    # filter is DERIVED (slashItems from draft), so ArrowDown only moves the index.
    assert "SKILLS.filter((s) => s.startsWith(slashQuery))" in js, "slash filtering not derived from the draft"
    assert "setSlashIdx((i) => (i + 1) % slashItems.length)" in js, \
        "ArrowDown doesn't advance the highlight without refiltering"


def test_conversation_caches_turns_no_reload_on_tab_switch():
    """ISS-68: switching agent tabs and back must NOT reload the thread from scratch
    (flicker + lost scroll). A fresh per-agent module-level cache is painted instantly
    + delta-refreshed via poll(); only a missing or stale (TTL) cache triggers load()."""
    js = _conv()
    assert "convCache" in js and "CONV_CACHE_TTL_MS" in js, "no per-agent conversation cache"
    assert "const cached = convCache[agent.id]" in js, "mount doesn't consult the cache"
    assert "Date.now() - cached.at < CONV_CACHE_TTL_MS" in js, "mount doesn't check the cache TTL"
    # fresh cache -> paint + delta-refresh; stale/missing -> full load()
    assert "if (freshCache) void poll();" in js and "else void load();" in js, \
        "mount lost the paint-from-cache / full-load split"
    # the cache is kept current as turns load + arrive
    assert "convCache[agent.id] = {" in js, "cache not refreshed as state changes"


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


# ---------- presence derivation (moved to Vitest) ----------

def test_presence_derived_from_agent_status():
    """The behavioral map (working→working, needs_verification→replied,
    awaiting_request→waking, idle→idle, terminated→offline) runs against the real
    component in frontend/src/pages/agents/Conversation.presence.test.tsx
    ("S1 presenceOf — the agent.status → pill map"). Here: pin the source map."""
    js = _conv()
    fn = js[js.index("function presenceOf"):js.index("function AttRow")]
    assert 'case "working"' in fn and '{ k: "working", l: "working" }' in fn
    assert 'case "needs_verification"' in fn and '{ k: "replied", l: "replied" }' in fn
    assert 'case "awaiting_request"' in fn and '{ k: "waking"' in fn
    assert 'case "terminated"' in fn and '{ k: "offline", l: "offline" }' in fn
    assert 'return { k: "idle", l: "idle" }' in fn, "no idle default"
    # the Vitest harness can't silently vanish
    t = (AGENTS_DIR / "Conversation.presence.test.tsx").read_text()
    assert "the agent.status → pill map" in t, "S1 presence-map Vitest scenario missing"
    for beat in ('"m2", "p-replied", "replied"', '"m5", "p-offline", "offline"'):
        assert beat in t, f"presence-map harness lost a beat: {beat}"


# ---------- S1/S4 polish (#118 follow-ups) ----------

def test_conversation_shows_thinking_indicator_on_send():
    """After the human sends a turn, a transient 'thinking…' indicator shows until the
    agent's reply turn lands (immediate feedback that the agent is working)."""
    js = _conv()
    assert "const thinking = () =>" in js and "conv-thinking" in js, "no thinking indicator"
    assert "setAwaiting(true)" in js, "send doesn't raise the thinking indicator"
    assert 'fresh.some((t) => t.role === "agent")' in js and "setAwaiting(false)" in js, \
        "the indicator isn't cleared when the agent reply lands"
    # the indicator's CSS lives in the agents page stylesheet
    assert ".conv-thinking" in (AGENTS_DIR / "agents.css").read_text(), "no .conv-thinking style"
    # review P2 parity: `awaiting` is per-mount useState and the panel is keyed by
    # agent id, so a pending "thinking…" can never leak to a different agent.
    assert "useState(false); // optimistic until the reply lands" in js, \
        "awaiting is not per-mount state (would leak between agents)"


def test_slash_shortcut_guarded_when_an_input_is_focused():
    """The global '/' search shortcut must NOT fire while the user is typing in a field
    (composer, reason box, any input/textarea/select/contenteditable) — else typing '/'
    steals the keystroke + focus into the search bar (#118 S4 follow-up)."""
    shell = (FRONTEND / "shell" / "Shell.tsx").read_text()
    assert "isContentEditable" in shell and "INPUT|TEXTAREA|SELECT" in shell, \
        "no editable-target guard helper"
    assert 'e.key === "/" && !editing' in shell, \
        "the '/' shortcut isn't guarded against a focused input"


def test_run_card_relabels_tmux_as_live_tab():
    """Feed display polish: the run-card wake_kind label shows 'live tab' for a tmux run
    (display-only — the stored wake_kind value is unchanged). Both run-card surfaces."""
    for page in ("pages/agents/runlog.tsx", "pages/tasks/TasksPage.tsx"):
        src = (FRONTEND / page).read_text()
        assert 'run.wake_kind === "tmux" ? "live tab"' in src, \
            f"{page}: tmux not relabeled 'live tab' in the run card"
