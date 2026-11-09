"""Unit tests for the fixes to the CodeQL alerts on PR #278.

  * ReDoS: review_routing's verdict regexes run in linear time on pathological input, with the
    same matches as before.
  * Information exposure: public_errors keeps only an upstream status code.
The route-level counterparts live beside each route's own tests (test_file_raw_routes,
test_deliverables, test_routines, test_github_binding, test_code_github_edit)."""
import time

import pytest

from portal_backend import public_errors
from portal_backend.review_routing import parse_manager_response


# ------------------------------------------------------------------ ReDoS

def _elapsed(fn, *args):
    t = time.perf_counter()
    out = fn(*args)
    return time.perf_counter() - t, out


def test_manager_verdict_regex_is_linear_on_long_blank_runs():
    for evil in (" " * 50_000 + "x", "\t" * 50_000 + "*" * 10 + " " * 50_000 + "x", "*" + " " * 50_000 + "!"):
        took, out = _elapsed(parse_manager_response, evil)
        assert took < 0.5, took
        assert out[0] == "comment"


@pytest.mark.parametrize("text, expected", [
    ("Approve", ("approve", "Approve")),
    ("  **Approved:** looks good", ("approve", "** looks good")),  # (as before: only one star run is a prefix)
    ("** approve — ship it", ("approve", "ship it")),
    ("LGTM. nice", ("approve", "nice")),
    ("recommend approval - tests pass", ("approve", "tests pass")),
    ("Send back: missing tests", ("send_back", "missing tests")),
    ("**send_back** the docs are wrong", ("send_back", "** the docs are wrong")),
    ("Changes requested - fix lint", ("send_back", "fix lint")),
    ("rejected", ("send_back", "rejected")),
    ("approvals pending", ("comment", "approvals pending")),
    ("I would approve", ("comment", "I would approve")),
])
def test_manager_verdict_matches_are_unchanged(text, expected):
    assert parse_manager_response(text) == expected


# ------------------------------------------------------------------ information exposure

def test_github_failure_keeps_only_the_status_code(caplog):
    with caplog.at_level("WARNING", logger="orcha.portal.errors"):
        assert public_errors.github_failure("x", RuntimeError("github_status:403:SECRET body")) == "GitHub returned 403"
        assert public_errors.github_failure("x", RuntimeError("GitHub returned 404 for user/repos")) == "GitHub returned 404"
        assert public_errors.github_failure("x", RuntimeError("github_unreachable:SECRET")) == "could not reach GitHub"
        assert public_errors.github_failure("x", RuntimeError("github_status:4040:x")) == "could not reach GitHub"
    assert "SECRET body" in caplog.text  # logged for the operator
