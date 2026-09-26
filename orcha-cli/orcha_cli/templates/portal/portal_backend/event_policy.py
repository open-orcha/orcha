"""Classify event-bus signals for wake and resident-drain policy."""

# Validation limits live with the request/response schemas in portal_backend.limits.
# ISS-58: self-echo / notification events that must NEVER by themselves wake an agent. The C1
# digest snapshot emits `digest_snapshotted` (a dashboard notification, not actionable work); when
# it was delivered to the agent's OWN key it self-woke the agent in a ~60s loop (the wake spawns a
# worker → SessionEnd snapshots → republishes → re-wakes). The publish is now container-scoped
# (target=NULL), and wake-scan also excludes these names from its should_wake count as a backstop.
_NON_WAKING_EVENTS = ("digest_snapshotted",)
# GH #91/#90: the WORK lane must NOT wake on a bare `conversation_turn`. A conversation_turn is the
# conversation lane's own actionable surface (the resident chat responds to it); after the lane
# split it must not by itself count as work-lane pending, or every human chat message would boot a
# WORK embodiment. The work pending-count / latest-event / max_ts consumption use this widened set;
# the conversation lane still wakes on conversation_turn via its own (unchanged) path.
_WORK_NON_WAKING_EVENTS = _NON_WAKING_EVENTS + ("conversation_turn",)
# ISS-75 (#188) / ISS-77 (#200): the SOLE event that must NOT, on its own, trigger a RESIDENT
# inbox-drain. `request_closed` is SELF-ECHOING: when the resident drains and closes a request, the
# close emits a NEW `request_closed` event → re-counts as pending_inbox → re-drains → the #185
# runaway (a turn burned every tick). It carries no drain surface, so excluding it loses nothing.
# ISS-77 CORRECTION: `request_answered` was ALSO excluded here, which stranded a resident whose
# request got answered — it never woke to act on the answer. But `request_answered` does NOT
# self-echo (acting on an answer doesn't emit another `request_answered`), so it is a genuine
# "my request was answered → wake + act" signal and MUST count toward the drain. It is no longer
# excluded. The exclusion is scoped to the resident drain count ONLY — the ephemeral one-shot wake
# path (gated by _NON_WAKING_EVENTS, digest_snapshotted only) still wakes on request_closed too
# (a worker resumes a parent then EXITS, so it can't loop). Mirrors ISS-58.
# `request_created` (a NEW incoming request TO the resident) is NOT here — it is real, actionable work.
_RESIDENT_DRAIN_AUDIT_EVENTS = ("request_closed",)
# #288 wake-suppression: terminal / FYI event types whose LONE, BARE delivery is a "no-action"
# wake — the recipient would spawn an ephemeral worker only to find nothing to do. wake-scan
# uses this set (plus `request_answered`, handled by LLM triage) to attach a `triage_hint` to a
# candidate; the notifier daemon makes the actual suppress decision and ALWAYS fails open (any
# error/ambiguity wakes). Per Helm's bareness rule, a human comment riding on any of these flips
# it from a silent structural skip to LLM triage — never a silent drop of human-authored content.
_TIER0_FYI_EVENTS = ("request_closed", "task_verified", "agent_suggestion_decided")


def _triage_hint_for(event_name, payload, *, full_answer=None):
    """#288: classify a single pending event into a wake-suppression *hint*, or return None when
    the event must always wake (the conservative default).

    Returns ``{tier, event_name, bare, request_id, text}``:
      - ``tier='structural'`` — a BARE terminal/FYI event: the daemon skips the spawn
        deterministically ($0, no LLM). ``request_id`` stays None (nothing to auto-close).
      - ``tier='llm'`` — feed ``text`` to ``llm_util.triage_wake`` (which fails open to wake).
        For ``request_answered`` this is the answer text and ``request_id`` is set so a pure-ack
        verdict auto-closes the request. For a structural FYI that CARRIES a human note
        (Helm's bareness rule) the note is triaged instead of being silently skipped.

    Only ever called for a candidate whose ONLY pending signal is this one event (pending==1, no
    ready task, no directed message) — so suppressing it cannot hide other actionable work."""
    payload = payload or {}
    if event_name == "request_answered":
        # the AMBIGUOUS case: an answer always carries text, so the LLM decides ack-vs-follow-up.
        # #307 T2: if it IS a pure ack, the routine next-hop is to CLOSE the request — a cheap
        # write the daemon can do on the 'ack' substrate instead of a full embodiment. The `t2`
        # tag rides alongside `tier` (the suppress path ignores it); the graded-wake decider only
        # consults it when the cheap rules DON'T already suppress.
        return {
            "tier": "llm",
            "event_name": event_name,
            "bare": False,
            "request_id": payload.get("request_id"),
            "text": (full_answer or payload.get("preview") or ""),
            "t2": {"action": "ack_close", "request_id": payload.get("request_id")},
        }
    if event_name == "request_closed":
        # a human force-close ROUTES its reason as a SEPARATE prompt event (pending would be >1),
        # so a lone request_closed is always bare. Nothing to auto-close (already closed).
        return {
            "tier": "structural",
            "event_name": event_name,
            "bare": True,
            "request_id": None,
            "text": "",
        }
    if event_name == "task_verified":
        if payload.get("approved") is not True:
            return None  # a REJECTED verify is a rework signal — always wake
        feedback = (payload.get("feedback") or "").strip()
        if not feedback:
            return {
                "tier": "structural",
                "event_name": event_name,
                "bare": True,
                "request_id": None,
                "text": "",
            }
        # approved WITH a verifier note → triage the note (bareness rule), don't silently skip.
        # #307 T2: an APPROVAL's only routine next-hop is acknowledging the note on the task
        # thread — a cheap write, no full boot. Tag it so the graded-wake decider can route the
        # ack to the 'ack' substrate when it would otherwise spend a full embodiment.
        return {
            "tier": "llm",
            "event_name": event_name,
            "bare": False,
            "request_id": None,
            "text": feedback,
            "t2": {"action": "ack_verify", "task_id": payload.get("task_id")},
        }
    if event_name == "agent_suggestion_decided":
        if payload.get("kind") != "refuse":
            return None  # create/reassign → a new agent/target now owns it; requester should wake
        reason = (payload.get("reason") or "").strip()
        if not reason:
            return {
                "tier": "structural",
                "event_name": event_name,
                "bare": True,
                "request_id": None,
                "text": "",
            }
        return {
            "tier": "llm",
            "event_name": event_name,
            "bare": False,
            "request_id": None,
            "text": reason,
        }
    return None
