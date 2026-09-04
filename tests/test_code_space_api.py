"""Orcha Code Space Phase 1 (line-anchored threads) + Phase 3 (built-in symbol
provider) — portal_backend/code_space_routes.py.

Per the test-teeth convention, the ONLY thing stubbed is the network leaf
(`_gh_get`, monkeypatched on BOTH `github_repo_browse_routes` — the module whose
own functions like `_resolve_ref`/`_fetch_full_tree` call it internally — and
`code_space_routes` itself, since `code_space_routes` imports `_gh_get` by name
for its own `_fetch_source_file` leaf) plus the installation-token file read,
mirroring test_repo_browser_api.py's fixtures exactly. The routes, sha
resolution, membership gating, thread state machine, and the directed-request
wake path all run for real against the real test Postgres.

Snapshot (tarball) leaf: `github_repo_browse_routes._download_tarball_bytes` is a
SEPARATE network leaf from `_gh_get` (raw bytes, not JSON) — `_clear_caches` below
also autouse-stubs it to return None ("snapshot unavailable") for every test that
doesn't explicitly opt in, so every pre-existing symbol-indexing test keeps
exercising the SAME per-file fallback path it always has, deterministically, with
zero live network — never an incidental fast-401 race against real GitHub. Tests
that want the snapshot happy path call `_stub_tarball` themselves.
"""
import base64
import io
import tarfile
import uuid

import pytest

from portal_backend import code_space_routes as cs
from portal_backend import github_repo_browse_routes as browse


@pytest.fixture(autouse=True)
def _clear_caches(monkeypatch):
    """Every module-dict TTL cache this feature touches — reset around every test so
    one test's cached tree/symbols/snapshot never leaks into the next (mirrors
    test_repo_browser_api.py's _clear_caches). Also defaults the tarball leaf to
    "unavailable" (see module docstring) so no test accidentally depends on live
    network reachability."""
    browse._TREE_CACHE.clear()
    browse._DEFAULT_BRANCH_CACHE.clear()
    browse._REPO_SNAPSHOT_CACHE.clear()
    browse._REPO_SNAPSHOT_ORDER.clear()
    cs._SYMBOL_TREE_CACHE.clear()
    monkeypatch.setattr(browse, "_download_tarball_bytes", lambda *a, **k: None)
    yield
    browse._TREE_CACHE.clear()
    browse._DEFAULT_BRANCH_CACHE.clear()
    browse._REPO_SNAPSHOT_CACHE.clear()
    browse._REPO_SNAPSHOT_ORDER.clear()
    cs._SYMBOL_TREE_CACHE.clear()


@pytest.fixture
def token_env(monkeypatch, tmp_path):
    """Wire a legacy single installation-token file so _resolve_repo_token yields a
    token (the multi-org map is absent). Identical to the browse/hub tests' fixture."""
    token_file = tmp_path / "github-token"
    token_file.write_text("ghs_hubtoken\n")
    monkeypatch.setenv("ORCHA_GITHUB_TOKEN_FILE", str(token_file))
    monkeypatch.delenv("ORCHA_GITHUB_TOKENS_FILE", raising=False)
    return "ghs_hubtoken"


def _b64(text: str) -> str:
    return base64.b64encode(text.encode("utf-8")).decode("ascii")


async def _bind_repo(client, cid, repo="acme/site"):
    r = await client.put(f"/api/containers/{cid}/github", json={"repo": repo})
    assert r.status_code == 200, r.text


def _stub_gh(monkeypatch, fake):
    """Patch the network leaf on BOTH modules that hold their own bound reference."""
    monkeypatch.setattr(browse, "_gh_get", fake)
    monkeypatch.setattr(cs, "_gh_get", fake)


def _make_tarball(files: dict, top_prefix: str = "acme-site-abc1234") -> bytes:
    """Build a real in-memory gzip tarball (tarfile.open on BytesIO) with each
    `files` entry nested under `top_prefix/` — the same synthetic top-level directory
    shape GitHub's own tarball archives use. Returns the raw tarball bytes, exactly
    what `_download_tarball_bytes` would hand back on a real download."""
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w:gz") as tar:
        for path, content in files.items():
            data = content if isinstance(content, bytes) else content.encode("utf-8")
            info = tarfile.TarInfo(name=f"{top_prefix}/{path}")
            info.size = len(data)
            tar.addfile(info, io.BytesIO(data))
    return buf.getvalue()


def _stub_tarball(monkeypatch, files: dict, top_prefix: str = "acme-site-abc1234"):
    """Stub the tarball leaf to hand back a real extracted-from-bytes tarball for
    `files` — the snapshot happy path. Returns the raw bytes built, in case a test
    wants to assert on size."""
    tarball_bytes = _make_tarball(files, top_prefix=top_prefix)
    monkeypatch.setattr(browse, "_download_tarball_bytes", lambda *a, **k: tarball_bytes)
    return tarball_bytes


# ============================== Phase 1: threads ==============================

# --------------------------- create: sha resolution + anchor ------------------

async def test_create_thread_resolves_sha_and_persists_anchor(client, container, make_agent, token_env, monkeypatch):
    cid = container["id"]
    await _bind_repo(client, cid)
    # Human actor, no ai agent in the container at all — keeps this test's own
    # assertion (`tagged_agent_id is None`) about sha/anchor resolution, not
    # default-agent auto-routing (see test_default_routing_* below for that).
    author = await make_agent("Author", kind="human")

    def fake_get(path, token):
        if "/commits/" in path:
            return {"sha": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}
        if path == "/repos/acme/site":
            return {"default_branch": "main"}
        raise AssertionError(f"unexpected path {path}")

    _stub_gh(monkeypatch, fake_get)
    r = await client.post(
        f"/api/containers/{cid}/code/threads",
        json={
            "actor_agent_id": author["agent_id"],
            "path": "src/a.py",
            "start_line": 3,
            "end_line": 5,
            "kind": "question",
            "body": "how does this work?",
        },
    )
    assert r.status_code == 201, r.text
    body = r.json()
    assert body["repo"] == "acme/site"
    assert body["sha"] == "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"  # anchor pins to the COMMIT sha, never a branch name
    assert body["path"] == "src/a.py"
    assert body["start_line"] == 3 and body["end_line"] == 5
    assert body["kind"] == "question"
    assert body["status"] == "open"
    assert body["created_by_agent_id"] == author["agent_id"]
    assert body["tagged_agent_id"] is None
    assert body["request_id"] is None
    assert uuid.UUID(body["id"])


async def test_create_thread_explicit_ref_and_sha(client, container, make_agent, token_env, monkeypatch):
    cid = container["id"]
    await _bind_repo(client, cid)
    author = await make_agent("Author")

    def fake_get(path, token):
        if "/commits/" in path:
            return {"sha": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}
        raise AssertionError(f"unexpected path {path}")  # explicit sha never calls GitHub

    _stub_gh(monkeypatch, fake_get)
    r = await client.post(
        f"/api/containers/{cid}/code/threads",
        json={
            "actor_agent_id": author["agent_id"], "ref": "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
            "path": "a.py", "start_line": 1, "end_line": 1, "body": "note",
        },
    )
    assert r.status_code == 201, r.text
    assert r.json()["sha"] == "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef"
    assert r.json()["ref"] == "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef"


async def test_create_thread_invalid_lines_400(client, container, make_agent, token_env):
    cid = container["id"]
    await _bind_repo(client, cid)
    author = await make_agent("Author")
    r = await client.post(
        f"/api/containers/{cid}/code/threads",
        json={"actor_agent_id": author["agent_id"], "path": "a.py",
              "start_line": 5, "end_line": 2, "body": "x"},
    )
    assert r.status_code == 400


async def test_create_thread_repo_not_connected(client, container, make_agent):
    cid = container["id"]
    author = await make_agent("Author")
    r = await client.post(
        f"/api/containers/{cid}/code/threads",
        json={"actor_agent_id": author["agent_id"], "path": "a.py",
              "start_line": 1, "end_line": 1, "body": "x"},
    )
    assert r.status_code == 200
    assert r.json()["reason"] == "repo_not_connected"


async def test_create_thread_bad_actor_404(client, container, token_env, monkeypatch):
    cid = container["id"]
    await _bind_repo(client, cid)

    def fake_get(path, token):
        if "/commits/" in path:
            return {"sha": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}
        return {"default_branch": "main"}

    _stub_gh(monkeypatch, fake_get)
    r = await client.post(
        f"/api/containers/{cid}/code/threads",
        json={"actor_agent_id": str(uuid.uuid4()), "path": "a.py",
              "start_line": 1, "end_line": 1, "body": "x"},
    )
    assert r.status_code == 404


async def test_create_thread_actor_wrong_container_400(client, container, make_agent, token_env, monkeypatch):
    cid = container["id"]
    await _bind_repo(client, cid)

    def fake_get(path, token):
        if "/commits/" in path:
            return {"sha": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}
        return {"default_branch": "main"}

    _stub_gh(monkeypatch, fake_get)
    other_container_id = (await client.post("/api/containers", json={"name": "other", "additional": True})).json()["container_id"]
    outsider = await make_agent("Outsider", container_id=other_container_id)
    r = await client.post(
        f"/api/containers/{cid}/code/threads",
        json={"actor_agent_id": outsider["agent_id"], "path": "a.py",
              "start_line": 1, "end_line": 1, "body": "x"},
    )
    assert r.status_code == 400


# --------------------- tagged create -> directed request + wake ---------------

async def test_tagged_create_makes_directed_request_with_anchor_and_wakes(
    client, db, container, make_agent, token_env, monkeypatch
):
    cid = container["id"]
    await _bind_repo(client, cid)
    author = await make_agent("Author")
    tagged = await make_agent("Tagged")

    def fake_get(path, token):
        if "/commits/" in path:
            return {"sha": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}
        if path == "/repos/acme/site":
            return {"default_branch": "main"}
        raise AssertionError(f"unexpected path {path}")

    _stub_gh(monkeypatch, fake_get)
    r = await client.post(
        f"/api/containers/{cid}/code/threads",
        json={
            "actor_agent_id": author["agent_id"], "tagged_agent_id": tagged["agent_id"],
            "path": "src/a.py", "start_line": 10, "end_line": 12,
            "kind": "why", "body": "why did we do it this way?",
        },
    )
    assert r.status_code == 201, r.text
    thread = r.json()
    thread_id = thread["id"]
    assert thread["tagged_agent_id"] == tagged["agent_id"]
    request_id = thread["request_id"]
    assert request_id is not None

    # The underlying request itself carries the rendered anchor + question + the
    # literal reply instruction naming this thread's real id.
    req = await client.get(f"/api/requests/{request_id}")
    assert req.status_code == 200, req.text
    assert req.json()["target_id"] == tagged["agent_id"]
    assert req.json()["status"] == "open"

    payload_rows = db.execute("SELECT payload FROM requests WHERE id=%s", (request_id,))
    payload_text = payload_rows[0]["payload"]
    assert "src/a.py:10-12" in payload_text
    assert "why did we do it this way?" in payload_text
    assert f"POST /api/code/threads/{thread_id}/messages" in payload_text
    assert "actor_agent_id" in payload_text
    # Portal deep-link line: lets a human reading the request/conversation surface
    # jump straight to the thread in Code Space (the reverse direction — thread ->
    # request — is a clickable chip in ThreadView.tsx instead).
    assert f"view/reply in the portal: /code?path=src/a.py&thread={thread_id}" in payload_text

    # Wake fired: the SAME seam test_events_bus.py uses — an agent_events row with
    # event_name='request_created' keyed to the tagged agent.
    agent_rows = [r for r in db.event_rows(tagged["agent_id"]) if r["event_name"] == "request_created"]
    assert len(agent_rows) == 1
    assert agent_rows[0]["payload"]["request_id"] == request_id


async def test_wake_payload_deep_link_url_encodes_path(client, db, container, make_agent, token_env, monkeypatch):
    """A path with characters that need escaping (a space here) still produces a
    single well-formed deep-link query string."""
    cid = container["id"]
    await _bind_repo(client, cid)
    author = await make_agent("Author")
    tagged = await make_agent("Tagged")

    def fake_get(path, token):
        if "/commits/" in path:
            return {"sha": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}
        if path == "/repos/acme/site":
            return {"default_branch": "main"}
        raise AssertionError(f"unexpected path {path}")

    _stub_gh(monkeypatch, fake_get)
    r = await client.post(
        f"/api/containers/{cid}/code/threads",
        json={
            "actor_agent_id": author["agent_id"], "tagged_agent_id": tagged["agent_id"],
            "path": "src/my file.py", "start_line": 1, "end_line": 1,
            "kind": "note", "body": "note",
        },
    )
    assert r.status_code == 201, r.text
    thread_id = r.json()["id"]
    request_id = r.json()["request_id"]

    payload_rows = db.execute("SELECT payload FROM requests WHERE id=%s", (request_id,))
    payload_text = payload_rows[0]["payload"]
    assert f"view/reply in the portal: /code?path=src/my%20file.py&thread={thread_id}" in payload_text


async def test_untagged_create_makes_no_request(client, db, container, make_agent, token_env, monkeypatch):
    cid = container["id"]
    await _bind_repo(client, cid)
    author = await make_agent("Author")

    def fake_get(path, token):
        if "/commits/" in path:
            return {"sha": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}
        return {"default_branch": "main"}

    _stub_gh(monkeypatch, fake_get)
    r = await client.post(
        f"/api/containers/{cid}/code/threads",
        json={"actor_agent_id": author["agent_id"], "path": "a.py",
              "start_line": 1, "end_line": 1, "body": "just a note"},
    )
    assert r.status_code == 201, r.text
    assert r.json()["request_id"] is None
    assert not [x for x in db.event_rows(author["agent_id"]) if x["event_name"] == "request_created"]


# ------------------- default routing: untagged question -> default ai agent ---
#
# An untagged question-like thread (question | why | teach — NOT note) is a
# broken promise if nobody owns it. code_space_routes._default_ai_agent_id
# backfills tagged_agent_id to the container's default AI agent (first live
# kind='ai' agent by created_at — the lead/main convention, Atlas in practice)
# BEFORE the existing tagged branch runs, so these assert the exact same
# directed-request + wake side effects as the explicit-tag tests above.

async def test_default_routing_untagged_question_targets_default_ai_agent(
    client, db, container, make_agent, token_env, monkeypatch
):
    cid = container["id"]
    await _bind_repo(client, cid)
    human = await make_agent("Homer", kind="human")
    # Two live ai agents — created in order, so "lead" (first by created_at) is
    # unambiguous: Atlas, then Forge.
    lead = await make_agent("Atlas")
    await make_agent("Forge")

    def fake_get(path, token):
        if "/commits/" in path:
            return {"sha": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}
        return {"default_branch": "main"}

    _stub_gh(monkeypatch, fake_get)
    r = await client.post(
        f"/api/containers/{cid}/code/threads",
        json={
            "actor_agent_id": human["agent_id"], "path": "src/a.py",
            "start_line": 1, "end_line": 1, "kind": "question",
            "body": "how does this work?",
        },
    )
    assert r.status_code == 201, r.text
    thread = r.json()
    # Backfilled exactly as if the human had @tagged the lead agent.
    assert thread["tagged_agent_id"] == lead["agent_id"]
    request_id = thread["request_id"]
    assert request_id is not None

    req = await client.get(f"/api/requests/{request_id}")
    assert req.status_code == 200, req.text
    assert req.json()["target_id"] == lead["agent_id"]
    assert req.json()["status"] == "open"

    # Same wake rails as the explicit-tag path.
    agent_rows = [r for r in db.event_rows(lead["agent_id"]) if r["event_name"] == "request_created"]
    assert len(agent_rows) == 1
    assert agent_rows[0]["payload"]["request_id"] == request_id


async def test_default_routing_applies_to_why_and_teach_too(
    client, db, container, make_agent, token_env, monkeypatch
):
    cid = container["id"]
    await _bind_repo(client, cid)
    human = await make_agent("Homer", kind="human")
    lead = await make_agent("Atlas")

    def fake_get(path, token):
        if "/commits/" in path:
            return {"sha": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}
        return {"default_branch": "main"}

    _stub_gh(monkeypatch, fake_get)
    for kind in ("why", "teach"):
        r = await client.post(
            f"/api/containers/{cid}/code/threads",
            json={
                "actor_agent_id": human["agent_id"], "path": "src/a.py",
                "start_line": 1, "end_line": 1, "kind": kind,
                "body": f"{kind} body",
            },
        )
        assert r.status_code == 201, r.text
        assert r.json()["tagged_agent_id"] == lead["agent_id"]
        assert r.json()["request_id"] is not None


async def test_default_routing_untagged_note_stays_untargeted(
    client, db, container, make_agent, token_env, monkeypatch
):
    """`note` is deliberately excluded from auto-routing — a note is not a
    request for an answer, so it stays untargeted exactly like before this
    change, even though a default ai agent exists and could catch it."""
    cid = container["id"]
    await _bind_repo(client, cid)
    human = await make_agent("Homer", kind="human")
    await make_agent("Atlas")

    def fake_get(path, token):
        if "/commits/" in path:
            return {"sha": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}
        return {"default_branch": "main"}

    _stub_gh(monkeypatch, fake_get)
    r = await client.post(
        f"/api/containers/{cid}/code/threads",
        json={
            "actor_agent_id": human["agent_id"], "path": "src/a.py",
            "start_line": 1, "end_line": 1, "kind": "note",
            "body": "just a note",
        },
    )
    assert r.status_code == 201, r.text
    assert r.json()["tagged_agent_id"] is None
    assert r.json()["request_id"] is None


async def test_default_routing_no_ai_agent_keeps_untargeted(
    client, db, container, make_agent, token_env, monkeypatch
):
    """No live ai agent in the container at all -> unchanged pre-existing
    behavior (untargeted), even for a question-like kind."""
    cid = container["id"]
    await _bind_repo(client, cid)
    human = await make_agent("Homer", kind="human")

    def fake_get(path, token):
        if "/commits/" in path:
            return {"sha": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}
        return {"default_branch": "main"}

    _stub_gh(monkeypatch, fake_get)
    r = await client.post(
        f"/api/containers/{cid}/code/threads",
        json={
            "actor_agent_id": human["agent_id"], "path": "src/a.py",
            "start_line": 1, "end_line": 1, "kind": "question",
            "body": "how does this work?",
        },
    )
    assert r.status_code == 201, r.text
    assert r.json()["tagged_agent_id"] is None
    assert r.json()["request_id"] is None
    assert not [x for x in db.event_rows(human["agent_id"]) if x["event_name"] == "request_created"]


async def test_default_routing_terminated_ai_agent_not_picked(
    client, db, container, make_agent, token_env, monkeypatch
):
    """A terminated ai agent is not a valid default target — only a live
    (`terminated_at IS NULL`) one counts, mirroring find_orchestrator_agent /
    _live_ai_agents elsewhere in this codebase."""
    cid = container["id"]
    await _bind_repo(client, cid)
    human = await make_agent("Homer", kind="human")
    gone = await make_agent("Retired")
    live = await make_agent("Atlas")

    db.execute("UPDATE agents SET terminated_at=now() WHERE id=%s", (gone["agent_id"],))

    def fake_get(path, token):
        if "/commits/" in path:
            return {"sha": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}
        return {"default_branch": "main"}

    _stub_gh(monkeypatch, fake_get)
    r = await client.post(
        f"/api/containers/{cid}/code/threads",
        json={
            "actor_agent_id": human["agent_id"], "path": "src/a.py",
            "start_line": 1, "end_line": 1, "kind": "question",
            "body": "how does this work?",
        },
    )
    assert r.status_code == 201, r.text
    assert r.json()["tagged_agent_id"] == live["agent_id"]


# ------------------------------- reply flips status ---------------------------

async def test_tagged_agents_first_reply_flips_answered(client, container, make_agent, token_env, monkeypatch):
    cid = container["id"]
    await _bind_repo(client, cid)
    author = await make_agent("Author")
    tagged = await make_agent("Tagged")

    def fake_get(path, token):
        if "/commits/" in path:
            return {"sha": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}
        return {"default_branch": "main"}

    _stub_gh(monkeypatch, fake_get)
    created = (await client.post(
        f"/api/containers/{cid}/code/threads",
        json={"actor_agent_id": author["agent_id"], "tagged_agent_id": tagged["agent_id"],
              "path": "a.py", "start_line": 1, "end_line": 1, "body": "why?"},
    )).json()
    tid = created["id"]

    r = await client.post(
        f"/api/code/threads/{tid}/messages",
        json={"actor_agent_id": tagged["agent_id"], "body": "because of X"},
    )
    assert r.status_code == 201, r.text
    assert r.json()["status"] == "answered"


async def test_non_tagged_agent_reply_does_not_flip_status(client, container, make_agent, token_env, monkeypatch):
    cid = container["id"]
    await _bind_repo(client, cid)
    author = await make_agent("Author")
    tagged = await make_agent("Tagged")
    bystander = await make_agent("Bystander")

    def fake_get(path, token):
        if "/commits/" in path:
            return {"sha": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}
        return {"default_branch": "main"}

    _stub_gh(monkeypatch, fake_get)
    created = (await client.post(
        f"/api/containers/{cid}/code/threads",
        json={"actor_agent_id": author["agent_id"], "tagged_agent_id": tagged["agent_id"],
              "path": "a.py", "start_line": 1, "end_line": 1, "body": "why?"},
    )).json()
    tid = created["id"]

    r = await client.post(
        f"/api/code/threads/{tid}/messages",
        json={"actor_agent_id": bystander["agent_id"], "body": "I have thoughts too"},
    )
    assert r.status_code == 201, r.text
    assert r.json()["status"] == "open"


# ------------------------------------ resolve ----------------------------------

async def test_human_resolve_flips_resolved(client, container, make_agent, token_env, monkeypatch):
    cid = container["id"]
    await _bind_repo(client, cid)
    author = await make_agent("Author")
    human = await make_agent("Homer", kind="human")

    def fake_get(path, token):
        if "/commits/" in path:
            return {"sha": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}
        return {"default_branch": "main"}

    _stub_gh(monkeypatch, fake_get)
    created = (await client.post(
        f"/api/containers/{cid}/code/threads",
        json={"actor_agent_id": author["agent_id"], "path": "a.py",
              "start_line": 1, "end_line": 1, "body": "note"},
    )).json()
    tid = created["id"]

    r = await client.post(
        f"/api/code/threads/{tid}/messages",
        json={"actor_agent_id": human["agent_id"], "body": "looks good", "resolve": True},
    )
    assert r.status_code == 201, r.text
    assert r.json()["status"] == "resolved"


async def test_agent_cannot_resolve_403(client, container, make_agent, token_env, monkeypatch):
    cid = container["id"]
    await _bind_repo(client, cid)
    author = await make_agent("Author")

    def fake_get(path, token):
        if "/commits/" in path:
            return {"sha": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}
        return {"default_branch": "main"}

    _stub_gh(monkeypatch, fake_get)
    created = (await client.post(
        f"/api/containers/{cid}/code/threads",
        json={"actor_agent_id": author["agent_id"], "path": "a.py",
              "start_line": 1, "end_line": 1, "body": "note"},
    )).json()
    tid = created["id"]

    r = await client.post(
        f"/api/code/threads/{tid}/messages",
        json={"actor_agent_id": author["agent_id"], "body": "trying to resolve", "resolve": True},
    )
    assert r.status_code == 403


async def test_resolved_thread_rejects_further_messages(client, container, make_agent, token_env, monkeypatch):
    cid = container["id"]
    await _bind_repo(client, cid)
    author = await make_agent("Author")
    human = await make_agent("Homer", kind="human")

    def fake_get(path, token):
        if "/commits/" in path:
            return {"sha": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}
        return {"default_branch": "main"}

    _stub_gh(monkeypatch, fake_get)
    created = (await client.post(
        f"/api/containers/{cid}/code/threads",
        json={"actor_agent_id": author["agent_id"], "path": "a.py",
              "start_line": 1, "end_line": 1, "body": "note"},
    )).json()
    tid = created["id"]
    await client.post(
        f"/api/code/threads/{tid}/messages",
        json={"actor_agent_id": human["agent_id"], "body": "done", "resolve": True},
    )
    r = await client.post(
        f"/api/code/threads/{tid}/messages",
        json={"actor_agent_id": author["agent_id"], "body": "wait, one more thing"},
    )
    assert r.status_code == 409


# --------------------------------- get thread ----------------------------------

async def test_get_thread_returns_messages(client, container, make_agent, token_env, monkeypatch):
    cid = container["id"]
    await _bind_repo(client, cid)
    author = await make_agent("Author")

    def fake_get(path, token):
        if "/commits/" in path:
            return {"sha": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}
        return {"default_branch": "main"}

    _stub_gh(monkeypatch, fake_get)
    created = (await client.post(
        f"/api/containers/{cid}/code/threads",
        json={"actor_agent_id": author["agent_id"], "path": "a.py",
              "start_line": 1, "end_line": 1, "body": "the opening note"},
    )).json()
    tid = created["id"]
    await client.post(
        f"/api/code/threads/{tid}/messages",
        json={"actor_agent_id": author["agent_id"], "body": "a follow-up"},
    )
    r = await client.get(f"/api/code/threads/{tid}")
    assert r.status_code == 200, r.text
    body = r.json()
    assert len(body["messages"]) == 2
    assert body["messages"][0]["body"] == "the opening note"
    assert body["messages"][1]["body"] == "a follow-up"


async def test_get_thread_404(client):
    r = await client.get(f"/api/code/threads/{uuid.uuid4()}")
    assert r.status_code == 404


# ------------------------------ list: path filter + blob_match ------------------

async def test_list_by_path_returns_threads(client, container, make_agent, token_env, monkeypatch):
    cid = container["id"]
    await _bind_repo(client, cid)
    author = await make_agent("Author")

    def fake_get(path, token):
        if "/commits/" in path:
            return {"sha": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}
        return {"default_branch": "main"}

    _stub_gh(monkeypatch, fake_get)
    await client.post(
        f"/api/containers/{cid}/code/threads",
        json={"actor_agent_id": author["agent_id"], "path": "src/a.py",
              "start_line": 1, "end_line": 1, "body": "t1"},
    )
    await client.post(
        f"/api/containers/{cid}/code/threads",
        json={"actor_agent_id": author["agent_id"], "path": "src/b.py",
              "start_line": 1, "end_line": 1, "body": "t2"},
    )
    r = await client.get(
        f"/api/containers/{cid}/code/threads", params={"path": "src/a.py"})
    assert r.status_code == 200, r.text
    body = r.json()
    assert len(body["threads"]) == 1
    assert body["threads"][0]["path"] == "src/a.py"


async def test_list_without_path_returns_per_file_counts(client, container, make_agent, token_env, monkeypatch):
    cid = container["id"]
    await _bind_repo(client, cid)
    author = await make_agent("Author")

    def fake_get(path, token):
        if "/commits/" in path:
            return {"sha": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}
        return {"default_branch": "main"}

    _stub_gh(monkeypatch, fake_get)
    await client.post(
        f"/api/containers/{cid}/code/threads",
        json={"actor_agent_id": author["agent_id"], "path": "src/a.py",
              "start_line": 1, "end_line": 1, "body": "t1"},
    )
    await client.post(
        f"/api/containers/{cid}/code/threads",
        json={"actor_agent_id": author["agent_id"], "path": "src/a.py",
              "start_line": 2, "end_line": 2, "body": "t2"},
    )
    r = await client.get(f"/api/containers/{cid}/code/threads")
    assert r.status_code == 200, r.text
    by_path = {e["path"]: e for e in r.json()["by_path"]}
    assert by_path["src/a.py"]["count"] == 2
    assert by_path["src/a.py"]["open_count"] == 2


# ------------------------------ list: recent quick-jump -------------------------

async def test_list_recent_returns_newest_first_across_paths(client, container, make_agent, token_env, monkeypatch):
    cid = container["id"]
    await _bind_repo(client, cid)
    author = await make_agent("Author")

    def fake_get(path, token):
        if "/commits/" in path:
            return {"sha": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}
        return {"default_branch": "main"}

    _stub_gh(monkeypatch, fake_get)
    first = (await client.post(
        f"/api/containers/{cid}/code/threads",
        json={"actor_agent_id": author["agent_id"], "path": "src/a.py",
              "start_line": 1, "end_line": 1, "body": "oldest"},
    )).json()
    second = (await client.post(
        f"/api/containers/{cid}/code/threads",
        json={"actor_agent_id": author["agent_id"], "path": "src/b.py",
              "start_line": 5, "end_line": 5, "body": "newest"},
    )).json()

    r = await client.get(f"/api/containers/{cid}/code/threads", params={"recent": 10})
    assert r.status_code == 200, r.text
    body = r.json()
    ids = [t["id"] for t in body["threads"]]
    assert ids == [second["id"], first["id"]]  # newest-first
    assert {t["path"] for t in body["threads"]} == {"src/a.py", "src/b.py"}


async def test_list_recent_caps_at_50(client, container, make_agent, token_env, monkeypatch):
    cid = container["id"]
    await _bind_repo(client, cid)
    author = await make_agent("Author")

    def fake_get(path, token):
        if "/commits/" in path:
            return {"sha": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}
        return {"default_branch": "main"}

    _stub_gh(monkeypatch, fake_get)
    for i in range(55):
        await client.post(
            f"/api/containers/{cid}/code/threads",
            json={"actor_agent_id": author["agent_id"], "path": f"src/f{i}.py",
                  "start_line": 1, "end_line": 1, "body": f"t{i}"},
        )
    r = await client.get(f"/api/containers/{cid}/code/threads", params={"recent": 500})
    assert r.status_code == 200, r.text
    # a requested recent count above RECENT_THREADS_MAX (50) is silently capped, not rejected
    assert len(r.json()["threads"]) == cs.RECENT_THREADS_MAX


async def test_list_recent_default_n_when_recent_zero_falls_back_to_by_path(client, container, make_agent, token_env, monkeypatch):
    """recent=0 (the default / omitted) keeps the existing by_path counts behavior —
    it must not be misread as 'recent mode with n=0'."""
    cid = container["id"]
    await _bind_repo(client, cid)
    author = await make_agent("Author")

    def fake_get(path, token):
        if "/commits/" in path:
            return {"sha": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}
        return {"default_branch": "main"}

    _stub_gh(monkeypatch, fake_get)
    await client.post(
        f"/api/containers/{cid}/code/threads",
        json={"actor_agent_id": author["agent_id"], "path": "src/a.py",
              "start_line": 1, "end_line": 1, "body": "t1"},
    )
    r = await client.get(f"/api/containers/{cid}/code/threads")
    assert r.status_code == 200, r.text
    assert "by_path" in r.json()
    assert "threads" not in r.json()


async def test_list_recent_respects_status_filter(client, container, make_agent, token_env, monkeypatch):
    cid = container["id"]
    await _bind_repo(client, cid)
    author = await make_agent("Author")
    human = await make_agent("Homer", kind="human")

    def fake_get(path, token):
        if "/commits/" in path:
            return {"sha": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}
        return {"default_branch": "main"}

    _stub_gh(monkeypatch, fake_get)
    open_t = (await client.post(
        f"/api/containers/{cid}/code/threads",
        json={"actor_agent_id": author["agent_id"], "path": "src/a.py",
              "start_line": 1, "end_line": 1, "body": "still open"},
    )).json()
    resolved_t = (await client.post(
        f"/api/containers/{cid}/code/threads",
        json={"actor_agent_id": author["agent_id"], "path": "src/b.py",
              "start_line": 1, "end_line": 1, "body": "will resolve"},
    )).json()
    await client.post(
        f"/api/code/threads/{resolved_t['id']}/messages",
        json={"actor_agent_id": human["agent_id"], "body": "done", "resolve": True},
    )

    r = await client.get(f"/api/containers/{cid}/code/threads", params={"recent": 10, "status": "open"})
    assert r.status_code == 200, r.text
    ids = [t["id"] for t in r.json()["threads"]]
    assert ids == [open_t["id"]]


async def test_list_recent_trusted_non_member_403(client, container, make_agent, trust_proxy):
    cid = container["id"]
    await _bind_owner(client, container, make_agent)
    r = await client.get(f"/api/containers/{cid}/code/threads", params={"recent": 10}, headers=MALLORY)
    assert r.status_code == 403, r.text


async def test_list_status_filter(client, container, make_agent, token_env, monkeypatch):
    cid = container["id"]
    await _bind_repo(client, cid)
    author = await make_agent("Author")
    human = await make_agent("Homer", kind="human")

    def fake_get(path, token):
        if "/commits/" in path:
            return {"sha": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}
        return {"default_branch": "main"}

    _stub_gh(monkeypatch, fake_get)
    created = (await client.post(
        f"/api/containers/{cid}/code/threads",
        json={"actor_agent_id": author["agent_id"], "path": "a.py",
              "start_line": 1, "end_line": 1, "body": "note"},
    )).json()
    await client.post(
        f"/api/code/threads/{created['id']}/messages",
        json={"actor_agent_id": human["agent_id"], "body": "done", "resolve": True},
    )
    r = await client.get(
        f"/api/containers/{cid}/code/threads",
        params={"path": "a.py", "status": "resolved"})
    assert r.status_code == 200, r.text
    assert len(r.json()["threads"]) == 1
    r2 = await client.get(
        f"/api/containers/{cid}/code/threads",
        params={"path": "a.py", "status": "open"})
    assert r2.json()["threads"] == []


async def test_list_blob_match_true_when_unchanged(client, container, make_agent, token_env, monkeypatch):
    cid = container["id"]
    await _bind_repo(client, cid)
    author = await make_agent("Author")

    def fake_get(path, token):
        if "/commits/" in path:
            return {"sha": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}
        if path == "/repos/acme/site":
            return {"default_branch": "main"}
        if path in ("/repos/acme/site/git/trees/main?recursive=1",
                    "/repos/acme/site/git/trees/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa?recursive=1"):
            return {"tree": [{"path": "a.py", "type": "blob", "sha": "blobsha1"}], "truncated": False}
        raise AssertionError(path)

    _stub_gh(monkeypatch, fake_get)
    created = (await client.post(
        f"/api/containers/{cid}/code/threads",
        json={"actor_agent_id": author["agent_id"], "path": "a.py",
              "start_line": 1, "end_line": 1, "body": "note"},
    )).json()
    assert created["sha"] == "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"

    r = await client.get(f"/api/containers/{cid}/code/threads", params={"path": "a.py"})
    assert r.status_code == 200, r.text
    assert r.json()["threads"][0]["blob_match"] is True


async def test_list_blob_match_false_when_file_changed(client, container, make_agent, token_env, monkeypatch):
    """Pin a thread to an explicit historical sha ("oldsha") whose tree has ONE blob
    sha for a.py, then list against the default branch ("main"), whose tree — a later
    commit — has a DIFFERENT blob sha for the same path: blob_match must read False."""
    cid = container["id"]
    await _bind_repo(client, cid)
    author = await make_agent("Author")

    def fake_get(path, token):
        if "/commits/" in path:
            return {"sha": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}
        if path == "/repos/acme/site":
            return {"default_branch": "main"}
        if path in ("/repos/acme/site/git/trees/oldsha?recursive=1", "/repos/acme/site/git/trees/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa?recursive=1"):
            return {"tree": [{"path": "a.py", "type": "blob", "sha": "blobsha1"}], "truncated": False}
        if path == "/repos/acme/site/git/trees/main?recursive=1":
            return {"tree": [{"path": "a.py", "type": "blob", "sha": "blobsha2-CHANGED"}], "truncated": False}
        raise AssertionError(path)

    _stub_gh(monkeypatch, fake_get)
    created = (await client.post(
        f"/api/containers/{cid}/code/threads",
        json={"actor_agent_id": author["agent_id"], "ref": "oldsha", "path": "a.py",
              "start_line": 1, "end_line": 1, "body": "note"},
    )).json()
    assert created["sha"] == "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"

    r = await client.get(f"/api/containers/{cid}/code/threads", params={"path": "a.py", "ref": "main"})
    assert r.status_code == 200, r.text
    assert r.json()["threads"][0]["blob_match"] is False


async def test_list_blob_match_none_when_repo_not_connected(client, db, container, make_agent):
    cid = container["id"]
    author = await make_agent("Author")
    # No repo bound at all -> the create call itself degrades to not_connected, so
    # seed a thread row directly via SQL (the `db` fixture) to exercise the list
    # route's own repo-gone path.
    db.execute(
        """INSERT INTO code_threads
             (container_id, repo, ref, sha, path, start_line, end_line, kind,
              status, created_by_agent_id)
           VALUES (%s, 'acme/orphan', 'main', 'main', 'a.py', 1, 1, 'note', 'open', %s)""",
        (cid, author["agent_id"]),
    )
    r = await client.get(f"/api/containers/{cid}/code/threads", params={"path": "a.py"})
    assert r.status_code == 200, r.text
    assert r.json()["threads"][0]["blob_match"] is None


# ------------------------------- membership gate --------------------------------

MALLORY = {"X-Auth-Request-User": "mallory"}
OCTO = {"X-Auth-Request-User": "octocat"}


@pytest.fixture
def trust_proxy(monkeypatch):
    monkeypatch.setenv("ORCHA_TRUST_PROXY_USER", "1")


async def _bind_owner(client, container, make_agent):
    await make_agent("root", "operator", kind="human")
    r = await client.get(f"/api/me?cid={container['id']}", headers=OCTO)
    assert r.status_code == 200, r.text
    return r.json()["identity"]


async def test_list_threads_trusted_non_member_403(client, container, make_agent, trust_proxy):
    cid = container["id"]
    await _bind_owner(client, container, make_agent)
    r = await client.get(f"/api/containers/{cid}/code/threads", headers=MALLORY)
    assert r.status_code == 403, r.text


async def test_list_threads_trusted_member_ok(client, container, make_agent, trust_proxy):
    cid = container["id"]
    await _bind_owner(client, container, make_agent)
    r = await client.get(f"/api/containers/{cid}/code/threads", headers=OCTO)
    assert r.status_code == 200, r.text


async def test_get_thread_trusted_non_member_403(client, container, make_agent, trust_proxy, token_env, monkeypatch):
    cid = container["id"]
    await _bind_owner(client, container, make_agent)
    await _bind_repo(client, cid)
    author = await make_agent("Author")

    def fake_get(path, token):
        if "/commits/" in path:
            return {"sha": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}
        return {"default_branch": "main"}

    _stub_gh(monkeypatch, fake_get)
    created = (await client.post(
        f"/api/containers/{cid}/code/threads",
        json={"actor_agent_id": author["agent_id"], "path": "a.py",
              "start_line": 1, "end_line": 1, "body": "note"},
    )).json()
    r = await client.get(f"/api/code/threads/{created['id']}", headers=MALLORY)
    assert r.status_code == 403, r.text


async def test_create_thread_actor_not_found_gates_before_repo_check(client, container):
    """An agent-authored write is gated on actor validity independent of proxy trust —
    a bogus actor_agent_id is refused even with no proxy trust configured at all."""
    cid = container["id"]
    r = await client.post(
        f"/api/containers/{cid}/code/threads",
        json={"actor_agent_id": "not-a-uuid", "path": "a.py",
              "start_line": 1, "end_line": 1, "body": "x"},
    )
    assert r.status_code == 400


async def test_post_message_wrong_container_actor_400(client, container, make_agent, token_env, monkeypatch):
    cid = container["id"]
    await _bind_repo(client, cid)
    author = await make_agent("Author")

    def fake_get(path, token):
        if "/commits/" in path:
            return {"sha": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}
        return {"default_branch": "main"}

    _stub_gh(monkeypatch, fake_get)
    created = (await client.post(
        f"/api/containers/{cid}/code/threads",
        json={"actor_agent_id": author["agent_id"], "path": "a.py",
              "start_line": 1, "end_line": 1, "body": "note"},
    )).json()
    other_container_id = (await client.post("/api/containers", json={"name": "other", "additional": True})).json()["container_id"]
    outsider = await make_agent("Outsider", container_id=other_container_id)
    r = await client.post(
        f"/api/code/threads/{created['id']}/messages",
        json={"actor_agent_id": outsider["agent_id"], "body": "hi"},
    )
    assert r.status_code == 400


# ============================== Phase 3: symbols/outline ==============================

PY_SAMPLE = (
    "import os\n\n"
    "MAX_LEN = 10\n\n"
    "class Widget:\n"
    "    def render(self):\n"
    "        pass\n\n"
    "def build_widget(name):\n"
    "    return Widget()\n"
)

TS_SAMPLE = (
    "export interface Props {\n"
    "  name: string;\n"
    "}\n\n"
    "export class Button {\n"
    "  render() {}\n"
    "}\n\n"
    "export function makeButton(props: Props) {\n"
    "  return new Button();\n"
    "}\n\n"
    "export const helper = (x: number) => x + 1;\n\n"
    "export const LIMIT = 5;\n\n"
    "export type ButtonKind = 'primary' | 'secondary';\n"
)

KOTLIN_SAMPLE = (
    "package com.acme\n\n"
    "interface Renderer {\n"
    "    fun render()\n"
    "}\n\n"
    "class Widget : Renderer {\n"
    "    override fun render() {}\n"
    "}\n\n"
    "object Registry {\n"
    "    val items = listOf<String>()\n"
    "}\n\n"
    "fun buildWidget(): Widget = Widget()\n\n"
    "val MAX_ITEMS = 10\n"
    "var counter = 0\n"
)

SWIFT_SAMPLE = (
    "import Foundation\n\n"
    "protocol Renderable {\n"
    "    func render()\n"
    "}\n\n"
    "struct Widget: Renderable {\n"
    "    func render() {}\n"
    "}\n\n"
    "final class WidgetView {\n"
    "    func draw() {}\n"
    "}\n\n"
    "func buildWidget() -> Widget {\n"
    "    return Widget()\n"
    "}\n\n"
    "let maxItems = 10\n"
    "var counter = 0\n"
)

GO_SAMPLE = (
    "package main\n\n"
    "type Renderer interface {\n"
    "\tRender()\n"
    "}\n\n"
    "type Widget struct {\n"
    "\tName string\n"
    "}\n\n"
    "func (w *Widget) Render() {}\n\n"
    "func BuildWidget() *Widget {\n"
    "\treturn &Widget{}\n"
    "}\n\n"
    "const MaxItems = 10\n\n"
    "var counter = 0\n"
)


def _tree_with_files(files: dict) -> dict:
    """files: {path: content} -> a GitHub git/trees response with each blob's sha
    derived from its content (unique per distinct content, stable across calls)."""
    return {
        "tree": [
            {"path": path, "type": "blob", "sha": f"sha-{path}", "size": len(content.encode("utf-8"))}
            for path, content in files.items()
        ],
        "truncated": False,
    }


def _content_response(text: str) -> dict:
    return {"size": len(text.encode("utf-8")), "encoding": "base64", "content": _b64(text)}


async def test_outline_python_definitions_truth_table(client, container, token_env, monkeypatch):
    cid = container["id"]
    await _bind_repo(client, cid)

    def fake_get(path, token):
        if "/commits/" in path:
            return {"sha": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}
        if path == "/repos/acme/site":
            return {"default_branch": "main"}
        assert path.startswith("/repos/acme/site/contents/pkg/widget.py?ref=main")
        return _content_response(PY_SAMPLE)

    _stub_gh(monkeypatch, fake_get)
    r = await client.get(
        f"/api/containers/{cid}/code/outline", params={"path": "pkg/widget.py"})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["language"] == "python"
    by_name = {s["name"]: s["kind"] for s in body["symbols"]}
    assert by_name["MAX_LEN"] == "const"
    assert by_name["Widget"] == "class"
    assert by_name["render"] == "function"
    assert by_name["build_widget"] == "function"


async def test_outline_typescript_definitions_truth_table(client, container, token_env, monkeypatch):
    cid = container["id"]
    await _bind_repo(client, cid)

    def fake_get(path, token):
        if "/commits/" in path:
            return {"sha": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}
        if path == "/repos/acme/site":
            return {"default_branch": "main"}
        return _content_response(TS_SAMPLE)

    _stub_gh(monkeypatch, fake_get)
    r = await client.get(
        f"/api/containers/{cid}/code/outline", params={"path": "src/button.tsx"})
    assert r.status_code == 200, r.text
    by_name = {s["name"]: s["kind"] for s in r.json()["symbols"]}
    assert by_name["Props"] == "interface"
    assert by_name["Button"] == "class"
    assert by_name["makeButton"] == "function"
    assert by_name["helper"] == "function"
    assert by_name["LIMIT"] == "const"
    assert by_name["ButtonKind"] == "type"


async def test_outline_kotlin_definitions_truth_table(client, container, token_env, monkeypatch):
    cid = container["id"]
    await _bind_repo(client, cid)

    def fake_get(path, token):
        if "/commits/" in path:
            return {"sha": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}
        if path == "/repos/acme/site":
            return {"default_branch": "main"}
        return _content_response(KOTLIN_SAMPLE)

    _stub_gh(monkeypatch, fake_get)
    r = await client.get(
        f"/api/containers/{cid}/code/outline", params={"path": "src/Widget.kt"})
    assert r.status_code == 200, r.text
    by_name = {s["name"]: s["kind"] for s in r.json()["symbols"]}
    assert by_name["Renderer"] == "interface"
    assert by_name["Widget"] == "class"
    assert by_name["Registry"] == "class"
    assert by_name["buildWidget"] == "function"
    assert by_name["MAX_ITEMS"] == "const"
    assert by_name["counter"] == "var"


async def test_outline_swift_definitions_truth_table(client, container, token_env, monkeypatch):
    cid = container["id"]
    await _bind_repo(client, cid)

    def fake_get(path, token):
        if "/commits/" in path:
            return {"sha": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}
        if path == "/repos/acme/site":
            return {"default_branch": "main"}
        return _content_response(SWIFT_SAMPLE)

    _stub_gh(monkeypatch, fake_get)
    r = await client.get(
        f"/api/containers/{cid}/code/outline", params={"path": "Sources/Widget.swift"})
    assert r.status_code == 200, r.text
    by_name = {s["name"]: s["kind"] for s in r.json()["symbols"]}
    assert by_name["Renderable"] == "interface"
    assert by_name["Widget"] == "class"
    assert by_name["WidgetView"] == "class"
    assert by_name["buildWidget"] == "function"
    assert by_name["maxItems"] == "const"
    assert by_name["counter"] == "var"


async def test_outline_go_definitions_truth_table(client, container, token_env, monkeypatch):
    cid = container["id"]
    await _bind_repo(client, cid)

    def fake_get(path, token):
        if "/commits/" in path:
            return {"sha": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}
        if path == "/repos/acme/site":
            return {"default_branch": "main"}
        return _content_response(GO_SAMPLE)

    _stub_gh(monkeypatch, fake_get)
    r = await client.get(
        f"/api/containers/{cid}/code/outline", params={"path": "widget.go"})
    assert r.status_code == 200, r.text
    by_name = {s["name"]: s["kind"] for s in r.json()["symbols"]}
    assert by_name["Renderer"] == "interface"
    assert by_name["Widget"] == "class"
    assert by_name["Render"] == "function"
    assert by_name["BuildWidget"] == "function"
    assert by_name["MaxItems"] == "const"
    assert by_name["counter"] == "var"


async def test_outline_unsupported_extension_empty(client, container, token_env, monkeypatch):
    cid = container["id"]
    await _bind_repo(client, cid)

    def fake_get(path, token):
        if "/commits/" in path:
            return {"sha": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}
        return {"default_branch": "main"}

    _stub_gh(monkeypatch, fake_get)
    r = await client.get(
        f"/api/containers/{cid}/code/outline", params={"path": "README.md"})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["language"] is None
    assert body["symbols"] == []


async def test_outline_skips_oversized_file(client, container, token_env, monkeypatch):
    cid = container["id"]
    await _bind_repo(client, cid)
    huge = "x = 1\n" * (cs.MAX_SOURCE_FILE_BYTES // 6 + 100)

    def fake_get(path, token):
        if "/commits/" in path:
            return {"sha": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}
        if path == "/repos/acme/site":
            return {"default_branch": "main"}
        return _content_response(huge)

    _stub_gh(monkeypatch, fake_get)
    r = await client.get(
        f"/api/containers/{cid}/code/outline", params={"path": "big.py"})
    assert r.status_code == 200, r.text
    assert r.json()["symbols"] == []


async def test_outline_uncapped(client, container, token_env, monkeypatch):
    cid = container["id"]
    await _bind_repo(client, cid)
    many_defs = "".join(f"def fn_{i}():\n    pass\n\n" for i in range(300))

    def fake_get(path, token):
        if "/commits/" in path:
            return {"sha": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}
        if path == "/repos/acme/site":
            return {"default_branch": "main"}
        return _content_response(many_defs)

    _stub_gh(monkeypatch, fake_get)
    r = await client.get(
        f"/api/containers/{cid}/code/outline", params={"path": "many.py"})
    assert r.status_code == 200, r.text
    assert len(r.json()["symbols"]) == 300


# ------------------------------ symbols: search + cache -------------------------

async def test_symbols_search_across_files_and_query_filter(client, container, token_env, monkeypatch):
    cid = container["id"]
    await _bind_repo(client, cid)
    files = {"a.py": PY_SAMPLE, "b.py": "def other_helper():\n    pass\n"}

    def fake_get(path, token):
        if "/commits/" in path:
            return {"sha": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}
        if path == "/repos/acme/site":
            return {"default_branch": "main"}
        if path == "/repos/acme/site/git/trees/main?recursive=1":
            return _tree_with_files(files)
        for p, content in files.items():
            if path.startswith(f"/repos/acme/site/contents/{p}?ref=main"):
                return _content_response(content)
        raise AssertionError(path)

    _stub_gh(monkeypatch, fake_get)
    r = await client.get(f"/api/containers/{cid}/code/symbols", params={"q": "widget"})
    assert r.status_code == 200, r.text
    body = r.json()
    names = {s["name"] for s in body["results"]}
    assert "Widget" in names
    assert "build_widget" in names
    assert "other_helper" not in names
    assert all(s["path"] == "a.py" for s in body["results"])


async def test_symbols_search_empty_query_returns_everything_capped(client, container, token_env, monkeypatch):
    cid = container["id"]
    await _bind_repo(client, cid)
    many_defs = "".join(f"def fn_{i}():\n    pass\n\n" for i in range(300))
    files = {"many.py": many_defs}

    def fake_get(path, token):
        if "/commits/" in path:
            return {"sha": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}
        if path == "/repos/acme/site":
            return {"default_branch": "main"}
        if path == "/repos/acme/site/git/trees/main?recursive=1":
            return _tree_with_files(files)
        return _content_response(many_defs)

    _stub_gh(monkeypatch, fake_get)
    r = await client.get(f"/api/containers/{cid}/code/symbols")
    assert r.status_code == 200, r.text
    body = r.json()
    assert len(body["results"]) == cs.SYMBOL_SEARCH_MAX_RESULTS
    assert body["truncated"] is True


async def test_symbols_skips_non_source_and_oversized(client, container, token_env, monkeypatch):
    cid = container["id"]
    await _bind_repo(client, cid)
    huge = "x = 1\n" * (cs.MAX_SOURCE_FILE_BYTES // 6 + 100)
    calls = []

    def fake_get(path, token):
        if "/commits/" in path:
            return {"sha": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}
        calls.append(path)
        if path == "/repos/acme/site":
            return {"default_branch": "main"}
        if path == "/repos/acme/site/git/trees/main?recursive=1":
            return {
                "tree": [
                    {"path": "README.md", "type": "blob", "sha": "s1", "size": 10},
                    {"path": "huge.py", "type": "blob", "sha": "s2", "size": len(huge.encode("utf-8"))},
                    {"path": "small.py", "type": "blob", "sha": "s3", "size": 20},
                ],
                "truncated": False,
            }
        if path.startswith("/repos/acme/site/contents/small.py"):
            return _content_response("def tiny():\n    pass\n")
        raise AssertionError(f"should not fetch {path}")

    _stub_gh(monkeypatch, fake_get)
    r = await client.get(f"/api/containers/{cid}/code/symbols")
    assert r.status_code == 200, r.text
    names = {s["name"] for s in r.json()["results"]}
    assert names == {"tiny"}
    # README.md (non-source ext) and huge.py (>200KB) were never fetched.
    assert not any("README.md" in c or "huge.py" in c for c in calls)


async def test_symbols_cached_60s_per_cid_ref(client, container, token_env, monkeypatch):
    cid = container["id"]
    await _bind_repo(client, cid)
    tree_calls = {"n": 0}

    def fake_get(path, token):
        if "/commits/" in path:
            return {"sha": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}
        if path == "/repos/acme/site":
            return {"default_branch": "main"}
        if path == "/repos/acme/site/git/trees/main?recursive=1":
            tree_calls["n"] += 1
            return _tree_with_files({"a.py": "def foo():\n    pass\n"})
        return _content_response("def foo():\n    pass\n")

    _stub_gh(monkeypatch, fake_get)
    await client.get(f"/api/containers/{cid}/code/symbols", params={"q": "foo"})
    await client.get(f"/api/containers/{cid}/code/symbols", params={"q": "oo"})
    assert tree_calls["n"] == 1  # second query reused the cached index, no re-fetch

    base = cs.time.monotonic()
    # the warm INDEX state outlives the 60s tree cache by design (10 min —
    # re-indexing is the expensive part); expiry re-fetches the tree.
    monkeypatch.setattr(cs.time, "monotonic", lambda: base + cs.SYMBOL_STATE_TTL_SECONDS + 1)
    await client.get(f"/api/containers/{cid}/code/symbols", params={"q": "foo"})
    assert tree_calls["n"] == 2


# ------------------------- symbols: snapshot (tarball) fetch path -------------------

async def test_symbols_snapshot_indexes_whole_repo_in_one_request(client, container, token_env, monkeypatch):
    """The headline win: when a tarball snapshot is available, indexing completes
    SYNCHRONOUSLY within one request — indexing:false immediately, indexed==total, no
    polling — never touching `_fetch_source_file`'s per-file Contents-API leaf."""
    cid = container["id"]
    await _bind_repo(client, cid)
    files = {"a.py": PY_SAMPLE, "b.py": "def other_helper():\n    pass\n"}

    def fake_get(path, token):
        if "/commits/" in path:
            return {"sha": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}
        if path == "/repos/acme/site":
            return {"default_branch": "main"}
        if path == "/repos/acme/site/git/trees/main?recursive=1":
            return _tree_with_files(files)
        raise AssertionError(f"per-file fallback should not be used: {path}")

    _stub_gh(monkeypatch, fake_get)
    _stub_tarball(monkeypatch, files)

    r = await client.get(f"/api/containers/{cid}/code/symbols")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["indexing"] is False
    assert body["indexed"] == body["total"] == 2
    names = {s["name"] for s in body["results"]}
    assert {"Widget", "build_widget", "other_helper"} <= names


async def test_symbols_snapshot_strips_top_level_tarball_prefix(client, container, token_env, monkeypatch):
    """GitHub tarballs nest every file under a synthetic {owner}-{repo}-{sha}/ dir;
    the snapshot must strip it so extracted paths match the tree's repo-relative
    paths — otherwise every file in the snapshot dict would silently miss its lookup
    and indexing would find nothing despite a "successful" snapshot fetch."""
    cid = container["id"]
    await _bind_repo(client, cid)
    files = {"a.py": "def only_one():\n    pass\n"}

    def fake_get(path, token):
        if "/commits/" in path:
            return {"sha": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}
        if path == "/repos/acme/site":
            return {"default_branch": "main"}
        if path == "/repos/acme/site/git/trees/main?recursive=1":
            return _tree_with_files(files)
        raise AssertionError(f"unexpected _gh_get call: {path}")

    _stub_gh(monkeypatch, fake_get)
    # A distinctive, GitHub-shaped top-level dir — proves the strip isn't hardcoded to
    # the fixture's own default prefix.
    _stub_tarball(monkeypatch, files, top_prefix="acme-site-0123abcd")

    r = await client.get(f"/api/containers/{cid}/code/symbols")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["indexing"] is False
    assert {s["name"] for s in body["results"]} == {"only_one"}


async def test_symbols_snapshot_filters_traversal_members(client, container, token_env, monkeypatch):
    """A crafted/corrupt tarball member with a `../` escape or an absolute path must
    never be trusted into the snapshot dict — extraction silently DROPS it rather than
    raising, so a hostile member degrades to "this one file is missing" not a crash or
    a path collision. Built via a raw tarfile so the malicious member names bypass the
    test helper's normal prefix-joining."""
    cid = container["id"]
    await _bind_repo(client, cid)
    good_path = "a.py"
    good_content = b"def safe():\n    pass\n"

    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w:gz") as tar:
        # legitimate member
        info = tarfile.TarInfo(name=f"acme-site-abc1234/{good_path}")
        info.size = len(good_content)
        tar.addfile(info, io.BytesIO(good_content))
        # traversal escape
        evil = b"pwned"
        info2 = tarfile.TarInfo(name="acme-site-abc1234/../../etc/evil.py")
        info2.size = len(evil)
        tar.addfile(info2, io.BytesIO(evil))
        # absolute path
        info3 = tarfile.TarInfo(name="/etc/evil2.py")
        info3.size = len(evil)
        tar.addfile(info3, io.BytesIO(evil))
    tarball_bytes = buf.getvalue()
    monkeypatch.setattr(browse, "_download_tarball_bytes", lambda *a, **k: tarball_bytes)

    files = {good_path: good_content.decode("utf-8")}

    def fake_get(path, token):
        if "/commits/" in path:
            return {"sha": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}
        if path == "/repos/acme/site":
            return {"default_branch": "main"}
        if path == "/repos/acme/site/git/trees/main?recursive=1":
            return _tree_with_files(files)
        raise AssertionError(f"unexpected _gh_get call: {path}")

    _stub_gh(monkeypatch, fake_get)

    r = await client.get(f"/api/containers/{cid}/code/symbols")
    assert r.status_code == 200, r.text
    body = r.json()
    assert {s["name"] for s in body["results"]} == {"safe"}

    # Direct unit check on the extraction helper: neither evil member ever appears as
    # an extracted key, under ANY name (not "etc/evil.py", not "evil2.py", nothing) —
    # proving they were dropped during extraction, not merely unreachable via the API.
    snapshot = browse._extract_source_files(tarball_bytes, (".py",), cs.MAX_SOURCE_FILE_BYTES)
    assert snapshot == {good_path: good_content}


async def test_symbols_snapshot_oversize_tarball_falls_back_to_per_file(client, container, token_env, monkeypatch):
    """A tarball download that exceeds REPO_SNAPSHOT_MAX_BYTES must fall back to the
    existing budgeted per-file path — never partially cache, never error the request."""
    cid = container["id"]
    await _bind_repo(client, cid)
    files = {"a.py": "def via_fallback():\n    pass\n"}

    def fake_get(path, token):
        if "/commits/" in path:
            return {"sha": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}
        if path == "/repos/acme/site":
            return {"default_branch": "main"}
        if path == "/repos/acme/site/git/trees/main?recursive=1":
            return _tree_with_files(files)
        if path.startswith("/repos/acme/site/contents/a.py"):
            return _content_response(files["a.py"])
        raise AssertionError(f"unexpected _gh_get call: {path}")

    _stub_gh(monkeypatch, fake_get)
    # _download_tarball_bytes itself returns None once the streamed download exceeds
    # the cap (see its own docstring) — simulate that directly rather than actually
    # streaming 80MB in a test.
    monkeypatch.setattr(browse, "_download_tarball_bytes", lambda *a, **k: None)

    r = await client.get(f"/api/containers/{cid}/code/symbols")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["indexing"] is False
    assert {s["name"] for s in body["results"]} == {"via_fallback"}
    # No snapshot was ever cached for this (cid, ref) — the size-cap path never
    # partially caches.
    assert browse._repo_snapshot_cache_get(cid, "main") is None


async def test_symbols_snapshot_download_error_falls_back_to_per_file(client, container, token_env, monkeypatch):
    """A genuine GitHub/network failure fetching the tarball (rate limit, timeout) must
    not fail the whole request — it degrades to the per-file fallback exactly like a
    missing/oversize snapshot does."""
    cid = container["id"]
    await _bind_repo(client, cid)
    files = {"a.py": "def via_fallback():\n    pass\n"}

    def fake_get(path, token):
        if "/commits/" in path:
            return {"sha": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}
        if path == "/repos/acme/site":
            return {"default_branch": "main"}
        if path == "/repos/acme/site/git/trees/main?recursive=1":
            return _tree_with_files(files)
        if path.startswith("/repos/acme/site/contents/a.py"):
            return _content_response(files["a.py"])
        raise AssertionError(f"unexpected _gh_get call: {path}")

    _stub_gh(monkeypatch, fake_get)

    def raise_status(*a, **k):
        raise RuntimeError("github_status:403")

    monkeypatch.setattr(browse, "_download_tarball_bytes", raise_status)

    r = await client.get(f"/api/containers/{cid}/code/symbols")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["available"] is True
    assert {s["name"] for s in body["results"]} == {"via_fallback"}


async def test_repo_snapshot_cache_evicts_oldest_beyond_bound(client, container, token_env, monkeypatch):
    """At most REPO_SNAPSHOT_MAX_CACHED (2) snapshots are held at once — a third
    distinct ref must evict the FIRST (oldest-inserted), not the second."""
    cid = container["id"]
    await _bind_repo(client, cid)

    def make_fake_get(ref_sha):
        def fake_get(path, token):
            if "/commits/" in path:
                return {"sha": ref_sha}
            if path == "/repos/acme/site":
                return {"default_branch": "main"}
            if path.endswith("/recursive=1") or "git/trees" in path:
                return _tree_with_files({"a.py": "def fn():\n    pass\n"})
            raise AssertionError(f"unexpected _gh_get call: {path}")
        return fake_get

    refs = [
        "1111111111111111111111111111111111111a",
        "2222222222222222222222222222222222222b",
        "3333333333333333333333333333333333333c",
    ]
    for ref_sha in refs:
        monkeypatch.setattr(browse, "_gh_get", make_fake_get(ref_sha))
        monkeypatch.setattr(cs, "_gh_get", make_fake_get(ref_sha))
        _stub_tarball(monkeypatch, {"a.py": "def fn():\n    pass\n"})
        r = await client.get(f"/api/containers/{cid}/code/symbols", params={"ref": ref_sha})
        assert r.status_code == 200, r.text

    assert browse._repo_snapshot_cache_get(cid, refs[0]) is None  # evicted
    assert browse._repo_snapshot_cache_get(cid, refs[1]) is not None
    assert browse._repo_snapshot_cache_get(cid, refs[2]) is not None
    assert len(browse._REPO_SNAPSHOT_ORDER) == browse.REPO_SNAPSHOT_MAX_CACHED


async def test_symbols_repo_not_connected(client, container):
    cid = container["id"]
    r = await client.get(f"/api/containers/{cid}/code/symbols")
    assert r.status_code == 200
    assert r.json()["reason"] == "repo_not_connected"


async def test_symbols_trusted_non_member_403(client, container, make_agent, trust_proxy):
    cid = container["id"]
    await _bind_owner(client, container, make_agent)
    r = await client.get(f"/api/containers/{cid}/code/symbols", headers=MALLORY)
    assert r.status_code == 403, r.text


async def test_outline_trusted_non_member_403(client, container, make_agent, trust_proxy):
    cid = container["id"]
    await _bind_owner(client, container, make_agent)
    r = await client.get(
        f"/api/containers/{cid}/code/outline", params={"path": "a.py"}, headers=MALLORY)
    assert r.status_code == 403, r.text
