"""Install notifier dependencies and shared mutable state on its public facade."""

from __future__ import annotations

import json
import os
import pathlib
import re
import shutil
import signal
import subprocess
import time
import urllib.error
import urllib.request
from typing import Optional

from . import notifier_command as _notifier_command
from . import notifier_conversation as _conversation
from . import notifier_daemon_control as _daemon_control
from . import notifier_daemon_registry as _daemon_registry
from . import notifier_resident_claude_start as _resident_claude_start
from . import notifier_resident_codex as _resident_codex
from . import notifier_resident_codex_start as _resident_codex_start
from . import notifier_resident_idle as _resident_idle
from . import notifier_resident_live as _resident_live
from . import notifier_worktree_cleanup as _worktree_cleanup
from .notifier_codex_events import (
    _codex_event_phase,
    _codex_is_rate_limit,
    _codex_is_turn_end,
    _codex_tail_is_live,
)
from .notifier_codex_result import _codex_result_status
from .notifier_host import (
    _api_and_cid,
    _extract_attachment_text,
    _get_json,
    _load_config,
    _post_json,
    _probe_container,
    send_tmux,
    tmux_pane_live,
)
from .notifier_persona import (
    CONVERSATION_LANE_DIRECTIVE,
    HUMAN_COMMS_GUARDRAIL,
    _wrap_conversation_turn,
    format_persona,
)
from .notifier_policy import (
    CODEX_RESUME_FAILED as _CODEX_RESUME_FAILED,
    GRACEFUL_EXIT_SECS,
    HARD_CAP_MIN_SECS,
    HARD_CAP_RESPAWN_MAX,
    RESIDENT_DRAIN_COOLDOWN_SECS,
    RESIDENT_DRAIN_YIELD as _RESIDENT_DRAIN_YIELD,
    RESIDENT_IDLE_REAP_SECS,
    RESIDENT_RESUME_FAILED as _RESIDENT_RESUME_FAILED,
    RESIDENT_WORK_TEARDOWN_ENABLED,
    RESUME_FAIL_WINDOW_SECS,
    TERMINAL_SWEEP_MAX_PAGES as _TERMINAL_SWEEP_MAX_PAGES,
    TERMINAL_SWEEP_PAGE_SIZE as _TERMINAL_SWEEP_PAGE_SIZE,
    TERMINAL_TASK_STATES as _TERMINAL_TASK_STATES,
    WAKE_LEASE_TTL_SECS,
)
from .notifier_process import _capture_run_output, _kill_worker, _usage_from_log
from .notifier_protocol import (
    _render_protocol,
    _render_resume_context,
    _render_task_body,
)
from .notifier_runtime import (
    ORCHA_CLAUDE_EXEC,
    ORCHA_CODEX_EXEC,
    RUNTIME_CLAUDE,
    RUNTIME_CODEX,
    _CODEX_EFFORT,
    _CODEX_EXEC_FALLBACKS,
    _codex_prompt,
    _normalize_runtime,
    _runtime_executable,
    _runtime_extra_flags,
)
from .notifier_session_io import (
    _extract_codex_session_id,
    _extract_session_id,
    _result_after,
    _send_user_turn,
)
from .notifier_wake_prompts import (
    build_resident_sidecar_drain_prompt,
    build_wake_prompt,
)
from .notifier_worker_status import (
    _last_event_type,
    _result_status,
    _terminal_status,
    _worker_is_live,
)

try:
    from .conversation_prefix import (
        format_conversation_history as _format_history,
    )
    from .conversation_prefix import render_attachment_feed as _render_attachment_feed
except ImportError:
    _format_history = None

    def _render_attachment_feed(
        attachments, *, api_base=None, runtime=None, extracted=None
    ):
        return ""

try:
    from .digest_curation import curate_history as _curate_history
except ImportError:
    _curate_history = None
try:
    from . import llm_util as _llm_util
except ImportError:
    _llm_util = None
try:
    from . import digest_curate as _digest_curate
except ImportError:
    _digest_curate = None
try:
    from . import secret_box as _secret_box
except ImportError:
    _secret_box = None


_DAEMON_LIVENESS_INTERVAL = 60.0
_PERSONA_CACHE_TTL_SECS = float(
    os.environ.get("ORCHA_PERSONA_CACHE_TTL_SECS") or 90.0
)
_PERSONA_CACHE: dict[str, tuple[float, Optional[dict], Optional[dict]]] = {}
pending_revokes: list[str] = []
_DIFF_EXCLUDES = _worktree_cleanup.DIFF_EXCLUDES
FAILED_DRAIN_MAX = 3
RATE_LIMIT_DEFAULT_BACKOFF_SECS = 60.0
_CONVERSATION_DISPATCH_DIRECTIVE = _conversation.DISPATCH_DIRECTIVE


def install(namespace: dict) -> None:
    """Copy compatibility dependencies and state into the notifier facade."""
    excluded = {"install", "namespace", "Optional"}
    namespace.update(
        {
            name: value
            for name, value in globals().items()
            if not name.startswith("__") and name not in excluded
        }
    )
