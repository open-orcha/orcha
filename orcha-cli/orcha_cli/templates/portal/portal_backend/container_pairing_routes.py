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


# ---- branded QR ------------------------------------------------------------
# The QR is drawn as a hand-assembled SVG from the raw module matrix (qrcode lib,
# EC level H) instead of the stock square-pixel image factory:
#   - dot-style data modules + rounded finder frames (the modern, branded look);
#   - a 4-module quiet zone baked into the viewBox over an always-LIGHT tile —
#     dark modules on light stay fixed in every theme, scanners need the contrast;
#   - the orca glyph (same artwork as static/favicon.svg) embedded on a rounded
#     dark tile in the centre. EC=H recovers up to 30% damage; the knockout is
#     capped well below that (~8% of the module area, see QR_EMBED_FRACTION).
# Pure string assembly on qrcode's matrix — no Pillow/StyledPilImage dependency,
# and SVG stays crisp at any rendered size.
QR_DARK = "#06171c"    # module ink — the brand dark, matches the favicon tile
QR_LIGHT = "#ffffff"   # the light tile behind the code (never theme-inverted)
QR_QUIET_MODULES = 4   # quiet zone, in modules, on every side
QR_EMBED_FRACTION = 0.28  # centre knockout side as a fraction of the module count


def _qr_finder_frame(x: float, y: float) -> str:
    """One 7x7 finder pattern as rounded concentric squares (dark/light/dark)."""
    return (
        f'<rect x="{x}" y="{y}" width="7" height="7" rx="2.33" fill="{QR_DARK}"/>'
        f'<rect x="{x + 1}" y="{y + 1}" width="5" height="5" rx="1.67" fill="{QR_LIGHT}"/>'
        f'<rect x="{x + 2}" y="{y + 2}" width="3" height="3" rx="1" fill="{QR_DARK}"/>'
    )


def _qr_orca_tile(x: float, y: float, size: float) -> str:
    """The favicon orca on its rounded dark tile, scaled into the centre knockout."""
    s = size / 100.0
    return (
        f'<g transform="translate({x:.2f},{y:.2f}) scale({s:.4f})" aria-hidden="true">'
        f'<rect width="100" height="100" rx="22" fill="{QR_DARK}"/>'
        '<path d="M27,83 C28,55 33,32 45.5,22.5 C51.5,18 57.5,19.5 60,27 '
        'C64.5,46 70.5,67 73,83 Z" fill="#f3fbfb"/>'
        '<g stroke="#06171c" stroke-width="2.4" stroke-linecap="round">'
        '<line x1="49" y1="38" x2="40" y2="62"/><line x1="49" y1="38" x2="56" y2="62"/>'
        '<line x1="49" y1="38" x2="50" y2="74"/></g>'
        '<g fill="#06171c"><circle cx="39" cy="64" r="4"/><circle cx="57" cy="64" r="4"/>'
        '<circle cx="50" cy="76" r="4"/></g>'
        '<circle cx="49" cy="35" r="6" fill="#1fc7cd"/>'
        '<path d="M13,86 C28,82 38,82 50,82.5 C62,82 72,82 87,86" stroke="#1fc7cd" '
        'stroke-width="5" stroke-linecap="round" fill="none"/>'
        "</g>"
    )


def qr_svg(payload: dict) -> tuple[str, str]:
    import qrcode

    qr_text = json.dumps(payload, separators=(",", ":"), sort_keys=True)
    qr = qrcode.QRCode(
        version=None,
        error_correction=qrcode.constants.ERROR_CORRECT_H,
        border=0,  # the quiet zone is drawn by hand in viewBox units below
    )
    qr.add_data(qr_text)
    qr.make(fit=True)
    matrix = qr.get_matrix()
    n = len(matrix)
    quiet = QR_QUIET_MODULES
    total = n + 2 * quiet

    # Centre knockout for the embedded glyph: an odd module count so it sits
    # symmetrically, ~8% of the code's area — far inside EC-H's 30% budget.
    knockout = max(9, int(n * QR_EMBED_FRACTION))
    knockout += 0 if knockout % 2 else 1
    k0 = (n - knockout) // 2
    k1 = k0 + knockout

    def in_finder(cx: int, cy: int) -> bool:
        return (
            (cx < 7 and cy < 7)
            or (cx >= n - 7 and cy < 7)
            or (cx < 7 and cy >= n - 7)
        )

    parts = [
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {total} {total}" '
        'shape-rendering="geometricPrecision">',
        # the light tile: baked in so contrast never depends on page CSS/theme
        f'<rect width="{total}" height="{total}" rx="6" fill="{QR_LIGHT}"/>',
        _qr_finder_frame(quiet, quiet),
        _qr_finder_frame(quiet + n - 7, quiet),
        _qr_finder_frame(quiet, quiet + n - 7),
    ]
    dots = []
    for y in range(n):
        for x in range(n):
            if not matrix[y][x] or in_finder(x, y):
                continue
            if k0 <= x < k1 and k0 <= y < k1:
                continue  # the glyph knockout — recovered by EC-H
            dots.append(
                f'<circle cx="{quiet + x + 0.5}" cy="{quiet + y + 0.5}" r="0.46"/>'
            )
    parts.append(f'<g fill="{QR_DARK}">{"".join(dots)}</g>')
    # the orca tile, inset one module inside the knockout for a light margin ring
    parts.append(_qr_orca_tile(quiet + k0 + 1, quiet + k0 + 1, knockout - 2))
    parts.append("</svg>")
    return qr_text, "".join(parts)


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
