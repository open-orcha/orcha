"""Expose attachment limits through an explicit compatibility configuration seam."""

import pathlib
from collections.abc import Callable

DEFAULT_ATTACHMENTS_DIR = pathlib.Path("/app/orcha-attachments")
MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024
MAX_ATTACHMENTS_PER_MESSAGE = 10
MAX_EXTRACTED_TEXT_CHARS = 8_000

_root_provider: Callable[[], pathlib.Path] = lambda: DEFAULT_ATTACHMENTS_DIR
_size_provider: Callable[[], int] = lambda: MAX_ATTACHMENT_BYTES


def configure_compatibility(
    root_provider: Callable[[], pathlib.Path],
    size_provider: Callable[[], int],
) -> None:
    """Connect legacy ``main`` monkeypatches to extracted attachment services."""
    global _root_provider, _size_provider
    _root_provider = root_provider
    _size_provider = size_provider


def attachments_dir() -> pathlib.Path:
    return _root_provider()


def max_attachment_bytes() -> int:
    return _size_provider()
