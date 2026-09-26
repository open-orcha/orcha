"""task_start_core — the shared GitHub-start internals both the hub and Slack seams
call. This file's focus: the GitHub round-trip comment ("🤖 Orcha started task ...")
that fires once per FRESH start, from the ONE shared function, regardless of caller.

Per the test-teeth convention, only the network leaf (`task_start_core._gh_post_comment`)
is stubbed — repo binding, token resolution, task creation, and the fresh-vs-existing
branch all run for real through the actual `POST /github/start` route.
"""
import pytest

from portal_backend import github_hub_routes as hub
from portal_backend import task_start_core as core


@pytest.fixture
def token_env(monkeypatch, tmp_path):
    token_file = tmp_path / "github-token"
    token_file.write_text("ghs_starttoken\n")
    monkeypatch.setenv("ORCHA_GITHUB_TOKEN_FILE", str(token_file))
    monkeypatch.delenv("ORCHA_GITHUB_TOKENS_FILE", raising=False)
    return "ghs_starttoken"


async def _bind_repo(client, cid, repo="acme/site"):
    r = await client.put(f"/api/containers/{cid}/github", json={"repo": repo})
    assert r.status_code == 200, r.text


def _capture_comment(monkeypatch):
    calls = []

    def fake_post(repo, number, token, body):
        calls.append({"repo": repo, "number": number, "token": token, "body": body})

    monkeypatch.setattr(core, "_gh_post_comment", fake_post)
    return calls


# ------------------------- composition -------------------------

def test_compose_start_comment_assigned():
    text = core._compose_start_comment("abcdef1234567890", "atlas")
    assert text.startswith("🤖 Orcha started task `abcdef12` for this")
    assert "assigned to **atlas**" in text
    assert "Work arrives as a PR; a human verifies before anything merges." in text


def test_compose_start_comment_unassigned():
    text = core._compose_start_comment("abcdef1234567890", None)
    assert "unassigned — the orchestrator routes it" in text
    assert "assigned to **" not in text


# ------------------------- fresh start: posts the comment -------------------------

async def test_comment_posted_on_fresh_issue_start(
        client, container, token_env, monkeypatch):
    cid = container["id"]
    await _bind_repo(client, cid)
    calls = _capture_comment(monkeypatch)

    r = await client.post(f"/api/containers/{cid}/github/start",
                          json={"kind": "issue", "number": 232, "title": "Clinician dashboard"})
    assert r.status_code == 201, r.text
    tid = r.json()["task_id"]

    assert len(calls) == 1
    c = calls[0]
    assert c["repo"] == "acme/site"
    assert c["number"] == 232
    assert c["token"] == "ghs_starttoken"
    assert c["body"].startswith(f"🤖 Orcha started task `{tid[:8]}` for this")
    assert "unassigned — the orchestrator routes it" in c["body"]
    assert "Work arrives as a PR; a human verifies before anything merges." in c["body"]


async def test_comment_posted_on_fresh_pull_start(
        client, container, token_env, monkeypatch):
    cid = container["id"]
    await _bind_repo(client, cid)
    calls = _capture_comment(monkeypatch)

    r = await client.post(f"/api/containers/{cid}/github/start",
                          json={"kind": "pull", "number": 55, "title": "Fix retry"})
    assert r.status_code == 201, r.text

    assert len(calls) == 1
    assert calls[0]["number"] == 55
    # PR comments ride the SAME issues/{number}/comments endpoint — task_start_core
    # never branches on kind for the comment call itself.


async def test_comment_names_the_assignee(
        client, container, make_agent, token_env, monkeypatch):
    cid = container["id"]
    await _bind_repo(client, cid)
    agent = await make_agent("worker-1", kind="ai")
    aid = agent["agent_id"]
    calls = _capture_comment(monkeypatch)

    r = await client.post(f"/api/containers/{cid}/github/start",
                          json={"kind": "issue", "number": 8, "title": "assign me",
                                "assignee_agent_id": aid})
    assert r.status_code == 201, r.text

    assert len(calls) == 1
    assert "assigned to **worker-1**" in calls[0]["body"]


# ------------------------- existing=True: never comments -------------------------

async def test_comment_skipped_on_existing_task(
        client, container, token_env, monkeypatch):
    """A double-click / retry that hits the idempotency short-circuit must NOT post a
    second comment — only the FRESH creation gets the round-trip comment."""
    cid = container["id"]
    await _bind_repo(client, cid)
    calls = _capture_comment(monkeypatch)

    r1 = await client.post(f"/api/containers/{cid}/github/start",
                           json={"kind": "issue", "number": 12, "title": "first"})
    assert r1.status_code == 201 and r1.json()["existing"] is False
    r2 = await client.post(f"/api/containers/{cid}/github/start",
                           json={"kind": "issue", "number": 12, "title": "first"})
    assert r2.status_code == 201 and r2.json()["existing"] is True

    assert len(calls) == 1  # only the fresh start commented, not the re-click


# ------------------------- non-fatal by construction -------------------------

async def test_comment_failure_never_breaks_task_creation(
        client, container, token_env, monkeypatch):
    def boom(repo, number, token, body):
        raise RuntimeError("github_status:403 (Issues:write not granted)")

    monkeypatch.setattr(core, "_gh_post_comment", boom)
    cid = container["id"]
    await _bind_repo(client, cid)

    r = await client.post(f"/api/containers/{cid}/github/start",
                          json={"kind": "issue", "number": 900, "title": "still works"})
    assert r.status_code == 201, r.text
    assert r.json()["existing"] is False
    listed = (await client.get(f"/api/containers/{cid}/tasks")).json()["tasks"]
    assert any(t["title"] == "GH #900: still works" for t in listed)


async def test_no_comment_attempted_without_bound_repo(client, container, monkeypatch):
    """No repo bound at all — the common pre-GitHub-hub-setup case. No comment attempt,
    no crash; task creation proceeds exactly as before this feature existed."""
    calls = _capture_comment(monkeypatch)
    cid = container["id"]
    r = await client.post(f"/api/containers/{cid}/github/start",
                          json={"kind": "issue", "number": 3, "title": "no repo bound"})
    assert r.status_code == 201, r.text
    assert calls == []


async def test_no_comment_attempted_without_token(client, container, monkeypatch):
    """Repo bound but no installation token resolvable (App not wired here) — same
    graceful no-op; matches slack_notify's "cheapest gate first" contract."""
    calls = _capture_comment(monkeypatch)
    cid = container["id"]
    await _bind_repo(client, cid)
    r = await client.post(f"/api/containers/{cid}/github/start",
                          json={"kind": "issue", "number": 4, "title": "no token"})
    assert r.status_code == 201, r.text
    assert calls == []


# ------------------------- shared internals: both dispatch paths -------------------------

async def test_comment_fires_once_from_shared_core_regardless_of_caller(
        client, container, make_agent, db, token_env, monkeypatch):
    """The comment is posted from task_start_core itself (not duplicated per-caller) —
    a Slack-triggered start goes through the exact same start_task_from_github call the
    hub uses, so it gets exactly one comment too, never two."""
    import hashlib
    import hmac
    import time
    import urllib.parse

    cid = container["id"]
    await _bind_repo(client, cid)
    monkeypatch.setattr(hub, "_gh_get", lambda p, t: {
        "number": 300, "title": "from slack", "html_url": "https://github.com/acme/site/issues/300",
        "body": "",
    })
    calls = _capture_comment(monkeypatch)

    agent = await make_agent("ops", kind="human")
    db.execute("UPDATE agents SET slack_user_id=%s WHERE id=%s",
               ("U-1", agent["agent_id"]))

    secret = "shhh"
    monkeypatch.setenv("SLACK_SIGNING_SECRET", secret)
    monkeypatch.setenv("SLACK_BOT_TOKEN", "xoxb-1")
    text_body = urllib.parse.urlencode({"user_id": "U-1", "text": "start issue 300"})
    ts = str(int(time.time()))
    base = f"v0:{ts}:{text_body}".encode()
    sig = "v0=" + hmac.new(secret.encode(), base, hashlib.sha256).hexdigest()
    r = await client.post(
        "/api/slack/commands", content=text_body,
        headers={"X-Slack-Request-Timestamp": ts, "X-Slack-Signature": sig,
                "Content-Type": "application/x-www-form-urlencoded"},
    )
    assert r.status_code == 200, r.text

    assert len(calls) == 1
    assert calls[0]["number"] == 300


# ------------------------- find_open_gh_task(s): shared-helper mutation pin ----------
#
# github_hub_routes' list/detail endpoints (tracked_task_id) and
# start_task_from_github's idempotency check must use the IDENTICAL "which task is
# this GH number already tracked by" rule, or a hub page could show an item as
# untracked while a click on Start immediately bounces off {existing:true} (or the
# reverse: a stale tracked chip pointing at a task the idempotency check would no
# longer honor). find_open_gh_task is implemented as literally
# find_open_gh_tasks(...).get(number) — these tests pin that relationship so a future
# edit that reintroduces a SEPARATE single-number code path (drift risk) goes red.

async def test_find_open_gh_task_and_batched_form_agree_for_open_task(client, container):
    from portal_backend.database import db_cursor

    cid = container["id"]
    r = await client.post(f"/api/containers/{cid}/tasks", json={
        "title": "GH #42: seed", "description": "", "definition_of_done": "x",
    })
    tid = r.json()["task_id"]

    with db_cursor() as (_, cur):
        single = core.find_open_gh_task(cur, cid, 42)
        batched = core.find_open_gh_tasks(cur, cid, [42, 999])
    assert single == tid
    assert batched == {42: tid}   # 999 (no open task) is simply absent, not None-valued


def test_find_open_gh_task_is_the_single_number_case_of_the_batched_helper(monkeypatch):
    """Mutation-guard: find_open_gh_task's body must literally delegate to
    find_open_gh_tasks — proven by making the batched helper always return a
    recognizable sentinel and asserting the single-number function surfaces it
    unchanged. If a future edit reintroduces a separate/duplicated query for the
    single-number path, this goes red even without a live DB."""
    sentinel = {7: "task-from-batched-helper"}
    calls = []

    def fake_batched(cur, container_id, numbers):
        calls.append((container_id, list(numbers)))
        return sentinel

    monkeypatch.setattr(core, "find_open_gh_tasks", fake_batched)
    result = core.find_open_gh_task("fake-cur", "cid-1", 7)
    assert result == "task-from-batched-helper"
    assert calls == [("cid-1", [7])]


# ------------------------- DoD: codebase-triage-first clause (issue-kind only) -------------------------
#
# Founder ask, layered on top of the Slack AI-refine feature: the LLM refine pass
# (slack_routes._refine_issue_for_filing) makes an issue's WORDING professional in
# seconds, codebase-blind by design (it never sees the repo). The dispatched agent
# is the one with actual codebase access — so its DoD now requires it to open with a
# codebase-grounded triage comment on the GitHub issue BEFORE writing any code. This
# is pure division of labor: fast, cheap wording polish up front; real investigation
# from inside the repo once an agent picks the work up. Only ISSUE-kind tasks get
# this clause — a PR/Fix task is reacting to CI/review feedback on code that already
# exists, not triaging a fresh report, so _PULL_DOD (and any dod_override the hub's
# PR-Fix path supplies) is deliberately untouched.

def test_build_task_fields_issue_kind_includes_triage_clause():
    fields = core.build_task_fields("issue", 42, "Login button broken", "", "")
    dod = fields["definition_of_done"]
    assert "Before implementing: post a triage comment on GH issue #42" in dod
    assert "codebase-grounded analysis" in dod
    assert "the specific modules/files involved" in dod
    assert "what logs/repro would confirm it" in dod
    # The triage clause comes BEFORE the existing fix/PR/review clauses, not appended
    # after — "Before implementing" must be true of the DoD's own ordering.
    assert dod.index("Before implementing") < dod.index("Fix GH #42 per its description")
    # Pre-existing clauses (pinned by test_github_hub_routes.py/test_slack_routes.py's
    # substring asserts) survive unchanged.
    assert "Fix GH #42 per its description" in dod
    assert "Never merge" in dod


def test_build_task_fields_pull_kind_has_no_triage_clause():
    fields = core.build_task_fields("pull", 9, "Fix retry backoff", "", "")
    dod = fields["definition_of_done"]
    assert "triage comment" not in dod
    assert "Before implementing" not in dod
    assert "Resolve CI failures / review feedback on PR #9" in dod


def test_build_task_fields_dod_override_bypasses_triage_clause():
    """A PR-Fix dod_override (github_hub_routes' context-aware DoD) REPLACES the
    generic template outright — the triage clause is part of the generic _ISSUE_DOD
    template only, never injected into an override."""
    fields = core.build_task_fields(
        "issue", 42, "title", "", "", dod_override="Custom DoD with no triage clause.",
    )
    assert fields["definition_of_done"] == "Custom DoD with no triage clause."


# ------------------------- slack-captured task-first start -------------------------

def test_build_slack_captured_dod_includes_file_issue_first_clauses():
    """The new DoD variant for Slack-captured tasks (no GH issue exists yet at
    creation time) must instruct the agent, in order: file a professional GitHub
    issue first (imperative title, structured body, embed screenshots, quote the
    reporter verbatim, provenance footer, post the link back to the task thread),
    THEN post the triage comment on that issue, THEN implement per the standard
    protocol (PR, never merge, human verifies)."""
    dod = core.build_slack_captured_dod()
    assert "file a professional github issue" in dod.lower()
    assert "imperative" in dod.lower()
    assert "screenshot" in dod.lower()
    assert "verbatim" in dod.lower()
    assert "post the new issue's link" in dod.lower() or "post the link" in dod.lower()
    assert "triage comment" in dod.lower()
    assert "never merge" in dod.lower() or "never merged" in dod.lower()
    assert "human" in dod.lower()
    # Ordering: the file-issue instruction must appear before the triage/implement
    # instructions (agents read DoDs top to bottom as an ordered checklist).
    file_idx = dod.lower().index("file a professional github issue")
    triage_idx = dod.lower().index("triage comment")
    assert file_idx < triage_idx


async def test_start_task_from_slack_capture_creates_ready_task_with_raw_title(
        client, container, make_agent, db):
    """A Slack-captured task has no GH number — the title is the raw modal title,
    unprefixed (never 'GH #N: ...', since find_open_gh_task's idempotency probe
    must never accidentally match a slack-captured task)."""
    member = await make_agent("reporter", kind="human")
    from portal_backend.database import db_cursor
    with db_cursor() as (conn, cur):
        result = core.start_task_from_slack_capture(
            cur, container["id"],
            title="Login button is misaligned",
            description="raw slack message text\n\n_Captured from Slack by reporter via Orcha_",
            created_by_agent_id=member["agent_id"],
            assignee_agent_id=None,
        )
        conn.commit()
    assert result["existing"] is False
    listed = (await client.get(f"/api/containers/{container['id']}/tasks")).json()["tasks"]
    t = [x for x in listed if x["id"] == result["task_id"]][0]
    assert t["title"] == "Login button is misaligned"
    assert not t["title"].startswith("GH #")
    assert t["status"] == "ready"  # unassigned -> Atlas routes it, same convention as create_task


async def test_start_task_from_slack_capture_with_assignee_starts_in_progress(
        client, container, make_agent, db):
    """Mirrors start_task_from_github's assigned-vs-unassigned status convention."""
    member = await make_agent("reporter", kind="human")
    ai = await make_agent("atlas", kind="ai")
    from portal_backend.database import db_cursor
    with db_cursor() as (conn, cur):
        result = core.start_task_from_slack_capture(
            cur, container["id"],
            title="Assigned capture",
            description="body",
            created_by_agent_id=member["agent_id"],
            assignee_agent_id=ai["agent_id"],
        )
        conn.commit()
    listed = (await client.get(f"/api/containers/{container['id']}/tasks")).json()["tasks"]
    t = [x for x in listed if x["id"] == result["task_id"]][0]
    assert t["status"] == "in_progress"
    at = db.execute("SELECT agent_id FROM agent_tasks WHERE task_id=%s", (t["id"],))
    assert str(at[0]["agent_id"]) == ai["agent_id"]


def test_start_task_from_slack_capture_uses_slack_captured_dod_not_issue_dod():
    """The new function must use the new DoD template, not the GH-issue one — a
    slack-captured task has no GH issue yet, so the generic _ISSUE_DOD's 'post a
    triage comment on GH issue #{n}' phrasing (which assumes a pre-existing numbered
    issue) would be nonsensical here."""
    import inspect
    src = inspect.getsource(core.start_task_from_slack_capture)
    assert "build_slack_captured_dod" in src
    assert "_ISSUE_DOD" not in src


# ------------------------- automatic triage: wake the orchestrator -------------------------
#
# Production gap: a task created UNASSIGNED via the hub Start / Slack capture paths landed
# 'ready' with nothing to wake anyone to route it — it could sit forever. Both paths funnel
# through this file's `_finish_task_insert`, so the fix lives in exactly one place: when the
# unassigned branch runs, look up the container's orchestrator agent (find_orchestrator_agent)
# and — if one exists — publish a targeted `task_created_unassigned` event at it, the same
# `publish_event` call shape the assigned branch already uses for `task_assigned`. These tests
# pin the event's shape, its presence/absence per branch, and its wake-scan visibility.

from portal_backend.database import db_cursor


async def test_find_orchestrator_agent_matches_role_ilike_orchestrat(
        client, container, make_agent):
    """The only existing 'is this the orchestrator' signal anywhere in the codebase is a
    role-string heuristic (the frontend's ORCHESTRATOR_ROLE_RE — now in
    frontend/src/cloud/github/ghlib.ts). This pins the backend
    mirror: a live AI agent whose role contains 'orchestrat', case-insensitively, matching
    realistic personas like 'orchestrator / system architect'."""
    cid = container["id"]
    atlas = await make_agent("Atlas", role="orchestrator / system architect", kind="ai")
    with db_cursor() as (_, cur):
        found = core.find_orchestrator_agent(cur, cid)
    assert found == atlas["agent_id"]


async def test_find_orchestrator_agent_none_when_no_match(client, container, make_agent):
    """A container with only non-orchestrator agents (or none at all) must resolve to
    None gracefully — never raise, never guess."""
    cid = container["id"]
    await make_agent("worker-1", role="worker", kind="ai")
    with db_cursor() as (_, cur):
        found = core.find_orchestrator_agent(cur, cid)
    assert found is None


async def test_find_orchestrator_agent_ignores_terminated_and_human(
        client, container, make_agent, db):
    """A terminated former-orchestrator, and a HUMAN whose role happens to say
    'orchestrator', must never be picked — only a live kind='ai' agent counts."""
    cid = container["id"]
    dead = await make_agent("old-atlas", role="orchestrator", kind="ai")
    db.execute("UPDATE agents SET terminated_at=now() WHERE id=%s", (dead["agent_id"],))
    await make_agent("boss", role="orchestrator of humans", kind="human")
    with db_cursor() as (_, cur):
        found = core.find_orchestrator_agent(cur, cid)
    assert found is None


async def test_find_orchestrator_agent_deterministic_tie_break_oldest_first(
        client, container, make_agent):
    """Two orchestrator-roled agents: the oldest (by created_at, then id) wins, not
    whichever happens to be scanned last — the routing target must be stable."""
    cid = container["id"]
    first = await make_agent("Atlas-1", role="orchestrator / system architect", kind="ai")
    await make_agent("Atlas-2", role="orchestrator / system architect", kind="ai")
    with db_cursor() as (_, cur):
        found = core.find_orchestrator_agent(cur, cid)
    assert found == first["agent_id"]


async def test_slack_capture_unassigned_emits_exactly_one_orchestrator_event(
        client, container, make_agent, db):
    """Deliverable #1's slack-capture half: an UNASSIGNED slack-captured task must emit
    exactly one task_created_unassigned event, targeted at the orchestrator, with the
    task id + title in the payload — the doorbell the notifier's wake-scan reads."""
    cid = container["id"]
    reporter = await make_agent("reporter", kind="human")
    atlas = await make_agent("Atlas", role="orchestrator / system architect", kind="ai")

    with db_cursor() as (conn, cur):
        result = core.start_task_from_slack_capture(
            cur, cid,
            title="Unassigned slack capture",
            description="raw text",
            created_by_agent_id=reporter["agent_id"],
            assignee_agent_id=None,
        )
        conn.commit()

    rows = db.event_rows(atlas["agent_id"])
    triage_rows = [r for r in rows if r["event_name"] == "task_created_unassigned"]
    assert len(triage_rows) == 1
    payload = triage_rows[0]["payload"]
    assert payload["task_id"] == result["task_id"]
    assert payload["title"] == "Unassigned slack capture"


async def test_hub_start_unassigned_emits_exactly_one_orchestrator_event(
        client, container, make_agent, token_env, monkeypatch, db):
    """Deliverable #1's hub-start half: the real POST /github/start route, unassigned,
    must emit the same shape of event as the slack-capture path — one dispatch mechanism,
    one doorbell convention, regardless of which seam created the task."""
    cid = container["id"]
    await _bind_repo(client, cid)
    _capture_comment(monkeypatch)  # keep the GitHub round-trip comment a no-op leaf
    atlas = await make_agent("Atlas", role="orchestrator / system architect", kind="ai")

    r = await client.post(f"/api/containers/{cid}/github/start",
                          json={"kind": "issue", "number": 501, "title": "unrouted work"})
    assert r.status_code == 201, r.text
    tid = r.json()["task_id"]

    rows = db.event_rows(atlas["agent_id"])
    triage_rows = [row for row in rows if row["event_name"] == "task_created_unassigned"]
    assert len(triage_rows) == 1
    assert triage_rows[0]["payload"]["task_id"] == tid
    assert triage_rows[0]["payload"]["title"] == "GH #501: unrouted work"


async def test_assigned_start_emits_no_task_created_unassigned_event(
        client, container, make_agent, db):
    """Deliverable #3: an assigned-at-creation task is unchanged — it gets its existing
    targeted task_assigned wake and NOTHING of the new kind, from either dispatch path."""
    cid = container["id"]
    reporter = await make_agent("reporter", kind="human")
    atlas = await make_agent("Atlas", role="orchestrator / system architect", kind="ai")
    worker = await make_agent("worker-1", kind="ai")

    with db_cursor() as (conn, cur):
        core.start_task_from_slack_capture(
            cur, cid,
            title="Assigned capture",
            description="body",
            created_by_agent_id=reporter["agent_id"],
            assignee_agent_id=worker["agent_id"],
        )
        conn.commit()

    atlas_rows = db.event_rows(atlas["agent_id"])
    assert not any(r["event_name"] == "task_created_unassigned" for r in atlas_rows)
    worker_rows = db.event_rows(worker["agent_id"])
    assert any(r["event_name"] == "task_assigned" for r in worker_rows)
    assert not any(r["event_name"] == "task_created_unassigned" for r in worker_rows)


async def test_no_orchestrator_container_emits_nothing_and_does_not_fail(
        client, container, make_agent, db):
    """Deliverable #2: a container with no orchestrator-roled agent at all must not raise
    and must not emit any task_created_unassigned event anywhere — a silent, log-safe
    no-op, never an error that could break task creation."""
    cid = container["id"]
    reporter = await make_agent("reporter", kind="human")
    await make_agent("worker-1", role="worker", kind="ai")

    with db_cursor() as (conn, cur):
        result = core.start_task_from_slack_capture(
            cur, cid,
            title="No orchestrator here",
            description="raw text",
            created_by_agent_id=reporter["agent_id"],
            assignee_agent_id=None,
        )
        conn.commit()
    assert result["existing"] is False

    all_rows = db.execute(
        "SELECT * FROM agent_events WHERE event_name='task_created_unassigned'"
    )
    assert all_rows == []


async def test_wake_scan_reports_orchestrator_with_pending_event_after_unassigned_start(
        client, container, make_agent, db):
    """Integration tooth: after the event insert, the portal's OWN wake-scan for this
    container must report the orchestrator as a candidate with a pending event and
    should_wake True — proving the notifier's real wake machinery (not just a raw
    agent_events row) actually sees this doorbell on its next tick."""
    cid = container["id"]
    reporter = await make_agent("reporter", kind="human")
    atlas = await make_agent("Atlas", role="orchestrator / system architect", kind="ai")
    aid = atlas["agent_id"]

    with db_cursor() as (conn, cur):
        core.start_task_from_slack_capture(
            cur, cid,
            title="Route me please",
            description="raw text",
            created_by_agent_id=reporter["agent_id"],
            assignee_agent_id=None,
        )
        conn.commit()

    r = await client.get(f"/api/containers/{cid}/wake-scan",
                         params={"cooldown": 0, "min_idle": 0})
    assert r.status_code == 200, r.text
    body = r.json()
    cand = next((c for c in body["candidates"] if c["agent_id"] == aid), None)
    assert cand is not None
    assert cand["pending_events"] >= 1
    assert cand["latest_event"] == "task_created_unassigned"
    assert cand["should_wake"] is True


async def test_wake_scan_prompt_messages_carries_routing_directive_text(
        client, container, make_agent, db):
    """Founder refinement: waking the orchestrator is not enough on its own — the wake must
    carry an explicit ROUTING DIRECTIVE so the orchestrator knows to ASSIGN the best-fit
    specialist (never implement it itself). This is the actual rendering seam a woken agent
    reads: wake-scan's `prompt_messages`, built by directed_message_collection.collect_directed_messages
    (mirroring how a `task_assigned` event's text reaches the same field). Pins the literal
    instruction text so a future edit that silently drops the directive (e.g. reverting to a bare
    passive FYI, or omitting the "do not implement it yourself" clause) goes red."""
    cid = container["id"]
    reporter = await make_agent("reporter", kind="human")
    atlas = await make_agent("Atlas", role="orchestrator / system architect", kind="ai")
    aid = atlas["agent_id"]

    with db_cursor() as (conn, cur):
        result = core.start_task_from_slack_capture(
            cur, cid,
            title="Login button is broken",
            description="raw text",
            created_by_agent_id=reporter["agent_id"],
            assignee_agent_id=None,
        )
        conn.commit()
    tid = result["task_id"]

    r = await client.get(f"/api/containers/{cid}/wake-scan",
                         params={"cooldown": 0, "min_idle": 0})
    assert r.status_code == 200, r.text
    body = r.json()
    cand = next((c for c in body["candidates"] if c["agent_id"] == aid), None)
    assert cand is not None
    msgs = cand["prompt_messages"]
    directive = next((m for m in msgs if tid[:8] in m), None)
    assert directive is not None, f"no routing directive surfaced in prompt_messages: {msgs!r}"
    assert "Login button is broken" in directive
    assert "ROUTING" in directive
    assert "ASSIGN" in directive
    assert "best-fit" in directive
    assert "do not implement it yourself" in directive.lower()
    assert "assigning it wakes the assignee automatically" in directive.lower()


async def test_wake_scan_no_routing_directive_when_task_already_gone(
        client, container, make_agent, db):
    """A task_created_unassigned event whose task was completed/cancelled before the orchestrator
    ever wakes must NOT surface a stale routing directive (mirrors task_assigned's own terminal-task
    guard) — nothing left to route."""
    cid = container["id"]
    reporter = await make_agent("reporter", kind="human")
    atlas = await make_agent("Atlas", role="orchestrator / system architect", kind="ai")
    aid = atlas["agent_id"]

    with db_cursor() as (conn, cur):
        result = core.start_task_from_slack_capture(
            cur, cid,
            title="Stale before wake",
            description="raw text",
            created_by_agent_id=reporter["agent_id"],
            assignee_agent_id=None,
        )
        conn.commit()
    db.execute("UPDATE tasks SET status='cancelled' WHERE id=%s", (result["task_id"],))

    r = await client.get(f"/api/containers/{cid}/wake-scan",
                         params={"cooldown": 0, "min_idle": 0})
    assert r.status_code == 200, r.text
    cand = next(c for c in r.json()["candidates"] if c["agent_id"] == aid)
    assert not any("ROUTING" in m for m in cand["prompt_messages"])
