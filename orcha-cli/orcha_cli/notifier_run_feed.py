"""Stream complete worker-log events into the portal's durable run feed."""

from __future__ import annotations

import json


def is_stream_event_line(line: str) -> bool:
    """Return whether a line is a high-volume partial stream delta."""
    try:
        return json.loads(line).get("type") == "stream_event"
    except (ValueError, AttributeError):
        return False


def pump_one(api_base: str, worker: dict, post_json) -> None:
    """Post newly completed log lines while retaining partial and failed batches."""
    log_path = worker.get("log_path")
    run_id = worker.get("run_id")
    if not log_path or not run_id:
        return
    offset = worker.get("lines_offset", 0)
    try:
        with open(log_path, "rb") as log:
            log.seek(offset)
            data = log.read()
    except OSError:
        return
    if not data:
        return

    buffered = worker.get("lines_buf", b"") + data
    *complete, tail = buffered.split(b"\n")
    if not complete:
        worker["lines_offset"] = offset + len(data)
        worker["lines_buf"] = tail
        return

    lines = [part.decode("utf-8", "replace").rstrip("\r") for part in complete]
    lines = [line for line in lines if line.strip() and not is_stream_event_line(line)]
    start_seq = worker.get("lines_seq", 1)
    if lines:
        response = post_json(
            f"{api_base}/api/runs/{run_id}/lines",
            {"start_seq": start_seq, "lines": lines},
        )
        if response is None:
            return
        worker["lines_seq"] = start_seq + len(lines)
    worker["lines_offset"] = offset + len(data)
    worker["lines_buf"] = tail
