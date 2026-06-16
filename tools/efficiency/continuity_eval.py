#!/usr/bin/env python3
"""#284 (EFFICIENCY epic) — continuity-eval harness: the QUALITY axis.

WHY THIS EXISTS
    `control_baseline.py` (#289) measures the *cost* of a wake — tokens per boot. But cost is
    only half the story: the whole point of a wake-boot is reasoning **continuity** — the
    resumed agent must still know what it was doing, what it decided, what it learned, and what
    is still open. A naive efficiency fix can drive boot tokens down by simply throwing away
    that context — cheaper boots, amnesiac agents. This harness is the guardrail: it scores how
    much of an agent's snapshotted working-state (its memory digest) actually SURVIVES into the
    boot context the resumed agent sees.

    The boot context is composed by the REAL renderer `notifier.format_persona` — the same
    `--append-system-prompt` text injected on a cold wake. So this eval tracks exactly what
    #286/#287 would change. A *good* efficiency fix shows boot bytes going DOWN while the
    continuity score stays ≈ 1.0; a fix that starts dropping digest content shows the score
    fall, and `diff` flags it.

    Mechanical and deterministic — no LLM, no API key, no provider coupling: continuity is
    scored as token-recall of each atomic digest fact against the rendered boot text. (An
    LLM-judge reconstruction mode is a deliberately-deferred extension; if added it would default
    to the latest Claude per repo standards.)

USAGE
    # score the built-in golden fixtures through the real renderer (offline, no infra) and save
    python3 tools/efficiency/continuity_eval.py run --label pre-fix

    # … apply an efficiency fix to format_persona / digest curation, then re-run …
    python3 tools/efficiency/continuity_eval.py run --label post-fix

    # diff two saved results (or the two most recent) — continuity Δ vs boot-size Δ
    python3 tools/efficiency/continuity_eval.py diff [pre.json post.json]

    # OPTIONAL live round-trip: also exercise the real POST -> store -> GET -> render chain
    # (writes throwaway digest rows to the named agent on the stack)
    python3 tools/efficiency/continuity_eval.py run --api-base http://localhost:8003 \
        --agent-id <throwaway-agent-uuid> --label live

Stdlib only. Imports the real `orcha_cli.notifier.format_persona` from this repo (no copy) so
the eval can never drift from the code it is measuring.
"""
from __future__ import annotations

import argparse
import datetime as _dt
import json
import math
import pathlib
import re
import sys
import urllib.error
import urllib.request

# Results land beside the #289 cost baselines (the dir is gitignored — machine-specific runs).
RESULT_DIR = pathlib.Path(__file__).resolve().parent / "baselines" / "continuity"
# Import the REAL boot-text renderer so the eval measures what ships, not a copy.
_REPO_ROOT = pathlib.Path(__file__).resolve().parents[2]
sys.path.insert(0, str(_REPO_ROOT / "orcha-cli"))
try:
    from orcha_cli.notifier import format_persona
except Exception as e:  # pragma: no cover - import wiring, surfaced loudly
    sys.exit(f"cannot import orcha_cli.notifier.format_persona (run from the repo): {e}")


# ---------------------------------------------------------------------------
# Golden fixtures — representative agent working-states a wake must carry forward.
# Each fixture's digest items ARE the ground-truth facts that must survive into the boot.
# Item texts use distinctive tokens so coincidental matches in the persona can't mask a drop.
# ---------------------------------------------------------------------------
_PERSONA = {"system_prompt": "You are Probe, a backend reviewer for the Orcha control project."}

CONTINUITY_FIXTURES = [
    {
        "name": "rich",  # the common case: focus + several decisions/learnings/threads
        "persona": _PERSONA,
        "digest": {
            "current_focus": "Driving PR qz-4417 through Gate after the keyset-pagination rework.",
            "decisions": [
                {"text": "Chose compound (snapshot_ts, id) keyset over bare ts to stop co-timestamp page drops."},
                {"text": "Overruled the retired-postman block per CLAUDE.md; Swagger is the contract."},
            ],
            "learnings": [
                {"text": "Assignee lives in the assignees array, never assignee_id — parsing the latter yields false None."},
                {"text": "Clear __pycache__ after mutation-testing or stale bytecode masks the RED."},
            ],
            "open_threads": [
                {"text": "PR qz-4417 sits at Gate 2nd-pass; on CLEAN it forwards to merge-into-mainline."},
                {"text": "Task tk-9920 stays needs_verification until a human verifies — never self-certify."},
            ],
        },
    },
    {
        "name": "focus_only",  # minimal but real — a single loose end
        "persona": _PERSONA,
        "digest": {
            "current_focus": "Half-way through wiring the wb-3001 fail-open spawn guard; tests not yet written.",
            "decisions": [],
            "learnings": [],
            "open_threads": [],
        },
    },
    {
        "name": "reaped_fallback",  # the machine-synthesised pre-kill digest (digest_synth.py)
        "persona": _PERSONA,
        "digest": {
            "current_focus": "[auto-synthesised on reap] Last worked on: rebasing branch bx-7782 onto mainline.",
            "decisions": [],
            "learnings": [],
            "open_threads": [
                {"text": "[auto-synthesised on reap] Resident session ended (reaped); continuity below is partial."},
                {"text": "Unanswered human message at reap: can you confirm the qm-5510 cutover window?"},
            ],
        },
    },
    {
        "name": "many_items",  # stress: lots of small facts, the kind a curation pass would trim
        "persona": _PERSONA,
        "digest": {
            "current_focus": "Sweeping the dispatch backlog; eight ready rows triaged.",
            "decisions": [{"text": f"Backlog row rk-{i:04d} classified as {kind}."}
                          for i, kind in enumerate(
                              ["queued", "eval-gated", "human-input", "done", "queued",
                               "eval-gated", "human-input", "done"], start=1)],
            "learnings": [{"text": f"Endpoint ep-{i:03d} returns the typed shape, not a bare dict."}
                          for i in range(1, 6)],
            "open_threads": [{"text": f"Follow up on thread th-{i:03d} once the merge lands."}
                             for i in range(1, 4)],
        },
    },
    {
        "name": "unicode_and_long",  # em-dashes, unicode, and a long item — escaping must not eat content
        "persona": _PERSONA,
        "digest": {
            "current_focus": "Adjudicating the spec↔build drift on §4 — the digest path diverged from _build_persona.",
            "decisions": [
                {"text": "Endorsed the doc-only amendment — heartbeat moves off rung T0→T1 (no #266 test change), "
                         "because the lease-yield path is orthogonal to the wake-rank ladder and a code change there "
                         "would reopen a settled review with zero behavioural delta."},
            ],
            "learnings": [
                {"text": "café-naïve unicode round-trips through JSONB intact when ensure_ascii is False."},
            ],
            "open_threads": [
                {"text": "Carry the §3 one-embodiment flag forward to the next reviewer — résumé of the concern is in the thread."},
            ],
        },
    },
    {
        "name": "empty",  # zero-fact digest — a vacuous but defined boundary (score is 1.0, nothing to lose)
        "persona": _PERSONA,
        "digest": {"current_focus": None, "decisions": [], "learnings": [], "open_threads": []},
    },
]


# ---------------------------------------------------------------------------
# Scorer — pure, deterministic, importable + unit-tested.
# ---------------------------------------------------------------------------
_FIELDS = ("current_focus", "decisions", "learnings", "open_threads")
_WORD = re.compile(r"[a-z0-9]+")


def _tokens(text: str) -> set[str]:
    """Lowercased alphanumeric word-tokens. Robust to JSON escaping / reordering: the renderer
    json.dumps the list values, but the words inside each fact survive verbatim."""
    return set(_WORD.findall((text or "").lower()))


def _fact_texts(digest: dict) -> list[tuple[str, str]]:
    """Flatten a digest into (field, text) atomic facts — the things a boot must carry forward.
    `current_focus` is one fact (if non-empty); each decisions/learnings/open_threads ENTRY is a
    fact. Entries may be {"text": ...} dicts (the stored shape) or bare strings."""
    facts: list[tuple[str, str]] = []
    focus = (digest or {}).get("current_focus")
    if isinstance(focus, str) and focus.strip():
        facts.append(("current_focus", focus))
    for field in ("decisions", "learnings", "open_threads"):
        for item in (digest or {}).get(field) or []:
            if isinstance(item, dict):
                text = item.get("text") or item.get("ref") or ""
            else:
                text = str(item)
            if text and text.strip():
                facts.append((field, text))
    return facts


def _fact_recall(fact_text: str, boot_tokens: set[str]) -> float:
    """Fraction of a fact's word-tokens present in the boot. 1.0 = fully carried forward;
    0.0 = dropped; partial = paraphrased/truncated. Token-with-no-words → vacuously 1.0."""
    ft = _tokens(fact_text)
    if not ft:
        return 1.0
    return len(ft & boot_tokens) / len(ft)


def score_boot(digest: dict, boot_text: str | None) -> dict:
    """Score one boot. Returns continuity_score (mean per-fact recall, each fact equal weight),
    a per-field breakdown, fact count, and the boot size (chars + a documented ~chars/4 token
    estimate). A digest with no facts scores 1.0 (nothing to lose) so empty boots aren't punished.
    """
    boot_text = boot_text or ""
    boot_tokens = _tokens(boot_text)
    facts = _fact_texts(digest)

    per_field: dict[str, dict] = {}
    recalls: list[float] = []
    for field in _FIELDS:
        field_recalls = [_fact_recall(t, boot_tokens) for f, t in facts if f == field]
        if field_recalls:
            per_field[field] = {
                "facts": len(field_recalls),
                "recall": sum(field_recalls) / len(field_recalls),
            }
            recalls.extend(field_recalls)

    score = sum(recalls) / len(recalls) if recalls else 1.0
    chars = len(boot_text)
    return {
        "continuity_score": round(score, 4),
        "facts": len(facts),
        "per_field": per_field,
        "boot_chars": chars,
        "boot_tokens_est": math.ceil(chars / 4),  # ~4 chars/token heuristic; honest proxy, no tokenizer dep
    }


# ---------------------------------------------------------------------------
# Boot rendering — offline (real renderer on fixtures) and live (POST -> store -> GET -> render).
# ---------------------------------------------------------------------------
def render_offline(fixture: dict) -> str | None:
    """Render the boot text the same way a cold wake does: notifier.format_persona over the
    fixture's persona + digest. Pure, no infra."""
    return format_persona(fixture["persona"], {"digest": fixture["digest"]})


def _get_json(url: str) -> dict:
    try:
        with urllib.request.urlopen(url, timeout=15) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        sys.exit(f"HTTP {e.code} from {url}: {e.read().decode('utf-8', 'replace')[:300]}")
    except (urllib.error.URLError, OSError) as e:
        sys.exit(f"cannot reach {url}: {e}")


def _post_json(url: str, body: dict) -> dict:
    data = json.dumps(body).encode("utf-8")
    req = urllib.request.Request(url, data=data, method="POST",
                                 headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        sys.exit(f"HTTP {e.code} from {url}: {e.read().decode('utf-8', 'replace')[:300]}")
    except (urllib.error.URLError, OSError) as e:
        sys.exit(f"cannot reach {url}: {e}")


def render_live(api_base: str, agent_id: str, fixture: dict) -> str | None:
    """Exercise the REAL store+retrieve chain: POST the fixture digest to a throwaway agent,
    then GET persona + latest digest back and render — i.e. exactly what _build_persona does on a
    cold wake. Catches store/normalize/retrieve regressions the offline path can't see. Writes a
    digest row to the named agent (use a throwaway)."""
    api_base = api_base.rstrip("/")
    _post_json(f"{api_base}/api/agents/{agent_id}/digest", fixture["digest"])
    persona = _get_json(f"{api_base}/api/agents/{agent_id}/persona")
    digest = _get_json(f"{api_base}/api/agents/{agent_id}/digest")
    return format_persona(persona, digest)


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------
def _utc_stamp() -> str:
    return _dt.datetime.now(_dt.timezone.utc).strftime("%Y%m%dT%H%M%SZ")


def evaluate(*, api_base: str | None = None, agent_id: str | None = None) -> dict:
    """Run every fixture through a boot render + score. Returns the full result record."""
    live = bool(api_base)
    if live and not agent_id:
        sys.exit("live mode (--api-base) requires --agent-id (a throwaway agent to POST digests to)")

    per_fixture = []
    for fx in CONTINUITY_FIXTURES:
        boot = render_live(api_base, agent_id, fx) if live else render_offline(fx)
        result = score_boot(fx["digest"], boot)
        result["name"] = fx["name"]
        per_fixture.append(result)

    n = len(per_fixture)
    overall = sum(r["continuity_score"] for r in per_fixture) / n if n else 1.0
    total_chars = sum(r["boot_chars"] for r in per_fixture)
    return {
        "mode": "live" if live else "offline",
        "fixtures": n,
        "overall_score": round(overall, 4),
        "total_boot_chars": total_chars,
        "mean_boot_chars": round(total_chars / n, 1) if n else 0,
        "per_fixture": per_fixture,
    }


def cmd_run(args: argparse.Namespace) -> None:
    record = evaluate(api_base=args.api_base, agent_id=args.agent_id)
    record["captured_at"] = _utc_stamp()
    record["label"] = args.label

    RESULT_DIR.mkdir(parents=True, exist_ok=True)
    fname = f"{record['captured_at']}{('-' + args.label) if args.label else ''}.json"
    out = RESULT_DIR / fname
    out.write_text(json.dumps(record, indent=2) + "\n")

    print(f"continuity result saved -> {out}   (mode={record['mode']})")
    print(f"{'fixture':<18} {'score':>7}  {'facts':>5}  {'boot_chars':>10}  {'~tok':>7}")
    print("-" * 54)
    for r in record["per_fixture"]:
        flag = "  ⚠" if r["continuity_score"] < 1.0 else ""
        print(f"{r['name']:<18} {r['continuity_score']:>7.3f}  {r['facts']:>5}  "
              f"{r['boot_chars']:>10,}  {r['boot_tokens_est']:>7,}{flag}")
    print("-" * 54)
    print(f"OVERALL continuity_score: {record['overall_score']:.3f}   "
          f"mean boot: {record['mean_boot_chars']:,} chars  "
          f"(~{math.ceil(record['mean_boot_chars'] / 4):,} tok)")


def _load(path: pathlib.Path) -> dict:
    return json.loads(path.read_text())


def _two_recent() -> tuple[pathlib.Path, pathlib.Path]:
    files = sorted(RESULT_DIR.glob("*.json"))
    if len(files) < 2:
        sys.exit(f"need >=2 continuity results in {RESULT_DIR} to diff (found {len(files)})")
    return files[-2], files[-1]


def cmd_diff(args: argparse.Namespace) -> None:
    if args.files:
        if len(args.files) != 2:
            sys.exit("diff takes exactly two result files (or none, to use the two most recent)")
        before, after = (pathlib.Path(f) for f in args.files)
    else:
        before, after = _two_recent()
    b, a = _load(before), _load(after)
    print(f"BEFORE {before.name}  (label={b.get('label')!r}, score={b.get('overall_score')}, "
          f"mean_boot={b.get('mean_boot_chars')} chars)")
    print(f"AFTER  {after.name}  (label={a.get('label')!r}, score={a.get('overall_score')}, "
          f"mean_boot={a.get('mean_boot_chars')} chars)")
    print("-" * 64)

    bf = {r["name"]: r for r in b.get("per_fixture", [])}
    af = {r["name"]: r for r in a.get("per_fixture", [])}
    print(f"{'fixture':<18} {'score Δ':>16}  {'boot_chars Δ':>22}")
    for name in sorted(set(bf) | set(af)):
        bs = bf.get(name, {}).get("continuity_score", 0.0)
        as_ = af.get(name, {}).get("continuity_score", 0.0)
        bc = bf.get(name, {}).get("boot_chars", 0)
        ac = af.get(name, {}).get("boot_chars", 0)
        ds, dc = as_ - bs, ac - bc
        flag = "  ⚠ REGRESSED" if ds < -1e-9 else ""
        print(f"{name:<18} {bs:>6.3f}->{as_:<6.3f}{ds:>+7.3f}  "
              f"{bc:>9,}->{ac:<9,}{dc:>+9,}{flag}")
    print("-" * 64)

    dscore = a.get("overall_score", 0.0) - b.get("overall_score", 0.0)
    dboot = a.get("mean_boot_chars", 0) - b.get("mean_boot_chars", 0)
    bmean = b.get("mean_boot_chars", 0) or 1
    pct = 100.0 * dboot / bmean
    print(f"OVERALL continuity_score: {b.get('overall_score'):.3f} -> {a.get('overall_score'):.3f}  "
          f"({dscore:+.3f})")
    print(f"OVERALL mean boot:        {b.get('mean_boot_chars'):,} -> {a.get('mean_boot_chars'):,} chars  "
          f"({pct:+.1f}%)")
    if dscore < -1e-9:
        print("⚠ CONTINUITY REGRESSED — boot got cheaper at the cost of carried-forward context.")
    elif dboot < 0:
        print(f"✓ boot shrank {abs(pct):.1f}% with continuity held — the win #286/#287 are after.")
    else:
        print("• continuity held; boot did not shrink.")


def main() -> None:
    p = argparse.ArgumentParser(description="Orcha #284 continuity-eval harness (boot-quality axis)")
    sub = p.add_subparsers(dest="cmd", required=True)

    r = sub.add_parser("run", help="score the golden fixtures through the real boot renderer + save")
    r.add_argument("--label", default=None, help="tag this result, e.g. pre-fix / post-fix")
    r.add_argument("--api-base", default=None,
                   help="OPTIONAL live mode: POST->store->GET->render against this stack")
    r.add_argument("--agent-id", default=None,
                   help="throwaway agent uuid to POST fixture digests to (required with --api-base)")
    r.set_defaults(func=cmd_run)

    d = sub.add_parser("diff", help="diff two results (default: two most recent)")
    d.add_argument("files", nargs="*", help="before.json after.json (optional)")
    d.set_defaults(func=cmd_diff)

    args = p.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
