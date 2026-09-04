#!/usr/bin/env python3
"""Orcha push relay — the ONE holder of the APNs signing key.

Design rule (docs/push-notifications.md): customer/BYOC boxes never see the
.p8 key. Boxes run deploy/push-forwarder.py, which POSTs batches of needs-you
events here; this relay signs an APNs provider JWT (ES256) and delivers each
alert over APNs HTTP/2, answering a per-event status so boxes can retire
tokens APNs reports as Unregistered.

DORMANT until credentials: with the APNS_* env absent every /relay/push call
answers 503 with a clear message and nothing else happens — the pipeline is
safe to deploy before the paid Apple Developer account exists.

API (bearer-authenticated with the per-box RELAY_TOKEN):

  POST /relay/push  {"events": [{"apns_token", "title", "body", "payload"}]}
    → 200 {"results": [{"apns_token", "status", "detail"}]}
        status: "delivered" | "unregistered" | "failed"
    → 401 missing/wrong bearer   → 503 relay not configured (dormant)

  GET /relay/healthz → 200 {"ok": true, "configured": bool}   (no auth)

Environment:
  RELAY_TOKEN    shared bearer the boxes present (required to serve /relay/push)
  APNS_KEY_ID    Apple key id of the .p8 APNs auth key
  APNS_TEAM_ID   Apple Developer team id
  APNS_KEY_P8    path to the .p8 key file
  APNS_TOPIC     the app bundle id (io.openorcha.mobile.ios)
  APNS_ENV       sandbox | production (default sandbox)
  RELAY_BIND     host:port to bind (default 127.0.0.1:8787)

Dependencies (requirements.txt, relay-only): PyJWT+cryptography for ES256,
httpx[h2] because APNs requires HTTP/2. The portal/boxes need none of these.
"""

import hmac
import json
import os
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

APNS_HOSTS = {
    "sandbox": "https://api.sandbox.push.apple.com",
    "production": "https://api.push.apple.com",
}

# Apple accepts provider JWTs 20-60 minutes old; refresh at 50 to stay clear
# of both edges (TooManyProviderTokenUpdates below 20, ExpiredProviderToken at 60).
JWT_REFRESH_SECS = 50 * 60

MAX_EVENTS_PER_CALL = 500


def apns_config():
    """The APNS_* env as a dict, or None when any piece is missing (dormant)."""
    cfg = {
        "key_id": os.environ.get("APNS_KEY_ID", "").strip(),
        "team_id": os.environ.get("APNS_TEAM_ID", "").strip(),
        "key_path": os.environ.get("APNS_KEY_P8", "").strip(),
        "topic": os.environ.get("APNS_TOPIC", "").strip(),
        "env": (os.environ.get("APNS_ENV", "").strip() or "sandbox"),
    }
    if not all([cfg["key_id"], cfg["team_id"], cfg["key_path"], cfg["topic"]]):
        return None
    if cfg["env"] not in APNS_HOSTS or not os.path.isfile(cfg["key_path"]):
        return None
    return cfg


def make_jwt(cfg, now=None):
    """A fresh ES256 provider JWT: header {alg, kid}, claims {iss: team, iat}."""
    import jwt  # PyJWT — relay-only dependency, imported lazily

    with open(cfg["key_path"]) as fh:
        key_pem = fh.read()
    return jwt.encode(
        {"iss": cfg["team_id"], "iat": int(now if now is not None else time.time())},
        key_pem,
        algorithm="ES256",
        headers={"kid": cfg["key_id"]},
    )


class _SignerCache:
    """Reuse one provider JWT for up to 50 minutes (Apple rate-limits refreshes)."""

    def __init__(self):
        self._lock = threading.Lock()
        self._token = None
        self._minted_at = 0.0

    def token(self, cfg):
        with self._lock:
            now = time.time()
            if self._token is None or now - self._minted_at > JWT_REFRESH_SECS:
                self._token = make_jwt(cfg, now)
                self._minted_at = now
            return self._token


_signer = _SignerCache()


def _make_client():
    """The APNs HTTP/2 client — a seam so tests can inject a mock transport."""
    import httpx

    return httpx.Client(http2=True, timeout=10.0)


def _classify(status_code, reason):
    """Map an APNs response to the relay's per-event verdict."""
    if status_code == 200:
        return "delivered"
    # 410 Unregistered: the token is dead (app deleted / token rotated).
    # 400 BadDeviceToken: malformed OR wrong APNs environment — either way the
    # token can never deliver in THIS relay's env, so boxes should retire it.
    if status_code == 410 or reason in ("Unregistered", "BadDeviceToken"):
        return "unregistered"
    return "failed"


def deliver_events(events):
    """Deliver a batch; returns one {apns_token, status, detail} per event.

    A provider-level failure (network down, bad JWT) fails the whole remainder
    with detail set — boxes leave those rows pending and retry next tick."""
    cfg = apns_config()
    assert cfg is not None  # callers gate on configuration first
    provider_jwt = _signer.token(cfg)
    host = APNS_HOSTS[cfg["env"]]
    results = []
    with _make_client() as client:
        for event in events:
            token = str(event.get("apns_token") or "").strip()
            if not token:
                results.append(
                    {"apns_token": token, "status": "failed", "detail": "empty token"}
                )
                continue
            payload = {
                "aps": {
                    "alert": {
                        "title": str(event.get("title") or "Orcha"),
                        "body": str(event.get("body") or ""),
                    },
                    "sound": "default",
                },
            }
            extra = event.get("payload")
            if isinstance(extra, dict):
                # The deep-link triple {cid, kind, id} rides top-level, exactly
                # like the local notification's userInfo.
                for key, value in extra.items():
                    if key != "aps":
                        payload[key] = value
            try:
                response = client.post(
                    f"{host}/3/device/{token}",
                    content=json.dumps(payload),
                    headers={
                        "authorization": f"bearer {provider_jwt}",
                        "apns-topic": cfg["topic"],
                        "apns-push-type": "alert",
                        "apns-priority": "10",
                    },
                )
            except Exception as exc:  # network/provider trouble — retryable
                results.append(
                    {"apns_token": token, "status": "failed", "detail": str(exc)[:200]}
                )
                continue
            reason = None
            if response.status_code != 200:
                try:
                    reason = response.json().get("reason")
                except Exception:
                    reason = None
            results.append(
                {
                    "apns_token": token,
                    "status": _classify(response.status_code, reason),
                    "detail": reason or f"http {response.status_code}",
                }
            )
    return results


class RelayHandler(BaseHTTPRequestHandler):
    server_version = "orcha-push-relay/1"

    def _respond(self, code, body):
        data = json.dumps(body).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _authorized(self):
        expected = os.environ.get("RELAY_TOKEN", "").strip()
        if not expected:
            return False
        supplied = self.headers.get("Authorization", "")
        scheme, _, token = supplied.partition(" ")
        return scheme == "Bearer" and hmac.compare_digest(token.strip(), expected)

    def do_GET(self):
        if self.path == "/relay/healthz":
            self._respond(200, {"ok": True, "configured": apns_config() is not None})
            return
        self._respond(404, {"error": "not found"})

    def do_POST(self):
        if self.path != "/relay/push":
            self._respond(404, {"error": "not found"})
            return
        if not self._authorized():
            self._respond(401, {"error": "missing or invalid relay bearer token"})
            return
        if apns_config() is None:
            # DORMANT: deployed before the paid Apple account / key exists.
            self._respond(
                503,
                {
                    "error": "relay not configured for APNs delivery — set "
                    "APNS_KEY_ID, APNS_TEAM_ID, APNS_KEY_P8, APNS_TOPIC "
                    "(and APNS_ENV) on the relay; see deploy/push-relay/README.md"
                },
            )
            return
        try:
            length = int(self.headers.get("Content-Length") or 0)
            body = json.loads(self.rfile.read(length) or b"{}")
            events = body.get("events") or []
            assert isinstance(events, list)
        except Exception:
            self._respond(400, {"error": "body must be JSON: {\"events\": [...]}"})
            return
        if len(events) > MAX_EVENTS_PER_CALL:
            self._respond(400, {"error": f"max {MAX_EVENTS_PER_CALL} events per call"})
            return
        self._respond(200, {"results": deliver_events(events)})

    def log_message(self, fmt, *args):  # systemd journal gets one line per call
        print(f"{self.address_string()} {fmt % args}", flush=True)


def main():
    bind = os.environ.get("RELAY_BIND", "127.0.0.1:8787")
    host, _, port = bind.rpartition(":")
    server = ThreadingHTTPServer((host or "127.0.0.1", int(port)), RelayHandler)
    configured = "configured" if apns_config() else "DORMANT (no APNs credentials)"
    print(f"orcha push relay on {bind} — {configured}", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
