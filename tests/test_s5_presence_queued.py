"""FT-SURFACE (S5) — conversation presence: thinking-vs-queued + derive-from-durable-state.

Two folded asks land here (one [Frame] PR):
  • req b178e687 — busy/queued: when the agent holds another (task) lease the human's
    message is QUEUED, so the panel shows an honest "queued" notice + a busy pill, NOT
    fake "thinking…" dots.
  • req 1ccab87e — derive the pending-reply indicator from the DURABLE turns (last turn is
    a human turn with no agent reply) so it SURVIVES an agent-switch + reload, not just the
    optimistic in-memory `awaiting` flag.

Both render against Vault's committed presence contract (req 6de81ae3): the conversation
read payload (GET /api/agents/{aid}/conversation, GET /api/conversations/{id}) carries a
top-level `presence` (idle|waking|working|busy|replied|stopped) + opaque `presence_reason`.
The field isn't live yet — the panel degrades to deriving presence from agent.status until
it is, which this file also pins.

Phase 7: the vanilla static/conversation.js is retired; the React port is
frontend/src/pages/agents/Conversation.tsx (+ agents.css). The node harnesses that drove
the panel with stubbed DOM + fetch moved to Vitest, driving the REAL component:
frontend/src/pages/agents/Conversation.presence.test.tsx.
"""
import pathlib

REPO = pathlib.Path(__file__).resolve().parent.parent
FRONTEND = REPO / "orcha-cli" / "orcha_cli" / "templates" / "portal" / "frontend" / "src"
AGENTS_DIR = FRONTEND / "pages" / "agents"


# ---------- the wiring is present in the source ----------

def test_presence_contract_is_wired_into_the_panel():
    js = (AGENTS_DIR / "Conversation.tsx").read_text()
    # reads presence + presence_reason off the top level of the conversation read payload
    assert "d.presence" in js and "d.presence_reason" in js, "doesn't read the presence contract fields"
    # refreshes presence on the poll tick via GET /api/conversations/{id} (not the /turns delta)
    assert "const refreshPresence" in js and '"/api/conversations/" + encodeURIComponent(cid)' in js, \
        "presence isn't refreshed on poll"
    assert "refreshPresence(cid)" in js, "poll() doesn't invoke the presence refresh"
    # the indicator is derived from durable turns, not only the optimistic flag
    assert 'turns[turns.length - 1].role === "human"' in js, "indicator not derived from durable turns"
    assert "const awaitingReply = awaiting ||" in js, "renderList doesn't use the derived indicator"
    # busy -> honest queued notice, never fake thinking dots
    assert "const queued = (" in js and "conv-queued" in js, "no queued notice"
    assert "p.reason ? p.reason :" in js, "queued notice doesn't carry the opaque presence_reason"
    assert "is busy with another task" in js, "no generic queued fallback line"
    assert 'if (p.k === "busy") return queued();' in js, "busy doesn't route to the queued notice"
    # the busy pill + queued styles exist
    css = (AGENTS_DIR / "agents.css").read_text()
    assert ".presence.p-busy" in css and ".conv-queued" in css, "busy pill / queued CSS missing"


# ---------- behavioral: drive the panel (moved to Vitest) ----------

def test_presence_drives_queued_vs_thinking_vs_fallback():
    """Moved to frontend/src/pages/agents/Conversation.presence.test.tsx, which drives
    the REAL Conversation component with a stubbed fetch:
      1) busy + pending human turn -> queued notice (with the verbatim reason) + busy
         pill, NOT thinking dots;
      2) working + pending -> thinking dots, not a queued notice;
      3) field ABSENT -> presence derived from agent.status; agent replied last ->
         the durable pending indicator is gone;
      4) unknown future enum -> idle (forward-compat); a pending turn while idle ->
         honest queued, not dots.
    Here: pin that the Vitest harness exists and keeps those beats."""
    t = (AGENTS_DIR / "Conversation.presence.test.tsx").read_text()
    assert "never fake thinking dots" in t, "busy-queued Vitest scenario missing"
    for beat in (
        'presence: "busy", presence_reason: "busy with \'Fix reset flow\' — queued"',
        'toContain("Fix reset flow")',
        '".conv-thinking")).toBeNull()',          # busy must NOT show fake dots
        "the animated thinking dots, not a queued notice",
        "falls back to agent.status; an agent reply clears the pending indicator",
        'presence: "frobnicate"',
        'toContain("p-idle")',
        'toContain("is busy with another task")',  # generic honest fallback line
    ):
        assert beat in t, f"presence harness lost a beat: {beat}"


def test_stale_presence_response_does_not_paint_the_switched_to_agent():
    """Review P2 (PR #128): if a load/presence fetch for agent A is in flight when the
    user selects agent B, A's late response must NOT overwrite B's panel (A's busy
    reason / p-busy pill). In React the panel is keyed by agent id, so the switch
    unmounts A's component and its in-flight setState no-ops — proven behaviorally in
    Conversation.presence.test.tsx ("stale response isolation")."""
    t = (AGENTS_DIR / "Conversation.presence.test.tsx").read_text()
    assert "stale response isolation" in t, "stale-race Vitest scenario missing"
    for beat in (
        "never paints agent B's panel",
        'hold: ["ra"]',                              # A's response is HELD OPEN
        "first.unmount()",                           # the switch tears A down
        'not.toContain("p-busy")',                   # A's busy pill never leaks onto B
        'not.toContain("RA is busy")',               # nor A's queued reason
        '".conv-thinking")).toBeTruthy()',           # B keeps its own indicator
    ):
        assert beat in t, f"stale-race harness lost a beat: {beat}"
    # and the mount-token guard's React equivalent is real: the panel is keyed per agent
    assert "<Conversation key={a.id}" in (AGENTS_DIR / "AgentsPage.tsx").read_text(), \
        "panel not keyed by agent id (a stale response could paint the wrong agent)"
