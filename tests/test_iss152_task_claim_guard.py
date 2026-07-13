"""GH #152 — hard-fail a hallucinated task-creation claim.

An agent can narrate "I created/started task <id>" in its reply text without the
underlying create-task/accept-task API call ever actually persisting (call skipped,
failed silently, or the model's text ran ahead of the tool result). `orcha
task-claim-guard` is a SessionEnd hook (Stop hooks don't fire for headless `claude -p`
workers, see `cmd_snapshot`) that scans the session's last reply for that claim shape and
cross-checks it against the live container task list, hard-failing loudly on a mismatch:
a digest override visible on the next `orcha rehydrate`, and either a message on the
agent's own live task thread or an escalated request to a human when it has none.

These tests exercise the CLI decision logic only (no live stack): pure regex-extraction
unit tests, then `cmd_task_claim_guard`'s decision flow with `_get_json`/`_post_json`
monkeypatched.
"""
import argparse
import json
import pathlib
from urllib.parse import urlparse, parse_qs

from orcha_cli import __main__ as cli  # noqa: E402  (conftest puts orcha-cli on sys.path)

AID = "11111111-2222-3333-4444-555555555555"
CID = "99999999-8888-7777-6666-555555555555"
REAL_TASK = "3f146113-932c-4f77-ba6c-b917544297f4"
FAKE_TASK = "abcdefab-1234-5678-9abc-def012345678"
REQUEST_ID = "9aa9752b-f694-4c6d-adb4-89525b44bd6e"
PAGE1_FILLER_TASK = "11112222-3333-4444-5555-666677778888"


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
        json.dumps({"alias": alias, "agent_id": AID, "container_id": CID}))


# ---- pure helper: _extract_claimed_task_ids ------------------------------------------

def test_extract_claimed_task_ids_matches_creation_claim():
    text = f"Task {REAL_TASK} created, assigned to me, status in_progress."
    assert cli._extract_claimed_task_ids(text) == [REAL_TASK]


def test_extract_claimed_task_ids_matches_verb_before_task_word():
    text = f"I created task {REAL_TASK} to track this follow-up."
    assert cli._extract_claimed_task_ids(text) == [REAL_TASK]


def test_extract_claimed_task_ids_ignores_unrelated_uuid_in_same_reply():
    """A request id mentioned nearby a real task claim must not get swept in — only
    the uuid actually adjacent to the word 'task' counts."""
    text = (f"Responded to request {REQUEST_ID} about install instructions. "
            f"Also created task {REAL_TASK}, assigned to me, status in_progress.")
    assert cli._extract_claimed_task_ids(text) == [REAL_TASK]


def test_extract_claimed_task_ids_ignores_mere_reference_without_creation_verb():
    """Just mentioning an existing task (no creation/start claim) is not a claim."""
    text = f"See task {REAL_TASK} for details on the ongoing work."
    assert cli._extract_claimed_task_ids(text) == []


def test_extract_claimed_task_ids_ignores_sentence_without_task_word():
    """A creation verb alone, with no 'task' near the uuid, is not a claim (e.g. a
    request or agent id in a sentence that happens to also use the word 'created')."""
    text = f"I created request {REQUEST_ID} to escalate this."
    assert cli._extract_claimed_task_ids(text) == []


def test_extract_claimed_task_ids_ignores_id_with_task_word_only_later_in_sentence():
    """Review-round-1 false positive: the word 'task' appearing LATER in the sentence,
    describing something else entirely, must not sweep in an unrelated id that merely
    precedes it — only a uuid directly adjacent to 'task' counts."""
    text = f"Created request {REQUEST_ID} for task follow-up."
    assert cli._extract_claimed_task_ids(text) == []


def test_extract_claimed_task_ids_ignores_accepted_request_for_task_review():
    """Same false-positive family, 'accepted' verb variant."""
    text = f"Accepted request {REQUEST_ID} for task review."
    assert cli._extract_claimed_task_ids(text) == []


def test_extract_claimed_task_ids_dedupes_repeated_claim():
    text = (f"Task {REAL_TASK} created. "
            f"To confirm: task {REAL_TASK} was created and started.")
    assert cli._extract_claimed_task_ids(text) == [REAL_TASK]


def test_extract_claimed_task_ids_empty_on_blank_or_none():
    assert cli._extract_claimed_task_ids("") == []
    assert cli._extract_claimed_task_ids(None) == []


def test_extract_claimed_task_ids_lowercases():
    text = f"Task {REAL_TASK.upper()} created, assigned to me."
    assert cli._extract_claimed_task_ids(text) == [REAL_TASK.lower()]


def test_extract_claimed_task_ids_matches_skill_taught_task_id_colon_phrasing():
    """Review-round-3: the orcha-task-new skill teaches agents to report success as
    'task_id: <uuid>, status: ...' (step 6). `\\btask\\b` alone never matches "task_id"
    since '_' is a word char — no boundary sits between "task" and "_id" — so this exact
    skill-taught phrasing was silently skipped by the extractor. Must match now."""
    text = f"Created task_id: {REAL_TASK}, status: in_progress, assignee_alias: Vault."
    assert cli._extract_claimed_task_ids(text) == [REAL_TASK]


def test_extract_claimed_task_ids_matches_task_id_equals_phrasing():
    text = f"Spawned task_id={REAL_TASK} for this follow-up."
    assert cli._extract_claimed_task_ids(text) == [REAL_TASK]


def test_extract_claimed_task_ids_still_ignores_task_follow_up_with_task_id_claim_nearby():
    """Non-regression (round 1/2 false positive): an unrelated uuid earlier in the
    sentence, with 'task' only appearing later describing something else, must still not
    be swept in — even now that 'task_id' is also a recognized adjacency spelling."""
    text = f"Created request {REQUEST_ID} for task_id follow-up planning."
    assert cli._extract_claimed_task_ids(text) == []


def test_extract_claimed_task_ids_matches_terse_status_ready_report_without_verb():
    """Review-round-4: the orcha-task-new skill's step-6 report is TERSE and has no
    creation verb at all — 'task_id: <uuid>, status: ready' — so the verb-required
    adjacency match alone silently skipped it. The status field itself is the claim."""
    text = f"task_id: {REAL_TASK}, status: ready, assignee_alias: (unassigned)."
    assert cli._extract_claimed_task_ids(text) == [REAL_TASK]


def test_extract_claimed_task_ids_matches_terse_status_pending_report_without_verb():
    text = f"task_id: {REAL_TASK}, status: pending, depends_on: 2."
    assert cli._extract_claimed_task_ids(text) == [REAL_TASK]


def test_extract_claimed_task_ids_terse_status_still_ignores_unrelated_uuid():
    """The terse-status pattern must obey the same adjacency discipline as the verb path:
    an unrelated uuid with 'task' only appearing later, and no status field near IT, must
    not be swept in even though the reply elsewhere reports an unrelated status."""
    text = (f"Responded to request {REQUEST_ID} for task follow-up. "
            f"Current queue status: pending review.")
    assert cli._extract_claimed_task_ids(text) == []


def test_extract_claimed_task_ids_matches_backtick_wrapped_id():
    """Review-round-4: Markdown/code-formatted task ids — the uuid itself wrapped in a
    code span — must not dodge detection just because of the extra backtick chars."""
    text = f"Created task `{REAL_TASK}`, assigned to me, status in_progress."
    assert cli._extract_claimed_task_ids(text) == [REAL_TASK]


def test_extract_claimed_task_ids_matches_backtick_wrapped_terse_status_report():
    """Combined case: the skill-taught terse report with the id itself code-formatted."""
    text = f"task_id: `{REAL_TASK}`, status: ready."
    assert cli._extract_claimed_task_ids(text) == [REAL_TASK]


def test_extract_claimed_task_ids_matches_multiline_task_id_then_status():
    """Review-round-5: the orcha-task-new skill's step-6 report is written as separate
    lines ('task_id, status (pending / ready / in_progress)', one field per line) MORE
    often than crammed onto a single line, so task_id and status usually land on adjacent
    lines rather than the same one. That split must not let the claim slip past."""
    text = f"task_id: {REAL_TASK}\nstatus: ready\nassignee_alias: (unassigned)"
    assert cli._extract_claimed_task_ids(text) == [REAL_TASK]


def test_extract_claimed_task_ids_matches_bulleted_task_id_then_status():
    """Same gap, bulleted-list rendering — the natural Markdown shape for the step-6
    report items."""
    text = f"- task_id: {REAL_TASK}\n- status: pending\n- depends_on: 0"
    assert cli._extract_claimed_task_ids(text) == [REAL_TASK]


def test_extract_claimed_task_ids_multiline_status_still_ignores_unrelated_uuid():
    """Non-regression: splitting the terse-status match across lines must not turn it
    into an unbounded 'any status anywhere later in the reply' trigger — 'task' appearing
    on its own bulleted line, with no uuid adjacent to it, still must not sweep in an
    unrelated id from a different bullet even when a status field follows a few lines
    down."""
    text = (f"- request_id: {REQUEST_ID}\n"
            "- summary: escalated for task follow-up\n"
            "- status: pending")
    assert cli._extract_claimed_task_ids(text) == []


def test_extract_claimed_task_ids_multiline_terse_status_bounded_past_long_filler():
    """Non-regression: the multiline gap is capped at two short (<=60-char) line hops, so
    a real task_id mention followed much later by an unrelated status line — separated by
    long filler content — must not be swept in just because 'status' eventually appears
    somewhere downstream in the same reply."""
    text = (
        f"task_id: {REAL_TASK}\n"
        "some unrelated multi-line report content that goes on for a good while "
        "describing something else entirely and is definitely not a status field here\n"
        "even more filler content padding this section out well past the bounded gap\n"
        "status: pending"
    )
    assert cli._extract_claimed_task_ids(text) == []


# ---- cmd_task_claim_guard decision flow -----------------------------------------------

def _tasks_response(tasks):
    return {"tasks": tasks}


def test_guard_noop_when_no_claim_in_transcript(tmp_path, monkeypatch):
    """No task-creation-shaped claim in the last reply → fast no-op, zero API calls."""
    calls = []
    monkeypatch.setattr(cli, "_get_json", lambda *a, **k: calls.append(("GET", a, k)) or None)
    monkeypatch.setattr(cli, "_post_json", lambda *a, **k: calls.append(("POST", a, k)) or {})
    t = _make_transcript(tmp_path, [_assistant("Answered Tim's request and closed it.")])
    monkeypatch.setattr(cli, "_read_hook_stdin", lambda: {"transcript_path": t})
    monkeypatch.chdir(tmp_path)
    _bind(tmp_path)

    cli.cmd_task_claim_guard(argparse.Namespace(alias="Vault"))

    assert calls == []


def test_guard_noop_when_claimed_task_exists(tmp_path, monkeypatch):
    """The claimed task really is in the container's task list → verified, silent."""
    posted = []
    monkeypatch.setattr(cli, "_get_json",
                         lambda url, timeout=5.0: _tasks_response([{"id": REAL_TASK,
                                                                     "status": "in_progress",
                                                                     "assignees": ["Vault"]}]))
    monkeypatch.setattr(cli, "_post_json", lambda url, body: posted.append((url, body)) or {})
    t = _make_transcript(tmp_path, [
        _assistant(f"Task {REAL_TASK} created, assigned to me, status in_progress.")])
    monkeypatch.setattr(cli, "_read_hook_stdin", lambda: {"transcript_path": t})
    monkeypatch.chdir(tmp_path)
    _bind(tmp_path)

    cli.cmd_task_claim_guard(argparse.Namespace(alias="Vault"))

    assert posted == []


def test_guard_pages_past_first_page_before_declaring_task_missing(tmp_path, monkeypatch):
    """TEETH: `GET .../tasks` defaults to a 10-row page — a claimed task sitting on page 2
    must not be declared missing just because it isn't on page 1. Revert the paging fix
    (fetch a single page) and this goes red: the guard would wrongly hard-fail on
    REAL_TASK even though it's genuinely in the container's (longer) task list."""
    posted = []

    def fake_get_json(url, timeout=5.0):
        if url.endswith("/digest"):
            return {"digest": None}
        offset = int((parse_qs(urlparse(url).query).get("offset") or ["0"])[0])
        if offset == 0:
            return {"tasks": [{"id": PAGE1_FILLER_TASK, "status": "in_progress",
                                "assignees": []}], "has_more": True}
        return {"tasks": [{"id": REAL_TASK, "status": "in_progress",
                            "assignees": ["Vault"]}], "has_more": False}

    monkeypatch.setattr(cli, "_get_json", fake_get_json)
    monkeypatch.setattr(cli, "_post_json", lambda url, body: posted.append((url, body)) or {})
    t = _make_transcript(tmp_path, [
        _assistant(f"Task {REAL_TASK} created, assigned to me, status in_progress.")])
    monkeypatch.setattr(cli, "_read_hook_stdin", lambda: {"transcript_path": t})
    monkeypatch.chdir(tmp_path)
    _bind(tmp_path)

    cli.cmd_task_claim_guard(argparse.Namespace(alias="Vault"))

    assert posted == []  # found on page 2 — verified, no false hard-fail


def test_guard_hard_fails_and_flags_thread_when_agent_has_live_task(tmp_path, monkeypatch, capsys):
    """TEETH: claimed task is NOT in the DB → digest override AND a message posted to
    the agent's own live in_progress task thread. Revert the fix (make this a no-op) and
    this test goes red."""
    posted = []
    monkeypatch.setattr(cli, "_get_json",
                         lambda url, timeout=5.0: (
                             {"digest": None} if url.endswith("/digest")
                             else _tasks_response([{"id": REAL_TASK, "status": "in_progress",
                                                     "assignees": ["Vault"]}])))
    monkeypatch.setattr(cli, "_post_json", lambda url, body: posted.append((url, body)) or {})
    t = _make_transcript(tmp_path, [
        _assistant(f"Task {FAKE_TASK} created, assigned to me, status in_progress.")])
    monkeypatch.setattr(cli, "_read_hook_stdin", lambda: {"transcript_path": t})
    monkeypatch.chdir(tmp_path)
    _bind(tmp_path)

    cli.cmd_task_claim_guard(argparse.Namespace(alias="Vault"))

    assert len(posted) == 2, "expected a digest POST and a thread-message POST"
    digest_calls = [p for p in posted if p[0] == f"http://test:8000/api/agents/{AID}/digest"]
    thread_calls = [p for p in posted if p[0] == f"http://test:8000/api/tasks/{REAL_TASK}/messages"]
    assert len(digest_calls) == 1
    assert FAKE_TASK in digest_calls[0][1]["current_focus"]
    assert len(thread_calls) == 1
    assert FAKE_TASK in thread_calls[0][1]["body"]
    assert thread_calls[0][1]["author_agent_id"] == AID
    assert "HARD-FAIL" in capsys.readouterr().out


def test_guard_escalates_when_agent_has_no_live_task(tmp_path, monkeypatch):
    """TEETH: same fabricated claim, but the agent has no in_progress task to post on
    → escalates a new request straight to a human instead (target omitted)."""
    posted = []
    monkeypatch.setattr(cli, "_get_json",
                         lambda url, timeout=5.0: (
                             {"digest": None} if url.endswith("/digest")
                             else _tasks_response([])))
    monkeypatch.setattr(cli, "_post_json", lambda url, body: posted.append((url, body)) or {})
    t = _make_transcript(tmp_path, [
        _assistant(f"Task {FAKE_TASK} created, assigned to me, status in_progress.")])
    monkeypatch.setattr(cli, "_read_hook_stdin", lambda: {"transcript_path": t})
    monkeypatch.chdir(tmp_path)
    _bind(tmp_path)

    cli.cmd_task_claim_guard(argparse.Namespace(alias="Vault"))

    escalations = [p for p in posted if p[0] == f"http://test:8000/api/containers/{CID}/requests"]
    assert len(escalations) == 1
    body = escalations[0][1]
    assert "target_alias" not in body            # omitted target == escalated to human
    assert FAKE_TASK in body["payload"]
    assert body["requester_agent_id"] == AID


def test_guard_never_raises_without_binding(tmp_path, monkeypatch):
    """No .claude/orcha-tabs binding in this folder → silent no-op, never raises."""
    posted = []
    monkeypatch.setattr(cli, "_get_json", lambda *a, **k: None)
    monkeypatch.setattr(cli, "_post_json", lambda url, body: posted.append((url, body)) or {})
    t = _make_transcript(tmp_path, [
        _assistant(f"Task {FAKE_TASK} created, assigned to me, status in_progress.")])
    monkeypatch.setattr(cli, "_read_hook_stdin", lambda: {"transcript_path": t})
    monkeypatch.chdir(tmp_path)
    (tmp_path / ".claude").mkdir()
    (tmp_path / ".claude" / "orcha.json").write_text(json.dumps({"api_base_url": "http://test:8000"}))

    cli.cmd_task_claim_guard(argparse.Namespace(alias="Vault"))  # must not raise

    assert posted == []


def test_guard_never_raises_when_api_unreachable(tmp_path, monkeypatch):
    """The tasks-list GET fails/returns None (API outage) → don't false-alarm, no-op."""
    posted = []
    monkeypatch.setattr(cli, "_get_json", lambda *a, **k: None)
    monkeypatch.setattr(cli, "_post_json", lambda url, body: posted.append((url, body)) or {})
    t = _make_transcript(tmp_path, [
        _assistant(f"Task {FAKE_TASK} created, assigned to me, status in_progress.")])
    monkeypatch.setattr(cli, "_read_hook_stdin", lambda: {"transcript_path": t})
    monkeypatch.chdir(tmp_path)
    _bind(tmp_path)

    cli.cmd_task_claim_guard(argparse.Namespace(alias="Vault"))  # must not raise

    assert posted == []


def test_guard_never_raises_on_malformed_transcript(tmp_path, monkeypatch):
    monkeypatch.setattr(cli, "_read_hook_stdin", lambda: {"transcript_path": "/no/such/file.jsonl"})
    monkeypatch.chdir(tmp_path)
    _bind(tmp_path)

    cli.cmd_task_claim_guard(argparse.Namespace(alias="Vault"))  # must not raise


# ---- hook registration -----------------------------------------------------------------

def test_task_claim_guard_hook_registered_by_write_hook_config(tmp_path):
    claude = tmp_path / ".claude"
    claude.mkdir()

    added = cli._write_hook_config(claude)

    assert added is True
    settings = json.loads((claude / "settings.json").read_text())
    cmds = [h.get("command") for entry in settings["hooks"].get("SessionEnd", [])
            for h in entry.get("hooks", [])]
    assert "orcha task-claim-guard" in cmds
    assert "orcha snapshot" in cmds  # pre-existing SessionEnd entry untouched
