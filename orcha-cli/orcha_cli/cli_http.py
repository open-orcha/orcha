"""Tiny urllib JSON helpers for the `orcha` CLI.

Minimal POST/GET-JSON wrappers and a portal-readiness poll, split out of
``__main__`` as a self-contained group. ``__main__`` re-imports these names, so
``orcha_cli.__main__.<fn>`` references (and the tests that monkeypatch them) keep
resolving unchanged. ``notifier`` keeps its own separate copies — these are the
CLI-side helpers only.
"""
from __future__ import annotations

import json
from typing import Optional


def _wait_for_portal(api_base: str, timeout_s: float = 30.0) -> None:
    """Block until the portal returns 200 on GET / (or timeout)."""
    import urllib.error
    import urllib.request
    import time as _time
    deadline = _time.time() + timeout_s
    last_err: Optional[Exception] = None
    while _time.time() < deadline:
        try:
            with urllib.request.urlopen(f"{api_base}/", timeout=2) as _:
                return
        except Exception as e:  # URLError, ConnectionRefused, etc.
            last_err = e
            _time.sleep(0.5)
    raise SystemExit(f"error: portal didn't come up within {timeout_s}s: {last_err}")


def _post_json(url: str, body: dict) -> dict:
    """Tiny urllib POST helper; returns parsed JSON. Raises on non-2xx."""
    import urllib.error
    import urllib.request
    req = urllib.request.Request(
        url,
        data=json.dumps(body).encode(),
        method="POST",
        headers={"Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            return json.loads(resp.read())
    except urllib.error.HTTPError as e:
        raise RuntimeError(f"HTTP {e.code} {e.read().decode(errors='replace')[:500]}") from e


def _get_json(url: str, timeout: float = 5.0) -> Optional[dict]:
    """Tiny urllib GET → JSON helper. Returns None on connection/HTTP error.

    Used by `orcha ls` to enrich the stack listing with container info — a
    silent fall-through is intentional so an unreachable stack still appears
    in the table (its row just won't show the container columns).
    """
    import urllib.error
    import urllib.request
    try:
        with urllib.request.urlopen(url, timeout=timeout) as resp:
            return json.loads(resp.read())
    except (urllib.error.URLError, urllib.error.HTTPError, ValueError):
        return None
