"""Build short-lived phone-pairing payloads for a container's human operator."""

import json
import os
import secrets
from datetime import datetime, timezone
from typing import Optional

from fastapi import HTTPException, Query, Request

from portal_backend.application import app
from portal_backend.database import db_cursor
from portal_backend.guards import valid_uuid

PAIRING_TTL_SECONDS = 5 * 60
PAIRING_TOKEN_EXCHANGE_FOLLOWUP = {
    "status": "follow_up",
    "endpoint": "POST /api/pair/device-token",
    "note": "Mobile device-token exchange/auth is not implemented in this slice.",
}


def is_local_pairing_host(host: Optional[str]) -> bool:
    h = (host or "").strip().strip("[]").lower()
    if not h:
        return True
    if h in {"localhost", "0.0.0.0", "::", "::1"}:
        return True
    return h.startswith("127.")


def pairing_warning(reason: str) -> dict:
    return {
        "reachable": False,
        "reason": reason,
        "title": "Phones can't reach this Orcha yet",
        "message": (
            "The portal only has a localhost address right now, so a phone on Wi-Fi would not "
            "know how to reach this computer."
        ),
        "remedy": (
            "Connect this Mac to the same Wi-Fi as the phone, run `orcha up` from this workspace, "
            "and allow the Orcha portal port through macOS Firewall or Local Network prompts."
        ),
    }


def pairing_base_url(request: Request) -> tuple[Optional[str], Optional[dict]]:
    env_host = (os.environ.get("ORCHA_PAIRING_HOST") or "").strip()
    req_host = request.url.hostname or ""
    if env_host and not is_local_pairing_host(env_host):
        host = env_host
    elif req_host and not is_local_pairing_host(req_host):
        host = req_host
    else:
        return None, pairing_warning("no_lan_address")

    port = request.url.port
    scheme = request.url.scheme or "http"
    default_port = (scheme == "http" and port in (None, 80)) or (
        scheme == "https" and port in (None, 443)
    )
    authority = host if default_port else f"{host}:{port}"
    return f"{scheme}://{authority}", None


def short_pairing_code() -> str:
    alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
    raw = "".join(secrets.choice(alphabet) for _ in range(8))
    return raw[:4] + "-" + raw[4:]


def qr_svg(payload: dict) -> tuple[str, str]:
    import qrcode
    import qrcode.image.svg

    qr_text = json.dumps(payload, separators=(",", ":"), sort_keys=True)
    qr = qrcode.QRCode(
        version=None,
        error_correction=qrcode.constants.ERROR_CORRECT_M,
        box_size=10,
        border=4,
    )
    qr.add_data(qr_text)
    qr.make(fit=True)
    img = qr.make_image(image_factory=qrcode.image.svg.SvgPathImage)
    return qr_text, img.to_string(encoding="unicode")


@app.get("/api/containers/{cid}/pairing")
def get_container_pairing(
    cid: str, request: Request, human_agent_id: Optional[str] = Query(default=None)
):
    """Return the portal-to-phone QR pairing payload.

    This implements the A1 pairing payload/UI contract. The returned token is short-lived and
    forward-compatible, but there is intentionally no device-token exchange in this slice; A2 is
    represented explicitly in `tokenExchange` so mobile auth is not silently implied.
    """
    if not valid_uuid(cid):
        raise HTTPException(400, "container_id is not a valid UUID")
    if human_agent_id is not None and not valid_uuid(human_agent_id):
        raise HTTPException(400, "human_agent_id is not a valid UUID")

    base_url, warning = pairing_base_url(request)
    if warning:
        raise HTTPException(409, warning)

    with db_cursor() as (_, cur):
        cur.execute("SELECT id, name FROM containers WHERE id=%s", (cid,))
        container = cur.fetchone()
        if not container:
            raise HTTPException(404, f"container {cid} not found")
        cur.execute(
            "SELECT id, alias FROM agents WHERE container_id=%s AND kind='human' "
            "AND terminated_at IS NULL ORDER BY created_at, alias",
            (cid,),
        )
        humans = cur.fetchall()

    if not humans:
        raise HTTPException(
            409,
            {
                "reachable": False,
                "reason": "no_human",
                "title": "No human can pair this phone",
                "message": "Add a human operator to this Orcha before pairing a phone.",
            },
        )
    if human_agent_id:
        human = next((h for h in humans if str(h["id"]) == human_agent_id), None)
        if not human:
            raise HTTPException(400, "human_agent_id must be a human in this container")
    elif len(humans) == 1:
        human = humans[0]
    else:
        raise HTTPException(
            400,
            {
                "reason": "choose_human",
                "message": "Choose which human to pair as, then request the pairing payload again.",
                "humans": [{"id": str(h["id"]), "alias": h["alias"]} for h in humans],
            },
        )

    expires = datetime.now(timezone.utc).timestamp() + PAIRING_TTL_SECONDS
    expires_at = (
        datetime.fromtimestamp(expires, tz=timezone.utc)
        .isoformat()
        .replace("+00:00", "Z")
    )
    payload = {
        "v": 1,
        "kind": "orcha-pair",
        "baseUrl": base_url,
        "containerId": str(container["id"]),
        "containerName": container["name"],
        "humanAgentId": str(human["id"]),
        "humanAgentAlias": human["alias"],
        "token": secrets.token_urlsafe(24),
        "shortCode": short_pairing_code(),
        "expiresAt": expires_at,
        "tokenExchange": PAIRING_TOKEN_EXCHANGE_FOLLOWUP,
    }
    qr_payload = {
        key: payload[key]
        for key in (
            "v",
            "kind",
            "baseUrl",
            "containerId",
            "containerName",
            "humanAgentId",
            "humanAgentAlias",
            "token",
            "shortCode",
            "expiresAt",
        )
    }
    qr_text, svg = qr_svg(qr_payload)
    return {
        **payload,
        "expiresInSeconds": PAIRING_TTL_SECONDS,
        "reachable": True,
        "qrText": qr_text,
        "qrSvg": svg,
    }
