"""FT-CONT / C1 — digest write-on-exit for headless wake workers.

A woken `claude -p` worker must snapshot a continuity digest before it exits so the
next wake rehydrates (C2) what this one was doing. Mechanism: a SessionEnd hook
(`orcha snapshot`) GATED to ORCHA_HEADLESS_WORKER=1 (the Stop hook does NOT fire in
`-p` mode, and SessionEnd can't block, so it writes the digest directly). To avoid
shadowing the RICH agent-authored digest (written during the turn via /orcha-snapshot,
e.g. from /orcha-done), the hook SKIPS when the transcript shows the agent already
POSTed its /digest this session. Interactive human tabs (marker unset) are unaffected.

These tests exercise the CLI decision logic only (no live stack): the POST itself is
covered by test_digest.py.
"""
import argparse
import json
import pathlib

from orcha_cli import __main__ as cli  # noqa: E402  (conftest puts orcha-cli on sys.path)

AID = "11111111-2222-3333-4444-555555555555"


def _make_transcript(tmp_path: pathlib.Path, records) -> str:
    p = tmp_path / "transcript.jsonl"
    p.write_text("\n".join(json.dumps(r) for r in records) + "\n")
    return str(p)


def _assistant(text):
    return {"type": "assistant", "message": {"role": "assistant",
            "content": [{"type": "text", "text": text}]}}


def _bind(tmp_path: pathlib.Path, *, api="http://test:8000", alias="Vault"):
    """Lay down a minimal Orcha project (config + one binding) under tmp_path."""
    claude = tmp_path / ".claude"
    (claude / "orcha-tabs").mkdir(parents=True)
    (claude / "orcha.json").write_text(json.dumps({"api_base_url": api}))
    (claude / "orcha-tabs" / f"{alias}.json").write_text(
        json.dumps({"alias": alias, "agent_id": AID, "container_id": "c"}))


# ---- pure helpers -------------------------------------------------------------

def test_focus_from_transcript_takes_last_assistant_line(tmp_path):
    t = _make_transcript(tmp_path, [
        _assistant("first turn"),
        {"type": "user", "message": {"role": "user", "content": "ok"}},
        _assistant("Answered Tim's request   and\nclosed it."),
    ])
    focus = cli._focus_from_transcript(t)
    assert focus == "Answered Tim's request and closed it."   # last turn, whitespace-condensed


def test_focus_from_transcript_handles_missing_file():
    assert cli._focus_from_transcript("/no/such/path.jsonl") is None
    assert cli._focus_from_transcript(None) is None


def test_rich_digest_detection_true_when_agent_posted(tmp_path):
    t = _make_transcript(tmp_path, [
        _assistant("snapshotting"),
        {"type": "assistant", "message": {"content": [{"type": "tool_use", "name": "Bash",
         "input": {"command": f"curl -X POST http://test:8000/api/agents/{AID}/digest -d '{{}}'"}}]}},
    ])
    assert cli._rich_digest_posted_this_session(t, AID) is True


def test_rich_digest_detection_false_without_post(tmp_path):
    t = _make_transcript(tmp_path, [_assistant("just answered a question, no snapshot")])
    assert cli._rich_digest_posted_this_session(t, AID) is False


# ---- cmd_snapshot decision flow ----------------------------------------------

def test_snapshot_noops_without_marker(tmp_path, monkeypatch):
    """Interactive tab (marker unset) → immediate no-op, never POSTs."""
    monkeypatch.delenv("ORCHA_HEADLESS_WORKER", raising=False)
    posted = []
    monkeypatch.setattr(cli, "_post_json", lambda url, body: posted.append((url, body)) or {})
    monkeypatch.setattr(cli, "_read_hook_stdin", lambda: {"transcript_path": "x"})
    monkeypatch.chdir(tmp_path)
    _bind(tmp_path)
    cli.cmd_snapshot(argparse.Namespace(alias="Vault"))
    assert posted == []


def test_snapshot_writes_fallback_for_headless_worker(tmp_path, monkeypatch):
    """Headless worker, no rich digest this session AND no prior digest → writes a
    fallback whose current_focus is the worker's last assistant turn."""
    monkeypatch.setenv("ORCHA_HEADLESS_WORKER", "1")
    posted = []
    monkeypatch.setattr(cli, "_post_json", lambda url, body: posted.append((url, body)) or {})
    monkeypatch.setattr(cli, "_get_json", lambda url, timeout=5.0: {"digest": None})  # no prior
    t = _make_transcript(tmp_path, [_assistant("Wrote /tmp/out.txt and answered the request.")])
    monkeypatch.setattr(cli, "_read_hook_stdin", lambda: {"transcript_path": t, "session_id": "s1"})
    monkeypatch.chdir(tmp_path)
    _bind(tmp_path)

    cli.cmd_snapshot(argparse.Namespace(alias="Vault"))

    assert len(posted) == 1, "exactly one digest POST"
    url, body = posted[0]
    assert url == f"http://test:8000/api/agents/{AID}/digest"
    assert body["current_focus"] == "Wrote /tmp/out.txt and answered the request."
    assert body["open_threads"]                                   # carries a resume hint
    assert body["decisions"] == [] and body["learnings"] == []     # nothing prior to carry
    assert body["audience"] is None                                # no prior register to carry


def test_fallback_carries_forward_prior_rich_digest(tmp_path, monkeypatch):
    """P2 fix: a thin write-on-exit fallback must NOT erase an earlier wake's rich
    digest. Since rehydrate reads only the latest row, the fallback carries forward the
    prior decisions/learnings/open_threads and only updates current_focus."""
    monkeypatch.setenv("ORCHA_HEADLESS_WORKER", "1")
    posted = []
    prior = {"digest": {
        "current_focus": "old focus from wake 1",
        "decisions": [{"text": "d1"}, {"text": "d2"}],
        "learnings": [{"text": "l1"}],
        "open_threads": [{"text": "o1"}],
        "audience": "Kedar — non-technical lead; avoid UUIDs/F1 labels, plain English.",
    }}
    monkeypatch.setattr(cli, "_post_json", lambda url, body: posted.append((url, body)) or {})
    monkeypatch.setattr(cli, "_get_json", lambda url, timeout=5.0: prior)
    t = _make_transcript(tmp_path, [_assistant("Wake 2: answered a request, did not /orcha-snapshot.")])
    monkeypatch.setattr(cli, "_read_hook_stdin", lambda: {"transcript_path": t, "session_id": "s3"})
    monkeypatch.chdir(tmp_path)
    _bind(tmp_path)

    cli.cmd_snapshot(argparse.Namespace(alias="Vault"))

    assert len(posted) == 1
    _, body = posted[0]
    # focus reflects THIS wake...
    assert body["current_focus"] == "Wake 2: answered a request, did not /orcha-snapshot."
    assert body["current_focus"] != "old focus from wake 1"
    # ...but the prior rich reasoning is preserved (not erased from rehydrate)
    assert body["decisions"] == [{"text": "d1"}, {"text": "d2"}]
    assert body["learnings"] == [{"text": "l1"}]
    assert {"text": "o1"} in body["open_threads"]                 # prior open thread kept
    assert any("Resume:" in (it.get("text") or "") for it in body["open_threads"])  # + new hint
    # #325: the plain-language register survives the no-explicit-snapshot path too.
    assert body["audience"] == "Kedar — non-technical lead; avoid UUIDs/F1 labels, plain English."


def test_fallback_carries_forward_prior_audience(tmp_path, monkeypatch):
    """#325 (Gate 2nd-pass blocker): a headless worker exiting WITHOUT an explicit
    /orcha-snapshot must carry the prior digest's `audience` (plain-language register)
    into the fallback body. Otherwise rehydrate — which reads only the latest row —
    loses the "who you're talking to" slice and the next wake reverts to jargon."""
    monkeypatch.setenv("ORCHA_HEADLESS_WORKER", "1")
    posted = []
    register = "Kedar prefers brief plain English; no bare UUIDs or internal labels."
    prior = {"digest": {
        "current_focus": "wake 1 focus",
        "decisions": [],
        "learnings": [],
        "open_threads": [],
        "audience": register,
    }}
    monkeypatch.setattr(cli, "_post_json", lambda url, body: posted.append((url, body)) or {})
    monkeypatch.setattr(cli, "_get_json", lambda url, timeout=5.0: prior)
    t = _make_transcript(tmp_path, [_assistant("Wake 2: did work, no /orcha-snapshot.")])
    monkeypatch.setattr(cli, "_read_hook_stdin", lambda: {"transcript_path": t, "session_id": "s4"})
    monkeypatch.chdir(tmp_path)
    _bind(tmp_path)

    cli.cmd_snapshot(argparse.Namespace(alias="Vault"))

    assert len(posted) == 1
    _, body = posted[0]
    assert body["audience"] == register, "the plain-language register must survive the fallback path"


def test_snapshot_skips_when_rich_digest_already_posted(tmp_path, monkeypatch):
    """Headless worker that already authored a digest this session (e.g. via /orcha-done)
    → SessionEnd fallback SKIPS so it can't shadow the rich row."""
    monkeypatch.setenv("ORCHA_HEADLESS_WORKER", "1")
    posted = []
    monkeypatch.setattr(cli, "_post_json", lambda url, body: posted.append((url, body)) or {})
    t = _make_transcript(tmp_path, [
        _assistant("Finishing up via /orcha-done."),
        {"type": "assistant", "message": {"content": [{"type": "tool_use", "name": "Bash",
         "input": {"command": f"curl -X POST http://test:8000/api/agents/{AID}/digest -d '...'"}}]}},
    ])
    monkeypatch.setattr(cli, "_read_hook_stdin", lambda: {"transcript_path": t, "session_id": "s2"})
    monkeypatch.chdir(tmp_path)
    _bind(tmp_path)

    cli.cmd_snapshot(argparse.Namespace(alias="Vault"))
    assert posted == [], "must not shadow the agent-authored digest"


def test_snapshot_noops_with_no_binding(tmp_path, monkeypatch):
    """Marked worker but not an Orcha project (no binding) → silent no-op, never raises."""
    monkeypatch.setenv("ORCHA_HEADLESS_WORKER", "1")
    posted = []
    monkeypatch.setattr(cli, "_post_json", lambda url, body: posted.append((url, body)) or {})
    monkeypatch.setattr(cli, "_read_hook_stdin", lambda: {"transcript_path": None})
    monkeypatch.chdir(tmp_path)   # empty dir, no .claude
    cli.cmd_snapshot(argparse.Namespace(alias=None))
    assert posted == []


# ---- hook registration --------------------------------------------------------

def test_sessionend_snapshot_hook_registered(tmp_path):
    """_write_hook_config wires `orcha snapshot` as a SessionEnd hook, idempotently."""
    claude = tmp_path / ".claude"
    claude.mkdir()
    assert cli._write_hook_config(claude) is True
    settings = json.loads((claude / "settings.json").read_text())
    cmds = [h.get("command")
            for entry in settings["hooks"].get("SessionEnd", [])
            for h in entry.get("hooks", [])]
    assert "orcha snapshot" in cmds
    assert "orcha unwatch" in cmds          # existing SessionEnd entry preserved
    # idempotent: a second run adds nothing new
    assert cli._write_hook_config(claude) is False
