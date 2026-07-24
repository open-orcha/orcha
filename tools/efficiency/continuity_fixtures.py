"""Representative memory digests used by the continuity quality harness."""

_PERSONA = {
    "system_prompt": "You are Probe, a backend reviewer for the Orcha control project."
}

CONTINUITY_FIXTURES = [
    {
        "name": "rich",
        "persona": _PERSONA,
        "digest": {
            "current_focus": (
                "Driving PR qz-4417 through Gate after the keyset-pagination rework."
            ),
            "decisions": [
                {
                    "text": (
                        "Chose compound (snapshot_ts, id) keyset over bare ts to stop "
                        "co-timestamp page drops."
                    )
                },
                {
                    "text": (
                        "Overruled the retired-postman block per CLAUDE.md; Swagger is "
                        "the contract."
                    )
                },
            ],
            "learnings": [
                {
                    "text": (
                        "Assignee lives in the assignees array, never assignee_id — "
                        "parsing the latter yields false None."
                    )
                },
                {
                    "text": (
                        "Clear __pycache__ after mutation-testing or stale bytecode "
                        "masks the RED."
                    )
                },
            ],
            "open_threads": [
                {
                    "text": (
                        "PR qz-4417 sits at Gate 2nd-pass; on CLEAN it forwards to "
                        "merge-into-mainline."
                    )
                },
                {
                    "text": (
                        "Task tk-9920 stays needs_verification until a human verifies "
                        "— never self-certify."
                    )
                },
            ],
        },
    },
    {
        "name": "focus_only",
        "persona": _PERSONA,
        "digest": {
            "current_focus": (
                "Half-way through wiring the wb-3001 fail-open spawn guard; tests not "
                "yet written."
            ),
            "decisions": [],
            "learnings": [],
            "open_threads": [],
        },
    },
    {
        "name": "reaped_fallback",
        "persona": _PERSONA,
        "digest": {
            "current_focus": (
                "[auto-synthesised on reap] Last worked on: rebasing branch bx-7782 "
                "onto mainline."
            ),
            "decisions": [],
            "learnings": [],
            "open_threads": [
                {
                    "text": (
                        "[auto-synthesised on reap] Resident session ended (reaped); "
                        "continuity below is partial."
                    )
                },
                {
                    "text": (
                        "Unanswered human message at reap: can you confirm the qm-5510 "
                        "cutover window?"
                    )
                },
            ],
        },
    },
    {
        "name": "many_items",
        "persona": _PERSONA,
        "digest": {
            "current_focus": "Sweeping the dispatch backlog; eight ready rows triaged.",
            "decisions": [
                {"text": f"Backlog row rk-{i:04d} classified as {kind}."}
                for i, kind in enumerate(
                    [
                        "queued",
                        "eval-gated",
                        "human-input",
                        "done",
                        "queued",
                        "eval-gated",
                        "human-input",
                        "done",
                    ],
                    start=1,
                )
            ],
            "learnings": [
                {
                    "text": (
                        f"Endpoint ep-{i:03d} returns the typed shape, not a bare dict."
                    )
                }
                for i in range(1, 6)
            ],
            "open_threads": [
                {
                    "text": (
                        f"Follow up on thread th-{i:03d} once the merge lands."
                    )
                }
                for i in range(1, 4)
            ],
        },
    },
    {
        "name": "unicode_and_long",
        "persona": _PERSONA,
        "digest": {
            "current_focus": (
                "Adjudicating the spec↔build drift on §4 — the digest path diverged "
                "from _build_persona."
            ),
            "decisions": [
                {
                    "text": (
                        "Endorsed the doc-only amendment — heartbeat moves off rung "
                        "T0→T1 (no #266 test change), because the lease-yield path is "
                        "orthogonal to the wake-rank ladder and a code change there "
                        "would reopen a settled review with zero behavioural delta."
                    )
                },
            ],
            "learnings": [
                {
                    "text": (
                        "café-naïve unicode round-trips through JSONB intact when "
                        "ensure_ascii is False."
                    )
                },
            ],
            "open_threads": [
                {
                    "text": (
                        "Carry the §3 one-embodiment flag forward to the next reviewer "
                        "— résumé of the concern is in the thread."
                    )
                },
            ],
        },
    },
    {
        "name": "empty",
        "persona": _PERSONA,
        "digest": {
            "current_focus": None,
            "decisions": [],
            "learnings": [],
            "open_threads": [],
        },
    },
]
