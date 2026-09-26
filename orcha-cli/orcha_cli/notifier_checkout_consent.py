"""Ask the human what to do when a conversation cannot move into the main checkout.

With worktrees disabled, a conversation resident must move from its previous
isolated worktree into the shared main checkout. Orcha refuses that move when
the saved files cannot be carried across safely (for example the main checkout
holds unrelated changes). Instead of silently retrying forever, the notifier
posts ONE question to the conversation:

* reply "discard" (yes / ok / proceed …) → the previous worktree's uncommitted
  and untracked changes are dropped, the resident starts in the main checkout,
  and the pending request is handled;
* reply "no" / "keep" → Orcha answers once that worktrees must be re-enabled,
  and keeps the worktree intact until that happens.

The question and its resolution are ordinary agent turns tagged in ``meta``
(``orcha_kind``) so the resident's own turn bookkeeping ignores them and the
original human request is still delivered once the resident boots.
"""

from __future__ import annotations

import re
import time

from .notifier_routing_handoff import previous_run

KIND_PROMPT = "checkout_consent_prompt"
KIND_DECLINED = "checkout_consent_declined"
KIND_RESOLVED = "checkout_consent_resolved"
SYSTEM_KINDS = frozenset({KIND_PROMPT, KIND_DECLINED, KIND_RESOLVED})

CONSENT_RE = re.compile(
    r"^\W*(yes|y|yep|yeah|ok|okay|sure|discard|drop|proceed|go ahead|do it|switch)\b",
    re.IGNORECASE,
)
DECLINE_RE = re.compile(
    r"^\W*(no|nope|don'?t|do not|keep|cancel|stop|never mind)\b", re.IGNORECASE
)


def is_system_turn(turn) -> bool:
    """Return whether a turn is one of Orcha's own consent notices, not a reply."""
    meta = turn.get("meta") if isinstance(turn, dict) else None
    return isinstance(meta, dict) and meta.get("orcha_kind") in SYSTEM_KINDS


def resolved_through(turns) -> int:
    """Newest agent turn seq that actually answered the human (consent notices excluded)."""
    return max(
        [
            turn["seq"]
            for turn in turns
            if turn.get("role") == "agent" and not is_system_turn(turn)
        ],
        default=0,
    )


def _latest_seq(turns, kind) -> int:
    return max(
        [
            turn.get("seq", 0)
            for turn in turns
            if turn.get("role") == "agent"
            and isinstance(turn.get("meta"), dict)
            and turn["meta"].get("orcha_kind") == kind
        ],
        default=0,
    )


def _post_notice(services, api_base, conv_id, candidate, base_cwd, kind, content):
    """Post an agent turn on a short-lived run row so the API accepts it."""
    agent_id = candidate["agent_id"]
    run = services._post_json(
        f"{api_base}/api/agents/{agent_id}/runs",
        {
            "wake_kind": "ephemeral",
            "wake_event": "conversation_turn",
            "conversation_id": conv_id,
            "lane": "conversation",
            "runtime": candidate.get("model_runtime"),
            "base_cwd": base_cwd,
        },
    )
    run_id = (run or {}).get("run_id")
    if not run_id:
        return False
    posted = services._post_json(
        f"{api_base}/api/conversations/{conv_id}/turns",
        {
            "role": "agent",
            "author_agent_id": agent_id,
            "content": content,
            "run_id": run_id,
            "meta": {"orcha_kind": kind},
        },
    )
    services._post_json(
        f"{api_base}/api/runs/{run_id}/finish",
        {"status": "exited", "exit_code": 0, "output": f"orcha {kind}"},
    )
    return bool(posted)


def prompt_text(worktree, base_cwd) -> str:
    return (
        "⚠️ I can't start in the main checkout yet. Worktrees are disabled for this "
        f"project, so I have to move from my previous checkout `{worktree}` into "
        f"`{base_cwd}`, but Orcha can't carry its files across safely (the main "
        "checkout has unrelated changes, or the saved state no longer applies).\n\n"
        f"• Reply **discard** to drop all uncommitted and untracked changes in "
        f"`{worktree}` and continue your request in the main checkout.\n"
        "• Or turn **Disable worktrees** off in Settings and I'll continue in my "
        "isolated checkout with everything kept.\n\n"
        "Your last message will be handled as soon as one of those happens."
    )


def blocked_text(base_cwd) -> str:
    """Question when no previous worktree of ours is recorded (nothing to discard)."""
    return (
        "⚠️ I can't start in the main checkout yet. Worktrees are disabled for this "
        f"project, but Orcha can't safely place my saved state into `{base_cwd}` "
        "(the main checkout has unrelated changes, or the saved state no longer "
        "applies).\n\n"
        "• Reply **proceed** to start fresh in the main checkout anyway.\n"
        "• Or turn **Disable worktrees** off in Settings and I'll continue in an "
        "isolated checkout.\n\n"
        "Your last message will be handled as soon as one of those happens."
    )


def handle_carry_failure(
    services, api_base, conv_id, candidate, turns, *, base_cwd, quiet
) -> bool:
    """Drive the consent exchange; return True once the caller may retry the carry."""
    try:
        prior = previous_run(
            api_base, candidate["agent_id"], services, conversation_id=conv_id
        )
    except Exception:
        prior = None
    worktree = (prior or {}).get("worktree")
    branch = (prior or {}).get("branch")
    prompt_seq = _latest_seq(turns, KIND_PROMPT)
    resolved_seq = _latest_seq(turns, KIND_RESOLVED)
    if prompt_seq and prompt_seq > resolved_seq:
        replies = [
            turn
            for turn in turns
            if turn.get("role") == "human" and turn.get("seq", 0) > prompt_seq
        ]
        if not replies:
            return False
        reply = str(replies[-1].get("content") or "")
        if CONSENT_RE.match(reply):
            if worktree:
                services._discard_worktree(base_cwd, worktree, branch)
                resolved = (
                    f"Discarded the uncommitted changes in `{worktree}` and switched "
                    f"to the main checkout `{base_cwd}`. Handling your request now."
                )
            else:
                resolved = (
                    f"Starting fresh in the main checkout `{base_cwd}`. Handling your "
                    "request now."
                )
            _post_notice(
                services,
                api_base,
                conv_id,
                candidate,
                base_cwd,
                KIND_RESOLVED,
                resolved,
            )
            if not quiet:
                print(
                    f"[notifier] {candidate.get('agent_alias')} — human consented; "
                    f"discarded {worktree or 'nothing'} and continuing in {base_cwd}"
                )
            return True
        if DECLINE_RE.match(reply):
            declined_seq = _latest_seq(turns, KIND_DECLINED)
            if declined_seq < replies[-1].get("seq", 0):
                _post_notice(
                    services,
                    api_base,
                    conv_id,
                    candidate,
                    base_cwd,
                    KIND_DECLINED,
                    f"Understood — keeping `{worktree}` intact. Please turn "
                    "**Disable worktrees** off in Settings; I'll pick up your request "
                    "in my isolated checkout right after.",
                )
            return False
        # An unrelated message while the question is open: leave the question standing.
        return False
    _post_notice(
        services,
        api_base,
        conv_id,
        candidate,
        base_cwd,
        KIND_PROMPT,
        prompt_text(worktree, base_cwd) if worktree else blocked_text(base_cwd),
    )
    if not quiet:
        print(
            f"[notifier] {candidate.get('agent_alias')} — asked the human whether to "
            f"discard {worktree or 'nothing'} or re-enable worktrees",
            file=__import__("sys").stderr,
        )
    return False


def discard_branch_name(branch: str) -> str:
    """Name under which a discarded branch's commits stay reachable."""
    suffix = branch[len("orcha/"):] if branch.startswith("orcha/") else branch
    return f"orcha-discarded/{suffix}-{int(time.time())}"
