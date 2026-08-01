import json
import re
from datetime import datetime, timezone

import pytest

pytestmark = pytest.mark.asyncio


async def test_pairing_payload_uses_lan_base_url_and_qr(client, container, make_agent, monkeypatch):
    monkeypatch.setenv("ORCHA_PAIRING_HOST", "192.168.1.24")
    human = await make_agent("Kedar", "operator", kind="human")

    r = await client.get(
        f"/api/containers/{container['id']}/pairing?human_agent_id={human['agent_id']}",
        headers={"host": "localhost:8001"},
    )

    assert r.status_code == 200, r.text
    data = r.json()
    assert data["v"] == 1
    assert data["kind"] == "orcha-pair"
    assert data["baseUrl"] == "http://192.168.1.24:8001"
    assert "localhost" not in data["baseUrl"]
    assert data["containerId"] == container["id"]
    assert data["containerName"] == container["name"]
    assert data["humanAgentId"] == human["agent_id"]
    assert data["humanAgentAlias"] == "Kedar"
    assert data["token"]
    assert data["shortCode"] and "-" in data["shortCode"]
    assert data["tokenExchange"]["status"] == "follow_up"
    assert data["tokenExchange"]["endpoint"] == "POST /api/pair/device-token"
    assert "<svg" in data["qrSvg"]

    qr_payload = json.loads(data["qrText"])
    assert qr_payload["kind"] == "orcha-pair"
    assert qr_payload["baseUrl"] == data["baseUrl"]
    assert qr_payload["humanAgentId"] == human["agent_id"]
    assert "qrSvg" not in qr_payload
    expires = datetime.fromisoformat(data["expiresAt"].replace("Z", "+00:00"))
    assert expires > datetime.now(timezone.utc)


async def test_pairing_warns_when_only_localhost_is_available(client, container, make_agent, monkeypatch):
    monkeypatch.delenv("ORCHA_PAIRING_HOST", raising=False)
    human = await make_agent("Kedar", "operator", kind="human")

    r = await client.get(
        f"/api/containers/{container['id']}/pairing?human_agent_id={human['agent_id']}",
        headers={"host": "localhost:8001"},
    )

    assert r.status_code == 409, r.text
    detail = r.json()["detail"]
    assert detail["title"] == "Phones can't reach this Orcha yet"
    assert detail["reason"] == "no_lan_address"
    assert "orcha up" in detail["remedy"]
    assert "--host" not in detail["remedy"]


async def test_pairing_requires_human_choice_when_multiple_humans(client, container, make_agent, monkeypatch):
    monkeypatch.setenv("ORCHA_PAIRING_HOST", "192.168.1.24")
    h1 = await make_agent("Kedar", "operator", kind="human")
    h2 = await make_agent("Dana", "designer", kind="human")

    r = await client.get(f"/api/containers/{container['id']}/pairing")
    assert r.status_code == 400, r.text
    detail = r.json()["detail"]
    assert detail["reason"] == "choose_human"
    assert {h["alias"] for h in detail["humans"]} == {"Kedar", "Dana"}

    ok = await client.get(f"/api/containers/{container['id']}/pairing?human_agent_id={h2['agent_id']}")
    assert ok.status_code == 200, ok.text
    assert ok.json()["humanAgentId"] == h2["agent_id"]
    assert ok.json()["humanAgentId"] != h1["agent_id"]


async def test_pairing_endpoint_is_in_openapi(client):
    r = await client.get("/openapi.json")
    assert r.status_code == 200, r.text
    assert "/api/containers/{cid}/pairing" in r.json()["paths"]


# ---------- branded QR: styled SVG + scannability round-trip ----------


async def test_qr_svg_is_branded_and_payload_unchanged(
    client, container, make_agent, monkeypatch
):
    monkeypatch.setenv("ORCHA_PAIRING_HOST", "192.168.1.24")
    human = await make_agent("Kedar", "operator", kind="human")
    r = await client.get(
        f"/api/containers/{container['id']}/pairing?human_agent_id={human['agent_id']}"
    )
    assert r.status_code == 200, r.text
    data = r.json()
    svg = data["qrSvg"]

    # dot-style modules + rounded finder frames + a baked-in light quiet zone
    assert svg.startswith("<svg")
    assert "<circle" in svg, "data modules are dots"
    assert svg.count('width="7" height="7" rx=') == 3, "three rounded finder frames"
    assert re.search(r'<rect width="\d+" height="\d+" rx="\d+" fill="#ffffff"/>', svg), (
        "the light tile behind the code is baked into the SVG (never theme-inverted)"
    )
    # the centre orca tile: same artwork as favicon.svg on the rounded dark tile
    assert 'rx="22" fill="#06171c"' in svg and "#1fc7cd" in svg, "embedded orca glyph"

    # the QR payload contract is unchanged by the restyle
    payload = json.loads(data["qrText"])
    assert payload["kind"] == "orcha-pair"
    assert payload["baseUrl"] == data["baseUrl"]
    assert payload["humanAgentId"] == human["agent_id"]
    assert payload["token"] == data["token"]
    assert "qrSvg" not in payload


def _rasterize_pairing_svg(svg, scale=8):
    """Draw the styled SVG's rects/circles with PIL, honestly: rounded corners kept,
    the centre glyph stripped (it is the trailing <g transform> group), so the
    knockout renders as blank damage exactly as a scanner sees a foreign image."""
    from PIL import Image, ImageDraw

    total = int(re.search(r'viewBox="0 0 (\d+) \d+"', svg).group(1))
    body = svg[: svg.index("<g transform=")] + "</svg>"
    img = Image.new("L", (total * scale, total * scale), 255)
    draw = ImageDraw.Draw(img)

    def shade(fill):
        m = re.match(r"#([0-9a-fA-F]{6})", fill or "")
        if not m:
            return None
        h = m.group(1)
        return 0 if (int(h[0:2], 16) + int(h[2:4], 16) + int(h[4:6], 16)) // 3 < 128 else 255

    group_fill = None
    for m in re.finditer(r"<(g|rect|circle)\b([^>]*?)/?>", body):
        tag = m.group(1)
        attrs = dict(re.findall(r'([\w-]+)="([^"]*)"', m.group(2)))
        if tag == "g":
            group_fill = attrs.get("fill")
            continue
        tone = shade(attrs.get("fill") or group_fill)
        if tone is None:
            continue
        if tag == "rect":
            x = float(attrs.get("x", 0)) * scale
            y = float(attrs.get("y", 0)) * scale
            w = float(attrs["width"]) * scale
            h = float(attrs["height"]) * scale
            r = float(attrs.get("rx", 0)) * scale
            draw.rounded_rectangle([x, y, x + w, y + h], radius=r, fill=tone)
        else:
            cx = float(attrs["cx"]) * scale
            cy = float(attrs["cy"]) * scale
            r = float(attrs["r"]) * scale
            draw.ellipse([cx - r, cy - r, cx + r, cy + r], fill=tone)
    return img


async def test_qr_decodes_back_to_the_exact_payload(
    client, container, make_agent, monkeypatch
):
    """Scannability gate: rasterize the shipped SVG geometry (dots, rounded
    finders, centre knockout) and a real decoder must read the exact payload."""
    zxingcpp = pytest.importorskip("zxingcpp")
    pytest.importorskip("PIL.Image")
    monkeypatch.setenv("ORCHA_PAIRING_HOST", "192.168.1.24")
    human = await make_agent("Kedar", "operator", kind="human")
    r = await client.get(
        f"/api/containers/{container['id']}/pairing?human_agent_id={human['agent_id']}"
    )
    assert r.status_code == 200, r.text
    data = r.json()

    result = zxingcpp.read_barcode(_rasterize_pairing_svg(data["qrSvg"]))
    assert result is not None and result.valid, "styled QR must stay machine-readable"
    assert "qr" in str(result.format).replace(" ", "").lower()
    assert result.ec_level == "H", "error correction must stay H for the glyph knockout"
    assert result.text == data["qrText"], "decoded payload round-trips exactly"
