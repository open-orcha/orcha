"""File previews — file_raw_routes.py / file_preview.py: raw bytes for the code viewer
(at a ref), the Code tab's working tree (HEAD vs disk) and a run's changes (live
checkout, or rebuilt from the CAPTURED diff's `GIT binary patch` / blob ids).

Real git throughout (the test-teeth convention): temp repos, real `git diff --binary`.
Run with ORCHA_TEST_DB_NAME=orcha_test_file_raw.
"""
import subprocess

import pytest

from portal_backend import file_preview as fp
from portal_backend import run_changes_routes as rc

PNG_A = b"\x89PNG\r\n\x1a\n" + bytes(range(256)) * 8
PNG_B = b"\x89PNG\r\n\x1a\n" + bytes(reversed(range(256))) * 9
JPG = b"\xff\xd8\xff\xe0" + bytes(range(200)) * 5
JPG2 = b"\xff\xd8\xff\xe1" + bytes(reversed(range(256))) * 3
PDF = b"%PDF-1.4\n" + b"1 0 obj\n<<>>\nendobj\n" * 20
MP4 = b"\x00\x00\x00\x18ftypisom" + b"\x00" * 64
ZIP = b"PK\x03\x04" + b"\x00\x01" * 40
SVG = b'<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'

OCTO = {"X-Auth-Request-User": "octocat"}
MALLORY = {"X-Auth-Request-User": "mallory"}


def _git(cwd, *args):
    return subprocess.run(["git", "-C", str(cwd), *args], check=True, capture_output=True).stdout


@pytest.fixture(autouse=True)
def _clear(monkeypatch):
    rc._CACHE.clear()
    monkeypatch.delenv("ORCHA_HOST_PROJECT_DIR", raising=False)
    from portal_backend import github_repo_browse_routes as browse
    browse._LOCAL_REF_CACHE.clear()
    yield
    rc._CACHE.clear()


@pytest.fixture
def repo(tmp_path, monkeypatch):
    r = tmp_path / "repo"
    r.mkdir()
    _git(r, "init", "-q", "-b", "main")
    _git(r, "config", "user.email", "t@example.com")
    _git(r, "config", "user.name", "T")
    (r / "img").mkdir()
    (r / "img" / "a.png").write_bytes(PNG_A)
    (r / "icon.svg").write_bytes(SVG)
    (r / "page.html").write_text("<script>alert(1)</script>")
    (r / "old.jpg").write_bytes(JPG)
    _git(r, "add", "-A")
    _git(r, "commit", "-q", "-m", "init")
    monkeypatch.setenv("ORCHA_LOCAL_REPO_DIR", str(r))
    return r


async def _bind_local(client, cid):
    r = await client.put(f"/api/containers/{cid}/github", json={"repo": "local"})
    assert r.status_code == 200, r.text


# ------------------------------------------------------------------ unit: types + patches

def test_content_type_by_extension_confirmed_by_bytes():
    assert fp.content_type_for("a.png", PNG_A) == "image/png"
    assert fp.content_type_for("a.png", b"<html>") == "application/octet-stream"  # lying extension
    assert fp.content_type_for("a.jpg", JPG) == "image/jpeg"
    assert fp.content_type_for("a.pdf", PDF) == "application/pdf"
    assert fp.content_type_for("a.mp4", MP4) == "video/mp4"
    assert fp.content_type_for("blob", PNG_A) == "image/png"  # unknown ext → sniff
    assert fp.content_type_for("a.zip", ZIP) == "application/zip"
    assert fp.content_type_for("page.html", b"<script>x</script>") == "text/plain; charset=utf-8"
    assert fp.content_type_for("data.bin", b"\x00\x01\x02") == "application/octet-stream"
    assert fp.content_type_for("i.svg", SVG) == "image/svg+xml"


def _binary_diff(tmp_path, before: dict, after: dict) -> tuple:
    r = tmp_path / "pr"
    r.mkdir()
    _git(r, "init", "-q", "-b", "main")
    for name, data in before.items():
        (r / name).write_bytes(data)
    _git(r, "add", "-A")
    _git(r, "-c", "user.email=t@e", "-c", "user.name=T", "commit", "-q", "-m", "a", "--allow-empty")
    for name, data in after.items():
        if data is None:
            (r / name).unlink()
        else:
            (r / name).write_bytes(data)
    _git(r, "add", "-A")
    return r, _git(r, "diff", "--cached", "--binary", "--full-index").decode()


def _section(diff, path):
    return next(s["text"] for s in rc._split_patch(diff) if s["path"] == path)


def test_binary_patch_rebuilds_both_sides_literal_and_delta(tmp_path):
    big = bytes(range(256)) * 200
    big2 = bytearray(big)
    big2[1000:1010] = b"x" * 10
    repo, diff = _binary_diff(tmp_path, {"m.png": PNG_A, "d.bin": big, "gone.jpg": JPG},
                              {"m.png": PNG_B, "d.bin": bytes(big2), "gone.jpg": None, "n.jpg": JPG2})
    none = lambda oid: None  # noqa: E731
    assert fp.blob_from_section(_section(diff, "n.jpg"), "new", none) == JPG2
    assert fp.blob_from_section(_section(diff, "n.jpg"), "old", none) is None  # added: no old side
    assert fp.blob_from_section(_section(diff, "gone.jpg"), "old", none) == JPG
    assert fp.blob_from_section(_section(diff, "gone.jpg"), "new", none) is None
    assert fp.blob_from_section(_section(diff, "m.png"), "new", none) == PNG_B
    assert fp.blob_from_section(_section(diff, "m.png"), "old", none) == PNG_A
    # a tiny edit to a big file is written as DELTA hunks: rebuilt against the blob by id
    sec = _section(diff, "d.bin")
    assert "\ndelta " in sec
    store = lambda oid: subprocess.run(["git", "-C", str(repo), "cat-file", "blob", oid],  # noqa: E731
                                       capture_output=True).stdout or None
    assert fp.blob_from_section(sec, "old", store) == big
    assert fp.blob_from_section(sec, "new", store) == bytes(big2)


# ------------------------------------------------------------------ code viewer (ref)

async def test_browse_raw_types_headers_and_traversal(client, container, repo):
    cid = container["id"]
    await _bind_local(client, cid)
    url = f"/api/containers/{cid}/github/browse/raw"
    r = await client.get(url, params={"path": "img/a.png"})
    assert r.status_code == 200, r.text
    assert r.content == PNG_A
    assert r.headers["content-type"] == "image/png"
    assert r.headers["x-content-type-options"] == "nosniff"
    assert r.headers["content-disposition"].startswith("inline;")
    assert "sandbox" in r.headers["content-security-policy"]
    assert r.headers["x-orcha-size"] == str(len(PNG_A))

    d = await client.get(url, params={"path": "img/a.png", "download": "1"})
    assert d.headers["content-disposition"].startswith("attachment;")

    # SVG is an image type but never an inline document on the portal origin
    s = await client.get(url, params={"path": "icon.svg"})
    assert s.headers["content-type"] == "image/svg+xml"
    assert s.headers["content-disposition"].startswith("attachment;")
    assert "sandbox" in s.headers["content-security-policy"]
    # HTML is served as inert text
    h = await client.get(url, params={"path": "page.html"})
    assert h.headers["content-type"].startswith("text/plain")

    # a ref pins the version
    (repo / "img" / "a.png").write_bytes(PNG_B)
    _git(repo, "commit", "-qam", "b")
    from portal_backend import github_repo_browse_routes as browse
    browse._LOCAL_REF_CACHE.clear()
    assert (await client.get(url, params={"path": "img/a.png", "ref": "HEAD~1"})).content == PNG_A
    assert (await client.get(url, params={"path": "img/a.png"})).content == PNG_B

    for bad in ("../etc/passwd", "/etc/passwd", "-x", "img/../../x"):
        assert (await client.get(url, params={"path": bad})).status_code == 400, bad
    assert (await client.get(url, params={"path": "nope.png"})).status_code == 404
    assert (await client.get(url, params={"path": "img"})).status_code == 404  # a tree is not a file


async def test_range_request_for_media(client, container, repo):
    cid = container["id"]
    await _bind_local(client, cid)
    r = await client.get(f"/api/containers/{cid}/github/browse/raw", params={"path": "img/a.png"},
                         headers={"Range": "bytes=0-7"})
    assert r.status_code == 206
    assert r.content == PNG_A[:8]
    assert r.headers["content-range"] == f"bytes 0-7/{len(PNG_A)}"


async def test_raw_routes_permissions_match_code_reads(client, container, make_agent, repo, monkeypatch):
    monkeypatch.setenv("ORCHA_PLAN", "team")
    monkeypatch.setenv("ORCHA_TRUST_PROXY_USER", "1")
    cid = container["id"]
    await make_agent("root", "operator", kind="human")
    assert (await client.get(f"/api/me?cid={cid}", headers=OCTO)).json()["identity"]["member_role"] == "owner"
    r = await client.put(f"/api/containers/{cid}/github", json={"repo": "local"}, headers=OCTO)
    assert r.status_code == 200, r.text
    for url, params in (
        (f"/api/containers/{cid}/github/browse/raw", {"path": "img/a.png"}),
        (f"/api/containers/{cid}/code/worktree/raw", {"path": "img/a.png"}),
    ):
        text_url = url.replace("/raw", "/file")
        assert (await client.get(url, params=params, headers=OCTO)).status_code == 200
        assert (await client.get(url, params=params, headers=MALLORY)).status_code == 403
        assert (await client.get(text_url, params=params, headers=MALLORY)).status_code == 403
    assert (await client.get("/api/containers/not-a-uuid/github/browse/raw", params={"path": "a"})).status_code == 400


# ------------------------------------------------------------------ Code tab working tree

async def test_worktree_raw_head_vs_working(client, container, repo):
    cid = container["id"]
    await _bind_local(client, cid)
    (repo / "img" / "a.png").write_bytes(PNG_B)
    (repo / "new.pdf").write_bytes(PDF)
    url = f"/api/containers/{cid}/code/worktree/raw"
    assert (await client.get(url, params={"path": "img/a.png", "side": "head"})).content == PNG_A
    assert (await client.get(url, params={"path": "img/a.png"})).content == PNG_B
    p = await client.get(url, params={"path": "new.pdf"})
    assert p.headers["content-type"] == "application/pdf" and p.headers["content-disposition"].startswith("inline")
    assert "content-security-policy" not in p.headers  # the built-in PDF viewer refuses sandboxed docs
    assert (await client.get(url, params={"path": "new.pdf", "side": "head"})).status_code == 404
    assert (await client.get(url, params={"path": "a", "side": "bogus"})).status_code == 422
    # a symlink out of the checkout is refused
    (repo / "escape").symlink_to("/etc")
    assert (await client.get(url, params={"path": "escape/hosts"})).status_code == 400


# ------------------------------------------------------------------ a run's changes

async def _start(client, aid, **body):
    r = await client.post(f"/api/agents/{aid}/runs", json={"wake_kind": "ephemeral", **body})
    assert r.status_code == 201, r.text
    return r.json()["run_id"]


async def test_live_run_raw_old_and_new(client, make_agent, repo):
    a = await make_agent("Atlas", "eng")
    aid = a["agent_id"]
    rid = await _start(client, aid, base_cwd=str(repo))
    (repo / "img" / "a.png").write_bytes(PNG_B)
    (repo / "clip.mp4").write_bytes(MP4)
    (repo / "old.jpg").unlink()
    url = f"/api/agents/{aid}/runs/{rid}/changes/raw"
    assert (await client.get(url, params={"path": "img/a.png", "side": "old"})).content == PNG_A
    assert (await client.get(url, params={"path": "img/a.png", "side": "new"})).content == PNG_B
    v = await client.get(url, params={"path": "clip.mp4"})
    assert v.headers["content-type"] == "video/mp4" and v.content == MP4
    assert (await client.get(url, params={"path": "clip.mp4", "side": "old"})).status_code == 404
    assert (await client.get(url, params={"path": "old.jpg", "side": "old"})).content == JPG
    assert (await client.get(url, params={"path": "old.jpg", "side": "new"})).status_code == 404
    assert (await client.get(url, params={"path": "README.md"})).status_code == 404  # not changed
    assert (await client.get(url, params={"path": "../x"})).status_code == 400


async def test_finished_run_raw_from_captured_binary_patch(client, make_agent, tmp_path):
    repo, diff = _binary_diff(tmp_path, {"m.png": PNG_A}, {"m.png": PNG_B, "add.jpg": JPG, "doc.pdf": PDF, "b.zip": ZIP})
    a = await make_agent("Atlas", "eng")
    aid = a["agent_id"]
    rid = await _start(client, aid, base_cwd="/host/gone")  # the checkout is unreachable afterwards
    f = await client.post(f"/api/runs/{rid}/finish", json={"status": "exited", "exit_code": 0, "diff": diff})
    assert f.status_code == 200, f.text
    url = f"/api/agents/{aid}/runs/{rid}/changes/raw"
    assert (await client.get(url, params={"path": "m.png", "side": "old"})).content == PNG_A
    new = await client.get(url, params={"path": "m.png", "side": "new"})
    assert new.content == PNG_B and new.headers["content-type"] == "image/png"
    assert (await client.get(url, params={"path": "add.jpg"})).content == JPG
    assert (await client.get(url, params={"path": "doc.pdf"})).headers["content-type"] == "application/pdf"
    z = await client.get(url, params={"path": "b.zip"})
    assert z.headers["content-type"] == "application/zip" and z.headers["content-disposition"].startswith("attachment")
    assert (await client.get(url, params={"path": "add.jpg", "side": "old"})).status_code == 404


async def test_finished_run_raw_by_blob_id_in_the_runs_own_repo(client, make_agent, repo):
    """A diff captured WITHOUT --binary only names the blobs (`index <old>..<new>`):
    the old side is looked up by id in the run's repository."""
    blob = _git(repo, "rev-parse", "HEAD:img/a.png").decode().strip()
    captured = (
        "diff --git a/img/a.png b/img/a.png\n"
        f"index {blob}..{'f' * 40} 100644\n"
        "Binary files a/img/a.png and b/img/a.png differ\n"
    )
    a = await make_agent("Atlas", "eng")
    aid = a["agent_id"]
    rid = await _start(client, aid, base_cwd=str(repo))
    await client.post(f"/api/runs/{rid}/finish", json={"status": "exited", "exit_code": 0, "diff": captured})
    url = f"/api/agents/{aid}/runs/{rid}/changes/raw"
    assert (await client.get(url, params={"path": "img/a.png", "side": "old"})).content == PNG_A
    # the new blob was never stored: honest 404, not someone else's bytes
    assert (await client.get(url, params={"path": "img/a.png", "side": "new"})).status_code == 404
    # a run under another agent is not readable here
    b = await make_agent("Other", "eng")
    assert (await client.get(f"/api/agents/{b['agent_id']}/runs/{rid}/changes/raw",
                             params={"path": "img/a.png"})).status_code == 404


async def test_routes_are_in_openapi(client):
    paths = (await client.get("/openapi.json")).json()["paths"]
    for p in ("/api/containers/{cid}/github/browse/raw", "/api/containers/{cid}/code/worktree/raw",
              "/api/agents/{aid}/runs/{rid}/changes/raw"):
        assert "get" in paths[p], p
