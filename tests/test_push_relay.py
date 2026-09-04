"""Push relay (deploy/push-relay/relay.py) — JWT shape, dormant 503, delivery.

No real APNs traffic anywhere: the delivery test injects an httpx MockTransport
through the relay's _make_client seam; everything else exercises the HTTP
surface of a real ThreadingHTTPServer on a loopback ephemeral port.
"""
import importlib.util
import json
import pathlib
import threading

import pytest

jwt = pytest.importorskip("jwt")  # PyJWT — relay-only dep (tests/requirements.txt)
pytest.importorskip("cryptography")
import httpx  # noqa: E402
from cryptography.hazmat.primitives import serialization  # noqa: E402
from cryptography.hazmat.primitives.asymmetric import ec  # noqa: E402

REPO = pathlib.Path(__file__).resolve().parent.parent
RELAY_PY = REPO / "deploy" / "push-relay" / "relay.py"

_spec = importlib.util.spec_from_file_location("push_relay", RELAY_PY)
relay = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(relay)

pytestmark = []  # sync tests — no asyncio needed here


@pytest.fixture(autouse=True)
def _fresh_signer():
    """The signer caches its JWT for 50 minutes — isolate tests from each other."""
    relay._signer = relay._SignerCache()
    yield
    relay._signer = relay._SignerCache()


@pytest.fixture
def p8_key(tmp_path):
    """A real P-256 key pair: (key_path, public_key) for sign/verify round-trips."""
    private = ec.generate_private_key(ec.SECP256R1())
    pem = private.private_bytes(
        serialization.Encoding.PEM,
        serialization.PrivateFormat.PKCS8,
        serialization.NoEncryption(),
    )
    path = tmp_path / "AuthKey_TESTKEY123.p8"
    path.write_bytes(pem)
    return str(path), private.public_key()


@pytest.fixture
def apns_env(monkeypatch, p8_key):
    key_path, public = p8_key
    monkeypatch.setenv("APNS_KEY_ID", "TESTKEY123")
    monkeypatch.setenv("APNS_TEAM_ID", "TEAM123456")
    monkeypatch.setenv("APNS_KEY_P8", key_path)
    monkeypatch.setenv("APNS_TOPIC", "io.openorcha.mobile.ios")
    monkeypatch.setenv("APNS_ENV", "sandbox")
    return public


@pytest.fixture
def relay_server(monkeypatch):
    """A live relay on a loopback ephemeral port, authenticated by 'sekrit'."""
    monkeypatch.setenv("RELAY_TOKEN", "sekrit")
    server = relay.ThreadingHTTPServer(("127.0.0.1", 0), relay.RelayHandler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    yield f"http://127.0.0.1:{server.server_address[1]}"
    server.shutdown()
    server.server_close()


AUTH = {"Authorization": "Bearer sekrit"}


# ---------- provider JWT shape ----------

def test_jwt_shape_and_signature(apns_env):
    """Header {alg: ES256, kid}; claims {iss: team, iat}; verifiable signature."""
    public = apns_env
    cfg = relay.apns_config()
    assert cfg is not None and cfg["env"] == "sandbox"
    token = relay.make_jwt(cfg, now=1_700_000_000)
    header = jwt.get_unverified_header(token)
    assert header["alg"] == "ES256" and header["kid"] == "TESTKEY123"
    claims = jwt.decode(token, public, algorithms=["ES256"])
    assert claims == {"iss": "TEAM123456", "iat": 1_700_000_000}


def test_signer_cache_reuses_until_refresh_window(apns_env, monkeypatch):
    cfg = relay.apns_config()
    first = relay._signer.token(cfg)
    assert relay._signer.token(cfg) == first  # cached
    monkeypatch.setattr(relay, "JWT_REFRESH_SECS", -1)  # force expiry
    assert relay._signer.token(cfg) != first


# ---------- configuration / dormant detection ----------

def test_apns_config_none_when_any_piece_missing(apns_env, monkeypatch):
    assert relay.apns_config() is not None
    monkeypatch.delenv("APNS_TEAM_ID")
    assert relay.apns_config() is None


def test_apns_config_none_for_bad_env_or_missing_file(apns_env, monkeypatch):
    monkeypatch.setenv("APNS_ENV", "staging")
    assert relay.apns_config() is None
    monkeypatch.setenv("APNS_ENV", "production")
    monkeypatch.setenv("APNS_KEY_P8", "/nonexistent/AuthKey.p8")
    assert relay.apns_config() is None


# ---------- the HTTP surface ----------

def test_dormant_mode_answers_503_with_guidance(relay_server, monkeypatch):
    for var in ("APNS_KEY_ID", "APNS_TEAM_ID", "APNS_KEY_P8", "APNS_TOPIC"):
        monkeypatch.delenv(var, raising=False)
    r = httpx.post(f"{relay_server}/relay/push", json={"events": []}, headers=AUTH)
    assert r.status_code == 503
    assert "APNS_KEY_ID" in r.json()["error"]  # says exactly what to configure

    health = httpx.get(f"{relay_server}/relay/healthz")
    assert health.status_code == 200
    assert health.json() == {"ok": True, "configured": False}


def test_auth_required_before_anything_else(relay_server):
    r = httpx.post(f"{relay_server}/relay/push", json={"events": []})
    assert r.status_code == 401
    r = httpx.post(
        f"{relay_server}/relay/push",
        json={"events": []},
        headers={"Authorization": "Bearer wrong"},
    )
    assert r.status_code == 401


def test_delivery_classifies_per_event(relay_server, apns_env, monkeypatch):
    """End-to-end through the real HTTP handler with a mock APNs transport:
    delivered / unregistered (410 + BadDeviceToken) / failed, per event."""
    seen = []

    def apns(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        token = request.url.path.rsplit("/", 1)[-1]
        if token == "dead1":
            return httpx.Response(410, json={"reason": "Unregistered"})
        if token == "dead2":
            return httpx.Response(400, json={"reason": "BadDeviceToken"})
        if token == "flaky":
            return httpx.Response(500, json={"reason": "InternalServerError"})
        return httpx.Response(200)

    monkeypatch.setattr(
        relay, "_make_client", lambda: httpx.Client(transport=httpx.MockTransport(apns))
    )
    events = [
        {"apns_token": "good", "title": "Verify task — arena", "body": "ship it",
         "payload": {"cid": "c1", "kind": "task", "id": "t1"}},
        {"apns_token": "dead1", "title": "x", "body": "y"},
        {"apns_token": "dead2", "title": "x", "body": "y"},
        {"apns_token": "flaky", "title": "x", "body": "y"},
    ]
    r = httpx.post(f"{relay_server}/relay/push", json={"events": events}, headers=AUTH)
    assert r.status_code == 200, r.text
    statuses = [(res["apns_token"], res["status"]) for res in r.json()["results"]]
    assert statuses == [
        ("good", "delivered"),
        ("dead1", "unregistered"),
        ("dead2", "unregistered"),
        ("flaky", "failed"),
    ]

    # the APNs request itself: path, topic/push-type headers, signed bearer, payload
    first = seen[0]
    assert first.url.host == "api.sandbox.push.apple.com"
    assert first.url.path == "/3/device/good"
    assert first.headers["apns-topic"] == "io.openorcha.mobile.ios"
    assert first.headers["apns-push-type"] == "alert"
    assert first.headers["authorization"].startswith("bearer ")
    body = json.loads(first.content)
    assert body["aps"]["alert"] == {"title": "Verify task — arena", "body": "ship it"}
    assert (body["cid"], body["kind"], body["id"]) == ("c1", "task", "t1")


def test_classify_table():
    assert relay._classify(200, None) == "delivered"
    assert relay._classify(410, "Unregistered") == "unregistered"
    assert relay._classify(400, "BadDeviceToken") == "unregistered"
    assert relay._classify(400, "MissingTopic") == "failed"
    assert relay._classify(500, None) == "failed"
