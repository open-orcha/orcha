"""Plan usage snapshots (mig 069) — PUT/GET /api/plan-usage, GET /api/plan-usage/summary.

Contract under test (portal_backend/plan_usage_routes.py):
  * PUT upserts by host and returns the stored snapshot; GET lists newest first;
    /summary returns the newest only, or {"snapshot": null}.
  * STRICT Pydantic validation: provider in claude|codex, used_pct 0..100, <=10 windows,
    label <=40, headline <=80, plan <=30, host <=120 — and NO unknown fields at any level
    (the privacy rule: tokens / credentials / paths / emails cannot ride along).
  * Trust off: open. Trusted login: must be a member of some project; viewers cannot write.
  * Routes appear in /openapi.json.
"""
import copy
from datetime import datetime, timezone

import pytest


def _snap(host="Husseins-MacBook-Pro.local", captured_at="2026-10-02T13:20:00Z", pct=8):
    return {
        "host": host,
        "captured_at": captured_at,
        "providers": [
            {
                "provider": "claude", "plan": "Max", "headline": "5h resets in 3h 26m",
                "windows": [
                    {"key": "5h", "label": "5h", "used_pct": pct,
                     "resets_at": "2026-10-02T16:49:00-04:00"},
                    {"key": "wk", "label": "wk", "used_pct": 6,
                     "resets_at": "2026-10-06T10:00:00Z"},
                    {"key": "model:fable", "label": "Fable", "used_pct": 2,
                     "resets_at": "2026-10-06T10:00:00Z"},
                ],
                "today": {"tokens": 601000000, "cost_usd": 237.61},
            },
            {
                "provider": "codex", "plan": "Plus", "headline": "wk resets in 1d 1h",
                "windows": [{"key": "wk", "label": "wk", "used_pct": 34, "resets_at": None}],
                "today": None,
            },
        ],
    }


@pytest.fixture
def no_trust_proxy(monkeypatch):
    monkeypatch.delenv("ORCHA_TRUST_PROXY_USER", raising=False)


async def test_put_returns_stored_snapshot_and_get_lists_it(client, no_trust_proxy):
    r = await client.put("/api/plan-usage", json=_snap())
    assert r.status_code == 200, r.text
    out = r.json()
    assert out["host"] == "Husseins-MacBook-Pro.local"
    assert out["updated_at"]
    assert [p["provider"] for p in out["providers"]] == ["claude", "codex"]
    claude = out["providers"][0]
    assert claude["plan"] == "Max"
    assert [w["label"] for w in claude["windows"]] == ["5h", "wk", "Fable"]
    assert claude["today"] == {"tokens": 601000000, "cost_usd": 237.61}
    assert out["providers"][1]["today"] is None

    r = await client.get("/api/plan-usage")
    assert r.status_code == 200
    snaps = r.json()["snapshots"]
    assert len(snaps) == 1 and snaps[0]["providers"] == out["providers"]


async def test_upsert_by_host_replaces_not_duplicates(client, no_trust_proxy):
    await client.put("/api/plan-usage", json=_snap(pct=8))
    r = await client.put("/api/plan-usage",
                         json=_snap(captured_at="2026-10-02T13:25:00Z", pct=41))
    assert r.status_code == 200, r.text
    snaps = (await client.get("/api/plan-usage")).json()["snapshots"]
    assert len(snaps) == 1
    assert snaps[0]["providers"][0]["windows"][0]["used_pct"] == 41
    assert datetime.fromisoformat(snaps[0]["captured_at"].replace("Z", "+00:00")) == \
        datetime(2026, 10, 2, 13, 25, tzinfo=timezone.utc)


async def test_get_is_newest_first_and_summary_is_newest(client, no_trust_proxy):
    r = await client.get("/api/plan-usage/summary")
    assert r.status_code == 200 and r.json() == {"snapshot": None}
    assert (await client.get("/api/plan-usage")).json() == {"snapshots": []}

    await client.put("/api/plan-usage", json=_snap(host="old", captured_at="2026-10-01T10:00:00Z"))
    await client.put("/api/plan-usage", json=_snap(host="new", captured_at="2026-10-02T10:00:00Z"))
    snaps = (await client.get("/api/plan-usage")).json()["snapshots"]
    assert [s["host"] for s in snaps] == ["new", "old"]
    assert (await client.get("/api/plan-usage/summary")).json()["snapshot"]["host"] == "new"


def _mutate(path_fn):
    body = copy.deepcopy(_snap())
    path_fn(body)
    return body


@pytest.mark.parametrize("label,mutate", [
    ("bad provider", lambda b: b["providers"][0].update(provider="gemini")),
    ("pct > 100", lambda b: b["providers"][0]["windows"][0].update(used_pct=101)),
    ("pct < 0", lambda b: b["providers"][0]["windows"][0].update(used_pct=-1)),
    ("pct not number", lambda b: b["providers"][0]["windows"][0].update(used_pct="lots")),
    ("11 windows", lambda b: b["providers"][0].update(
        windows=[{"key": f"k{i}", "label": "x", "used_pct": 1} for i in range(11)])),
    ("label 41", lambda b: b["providers"][0]["windows"][0].update(label="x" * 41)),
    ("headline 81", lambda b: b["providers"][0].update(headline="x" * 81)),
    ("plan 31", lambda b: b["providers"][0].update(plan="x" * 31)),
    ("host 121", lambda b: b.update(host="h" * 121)),
    ("empty host", lambda b: b.update(host="")),
    ("bad captured_at", lambda b: b.update(captured_at="yesterday")),
    ("negative tokens", lambda b: b["providers"][0]["today"].update(tokens=-5)),
    # privacy: unknown fields are refused at every level, never stored
    ("token at top", lambda b: b.update(oauth_token="sk-ant-oat01-secret")),
    ("email in provider", lambda b: b["providers"][0].update(account_email="me@example.com")),
    ("path in window", lambda b: b["providers"][0]["windows"][0].update(path="/Users/me/.claude")),
    ("prompt in today", lambda b: b["providers"][0]["today"].update(prompt="hello")),
])
async def test_validation_rejects(client, no_trust_proxy, label, mutate):
    r = await client.put("/api/plan-usage", json=_mutate(mutate))
    # the portal's global field-length guard answers over-long strings with 413 before
    # Pydantic sees them; everything else is Pydantic's 422 — either way, nothing is stored
    assert r.status_code in (413, 422), f"{label}: {r.status_code} {r.text}"
    assert (await client.get("/api/plan-usage")).json() == {"snapshots": []}


async def test_validation_accepts_boundaries(client, no_trust_proxy):
    body = _mutate(lambda b: (
        b.update(host="h" * 120),
        b["providers"][0].update(
            plan="p" * 30, headline="x" * 80,
            windows=[{"key": f"k{i}", "label": "l" * 40, "used_pct": i * 10} for i in range(10)]),
    ))
    r = await client.put("/api/plan-usage", json=body)
    assert r.status_code == 200, r.text
    assert r.json()["providers"][0]["windows"][-1]["used_pct"] == 90


async def test_trusted_stranger_cannot_read_or_write(client, monkeypatch):
    monkeypatch.setenv("ORCHA_TRUST_PROXY_USER", "1")
    hdr = {"X-Auth-Request-User": "mallory"}
    assert (await client.put("/api/plan-usage", json=_snap(), headers=hdr)).status_code == 403
    assert (await client.get("/api/plan-usage", headers=hdr)).status_code == 403
    assert (await client.get("/api/plan-usage/summary", headers=hdr)).status_code == 403


async def test_routes_in_openapi(client):
    spec = (await client.get("/openapi.json")).json()
    assert "put" in spec["paths"]["/api/plan-usage"]
    assert "get" in spec["paths"]["/api/plan-usage"]
    assert "get" in spec["paths"]["/api/plan-usage/summary"]


# ---- display setting (mig 070) ------------------------------------------------------------


async def test_display_defaults_off_both(client, no_trust_proxy):
    r = await client.get("/api/plan-usage/display")
    assert r.status_code == 200, r.text
    assert r.json() == {"show": False, "providers": "both", "updated_at": None}


async def test_display_put_round_trips_and_upserts(client, no_trust_proxy):
    r = await client.put("/api/plan-usage/display", json={"show": True, "providers": "claude"})
    assert r.status_code == 200, r.text
    assert r.json()["show"] is True and r.json()["providers"] == "claude"
    assert r.json()["updated_at"]
    r = await client.put("/api/plan-usage/display", json={"show": False})
    assert r.json()["show"] is False and r.json()["providers"] == "both"
    got = (await client.get("/api/plan-usage/display")).json()
    assert got["show"] is False and got["providers"] == "both"


async def test_display_rejects_unknown_provider_and_extra_fields(client, no_trust_proxy):
    assert (await client.put("/api/plan-usage/display", json={"show": True, "providers": "gemini"})).status_code == 422
    assert (await client.put("/api/plan-usage/display", json={"show": True, "x": 1})).status_code == 422


async def test_display_routes_in_openapi(client, no_trust_proxy):
    spec = (await client.get("/openapi.json")).json()
    assert {"get", "put"} <= set(spec["paths"]["/api/plan-usage/display"])
