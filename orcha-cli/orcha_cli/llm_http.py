"""Provide the pure-stdlib JSON and SSE HTTP primitives used by LLM transports."""

from __future__ import annotations

import json
import urllib.error
import urllib.request
from typing import Iterator

try:
    from .llm_catalog import LLMError
except ImportError:  # Portal copies these modules into a top-level build directory.
    from llm_catalog import LLMError


def http_post_json(url: str, headers: dict, body: dict, *, timeout_s: float) -> dict:
    """POST JSON and normalize provider transport failures."""
    request = urllib.request.Request(
        url,
        data=json.dumps(body).encode("utf-8"),
        headers=headers,
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout_s) as response:
            return json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", "replace")[:500]
        raise LLMError(f"HTTP {exc.code} from {url}: {detail}") from exc
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        raise LLMError(f"transport error to {url}: {exc}") from exc
    except json.JSONDecodeError as exc:
        raise LLMError(f"non-JSON response from {url}: {exc}") from exc


def http_post_sse(
    url: str,
    headers: dict,
    body: dict,
    *,
    timeout_s: float,
) -> Iterator[dict]:
    """POST JSON and yield valid SSE data payloads."""
    request = urllib.request.Request(
        url,
        data=json.dumps(body).encode("utf-8"),
        headers=headers,
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout_s) as response:
            for raw in response:
                line = raw.decode("utf-8", "replace").strip()
                if not line.startswith("data:"):
                    continue
                payload = line[len("data:") :].strip()
                if not payload or payload == "[DONE]":
                    continue
                try:
                    yield json.loads(payload)
                except json.JSONDecodeError:
                    continue
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", "replace")[:500]
        raise LLMError(f"HTTP {exc.code} from {url}: {detail}") from exc
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        raise LLMError(f"transport error to {url}: {exc}") from exc
