"""Live changes — run_changes_routes.py: a run's changed files + per-file diff, computed
in the run's OWN checkout (worktree or base checkout), or served from the captured diff
once the run has finished.

Per the test-teeth convention nothing git-level is stubbed: every test drives a REAL temp
repo with a real `origin` remote and a real linked worktree created the way the notifier
creates one (`worktree add -b orcha/wk-… <base>/.orcha-worktrees/<name> origin/main`).
The "container" tests reproduce the Docker reality: the run records HOST paths that don't
exist here, the project is reachable only through ORCHA_LOCAL_REPO_DIR, and the
worktree's `.git` file names its gitdir by that absolute HOST path.

Run with ORCHA_TEST_DB_NAME=orcha_test_live_changes.
"""
import subprocess

import pytest

from portal_backend import run_changes_routes as rc

HOST = "/host/proj-live-changes"  # a host path that does NOT exist in this process

OCTO = {"X-Auth-Request-User": "octocat"}
VERA = {"X-Auth-Request-User": "vera"}
MALLORY = {"X-Auth-Request-User": "mallory"}


def _git(cwd, *args):
    return subprocess.run(["git", "-C", str(cwd), *args], check=True, capture_output=True).stdout


@pytest.fixture(autouse=True)
def _clear_cache(monkeypatch):
    rc._CACHE.clear()
    monkeypatch.delenv("ORCHA_HOST_PROJECT_DIR", raising=False)
    yield
    rc._CACHE.clear()


@pytest.fixture
def project(tmp_path):
    """origin (bare) + project clone on main + one notifier-style worktree `wk-a`."""
    origin = tmp_path / "origin.git"
    _git(tmp_path, "init", "-q", "--bare", "-b", "main", str(origin))
    proj = tmp_path / "proj"
    _git(tmp_path, "clone", "-q", str(origin), str(proj))
    _git(proj, "config", "user.email", "t@example.com")
    _git(proj, "config", "user.name", "T")
    _git(proj, "checkout", "-q", "-b", "main")
    (proj / "README.md").write_text("hello\n")
    (proj / "src").mkdir()
    (proj / "src" / "app.py").write_text("a = 1\nb = 2\n")
    (proj / "old_name.txt").write_text("rename me\nplease\n")
    (proj / "gone.txt").write_text("bye\n")
    _git(proj, "add", "-A")
    _git(proj, "commit", "-q", "-m", "init")
    _git(proj, "push", "-q", "-u", "origin", "main")
    wt = proj / ".orcha-worktrees" / "wk-a"
    _git(proj, "worktree", "add", "-q", "-b", "orcha/wk-a", str(wt), "origin/main")
    _git(wt, "config", "user.email", "t@example.com")
    _git(wt, "config", "user.name", "T")
    return {"proj": proj, "wt": wt, "tmp": tmp_path}


def _agent_edits(wt):
    """What an agent does in its worktree: a commit on its branch, a modification, a
    staged rename, a deletion, an untracked text file and an untracked binary file."""
    (wt / "committed.py").write_text("x = 1\n")
    _git(wt, "add", "committed.py")
    _git(wt, "commit", "-q", "-m", "agent commit")
    (wt / "src" / "app.py").write_text("a = 1\nb = 3\nc = 4\n")
    _git(wt, "mv", "old_name.txt", "new_name.txt")
    (wt / "gone.txt").unlink()
    (wt / "notes.md").write_text("one\ntwo\nthree\n")
    (wt / "blob.bin").write_bytes(b"\x00\x01\x02binary")


def _containerize(p, monkeypatch):
    """Make the checkout reachable ONLY the way the portal container reaches it."""
    monkeypatch.setenv("ORCHA_LOCAL_REPO_DIR", str(p["proj"]))
    (p["wt"] / ".git").write_text(f"gitdir: {HOST}/.git/worktrees/wk-a\n")
    (p["proj"] / ".git" / "worktrees" / "wk-a" / "gitdir").write_text(
        f"{HOST}/.orcha-worktrees/wk-a/.git\n")


async def _start(client, aid, **body):
    r = await client.post(f"/api/agents/{aid}/runs", json={"wake_kind": "ephemeral", **body})
    assert r.status_code == 201, r.text
    return r.json()["run_id"]


def _by_path(payload):
    return {f["path"]: f for f in payload["files"]}


# ------------------------------------------------------------------ live worktree

async def test_live_worktree_changes_through_container_mount(client, make_agent, project, monkeypatch):
    _agent_edits(project["wt"])
    _containerize(project, monkeypatch)
    a = await make_agent("Atlas", "eng")
    rid = await _start(client, a["agent_id"], worktree=f"{HOST}/.orcha-worktrees/wk-a",
                       branch="orcha/wk-a", base_cwd=HOST)

    r = await client.get(f"/api/agents/{a['agent_id']}/runs/{rid}/changes")
    assert r.status_code == 200, r.text
    d = r.json()
    assert d["available"] is True, d
    assert d["running"] is True and d["source"] == "live" and d["root"] == "worktree"
    assert d["branch"] == "orcha/wk-a"
    assert d["base"]["kind"] == "merge_base" and d["base"]["ref"] == "origin/main"
    assert d["base"]["sha"] == _git(project["proj"], "rev-parse", "origin/main").decode().strip()
    assert d["shared_checkout"] is False
    files = _by_path(d)
    assert files["committed.py"]["status"] == "A"          # agent's own commit is included
    assert files["src/app.py"] == {"path": "src/app.py", "status": "M", "additions": 2, "deletions": 1}
    assert files["new_name.txt"]["status"] == "R" and files["new_name.txt"]["orig_path"] == "old_name.txt"
    assert "old_name.txt" not in files
    assert files["gone.txt"]["status"] == "D" and files["gone.txt"]["deletions"] == 1
    assert files["notes.md"] == {"path": "notes.md", "status": "??", "additions": 3, "deletions": 0}
    assert files["blob.bin"]["status"] == "??" and files["blob.bin"]["binary"] is True
    assert files["blob.bin"]["additions"] is None
    # Orcha's own runtime paths never count as the agent's work
    assert not any(p.startswith(".orcha") for p in files)
    assert d["summary"]["files"] == len(d["files"])
    assert d["summary"]["additions"] == sum(f["additions"] or 0 for f in d["files"])
    assert r.headers["etag"] == f'W/"{d["version"]}"'
    assert d["as_of"]


async def test_live_diff_modified_untracked_rename_binary(client, make_agent, project, monkeypatch):
    _agent_edits(project["wt"])
    _containerize(project, monkeypatch)
    a = await make_agent("Atlas", "eng")
    aid = a["agent_id"]
    rid = await _start(client, aid, worktree=f"{HOST}/.orcha-worktrees/wk-a", branch="orcha/wk-a", base_cwd=HOST)
    base = f"/api/agents/{aid}/runs/{rid}/changes/diff"

    d = (await client.get(base, params={"path": "src/app.py"})).json()
    assert d["available"] and d["source"] == "live" and not d["binary"]
    assert "-b = 2" in d["diff"] and "+b = 3" in d["diff"] and "+c = 4" in d["diff"]

    d = (await client.get(base, params={"path": "notes.md"})).json()
    assert d["available"] and "+three" in d["diff"] and "/dev/null" in d["diff"]

    d = (await client.get(base, params={"path": "new_name.txt"})).json()
    assert d["available"] and "rename from old_name.txt" in d["diff"]

    d = (await client.get(base, params={"path": "blob.bin"})).json()
    assert d["available"] and d["binary"] is True

    # a real, safe path that simply isn't among the run's changes
    d = (await client.get(base, params={"path": "README.md"})).json()
    assert d == {"available": False, "reason": "not_changed",
                 "detail": "'README.md' is not among this run's changed files"}


async def test_diff_path_traversal_is_rejected(client, make_agent, project, monkeypatch, tmp_path):
    _containerize(project, monkeypatch)
    outside = tmp_path / "secret"
    outside.mkdir()
    (outside / "passwd").write_text("root:x:0:0\n")
    # an agent-created symlinked dir pointing OUT of the checkout
    (project["wt"] / "evil").symlink_to(outside, target_is_directory=True)
    a = await make_agent("Atlas", "eng")
    aid = a["agent_id"]
    rid = await _start(client, aid, worktree=f"{HOST}/.orcha-worktrees/wk-a", branch="orcha/wk-a", base_cwd=HOST)
    base = f"/api/agents/{aid}/runs/{rid}/changes/diff"
    for bad in ("../../etc/passwd", "/etc/passwd", "src/../../x", "-p", ""):
        r = await client.get(base, params={"path": bad})
        assert r.status_code == 400, (bad, r.text)
    # the symlink itself is a listed untracked entry — but reading THROUGH it escapes
    files = _by_path((await client.get(f"/api/agents/{aid}/runs/{rid}/changes")).json())
    assert "evil/passwd" not in files
    r = await client.get(base, params={"path": "evil/passwd"})
    assert r.status_code in (200, 400)
    assert "root:x" not in r.text


async def test_unchanged_poll_is_tiny_and_etag_304(client, make_agent, project, monkeypatch):
    _containerize(project, monkeypatch)
    (project["wt"] / "notes.md").write_text("one\n")
    a = await make_agent("Atlas", "eng")
    aid = a["agent_id"]
    rid = await _start(client, aid, worktree=f"{HOST}/.orcha-worktrees/wk-a", branch="orcha/wk-a", base_cwd=HOST)
    url = f"/api/agents/{aid}/runs/{rid}/changes"
    first = (await client.get(url)).json()
    v = first["version"]
    again = (await client.get(url, params={"since": v})).json()
    assert again["unchanged"] is True and again["version"] == v and again["running"] is True
    assert "files" not in again
    r = await client.get(url, headers={"If-None-Match": f'W/"{v}"'})
    assert r.status_code == 304
    # a real change produces a new version once the ~1 s cache lapses
    (project["wt"] / "more.md").write_text("x\n")
    rc._CACHE.clear()
    changed = (await client.get(url, params={"since": v})).json()
    assert changed.get("unchanged") is not True and "more.md" in _by_path(changed)


async def test_cache_absorbs_rapid_polls(client, make_agent, project, monkeypatch):
    _containerize(project, monkeypatch)
    a = await make_agent("Atlas", "eng")
    aid = a["agent_id"]
    rid = await _start(client, aid, worktree=f"{HOST}/.orcha-worktrees/wk-a", branch="orcha/wk-a", base_cwd=HOST)
    calls = []
    real = rc._compute
    monkeypatch.setattr(rc, "_compute", lambda run: calls.append(1) or real(run))
    for _ in range(3):
        assert (await client.get(f"/api/agents/{aid}/runs/{rid}/changes")).status_code == 200
    assert len(calls) == 1


# ------------------------------------------------------------------ base checkout

async def test_base_checkout_run_compares_against_head(client, make_agent, project, monkeypatch):
    _containerize(project, monkeypatch)
    (project["proj"] / "README.md").write_text("hello\nworld\n")
    (project["proj"] / ".claude").mkdir(exist_ok=True)
    (project["proj"] / ".claude" / ".orcha-notifier.log").write_text("runtime noise\n")
    a = await make_agent("Atlas", "eng")
    aid = a["agent_id"]
    # conversation run, worktrees disabled: base_cwd only (a host path)
    rid = await _start(client, aid, base_cwd=HOST, lane="conversation")
    d = (await client.get(f"/api/agents/{aid}/runs/{rid}/changes")).json()
    assert d["available"] is True, d
    assert d["root"] == "base" and d["base"]["kind"] == "head" and d["shared_checkout"] is True
    files = _by_path(d)
    assert files["README.md"]["additions"] == 1
    # the nested worktree is its own checkout, never the base's changes
    assert not any(p.startswith(".orcha-worktrees") for p in files)
    # Orcha's runtime state files are not the agent's work
    assert ".claude/.orcha-notifier.log" not in files


async def test_no_origin_main_falls_back_to_head(client, make_agent, tmp_path, monkeypatch):
    repo = tmp_path / "solo"
    repo.mkdir()
    _git(repo, "init", "-q", "-b", "main")
    _git(repo, "config", "user.email", "t@example.com")
    _git(repo, "config", "user.name", "T")
    (repo / "f.txt").write_text("1\n")
    _git(repo, "add", "-A")
    _git(repo, "commit", "-q", "-m", "c")
    wt = repo / ".orcha-worktrees" / "wk"
    _git(repo, "worktree", "add", "-q", "-b", "orcha/wk", str(wt))
    (wt / "f.txt").write_text("2\n")
    monkeypatch.delenv("ORCHA_LOCAL_REPO_DIR", raising=False)
    a = await make_agent("Atlas", "eng")
    aid = a["agent_id"]
    # portal on the host: real paths, no mount translation needed
    rid = await _start(client, aid, worktree=str(wt), branch="orcha/wk", base_cwd=str(repo))
    d = (await client.get(f"/api/agents/{aid}/runs/{rid}/changes")).json()
    assert d["available"] is True, d
    assert d["base"]["kind"] == "head"
    assert _by_path(d)["f.txt"]["status"] == "M"


# ------------------------------------------------------------------ unreachable

async def test_unreachable_checkout_is_honest_not_500(client, make_agent, project, monkeypatch):
    a = await make_agent("Atlas", "eng")
    aid = a["agent_id"]
    # no mount at all
    monkeypatch.delenv("ORCHA_LOCAL_REPO_DIR", raising=False)
    rid = await _start(client, aid, worktree=f"{HOST}/.orcha-worktrees/wk-a", base_cwd=HOST)
    d = (await client.get(f"/api/agents/{aid}/runs/{rid}/changes")).json()
    assert d["available"] is False and d["reason"] == "not_reachable" and d["files"] == []
    # a run from ANOTHER repository must not be shown the mounted tree's changes
    _containerize(project, monkeypatch)
    rid2 = await _start(client, aid, base_cwd="/host/some-other-repo")
    d = (await client.get(f"/api/agents/{aid}/runs/{rid2}/changes")).json()
    assert d["available"] is False and d["reason"] == "not_reachable"
    # worktree removed since
    rid3 = await _start(client, aid, worktree=f"{HOST}/.orcha-worktrees/gone", base_cwd=HOST)
    d = (await client.get(f"/api/agents/{aid}/runs/{rid3}/changes")).json()
    assert d["available"] is False and d["reason"] == "not_reachable"
    # nothing recorded
    rid4 = await _start(client, aid)
    d = (await client.get(f"/api/agents/{aid}/runs/{rid4}/changes")).json()
    assert d["available"] is False and d["reason"] == "no_checkout"
    r = await client.get(f"/api/agents/{aid}/runs/{rid4}/changes/diff", params={"path": "a.txt"})
    assert r.status_code == 200 and r.json()["available"] is False


# ------------------------------------------------------------------ finished run

CAPTURED = """diff --git a/src/app.py b/src/app.py
index 1111111..2222222 100644
--- a/src/app.py
+++ b/src/app.py
@@ -1,2 +1,3 @@
 a = 1
-b = 2
+b = 3
+c = 4
diff --git a/notes.md b/notes.md
new file mode 100644
index 0000000..3333333
--- /dev/null
+++ b/notes.md
@@ -0,0 +1,2 @@
+one
+two
diff --git a/gone.txt b/gone.txt
deleted file mode 100644
index 4444444..0000000
--- a/gone.txt
+++ /dev/null
@@ -1 +0,0 @@
-bye
diff --git a/logo.png b/logo.png
new file mode 100644
index 0000000..5555555
Binary files /dev/null and b/logo.png differ
"""


async def test_finished_run_serves_captured_diff_not_the_moved_tree(client, make_agent, project, monkeypatch):
    _containerize(project, monkeypatch)
    a = await make_agent("Atlas", "eng")
    aid = a["agent_id"]
    rid = await _start(client, aid, worktree=f"{HOST}/.orcha-worktrees/wk-a", branch="orcha/wk-a", base_cwd=HOST)
    f = await client.post(f"/api/runs/{rid}/finish", json={"status": "exited", "exit_code": 0, "diff": CAPTURED})
    assert f.status_code == 200, f.text
    # the tree moves on after the run — must NOT leak into the finished run's changes
    (project["wt"] / "later.txt").write_text("after the run\n")
    d = (await client.get(f"/api/agents/{aid}/runs/{rid}/changes")).json()
    assert d["available"] is True and d["running"] is False and d["source"] == "captured"
    files = _by_path(d)
    assert set(files) == {"src/app.py", "notes.md", "gone.txt", "logo.png"}
    assert files["src/app.py"]["additions"] == 2 and files["src/app.py"]["deletions"] == 1
    assert files["notes.md"]["status"] == "A" and files["gone.txt"]["status"] == "D"
    assert files["logo.png"]["binary"] is True
    assert d["summary"] == {"files": 4, "additions": 4, "deletions": 2}

    diff = (await client.get(f"/api/agents/{aid}/runs/{rid}/changes/diff", params={"path": "notes.md"})).json()
    assert diff["source"] == "captured" and "+two" in diff["diff"] and "src/app.py" not in diff["diff"]
    r = await client.get(f"/api/agents/{aid}/runs/{rid}/changes/diff", params={"path": "later.txt"})
    assert r.json()["reason"] == "not_changed"


async def test_finished_run_without_captured_diff(client, make_agent):
    a = await make_agent("Atlas", "eng")
    aid = a["agent_id"]
    rid = await _start(client, aid, base_cwd=HOST)
    await client.post(f"/api/runs/{rid}/finish", json={"status": "exited", "exit_code": 0})
    d = (await client.get(f"/api/agents/{aid}/runs/{rid}/changes")).json()
    assert d["available"] is False and d["reason"] == "not_captured" and d["running"] is False


# ------------------------------------------------------------------ access

async def test_ids_and_ownership(client, make_agent):
    a = await make_agent("Atlas", "eng")
    b = await make_agent("Other", "eng")
    rid = await _start(client, a["agent_id"], base_cwd=HOST)
    r = await client.get(f"/api/agents/not-a-uuid/runs/{rid}/changes")
    assert r.status_code == 400
    # a run is only readable under ITS agent
    r = await client.get(f"/api/agents/{b['agent_id']}/runs/{rid}/changes")
    assert r.status_code == 404
    r = await client.get(f"/api/agents/{b['agent_id']}/runs/{rid}/changes/diff", params={"path": "x"})
    assert r.status_code == 404


async def test_member_read_rules_match_runs_list(client, container, make_agent, project, monkeypatch):
    monkeypatch.setenv("ORCHA_PLAN", "team")
    monkeypatch.setenv("ORCHA_TRUST_PROXY_USER", "1")
    _containerize(project, monkeypatch)
    (project["wt"] / "notes.md").write_text("one\n")
    cid = container["id"]
    await make_agent("root", "operator", kind="human")
    me = await client.get(f"/api/me?cid={cid}", headers=OCTO)
    assert me.json()["identity"]["member_role"] == "owner"
    r = await client.post(f"/api/containers/{cid}/members", json={"github_login": "vera", "role": "viewer"}, headers=OCTO)
    assert r.status_code == 201, r.text
    a = await make_agent("Atlas", "eng")
    aid = a["agent_id"]
    rid = await _start(client, aid, worktree=f"{HOST}/.orcha-worktrees/wk-a", branch="orcha/wk-a", base_cwd=HOST)
    url = f"/api/agents/{aid}/runs/{rid}/changes"
    durl = url + "/diff"
    for who, code in ((OCTO, 200), (VERA, 200), (MALLORY, 403)):
        runs = await client.get(f"/api/agents/{aid}/runs", headers=who)
        assert runs.status_code == code
        assert (await client.get(url, headers=who)).status_code == code, who
        assert (await client.get(durl, params={"path": "notes.md"}, headers=who)).status_code == code, who
    assert (await client.get(url, headers=VERA)).json()["available"] is True


# ------------------------------------------------------------------ parsers

def test_split_patch_rename_section():
    patch = (
        "diff --git a/old.txt b/new.txt\nsimilarity index 90%\nrename from old.txt\n"
        "rename to new.txt\n--- a/old.txt\n+++ b/new.txt\n@@ -1 +1 @@\n-a\n+b\n"
    )
    (row,) = rc._split_patch(patch)
    assert row["path"] == "new.txt" and row["status"] == "R" and row["orig_path"] == "old.txt"
    assert (row["additions"], row["deletions"]) == (1, 1)


# L2: a captured diff WITHOUT `diff --git` headers (plain `diff -u` shape).
PLAIN = """--- a/api/limits.py
+++ b/api/limits.py
@@ -1,3 +1,4 @@
 import os
--- not a header: removed line that looks like one
+++ nor this: an added line
+LIMIT = 10
 x = 1
--- /dev/null
+++ b/api/new.py
@@ -0,0 +1,2 @@
+one
+two
--- old.txt\t2026-01-01 00:00:00
+++ /dev/null\t2026-01-01 00:00:00
@@ -1 +0,0 @@
-bye
"""


def test_split_patch_headerless_unified_diff():
    rows = {r["path"]: r for r in rc._split_patch(PLAIN)}
    assert set(rows) == {"api/limits.py", "api/new.py", "old.txt"}
    lim = rows["api/limits.py"]
    assert lim["status"] == "M" and (lim["additions"], lim["deletions"]) == (2, 1)
    assert rows["api/new.py"]["status"] == "A" and rows["api/new.py"]["additions"] == 2
    assert rows["old.txt"]["status"] == "D" and rows["old.txt"]["deletions"] == 1


async def test_finished_run_headerless_diff_lists_files(client, make_agent):
    a = await make_agent("Forge", "eng")
    aid = a["agent_id"]
    rid = await _start(client, aid, base_cwd=HOST)
    f = await client.post(f"/api/runs/{rid}/finish", json={"status": "exited", "exit_code": 0, "diff": PLAIN})
    assert f.status_code == 200, f.text
    d = (await client.get(f"/api/agents/{aid}/runs/{rid}/changes")).json()
    assert d["available"] is True and d["source"] == "captured"
    assert "api/limits.py" in _by_path(d) and d["summary"]["files"] == 3
    diff = (await client.get(f"/api/agents/{aid}/runs/{rid}/changes/diff", params={"path": "api/limits.py"})).json()
    assert "+LIMIT = 10" in diff["diff"]


async def test_finished_run_unparseable_diff_is_honest(client, make_agent):
    a = await make_agent("Forge", "eng")
    aid = a["agent_id"]
    rid = await _start(client, aid, base_cwd=HOST)
    await client.post(f"/api/runs/{rid}/finish", json={"status": "exited", "exit_code": 0, "diff": "garbage\nmore garbage\n"})
    d = (await client.get(f"/api/agents/{aid}/runs/{rid}/changes")).json()
    assert d["available"] is False and d["reason"] == "unparsed"


async def test_snapshot_running_run_carries_checkout_fields(client, container, make_agent):
    """L13b: the board's Live-changes entry needs the running run's checkout fields."""
    a = await make_agent("Pixel", "eng")
    b = await make_agent("Forge", "eng")
    await _start(client, a["agent_id"])  # no checkout recorded
    await _start(client, b["agent_id"], worktree=f"{HOST}/.orcha-worktrees/wk-f", base_cwd=HOST)
    snap = (await client.get(f"/api/containers/{container['id']}")).json()
    rr = {x["alias"]: x.get("running_run") for x in snap["agents"]}
    assert rr["Pixel"]["worktree"] is None and rr["Pixel"]["base_cwd"] is None
    assert rr["Forge"]["worktree"].endswith("wk-f") and rr["Forge"]["base_cwd"] == HOST
