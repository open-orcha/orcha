#!/usr/bin/env python3
"""Box-side push forwarder — drains the portal's push outbox into the relay.

Runs from push-forwarder.timer (every minute, oneshot). Stdlib only: the box
holds no APNs material and speaks no HTTP/2 — it just moves rows.

One tick (run_once):
  1. POST {portal}/api/push/outbox/claim        → pending events, each with its
     recipient devices resolved at claim time (never enqueue-time snapshots).
  2. POST {relay}/relay/push (bearer RELAY_TOKEN) with one flat entry per
     (event × device token).
  3. POST {portal}/api/push/outbox/mark          → delivered_at for events where
     at least one device delivered; failed for events where every device
     failed terminally. Events with retryable failures are left pending — the
     next tick re-claims them (at-least-once, bounded by the portal's 48h prune).
  4. POST {portal}/api/push/devices/revoke-unregistered for tokens APNs
     reported dead, so they stop resolving at the next claim.

DORMANT MODE: without RELAY_URL + RELAY_TOKEN in the environment the script
exits 0 immediately — no portal traffic at all; outbox rows age out on the
portal side (48h prune inside the claim/enqueue paths). A relay answering 503
(deployed but unconfigured) likewise leaves everything pending.

Environment:
  RELAY_TOKEN       per-box bearer for the relay        } absent → dormant
  RELAY_URL         e.g. https://relay.example:8787     }
  ORCHA_PORTAL_URL  default http://127.0.0.1:8001 (the loopback portal lane)
"""

import json
import os
import sys
import urllib.error
import urllib.request

CLAIM_LIMIT = 100


def _http_json(method, url, body=None, headers=None, timeout=15):
    """(status, parsed-json) for one JSON request. The module's single HTTP seam
    — tests monkeypatch this; both service endpoints ride through it."""
    data = json.dumps(body).encode() if body is not None else None
    request = urllib.request.Request(url, data=data, method=method)
    request.add_header("Content-Type", "application/json")
    for key, value in (headers or {}).items():
        request.add_header(key, value)
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return response.status, json.loads(response.read() or b"{}")
    except urllib.error.HTTPError as exc:
        try:
            payload = json.loads(exc.read() or b"{}")
        except Exception:
            payload = {}
        return exc.code, payload


def run_once(portal, relay_url, relay_token):
    """One forwarder tick. Returns a summary dict (also the test surface)."""
    summary = {"claimed": 0, "delivered": 0, "failed": 0, "revoked": 0, "skipped": False}

    status, claim = _http_json(
        "POST", f"{portal}/api/push/outbox/claim", {"limit": CLAIM_LIMIT}
    )
    if status != 200:
        print(f"claim failed: http {status}", flush=True)
        summary["skipped"] = True
        return summary
    events = claim.get("events") or []
    summary["claimed"] = len(events)
    if not events:
        return summary

    # Flatten to one relay entry per (event × device); remember each entry's row.
    entries, entry_event_ids = [], []
    for event in events:
        for token in event.get("devices") or []:
            entries.append(
                {
                    "apns_token": token,
                    "title": event.get("title"),
                    "body": event.get("body"),
                    "payload": event.get("payload"),
                }
            )
            entry_event_ids.append(event["id"])

    status, relayed = _http_json(
        "POST",
        f"{relay_url}/relay/push",
        {"events": entries},
        headers={"Authorization": f"Bearer {relay_token}"},
    )
    if status == 503:
        # Relay deployed but APNs-dormant: leave every row pending to age out.
        print(f"relay dormant: {relayed.get('error', 'not configured')}", flush=True)
        summary["skipped"] = True
        return summary
    if status != 200:
        print(f"relay error: http {status}", flush=True)
        summary["skipped"] = True
        return summary

    results = relayed.get("results") or []
    per_event = {event["id"]: {"delivered": 0, "dead": 0, "soft": 0} for event in events}
    dead_tokens = set()
    for index, result in enumerate(results[: len(entry_event_ids)]):
        outcome = per_event[entry_event_ids[index]]
        verdict = result.get("status")
        if verdict == "delivered":
            outcome["delivered"] += 1
        elif verdict == "unregistered":
            outcome["dead"] += 1
            dead_tokens.add(result.get("apns_token") or "")
        else:
            outcome["soft"] += 1

    delivered_ids, failed_ids = [], {}
    for event in events:
        outcome = per_event[event["id"]]
        if outcome["delivered"] > 0:
            delivered_ids.append(event["id"])
        elif outcome["soft"] == 0 and outcome["dead"] > 0:
            # Every recipient token is dead — no retry can ever succeed.
            failed_ids[event["id"]] = "all device tokens unregistered"
        # else: soft failures remain pending for the next tick's re-claim.

    if delivered_ids or failed_ids:
        _, marked = _http_json(
            "POST",
            f"{portal}/api/push/outbox/mark",
            {"delivered": delivered_ids, "failed": failed_ids},
        )
        summary["delivered"] = marked.get("delivered", 0)
        summary["failed"] = marked.get("failed", 0)

    dead_tokens.discard("")
    if dead_tokens:
        _, revoked = _http_json(
            "POST",
            f"{portal}/api/push/devices/revoke-unregistered",
            {"apns_tokens": sorted(dead_tokens)},
        )
        summary["revoked"] = revoked.get("revoked", 0)

    print(
        f"push tick: claimed={summary['claimed']} delivered={summary['delivered']} "
        f"failed={summary['failed']} revoked={summary['revoked']}",
        flush=True,
    )
    return summary


def main():
    relay_url = (os.environ.get("RELAY_URL") or "").strip().rstrip("/")
    relay_token = (os.environ.get("RELAY_TOKEN") or "").strip()
    if not relay_url or not relay_token:
        # Dormant: push not activated on this box. Silence is deliberate —
        # a timer log line every minute would just be noise.
        return 0
    portal = (
        os.environ.get("ORCHA_PORTAL_URL") or "http://127.0.0.1:8001"
    ).strip().rstrip("/")
    run_once(portal, relay_url, relay_token)
    return 0


if __name__ == "__main__":
    sys.exit(main())
