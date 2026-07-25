"""Define the typed notification registry and priority ladder."""

# ---------- #247 KEYSTONE: typed notification registry (classify-over-the-bus) ----------
# The durable bus (agent_events) is ALREADY a per-recipient stream — rows keyed on the target
# agent's id, indexed (event_key, ts, id). What it LACKS is a typed taxonomy, a priority/ranking,
# and per-recipient read-state. The #247 registry supplies those by laying a typed classifier +
# a read-cursor + a read-API OVER the existing bus — NOT a parallel notifications table (events
# already persist atomically with their cause; a dual-write would only re-introduce drift).
# Classification is PURE and happens at READ time, so wake/notifier behaviour is unchanged.
#
# Each notification carries two ORTHOGONAL axes:
#   * zone     — SPEC-3 visual grouping: 'needs_you' (actionable) vs 'earlier' (informational).
#                The canonical NEEDS-YOU surface stays sourced from live attnItems(); this zone
#                is a high-signal hint a consumer MAY use to pull an item up.
#   * priority — a numeric DRAIN rank for the downstream wake-boot router, ordered to the locked
#                #247 contract ladder (Helm sign-off), highest first:
#                  interrupt/stop > approval|rejection-on-own-work > live human convo
#                  > task-assignment|thread-msg > request-in > answer-to-request > human close/cancel
#                Lower int = higher priority; gaps leave room for future rungs. The canonical drain
#                order is `ORDER BY priority ASC, ts ASC` — DOCUMENTED here; the actual drain-then-park
#                wake-boot BEHAVIOUR is the downstream D task, NOT wired in this keystone.
_NOTIF_PRI_INTERRUPT = 0  # a directed interrupt / nudge injected into my turn
_NOTIF_PRI_OWN_WORK = (
    10  # an approve / reject / decision on work or an ask that is MINE
)
_NOTIF_PRI_HUMAN_CONVO = 20  # a human needs me / an escalation surfaced to the operator
_NOTIF_PRI_TASK = 30  # task assignment / readiness / thread message
_NOTIF_PRI_REQUEST_IN = 40  # a fresh incoming request from another agent
_NOTIF_PRI_ANSWER = 50  # a request of mine was answered
_NOTIF_PRI_CLOSE = 60  # a request of mine was closed / cancelled
_NOTIF_PRI_UNKNOWN = 90  # an event_name with no taxonomy entry (graceful degrade)

_NOTIF_PRIORITY_LADDER = [
    (_NOTIF_PRI_INTERRUPT, "interrupt"),
    (_NOTIF_PRI_OWN_WORK, "own_work"),
    (_NOTIF_PRI_HUMAN_CONVO, "human_conversation"),
    (_NOTIF_PRI_TASK, "task"),
    (_NOTIF_PRI_REQUEST_IN, "request_in"),
    (_NOTIF_PRI_ANSWER, "answer"),
    (_NOTIF_PRI_CLOSE, "close"),
    (_NOTIF_PRI_UNKNOWN, "unknown"),
]
_NOTIF_PRIORITY_TO_RANK = {
    priority: i + 1 for i, (priority, _label) in enumerate(_NOTIF_PRIORITY_LADDER)
}
_NOTIF_PRIORITY_TO_LABEL = dict(_NOTIF_PRIORITY_LADDER)
_WAKE_NOTIFICATION_MANIFEST_LIMIT = 20

# event_name -> static classification. `request_created` is resolved DYNAMICALLY (its rung
# depends on whether the requester is a human), so it is handled in _classify_notification, not
# here. `link_kind`/`link_field` name the entity the panel row deep-links to and the payload
# field carrying its id.
_NOTIF_TAXONOMY = {
    "prompt": {
        "type": "directed",
        "zone": "needs_you",
        "priority": _NOTIF_PRI_INTERRUPT,
        "link_kind": None,
        "link_field": None,
    },
    "task_verified": {
        "type": "task_verified",
        "zone": "earlier",
        "priority": _NOTIF_PRI_OWN_WORK,
        "link_kind": "task",
        "link_field": "task_id",
    },
    "task_request_rejected": {
        "type": "agent_blocked",
        "zone": "needs_you",
        "priority": _NOTIF_PRI_OWN_WORK,
        "link_kind": "request",
        "link_field": "request_id",
    },
    "task_request_accepted": {
        "type": "request_answered",
        "zone": "earlier",
        "priority": _NOTIF_PRI_OWN_WORK,
        "link_kind": "request",
        "link_field": "request_id",
    },
    "agent_suggestion_decided": {
        "type": "plan_decided",
        "zone": "earlier",
        "priority": _NOTIF_PRI_OWN_WORK,
        "link_kind": "request",
        "link_field": "request_id",
    },
    "decision_made": {
        "type": "plan_decided",
        "zone": "earlier",
        "priority": _NOTIF_PRI_OWN_WORK,
        "link_kind": "decision",
        "link_field": "decision_id",
    },
    "request_escalated": {
        "type": "escalation",
        "zone": "needs_you",
        "priority": _NOTIF_PRI_HUMAN_CONVO,
        "link_kind": "request",
        "link_field": "request_id",
    },
    "agent_suggested": {
        "type": "agent_suggested",
        "zone": "needs_you",
        "priority": _NOTIF_PRI_HUMAN_CONVO,
        "link_kind": "request",
        "link_field": "request_id",
    },
    "task_assigned": {
        "type": "task_assigned",
        "zone": "earlier",
        "priority": _NOTIF_PRI_TASK,
        "link_kind": "task",
        "link_field": "task_id",
    },
    "task_ready": {
        "type": "task_ready",
        "zone": "earlier",
        "priority": _NOTIF_PRI_TASK,
        "link_kind": "task",
        "link_field": "task_id",
    },
    "task_message": {
        "type": "task_message",
        "zone": "earlier",
        "priority": _NOTIF_PRI_TASK,
        "link_kind": "task",
        "link_field": "task_id",
    },
    "task_unassigned": {
        "type": "task_unassigned",
        "zone": "earlier",
        "priority": _NOTIF_PRI_TASK,
        "link_kind": "task",
        "link_field": "task_id",
    },
    "request_answered": {
        "type": "request_answered",
        "zone": "earlier",
        "priority": _NOTIF_PRI_ANSWER,
        "link_kind": "request",
        "link_field": "request_id",
    },
    "request_closed": {
        "type": "request_closed",
        "zone": "earlier",
        "priority": _NOTIF_PRI_CLOSE,
        "link_kind": "request",
        "link_field": "request_id",
    },
}

# event_names that must NEVER surface as an operator notification: the self-echo dashboard ping
# (digest_snapshotted, container-scoped so it doesn't even reach an agent key — suppressed defensively)
# and the live-conversation channel (conversation_turn — that is the chat transcript, delivered to the
# agent's OWN key, and is NOT a notification). The classifier returns None for these (dropped).
_NOTIF_SUPPRESSED = ("digest_snapshotted", "conversation_turn")

# payload fields carrying a short human-readable preview, in priority order.
_NOTIF_PREVIEW_FIELDS = ("preview", "message", "reason", "feedback", "title")
# payload fields carrying the acting agent's id, in priority order. Q2 (Helm sign-off): the actor is
# resolved at READ time from these — NO ~25-site agent_events.actor_id backfill; a missing actor
# degrades to None (SPEC-3 graceful-degrade covers it).
_NOTIF_ACTOR_FIELDS = ("from_agent_id", "by_agent_id")
