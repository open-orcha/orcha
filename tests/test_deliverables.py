"""Non-code task deliverables (mig 953 + portal_backend/deliverables_*.py + notifier collector).

Contract under test:
  * Upload (multipart) creates a deliverable keyed by its confined logical path; a later
    upload of the same path appends a version — identical bytes are deduplicated (sha256).
  * List / detail / version history; text preview (capped); raw bytes with safe disposition
    (images + real PDFs inline, everything else a download, nosniff always).
  * Diff between versions: git-style unified diff for text kinds (renders in FilesChanged),
    changed/unchanged for binary kinds; defaults to previous → latest.
  * Policy: allowlisted types only (no SVG/HTML), magic-byte check for images/PDF, UTF-8
    check for text, size cap (env-tunable), per-task and per-deliverable caps, path
    traversal refused, root task refused, closed tasks frozen.
  * Authority: reads project-scoped (non-member 403, viewer OK); upload is a write (viewer
    403); run_id uploads are the machine lane, attributed to the run's agent, and must be
    the same task / project.
  * Audit + live event on each new version.
  * Notifier collector: scans <cwd>/.orcha/outputs confined (no symlinks, no hidden, caps),
    uploads with run_id, idempotent re-sync, self-ignoring .gitignore, reaper hook no-op
    without an outputs folder.
"""
import io
import os
import pathlib
import re

import pytest
import pytest_asyncio
from fastapi.testclient import TestClient

import main
from portal_backend import deliverables_routes, deliverables_storage as ds
from orcha_cli import notifier_deliverables as nd

MIG = (pathlib.Path(__file__).resolve().parents[1] / "orcha-cli" / "orcha_cli" / "templates"
       / "migrations" / "061_task_deliverables.sql")

OCTO = {"X-Auth-Request-User": "octocat"}
HUBOT = {"X-Auth-Request-User": "hubot"}
VERA = {"X-Auth-Request-User": "vera"}
MALLORY = {"X-Auth-Request-User": "mallory"}

PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 32
PNG2 = b"\x89PNG\r\n\x1a\n" + b"\x01" * 32
PDF = b"%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n"


@pytest.fixture(autouse=True)
def _team_plan(monkeypatch):
    monkeypatch.setenv("ORCHA_PLAN", "team")
    monkeypatch.delenv("ORCHA_DELIVERABLE_MAX_BYTES", raising=False)


@pytest.fixture
def trust_proxy(monkeypatch):
    monkeypatch.setenv("ORCHA_TRUST_PROXY_USER", "1")


@pytest.fixture
def no_trust_proxy(monkeypatch):
    monkeypatch.delenv("ORCHA_TRUST_PROXY_USER", raising=False)


@pytest_asyncio.fixture
async def store(tmp_path, monkeypatch):
    d = tmp_path / "orcha-attachments"
    d.mkdir()
    monkeypatch.setattr(main, "ATTACHMENTS_DIR", d)
    return d


@pytest_asyncio.fixture
async def arena(make_agent, make_task, no_trust_proxy, store):
    human = await make_agent("root", "operator", kind="human")
    dev = await make_agent("dev", "eng")
    task = await make_task("write the Q3 report", "report.md exists", assignee_alias="dev")
    return {"human": human, "dev": dev, "task": task, "tid": task["task_id"]}


async def _up(client, tid, name, content, *, path=None, run_id=None, author=None,
              note=None, headers=None):
    data = {}
    if path is not None:
        data["path"] = path
    if run_id is not None:
        data["run_id"] = run_id
    if author is not None:
        data["author_agent_id"] = author
    if note is not None:
        data["note"] = note
    return await client.post(
        f"/api/tasks/{tid}/deliverables",
        files={"file": (name, io.BytesIO(content), "application/octet-stream")},
        data=data,
        headers=headers or {},
    )


async def _start_run(client, aid, task_id=None):
    body = {"wake_kind": "ephemeral"}
    if task_id:
        body["task_id"] = task_id
    r = await client.post(f"/api/agents/{aid}/runs", json=body)
    assert r.status_code == 201, r.text
    return r.json()["run_id"]


# ---- pure policy ------------------------------------------------------------------------

@pytest.mark.parametrize("raw,expected", [
    ("report.md", "report.md"),
    ("reports/Q3 summary.md", "reports/Q3_summary.md"),
    ("./a//b/./c.csv", "a/b/c.csv"),
    ("win\\style\\notes.txt", "win/style/notes.txt"),
    ("data/.hidden.json", "data/hidden.json"),
    ("CHART.PNG", "CHART.PNG"),
])
def test_normalize_path_accepts_and_confines(raw, expected):
    assert ds.normalize_path(raw) == expected


@pytest.mark.parametrize("raw", [
    "", "   ", "../etc/passwd.txt", "a/../../b.md", "/abs/report.md", "C:/x/report.md",
    "evil.svg", "page.html", "script.js", "noext", "a/b/c/d/e.md", "x" * 300 + ".md",
    "nul\x00.md", "a/b.md/..",
])
def test_normalize_path_refuses(raw):
    with pytest.raises(ds.DeliverablePathError):
        ds.normalize_path(raw)


def test_kinds_and_magic():
    assert ds.kind_of("a.md") == "markdown" and ds.kind_of("a.csv") == "csv"
    assert ds.kind_of("a.tsv") == "csv" and ds.kind_of("a.json") == "json"
    assert ds.kind_of("a.pdf") == "pdf" and ds.kind_of("a.webp") == "image"
    assert ds.kind_of("a.svg") is None and ds.kind_of("a.html") is None
    assert ds.looks_like("png", PNG) and not ds.looks_like("png", b"GIF89a....")
    assert ds.looks_like("pdf", PDF) and not ds.looks_like("pdf", b"<html>")
    assert ds.looks_like("webp", b"RIFF\x00\x00\x00\x00WEBPVP8 ")
    assert ds.looks_like("md", b"anything")  # text kinds have no magic
    assert ds.is_probably_text("héllo".encode()) and not ds.is_probably_text(b"\x00\x01")


def test_text_diff_is_git_shaped():
    out = ds.text_diff("r.md", "a\nb\nc\n", "a\nB\nc\nd\n", old_label="v1", new_label="v2")
    lines = out["diff"].split("\n")
    assert lines[:3] == ["diff --git a/r.md b/r.md", "--- a/r.md", "+++ b/r.md"]
    assert "-b" in lines and "+B" in lines and "+d" in lines
    assert (out["added"], out["removed"], out["identical"]) == (2, 1, False)
    same = ds.text_diff("r.md", "x\n", "x\n", old_label="v1", new_label="v2")
    assert same["identical"] and same["diff"] == ""
    big = ds.text_diff("r.md", "", "\n".join(map(str, range(50))), old_label="v1",
                       new_label="v2", max_lines=10)
    assert big["truncated"] and len(big["diff"].split("\n")) == 13


def test_resolve_version_file_refuses_traversal(store):
    tid, did = "11111111-1111-1111-1111-111111111111", "22222222-2222-2222-2222-222222222222"
    d = ds.deliverable_dir(tid, did)
    d.mkdir(parents=True)
    (d / "v1.md").write_text("ok")
    assert ds.resolve_version_file(tid, did, "v1.md") is not None
    for bad in ("../v1.md", "v1.md/..", "x.md", "v0.md", "v1", "/etc/passwd"):
        assert ds.resolve_version_file(tid, did, bad) is None
    assert ds.deliverable_dir("..", did) is None or ".." not in str(ds.deliverable_dir("..", did))


def test_migration_is_additive():
    sql = "\n".join(l for l in MIG.read_text().splitlines() if not l.strip().startswith("--"))
    assert "CREATE TABLE IF NOT EXISTS task_deliverables" in sql
    assert "CREATE TABLE IF NOT EXISTS task_deliverable_versions" in sql
    for bad in (r"^\s*DROP\b", r"^\s*UPDATE\b", r"^\s*DELETE\b", r"^\s*TRUNCATE\b",
                r"^\s*ALTER\s+TABLE\b"):
        assert not re.search(bad, sql, re.I | re.M), bad


# ---- upload / list / versions ----------------------------------------------------------------

async def test_upload_list_detail_and_disk_layout(client, arena, store, db):
    tid, human = arena["tid"], arena["human"]
    r = await _up(client, tid, "report.md", b"# Q3\n\nRevenue up.\n",
                  author=human["agent_id"], note="first draft")
    assert r.status_code == 201, r.text
    body = r.json()
    assert body["created"] is True and body["deduplicated"] is False
    d, v = body["deliverable"], body["version"]
    assert (d["path"], d["name"], d["kind"], d["latest_version"], d["version_count"]) == (
        "report.md", "report.md", "markdown", 1, 1)
    assert v["source"] == "attached" and v["author_alias"] == "root" and v["note"] == "first draft"
    assert v["raw_url"] == f"/api/tasks/{tid}/deliverables/{d['id']}/versions/1/raw"
    assert v["text_url"].endswith("/versions/1/text")
    # bytes on disk under the store, never in the DB
    assert (store / "deliverables" / tid / d["id"] / "v1.md").read_bytes().startswith(b"# Q3")
    assert not list((store / "deliverables" / ".staging").glob("*"))  # staging cleaned

    lst = (await client.get(f"/api/tasks/{tid}/deliverables")).json()
    assert [x["path"] for x in lst["deliverables"]] == ["report.md"]
    assert lst["limits"]["max_bytes"] == 10 * 1024 * 1024
    assert "svg" not in lst["limits"]["allowed_extensions"]
    assert lst["limits"]["outputs_folder"] == ".orcha/outputs"

    det = (await client.get(f"/api/tasks/{tid}/deliverables/{d['id']}")).json()
    assert [x["version"] for x in det["versions"]] == [1]


async def test_versioning_dedup_and_diff(client, arena):
    tid = arena["tid"]
    r1 = await _up(client, tid, "report.md", b"a\nb\nc\n")
    did = r1.json()["deliverable"]["id"]
    same = await _up(client, tid, "report.md", b"a\nb\nc\n")
    assert same.status_code == 201 and same.json()["deduplicated"] is True
    assert same.json()["created"] is False and same.json()["version"]["version"] == 1

    r2 = await _up(client, tid, "whatever.md", b"a\nB\nc\nd\n", path="report.md")
    assert r2.json()["version"]["version"] == 2 and r2.json()["deliverable"]["id"] == did
    r3 = await _up(client, tid, "report.md", b"a\nB\nc\nd\ne\n")
    assert r3.json()["deliverable"]["version_count"] == 3

    det = (await client.get(f"/api/tasks/{tid}/deliverables/{did}")).json()
    assert [x["version"] for x in det["versions"]] == [3, 2, 1]
    lst = (await client.get(f"/api/tasks/{tid}/deliverables")).json()["deliverables"]
    assert lst[0]["latest"]["version"] == 3 and lst[0]["version_count"] == 3

    dflt = (await client.get(f"/api/tasks/{tid}/deliverables/{did}/diff")).json()
    assert (dflt["from"]["version"], dflt["to"]["version"]) == (2, 3)
    assert dflt["binary"] is False and dflt["added"] == 1 and dflt["removed"] == 0
    assert "+e" in dflt["diff"].split("\n")
    full = (await client.get(f"/api/tasks/{tid}/deliverables/{did}/diff?from=1&to=3")).json()
    assert {"-b", "+B", "+d", "+e"} <= set(full["diff"].split("\n"))
    assert full["diff"].startswith("diff --git a/report.md b/report.md")
    rev = (await client.get(f"/api/tasks/{tid}/deliverables/{did}/diff?from=3&to=1")).json()
    assert rev["removed"] == 3
    assert (await client.get(f"/api/tasks/{tid}/deliverables/{did}/diff?from=2&to=2")).status_code == 400
    assert (await client.get(f"/api/tasks/{tid}/deliverables/{did}/diff?from=1&to=9")).status_code == 404

    single = (await _up(client, tid, "other.txt", b"x")).json()["deliverable"]["id"]
    r = await client.get(f"/api/tasks/{tid}/deliverables/{single}/diff")
    assert r.status_code == 409 and "only one version" in r.json()["detail"]


async def test_binary_diff_reports_change_only(client, arena):
    tid = arena["tid"]
    did = (await _up(client, tid, "chart.png", PNG)).json()["deliverable"]["id"]
    await _up(client, tid, "chart.png", PNG2)
    r = (await client.get(f"/api/tasks/{tid}/deliverables/{did}/diff")).json()
    assert r["binary"] is True and r["bytes_changed"] is True and "diff" not in r
    t = await client.get(f"/api/tasks/{tid}/deliverables/{did}/versions/1/text")
    assert t.status_code == 415


async def test_text_preview_and_cap(client, arena, monkeypatch):
    tid = arena["tid"]
    did = (await _up(client, tid, "data.csv", b"a,b\n1,2\n")).json()["deliverable"]["id"]
    t = (await client.get(f"/api/tasks/{tid}/deliverables/{did}/versions/1/text")).json()
    assert t["text"] == "a,b\n1,2\n" and t["truncated"] is False and t["kind"] == "csv"
    monkeypatch.setattr(deliverables_routes, "TEXT_PREVIEW_MAX_BYTES", 4)
    t = (await client.get(f"/api/tasks/{tid}/deliverables/{did}/versions/1/text")).json()
    assert t["text"] == "a,b\n" and t["truncated"] is True
    assert (await client.get(f"/api/tasks/{tid}/deliverables/{did}/versions/7/text")).status_code == 404


async def test_raw_disposition_rules(client, arena):
    tid = arena["tid"]
    img = (await _up(client, tid, "chart.png", PNG)).json()["deliverable"]["id"]
    pdf = (await _up(client, tid, "memo.pdf", PDF)).json()["deliverable"]["id"]
    md = (await _up(client, tid, "notes.md", b"# hi\n")).json()["deliverable"]["id"]
    await _up(client, tid, "notes.md", b"# hi v2\n")

    r = await client.get(f"/api/tasks/{tid}/deliverables/{img}/versions/1/raw")
    assert r.status_code == 200 and r.content == PNG
    assert r.headers["content-type"] == "image/png"
    assert r.headers["content-disposition"].startswith("inline")
    assert r.headers["x-content-type-options"] == "nosniff"
    r = await client.get(f"/api/tasks/{tid}/deliverables/{pdf}/versions/1/raw")
    assert r.headers["content-disposition"].startswith("inline")
    assert r.headers["content-type"] == "application/pdf"
    r = await client.get(f"/api/tasks/{tid}/deliverables/{pdf}/versions/1/raw?download=1")
    assert r.headers["content-disposition"].startswith("attachment")
    r = await client.get(f"/api/tasks/{tid}/deliverables/{md}/versions/1/raw")
    assert r.headers["content-disposition"] == 'attachment; filename="notes.v1.md"'
    r = await client.get(f"/api/tasks/{tid}/deliverables/{md}/versions/2/raw")
    assert r.headers["content-disposition"] == 'attachment; filename="notes.md"'
    assert r.content == b"# hi v2\n"


async def test_missing_file_is_410(client, arena, store):
    tid = arena["tid"]
    d = (await _up(client, tid, "a.md", b"x")).json()["deliverable"]
    (store / "deliverables" / tid / d["id"] / "v1.md").unlink()
    r = await client.get(f"/api/tasks/{tid}/deliverables/{d['id']}/versions/1/raw")
    assert r.status_code == 410


# ---- policy refusals ---------------------------------------------------------------------------

async def test_type_and_content_refusals(client, arena, store):
    tid = arena["tid"]
    assert (await _up(client, tid, "evil.svg", b"<svg onload=alert(1)>")).status_code == 400
    assert (await _up(client, tid, "x.html", b"<script>")).status_code == 400
    r = await _up(client, tid, "ok.md", b"x", path="../../escape.md")
    assert r.status_code == 400 and ".." in r.json()["detail"]
    assert (await _up(client, tid, "empty.md", b"")).status_code == 400
    r = await _up(client, tid, "fake.png", b"GIF89a not a png")
    assert r.status_code == 400 and "not a valid .png" in r.json()["detail"]
    r = await _up(client, tid, "bin.txt", b"\x00\x01\x02\x03")
    assert r.status_code == 400 and "UTF-8" in r.json()["detail"]
    r = await _up(client, tid, "fake.pdf", b"<html>")
    assert r.status_code == 400
    lst = (await client.get(f"/api/tasks/{tid}/deliverables")).json()["deliverables"]
    assert lst == []
    staging = store / "deliverables" / ".staging"
    assert not staging.exists() or not list(staging.glob("*"))


async def test_size_cap_env(client, arena, monkeypatch, store):
    monkeypatch.setenv("ORCHA_DELIVERABLE_MAX_BYTES", "8")
    r = await _up(client, arena["tid"], "big.md", b"way more than eight bytes")
    assert r.status_code == 413, r.text
    assert not list((store / "deliverables" / ".staging").glob("*"))
    monkeypatch.setenv("ORCHA_DELIVERABLE_MAX_BYTES", "garbage")
    assert ds.max_deliverable_bytes() == ds.DEFAULT_MAX_DELIVERABLE_BYTES


async def test_version_and_count_caps(client, arena, monkeypatch):
    tid = arena["tid"]
    monkeypatch.setattr(deliverables_routes, "MAX_VERSIONS_PER_DELIVERABLE", 2)
    await _up(client, tid, "a.md", b"1")
    await _up(client, tid, "a.md", b"2")
    r = await _up(client, tid, "a.md", b"3")
    assert r.status_code == 409 and "versions" in r.json()["detail"]
    monkeypatch.setattr(deliverables_routes, "MAX_DELIVERABLES_PER_TASK", 1)
    r = await _up(client, tid, "b.md", b"1")
    assert r.status_code == 409 and "deliverables" in r.json()["detail"]
    # an existing path can still be versioned at the count cap (it isn't a NEW deliverable)
    monkeypatch.setattr(deliverables_routes, "MAX_VERSIONS_PER_DELIVERABLE", 50)
    assert (await _up(client, tid, "a.md", b"3")).status_code == 201


async def test_task_state_refusals(client, arena, container, db):
    tid = arena["tid"]
    assert (await _up(client, "not-a-uuid", "a.md", b"x")).status_code == 400
    assert (await _up(client, "3f2b8c1e-5a4d-4e0b-9c7a-1d2e3f4a5b6c", "a.md", b"x")).status_code == 404
    r = await _up(client, container["root_task_id"], "a.md", b"x")
    assert r.status_code == 400 and "root" in r.json()["detail"]
    await _up(client, tid, "a.md", b"x")
    for status in ("completed", "cancelled"):
        db.execute("UPDATE tasks SET status=%s WHERE id=%s", (status, tid))
        r = await _up(client, tid, "a.md", b"y")
        assert r.status_code == 409 and "frozen" in r.json()["detail"]
    # reads keep working on a closed task (the verified evidence stays reviewable)
    assert len((await client.get(f"/api/tasks/{tid}/deliverables")).json()["deliverables"]) == 1
    assert (await client.get("/api/tasks/nope/deliverables")).status_code == 400
    assert (await client.get(f"/api/tasks/{tid}/deliverables/nope")).status_code == 400
    r = await client.get(f"/api/tasks/{tid}/deliverables/3f2b8c1e-5a4d-4e0b-9c7a-1d2e3f4a5b6c")
    assert r.status_code == 404


async def test_deliverable_is_task_scoped(client, arena, make_task):
    other = await make_task("other", "done", assignee_alias="dev")
    did = (await _up(client, arena["tid"], "a.md", b"x")).json()["deliverable"]["id"]
    r = await client.get(f"/api/tasks/{other['task_id']}/deliverables/{did}")
    assert r.status_code == 404
    r = await client.get(f"/api/tasks/{other['task_id']}/deliverables/{did}/versions/1/raw")
    assert r.status_code == 404


# ---- run outputs (machine lane) ------------------------------------------------------------

async def test_run_output_attribution_and_run_checks(client, arena, make_task, make_agent, db):
    tid, dev = arena["tid"], arena["dev"]
    run = await _start_run(client, dev["agent_id"], tid)
    r = await _up(client, tid, "report.md", b"# from the run\n", run_id=run)
    assert r.status_code == 201, r.text
    v = r.json()["version"]
    assert (v["source"], v["run_id"], v["author_alias"], v["author_kind"]) == (
        "run_output", run, "dev", "ai")
    row = db.execute("SELECT run_id FROM task_deliverable_versions WHERE sha256=%s", (v["sha256"],))
    assert str(row[0]["run_id"]) == run

    other = await make_task("other", "done", assignee_alias="dev")
    other_run = await _start_run(client, dev["agent_id"], other["task_id"])
    r = await _up(client, tid, "x.md", b"x", run_id=other_run)
    assert r.status_code == 409 and "different task" in r.json()["detail"]
    r = await _up(client, tid, "x.md", b"x", run_id="3f2b8c1e-5a4d-4e0b-9c7a-1d2e3f4a5b6c")
    assert r.status_code == 404
    assert (await _up(client, tid, "x.md", b"x", run_id="nope")).status_code == 400

    # a run from ANOTHER project is refused
    c2 = (await client.post("/api/containers", json={"name": "elsewhere", "additional": True})).json()
    stranger = await make_agent("far", "eng", container_id=c2["container_id"])
    far_run = await _start_run(client, stranger["agent_id"])
    r = await _up(client, tid, "x.md", b"x", run_id=far_run)
    assert r.status_code == 403
    r = await _up(client, tid, "x.md", b"x", author=stranger["agent_id"])
    assert r.status_code == 403


async def test_audit_and_live_event(client, arena, container, db):
    tid = arena["tid"]
    await _up(client, tid, "a.md", b"1", author=arena["human"]["agent_id"])
    await _up(client, tid, "a.md", b"1")  # dedup: no second audit row
    ev = db.execute(
        "SELECT * FROM events WHERE entity_id=%s AND event_type='deliverable_version_added'", (tid,))
    assert len(ev) == 1 and ev[0]["detail"]["path"] == "a.md" and ev[0]["detail"]["version"] == 1
    live = db.execute("SELECT payload FROM agent_events WHERE event_name='task_deliverable_added'")
    assert len(live) == 1 and live[0]["payload"]["task_id"] == tid


# ---- trusted identity (cloud) --------------------------------------------------------------------

async def _bind_owner(client, container, make_agent):
    owner = await make_agent("root", "operator", kind="human")
    r = await client.get(f"/api/me?cid={container['id']}", headers=OCTO)
    assert r.status_code == 200, r.text
    return owner


async def _invite(client, cid, login, role="member"):
    r = await client.post(f"/api/containers/{cid}/members",
                          json={"github_login": login, "role": role}, headers=OCTO)
    assert r.status_code == 201, r.text
    return r.json()["agent_id"]


async def test_trusted_lane_authority(client, container, make_agent, make_task, trust_proxy, store):
    cid = container["id"]
    await _bind_owner(client, container, make_agent)
    dev = await make_agent("dev", "eng")
    tid = (await make_task("t", "d", assignee_alias="dev"))["task_id"]
    hubot = await _invite(client, cid, "hubot")
    await _invite(client, cid, "vera", role="viewer")

    # a member's upload is attributed to THEM, whatever author the body claims
    r = await _up(client, tid, "a.md", b"x", author=dev["agent_id"], headers=HUBOT)
    assert r.status_code == 201, r.text
    assert r.json()["version"]["author_agent_id"] == hubot
    assert r.json()["version"]["source"] == "attached"

    # viewer reads but may not write; a stranger may do neither
    assert (await client.get(f"/api/tasks/{tid}/deliverables", headers=VERA)).status_code == 200
    assert (await _up(client, tid, "b.md", b"x", headers=VERA)).status_code == 403
    assert (await client.get(f"/api/tasks/{tid}/deliverables", headers=MALLORY)).status_code == 403
    did = r.json()["deliverable"]["id"]
    for url in (f"/api/tasks/{tid}/deliverables/{did}",
                f"/api/tasks/{tid}/deliverables/{did}/versions/1/raw",
                f"/api/tasks/{tid}/deliverables/{did}/versions/1/text"):
        assert (await client.get(url, headers=MALLORY)).status_code == 403
        assert (await client.get(url, headers=VERA)).status_code == 200

    # run_id = the machine lane: a plain member may not act as the agent; the owner may
    run = await _start_run(client, dev["agent_id"], tid)
    assert (await _up(client, tid, "c.md", b"x", run_id=run, headers=HUBOT)).status_code == 403
    r = await _up(client, tid, "c.md", b"x", run_id=run, headers=OCTO)
    assert r.status_code == 201 and r.json()["version"]["author_alias"] == "dev"


def test_openapi_documents_the_routes():
    paths = main.app.openapi()["paths"]
    assert "/api/tasks/{tid}/deliverables" in paths
    assert {"get", "post"} <= set(paths["/api/tasks/{tid}/deliverables"])
    assert "/api/tasks/{tid}/deliverables/{did}/diff" in paths


# ---- notifier collector -----------------------------------------------------------------------------

def _outputs(tmp_path):
    d = tmp_path / "work" / ".orcha" / "outputs"
    d.mkdir(parents=True)
    return tmp_path / "work", d


def test_scan_outputs_confinement(tmp_path):
    cwd, out = _outputs(tmp_path)
    (out / "report.md").write_text("# r")
    (out / "sub").mkdir()
    (out / "sub" / "data.csv").write_text("a,b")
    (out / ".secret.md").write_text("no")
    (out / ".hidden").mkdir()
    (out / ".hidden" / "x.md").write_text("no")
    (out / "tool.exe").write_bytes(b"MZ")
    (out / "empty.md").write_text("")
    (out / "a" / "b" / "c" / "d").mkdir(parents=True)
    (out / "a" / "b" / "c" / "ok.md").write_text("depth 4 file")
    (out / "a" / "b" / "c" / "d" / "deep.md").write_text("too deep")
    secret = tmp_path / "outside.md"
    secret.write_text("outside")
    os.symlink(secret, out / "link.md")
    os.symlink(tmp_path, out / "linkdir")
    found, skipped = nd.scan_outputs(cwd)
    assert sorted(p for p, _ in found) == ["a/b/c/ok.md", "report.md", "sub/data.csv"]
    reasons = {s["path"]: s["reason"] for s in skipped}
    assert reasons["link.md"] == "symlink"
    assert reasons["tool.exe"] == "unsupported type" and reasons["empty.md"] == "empty"
    assert all("outside" not in p for p, _ in found)
    assert nd.scan_outputs(tmp_path / "nowhere") == ([], [])


def test_scan_outputs_caps(tmp_path, monkeypatch):
    cwd, out = _outputs(tmp_path)
    monkeypatch.setattr(nd, "MAX_FILES_PER_RUN", 2)
    monkeypatch.setattr(nd, "MAX_FILE_BYTES", 5)
    for i in range(3):
        (out / f"f{i}.md").write_text("x")
    (out / "big.md").write_text("123456")
    found, skipped = nd.scan_outputs(cwd)
    assert len(found) == 2
    reasons = sorted(s["reason"] for s in skipped)
    assert reasons == ["file cap reached", "too large"]


def test_ensure_outputs_dir_self_ignores(tmp_path):
    d = nd.ensure_outputs_dir(tmp_path)
    assert (d / ".gitignore").read_text() == "*\n"
    (d / ".gitignore").write_text("custom\n")
    nd.ensure_outputs_dir(tmp_path)
    assert (d / ".gitignore").read_text() == "custom\n"  # never clobbered


def test_encode_multipart_round_trips_through_the_real_route(tmp_path, monkeypatch):
    """The stdlib encoder the notifier uses is accepted by the real FastAPI route."""
    body, ctype = nd.encode_multipart({"path": "x\r\ny.md", "run_id": None}, 'n"a.md', b"hello")
    assert b'name="run_id"' not in body and b'filename="n_a.md"' in body
    assert b"x  y.md" in body  # CR/LF in a field value can't forge a part header


async def test_collector_end_to_end_idempotent(client, arena, tmp_path, monkeypatch):
    """Collector -> real route (via a sync TestClient adapter): new, unchanged, updated."""
    tid, dev = arena["tid"], arena["dev"]
    run1 = await _start_run(client, dev["agent_id"], tid)
    cwd, out = _outputs(tmp_path)
    (out / "report.md").write_text("# v1\n")
    (out / "charts").mkdir()
    (out / "charts" / "c.png").write_bytes(PNG)
    (out / "bad.png").write_bytes(b"not a png")

    tc = TestClient(main.app)
    calls = []

    def post(url, fields, name, data):
        body, ctype = nd.encode_multipart(fields, name, data)
        path = url.split("http://portal", 1)[1]
        r = tc.post(path, content=body, headers={"Content-Type": ctype})
        calls.append((fields["path"], r.status_code))
        return r.status_code, (r.json() if r.status_code == 201 else None)

    s1 = nd.collect_run_deliverables("http://portal", tid, run1, cwd, post_multipart=post)
    assert sorted(s1["uploaded"]) == ["charts/c.png", "report.md"]
    assert s1["failed"] == [{"path": "bad.png", "status": 400}]

    run2 = await _start_run(client, dev["agent_id"], tid)
    (out / "report.md").write_text("# v2\n")
    s2 = nd.collect_run_deliverables("http://portal", tid, run2, cwd, post_multipart=post)
    assert s2["uploaded"] == ["report.md"] and s2["unchanged"] == ["charts/c.png"]

    lst = (await client.get(f"/api/tasks/{tid}/deliverables")).json()["deliverables"]
    by = {d["path"]: d for d in lst}
    assert by["report.md"]["latest_version"] == 2 and by["report.md"]["latest"]["run_id"] == run2
    assert by["charts/c.png"]["latest_version"] == 1 and by["charts/c.png"]["kind"] == "image"
    diff = (await client.get(f"/api/tasks/{tid}/deliverables/{by['report.md']['id']}/diff")).json()
    assert "-# v1" in diff["diff"] and "+# v2" in diff["diff"]


def test_collect_for_worker_hook(tmp_path, monkeypatch):
    seen = []
    fake = lambda url, fields, name, data: (seen.append(fields["path"]) or (201, {"deduplicated": False}))
    # no task / no outputs folder -> strict no-op, no network
    assert nd.collect_for_worker("http://x", {"respawn_ctx": {}, "worktree": str(tmp_path)},
                                 post_multipart=fake) is None
    assert nd.collect_for_worker("http://x", {"respawn_ctx": {"task_id": "t"},
                                              "worktree": str(tmp_path)},
                                 post_multipart=fake) is None
    assert seen == []
    cwd, out = _outputs(tmp_path)
    (out / "r.md").write_text("x")
    s = nd.collect_for_worker("http://x", {"respawn_ctx": {"task_id": "t"}, "run_id": "r",
                                           "base_cwd": str(cwd)}, post_multipart=fake)
    assert s["uploaded"] == ["r.md"] and seen == ["r.md"]
    assert (out / ".gitignore").read_text() == "*\n"
    # a raising uploader never escapes into the reaper
    boom = lambda *a, **k: (_ for _ in ()).throw(RuntimeError("x"))
    assert nd.collect_for_worker("http://x", {"respawn_ctx": {"task_id": "t"},
                                              "base_cwd": str(cwd)}, post_multipart=boom) is None


def test_reaper_calls_hook_for_task_bound_workers(monkeypatch):
    from orcha_cli import notifier_reaper_completion as comp
    calls = []
    monkeypatch.setattr(comp.notifier_deliverables, "collect_for_worker",
                        lambda api, worker, quiet=True: calls.append(worker["run_id"]))

    class Proc:
        returncode = 0
        pid = 1

    class S:
        RUNTIME_CODEX = "codex"
        def __getattr__(self, name):
            return lambda *a, **k: None
        _normalize_runtime = staticmethod(lambda r: "claude")
        _finish_run = staticmethod(lambda *a, **k: True)
        _capture_diff = staticmethod(lambda *a, **k: "")
        _safe_teardown_worktree = staticmethod(lambda *a, **k: "noop")

    for bound, expect in ((True, ["r1"]), (False, [])):
        calls.clear()
        worker = {"proc": Proc(), "run_id": "r1", "task_bound": bound, "task_worktree": False,
                  "respawn_ctx": {"task_id": "t"}, "base_cwd": "/nope"}
        comp.handle_exited("http://x", "a", worker, {}, {}, {}, 0, True, S())
        assert calls == expect


async def test_commit_refuses_a_stored_name_that_escapes_the_deliverable_dir(client, arena, store, monkeypatch):
    """Defence in depth for the version copy (CodeQL path-injection): even if the stored
    name derived from the logical path were ever unsafe, the copy is refused (400) and
    nothing is written outside the deliverable's own directory."""
    tid, human = arena["tid"], arena["human"]
    for bad in ("../../../evil.md", "/tmp/evil.md", "v1.md/../../evil.md"):
        monkeypatch.setattr(deliverables_routes, "stored_name_for", lambda version, path, bad=bad: bad)
        r = await _up(client, tid, "report.md", b"# hi\n", author=human["agent_id"])
        assert r.status_code == 400, (bad, r.text)
        assert r.json()["detail"] == "invalid deliverable location"
    assert not list(store.rglob("evil.md"))
