"""GH #90 — conversation agents dispatch real work to task workers, never do it inline.

A conversation embodiment (Codex one-shot conversation worker or a Claude resident) is for quick
information exchange and DISPATCH only. When the human asks for substantive work it must convert the
ask into an ASSIGNED task and stop; the assignment wakes a separate ephemeral task worker that reads
the full spec and does the work. These tests cover the three concrete guardrails that enforce it:

  * the dispatch guardrail text rides every conversation prompt (Codex cold + resume) and every
    Claude resident human turn (a warm --resume resident never re-reads its cold system prompt);
  * a `ORCHA_CONVERSATION_WORKER=1` spawn marker is set on conversation embodiments (Codex
    conversation worker, Claude resident) but NOT on ephemeral task workers / drain sidecars;
  * the task-working skills (`/orcha-next`, `/orcha-accept-task`) refuse to do inline work when the
    marker is set, pointing the agent at create-and-assign instead.
"""
from orcha_cli import notifier  # noqa: E402  (conftest puts orcha-cli on sys.path)


# ---------- the guardrail text: dispatch work, answer questions inline ----------

def test_guardrail_constant_says_dispatch_work_and_keep_questions_inline():
    g = notifier.CONVERSATION_WORK_GUARDRAIL
    # dispatch side: create + assign a task, then stop
    assert "/orcha-task-new" in g
    assert "--assign" in g
    assert "definition of done" in g.lower()
    assert "same agent" in g.lower()               # default assignee = the agent being talked to
    # stop side: do NOT do the work inline
    lower = g.lower()
    assert "do not" in lower and "coding" in lower
    # inline side: pure questions/brainstorm/status stay in the conversation (negative case)
    assert "questions" in lower and "brainstorm" in lower
    assert "not work" in lower or "answer" in lower


def test_codex_conversation_prompt_carries_dispatch_guardrail():
    prompt = notifier._conversation_worker_prompt(
        "Vox",
        pending_turns=[{"seq": 3, "content": "please refactor the auth module"}],
        history_turns=[],
    )
    assert notifier.CONVERSATION_WORK_GUARDRAIL in prompt
    # still a conversation worker — the reply framing is preserved alongside the guardrail
    assert "Conversation tab" in prompt


def test_codex_resume_prompt_carries_dispatch_guardrail():
    # #286: resumed Codex turns do NOT get the full cold prompt again, so the guardrail must ride the
    # resume continuation too or every resumed turn would be un-guarded.
    prompt = notifier._codex_resume_prompt("Vox", pending_turns=[{"seq": 5, "content": "now ship it"}])
    assert notifier.CONVERSATION_WORK_GUARDRAIL in prompt
    assert "RESUMES your existing Codex session" in prompt


def test_resident_turn_feed_prefixes_guardrail_before_every_turn():
    # The single code path both cold and warm Claude resident turns flow through (notifier.py), so the
    # guardrail 'rides every turn, not only cold boot' is proven by this pure helper.
    fed = notifier._resident_turn_feed("please review PR #42 and fix the failing test")
    assert fed.startswith(notifier.CONVERSATION_WORK_GUARDRAIL)
    assert fed.endswith("please review PR #42 and fix the failing test")


# ---------- the spawn env marker ----------

class _FakePopen:
    """Captures the env passed to subprocess.Popen (the marker lives there)."""
    last = None

    def __init__(self, argv, cwd=None, env=None, **kw):
        _FakePopen.last = {"argv": argv, "env": env or {}}
        self.pid = 1
        self.returncode = None

    def poll(self):
        return self.returncode


def _stub_exec(monkeypatch):
    monkeypatch.setattr(notifier.shutil, "which", lambda x: "/usr/bin/claude")
    monkeypatch.setattr(notifier, "_resolve_runtime_executable", lambda rt: "/usr/bin/claude")
    monkeypatch.setattr(notifier.subprocess, "Popen", _FakePopen)


def test_spawn_headless_conversation_worker_sets_marker(monkeypatch, tmp_path):
    _stub_exec(monkeypatch)
    sent, _, _ = notifier.spawn_headless(str(tmp_path), "reply!", None, dry_run=False,
                                         alias="Vox", conversation_worker=True)
    assert sent is True
    assert _FakePopen.last["env"].get("ORCHA_CONVERSATION_WORKER") == "1"


def test_spawn_headless_task_worker_is_not_marked(monkeypatch, tmp_path):
    # The ephemeral task worker / drain sidecar path (default conversation_worker=False) must NOT be
    # marked — those are exactly the workers that SHOULD claim and do the task.
    _stub_exec(monkeypatch)
    sent, _, _ = notifier.spawn_headless(str(tmp_path), "do the task!", None, dry_run=False,
                                         alias="Vox")
    assert sent is True
    assert "ORCHA_CONVERSATION_WORKER" not in _FakePopen.last["env"]


def test_spawn_resident_sets_conversation_marker(monkeypatch, tmp_path):
    # A Claude resident is always a conversation embodiment → always marked.
    monkeypatch.setattr(notifier.shutil, "which", lambda x: "/usr/bin/claude")
    monkeypatch.setattr(notifier.subprocess, "Popen", _FakePopen)
    sent, _, _ = notifier.spawn_resident(str(tmp_path), alias="Vox", log_path=tmp_path / "r.log")
    assert sent is True
    assert _FakePopen.last["env"].get("ORCHA_CONVERSATION_WORKER") == "1"


# ---------- the skill-level refusal ----------

import pathlib  # noqa: E402
_TEMPLATES = pathlib.Path(notifier.__file__).resolve().parent / "templates"


def test_orcha_next_skill_refuses_work_in_conversation_mode():
    text = (_TEMPLATES / "skills" / "orcha-next.md").read_text()
    assert "ORCHA_CONVERSATION_WORKER" in text
    lower = text.lower()
    assert "stop" in lower and "dispatch" in lower
    assert "/orcha-task-new" in text            # points at the create-and-assign path


def test_orcha_accept_task_skill_blocks_inline_work_in_conversation_mode():
    text = (_TEMPLATES / "skills" / "orcha-accept-task.md").read_text()
    assert "ORCHA_CONVERSATION_WORKER" in text
    # accept (dispatch) is allowed, but inline work is not
    assert "not begin the work inline" in text.lower()
