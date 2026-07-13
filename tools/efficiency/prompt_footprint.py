#!/usr/bin/env python3
"""GH #34 (scoped) — per-section footprint of the per-wake prompt.

WHY THIS EXISTS
    GH #34 proposes adopting Headroom to cut agent-run cost; this repo does NOT adopt an
    external dependency for that (see the issue's scoped low-hanging-fruit carve-out). Before
    optimizing anything, this script answers the first question a cache/compression effort
    needs: where do the per-wake tokens actually go? It measures the FOUR sections GH #34 names
    — protocol (the standing RULES), digest (the memory digest), manifest (the ranked wake
    event summary), and task body (title + description + definition_of_done) — using the REAL
    renderers (`notifier.format_persona` / `notifier.build_wake_prompt`, the same functions a
    live wake calls), against representative fixture data. No network, no LLM, no live key —
    reproducible offline.

    Companion to `digest_curation_delta.py` (which measures ONE section's before/after under
    curation) and `continuity_eval.py` (which guards digest-curation quality) — this one gives
    the whole-prompt breakdown those two don't.

USAGE
    PYTHONPATH=orcha-cli python3 tools/efficiency/prompt_footprint.py

Stdlib only — no deps, runs anywhere Python 3.9+ does.
"""
from __future__ import annotations

import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[2] / "orcha-cli"))

from orcha_cli import notifier  # noqa: E402

# Representative fixtures — sized like a real, moderately-active agent mid-task (not an
# empty-cold-boot minimum, not the append-only-accretion worst case digest_curation_delta.py
# already covers).
_PERSONA = {"system_prompt": (
    "You are Ethan, the iOS Developer on the Orcha team. Your primary charter is GitHub issue "
    "#30 (open-orcha/orcha): build a native iOS app that lets a user connect to their "
    "locally-running Orcha stack and manage their agents on the go."
)}

_PROTOCOL = {
    "task_id": "94cd22d4-de79-45d9-b896-047e00c77aa2",
    "title": "GH #34 (scoped): prompt-footprint measurement + stable prefix ordering",
    "description": (
        "the LOW-HANGING part in scope here is: (1) instrument/measure what the per-wake "
        "prompt actually costs (footprint per section: protocol, digest, manifest, task body), "
        "and (2) reorder prompt assembly so the stable parts form a consistent prefix across "
        "wakes (cache-friendly ordering), without any external dependency."
    ),
    "definition_of_done": (
        "a measurement artifact showing per-section prompt footprint, plus the prefix-ordering "
        "change with tests that the assembled prompt keeps stable sections first; focused "
        "suites green; PR opened; Code Reviewer verdict CLEAN."
    ),
    "protocol": {
        "review_chain": "Builder -> Code Reviewer until CLEAN -> CodeCleanupAgent lead-review "
                        "+ merge into integration/low-hanging-fruits -> kedar verifies",
        "handoff_to": "CodeCleanupAgent",
        "autonomy": "Build autonomously on your child branch. Loop with Code Reviewer until "
                    "CLEAN before answering.",
        "notes": "REPORT BACK: when materially finished, post your result to the originating "
                "request before moving on.",
    },
}

_DIGEST = {"digest": {
    "audience": "Talking to Kedar — non-engineer; wants plain answers, no jargon or UUIDs.",
    "current_focus": "Measuring per-wake prompt footprint and reordering assembly for GH #34.",
    "decisions": ["Reorder format_persona so digest/resume renders last, after protocol",
                  "Reorder build_wake_prompt so the fixed instructions precede the volatile "
                  "per-wake manifest/directed-message summary"],
    "learnings": ["build_wake_prompt (user turn) and format_persona (system prompt via "
                 "--append-system-prompt) are two separate strings assembled independently",
                 "The digest and the wake manifest are the two sections that vary almost every "
                 "wake; everything else is stable per-agent or per-task"],
    "open_threads": ["Confirm Code Reviewer verdict CLEAN before handing off to CodeCleanupAgent"],
}}

_WAKE_CANDIDATE = {
    "alias": "Ethan",
    "pending_events": 3,
    "notifications": [
        {"rank": 1, "rank_label": "task_request_in", "surface": "request:664309b8",
         "actor_alias": "CodeCleanupAgent", "object_priority": 50, "is_task_request": True,
         "preview": "Lead status ping: no branch for GH #34 on origin yet"},
        {"rank": 2, "rank_label": "human_conversation", "surface": "request:9f1c2e0a",
         "actor_alias": "kedar", "object_priority": 70,
         "preview": "quick question about the prefix-ordering approach"},
        {"rank": 3, "rank_label": "task", "surface": "task:94cd22d4",
         "actor_alias": "CodeCleanupAgent", "object_priority": 50,
         "preview": "reminder: branch off integration/low-hanging-fruits"},
    ],
    "prompt_messages": ["[task-thread message on task 94cd22d4] Lead status ping: no branch "
                        "for GH #34 on origin yet. Reminder: branch off integration."],
    "wake_task_id": "94cd22d4-de79-45d9-b896-047e00c77aa2",
}


def _approx_tokens(s: str) -> int:
    return len(s) // 4  # the conventional ~4 chars/token rough proxy


def _measure(label: str, text: str) -> tuple:
    n = len(text or "")
    return (label, n, _approx_tokens(text or ""))


def main() -> None:
    # Isolate each section via the SAME renderers a real wake calls, so this can never drift
    # from the code it measures.
    protocol_only = notifier._render_protocol(_PROTOCOL) or ""
    task_body_only = notifier._render_task_body(_PROTOCOL) or ""
    digest_only = notifier.format_persona(None, _DIGEST) or ""   # persona=None -> digest-only path
    manifest_prompt = notifier.build_wake_prompt(_WAKE_CANDIDATE)
    # the manifest ITSELF (not the fixed instructions around it) — the volatile per-wake slice.
    manifest_start = manifest_prompt.index("[orcha wake]")
    manifest_only = manifest_prompt[manifest_start:]

    full_system_prompt = notifier.format_persona(_PERSONA, _DIGEST, _PROTOCOL) or ""

    rows = [
        _measure("protocol (standing RULES)", protocol_only),
        _measure("digest (memory digest, incl. audience)", digest_only),
        _measure("manifest (ranked wake events + directed msg)", manifest_only),
        _measure("task body (title + description + DoD)", task_body_only),
    ]
    w0 = max(len(r[0]) for r in rows)
    print("\nGH #34 — per-wake prompt footprint by section (fixture data, offline/reproducible)")
    print(f"  {'section'.ljust(w0)}   {'chars':>8}   {'~tokens (4ch/tok)':>18}")
    print(f"  {'-' * w0}   {'-' * 8}   {'-' * 18}")
    for label, chars, tokens in rows:
        print(f"  {label.ljust(w0)}   {chars:>8,}   {tokens:>18,}")
    total_measured = sum(r[1] for r in rows)
    print(f"\n  sum of the four sections above: {total_measured:,} chars "
          f"(~{total_measured // 4:,} tokens)")
    print(f"  full system prompt (persona+guardrail+task body+protocol+digest), "
          f"as actually injected via --append-system-prompt: "
          f"{len(full_system_prompt):,} chars (~{_approx_tokens(full_system_prompt):,} tokens)")
    print(f"  full user-turn wake prompt (fixed instructions + manifest), "
          f"as actually passed to `claude -p`: "
          f"{len(manifest_prompt):,} chars (~{_approx_tokens(manifest_prompt):,} tokens)")
    print()


if __name__ == "__main__":
    main()
