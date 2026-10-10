"""Unit tests for the fixes to the CodeQL alerts on PR #278.

  * SSRF (verdikt_client): the Verdikt base URL is checked and rebuilt before any request —
    http(s) only, no credentials / query / fragment, never a link-local / metadata /
    unspecified / multicast host (literal, or a name resolving to one), an optional strict
    allow-list (ORCHA_VERDIKT_ALLOWED_HOSTS), and redirects are never followed.
  * ReDoS: review_routing's verdict regexes and verdikt_preview's ANSI stripper run in linear
    time on pathological input, with the same matches as before.
  * Information exposure: public_errors keeps only an upstream status code; the Verdikt
    sweep's error is a fixed message.
The route-level counterparts live beside each route's own tests (test_file_raw_routes,
test_deliverables, test_evidence_verdikt, test_routines, test_github_binding,
test_code_github_edit)."""
import http.server
import socket
import threading
import time

import pytest

from portal_backend import public_errors, verdikt_autofix
from portal_backend.review_routing import parse_manager_response
from portal_backend.verdikt_client import ALLOWED_HOSTS_ENV, VerdiktClient, VerdiktError, normalize_base
from portal_backend.verdikt_preview import clean_tail


# ------------------------------------------------------------------ SSRF

@pytest.mark.parametrize("url, expected", [
    ("http://127.0.0.1:31100/", "http://127.0.0.1:31100"),
    ("http://localhost:3100", "http://localhost:3100"),
    ("http://[::1]:3100", "http://[::1]:3100"),
    ("http://host.docker.internal:31970", "http://host.docker.internal:31970"),
    ("https://verdikt.acme.dev", "https://verdikt.acme.dev"),
    ("https://10.0.0.5/verdikt/", "https://10.0.0.5/verdikt"),
    ("HTTP://LocalHost:3100", "http://localhost:3100"),
])
def test_normalize_base_keeps_legitimate_urls(url, expected, monkeypatch):
    monkeypatch.delenv(ALLOWED_HOSTS_ENV, raising=False)
    assert normalize_base(url) == expected


@pytest.mark.parametrize("url", [
    "http://169.254.169.254/latest/meta-data",       # cloud metadata
    "http://[::ffff:169.254.169.254]/",             # ... wrapped in IPv6
    "http://[fe80::1]:80",                          # link-local v6
    "http://metadata.google.internal",
    "http://0.0.0.0:31100",
    "http://224.0.0.1",
    "http://user:pw@127.0.0.1:31100",
    "http://127.0.0.1:31100/?next=http://evil",
    "http://127.0.0.1:31100/#frag",
    "http://127.0.0.1:31100/a/../b",
    "http://127.0.0.1:99999",
    "ftp://127.0.0.1", "file:///etc/passwd", "gopher://127.0.0.1:70",
    "", "   ",
])
def test_normalize_base_refuses_dangerous_urls(url, monkeypatch):
    monkeypatch.delenv(ALLOWED_HOSTS_ENV, raising=False)
    with pytest.raises(VerdiktError) as e:
        normalize_base(url)
    assert e.value.user_message  # a message written for the person configuring Verdikt


def test_allow_list_env_restricts_hosts_to_the_listed_ones_plus_loopback(monkeypatch):
    monkeypatch.setenv(ALLOWED_HOSTS_ENV, "verdikt.acme.dev, 10.0.0.5")
    assert normalize_base("https://verdikt.acme.dev") == "https://verdikt.acme.dev"
    assert normalize_base("http://10.0.0.5:3100") == "http://10.0.0.5:3100"
    assert normalize_base("http://127.0.0.1:31100") == "http://127.0.0.1:31100"
    assert normalize_base("http://localhost:31100") == "http://localhost:31100"
    for bad in ("https://other.acme.dev", "http://10.0.0.6", "http://169.254.169.254"):
        with pytest.raises(VerdiktError):
            normalize_base(bad)


def test_a_name_resolving_to_the_metadata_address_is_refused_before_the_request(monkeypatch):
    monkeypatch.delenv(ALLOWED_HOSTS_ENV, raising=False)
    calls = []
    monkeypatch.setattr(socket, "getaddrinfo",
                        lambda host, *a, **k: [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("169.254.169.254", 0))])
    client = VerdiktClient("http://rebind.example:31100", opener=lambda req, timeout: calls.append(req))
    with pytest.raises(VerdiktError) as e:
        client.health()
    assert "never contacts" in str(e.value) and calls == []
    with pytest.raises(VerdiktError):
        client.open_artifact("r1/a.png")
    assert calls == []


class _Redirector(http.server.BaseHTTPRequestHandler):
    hits: list = []

    def do_GET(self):  # noqa: N802
        _Redirector.hits.append(self.path)
        if self.path == "/api/health":
            self.send_response(302)
            self.send_header("Location", "/internal-only")
            self.end_headers()
            return
        body = b'{"ok": true}'
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *a):
        pass


def test_redirects_are_never_followed(monkeypatch):
    monkeypatch.delenv(ALLOWED_HOSTS_ENV, raising=False)
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), _Redirector)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    _Redirector.hits = []
    try:
        client = VerdiktClient(f"http://127.0.0.1:{server.server_address[1]}")
        with pytest.raises(VerdiktError) as e:
            client.health()
        assert e.value.status == 302
        assert _Redirector.hits == ["/api/health"]  # the redirect target was never requested
    finally:
        server.shutdown()
        server.server_close()


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


def test_ansi_stripper_is_linear_on_unterminated_osc_runs():
    took, out = _elapsed(clean_tail, "\x1b]" * 50_000 + "\n\x1b]0;title\x07done")
    assert took < 0.5, took
    assert out.endswith("\ndone")


def test_ansi_stripper_still_strips_csi_and_osc():
    raw = "\x1b[1;32mok\x1b[0m\n\x1b]0;window title\x07built in 3s\n"
    assert clean_tail(raw) == "ok\nbuilt in 3s"


# ------------------------------------------------------------------ information exposure

def test_github_failure_keeps_only_the_status_code(caplog):
    with caplog.at_level("WARNING", logger="orcha.portal.errors"):
        assert public_errors.github_failure("x", RuntimeError("github_status:403:SECRET body")) == "GitHub returned 403"
        assert public_errors.github_failure("x", RuntimeError("GitHub returned 404 for user/repos")) == "GitHub returned 404"
        assert public_errors.github_failure("x", RuntimeError("github_unreachable:SECRET")) == "could not reach GitHub"
        assert public_errors.github_failure("x", RuntimeError("github_status:4040:x")) == "could not reach GitHub"
    assert "SECRET body" in caplog.text  # logged for the operator


def test_verdikt_sweep_error_is_a_fixed_message(monkeypatch, caplog):
    import portal_backend.database as database

    def broken_cursor():
        raise RuntimeError("SECRET dsn=postgres://u:pw@db")

    monkeypatch.setattr(database, "db_cursor", broken_cursor)
    with caplog.at_level("WARNING", logger="orcha.portal.errors"):
        out = verdikt_autofix.sweep("00000000-0000-0000-0000-000000000000")
    assert out["error"] == "the Verdikt sweep failed — see the portal log"
    assert "SECRET" in caplog.text
