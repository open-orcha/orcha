import json
import re
from datetime import datetime, timezone

import pytest


@pytest.fixture(autouse=True)
def _team_plan(monkeypatch):
    """This suite exercises Team-plan features (members/device identity) under the
    plan-gating addendum (docs/orcha-cloud-local-run.md) — same idiom as
    tests/test_access_model.py. Solo-tier 402 behavior is covered by
    tests/test_plan_gating.py, so nothing here masks the gate itself."""
    monkeypatch.setenv("ORCHA_PLAN", "team")


pytestmark = pytest.mark.asyncio

OCTO = {"X-Auth-Request-User": "octocat"}      # will bind as the founding owner
MALLORY = {"X-Auth-Request-User": "mallory"}   # verified stranger — never a member


@pytest.fixture
def trust_proxy(monkeypatch):
    monkeypatch.setenv("ORCHA_TRUST_PROXY_USER", "1")


async def _bind_owner(client, container, make_agent):
    """Fresh-container binding: octocat claims the founding human, becomes owner."""
    await make_agent("root", "operator", kind="human")
    r = await client.get(f"/api/me?cid={container['id']}", headers=OCTO)
    assert r.status_code == 200, r.text
    ident = r.json()["identity"]
    assert ident and ident["member_role"] == "owner"
    return ident


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


# ---------- identity-bound pairing (trusted proxy lane) ----------


async def test_trusted_identity_is_auto_selected_no_choose_human(
    client, container, make_agent, trust_proxy, monkeypatch
):
    """A resolved member pairs as themselves even with several humans present —
    the multi-human 400 choose_human detour never fires for a trusted member."""
    monkeypatch.setenv("ORCHA_PAIRING_HOST", "192.168.1.24")
    ident = await _bind_owner(client, container, make_agent)
    await make_agent("Dana", "designer", kind="human")  # 2 humans, no login on Dana

    r = await client.get(f"/api/containers/{container['id']}/pairing", headers=OCTO)
    assert r.status_code == 200, r.text
    assert r.json()["humanAgentId"] == ident["agent_id"]
    assert r.json()["humanAgentAlias"] == "octocat"


async def test_trusted_mismatched_human_is_403_not_overridden(
    client, container, make_agent, trust_proxy, monkeypatch
):
    """Requesting the pairing payload FOR ANOTHER HUMAN under a trusted identity is
    refused outright — a phone is paired for yourself, never as someone else."""
    monkeypatch.setenv("ORCHA_PAIRING_HOST", "192.168.1.24")
    await _bind_owner(client, container, make_agent)
    dana = await make_agent("Dana", "designer", kind="human")

    r = await client.get(
        f"/api/containers/{container['id']}/pairing?human_agent_id={dana['agent_id']}",
        headers=OCTO,
    )
    assert r.status_code == 403, r.text
    assert "identity-bound" in r.text

    # ...while the member's OWN id stays accepted (idempotent with auto-selection)
    me = await client.get(f"/api/me?cid={container['id']}", headers=OCTO)
    own = me.json()["identity"]["agent_id"]
    ok = await client.get(
        f"/api/containers/{container['id']}/pairing?human_agent_id={own}",
        headers=OCTO,
    )
    assert ok.status_code == 200, ok.text
    assert ok.json()["humanAgentId"] == own


async def test_trusted_nonmember_cannot_pair(
    client, container, make_agent, trust_proxy, monkeypatch
):
    monkeypatch.setenv("ORCHA_PAIRING_HOST", "192.168.1.24")
    await _bind_owner(client, container, make_agent)  # container is mapped now

    r = await client.get(f"/api/containers/{container['id']}/pairing", headers=MALLORY)
    assert r.status_code == 403, r.text
    assert "not a member" in r.text


async def test_trust_off_keeps_selector_contract(
    client, container, make_agent, monkeypatch
):
    """Self-host (trust env unset): the header is ignored — multiple humans still
    answer 400 choose_human, and an explicit human_agent_id still selects."""
    monkeypatch.delenv("ORCHA_TRUST_PROXY_USER", raising=False)
    monkeypatch.setenv("ORCHA_PAIRING_HOST", "192.168.1.24")
    h1 = await make_agent("Kedar", "operator", kind="human")
    await make_agent("Dana", "designer", kind="human")

    r = await client.get(f"/api/containers/{container['id']}/pairing", headers=OCTO)
    assert r.status_code == 400, r.text
    assert r.json()["detail"]["reason"] == "choose_human"

    ok = await client.get(
        f"/api/containers/{container['id']}/pairing?human_agent_id={h1['agent_id']}",
        headers=OCTO,
    )
    assert ok.status_code == 200, ok.text
    assert ok.json()["humanAgentId"] == h1["agent_id"]


async def test_viewer_role_can_pair_a_phone(
    client, container, make_agent, trust_proxy, monkeypatch
):
    """Pairing stays READ-scoped under the access model: the viewer role may pair
    a phone to look around (write=False lane) — as themselves, like everyone."""
    monkeypatch.setenv("ORCHA_PAIRING_HOST", "192.168.1.24")
    await _bind_owner(client, container, make_agent)
    r = await client.post(
        f"/api/containers/{container['id']}/members",
        json={"github_login": "vera", "role": "viewer"},
        headers=OCTO,
    )
    assert r.status_code == 201, r.text
    vera_id = r.json()["agent_id"]

    r = await client.get(
        f"/api/containers/{container['id']}/pairing",
        headers={"X-Auth-Request-User": "vera"},
    )
    assert r.status_code == 200, r.text
    assert r.json()["humanAgentId"] == vera_id


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
    assert 'rx="22" fill="#0b1216"' in svg and "#1fc7cd" in svg, "embedded orca glyph"

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
