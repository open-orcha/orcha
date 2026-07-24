"""Load notifier configuration and perform small host/API transport operations."""

from __future__ import annotations

import json
import pathlib
import shutil
import subprocess
import sys
import urllib.error
import urllib.request
from typing import Optional


def _load_config(cwd: pathlib.Path) -> dict:
    cfg = cwd / ".claude" / "orcha.json"
    if not cfg.exists():
        sys.exit(
            "error: no .claude/orcha.json in CWD. Run the notifier from the project "
            "root (where `orcha init`/`orcha connect` was run)."
        )
    return json.loads(cfg.read_text())


def _api_and_cid(
    cwd: pathlib.Path,
    api_override: Optional[str],
    cid_override: Optional[str],
) -> tuple[str, str]:
    if api_override and cid_override:
        return api_override.rstrip("/"), cid_override
    cfg = _load_config(cwd)
    api_base = (api_override or cfg.get("api_base_url") or "").rstrip("/")
    cid = cid_override or cfg.get("current_container_id")
    if not api_base:
        sys.exit("error: api_base_url missing from .claude/orcha.json")
    if not cid:
        sys.exit(
            "error: no container_id — pass --container or set current_container_id "
            "in .claude/orcha.json (run /orcha-container)."
        )
    return api_base, cid


def _get_json(url: str, timeout: float = 8.0) -> Optional[dict]:
    try:
        with urllib.request.urlopen(url, timeout=timeout) as resp:
            return json.loads(resp.read())
    except (urllib.error.URLError, urllib.error.HTTPError, ValueError):
        return None


def _probe_container(api_base: str, cid: str) -> str:
    """Return ``ok``, ``missing``, or ``unreachable`` for a container probe."""
    url = f"{api_base}/api/containers/{cid}/wake-scan?cooldown=15&min_idle=30"
    try:
        with urllib.request.urlopen(url, timeout=8.0) as resp:
            resp.read()
        return "ok"
    except urllib.error.HTTPError as exc:
        return "missing" if exc.code == 404 else "ok"
    except (urllib.error.URLError, ValueError, OSError):
        return "unreachable"


def _post_json(url: str, body: dict, timeout: float = 8.0) -> Optional[dict]:
    req = urllib.request.Request(
        url,
        data=json.dumps(body).encode(),
        method="POST",
        headers={"Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read())
    except (urllib.error.URLError, urllib.error.HTTPError, ValueError):
        return None


def _extract_attachment_text(attachments, api_base: Optional[str] = None) -> dict:
    """Return upload-time cached OCR text keyed by attachment id."""
    del api_base  # Kept in the public helper signature for compatibility.
    out: dict = {}
    for attachment in attachments or []:
        if not isinstance(attachment, dict):
            continue
        attachment_id = attachment.get("id")
        text = (attachment.get("extracted_text") or "").strip()
        if text:
            out[attachment_id] = text
    return out


def _tmux_available() -> bool:
    return shutil.which("tmux") is not None


def tmux_pane_live(target: str) -> bool:
    """Return whether a tmux target exists and hosts a Claude-style process."""
    if not target or not _tmux_available():
        return False
    try:
        out = subprocess.run(
            ["tmux", "display-message", "-p", "-t", target, "#{pane_current_command}"],
            capture_output=True,
            text=True,
            timeout=5,
        )
    except (OSError, subprocess.SubprocessError):
        return False
    if out.returncode != 0:
        return False
    return out.stdout.strip().lower() in {"node", "claude", "claude-code"}


def send_tmux(target: str, prompt: str, dry_run: bool) -> tuple[bool, str]:
    """Inject a prompt into a tmux pane and report whether it was sent."""
    literal = ["tmux", "send-keys", "-t", target, "-l", prompt]
    enter = ["tmux", "send-keys", "-t", target, "Enter"]
    command = f"tmux send-keys -t {target} -l <prompt>; tmux send-keys -t {target} Enter"
    if dry_run:
        return False, command
    try:
        subprocess.run(literal, check=True, timeout=5)
        subprocess.run(enter, check=True, timeout=5)
        return True, command
    except (OSError, subprocess.SubprocessError):
        return False, command
