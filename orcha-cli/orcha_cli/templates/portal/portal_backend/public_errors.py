"""User-facing text for exceptions that would otherwise reach an HTTP response verbatim.

An exception's message can carry internals — an upstream error body, a host, a path, a
library's own wording — so routes never hand `str(exc)` to the client. They log the
exception here (server-side, where an operator can read it) and return a fixed message
that keeps only what the caller needs: for an upstream HTTP failure, its status code.
"""

from __future__ import annotations

import logging
import re

ERROR_LOG = logging.getLogger("orcha.portal.errors")

# the two shapes the GitHub leaves raise: `github_status:<code>:<body>` (github_hub_routes
# `_gh_get` / `_gh_post`) and `GitHub returned <code> for <what>` (github_routes)
_HTTP_STATUS = re.compile(r"(?:github_status:|GitHub returned )([1-5][0-9]{2})(?![0-9])")


def log_exception(context: str, exc: BaseException) -> None:
    ERROR_LOG.warning("%s: %s: %s", context, type(exc).__name__, exc)


def upstream_status(exc: BaseException) -> int | None:
    """The HTTP status an upstream call failed with, when the exception names one."""
    m = _HTTP_STATUS.search(str(exc)[:200])
    return int(m.group(1)) if m else None


def github_failure(context: str, exc: BaseException) -> str:
    """Log a failed GitHub call and return its user-facing text: `GitHub returned <code>`
    when GitHub answered with an error, else `could not reach GitHub`."""
    log_exception(context, exc)
    status = upstream_status(exc)
    return f"GitHub returned {status}" if status is not None else "could not reach GitHub"
