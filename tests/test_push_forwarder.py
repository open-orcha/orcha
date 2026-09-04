"""Box forwarder (deploy/push-forwarder.py) — tick flow against a stubbed relay.

The module's single HTTP seam (_http_json) is replaced with a recorder, so the
harness asserts the full portal→relay→portal conversation without any network:
claim → flatten per (event × device) → relay POST (bearer) → mark outcomes →
revoke Unregistered tokens. Plus the dormant contract: no RELAY_URL/RELAY_TOKEN
means zero HTTP traffic and a clean exit 0.
"""
import importlib.util
import pathlib

import pytest

REPO = pathlib.Path(__file__).resolve().parent.parent
FORWARDER_PY = REPO / "deploy" / "push-forwarder.py"

_spec = importlib.util.spec_from_file_location("push_forwarder", FORWARDER_PY)
forwarder = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(forwarder)

PORTAL = "http://127.0.0.1:8001"
RELAY = "https://relay.example"


class FakeWire:
    """Scripted (status, body) responses keyed by URL suffix; records every call."""

    def __init__(self, script):
        self.script = script
        self.calls = []

    def __call__(self, method, url, body=None, headers=None, timeout=15):
        self.calls.append({"method": method, "url": url, "body": body,
                           "headers": headers or {}})
        for suffix, response in self.script.items():
            if url.endswith(suffix):
                return response
        raise AssertionError(f"unexpected URL {url}")

    def sent_to(self, suffix):
        return [c for c in self.calls if c["url"].endswith(suffix)]


def _event(eid, devices, kind="task_verify", ref="t1"):
    return {
        "id": eid,
        "container_id": "c1",
        "kind": kind,
        "ref_id": ref,
        "title": "Verify task — arena",
        "body": "ship it",
        "payload": {"cid": "c1",
                    "kind": "request" if kind == "request" else "task",
                    "id": ref},
        "devices": devices,
    }


def test_dormant_without_relay_env(monkeypatch):
    """No RELAY_URL/RELAY_TOKEN → exit 0 and NOT ONE http call (not even claim)."""
    monkeypatch.delenv("RELAY_URL", raising=False)
    monkeypatch.delenv("RELAY_TOKEN", raising=False)

    def _forbidden(*args, **kwargs):
        raise AssertionError("dormant mode must make no HTTP calls")

    monkeypatch.setattr(forwarder, "_http_json", _forbidden)
    assert forwarder.main() == 0


def test_tick_full_flow_delivers_marks_and_revokes(monkeypatch):
    """e1: one device delivers (delivered even though the other is dead).
    e2: every device unregistered → failed terminally. Dead tokens revoked."""
    wire = FakeWire({
        "/api/push/outbox/claim": (200, {"events": [
            _event("e1", ["tok-good", "tok-dead"]),
            _event("e2", ["tok-dead2"], kind="request", ref="r1"),
        ]}),
        "/relay/push": (200, {"results": [
            {"apns_token": "tok-good", "status": "delivered", "detail": "http 200"},
            {"apns_token": "tok-dead", "status": "unregistered", "detail": "Unregistered"},
            {"apns_token": "tok-dead2", "status": "unregistered", "detail": "Unregistered"},
        ]}),
        "/api/push/outbox/mark": (200, {"delivered": 1, "failed": 1}),
        "/api/push/devices/revoke-unregistered": (200, {"revoked": 2}),
    })
    monkeypatch.setattr(forwarder, "_http_json", wire)

    summary = forwarder.run_once(PORTAL, RELAY, "sekrit")
    assert summary == {"claimed": 2, "delivered": 1, "failed": 1,
                       "revoked": 2, "skipped": False}

    # relay call: bearer + one flat entry per (event × device), payload intact
    relay_call = wire.sent_to("/relay/push")[0]
    assert relay_call["headers"]["Authorization"] == "Bearer sekrit"
    entries = relay_call["body"]["events"]
    assert [e["apns_token"] for e in entries] == ["tok-good", "tok-dead", "tok-dead2"]
    assert entries[0]["payload"] == {"cid": "c1", "kind": "task", "id": "t1"}
    assert entries[2]["payload"] == {"cid": "c1", "kind": "request", "id": "r1"}

    # outcome report: e1 delivered (one live recipient suffices), e2 dead forever
    mark_call = wire.sent_to("/api/push/outbox/mark")[0]
    assert mark_call["body"] == {
        "delivered": ["e1"],
        "failed": {"e2": "all device tokens unregistered"},
    }

    # both dead tokens revoked via the portal (sorted, deduped)
    revoke_call = wire.sent_to("/api/push/devices/revoke-unregistered")[0]
    assert revoke_call["body"] == {"apns_tokens": ["tok-dead", "tok-dead2"]}


def test_soft_failures_stay_pending(monkeypatch):
    """A retryable failure marks nothing — the next tick re-claims the row."""
    wire = FakeWire({
        "/api/push/outbox/claim": (200, {"events": [_event("e1", ["tok-good"])]}),
        "/relay/push": (200, {"results": [
            {"apns_token": "tok-good", "status": "failed", "detail": "http 500"},
        ]}),
    })
    monkeypatch.setattr(forwarder, "_http_json", wire)
    summary = forwarder.run_once(PORTAL, RELAY, "sekrit")
    assert summary["claimed"] == 1
    assert summary["delivered"] == 0 and summary["failed"] == 0
    assert wire.sent_to("/api/push/outbox/mark") == []          # nothing terminal
    assert wire.sent_to("/api/push/devices/revoke-unregistered") == []


def test_relay_dormant_503_leaves_rows_pending(monkeypatch):
    """Relay deployed but APNs-unconfigured: claim happened, nothing marked."""
    wire = FakeWire({
        "/api/push/outbox/claim": (200, {"events": [_event("e1", ["tok-good"])]}),
        "/relay/push": (503, {"error": "relay not configured for APNs delivery"}),
    })
    monkeypatch.setattr(forwarder, "_http_json", wire)
    summary = forwarder.run_once(PORTAL, RELAY, "sekrit")
    assert summary["skipped"] is True
    assert wire.sent_to("/api/push/outbox/mark") == []


def test_empty_claim_short_circuits(monkeypatch):
    wire = FakeWire({"/api/push/outbox/claim": (200, {"events": []})})
    monkeypatch.setattr(forwarder, "_http_json", wire)
    summary = forwarder.run_once(PORTAL, RELAY, "sekrit")
    assert summary["claimed"] == 0
    assert len(wire.calls) == 1  # claim only — no relay, no mark, no revoke
