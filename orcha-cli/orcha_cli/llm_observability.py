"""Record provider-neutral LLM call outcomes for cost and failure monitoring."""

from __future__ import annotations

import json
import logging
import time
from typing import Optional

try:
    from .llm_catalog import ModelSpec
except ImportError:  # Portal copies these modules into a top-level build directory.
    from llm_catalog import ModelSpec

log = logging.getLogger("orcha.llm")


def now_ms() -> int:
    """Return a monotonic millisecond timestamp for latency measurements."""
    return int(time.monotonic() * 1000)


def log_call(
    *,
    use_case: str,
    spec: ModelSpec,
    outcome: str,
    latency_ms: int,
    usage: Optional[dict] = None,
    error: Optional[str] = None,
) -> None:
    """Emit one structured record for an LLM call."""
    record = {
        "event": "llm_call",
        "use_case": use_case,
        "provider": spec.provider,
        "model": spec.model,
        "outcome": outcome,
        "latency_ms": latency_ms,
        "input_tokens": (usage or {}).get("input_tokens", 0),
        "output_tokens": (usage or {}).get("output_tokens", 0),
    }
    if error:
        record["error"] = error[:300]
    log.info(json.dumps(record, sort_keys=True))
