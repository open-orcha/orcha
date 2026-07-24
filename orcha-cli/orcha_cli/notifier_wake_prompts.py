"""Build finite one-shot prompts for ordinary and warm-resident wake workers."""

from __future__ import annotations

from typing import Optional


def build_wake_prompt(cand: dict) -> str:
    """The short directive injected into the agent's session. Pure (testable).

    R2.4: this is a ONE-SHOT worker prompt — drain the inbox and EXIT. The runaway
    happened because the old prompt told the worker to run `/orcha-listen`, whose
    long-poll watch loop never returns; every wake spawned a fresh headless process
    that then sat forever in its own /wait loop, and they piled up.

    R2.2: "drain" means the FULL backlog — ALL open requests + ALL unacked events,
    repeating until the inbox is EMPTY, then exit. This is finite (it terminates when
    nothing is pending) and is NOT the `/orcha-listen` watch loop, which blocks
    indefinitely waiting for NEW events. Handling only the first item would strand the
    rest until the next wake (queue-stranding bug d94727e7).
    """
    alias = cand.get("alias") or "agent"
    bits = []
    if cand.get("pending_events"):
        bits.append(f"{cand['pending_events']} new event(s)")
    if cand.get("auto_start_task_ids"):
        bits.append(f"{len(cand['auto_start_task_ids'])} assigned ready task(s)")
    if cand.get("self_wake_due"):
        bits.append("self-scheduled task wake")
    # #266: a clock-driven heartbeat wake with NOTHING otherwise pending — say so plainly so the
    # worker knows it's a scheduled poll: drain anything that's there, and if genuinely empty, just
    # exit (the generic "pending work" below would be misleading for an empty scheduled poll).
    if (cand.get("auto_wake_due") and not cand.get("pending_events")
            and not cand.get("auto_start_task_ids") and not cand.get("self_wake_due")):
        bits.append("scheduled heartbeat wake (nothing flagged — check for anything pending, else exit)")
    what = " + ".join(bits) or "pending work"

    manifest = ""
    notifications = cand.get("notifications") or []
    if notifications:
        rows = []
        for n in notifications[:12]:
            label = str(n.get("rank_label") or n.get("type") or n.get("event_name") or "notification")
            label = label.replace("_", "-")
            # #359: a task-REQUEST drains as "accept → spawn the task → work it", not "answer & clear".
            # Surface it distinctly so the worker (and the human reading the manifest) sees it is work,
            # not just another request to acknowledge.
            if n.get("is_task_request"):
                label = "task-request-in"
            surface = n.get("surface")
            if not surface:
                deeplink = n.get("deeplink") or {}
                if deeplink.get("kind") and deeplink.get("id"):
                    surface = f"{deeplink['kind']}:{deeplink['id']}"
                else:
                    surface = str(n.get("type") or n.get("event_name") or "notification").replace("_", "-")
            actor = f" from {n['actor_alias']}" if n.get("actor_alias") else ""
            obj_pri = f" p={n['object_priority']}" if n.get("object_priority") is not None else ""
            preview = str(n.get("preview") or "").replace("\n", " ").strip()
            if len(preview) > 120:
                preview = preview[:117] + "..."
            tail = f": {preview}" if preview else ""
            rows.append(f"rank {n.get('rank', '?')} {label} -> {surface}{actor}{obj_pri}{tail}")
        if cand.get("notifications_truncated") or len(notifications) > 12:
            rows.append("more pending notifications omitted from this prompt; keep draining until empty")
        manifest = " RANKED WAKE MANIFEST - drain in this order: " + " | ".join(rows) + "."

    # A3: a directed prompt-event carries a human/teammate message. Surface it verbatim so the
    # worker acts on it specifically (not just "drain the inbox"). Quote each pending message.
    directed = ""
    msgs = [m for m in (cand.get("prompt_messages") or []) if m]
    if msgs:
        quoted = " ".join(f'(prompt {i + 1}) "{m}"' for i, m in enumerate(msgs))
        directed = (f" DIRECTED MESSAGE{'S' if len(msgs) > 1 else ''} FOR YOU — act on "
                    f"{'these' if len(msgs) > 1 else 'this'} specifically: {quoted}.")
        # GH #33: a task-thread message wake carries only the message preview. When the wake resolves
        # a task, its FULL body (title + description + definition_of_done) now rides in your system
        # prompt's "Your task" section — read it before acting, and don't work off the message/title
        # alone. The thread read (GET /api/tasks/<id>/messages) also returns a `task` header with the
        # same body if you re-read it there.
        if cand.get("wake_task_id"):
            directed += (" Before acting, READ the FULL task body (description AND definition_of_done) "
                         "in your 'Your task' section — honor every acceptance criterion (run the loop "
                         "if asked); do not act on the message preview or title alone (GH #33).")
    # #359: a TASK-request in the inbox IS an assignment — accepting it spawns the task. Without this
    # the worker reads "drain your inbox" + "assignment is the only task trigger" and DEFLECTS the
    # work (answers/defers the request to empty the inbox) instead of spawning it. When one is
    # pending, steer the worker into accept-and-do, overriding the generic don't-claim guidance.
    # GH #91/#90 (Round 10): also honor the uncapped, event-independent server signal so a beyond-cap
    # or event-consumed (nudge-redelivered) task request still selects the accept-task step — keeping
    # the prompt and the token lane in agreement (both say "accept it and make progress").
    has_task_request = (any((n.get("is_task_request") for n in notifications))
                        or bool(cand.get("has_pending_task_request")))
    if has_task_request:
        task_step = (
            f"(2) one or more inbox items is a TASK-REQUEST (a teammate asking you to DO work) — "
            f"this IS an assignment: accept it via `/orcha-accept-task <request-id> --alias {alias}` "
            f"(which SPAWNS the task) and make concrete progress on it THIS session; do NOT just "
            f"answer, reject, or defer a task-request to empty your inbox — that deflects the work "
            f"instead of doing it; "
        )
    elif cand.get("auto_start_task_ids"):
        task_step = (
            f"(2) if the auto-start rule still holds (assigned & ready, no human HOLD, "
            f"container active) claim your task via `/orcha-next --alias {alias}`, then READ "
            f"the claimed task's FULL description AND definition_of_done before acting — do "
            f"not work off the title alone (GH #33); honor every acceptance criterion, and if "
            f"the description/DoD asks for a loop or multi-step work, run the loop / do all "
            f"steps, then make concrete progress; "
        )
    elif cand.get("self_wake_due"):
        task_step = (
            "(2) resume the in-progress task you scheduled this wake for; read the "
            "'Your task' and 'Resuming' sections, check the saved wait-point first, then "
            "continue the task; if the external step is still not ready, schedule another "
            "self-wake and exit instead of polling; "
        )
    else:
        task_step = (
            "(2) do not claim a task just because you were woken for inbox/event work — "
            "assignment is the only task trigger; "
        )
    # GH #34 (scoped): the fixed operating instructions (steps 1-3, `task_step`) are the SAME text
    # every time a given agent hits a given branch — only the trailing "[orcha wake] ..." summary
    # (alias/count/manifest/directed-message) is unique per wake. Rendering the instructions FIRST
    # and the volatile per-wake summary LAST gives the two consecutive prompts of a busy agent the
    # longest possible shared prefix, instead of breaking it at byte 0 with the always-different
    # manifest. Same information either way — only the order changed.
    return (
        f"You are a ONE-SHOT headless worker: drain your "
        f"FULL inbox, then EXIT — do NOT enter the `/orcha-listen` long-poll watch loop "
        f"(it never returns and piles up stuck workers). Steps: (1) drain the ENTIRE "
        f"backlog — handle ALL your open requests AND all unacked events, repeating until "
        f"your inbox is EMPTY (don't stop after the first item; that strands the rest "
        f"until the next wake); {task_step}(3) once the inbox is empty and you've "
        f"reached a natural stop — or you need the human — STOP and exit; another wake "
        f"resumes you when there's more. Never self-certify: stop at needs_verification "
        f"and let the human verify. "
        f"[orcha wake] {alias}: {what}.{manifest}{directed}"
    )


# ISS-78 (A2): build_resident_drain_prompt was removed. A warm resident no longer drains its
# NON-conversation inbox in-session (that physically left task-work reasoning in the conversation's
# context window — the ISS-78 bleed). It now idle-YIELDS the lease (service_residents) and an ordinary
# ephemeral worker drains the backlog via build_wake_prompt in its OWN session — so the drain prompt
# and the wake prompt are one and the same again.


def build_resident_sidecar_drain_prompt(alias: Optional[str], inbox: int,
                                        messages: Optional[list] = None) -> str:
    """#247 B3 (§5.2 warm-zone): the LEAN one-shot prompt for a warm-resident DRAIN SIDECAR. Pure.

    Distinct from build_wake_prompt (the ephemeral wake) in TWO deliberate ways:
      1. It is spawned in a SEPARATE session/cwd while the warm conversation lease is STILL HELD —
         so it can drain the queued NON-conversation backlog without the ISS-78 context-bleed (the
         removed in-session drain fed task reasoning into the next human turn) AND without yielding
         the lease (which the A2 idle-yield did, defeating the §5.1 warm-zone hold).
      2. It OMITS task auto-start. A warm conversation embodiment is already live for this agent;
         claiming + working a task here would be a SECOND concurrent embodiment, violating the
         Kedar-locked §3 ONE-EMBODIMENT contract. So: drain notifications/requests only, then EXIT.

    GH #58 (§5.2 safe-rows-only): the caller (service_residents) spawns this sidecar ONLY when the
    queued backlog is pure FYI + taskless-actionable (active-conversations' drain_taskbound == 0); if
    any TASK_BOUND / NEW_WORK / DIRECTIVE row is present it yields the lease to a protocol-bound
    ephemeral instead. So this run, which carries NO injected task protocol, never needs to reason
    about a specific task — it only clears protocol-less rows, and the caller acks exactly those ids
    (drain_ackable_ids) via /events/ack-handled on its clean exit.

    Gate P1b: `prompt`/`task_message`/`task_assigned` events carry content with NO inbox surface —
    surfacing the text is the ONLY delivery path (same as build_wake_prompt / wake_scan). So the
    caller threads the bounded directed-message batch (active-conversations' `inbox_messages`) in
    here and we quote it VERBATIM — otherwise the cursor-ack (P1a) would mark these delivered while
    silently dropping their content. The cursor is acked ONLY after this sidecar has run with them.
    """
    who = alias or "agent"
    n = f"{inbox} queued inbox event(s)" if inbox else "queued inbox events"
    # P1b: directed messages have no other inbox surface — quote each so the sidecar acts on it
    # specifically (mirrors build_wake_prompt's A3 surfacing) before its content is acked away.
    directed = ""
    msgs = [m for m in (messages or []) if m]
    if msgs:
        quoted = " ".join(f'(message {i + 1}) "{m}"' for i, m in enumerate(msgs))
        directed = (f" DIRECTED MESSAGE{'S' if len(msgs) > 1 else ''} FOR YOU — these carry content "
                    f"with no other inbox surface, so handle {'them' if len(msgs) > 1 else 'it'} "
                    f"specifically: {quoted}.")
    return (
        f"[orcha wake · drain sidecar] {who}: {n} piled up while your live conversation session is "
        f"held WARM.{directed} You are a ONE-SHOT DRAIN worker: clear the FULL non-conversation backlog, then "
        f"EXIT — do NOT enter the `/orcha-listen` long-poll watch loop (it never returns and piles "
        f"up stuck workers). Steps: (1) drain the ENTIRE inbox — handle ALL your open requests AND "
        f"ack ALL unacked events, repeating until your inbox is EMPTY (don't stop after the first "
        f"item; that strands the rest). (2) Do NOT claim or start a task via `/orcha-next` and do "
        f"NOT begin code work — a warm conversation session is already live for you, so starting "
        f"task work here would be a second concurrent embodiment. If answering a request would "
        f"require real task work, leave it for that task's own worker; answer what you can without "
        f"code and move on. (3) Once the inbox is empty, STOP and exit. Never self-certify — stop "
        f"at needs_verification and let a human verify."
    )
