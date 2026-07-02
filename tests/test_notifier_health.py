"""#103 — notifier health reporting + portal visibility.

Covers the daemon->portal heartbeat ingest, the health derivation surfaced in the container
snapshot (healthy | stale | offline), and the daemon-side _report_heartbeat helper.
"""
import uuid

from orcha_cli import notifier  # noqa: E402  (conftest puts orcha-cli on sys.path)


# ---------------------------------------------------------------- migration / ingest

async def test_notifier_state_table_exists(db):
    # migration 030 is applied by conftest's bootstrap → the table is queryable (empty).
    assert db.execute("SELECT * FROM notifier_state") == []


async def test_heartbeat_upserts_row(client, container, db):
    cid = container["id"]
    r = await client.post(f"/api/containers/{cid}/notifier/heartbeat",
                          json={"version": "0.3.0", "pid": 4242, "error": None})
    assert r.status_code == 200, r.text
    assert r.json() == {"container_id": cid, "ok": True}

    rows = db.execute("SELECT * FROM notifier_state WHERE container_id=%s", (cid,))
    assert len(rows) == 1
    row = rows[0]
    assert row["version"] == "0.3.0"
    assert row["pid"] == 4242
    assert row["last_error"] is None
    assert row["last_seen_at"] is not None


async def test_heartbeat_second_post_updates_same_row(client, container, db):
    cid = container["id"]
    await client.post(f"/api/containers/{cid}/notifier/heartbeat",
                      json={"version": "0.3.0", "pid": 1, "error": None})
    await client.post(f"/api/containers/{cid}/notifier/heartbeat",
                      json={"version": "0.4.0", "pid": 2, "error": "boom"})
    rows = db.execute("SELECT * FROM notifier_state WHERE container_id=%s", (cid,))
    assert len(rows) == 1, "singleton per container — second beat updates, not inserts"
    assert rows[0]["version"] == "0.4.0"
    assert rows[0]["pid"] == 2
    assert rows[0]["last_error"] == "boom"


async def test_heartbeat_bad_uuid_400(client):
    r = await client.post("/api/containers/not-a-uuid/notifier/heartbeat", json={})
    assert r.status_code == 400, r.text


async def test_heartbeat_unknown_container_404(client):
    r = await client.post(f"/api/containers/{uuid.uuid4()}/notifier/heartbeat", json={})
    assert r.status_code == 404, r.text


# ---------------------------------------------------------------- health in snapshot

async def _status(client, cid):
    snap = await client.get(f"/api/containers/{cid}")
    assert snap.status_code == 200, snap.text
    return snap.json()["container"]["notifier"]


async def test_snapshot_offline_when_never_seen(client, container):
    n = await _status(client, container["id"])
    assert n["status"] == "offline"
    assert n["last_seen_secs"] is None
    assert n["version"] is None


async def test_snapshot_healthy_right_after_beat(client, container):
    cid = container["id"]
    await client.post(f"/api/containers/{cid}/notifier/heartbeat",
                      json={"version": "0.3.0", "pid": 7, "error": None})
    n = await _status(client, cid)
    assert n["status"] == "healthy"
    assert n["version"] == "0.3.0"
    assert n["last_seen_secs"] is not None and n["last_seen_secs"] < notifier_healthy()


async def test_snapshot_stale_when_backdated(client, container, db):
    cid = container["id"]
    await client.post(f"/api/containers/{cid}/notifier/heartbeat", json={"version": "0.3.0"})
    # age between HEALTHY and STALE thresholds → stale
    db.execute("UPDATE notifier_state SET last_seen_at = now() - interval '40 seconds' "
               "WHERE container_id=%s", (cid,))
    n = await _status(client, cid)
    assert n["status"] == "stale", n


async def test_snapshot_offline_when_very_old(client, container, db):
    cid = container["id"]
    await client.post(f"/api/containers/{cid}/notifier/heartbeat", json={"version": "0.3.0"})
    db.execute("UPDATE notifier_state SET last_seen_at = now() - interval '200 seconds' "
               "WHERE container_id=%s", (cid,))
    n = await _status(client, cid)
    assert n["status"] == "offline", n


async def test_snapshot_surfaces_last_error(client, container):
    cid = container["id"]
    await client.post(f"/api/containers/{cid}/notifier/heartbeat",
                      json={"version": "0.3.0", "error": "tick blew up"})
    n = await _status(client, cid)
    assert n["last_error"] == "tick blew up"


def notifier_healthy():
    """Read the portal's healthy threshold so the assertion tracks the constant, not a literal."""
    import importlib
    main = importlib.import_module("main")
    return main.NOTIFIER_HEALTHY_SECS


# ---------------------------------------------------------------- daemon-side helper

def test_report_heartbeat_posts_expected_payload(monkeypatch):
    posts = []
    monkeypatch.setattr(notifier, "_post_json",
                        lambda url, body, **k: posts.append((url, body)) or {})
    notifier._report_heartbeat("http://api", "cid-123", error="oops")
    assert len(posts) == 1
    url, body = posts[0]
    assert url == "http://api/api/containers/cid-123/notifier/heartbeat"
    assert body["error"] == "oops"
    assert body["pid"] == __import__("os").getpid()
    assert "version" in body  # the orcha-cli version (or None if unavailable)


def test_report_heartbeat_swallows_errors(monkeypatch):
    def boom(url, body, **k):
        raise RuntimeError("network down")
    monkeypatch.setattr(notifier, "_post_json", boom)
    # must NOT raise — a failed beat can never destabilise the wake loop.
    notifier._report_heartbeat("http://api", "cid-123")
