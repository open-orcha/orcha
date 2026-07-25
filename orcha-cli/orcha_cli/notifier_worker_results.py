"""Classify worker exits and derive retry delays from Codex event logs."""

from __future__ import annotations

import json
import os
import re


def codex_tail_is_rate_limited(log_path, services) -> bool:
    """Return whether the last meaningful Codex event is a rate-limit signal."""
    if not log_path:
        return False
    try:
        with open(log_path, "rb") as log:
            log.seek(0, os.SEEK_END)
            log.seek(max(0, log.tell() - 65536))
            tail = log.read()
    except OSError:
        return False

    last = None
    for raw in tail.split(b"\n"):
        try:
            event = json.loads(raw.strip())
        except ValueError:
            continue
        if not isinstance(event, dict):
            continue
        if services._codex_is_rate_limit(event):
            last = "rate_limit"
        elif services._codex_is_turn_end(event):
            last = "turn_end"
        else:
            phase, _item_id = services._codex_event_phase(event)
            if phase in ("start", "end"):
                last = phase
    return last == "rate_limit"


def parse_rate_limit_reset(log_path, services) -> float:
    """Read the last retry hint, falling back to the notifier's safe cooldown."""
    seconds = None
    for event in _tail_events(log_path):
        if not services._codex_is_rate_limit(event):
            continue
        message = event.get("msg") if isinstance(event.get("msg"), dict) else {}
        retry_after = event.get("retry_after") or message.get("retry_after")
        if isinstance(retry_after, (int, float)) and retry_after > 0:
            seconds = float(retry_after)
            continue
        fields = (
            message.get("message"),
            message.get("error"),
            event.get("error"),
            event.get("message"),
        )
        for field in fields:
            if not isinstance(field, str):
                continue
            match = re.search(
                r"retry[ _-]?after[^0-9]*([0-9]+(?:\.[0-9]+)?)",
                field.lower(),
            )
            if match:
                seconds = float(match.group(1))
    if not seconds or seconds <= 0:
        seconds = services.RATE_LIMIT_DEFAULT_BACKOFF_SECS
    return max(5.0, min(seconds, 3600.0))


def _tail_events(log_path):
    """Yield dictionary events from the bounded tail of a worker log."""
    if not log_path:
        return
    try:
        with open(log_path, "rb") as log:
            log.seek(0, os.SEEK_END)
            log.seek(max(0, log.tell() - 65536))
            tail = log.read()
    except OSError:
        return
    for raw in tail.split(b"\n"):
        try:
            event = json.loads(raw.strip())
        except ValueError:
            continue
        if isinstance(event, dict):
            yield event
