"""Guard: the dashboard's WORKER_LAUNCH_FLAGS display must never drift from the flags the
notifier actually passes when it spawns a worker.

The Controls card renders `main.WORKER_LAUNCH_FLAGS` (served via /api/models). The real
launch argv is built independently in `notifier.spawn_headless`. These live in two separate
runtimes (portal container vs host daemon) and can't share a constant, so this test ties them
together: it drives spawn_headless in dry-run mode (which returns the exact command repr) and
asserts every flag marked `static` in the display constant appears verbatim in what is really
launched, per runtime. If someone changes the spawn flags without updating the dashboard (or
vice versa), this fails.
"""
import pathlib

import main  # portal app (on sys.path via conftest)
from orcha_cli import notifier


def _spawn_repr(runtime):
    """The exact command repr the daemon would run for a worker of this runtime."""
    _, cmd, _ = notifier.spawn_headless(
        "/proj", "hi", None, dry_run=True,
        runtime=runtime,
        model=("gpt-5.5" if runtime == "codex" else "claude-opus-4-8"),
        system_prompt="You are Tim.",
        last_message_path=(pathlib.Path("/tmp/last.txt") if runtime == "codex" else None),
    )
    return cmd


def test_static_flags_match_notifier_spawn():
    for runtime in ("claude", "codex"):
        cmd = _spawn_repr(runtime)
        for entry in main.WORKER_LAUNCH_FLAGS[runtime]:
            if entry.get("static"):
                assert entry["flag"] in cmd, (
                    f"{runtime}: displayed flag {entry['flag']!r} is not in the actual "
                    f"spawn command, so the dashboard would lie: {cmd}"
                )


def test_dynamic_flags_present_when_supplied():
    # --model is dynamic; with a model supplied it must surface in the real spawn.
    for runtime in ("claude", "codex"):
        cmd = _spawn_repr(runtime)
        assert "--model" in cmd, f"{runtime}: --model missing from spawn: {cmd}"


def test_runtimes_and_reasoning_gap_documented():
    assert set(main.WORKER_LAUNCH_FLAGS) == {"claude", "codex"}
    # The reasoning-effort gap (#241) is surfaced as an explicit not-set row on both runtimes,
    # so the omission is visible in the UI rather than silent.
    for runtime in ("claude", "codex"):
        unset = [e for e in main.WORKER_LAUNCH_FLAGS[runtime] if e.get("set") is False]
        assert any("Reasoning" in e["label"] for e in unset), (
            f"{runtime}: reasoning-effort gap should be shown as a not-set row"
        )
