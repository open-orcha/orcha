"""Regression coverage for local-first conversation-to-task handoffs."""

from orcha_cli import notifier


def _conversation_prompts():
    pending = [{"seq": 7, "role": "human", "content": "please implement this"}]
    return {
        "cold persona": notifier.format_persona(
            {"system_prompt": "You are Vox."}, None, lane="conversation"
        ),
        "warm turn": notifier._wrap_conversation_turn("please implement this"),
        "Codex cold": notifier._conversation_worker_prompt("Vox", pending, []),
        "Codex resume": notifier._codex_resume_prompt("Vox", pending),
    }


def test_missing_named_tool_triggers_workspace_local_discovery():
    for name, prompt in _conversation_prompts().items():
        lower = prompt.lower()
        assert "missing named" in lower, name
        assert "not proof" in lower, name
        assert ".claude/orcha.json" in prompt, name
        assert "orcha-task-new" in prompt, name
        assert "configured local api" in lower, name


def test_internal_subagent_thread_is_never_reported_as_orcha_task_or_request():
    for name, prompt in _conversation_prompts().items():
        lower = prompt.lower()
        assert "sub-agent thread" in lower, name
        assert "not a" in lower and "orcha task" in lower, name
        assert "task/request" in lower or "task or task request" in lower, name


def test_chrome_and_unrelated_tabs_are_prohibited_as_fallback():
    for name, prompt in _conversation_prompts().items():
        lower = prompt.lower()
        assert "chrome/browser" in lower, name
        assert "tabs" in lower, name
        assert "unless the human explicitly named" in lower, name


def test_local_task_must_be_verified_or_handoff_fails_closed():
    for name, prompt in _conversation_prompts().items():
        lower = prompt.lower()
        assert "verify" in lower or "read-back" in lower, name
        assert "stop and ask" in lower, name

    cold = _conversation_prompts()["cold persona"]
    assert "/tasks?task=<id>" in cold
    assert "do not create the task anywhere else" in cold
