"""pairing_base_url — the QR's address must be reachable from a PHONE.

Incident (2026-08-31): with ORCHA_PAIRING_HOST pinned to the public domain on a
hosted box, the QR still shipped `http://<domain>:8000` — the scheme/port of the
container's INTERNAL hop behind the reverse proxy, a loopback-only port no phone
can reach. Pinned host now implies forwarded-proto/https + standard port unless
ORCHA_PAIRING_PORT overrides; the LAN path keeps request scheme/port untouched.
"""
import sys
import pathlib

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent
                       / "orcha-cli" / "orcha_cli" / "templates" / "portal"))

from starlette.requests import Request  # noqa: E402
from portal_backend.container_pairing_routes import pairing_base_url  # noqa: E402


def _req(host="127.0.0.1", port=8000, scheme="http", fwd_proto=None):
    headers = []
    if fwd_proto:
        headers.append((b"x-forwarded-proto", fwd_proto.encode()))
    return Request({
        "type": "http", "method": "GET", "path": "/api/x", "query_string": b"",
        "headers": headers, "server": (host, port), "scheme": scheme,
    })


def test_pinned_host_yields_https_standard_port(monkeypatch):
    monkeypatch.setenv("ORCHA_PAIRING_HOST", "orcha.example.com")
    monkeypatch.delenv("ORCHA_PAIRING_PORT", raising=False)
    base, warn = pairing_base_url(_req(fwd_proto="https"))
    assert warn is None
    assert base == "https://orcha.example.com"


def test_pinned_host_defaults_https_without_forwarded_proto(monkeypatch):
    monkeypatch.setenv("ORCHA_PAIRING_HOST", "orcha.example.com")
    monkeypatch.delenv("ORCHA_PAIRING_PORT", raising=False)
    base, _ = pairing_base_url(_req())
    assert base == "https://orcha.example.com"


def test_pinned_host_honors_pairing_port(monkeypatch):
    monkeypatch.setenv("ORCHA_PAIRING_HOST", "orcha.example.com")
    monkeypatch.setenv("ORCHA_PAIRING_PORT", "8443")
    base, _ = pairing_base_url(_req(fwd_proto="https"))
    assert base == "https://orcha.example.com:8443"


def test_lan_path_keeps_request_scheme_and_port(monkeypatch):
    monkeypatch.delenv("ORCHA_PAIRING_HOST", raising=False)
    monkeypatch.delenv("ORCHA_PAIRING_PORT", raising=False)
    base, warn = pairing_base_url(_req(host="192.168.1.24", port=8000, scheme="http"))
    assert warn is None
    assert base == "http://192.168.1.24:8000"


def test_localhost_only_still_warns(monkeypatch):
    monkeypatch.delenv("ORCHA_PAIRING_HOST", raising=False)
    base, warn = pairing_base_url(_req(host="127.0.0.1"))
    assert base is None and warn is not None
