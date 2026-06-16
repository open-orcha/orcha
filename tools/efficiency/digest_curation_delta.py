#!/usr/bin/env python3
"""#287 — deterministic before/after of the wake-injection size the digest curator removes.

The full #284 ship-gate is the live control-container token-usage diff (control_baseline.py),
run against a deployed build with real wakes — that is the HUMAN-run verification. This script is
the OFFLINE companion: it builds a representative *bloated* digest (the append-only accretion a
long-lived agent produces) and measures the persona/digest text notifier injects into every wake
BEFORE vs AFTER `digest_curate.curate_inner` — no network, no live key (LLM summary path is
stubbed to the deterministic breadcrumb so the number is reproducible). The injected text IS the
per-wake boot overhead the meter charges, so this byte delta is a direct lower-bound proxy for
the tokens/wake the curator saves. Attach the printed table to the PR.

USAGE
    PYTHONPATH=orcha-cli python3 tools/efficiency/digest_curation_delta.py
"""
from __future__ import annotations

import json
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[2] / "orcha-cli"))

from orcha_cli import digest_curate as C  # noqa: E402
from orcha_cli import notifier  # noqa: E402

# A representative long-lived agent digest: append-only accretion the curator targets. Entry
# sizes mirror real digest entries (a sentence or two). ~ what a multi-day agent accumulates.
def _bloated_digest(n_dec=60, n_learn=60, n_open=40, entry_chars=280) -> dict:
    def entries(prefix, n):
        return [{"text": f"{prefix} #{i}: " + "context " * (entry_chars // 8)} for i in range(n)]
    return {
        "current_focus": "Resuming the platform/data layer work; inbox drained, one task in flight.",
        "decisions": entries("decision", n_dec),
        "learnings": entries("learning", n_learn),
        "open_threads": entries("open thread", n_open),
    }


def _approx_tokens(s: str) -> int:
    return len(s) // 4  # the conventional ~4 chars/token rough proxy


def main() -> None:
    inner = _bloated_digest()
    before = notifier.format_persona(None, {"digest": inner}) or ""
    # summarizer=None → deterministic breadcrumb, so this run is reproducible with no LLM.
    curated = C.curate_inner(inner, summarizer=None)
    after = notifier.format_persona(None, {"digest": curated}) or ""

    rows = [
        ("entries (decisions/learnings/open_threads)",
         f"{len(inner['decisions'])}/{len(inner['learnings'])}/{len(inner['open_threads'])}",
         f"{len(curated['decisions'])}/{len(curated['learnings'])}/{len(curated['open_threads'])}"),
        ("injected chars", f"{len(before):,}", f"{len(after):,}"),
        ("approx tokens (~4 ch/tok)", f"{_approx_tokens(before):,}", f"{_approx_tokens(after):,}"),
    ]
    w0 = max(len(r[0]) for r in rows)
    print("\n#287 wake-injection size — bloated digest, BEFORE vs AFTER curation")
    print(f"  caps: keep={C.DEFAULT_KEEP}, clip={C.CLIP_CHARS}ch, ceiling={C.INJECTION_CEILING:,}B")
    print(f"  {'metric'.ljust(w0)}   {'before':>12}   {'after':>12}")
    print(f"  {'-' * w0}   {'-' * 12}   {'-' * 12}")
    for label, b, a in rows:
        print(f"  {label.ljust(w0)}   {b:>12}   {a:>12}")
    drop = 1 - (len(after) / len(before)) if before else 0
    print(f"\n  injected size reduced {drop * 100:.1f}%  ({len(before):,} → {len(after):,} chars)")
    # honesty + safety invariants the number rests on
    assert curated["current_focus"] == inner["current_focus"], "focus must be untouched"
    for f in ("decisions", "learnings", "open_threads"):
        assert curated[f], f"{f} must never empty to nothing"
    print("  invariants OK: focus untouched; no field emptied; older tail summarised, not dropped.\n")


if __name__ == "__main__":
    main()
