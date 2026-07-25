"""Preserve notifier conversation formatting, paths, and recovery entry points."""

from __future__ import annotations

import pathlib
import re
import sys
import time
from typing import Optional

from . import notifier_codex_conversation as _codex
from . import notifier_conversation as _conversation
from .notifier_runtime import _normalize_runtime


def _compat():
    return sys.modules["orcha_cli.notifier"]


def _resident_log_path(base_cwd, conversation_id) -> Optional[pathlib.Path]:
    if not base_cwd:
        return None
    return (
        pathlib.Path(base_cwd)
        / ".orcha"
        / "resident-logs"
        / f"{conversation_id}.ndjson"
    )


def _next_human_turn(
    api_base: str, conv_id: str, after_seq: int
) -> Optional[dict]:
    data = _compat()._get_json(
        f"{api_base}/api/conversations/{conv_id}/turns"
        f"?after_seq={after_seq}&limit=50"
    )
    for turn in (data or {}).get("turns", []):
        if turn.get("role") == "human":
            return {
                "seq": turn["seq"],
                "content": turn.get("content") or "",
                "attachments": turn.get("attachments") or [],
            }
    return None


def _conversation_log_path(
    base_cwd, conversation_id
) -> Optional[pathlib.Path]:
    if not base_cwd:
        return None
    slug = (
        re.sub(r"[^A-Za-z0-9_.-]+", "-", str(conversation_id)).strip("-")
        or "conversation"
    )
    return (
        pathlib.Path(base_cwd)
        / ".orcha"
        / "conversation-logs"
        / f"{slug}-{int(time.time() * 1000)}.ndjson"
    )


def _conversation_reply_path(log_path) -> Optional[pathlib.Path]:
    return pathlib.Path(str(log_path) + ".reply.txt") if log_path else None


def _simple_history(turns: list[dict]) -> str:
    return _conversation.simple_history(turns)


def _conversation_worker_prompt(
    alias: str,
    pending_turns: list[dict],
    history_turns: list[dict],
    api_base: Optional[str] = None,
) -> str:
    compat = _compat()
    return _conversation.worker_prompt(
        alias,
        pending_turns,
        history_turns,
        api_base,
        cold_history=compat._cold_boot_history,
        extract_attachment_text=compat._extract_attachment_text,
        render_attachment_feed=compat._render_attachment_feed,
    )


def _codex_resume_prompt(alias: str, pending_turns: list[dict]) -> str:
    return _conversation.resume_prompt(alias, pending_turns)


def _text_from_content(content) -> Optional[str]:
    return _conversation.text_from_content(content)


def _conversation_reply_text(
    log_path, last_message_path=None
) -> Optional[str]:
    return _conversation.reply_text(
        log_path,
        last_message_path,
        result_after=_compat()._result_after,
    )


class _ExternalProcess:
    """Minimal Popen-compatible view of a worker from an earlier daemon."""

    def __init__(self, pid: int):
        self.pid = int(pid)
        self.returncode = None
        self.stdin = None

    def poll(self):
        if self.returncode is not None:
            return self.returncode
        if _compat()._pid_alive(self.pid):
            return None
        self.returncode = 0
        return self.returncode

    def wait(self, timeout=None):
        started = time.time()
        while self.poll() is None:
            if timeout is not None and time.time() - started > timeout:
                raise _compat().subprocess.TimeoutExpired(
                    str(self.pid), timeout
                )
            time.sleep(0.05)
        return self.returncode

    def kill(self):
        compat = _compat()
        try:
            compat.os.kill(self.pid, compat.signal.SIGKILL)
        except OSError:
            pass
        self.returncode = -9


def _as_path(value):
    return pathlib.Path(value) if value else None


def _post_conversation_reply(
    api_base: str,
    conv_id: str,
    resident: dict,
    text: str,
    meta: Optional[dict] = None,
) -> bool:
    result = _compat()._post_json(
        f"{api_base}/api/conversations/{conv_id}/turns",
        {
            "role": "agent",
            "author_agent_id": resident["agent_id"],
            "content": text,
            "run_id": resident["current_run_id"],
            "meta": meta or {},
        },
    )
    return bool(result and result.get("turn"))


def _conversation_ack_body(
    kind: str, *, delivered_ts=None, release_lease: bool = True
) -> dict:
    body = {
        "kind": kind,
        "event": "conversation_turn",
        "release_lease": release_lease,
        "lane": "conversation",
    }
    if delivered_ts is not None:
        body["delivered_ts"] = delivered_ts
    return body


def _resident_runtime(resident: dict) -> str:
    return _normalize_runtime((resident or {}).get("runtime"))


def _maybe_pin_codex_session(
    api_base: str, conv_id: str, resident: dict
) -> Optional[str]:
    return _codex.maybe_pin_session(
        api_base, conv_id, resident, _compat()
    )


def _finish_codex_conversation(
    api_base: str,
    conv_id: str,
    resident: dict,
    **kwargs,
) -> bool:
    return _codex.finish(
        api_base, conv_id, resident, _compat(), **kwargs
    )


def _codex_run_state(
    conv: dict, run: dict, *, base_cwd: Optional[str] = None
) -> dict:
    return _codex.run_state(
        conv, run, _compat(), base_cwd=base_cwd
    )


def reconcile_codex_conversation_runs(
    api_base: str,
    cid: str,
    live_residents: dict,
    *,
    quiet: bool = False,
    base_cwd: Optional[str] = None,
) -> None:
    _codex.reconcile(
        api_base,
        cid,
        live_residents,
        _compat(),
        quiet=quiet,
        base_cwd=base_cwd,
    )
