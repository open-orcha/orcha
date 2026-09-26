"""Convert supported image and PDF attachments into text for text-only agents."""

from __future__ import annotations

import base64
from typing import Callable, Optional

_VISION_IMAGE_TYPES = {"image/png", "image/jpeg", "image/jpg", "image/gif", "image/webp"}
_VISION_DOC_TYPES = {"application/pdf"}
_DESCRIBE_SYSTEM = (
    "Transcribe all readable text in this image or PDF, then briefly describe non-text visual "
    "content so a text-only agent can act on it. Be faithful, concise, and do not speculate."
)


def can_describe(content_type: Optional[str]) -> bool:
    """Whether the content type is supported by the vision conversion."""
    normalized = (content_type or "").lower()
    return normalized in _VISION_IMAGE_TYPES or normalized in _VISION_DOC_TYPES


def describe_image(
    data: bytes,
    content_type: str,
    *,
    resolve_spec: Callable,
    get_provider: Callable,
    resolve_api_key: Callable,
    log_call: Callable,
    now_ms: Callable,
    use_case: str = "vision",
    prompt: Optional[str] = None,
    config: Optional[dict] = None,
    api_key: Optional[str] = None,
    provider=None,
) -> str:
    """Return extracted text, failing open to an empty string on every problem."""
    normalized = (content_type or "").lower()
    if not data or not can_describe(normalized):
        return ""
    spec = resolve_spec(use_case, config=config)
    block_type = "document" if normalized in _VISION_DOC_TYPES else "image"
    media_type = "application/pdf" if block_type == "document" else normalized
    attachment = {
        "type": block_type,
        "source": {
            "type": "base64",
            "media_type": media_type,
            "data": base64.b64encode(data).decode("ascii"),
        },
    }
    messages = [
        {
            "role": "user",
            "content": [
                attachment,
                {
                    "type": "text",
                    "text": prompt or "Transcribe and describe this file for a text-only agent.",
                },
            ],
        }
    ]
    transport = provider or get_provider(spec.provider)
    key = "" if provider is not None else resolve_api_key(spec.provider, explicit=api_key)
    started = now_ms()
    try:
        response = transport.complete(
            spec=spec,
            system=_DESCRIBE_SYSTEM,
            messages=messages,
            api_key=key,
        )
        text = (response.get("text") or "").strip()
        log_call(
            use_case=use_case,
            spec=spec,
            outcome="ok" if text else "fail_open",
            latency_ms=now_ms() - started,
            usage=response.get("usage"),
            error=None if text else "empty vision output",
        )
        return text
    except Exception as exc:
        log_call(
            use_case=use_case,
            spec=spec,
            outcome="fail_open",
            latency_ms=now_ms() - started,
            error=str(exc),
        )
        return ""
