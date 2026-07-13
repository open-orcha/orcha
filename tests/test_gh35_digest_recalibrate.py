"""GH #35 — recalibrate the agent memory digest on task completion.

A digest only ever ACCUMULATES; nothing trims it when the work it describes closes. So the next
wake rehydrates the finished task's "I still need to do X" open threads and its task-scoped
decisions as if they were live. This module covers the PURE `digest_curate.recalibrate_digest`
transform (no DB): the pruning rules, the keep-pending-verification carve-out, durable-learnings
survival, focus reset, id/title matching, and the no-mutation / non-dict invariants. The endpoint
wiring (real /done, /verify, /cancel) lives in test_gh35_digest_recalibrate_endpoint.py — kept in a
separate all-async module so the sync tests here don't perturb the async DB-reset fixture ordering.
"""
from orcha_cli import digest_curate as C

TID = "8b9733b5-ea75-4b76-b2b7-104d516b05ab"
SHORT = "8b9733b5"
TITLE = "recalibrate memory digest on task completion"


# ----------------------------------------------------------------- pure transform


def _digest(**kw):
    base = {"current_focus": "", "decisions": [], "learnings": [], "open_threads": []}
    base.update(kw)
    return base


def test_prunes_open_thread_referencing_task_by_short_id():
    d = _digest(open_threads=[
        {"text": f"still need to finish task {SHORT}"},
        {"text": "unrelated: chase the Android review"},
    ])
    out = C.recalibrate_digest(d, TID, TITLE, verification_pending=False)
    assert out["open_threads"] == [{"text": "unrelated: chase the Android review"}]


def test_prunes_open_thread_referencing_task_by_full_uuid():
    d = _digest(open_threads=[{"text": f"ship the thing for {TID} tomorrow"}])
    out = C.recalibrate_digest(d, TID, TITLE, verification_pending=False)
    assert out["open_threads"] == []


def test_prunes_open_thread_referencing_task_by_title():
    d = _digest(open_threads=[{"text": f"WIP: {TITLE} — write the tests"}])
    out = C.recalibrate_digest(d, "", TITLE, verification_pending=False)  # id blank → title matches
    assert out["open_threads"] == []


def test_keeps_pending_verification_thread_when_needs_verification():
    d = _digest(open_threads=[
        {"text": f"ship feature for task {SHORT}"},              # stale work → drop
        {"text": f"await human verification on {SHORT} (kedar)"},  # still pending → keep
    ])
    out = C.recalibrate_digest(d, TID, TITLE, verification_pending=True)
    assert out["open_threads"] == [{"text": f"await human verification on {SHORT} (kedar)"}]


def test_drops_verification_thread_once_completed():
    # verification_pending=False (verified / cancelled): even the verify thread is resolved.
    d = _digest(open_threads=[{"text": f"await human verification on {SHORT}"}])
    out = C.recalibrate_digest(d, TID, TITLE, verification_pending=False)
    assert out["open_threads"] == []


def test_durable_learnings_are_untouched():
    learnings = [{"text": "GET /api/tasks/<id> is 404 — read status from the container tasks list"},
                 {"text": f"the {SHORT} endpoint auto-completes at full autonomy"}]
    d = _digest(learnings=list(learnings))
    out = C.recalibrate_digest(d, TID, TITLE, verification_pending=False)
    # learnings survive VERBATIM even when they name the closed task — durable knowledge persists.
    assert out["learnings"] == learnings


def test_drops_task_scoped_decisions_keeps_others():
    d = _digest(decisions=[
        {"text": f"for task {SHORT}: stack the PR on the integration branch"},
        {"text": "team convention: never merge to main"},
    ])
    out = C.recalibrate_digest(d, TID, TITLE, verification_pending=False)
    assert out["decisions"] == [{"text": "team convention: never merge to main"}]


def test_resets_focus_only_when_it_points_at_closed_task():
    d = _digest(current_focus=f"finishing task {SHORT} — the digest recalibration")
    out = C.recalibrate_digest(d, TID, TITLE, verification_pending=False)
    assert out["current_focus"] != d["current_focus"]
    assert SHORT in out["current_focus"]  # neutral recalibrated marker names the closed task

    unrelated = _digest(current_focus="reviewing Andrew's Android PR")
    out2 = C.recalibrate_digest(unrelated, TID, TITLE, verification_pending=False)
    assert out2["current_focus"] == "reviewing Andrew's Android PR"


def test_explicit_next_focus_wins_over_default_marker():
    d = _digest(current_focus=f"task {SHORT} work")
    out = C.recalibrate_digest(d, TID, TITLE, verification_pending=False,
                               next_focus="pick up the scheduled-tasks design")
    assert out["current_focus"] == "pick up the scheduled-tasks design"


def test_handles_bare_string_entries():
    d = _digest(open_threads=[f"loose end on {SHORT}", "keep this one"])
    out = C.recalibrate_digest(d, TID, TITLE, verification_pending=False)
    assert out["open_threads"] == ["keep this one"]


def test_does_not_mutate_input_and_non_dict_passthrough():
    d = _digest(open_threads=[{"text": f"drop {SHORT}"}])
    before = [dict(e) for e in d["open_threads"]]
    C.recalibrate_digest(d, TID, TITLE, verification_pending=False)
    assert d["open_threads"] == before          # input untouched
    assert C.recalibrate_digest(None, TID, TITLE, verification_pending=False) is None


def test_short_generic_title_does_not_false_match():
    # A too-short title must NOT be used for matching (would prune unrelated threads).
    d = _digest(open_threads=[{"text": "fix the bug in login"}])
    out = C.recalibrate_digest(d, "no-id-here", "bug", verification_pending=False)
    assert out["open_threads"] == [{"text": "fix the bug in login"}]
