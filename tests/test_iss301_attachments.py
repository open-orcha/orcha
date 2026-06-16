"""#301 ATTACHMENTS — local project-folder file attachments on task-thread messages.

Covers the full path: multipart upload → on-disk storage → message persistence (path-only
JSONB refs, NO blobs) → read-back → byte-serving with the right Content-Disposition, plus the
security teeth (extension allowlist, path-traversal gate, JSONB-poisoning guard, size cap).

ATTACHMENTS_DIR is redirected to a per-test tmp dir so nothing touches /app/orcha-attachments.
"""
import io

import pytest
import pytest_asyncio

import main


@pytest_asyncio.fixture
async def att_dir(tmp_path, monkeypatch):
    d = tmp_path / "orcha-attachments"
    d.mkdir()
    monkeypatch.setattr(main, "ATTACHMENTS_DIR", d)
    return d


@pytest_asyncio.fixture
async def task(make_agent, make_task):
    await make_agent("dev", "eng")
    return await make_task("attach me", "done", assignee_alias="dev")


async def _upload(client, tid, filename, content, ctype="application/octet-stream"):
    return await client.post(
        f"/api/tasks/{tid}/attachments",
        files={"file": (filename, io.BytesIO(content), ctype)},
    )


# ---------------- upload ----------------

async def test_upload_image_returns_ref(client, task, att_dir):
    r = await _upload(client, task["task_id"], "diagram.png", b"\x89PNG\r\n\x1a\nfakepng")
    assert r.status_code == 201, r.text
    ref = r.json()
    assert ref["name"] == "diagram.png"
    assert ref["kind"] == "image"
    assert ref["content_type"] == "image/png"
    assert ref["size"] == len(b"\x89PNG\r\n\x1a\nfakepng")
    assert ref["url"] == f"/api/tasks/{task['task_id']}/attachments/{ref['id']}"
    # bytes actually landed on disk under the per-task subdir (no blob in DB)
    assert (att_dir / task["task_id"] / ref["id"]).read_bytes().startswith(b"\x89PNG")


async def test_upload_non_image_is_file_kind(client, task, att_dir):
    r = await _upload(client, task["task_id"], "notes.txt", b"hello world")
    assert r.status_code == 201, r.text
    assert r.json()["kind"] == "file"
    assert r.json()["content_type"].startswith("text/plain")


async def test_upload_rejects_unsupported_extension(client, task, att_dir):
    # SVG is deliberately OFF the allowlist (can carry inline script → XSS if served renderable).
    r = await _upload(client, task["task_id"], "evil.svg", b"<svg onload=alert(1)>")
    assert r.status_code == 400, r.text
    assert "unsupported" in r.json()["detail"].lower()


async def test_upload_rejects_empty_file(client, task, att_dir):
    r = await _upload(client, task["task_id"], "empty.txt", b"")
    assert r.status_code == 400, r.text


async def test_upload_enforces_size_cap(client, task, att_dir, monkeypatch):
    monkeypatch.setattr(main, "MAX_ATTACHMENT_BYTES", 8)
    r = await _upload(client, task["task_id"], "big.txt", b"way over the eight byte cap")
    assert r.status_code == 413, r.text
    # the partially-written temp file is cleaned up, not left orphaned
    assert list((att_dir / task["task_id"]).glob("*")) == []


async def test_upload_unknown_task_404(client, att_dir):
    r = await _upload(client, "00000000-0000-0000-0000-000000000000", "x.txt", b"hi")
    assert r.status_code == 404, r.text


# ---------------- message persistence + read-back ----------------

async def test_post_message_persists_and_reads_back_attachment(client, task, att_dir, make_agent):
    dev = (await make_agent("poster", "eng"))
    up = (await _upload(client, task["task_id"], "shot.png", b"\x89PNGdata")).json()
    r = await client.post(
        f"/api/tasks/{task['task_id']}/messages",
        json={"body": "see attached", "author_agent_id": dev["agent_id"],
              "attachments": [{"id": up["id"], "name": "shot.png"}]},
    )
    assert r.status_code == 201, r.text
    got = await client.get(f"/api/tasks/{task['task_id']}/messages")
    assert got.status_code == 200, got.text
    msgs = got.json()["messages"]
    assert len(msgs) == 1
    atts = msgs[0]["attachments"]
    assert len(atts) == 1
    assert atts[0]["id"] == up["id"]
    assert atts[0]["kind"] == "image"
    assert atts[0]["size"] == len(b"\x89PNGdata")
    assert atts[0]["url"].endswith(up["id"])


async def test_message_without_attachments_reads_empty_list(client, task, att_dir, make_agent):
    dev = (await make_agent("plainposter", "eng"))
    r = await client.post(
        f"/api/tasks/{task['task_id']}/messages",
        json={"body": "plain note", "author_agent_id": dev["agent_id"]},
    )
    assert r.status_code == 201, r.text
    msgs = (await client.get(f"/api/tasks/{task['task_id']}/messages")).json()["messages"]
    assert msgs[0]["attachments"] == []


async def test_post_rejects_fabricated_attachment_ref(client, task, att_dir, make_agent):
    # JSONB-poisoning guard: a ref whose file was never uploaded must 400 (not silently persist).
    dev = (await make_agent("forger", "eng"))
    r = await client.post(
        f"/api/tasks/{task['task_id']}/messages",
        json={"body": "fake", "author_agent_id": dev["agent_id"],
              "attachments": [{"id": "deadbeef_made_up.png", "name": "made_up.png"}]},
    )
    assert r.status_code == 400, r.text
    assert "not found" in r.json()["detail"].lower()


async def test_post_rejects_too_many_attachments(client, task, att_dir, make_agent):
    dev = (await make_agent("spammer", "eng"))
    up = (await _upload(client, task["task_id"], "a.txt", b"x")).json()
    refs = [{"id": up["id"], "name": "a.txt"} for _ in range(main.MAX_ATTACHMENTS_PER_MESSAGE + 1)]
    r = await client.post(
        f"/api/tasks/{task['task_id']}/messages",
        json={"body": "many", "author_agent_id": dev["agent_id"], "attachments": refs},
    )
    assert r.status_code == 400, r.text


# ---------------- serve ----------------

async def test_serve_image_inline_with_nosniff(client, task, att_dir):
    up = (await _upload(client, task["task_id"], "pic.png", b"\x89PNGbytes")).json()
    r = await client.get(up["url"])
    assert r.status_code == 200, r.text
    assert r.content == b"\x89PNGbytes"
    assert r.headers["content-type"].startswith("image/png")
    assert r.headers["content-disposition"].startswith("inline")
    assert r.headers["x-content-type-options"] == "nosniff"


async def test_serve_non_image_forces_download(client, task, att_dir):
    up = (await _upload(client, task["task_id"], "doc.txt", b"plain text")).json()
    r = await client.get(up["url"])
    assert r.status_code == 200, r.text
    # NEVER inline for non-images → no in-origin render
    assert r.headers["content-disposition"].startswith("attachment")
    assert 'filename="doc.txt"' in r.headers["content-disposition"]


async def test_serve_rejects_path_traversal(client, task, att_dir):
    # The stored-name regex gate (no '/', no '..') stops traversal before disk resolution.
    r = await client.get(f"/api/tasks/{task['task_id']}/attachments/..%2f..%2fmain.py")
    assert r.status_code in (400, 404), r.text


async def test_serve_unknown_name_404(client, task, att_dir):
    r = await client.get(f"/api/tasks/{task['task_id']}/attachments/abc123_missing.png")
    assert r.status_code == 404, r.text


async def test_serve_cross_task_isolation(client, att_dir, make_agent, make_task):
    # A file uploaded to task A is not reachable under task B's URL (parent-dir check).
    await make_agent("dev2", "eng")
    a = await make_task("task A", "done", assignee_alias="dev2")
    b = await make_task("task B", "done", assignee_alias="dev2")
    up = (await _upload(client, a["task_id"], "secret.txt", b"sekret")).json()
    r = await client.get(f"/api/tasks/{b['task_id']}/attachments/{up['id']}")
    assert r.status_code == 404, r.text
