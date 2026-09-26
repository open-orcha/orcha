"""#293 — First-run roster-builder UX (frontend, Path G).

The onboarding wizard has an AI lane: describe a goal → stream the model's thinking →
review/edit a proposed roster → commit it. It consumes the FROZEN SPEC-292 contract
(POST /api/onboarding/propose, SSE: thinking|clarify|roster|error|done) and — per the
SPEC-292 §4/§5 reuse mandate — commits through the EXISTING client POSTs
(POST .../agents, POST .../tasks): NO new commit route, zero route/OpenAPI/DB delta.

MIGRATED (portal React migration Phase 7): the lane lives in the React SPA — the pure
client wiring (SSE parser, roster normalization, walk mapping, propose stream) in
frontend/src/pages/onboarding/logic.ts, the steps in OnboardingPage.tsx. The node
harness cases moved to Vitest: frontend/src/pages/onboarding/logic.test.ts
(parseSSE / normalizeRoster / rosterToWalk+walkAgentToDraft / rail+resume for the
propose steps / #339 demo-flag non-stickiness). Static guards below are repointed at
the React SOURCE; the commit round-trip still runs against the live API.
"""
import pathlib
import pytest

REPO = pathlib.Path(__file__).resolve().parent.parent
SRC = REPO / "orcha-cli" / "orcha_cli" / "templates" / "portal" / "frontend" / "src"
ONB = SRC / "pages" / "onboarding"


def _page() -> str:
    return (ONB / "OnboardingPage.tsx").read_text()


def _logic() -> str:
    return (ONB / "logic.ts").read_text()


# ---------- static guards on the Path G lane contract ----------

def test_path_g_lane_present_and_consumes_propose_contract():
    js = _page()
    logic = _logic()
    # the fork offers the AI lane, routing to the goal step
    assert 'data-go="propose-goal"' in js, "fork doesn't offer the Path G propose lane"
    # the three propose steps are wired into the step dispatcher
    for step in ('case "propose-goal": return <StepProposeGoal',
                 'case "propose-stream": return <StepProposeStream',
                 'case "propose-roster": return <StepProposeRoster'):
        assert step in js, f"step dispatcher missing {step}"
    # it streams from the FROZEN SPEC-292 route via POST (EventSource is GET-only → fetch+reader)
    assert '"/api/onboarding/propose"' in logic, "doesn't consume the SPEC-292 propose route"
    assert "getReader()" in logic, "SSE not read via a ReadableStream reader (POST+SSE needs fetch, not EventSource)"
    # the SSE event discriminators of §1.2 are all handled
    for ev in ('"thinking"', '"clarify"', '"roster"', '"error"', '"done"'):
        assert f"f.event === {ev}" in logic, f"propose stream doesn't handle the {ev} event"


def test_reuse_mandate_no_new_commit_route():
    """SPEC-292 §5: commit REUSES the existing client POSTs — #293 adds NO commit route."""
    js = _page()
    logic = _logic()
    # the forbidden server-side commit endpoint must NOT appear
    assert "/api/onboarding/commit" not in js + logic, "introduced a forbidden /commit route (violates §5 reuse mandate)"
    # commit still flows through the existing agent + task POSTs
    assert "/agents" in js and "/tasks" in js, "commit doesn't reuse the existing agents/tasks POSTs"
    # the walk seeds the EXISTING create-agent draft + hands tasks to the EXISTING queue loop
    assert "s._agentDraft = walkAgentToDraft(walk.agents[0]" in js, \
        "roster walk doesn't pre-seed the existing create-agent draft"
    assert "s._walk = walk" in js and "rosterToWalk(clean)" in js, "commit doesn't build the walk from the edited roster"


def test_propose_fails_open_to_manual_lane():
    """The #292 backend may be absent (404) — the stream must fail OPEN: an honest error
    turn that keeps the manual lanes usable, never a dead screen."""
    js = _page()
    logic = _logic()
    # an HTTP/transport failure surfaces an error turn (not an unhandled throw)
    assert "h.onError(" in logic, "propose stream doesn't surface a recoverable error turn"
    assert "#292 backend" in logic, "error copy doesn't name the missing backend dependency honestly"
    # the error card offers a manual fallback + retry
    assert 'data-go="fork"' in js, "error turn has no manual-setup fallback to the fork"
    assert 'id="peRetry"' in js, "error turn has no retry"


def test_demo_mode_is_dev_only_not_default():
    """?demo=1 synthesizes a roster client-side so the lane is demoable before #292 ships —
    but it must be GATED, never the default path. (#339 non-stickiness behavior:
    frontend/src/pages/onboarding/logic.test.ts.)"""
    js = _page()
    logic = _logic()
    assert 'qp("demo") === "1"' in js, "no dev-only demo gate"
    assert "if (opts && opts.demo) return demoPropose(" in logic, \
        "startPropose doesn't gate the demo stub behind the demo flag (would fake every run)"
    # boot() must reconcile the flag from the LIVE url every load (not a one-directional set),
    # else a single ?demo=1 visit sticks demo:true into localStorage and hijacks every later run.
    assert 'reconcileDemoFlag(s, qp("demo") === "1")' in js, \
        "boot() doesn't reconcile the demo flag from the current URL (would let demo go sticky)"


def test_propose_lane_does_not_self_certify_or_auto_commit():
    """Human-authoritative invariant: the model output is an editable proposal; the only
    writes are the operator's explicit create actions."""
    js = _page()
    # the commit button is an explicit operator action, not an auto-fire on roster arrival
    assert 'id="rCommit"' in js, "no explicit operator commit control on the roster review"
    # onRoster routes to the EDITABLE review step, it does not POST anything itself
    assert 'go("propose-roster")' in js, "roster arrival doesn't route to the editable review"


def test_pure_helpers_exported_for_tests():
    logic = _logic()
    for fn in ("parseSSE", "normalizeRoster", "rosterToWalk", "walkAgentToDraft"):
        assert f"export function {fn}" in logic, f"{fn} not exported from onboarding logic"


def test_propose_retry_feeds_validation_error_back_to_model():
    """Retry after a server-side validation error must change the next propose prompt."""
    js = _page()
    assert "const retry = () =>" in js, "no retry handler on the error turn"
    assert 'err.code === "invalid_goal"' in js
    assert "Previous roster proposal failed validation on the server" in js
    assert 'id="peRetry"' in js and "onClick={retry}" in js


def test_propose_truncation_does_not_blind_retry_same_request():
    """A roster truncated by output-token limits needs a narrower goal, not the same POST again."""
    js = _page()
    logic = _logic()
    assert "roster_truncated" in logic, "no roster_truncated error copy"
    assert 'code !== "roster_truncated"' in js, "truncation not excluded from blind retry"
    assert "{retryable &&" in js, "retry button not gated on retryability"


# ---------- the commit reuses the existing endpoints (real round-trip) ----------

@pytest.mark.asyncio
async def test_commit_endpoints_roundtrip(client, container):
    """The walk commits through the EXISTING POSTs (no new route). Prove those endpoints —
    an agent with an initial_task + a standalone task — still round-trip end-to-end."""
    cid = container["id"]
    h = await client.post(f"/api/containers/{cid}/agents",
                          json={"alias": "Dario", "role": "Operator", "kind": "human"})
    assert h.status_code in (200, 201), h.text

    # agent + kickoff (initial_task) — the per-agent walk path
    a = await client.post(f"/api/containers/{cid}/agents", json={
        "alias": "Atlas", "role": "Concierge", "kind": "ai",
        "prompt": "You are the concierge. Never self-certify.",
        "initial_task": {"title": "Map the onboarding flow",
                         "definition_of_done": "A breakdown the operator approved."},
    })
    assert a.status_code in (200, 201), a.text
    # standalone task — the queued-tasks path
    t = await client.post(f"/api/containers/{cid}/tasks",
                          json={"title": "Ship the fix", "definition_of_done": "Top drop-off fixed + verified."})
    assert t.status_code in (200, 201), t.text

    snap = (await client.get(f"/api/containers/{cid}")).json()
    titles = [x["title"] for x in snap["tasks"]]
    assert "Map the onboarding flow" in titles, titles
    assert "Ship the fix" in titles, titles
