"""Slack trigger seam (Feature B) — signature verification, command parsing, the
unlinked-user path, start-via-Slack producing an identical task to a hub start (shared
internals), Block Kit composer coverage, and outbound needs_verification emission
gated on a configured webhook.

Nothing external is hit: the Slack signature is computed locally with the test secret,
the outbound webhook POST leaf (slack_notify._post_webhook) is monkeypatched, the
GitHub round-trip comment leaf (task_start_core._gh_post_comment) is stubbed
autouse (see test_task_start_core.py for its own dedicated coverage), and the
title-fetch leaf (github_hub_routes._gh_get) is stubbed per-test where the bug-fix
tests need a live-looking issue/PR title — no real network. The routes, signature
check, member mapping, and task-creation internals run for real.
"""
import hashlib
import hmac
import time
import urllib.parse

import pytest

from portal_backend import github_hub_routes as hub
from portal_backend import slack_files, slack_notify, slack_routes
from portal_backend import task_start_core as core

SIGNING_SECRET = "shhh-test-secret"
BOT_TOKEN = "xoxb-test"


@pytest.fixture
def slack_enabled(monkeypatch):
    monkeypatch.setenv("SLACK_SIGNING_SECRET", SIGNING_SECRET)
    monkeypatch.setenv("SLACK_BOT_TOKEN", BOT_TOKEN)


@pytest.fixture(autouse=True)
def _stub_start_comment(monkeypatch):
    """No test in this file exercises the GitHub round-trip comment itself (that lives
    in test_task_start_core.py) — stub the leaf so a bound repo + working token never
    makes a real network call as a side effect of testing something else."""
    monkeypatch.setattr(core, "_gh_post_comment", lambda repo, number, token, body: None)


@pytest.fixture(autouse=True)
def _run_background_inline(monkeypatch):
    """The ack-timing fix (fix/slack-ack-latency) moved shortcut/view_submission/
    block_actions' actual work behind `slack_routes._schedule_background` — production
    fires it as `asyncio.create_task(asyncio.to_thread(fn))`, AFTER the ack is already
    returned to Slack, so a real asyncio task would still be racing against the test's
    own assertions when `await client.post(...)` returns (httpx.ASGITransport does not
    wait out other scheduled tasks). Autouse + monkeypatched to run the closure INLINE
    and synchronously instead: every interactions test gets deterministic background
    completion by the time the response comes back, with no change to the assertions
    a pre-ack-fix test would have made on the FINAL STATE (DB rows, DM payloads) — only
    tests asserting on the SYNCHRONOUS RESPONSE BODY need rewriting (the ack shape
    itself legitimately changed)."""
    monkeypatch.setattr(slack_routes, "_schedule_background", lambda fn: fn())


@pytest.fixture(autouse=True)
def _no_llm_key_by_default(monkeypatch):
    """No workspace/env LLM key configured, by default, for every test in this file —
    `_refine_issue_for_filing` then fails closed (refined=False) exactly like a real
    unconfigured workspace, so a view_submission test that doesn't care about
    refinement gets the RAW title/body filed unchanged, matching this file's
    pre-refinement assertions, and never accidentally makes a live LLM call just
    because the machine running the suite happens to have ANTHROPIC_API_KEY set.
    Dedicated refinement tests override this by setting a key + stubbing
    `llm_util.classify` themselves."""
    monkeypatch.delenv("ORCHA_LLM_API_KEY", raising=False)
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    monkeypatch.delenv("XAI_API_KEY", raising=False)


@pytest.fixture
def token_env(monkeypatch, tmp_path):
    """Wire a legacy single installation-token file so _resolve_repo_token yields a
    token (the multi-org map is absent). Mirrors test_github_hub_routes.py's fixture —
    needed here so the Slack start path's live title-fetch has a token to resolve."""
    token_file = tmp_path / "github-token"
    token_file.write_text("ghs_slacktoken\n")
    monkeypatch.setenv("ORCHA_GITHUB_TOKEN_FILE", str(token_file))
    monkeypatch.delenv("ORCHA_GITHUB_TOKENS_FILE", raising=False)
    return "ghs_slacktoken"


async def _bind_repo(client, cid, repo="acme/site"):
    r = await client.put(f"/api/containers/{cid}/github", json={"repo": repo})
    assert r.status_code == 200, r.text


def _sign(body: str, ts=None):
    """Return (headers, raw_body) with a valid v0 signature for `body`."""
    ts = str(int(time.time())) if ts is None else str(ts)
    base = f"v0:{ts}:{body}".encode()
    digest = hmac.new(SIGNING_SECRET.encode(), base, hashlib.sha256).hexdigest()
    return {
        "X-Slack-Request-Timestamp": ts,
        "X-Slack-Signature": "v0=" + digest,
        "Content-Type": "application/x-www-form-urlencoded",
    }, body


def _form(**fields) -> str:
    return urllib.parse.urlencode(fields)


async def _link_slack_member(client, container, make_agent, db, slack_user_id, alias="ops",
                             container_id=None):
    """Create a live human member and link their Slack user id (mig 044). Defaults to
    the `container` fixture's container; pass `container_id` to link a member into a
    DIFFERENT container (e.g. comparing a hub-started task in one container against a
    Slack-started task in another)."""
    agent = await make_agent(alias, kind="human", container_id=container_id or container["id"])
    db.execute("UPDATE agents SET slack_user_id=%s WHERE id=%s",
               (slack_user_id, agent["agent_id"]))
    return agent["agent_id"]


# ------------------------- feature flag -------------------------

async def test_disabled_without_secrets_503(client, monkeypatch):
    monkeypatch.delenv("SLACK_SIGNING_SECRET", raising=False)
    monkeypatch.delenv("SLACK_BOT_TOKEN", raising=False)
    r = await client.post("/api/slack/commands", content="text=tasks")
    assert r.status_code == 503


async def test_disabled_with_only_one_secret(client, monkeypatch):
    monkeypatch.setenv("SLACK_SIGNING_SECRET", SIGNING_SECRET)
    monkeypatch.delenv("SLACK_BOT_TOKEN", raising=False)
    r = await client.post("/api/slack/commands", content="text=tasks")
    assert r.status_code == 503


# ------------------------- signature verification -------------------------

async def test_bad_signature_401(client, slack_enabled):
    headers, body = _sign(_form(user_id="U1", text="tasks"))
    headers["X-Slack-Signature"] = "v0=deadbeef"
    r = await client.post("/api/slack/commands", content=body, headers=headers)
    assert r.status_code == 401


async def test_missing_signature_401(client, slack_enabled):
    body = _form(user_id="U1", text="tasks")
    r = await client.post(
        "/api/slack/commands", content=body,
        headers={"Content-Type": "application/x-www-form-urlencoded"})
    assert r.status_code == 401


async def test_stale_timestamp_401(client, slack_enabled):
    # 10 minutes old → outside the ±300s replay window.
    headers, body = _sign(_form(user_id="U1", text="tasks"),
                          ts=int(time.time()) - 600)
    r = await client.post("/api/slack/commands", content=body, headers=headers)
    assert r.status_code == 401


async def test_verify_signature_unit_good_bad_stale():
    ts = str(int(time.time()))
    body = b"v0:x"
    good_base = b"v0:" + ts.encode() + b":" + body
    good_sig = "v0=" + hmac.new(SIGNING_SECRET.encode(), good_base,
                                hashlib.sha256).hexdigest()
    import os
    os.environ["SLACK_SIGNING_SECRET"] = SIGNING_SECRET
    try:
        assert slack_routes.verify_slack_signature(body, ts, good_sig) is True
        assert slack_routes.verify_slack_signature(body, ts, "v0=nope") is False
        stale = str(int(time.time()) - 999)
        stale_base = b"v0:" + stale.encode() + b":" + body
        stale_sig = "v0=" + hmac.new(SIGNING_SECRET.encode(), stale_base,
                                     hashlib.sha256).hexdigest()
        assert slack_routes.verify_slack_signature(body, stale, stale_sig) is False
    finally:
        del os.environ["SLACK_SIGNING_SECRET"]


# ------------------------- unlinked user -------------------------

async def test_unlinked_user_gets_ephemeral_link_prompt(client, slack_enabled):
    headers, body = _sign(_form(user_id="U-unknown", text="tasks"))
    r = await client.post("/api/slack/commands", content=body, headers=headers)
    assert r.status_code == 200, r.text
    j = r.json()
    assert j["response_type"] == "ephemeral"
    assert "link" in j["text"].lower()
    # Block Kit body: header + explainer + the "ask an owner" context line.
    header = j["blocks"][0]
    assert header["type"] == "header" and "Link your Slack" in header["text"]["text"]
    joined = " ".join(
        el["text"] for b in j["blocks"] for el in b.get("elements", [b.get("text", {})])
        if el and "text" in el
    )
    assert "ask an owner to link your Slack ID" in joined


# ------------------------- command parsing / start -------------------------

async def test_start_issue_via_slack(client, container, make_agent, db, slack_enabled):
    await _link_slack_member(client, container, make_agent, db, "U-linked")
    headers, body = _sign(_form(user_id="U-linked", text="start issue 42"))
    r = await client.post("/api/slack/commands", content=body, headers=headers)
    assert r.status_code == 200, r.text
    assert r.json()["response_type"] == "ephemeral"
    # A task GH #42 now exists in that member's container.
    listed = (await client.get(f"/api/containers/{container['id']}/tasks")).json()["tasks"]
    assert any(t["title"].startswith("GH #42:") for t in listed)


async def test_start_pr_via_slack(client, container, make_agent, db, slack_enabled):
    await _link_slack_member(client, container, make_agent, db, "U-linked")
    headers, body = _sign(_form(user_id="U-linked", text="start pr 9"))
    r = await client.post("/api/slack/commands", content=body, headers=headers)
    assert r.status_code == 200, r.text
    listed = (await client.get(f"/api/containers/{container['id']}/tasks")).json()["tasks"]
    t = [x for x in listed if x["title"].startswith("GH #9:")][0]
    assert "Resolve CI failures / review feedback on PR #9" in t["definition_of_done"]


# ------------------------- title bug: GH #232: #232 (live regression) -------------------------
#
# Production bug: `/orcha start issue 232` created a task titled "GH #232: #232" — the
# Slack path substituted the issue NUMBER where the issue TITLE belongs (slack_routes
# used to hardcode gh_title=f"#{number}" with no GitHub fetch at all). The hub path
# always composed correctly because its FRONTEND already has the real title in hand
# from the issue/PR list it just rendered and passes it straight through
# (github_hub_routes.GithubStartBody). The fix: slack_routes._fetch_gh_item does the
# ONE live GitHub fetch the hub gets for free, before calling the shared
# task_start_core.start_task_from_github — so both paths land on the SAME title.

def _fake_issue_get(number, title):
    def fake_get(path, token):
        assert path == f"/repos/acme/site/issues/{number}"
        return {"number": number, "title": title, "html_url": f"https://github.com/acme/site/issues/{number}",
                "body": "the issue body"}
    return fake_get


def _fake_pull_get(number, title):
    def fake_get(path, token):
        assert path == f"/repos/acme/site/pulls/{number}"
        return {"number": number, "title": title, "html_url": f"https://github.com/acme/site/pulls/{number}",
                "body": "the pr body"}
    return fake_get


async def test_slack_start_issue_uses_real_title_not_number(
        client, container, make_agent, db, slack_enabled, token_env, monkeypatch):
    """The regression test: a slack-started issue task's title carries the real GitHub
    title ('Clinician dashboard: …'), never the bare number-as-title
    ('GH #232: #232') the production bug produced. Revert the _fetch_gh_item wiring
    in slack_routes._handle_command and this goes red."""
    await _bind_repo(client, container["id"])
    monkeypatch.setattr(hub, "_gh_get", _fake_issue_get(232, "Clinician dashboard: add filters"))
    await _link_slack_member(client, container, make_agent, db, "U-linked")
    headers, body = _sign(_form(user_id="U-linked", text="start issue 232"))
    r = await client.post("/api/slack/commands", content=body, headers=headers)
    assert r.status_code == 200, r.text

    listed = (await client.get(f"/api/containers/{container['id']}/tasks")).json()["tasks"]
    t = [x for x in listed if x["title"].startswith("GH #232:")][0]
    assert t["title"] == "GH #232: Clinician dashboard: add filters"
    assert t["title"] != "GH #232: #232"  # the exact production bug shape


async def test_slack_started_title_matches_hub_started_title_same_issue(
        client, container, make_agent, db, slack_enabled, token_env, monkeypatch):
    """Test-teeth for the bug: for the SAME fixture issue, a hub start (which gets the
    title from its request body, as the frontend would supply it) and a Slack start
    (which now live-fetches it) land on the IDENTICAL title. Different container so the
    hub 'client-supplied title' and the Slack 'live-fetched title' are the two ONLY
    sources of truth being compared — both must agree because both ultimately describe
    GH issue #232 in this fixture repo."""
    cid = container["id"]
    await _bind_repo(client, cid)
    real_title = "Clinician dashboard: add filters"
    monkeypatch.setattr(hub, "_gh_get", _fake_issue_get(232, real_title))

    # Hub start: the frontend already fetched the issue list and supplies the title.
    hub_r = await client.post(f"/api/containers/{cid}/github/start",
                              json={"kind": "issue", "number": 232, "title": real_title})
    assert hub_r.status_code == 201, hub_r.text

    # A fresh container for the Slack side so idempotency doesn't merge the two hits
    # on the SAME GH #232 (both would resolve to the same open-task probe otherwise).
    # additional=true is required past the first container (Orcha#28's 1:1:1 stack
    # contract; the portal's own "New project" flow passes this too).
    c2 = await client.post("/api/containers", json={"name": "slack-side", "additional": True})
    assert c2.status_code == 201, c2.text
    cid2 = c2.json()["container_id"]
    await _bind_repo(client, cid2)
    await _link_slack_member(client, container, make_agent, db, "U-linked2", alias="ops2",
                             container_id=cid2)
    headers, body = _sign(_form(user_id="U-linked2", text="start issue 232"))
    slack_r = await client.post("/api/slack/commands", content=body, headers=headers)
    assert slack_r.status_code == 200, slack_r.text

    hub_listed = (await client.get(f"/api/containers/{cid}/tasks")).json()["tasks"]
    slack_listed = (await client.get(f"/api/containers/{cid2}/tasks")).json()["tasks"]
    hub_t = [x for x in hub_listed if x["title"].startswith("GH #232:")][0]
    slack_t = [x for x in slack_listed if x["title"].startswith("GH #232:")][0]
    assert hub_t["title"] == slack_t["title"] == "GH #232: Clinician dashboard: add filters"


async def test_slack_start_pull_uses_real_title(
        client, container, make_agent, db, slack_enabled, token_env, monkeypatch):
    await _bind_repo(client, container["id"])
    monkeypatch.setattr(hub, "_gh_get", _fake_pull_get(55, "Fix retry backoff"))
    await _link_slack_member(client, container, make_agent, db, "U-linked")
    headers, body = _sign(_form(user_id="U-linked", text="start pr 55"))
    r = await client.post("/api/slack/commands", content=body, headers=headers)
    assert r.status_code == 200, r.text
    listed = (await client.get(f"/api/containers/{container['id']}/tasks")).json()["tasks"]
    t = [x for x in listed if x["title"].startswith("GH #55:")][0]
    assert t["title"] == "GH #55: Fix retry backoff"


async def test_slack_started_task_shows_tracked_on_hub_list_without_a_click(
        client, container, make_agent, db, slack_enabled, token_env, monkeypatch):
    """Founder-caught gap, closed: issue #232 started via Slack must show as tracked on
    the hub's OWN list endpoint immediately — not just after a hub click that would
    itself bounce off {existing:true}. Proves the cross-seam link: a Slack start
    populates tracked_task_id on github_hub_routes' list route, which never even ran
    task creation itself — only task_start_core.find_open_gh_tasks did, and both
    seams share that ONE function."""
    cid = container["id"]
    await _bind_repo(client, cid)
    real_title = "Clinician dashboard: add filters"

    def fake_get(path, token):
        # Serves BOTH shapes _gh_get is asked for here: the Slack start's single-item
        # detail fetch, and the hub list's bulk fetch — a real GitHub token would
        # equally answer either path against the same underlying issue.
        if path == "/repos/acme/site/issues/232":
            return {"number": 232, "title": real_title,
                    "html_url": "https://github.com/acme/site/issues/232", "body": ""}
        return [{"number": 232, "title": real_title,
                "html_url": "https://github.com/acme/site/issues/232"}]

    monkeypatch.setattr(hub, "_gh_get", fake_get)
    await _link_slack_member(client, container, make_agent, db, "U-linked")
    headers, body = _sign(_form(user_id="U-linked", text="start issue 232"))
    r = await client.post("/api/slack/commands", content=body, headers=headers)
    assert r.status_code == 200, r.text

    # The hub's OWN issues list — a completely separate route from /orcha start —
    # must already show #232 as tracked, no Start click required.
    list_r = await client.get(f"/api/containers/{cid}/github/issues")
    assert list_r.status_code == 200, list_r.text
    by_number = {it["number"]: it for it in list_r.json()["issues"]}
    assert by_number[232]["tracked_task_id"] is not None

    listed = (await client.get(f"/api/containers/{cid}/tasks")).json()["tasks"]
    t = [x for x in listed if x["title"].startswith("GH #232:")][0]
    assert by_number[232]["tracked_task_id"] == t["id"]


async def test_slack_start_falls_back_to_bare_number_when_github_unreachable(
        client, container, make_agent, db, slack_enabled, token_env, monkeypatch):
    """The live fetch failing (rate-limited / 404 / network) must never break the
    3s-contract slash command — it degrades to the old '#N' placeholder title rather
    than erroring the whole dispatch."""
    await _bind_repo(client, container["id"])

    def boom(path, token):
        raise RuntimeError("github_status:403")

    monkeypatch.setattr(hub, "_gh_get", boom)
    await _link_slack_member(client, container, make_agent, db, "U-linked")
    headers, body = _sign(_form(user_id="U-linked", text="start issue 909"))
    r = await client.post("/api/slack/commands", content=body, headers=headers)
    assert r.status_code == 200, r.text
    listed = (await client.get(f"/api/containers/{container['id']}/tasks")).json()["tasks"]
    t = [x for x in listed if x["title"].startswith("GH #909:")][0]
    assert t["title"] == "GH #909: #909"  # degraded fallback, not a failure


async def test_slack_start_without_bound_repo_falls_back_to_bare_number(
        client, container, make_agent, db, slack_enabled):
    """No repo bound at all (the common case pre-GitHub-hub-setup) — same graceful
    fallback, no crash, no GitHub call attempted."""
    await _link_slack_member(client, container, make_agent, db, "U-linked")
    headers, body = _sign(_form(user_id="U-linked", text="start issue 5"))
    r = await client.post("/api/slack/commands", content=body, headers=headers)
    assert r.status_code == 200, r.text
    listed = (await client.get(f"/api/containers/{container['id']}/tasks")).json()["tasks"]
    t = [x for x in listed if x["title"].startswith("GH #5:")][0]
    assert t["title"] == "GH #5: #5"


# ------------------------- Block Kit: start success / already tracked -------------------------

async def test_slack_start_success_block_shape(
        client, container, make_agent, db, slack_enabled, token_env, monkeypatch):
    await _bind_repo(client, container["id"])
    monkeypatch.setattr(hub, "_gh_get", _fake_issue_get(232, "Clinician dashboard"))
    monkeypatch.setenv("ORCHA_PORTAL_BASE_URL", "https://app.example.com")
    await _link_slack_member(client, container, make_agent, db, "U-linked")
    headers, body = _sign(_form(user_id="U-linked", text="start issue 232"))
    r = await client.post("/api/slack/commands", content=body, headers=headers)
    j = r.json()
    blocks = j["blocks"]
    assert blocks[0]["type"] == "header"
    assert blocks[0]["text"]["text"] == "🚀 Task started"
    section_text = blocks[1]["text"]["text"]
    assert "<https://github.com/acme/site/issues/232|#232 Clinician dashboard>" in section_text
    ctx_text = blocks[2]["elements"][0]["text"]
    assert "assigned: Atlas routes it" in ctx_text
    assert "a human verifies before anything merges" in ctx_text
    button = blocks[3]["elements"][0]
    assert button["text"]["text"] == "Open task in Orcha"
    assert button["url"].startswith("https://app.example.com/tasks?cid=")
    assert "task=" in button["url"]


async def test_slack_already_tracked_block_shape(
        client, container, make_agent, db, slack_enabled, token_env, monkeypatch):
    await _bind_repo(client, container["id"])
    monkeypatch.setattr(hub, "_gh_get", _fake_issue_get(70, "dup"))
    monkeypatch.setenv("ORCHA_PORTAL_BASE_URL", "https://app.example.com")
    await _link_slack_member(client, container, make_agent, db, "U-linked")
    for _ in range(2):
        headers, body = _sign(_form(user_id="U-linked", text="start issue 70"))
        r = await client.post("/api/slack/commands", content=body, headers=headers)
    j = r.json()
    assert j["blocks"][0]["text"]["text"] == "↩️ Already tracked"
    assert "already has an open Orcha task" in j["blocks"][1]["text"]["text"]
    button = j["blocks"][2]["elements"][0]
    assert button["text"]["text"] == "Open task in Orcha"


async def test_slack_start_idempotent(client, container, make_agent, db, slack_enabled):
    await _link_slack_member(client, container, make_agent, db, "U-linked")
    for _ in range(2):
        headers, body = _sign(_form(user_id="U-linked", text="start issue 7"))
        r = await client.post("/api/slack/commands", content=body, headers=headers)
        assert r.status_code == 200
    listed = (await client.get(f"/api/containers/{container['id']}/tasks")).json()["tasks"]
    assert sum(1 for t in listed if t["title"].startswith("GH #7:")) == 1


async def test_slack_start_identical_to_hub_start(client, container, make_agent, db, slack_enabled):
    """The shared-internals proof: a Slack `start issue N` and the hub's POST /github/start
    for the same N produce a task with the SAME title + definition_of_done template. (Run
    against different numbers so idempotency doesn't merge them.)"""
    await _link_slack_member(client, container, make_agent, db, "U-linked")
    cid = container["id"]
    # hub start (#100)
    hub_r = await client.post(f"/api/containers/{cid}/github/start",
                              json={"kind": "issue", "number": 100})
    # slack start (#101)
    headers, body = _sign(_form(user_id="U-linked", text="start issue 101"))
    await client.post("/api/slack/commands", content=body, headers=headers)

    listed = (await client.get(f"/api/containers/{cid}/tasks")).json()["tasks"]
    hub_t = [t for t in listed if t["title"].startswith("GH #100:")][0]
    slk_t = [t for t in listed if t["title"].startswith("GH #101:")][0]
    # Same DoD TEMPLATE (differing only in the number).
    assert hub_t["definition_of_done"].replace("100", "N") == \
           slk_t["definition_of_done"].replace("101", "N")


async def test_tasks_summary(client, container, make_agent, make_task, db, slack_enabled):
    await _link_slack_member(client, container, make_agent, db, "U-linked")
    t = await make_task("ship", "shipped")
    db.execute("UPDATE tasks SET status='needs_verification' WHERE id=%s", (t["id"],))
    headers, body = _sign(_form(user_id="U-linked", text="tasks"))
    r = await client.post("/api/slack/commands", content=body, headers=headers)
    assert r.status_code == 200
    j = r.json()
    assert j["blocks"][0]["text"]["text"] == "🔔 Needs you"
    body_text = j["blocks"][1]["text"]["text"]
    assert "To verify (1)" in body_text
    assert "ship" in body_text


async def test_tasks_summary_zero_state_matches_portal_phrasing(
        client, container, make_agent, db, slack_enabled):
    """Nothing needs attention → the exact phrasing home-state.js's own zero-state
    uses ('✓ Nothing needs you right now.') so the copy matches across surfaces."""
    await _link_slack_member(client, container, make_agent, db, "U-linked")
    headers, body = _sign(_form(user_id="U-linked", text="tasks"))
    r = await client.post("/api/slack/commands", content=body, headers=headers)
    assert r.status_code == 200
    j = r.json()
    assert j["blocks"][1]["text"]["text"] == "✓ Nothing needs you right now."


async def test_unknown_command_help(client, container, make_agent, db, slack_enabled):
    await _link_slack_member(client, container, make_agent, db, "U-linked")
    headers, body = _sign(_form(user_id="U-linked", text="frobnicate"))
    r = await client.post("/api/slack/commands", content=body, headers=headers)
    assert r.status_code == 200
    j = r.json()
    body_text = j["blocks"][1]["text"]["text"]
    assert "/orcha start issue <N>" in body_text
    assert "/orcha start pr <N>" in body_text
    assert "/orcha tasks" in body_text


# ------------------------- Block Kit composers: pure-function unit tests -------------------------
#
# Every composer in slack_notify.py is a pure function (data in -> block array out) —
# these tests assert the JSON structure directly, no client/DB/network involved.

def test_mrkdwn_escape_angle_brackets_and_ampersand():
    """A title containing <, >, & must not corrupt Slack's mrkdwn link/mention syntax."""
    raw = "Fix <script> handling & the > operator"
    escaped = slack_notify._mrkdwn_escape(raw)
    assert escaped == "Fix &lt;script&gt; handling &amp; the &gt; operator"
    assert "<" not in escaped and ">" not in escaped
    # & must be escaped FIRST (Slack's documented order) or a literal '&amp;' would
    # itself get re-escaped into '&amp;amp;' — assert the escape ran exactly once.
    assert "&amp;amp;" not in escaped


def test_mrkdwn_link_escapes_visible_text_not_url():
    link = slack_notify._mrkdwn_link("https://x.test/1", "Fix <a> & <b>")
    assert link == "<https://x.test/1|Fix &lt;a&gt; &amp; &lt;b&gt;>"


def test_blocks_start_success_structure():
    blocks = slack_notify.blocks_start_success(
        "issue", 232, "https://github.com/acme/site/issues/232",
        "Clinician dashboard", "https://app.example.com/tasks?cid=c1&task=t1",
    )
    assert blocks[0] == {"type": "header",
                         "text": {"type": "plain_text", "text": "🚀 Task started"}}
    assert blocks[1]["type"] == "section"
    assert blocks[1]["text"]["type"] == "mrkdwn"
    assert "<https://github.com/acme/site/issues/232|#232 Clinician dashboard>" \
        in blocks[1]["text"]["text"]
    assert blocks[2]["type"] == "context"
    ctx = blocks[2]["elements"][0]["text"]
    assert "assigned: Atlas routes it" in ctx and "a human verifies before anything merges" in ctx
    assert blocks[3]["type"] == "actions"
    button = blocks[3]["elements"][0]
    assert button["type"] == "button"
    assert button["text"]["text"] == "Open task in Orcha"
    assert button["url"] == "https://app.example.com/tasks?cid=c1&task=t1"


def test_blocks_start_success_escapes_title_with_angle_brackets():
    blocks = slack_notify.blocks_start_success(
        "issue", 1, "https://github.com/acme/site/issues/1",
        "Handle <input> & fix", None,
    )
    assert "&lt;input&gt;" in blocks[1]["text"]["text"]
    assert "<input>" not in blocks[1]["text"]["text"]


def test_blocks_start_success_no_link_omits_button_and_falls_back_to_plain_text():
    blocks = slack_notify.blocks_start_success("issue", 909, "", "#909", None)
    assert not any(b["type"] == "actions" for b in blocks)
    assert "#909" in blocks[1]["text"]["text"]
    assert "<" not in blocks[1]["text"]["text"] or "|" not in blocks[1]["text"]["text"]


def test_blocks_already_tracked_structure():
    blocks = slack_notify.blocks_already_tracked("PR", 9, "https://app.example.com/tasks?cid=c&task=t")
    assert blocks[0]["text"]["text"] == "↩️ Already tracked"
    assert "PR #9" in blocks[1]["text"]["text"]
    assert blocks[2]["elements"][0]["url"] == "https://app.example.com/tasks?cid=c&task=t"


def test_blocks_unlinked_user_structure():
    blocks = slack_notify.blocks_unlinked_user()
    assert blocks[0]["text"]["text"] == "🔗 Link your Slack account"
    assert blocks[-1]["type"] == "context"
    assert "ask an owner to link your Slack ID" in blocks[-1]["elements"][0]["text"]


def test_blocks_usage_help_lists_three_commands():
    blocks = slack_notify.blocks_usage_help()
    text = blocks[1]["text"]["text"]
    assert "/orcha start issue <N>" in text
    assert "/orcha start pr <N>" in text
    assert "/orcha tasks" in text


def test_blocks_tasks_summary_zero_state():
    blocks = slack_notify.blocks_tasks_summary([], 0, 0, lambda tid: None)
    assert blocks[0]["text"]["text"] == "🔔 Needs you"
    assert blocks[1]["text"]["text"] == "✓ Nothing needs you right now."


def test_blocks_tasks_summary_lists_up_to_five_links_and_counts():
    tasks = [{"id": f"t{i}", "title": f"task {i}"} for i in range(7)]
    blocks = slack_notify.blocks_tasks_summary(
        tasks, open_requests_count=3, ready_unassigned_count=2,
        task_link_fn=lambda tid: f"https://app.example.com/tasks?task={tid}",
    )
    body = blocks[1]["text"]["text"]
    assert "To verify (7)" in body   # the COUNT reflects the full set…
    for i in range(5):
        assert f"<https://app.example.com/tasks?task=t{i}|task {i}>" in body
    for i in range(5, 7):
        assert f"task {i}" not in body   # …but only the first 5 are LINKED/listed
    ctx = blocks[2]["elements"][0]["text"]
    assert "Open requests (3)" in ctx
    assert "Ready · unassigned (2)" in ctx


def test_blocks_tasks_summary_escapes_titles_with_angle_brackets():
    blocks = slack_notify.blocks_tasks_summary(
        [{"id": "t1", "title": "Fix <script> & tags"}], 0, 0,
        lambda tid: "https://app.example.com/tasks?task=t1",
    )
    body = blocks[1]["text"]["text"]
    assert "&lt;script&gt;" in body
    assert "<script>" not in body


def test_blocks_needs_verification_structure():
    blocks = slack_notify.blocks_needs_verification(
        "Acme", "Ship the thing", "https://app.example.com/tasks?cid=c&task=t",
        project_name="Acme", agent_alias="atlas",
    )
    assert blocks[0] == {"type": "header",
                         "text": {"type": "plain_text", "text": "🛡️ Needs your verification"}}
    assert "<https://app.example.com/tasks?cid=c&task=t|Ship the thing>" in blocks[1]["text"]["text"]
    ctx = blocks[2]["elements"][0]["text"]
    assert "Acme" in ctx and "atlas" in ctx
    button = blocks[3]["elements"][0]
    assert button["text"]["text"] == "Verify in Orcha"
    assert button["style"] == "primary"
    assert button["url"] == "https://app.example.com/tasks?cid=c&task=t"
    # ONE message: header + section + context + one actions block, nothing more.
    assert len(blocks) == 4


def test_blocks_needs_verification_escapes_title():
    blocks = slack_notify.blocks_needs_verification(
        "Acme", "Fix <b>bold</b> & such", None,
    )
    assert "&lt;b&gt;" in blocks[1]["text"]["text"]
    assert "<b>" not in blocks[1]["text"]["text"]


def test_portal_task_link_uses_extensionless_tasks_route_not_tasks_html():
    """Regression: the portal serves the extensionless /tasks route
    (dashboard_routes.tasks_page) — static files are mounted at /assets, not the site
    root, so a literal '/tasks.html' path 404s. A Slack button pointing at it would be
    dead on arrival."""
    import os
    old = os.environ.get(slack_notify.PORTAL_BASE_URL_ENV)
    os.environ[slack_notify.PORTAL_BASE_URL_ENV] = "https://app.example.com"
    try:
        link = slack_notify.portal_task_link("c1", "t1")
    finally:
        if old is None:
            os.environ.pop(slack_notify.PORTAL_BASE_URL_ENV, None)
        else:
            os.environ[slack_notify.PORTAL_BASE_URL_ENV] = old
    assert link == "https://app.example.com/tasks?cid=c1&task=t1"
    assert ".html" not in link


def test_portal_task_link_none_without_base_url(monkeypatch):
    monkeypatch.delenv(slack_notify.PORTAL_BASE_URL_ENV, raising=False)
    assert slack_notify.portal_task_link("c1", "t1") is None


# ------------------------- outbound on needs_verification -------------------------

async def _drive_task_to_needs_verification(client, container, make_agent, work_headers):
    """Create + assign + start + mark done a task so it parks at needs_verification
    (plan autonomy default). Returns (cid, tid)."""
    cid = container["id"]
    agent = await make_agent("w1", kind="ai")
    aid = agent["agent_id"]
    # create assigned → in_progress
    r = await client.post(f"/api/containers/{cid}/tasks",
                          json={"title": "do it", "definition_of_done": "done",
                                "assignee_alias": "w1"})
    tid = r.json()["task_id"]
    headers = await work_headers(aid)
    r = await client.post(f"/api/tasks/{tid}/done",
                          json={"agent_id": aid, "result": "ok"}, headers=headers)
    assert r.status_code == 200 and r.json()["status"] == "needs_verification", r.text
    return cid, tid


async def test_outbound_fires_when_webhook_configured(
        client, container, make_agent, work_headers, db, monkeypatch):
    posted = {}

    def fake_post(url, payload):
        posted["url"] = url
        posted["payload"] = payload

    monkeypatch.setattr(slack_notify, "_post_webhook", fake_post)
    monkeypatch.setenv("ORCHA_PORTAL_BASE_URL", "https://app.example.com")
    cid = container["id"]
    db.execute("UPDATE containers SET slack_webhook_url=%s WHERE id=%s",
               ("https://hooks.slack.com/services/T/B/x", cid))
    _, tid = await _drive_task_to_needs_verification(client, container, make_agent, work_headers)
    assert posted.get("url") == "https://hooks.slack.com/services/T/B/x"
    assert "blocks" in posted["payload"]
    # the Block Kit message references the task and offers verification
    assert "Needs verification" in posted["payload"]["text"]
    blocks = posted["payload"]["blocks"]
    assert blocks[0]["text"]["text"] == "🛡️ Needs your verification"
    # the working agent's alias ("w1", from _drive_task_to_needs_verification) rides
    # the muted context line alongside the project name.
    ctx = blocks[2]["elements"][0]["text"]
    assert "w1" in ctx
    assert blocks[-1]["elements"][0]["text"]["text"] == "Verify in Orcha"


async def test_outbound_silent_without_webhook(
        client, container, make_agent, work_headers, db, monkeypatch):
    calls = {"n": 0}
    monkeypatch.setattr(slack_notify, "_post_webhook",
                        lambda url, payload: calls.__setitem__("n", calls["n"] + 1))
    # no slack_webhook_url configured → no POST
    await _drive_task_to_needs_verification(client, container, make_agent, work_headers)
    assert calls["n"] == 0


async def test_outbound_failure_never_breaks_transition(
        client, container, make_agent, work_headers, db, monkeypatch):
    def boom(url, payload):
        raise RuntimeError("slack is down")

    monkeypatch.setattr(slack_notify, "_post_webhook", boom)
    cid = container["id"]
    db.execute("UPDATE containers SET slack_webhook_url=%s WHERE id=%s",
               ("https://hooks.slack.com/services/T/B/x", cid))
    # The transition must still succeed (the /done returns needs_verification) despite
    # the webhook POST raising — proven by _drive_task_to_needs_verification's asserts.
    _, tid = await _drive_task_to_needs_verification(client, container, make_agent, work_headers)
    rows = db.execute("SELECT status FROM tasks WHERE id=%s", (tid,))
    assert rows[0]["status"] == "needs_verification"


# ====================================================================================
# Feature: create GitHub issues from Slack
#   (1) /orcha issue <title> [-- <body>] slash command
#   (2) "Create GitHub issue" / "Create Orcha task" message shortcuts via
#       POST /api/slack/interactions (shortcut -> modal -> view_submission)
# ====================================================================================

import json as _json


def _fake_issue_post(number=501, title="issue title", html_url=None):
    """A fake `_gh_post_issue` leaf: asserts the POST shape, returns a GitHub-looking
    issue payload. `html_url` defaults to a URL derived from `number`."""
    calls = []

    def fake(repo, token, title_arg, body_arg):
        calls.append({"repo": repo, "token": token, "title": title_arg, "body": body_arg})
        return {
            "number": number,
            "title": title_arg,
            "html_url": html_url or f"https://github.com/{repo}/issues/{number}",
            "body": body_arg,
        }
    fake.calls = calls
    return fake


def _payload_form(payload: dict) -> str:
    """Slack's interactions body shape: form-encoded with a single `payload` field
    holding the JSON blob (never raw JSON)."""
    return urllib.parse.urlencode({"payload": _json.dumps(payload)})


# ------------------------- /orcha issue: command parsing -------------------------

def test_parse_issue_command_title_only():
    assert slack_routes._parse_issue_command("Login button broken") == \
        ("Login button broken", "")


def test_parse_issue_command_title_and_body():
    assert slack_routes._parse_issue_command(
        "Login button broken -- happens only on Safari"
    ) == ("Login button broken", "happens only on Safari")


def test_parse_issue_command_empty_title_rejected():
    assert slack_routes._parse_issue_command("   ") == (None, None)
    assert slack_routes._parse_issue_command("") == (None, None)


def test_parse_issue_command_title_with_literal_hyphens_not_split():
    # Only the ' -- ' (space-dash-dash-space) token is the separator; a bare '-' or a
    # word like 'well-known' must not be mistaken for it.
    title, body = slack_routes._parse_issue_command("Fix well-known-file handling")
    assert title == "Fix well-known-file handling"
    assert body == ""


def test_parse_issue_command_only_first_separator_splits():
    title, body = slack_routes._parse_issue_command("A -- B -- C")
    assert title == "A"
    assert body == "B -- C"


# ------------------------- /orcha issue: end-to-end via the slash command -------------------------

async def test_orcha_issue_empty_title_returns_usage(client, container, make_agent, db, slack_enabled):
    await _link_slack_member(client, container, make_agent, db, "U-linked")
    headers, body = _sign(_form(user_id="U-linked", text="issue"))
    r = await client.post("/api/slack/commands", content=body, headers=headers)
    assert r.status_code == 200, r.text
    j = r.json()
    assert "Usage: /orcha issue" in j["blocks"][0]["text"]["text"]


async def test_orcha_issue_whitespace_title_returns_usage(client, container, make_agent, db, slack_enabled):
    await _link_slack_member(client, container, make_agent, db, "U-linked")
    headers, body = _sign(_form(user_id="U-linked", text="issue    "))
    r = await client.post("/api/slack/commands", content=body, headers=headers)
    assert r.status_code == 200, r.text
    assert "Usage: /orcha issue" in r.json()["blocks"][0]["text"]["text"]


async def test_orcha_issue_creates_issue_with_footer(
        client, container, make_agent, db, slack_enabled, token_env, monkeypatch):
    await _bind_repo(client, container["id"])
    fake = _fake_issue_post(number=77, title="Fix the thing")
    monkeypatch.setattr(slack_routes, "_gh_post_issue", fake)
    agent_id = await _link_slack_member(client, container, make_agent, db, "U-linked")
    db.execute("UPDATE agents SET github_login=%s WHERE id=%s", ("octocat", agent_id))

    headers, body = _sign(_form(user_id="U-linked", text="issue Fix the thing -- extra detail here"))
    r = await client.post("/api/slack/commands", content=body, headers=headers)
    assert r.status_code == 200, r.text

    assert len(fake.calls) == 1
    call = fake.calls[0]
    assert call["repo"] == "acme/site"
    assert call["title"] == "Fix the thing"
    assert "extra detail here" in call["body"]
    assert "_Filed from Slack by octocat via Orcha_" in call["body"]

    j = r.json()
    assert j["blocks"][0]["text"]["text"] == "📝 Issue filed"
    section_text = j["blocks"][1]["text"]["text"]
    assert "#77 Fix the thing" in section_text
    # A REAL interactive Start button (not a hint to run a command) since the
    # interactions endpoint ships in this same PR.
    actions = j["blocks"][-1]["elements"]
    action_ids = [el.get("action_id") for el in actions if "action_id" in el]
    assert slack_routes.START_ISSUE_ACTION_ID in action_ids
    start_btn = [el for el in actions if el.get("action_id") == slack_routes.START_ISSUE_ACTION_ID][0]
    assert start_btn["value"] == "77"


async def test_orcha_issue_footer_falls_back_to_alias_without_github_login(
        client, container, make_agent, db, slack_enabled, token_env, monkeypatch):
    await _bind_repo(client, container["id"])
    fake = _fake_issue_post(number=1)
    monkeypatch.setattr(slack_routes, "_gh_post_issue", fake)
    await _link_slack_member(client, container, make_agent, db, "U-linked", alias="opsy")
    headers, body = _sign(_form(user_id="U-linked", text="issue No login on file"))
    r = await client.post("/api/slack/commands", content=body, headers=headers)
    assert r.status_code == 200, r.text
    assert "_Filed from Slack by opsy via Orcha_" in fake.calls[0]["body"]


async def test_orcha_issue_no_body_footer_only(
        client, container, make_agent, db, slack_enabled, token_env, monkeypatch):
    await _bind_repo(client, container["id"])
    fake = _fake_issue_post(number=2)
    monkeypatch.setattr(slack_routes, "_gh_post_issue", fake)
    await _link_slack_member(client, container, make_agent, db, "U-linked")
    headers, body = _sign(_form(user_id="U-linked", text="issue Title only, no body"))
    r = await client.post("/api/slack/commands", content=body, headers=headers)
    assert r.status_code == 200, r.text
    assert fake.calls[0]["body"].strip().startswith("_Filed from Slack by")


async def test_orcha_issue_403_shows_friendly_permission_card(
        client, container, make_agent, db, slack_enabled, token_env, monkeypatch):
    await _bind_repo(client, container["id"])

    def forbidden(repo, token, title, body):
        raise slack_routes.GithubPermissionError("403")

    monkeypatch.setattr(slack_routes, "_gh_post_issue", forbidden)
    await _link_slack_member(client, container, make_agent, db, "U-linked")
    headers, body = _sign(_form(user_id="U-linked", text="issue This will 403"))
    r = await client.post("/api/slack/commands", content=body, headers=headers)
    assert r.status_code == 200, r.text  # never a raw error / stack trace
    j = r.json()
    assert j["blocks"][0]["text"]["text"] == "🔒 Can't file that issue"
    assert "Issues: Read and write" in j["blocks"][1]["text"]["text"]


async def test_orcha_issue_no_repo_bound_shows_friendly_card(
        client, container, make_agent, db, slack_enabled):
    await _link_slack_member(client, container, make_agent, db, "U-linked")
    headers, body = _sign(_form(user_id="U-linked", text="issue No repo bound here"))
    r = await client.post("/api/slack/commands", content=body, headers=headers)
    assert r.status_code == 200, r.text
    assert r.json()["blocks"][0]["text"]["text"] == "🔒 Can't file that issue"


async def test_orcha_issue_generic_github_failure_shows_friendly_card_not_500(
        client, container, make_agent, db, slack_enabled, token_env, monkeypatch):
    await _bind_repo(client, container["id"])

    def unreachable(repo, token, title, body):
        raise RuntimeError("github_status:500")

    monkeypatch.setattr(slack_routes, "_gh_post_issue", unreachable)
    await _link_slack_member(client, container, make_agent, db, "U-linked")
    headers, body = _sign(_form(user_id="U-linked", text="issue Will blow up"))
    r = await client.post("/api/slack/commands", content=body, headers=headers)
    assert r.status_code == 200, r.text
    assert "Couldn't file" in r.json()["blocks"][0]["text"]["text"]


async def test_orcha_issue_gated_by_linked_member(client, container, slack_enabled):
    headers, body = _sign(_form(user_id="U-unknown", text="issue Some title"))
    r = await client.post("/api/slack/commands", content=body, headers=headers)
    assert r.status_code == 200, r.text
    assert "link" in r.json()["text"].lower()


async def test_usage_help_lists_orcha_issue(client, container, make_agent, db, slack_enabled):
    await _link_slack_member(client, container, make_agent, db, "U-linked")
    headers, body = _sign(_form(user_id="U-linked", text="frobnicate"))
    r = await client.post("/api/slack/commands", content=body, headers=headers)
    body_text = r.json()["blocks"][1]["text"]["text"]
    assert "/orcha issue <title> [-- <body>]" in body_text


# ------------------------- POST /api/slack/interactions: plumbing -------------------------

async def test_interactions_disabled_without_secrets_503(client, monkeypatch):
    monkeypatch.delenv("SLACK_SIGNING_SECRET", raising=False)
    monkeypatch.delenv("SLACK_BOT_TOKEN", raising=False)
    r = await client.post("/api/slack/interactions", content="payload=%7B%7D")
    assert r.status_code == 503


async def test_interactions_bad_signature_401(client, slack_enabled):
    body = _payload_form({"type": "block_actions"})
    headers, body = _sign(body)
    headers["X-Slack-Signature"] = "v0=deadbeef"
    r = await client.post("/api/slack/interactions", content=body, headers=headers)
    assert r.status_code == 401


async def test_interactions_missing_signature_401(client, slack_enabled):
    body = _payload_form({"type": "block_actions"})
    r = await client.post(
        "/api/slack/interactions", content=body,
        headers={"Content-Type": "application/x-www-form-urlencoded"})
    assert r.status_code == 401


async def test_interactions_malformed_payload_400(client, slack_enabled):
    headers, body = _sign("payload=not-json")
    r = await client.post("/api/slack/interactions", content=body, headers=headers)
    assert r.status_code == 400


async def test_interactions_3s_contract_ack_returns_before_views_open_is_even_scheduled(
        client, container, make_agent, db, slack_enabled, monkeypatch):
    """Order-of-calls proof for the ACTUAL 3s ack contract (fix/slack-ack-latency): for
    a shortcut, the HTTP response Slack's 3s window is timed against must be built and
    returned WITHOUT waiting on views.open at all — views.open is no longer the ack, it
    is background work fired only AFTER the ack. This is the inverse of the pre-fix
    pin (which asserted views.open WAS the synchronous ack, i.e. the exact latency bug
    this branch fixes) — reverting the ack-timing fix must turn this test red: with the
    OLD code, `_schedule_background` is never called at all (views.open runs inline
    inside the same call that builds the response), so the assertion on
    `background_calls` below would fail with an empty list.

    Deliberately does NOT use the autouse `_run_background_inline` fixture's inlining
    for its own assertion — it separately captures what `_schedule_background` was
    handed, and calls that closure only AFTER already asserting the HTTP response
    contains no trace of views.open having run.
    """
    order = []

    def fake_call_slack_api(method, token, payload):
        order.append(("slack_api", method))
        return {"ok": True}

    monkeypatch.setattr(slack_routes, "call_slack_api", fake_call_slack_api)
    background_calls = []
    monkeypatch.setattr(slack_routes, "_schedule_background", lambda fn: background_calls.append(fn))
    await _link_slack_member(client, container, make_agent, db, "U-linked")

    payload = {
        "type": "shortcut",
        "callback_id": slack_routes.SHORTCUT_CALLBACK_ID,
        "trigger_id": "trig1",
        "user": {"id": "U-linked"},
        "message": {"text": "Something broke\nmore detail"},
    }
    headers, body = _sign(_payload_form(payload))
    r = await client.post("/api/slack/interactions", content=body, headers=headers)
    assert r.status_code == 200, r.text
    assert r.json() == {}  # the ack itself — empty 200, exactly what Slack expects

    # At the moment the ack was returned, views.open had NOT yet run.
    assert order == []
    # Exactly one background closure was handed to the scheduling seam — run it now
    # (simulating "a beat later") and confirm THAT'S when views.open actually fires.
    assert len(background_calls) == 1
    background_calls[0]()
    assert order == [("slack_api", "views.open")]


# ------------------------- shortcut -> modal (both callback_ids) -------------------------

async def test_shortcut_create_github_issue_opens_modal_prefilled(
        client, container, make_agent, db, slack_enabled, monkeypatch):
    opened = {}

    def fake_call_slack_api(method, token, payload):
        opened["method"] = method
        opened["payload"] = payload
        return {"ok": True}

    monkeypatch.setattr(slack_routes, "call_slack_api", fake_call_slack_api)
    await _link_slack_member(client, container, make_agent, db, "U-linked")

    payload = {
        "type": "shortcut",
        "callback_id": slack_routes.SHORTCUT_CALLBACK_ID,
        "trigger_id": "trig123",
        "user": {"id": "U-linked"},
        "message": {"text": "The login button is broken\nhappens on every browser"},
    }
    headers, body = _sign(_payload_form(payload))
    r = await client.post("/api/slack/interactions", content=body, headers=headers)
    assert r.status_code == 200, r.text

    assert opened["method"] == "views.open"
    assert opened["payload"]["trigger_id"] == "trig123"
    view = opened["payload"]["view"]
    assert view["callback_id"] == "create_github_issue_submit"
    assert view["title"]["text"] == "Create GitHub issue"
    assert view["submit"]["text"] == "File issue"
    title_el = view["blocks"][0]["element"]
    assert title_el["initial_value"] == "The login button is broken"
    body_el = view["blocks"][1]["element"]
    assert "happens on every browser" in body_el["initial_value"]
    assert "— from Slack conversation" in body_el["initial_value"]
    # No assignee picker on the issue-only shortcut.
    assert len(view["blocks"]) == 2
    # container_id + slack_user_id (+ any selected image files) ride private_metadata
    # as JSON for view_submission to recover (Slack payloads carry no other context).
    meta = _json.loads(view["private_metadata"])
    assert meta["cid"] == container["id"]
    assert meta["slack_user_id"] == "U-linked"
    assert meta["files"] == []


async def test_shortcut_create_orcha_task_opens_modal_with_assignee_picker(
        client, container, make_agent, db, slack_enabled, monkeypatch):
    opened = {}
    monkeypatch.setattr(slack_routes, "call_slack_api",
                        lambda method, token, payload: (opened.update(method=method, payload=payload), {"ok": True})[1])
    await _link_slack_member(client, container, make_agent, db, "U-linked")
    ai = await make_agent("atlas", kind="ai")

    payload = {
        "type": "message_action",
        "callback_id": slack_routes.SHORTCUT_CALLBACK_ID_WITH_TASK,
        "trigger_id": "trig456",
        "user": {"id": "U-linked"},
        "message": {"text": "Deploy is failing"},
    }
    headers, body = _sign(_payload_form(payload))
    r = await client.post("/api/slack/interactions", content=body, headers=headers)
    assert r.status_code == 200, r.text

    view = opened["payload"]["view"]
    assert view["callback_id"] == "create_orcha_task_submit"
    assert view["title"]["text"] == "Create Orcha task"
    assert view["submit"]["text"] == "Create task"
    assert len(view["blocks"]) == 3  # title, body, assignee
    assignee_block = view["blocks"][2]
    assert assignee_block["block_id"] == slack_routes.ASSIGNEE_BLOCK_ID
    options = assignee_block["element"]["options"]
    assert any(o["text"]["text"] == "atlas" for o in options)
    assert assignee_block["element"]["placeholder"]["text"] == "Let the orchestrator route it"


async def test_shortcut_unlinked_user_opens_not_linked_modal_never_drafts(
        client, container, slack_enabled, monkeypatch):
    """An unlinked caller must never see the drafting form — the "never acts for an
    unlinked caller" contract holds even for the shortcut path, where views.open is the
    only available ack mechanism."""
    opened = {}
    monkeypatch.setattr(slack_routes, "call_slack_api",
                        lambda method, token, payload: (opened.update(method=method, payload=payload), {"ok": True})[1])
    payload = {
        "type": "shortcut",
        "callback_id": slack_routes.SHORTCUT_CALLBACK_ID,
        "trigger_id": "trig-unlinked",
        "user": {"id": "U-unknown"},
        "message": {"text": "hello"},
    }
    headers, body = _sign(_payload_form(payload))
    r = await client.post("/api/slack/interactions", content=body, headers=headers)
    assert r.status_code == 200, r.text
    view = opened["payload"]["view"]
    assert view["title"]["text"] == "Not linked"
    assert "callback_id" not in view or view.get("callback_id") is None
    # No title/body input blocks — never a drafting form for an unlinked caller.
    block_ids = [b.get("block_id") for b in view["blocks"]]
    assert "title_block" not in block_ids


# ------------------------- view_submission: issue-only -------------------------

def _private_metadata(cid, slack_user_id, files=None):
    """Build the JSON private_metadata blob slack_routes._handle_shortcut composes
    (slack_routes._parse_private_metadata is the decode side)."""
    return _json.dumps({"cid": cid, "slack_user_id": slack_user_id, "files": files or []})


def _submission_payload(callback_id, cid, slack_user_id, title, body, assignee_value=None,
                        files=None):
    values = {
        "title_block": {"title_input": {"value": title}},
        "body_block": {"body_input": {"value": body}},
    }
    if assignee_value is not None:
        values[slack_routes.ASSIGNEE_BLOCK_ID] = {
            slack_routes.ASSIGNEE_ACTION_ID: {
                "selected_option": {"value": assignee_value, "text": {"type": "plain_text", "text": "x"}}
            }
        }
    return {
        "type": "view_submission",
        "user": {"id": slack_user_id},
        "view": {
            "callback_id": callback_id,
            "private_metadata": _private_metadata(cid, slack_user_id, files),
            "state": {"values": values},
        },
    }


async def test_view_submission_issue_only_creates_issue_and_dms_confirmation(
        client, container, make_agent, db, slack_enabled, token_env, monkeypatch):
    await _bind_repo(client, container["id"])
    fake_issue = _fake_issue_post(number=88, title="From the modal")
    monkeypatch.setattr(slack_routes, "_gh_post_issue", fake_issue)
    dm_calls = []

    def fake_call_slack_api(method, token, payload):
        if method == "chat.postMessage":
            dm_calls.append(payload)
        return {"ok": True}

    monkeypatch.setattr(slack_routes, "call_slack_api", fake_call_slack_api)
    await _link_slack_member(client, container, make_agent, db, "U-linked")

    payload = _submission_payload(
        "create_github_issue_submit", container["id"], "U-linked",
        "From the modal", "extra body text",
    )
    headers, body = _sign(_payload_form(payload))
    r = await client.post("/api/slack/interactions", content=body, headers=headers)
    assert r.status_code == 200, r.text
    assert r.json() == {"response_action": "clear"}

    assert fake_issue.calls[0]["title"] == "From the modal"
    assert "extra body text" in fake_issue.calls[0]["body"]

    # No Orcha task was created — issue-only shortcut.
    listed = (await client.get(f"/api/containers/{container['id']}/tasks")).json()["tasks"]
    assert not any("From the modal" in t["title"] for t in listed)

    assert len(dm_calls) == 1
    assert dm_calls[0]["channel"] == "U-linked"
    assert dm_calls[0]["blocks"][0]["text"]["text"] == "📝 Issue filed"


async def test_view_submission_empty_title_returns_validation_error(
        client, container, make_agent, db, slack_enabled):
    await _link_slack_member(client, container, make_agent, db, "U-linked")
    payload = _submission_payload(
        "create_github_issue_submit", container["id"], "U-linked", "   ", "",
    )
    headers, body = _sign(_payload_form(payload))
    r = await client.post("/api/slack/interactions", content=body, headers=headers)
    assert r.status_code == 200, r.text
    j = r.json()
    assert j["response_action"] == "errors"
    assert "title_block" in j["errors"]


async def test_view_submission_unlinked_member_fails_closed(
        client, container, slack_enabled):
    payload = _submission_payload(
        "create_github_issue_submit", container["id"], "U-not-linked", "A title", "",
    )
    headers, body = _sign(_payload_form(payload))
    r = await client.post("/api/slack/interactions", content=body, headers=headers)
    assert r.status_code == 200, r.text
    assert r.json()["response_action"] == "errors"


async def test_view_submission_github_403_acks_clear_then_dms_failure_card(
        client, container, make_agent, db, slack_enabled, token_env, monkeypatch):
    """Post-ack-timing-fix shape: the GitHub POST (and thus its 403) now happens in the
    BACKGROUND pipeline, after Slack's response_action='clear' ack already closed the
    modal — a 403 can no longer render as an inline modal validation error (that path
    only exists synchronously, before the ack). The failure still reaches the member,
    just as a DM using the SAME friendly permission-error card the synchronous path
    used to return inline — never silently vanishing, never a raw error."""
    await _bind_repo(client, container["id"])

    def forbidden(repo, token, title, body):
        raise slack_routes.GithubPermissionError("403")

    monkeypatch.setattr(slack_routes, "_gh_post_issue", forbidden)
    dm_calls = []

    def fake_call_slack_api(method, token, payload):
        if method == "chat.postMessage":
            dm_calls.append(payload)
        return {"ok": True}

    monkeypatch.setattr(slack_routes, "call_slack_api", fake_call_slack_api)
    await _link_slack_member(client, container, make_agent, db, "U-linked")
    payload = _submission_payload(
        "create_github_issue_submit", container["id"], "U-linked", "Title", "",
    )
    headers, body = _sign(_payload_form(payload))
    r = await client.post("/api/slack/interactions", content=body, headers=headers)
    assert r.status_code == 200, r.text
    assert r.json() == {"response_action": "clear"}  # ack happens BEFORE the GitHub call

    assert len(dm_calls) == 1
    assert dm_calls[0]["channel"] == "U-linked"
    blocks = dm_calls[0]["blocks"]
    assert blocks[0]["text"]["text"] == "🔒 Can't file that issue"
    assert "Issues: Read and write" in blocks[1]["text"]["text"]


# ====================================================================================
# Feature: portal-side LLM refinement REMOVED (agent-first redesign) — the
# "Create Orcha task" shortcut used to run a wording pass through llm_util before
# filing; that pass, and the whole slack_issue_refine use case, no longer exist
# anywhere in the portal. The agent itself does the refinement now (per the new
# task_start_core.build_slack_captured_dod), when it files the real GitHub issue.
# ====================================================================================

def test_slack_routes_has_no_llm_util_dependency():
    """The plumbing pin: slack_routes.py must not import llm_util at all anymore —
    the only use case it ever needed llm_util for (slack_issue_refine) is deleted."""
    assert not hasattr(slack_routes, "llm_util")


def test_slack_routes_has_no_refine_issue_function():
    """The function itself is gone, not just unused."""
    assert not hasattr(slack_routes, "_refine_issue_for_filing")


def test_reporter_quote_heading_constant_removed():
    """_REPORTER_QUOTE_HEADING was only used by the deleted refine path (the raw
    reporter's message now lives directly in the task description for a task-first
    capture, or as the plain modal body for the issue-only shortcut — neither needs
    a separate 'quoted verbatim under a heading' composition step in the portal; the
    new task-first DoD asks the AGENT to quote the reporter verbatim when it writes
    the real issue)."""
    assert not hasattr(slack_routes, "_REPORTER_QUOTE_HEADING")


async def test_view_submission_issue_only_files_raw_title_and_body_unchanged(
        client, container, make_agent, db, slack_enabled, token_env, monkeypatch):
    """The issue-only shortcut ('Create GitHub issue') files the RAW modal
    title/body verbatim — there is no refinement pass to apply anymore, on this
    path or any other. Holds even WITH an LLM key in the environment (the strongest
    form of the pin: a configured key must not resurrect any refine behavior)."""
    await _bind_repo(client, container["id"])
    monkeypatch.setenv("ORCHA_LLM_API_KEY", "sk-test")
    fake_issue = _fake_issue_post(number=235, title="placeholder")
    monkeypatch.setattr(slack_routes, "_gh_post_issue", fake_issue)
    await _link_slack_member(client, container, make_agent, db, "U-linked")

    payload = _submission_payload(
        "create_github_issue_submit", container["id"], "U-linked",
        "Raw title unchanged", "Raw body unchanged",
    )
    headers, body = _sign(_payload_form(payload))
    r = await client.post("/api/slack/interactions", content=body, headers=headers)
    assert r.status_code == 200, r.text

    assert fake_issue.calls[0]["title"] == "Raw title unchanged"
    assert "Raw body unchanged" in fake_issue.calls[0]["body"]
    # No reporter-quote heading — that was only ever composed by the deleted
    # refine path.
    assert "## Reporter's original message" not in fake_issue.calls[0]["body"]


async def test_orcha_issue_slash_command_unaffected_by_refine_removal(
        client, container, make_agent, db, slack_enabled, token_env, monkeypatch):
    """Regression pin: /orcha issue never had refinement and is fully unaffected by
    its removal — still synchronous, still files the raw title exactly as typed."""
    await _bind_repo(client, container["id"])
    fake = _fake_issue_post(number=238, title="Raw slash command title")
    monkeypatch.setattr(slack_routes, "_gh_post_issue", fake)
    await _link_slack_member(client, container, make_agent, db, "U-linked")

    headers, body = _sign(_form(user_id="U-linked", text="issue Raw slash command title"))
    r = await client.post("/api/slack/commands", content=body, headers=headers)
    assert r.status_code == 200, r.text

    assert fake.calls[0]["title"] == "Raw slash command title"


# ------------------------- view_submission: task-first capture (Create Orcha task) -------------------------

async def test_view_submission_with_task_creates_task_not_issue(
        client, container, make_agent, db, slack_enabled, monkeypatch):
    """The redesign's core behavior: the 'Create Orcha task' shortcut creates the
    Orcha task DIRECTLY — no GitHub issue is filed by the portal at all. Proven by
    asserting _gh_post_issue is never called."""
    issue_post_calls = []
    monkeypatch.setattr(slack_routes, "_gh_post_issue",
                        lambda *a, **k: issue_post_calls.append(1) or {"number": 1, "html_url": "", "title": ""})
    monkeypatch.setattr(slack_routes, "call_slack_api", lambda method, token, payload: {"ok": True})
    await _link_slack_member(client, container, make_agent, db, "U-linked")

    payload = _submission_payload(
        "create_orcha_task_submit", container["id"], "U-linked",
        "Login button is misaligned", "raw slack body text",
    )
    headers, body = _sign(_payload_form(payload))
    r = await client.post("/api/slack/interactions", content=body, headers=headers)
    assert r.status_code == 200, r.text
    assert r.json() == {"response_action": "clear"}

    assert issue_post_calls == []  # never filed a GitHub issue

    listed = (await client.get(f"/api/containers/{container['id']}/tasks")).json()["tasks"]
    t = [x for x in listed if x["title"] == "Login button is misaligned"]
    assert len(t) == 1
    assert t[0]["status"] == "ready"


async def test_view_submission_with_task_title_is_raw_modal_title(
        client, container, make_agent, db, slack_enabled, monkeypatch):
    """No 'GH #N:' prefix — that prefix is the idempotency key GitHub-triggered
    tasks use; a slack-captured task has no GH number and must never look like one."""
    monkeypatch.setattr(slack_routes, "call_slack_api", lambda method, token, payload: {"ok": True})
    await _link_slack_member(client, container, make_agent, db, "U-linked")

    payload = _submission_payload(
        "create_orcha_task_submit", container["id"], "U-linked",
        "Raw title, please", "body",
    )
    headers, body = _sign(_payload_form(payload))
    r = await client.post("/api/slack/interactions", content=body, headers=headers)
    assert r.status_code == 200, r.text

    listed = (await client.get(f"/api/containers/{container['id']}/tasks")).json()["tasks"]
    t = [x for x in listed if x["title"] == "Raw title, please"][0]
    assert not t["title"].startswith("GH #")


async def test_view_submission_with_task_description_carries_body_and_provenance(
        client, container, make_agent, db, slack_enabled, monkeypatch):
    """The task description is the raw message text + Slack provenance — the
    reporter's exact words must survive, since the agent (not a portal LLM call)
    does the refinement now."""
    monkeypatch.setattr(slack_routes, "call_slack_api", lambda method, token, payload: {"ok": True})
    await _link_slack_member(client, container, make_agent, db, "U-linked")

    payload = _submission_payload(
        "create_orcha_task_submit", container["id"], "U-linked",
        "Provenance test", "the exact raw wording from slack",
    )
    headers, body = _sign(_payload_form(payload))
    r = await client.post("/api/slack/interactions", content=body, headers=headers)
    assert r.status_code == 200, r.text

    listed = (await client.get(f"/api/containers/{container['id']}/tasks")).json()["tasks"]
    t = [x for x in listed if x["title"] == "Provenance test"][0]
    assert "the exact raw wording from slack" in t["description"]
    assert "slack" in t["description"].lower()


async def test_view_submission_with_task_uses_slack_captured_dod(
        client, container, make_agent, db, slack_enabled, monkeypatch):
    """The created task's DoD must be the new file-issue-first template, not the
    generic GH-issue _ISSUE_DOD (which assumes an issue already exists)."""
    monkeypatch.setattr(slack_routes, "call_slack_api", lambda method, token, payload: {"ok": True})
    await _link_slack_member(client, container, make_agent, db, "U-linked")

    payload = _submission_payload(
        "create_orcha_task_submit", container["id"], "U-linked",
        "DoD check", "body",
    )
    headers, body = _sign(_payload_form(payload))
    r = await client.post("/api/slack/interactions", content=body, headers=headers)
    assert r.status_code == 200, r.text

    listed = (await client.get(f"/api/containers/{container['id']}/tasks")).json()["tasks"]
    t = [x for x in listed if x["title"] == "DoD check"][0]
    assert "file a professional github issue" in t["definition_of_done"].lower()
    assert "triage comment" in t["definition_of_done"].lower()


async def test_view_submission_with_task_passes_selected_assignee(
        client, container, make_agent, db, slack_enabled, monkeypatch):
    monkeypatch.setattr(slack_routes, "call_slack_api", lambda method, token, payload: {"ok": True})
    await _link_slack_member(client, container, make_agent, db, "U-linked")
    ai = await make_agent("atlas", kind="ai")
    ai_id = ai["agent_id"]

    payload = _submission_payload(
        "create_orcha_task_submit", container["id"], "U-linked",
        "Assign me", "", assignee_value=ai_id,
    )
    headers, body = _sign(_payload_form(payload))
    r = await client.post("/api/slack/interactions", content=body, headers=headers)
    assert r.status_code == 200, r.text

    listed = (await client.get(f"/api/containers/{container['id']}/tasks")).json()["tasks"]
    t = [x for x in listed if x["title"] == "Assign me"][0]
    assert t["status"] == "in_progress"
    at = db.execute("SELECT agent_id FROM agent_tasks WHERE task_id=%s", (t["id"],))
    assert str(at[0]["agent_id"]) == ai_id


async def test_view_submission_with_task_retired_assignee_degrades_to_unassigned(
        client, container, make_agent, db, slack_enabled, monkeypatch):
    """A modal can sit open indefinitely — if the picked agent was RETIRED between
    modal-open and submit, the stale selection must degrade to unassigned (Atlas
    routes it) rather than assign work to a dead agent or crash the submission."""
    monkeypatch.setattr(slack_routes, "call_slack_api", lambda method, token, payload: {"ok": True})
    await _link_slack_member(client, container, make_agent, db, "U-linked")
    ai = await make_agent("atlas", kind="ai")
    ai_id = ai["agent_id"]
    db.execute("UPDATE agents SET terminated_at=now() WHERE id=%s", (ai_id,))

    payload = _submission_payload(
        "create_orcha_task_submit", container["id"], "U-linked",
        "Retired assignee", "", assignee_value=ai_id,
    )
    headers, body = _sign(_payload_form(payload))
    r = await client.post("/api/slack/interactions", content=body, headers=headers)
    assert r.status_code == 200, r.text

    listed = (await client.get(f"/api/containers/{container['id']}/tasks")).json()["tasks"]
    t = [x for x in listed if x["title"] == "Retired assignee"][0]
    assert t["status"] == "ready"  # degraded to unassigned, not assigned to the retiree
    at = db.execute("SELECT agent_id FROM agent_tasks WHERE task_id=%s", (t["id"],))
    assert at == []


async def test_view_submission_with_task_cross_container_assignee_degrades_to_unassigned(
        client, container, make_agent, db, slack_enabled, monkeypatch):
    """A modal-selected assignee id from a DIFFERENT container (should be impossible
    via the modal's own options, but a client could still submit an arbitrary value)
    must never be trusted — degrade to unassigned rather than cross a container
    boundary."""
    monkeypatch.setattr(slack_routes, "call_slack_api", lambda method, token, payload: {"ok": True})
    await _link_slack_member(client, container, make_agent, db, "U-linked")

    other = await client.post("/api/containers", json={"name": "other", "additional": True})
    assert other.status_code == 201, other.text
    other_cid = other.json()["container_id"]
    r_agent = await client.post(f"/api/containers/{other_cid}/agents",
                                json={"alias": "outsider", "role": "worker", "kind": "ai",
                                      "prompt": "x"})
    assert r_agent.status_code in (200, 201), r_agent.text
    outsider_id = r_agent.json()["agent_id"]

    payload = _submission_payload(
        "create_orcha_task_submit", container["id"], "U-linked",
        "Cross container", "", assignee_value=outsider_id,
    )
    headers, body = _sign(_payload_form(payload))
    r = await client.post("/api/slack/interactions", content=body, headers=headers)
    assert r.status_code == 200, r.text

    listed = (await client.get(f"/api/containers/{container['id']}/tasks")).json()["tasks"]
    t = [x for x in listed if x["title"] == "Cross container"][0]
    assert t["status"] == "ready"  # degraded to unassigned, never cross-container


async def test_view_submission_with_task_unassigned_sentinel_means_no_assignee(
        client, container, make_agent, db, slack_enabled, monkeypatch):
    monkeypatch.setattr(slack_routes, "call_slack_api", lambda method, token, payload: {"ok": True})
    await _link_slack_member(client, container, make_agent, db, "U-linked")

    payload = _submission_payload(
        "create_orcha_task_submit", container["id"], "U-linked",
        "No assignee", "", assignee_value=slack_routes.ASSIGNEE_UNASSIGNED_VALUE,
    )
    headers, body = _sign(_payload_form(payload))
    r = await client.post("/api/slack/interactions", content=body, headers=headers)
    assert r.status_code == 200, r.text
    listed = (await client.get(f"/api/containers/{container['id']}/tasks")).json()["tasks"]
    t = [x for x in listed if x["title"] == "No assignee"][0]
    assert t["status"] == "ready"  # unassigned -> Atlas routes it


async def test_view_submission_with_task_confirmation_card_links_task_only(
        client, container, make_agent, db, slack_enabled, monkeypatch):
    monkeypatch.setenv("ORCHA_PORTAL_BASE_URL", "https://app.example.com")
    dm_calls = []

    def fake_call_slack_api(method, token, payload):
        if method == "chat.postMessage":
            dm_calls.append(payload)
        return {"ok": True}

    monkeypatch.setattr(slack_routes, "call_slack_api", fake_call_slack_api)
    await _link_slack_member(client, container, make_agent, db, "U-linked")

    payload = _submission_payload(
        "create_orcha_task_submit", container["id"], "U-linked", "Card check", "",
    )
    headers, body = _sign(_payload_form(payload))
    r = await client.post("/api/slack/interactions", content=body, headers=headers)
    assert r.status_code == 200, r.text

    assert len(dm_calls) == 1
    blocks = dm_calls[0]["blocks"]
    assert blocks[0]["text"]["text"] == "🚀 Task created"
    buttons = [b for b in blocks if b.get("type") == "actions"]
    assert len(buttons) == 1
    urls = [el["url"] for el in buttons[0]["elements"]]
    assert all("github.com" not in u for u in urls)  # no issue link — none exists yet
    assert any(u.startswith("https://app.example.com/tasks?") for u in urls)
    joined_context = " ".join(
        b["elements"][0]["text"] for b in blocks if b.get("type") == "context"
    )
    assert "agent files the refined github issue" in joined_context.lower()


async def test_view_submission_with_task_creation_failure_is_honest_and_rolled_back(
        client, container, make_agent, db, slack_enabled, monkeypatch):
    """A failure inside the task INSERT itself must roll back cleanly (no partial
    rows) and surface an honest failure DM — never crash the interaction handler,
    whose ack (response_action: clear) already went out before the background
    pipeline ran."""
    def boom(cur, cid, **kwargs):
        raise RuntimeError("task creation blew up")

    monkeypatch.setattr(slack_routes, "start_task_from_slack_capture", boom)
    dm_calls = []

    def fake_call_slack_api(method, token, payload):
        if method == "chat.postMessage":
            dm_calls.append(payload)
        return {"ok": True}

    monkeypatch.setattr(slack_routes, "call_slack_api", fake_call_slack_api)
    await _link_slack_member(client, container, make_agent, db, "U-linked")

    payload = _submission_payload(
        "create_orcha_task_submit", container["id"], "U-linked", "Boom", "",
    )
    headers, body = _sign(_payload_form(payload))
    r = await client.post("/api/slack/interactions", content=body, headers=headers)
    assert r.status_code == 200, r.text
    assert r.json() == {"response_action": "clear"}
    listed = (await client.get(f"/api/containers/{container['id']}/tasks")).json()["tasks"]
    assert not any(t["title"] == "Boom" for t in listed)
    assert len(dm_calls) == 1  # an honest failure DM, never silence


# ====================================================================================
# Feature: screenshots travel with the work (message-shortcut images)
# ====================================================================================

import main as _main  # noqa: E402  (module-level import, mirrors test_iss301_attachments.py)


@pytest.fixture
def att_dir(tmp_path, monkeypatch):
    """Redirect the task-attachments store to a per-test tmp dir — mirrors
    test_iss301_attachments.py's fixture of the same name/shape (main.ATTACHMENTS_DIR
    is read fresh on every call through attachment_config's provider lambda)."""
    d = tmp_path / "orcha-attachments"
    d.mkdir()
    monkeypatch.setattr(_main, "ATTACHMENTS_DIR", d)
    return d


def _slack_image_file(name="shot.png", mimetype="image/png", size=1024,
                      url="https://files.slack.com/x/download"):
    return {"name": name, "mimetype": mimetype, "size": size, "url_private_download": url}


async def test_shortcut_private_metadata_carries_selected_image_files(
        client, container, make_agent, db, slack_enabled, monkeypatch):
    """The shortcut payload's message.files[] survive into private_metadata (as
    lightweight metadata, not bytes) — proving download is deferred to submission
    time, not attempted during the 3s shortcut ack."""
    opened = {}
    monkeypatch.setattr(slack_routes, "call_slack_api",
                        lambda method, token, payload: (opened.update(payload=payload), {"ok": True})[1])
    await _link_slack_member(client, container, make_agent, db, "U-linked")

    payload = {
        "type": "shortcut",
        "callback_id": slack_routes.SHORTCUT_CALLBACK_ID,
        "trigger_id": "trigX",
        "user": {"id": "U-linked"},
        "message": {
            "text": "Bug report",
            "files": [_slack_image_file(name="screenshot.png"), _slack_image_file(name="doc.pdf", mimetype="application/pdf")],
        },
    }
    headers, body = _sign(_payload_form(payload))
    r = await client.post("/api/slack/interactions", content=body, headers=headers)
    assert r.status_code == 200, r.text

    view = opened["payload"]["view"]
    meta = _json.loads(view["private_metadata"])
    # Only the image (not the pdf) made it into the metadata's file selection.
    assert len(meta["files"]) == 1
    assert meta["files"][0]["name"] == "screenshot.png"
    assert "data" not in meta["files"][0]  # no bytes — metadata only
    # files_seen is the RAW pre-filter count (both files, including the filtered pdf) —
    # the issue #234 follow-up field that lets view_submission tell "no screenshots"
    # apart from "screenshots were present but all filtered out."
    assert meta["files_seen"] == 2


async def test_shortcut_private_metadata_files_seen_carries_raw_count_when_all_filtered(
        client, container, make_agent, db, slack_enabled, monkeypatch):
    """The exact production gap this closes: a message whose screenshots are ALL
    filtered out before download (here: both over the size cap) must still carry
    files_seen > 0 into private_metadata, even though `files` itself is empty — so
    view_submission can render an honest 'skipped' note instead of silence."""
    opened = {}
    monkeypatch.setattr(slack_routes, "call_slack_api",
                        lambda method, token, payload: (opened.update(payload=payload), {"ok": True})[1])
    await _link_slack_member(client, container, make_agent, db, "U-linked")

    oversized = slack_files.SLACK_IMAGE_MAX_BYTES + 1
    payload = {
        "type": "shortcut",
        "callback_id": slack_routes.SHORTCUT_CALLBACK_ID,
        "trigger_id": "trigY",
        "user": {"id": "U-linked"},
        "message": {
            "text": "Huge screenshots",
            "files": [_slack_image_file(name="huge1.png", size=oversized),
                     _slack_image_file(name="huge2.png", size=oversized)],
        },
    }
    headers, body = _sign(_payload_form(payload))
    r = await client.post("/api/slack/interactions", content=body, headers=headers)
    assert r.status_code == 200, r.text

    meta = _json.loads(opened["payload"]["view"]["private_metadata"])
    assert meta["files"] == []          # nothing survived selection
    assert meta["files_seen"] == 2      # but two files WERE on the message


async def test_view_submission_all_files_filtered_still_gets_mandatory_skip_note(
        client, container, make_agent, db, slack_enabled, token_env, monkeypatch):
    """The card-honesty half of the same fix: when private_metadata says files_seen>0
    but files=[] (every candidate was filtered before download was even attempted —
    e.g. all oversized), the confirmation card MUST say so ('N screenshots were
    skipped — too large or not an image'), not stay silent the way a plain-text
    message's card correctly does."""
    await _bind_repo(client, container["id"])
    fake_issue = _fake_issue_post(number=239, title="All filtered")
    monkeypatch.setattr(slack_routes, "_gh_post_issue", fake_issue)
    dm_calls = []
    monkeypatch.setattr(slack_routes, "call_slack_api",
                        lambda method, token, payload: (dm_calls.append(payload) if method == "chat.postMessage" else None, {"ok": True})[1])
    await _link_slack_member(client, container, make_agent, db, "U-linked")

    private_metadata = _json.dumps({
        "cid": container["id"], "slack_user_id": "U-linked", "files": [], "files_seen": 2,
    })
    payload = {
        "type": "view_submission",
        "user": {"id": "U-linked"},
        "view": {
            "callback_id": "create_github_issue_submit",
            "private_metadata": private_metadata,
            "state": {"values": {
                "title_block": {"title_input": {"value": "All filtered"}},
                "body_block": {"body_input": {"value": ""}},
            }},
        },
    }
    headers, body = _sign(_payload_form(payload))
    r = await client.post("/api/slack/interactions", content=body, headers=headers)
    assert r.status_code == 200, r.text

    assert len(dm_calls) == 1
    joined = " ".join(
        b["elements"][0]["text"] for b in dm_calls[0]["blocks"] if b.get("type") == "context"
    )
    assert "2 screenshots were skipped" in joined
    assert "too large or not an image" in joined


async def test_view_submission_no_files_at_all_gets_no_screenshot_note(
        client, container, make_agent, db, slack_enabled, token_env, monkeypatch):
    """The common case (files_seen=0) must NOT gain a screenshot context line — proves
    the mandatory-note widening didn't add noise to every plain-text-message card."""
    await _bind_repo(client, container["id"])
    fake_issue = _fake_issue_post(number=240, title="No screenshots at all")
    monkeypatch.setattr(slack_routes, "_gh_post_issue", fake_issue)
    dm_calls = []
    monkeypatch.setattr(slack_routes, "call_slack_api",
                        lambda method, token, payload: (dm_calls.append(payload) if method == "chat.postMessage" else None, {"ok": True})[1])
    await _link_slack_member(client, container, make_agent, db, "U-linked")

    payload = _submission_payload(
        "create_github_issue_submit", container["id"], "U-linked",
        "No screenshots at all", "",
    )
    headers, body = _sign(_payload_form(payload))
    r = await client.post("/api/slack/interactions", content=body, headers=headers)
    assert r.status_code == 200, r.text

    context_texts = [
        b["elements"][0]["text"] for b in dm_calls[0]["blocks"] if b.get("type") == "context"
    ]
    assert not any("screenshot" in t.lower() for t in context_texts)


# ------------------------- private_metadata byte-budget guard -------------------------

def test_private_metadata_files_drops_trailing_entries_over_budget():
    """A handful of files with unusually long filenames/URLs must never blow Slack's
    ~3000-char private_metadata limit and corrupt the cid/slack_user_id fields riding
    the same blob — trailing entries (in message order) are dropped until the
    serialized list fits the budget, rather than truncating mid-JSON."""
    long_name = "x" * 500
    long_url = "https://files.slack.com/" + ("y" * 500)
    files = [_slack_image_file(name=f"{long_name}-{i}.png", url=f"{long_url}?i={i}")
             for i in range(5)]
    result = slack_routes._private_metadata_files(files)
    assert result["seen"] == 5
    # At least one long-filename entry was dropped to stay under budget.
    assert len(result["files"]) < 5
    serialized = _json.dumps(result["files"])
    assert len(serialized) <= slack_routes.PRIVATE_METADATA_FILES_BUDGET_CHARS


def test_private_metadata_files_normal_case_keeps_everything():
    """The common case (a handful of short Slack-generated filenames) is never
    trimmed by the byte-budget guard."""
    files = [_slack_image_file(name=f"shot{i}.png") for i in range(5)]
    result = slack_routes._private_metadata_files(files)
    assert len(result["files"]) == 5
    assert result["seen"] == 5


async def test_view_submission_embeds_images_as_markdown_in_issue_body(
        client, container, make_agent, db, slack_enabled, token_env, monkeypatch):
    await _bind_repo(client, container["id"])
    fake_issue = _fake_issue_post(number=200, title="With screenshot")
    monkeypatch.setattr(slack_routes, "_gh_post_issue", fake_issue)
    monkeypatch.setattr(slack_routes, "call_slack_api", lambda method, token, payload: {"ok": True})
    monkeypatch.setattr(slack_files, "download_slack_file", lambda url, token: b"\x89PNGfakebytes")

    put_calls = []

    def fake_put(repo, token, path, data, message):
        put_calls.append({"repo": repo, "path": path, "data": data})
        return {"content": {"download_url": f"https://raw.githubusercontent.com/{repo}/main/{path}"}}

    monkeypatch.setattr(slack_routes, "_gh_put_contents", fake_put)
    await _link_slack_member(client, container, make_agent, db, "U-linked")

    payload = _submission_payload(
        "create_github_issue_submit", container["id"], "U-linked",
        "With screenshot", "the bug",
        files=[_slack_image_file(name="bug.png")],
    )
    headers, body = _sign(_payload_form(payload))
    r = await client.post("/api/slack/interactions", content=body, headers=headers)
    assert r.status_code == 200, r.text
    assert r.json() == {"response_action": "clear"}

    assert len(put_calls) == 1
    assert put_calls[0]["repo"] == "acme/site"
    assert ".github/orcha-attachments/" in put_calls[0]["path"]
    assert put_calls[0]["data"] == b"\x89PNGfakebytes"

    issue_body = fake_issue.calls[0]["body"]
    assert "### Screenshots" in issue_body
    assert "![bug.png](https://raw.githubusercontent.com/acme/site/main/" in issue_body
    assert "the bug" in issue_body  # original body text preserved alongside the images


async def test_view_submission_files_read_missing_degrades_gracefully(
        client, container, make_agent, db, slack_enabled, token_env, monkeypatch):
    """No files:read scope (Slack 403s the download) — the issue/task still gets
    created, just without images, and the confirmation card says so explicitly."""
    await _bind_repo(client, container["id"])
    fake_issue = _fake_issue_post(number=201, title="No scope")
    monkeypatch.setattr(slack_routes, "_gh_post_issue", fake_issue)
    dm_calls = []

    def fake_call_slack_api(method, token, payload):
        if method == "chat.postMessage":
            dm_calls.append(payload)
        return {"ok": True}

    monkeypatch.setattr(slack_routes, "call_slack_api", fake_call_slack_api)

    def denied(url, token):
        raise slack_files.SlackFilesScopeMissing("403")

    monkeypatch.setattr(slack_files, "download_slack_file", denied)
    await _link_slack_member(client, container, make_agent, db, "U-linked")

    payload = _submission_payload(
        "create_github_issue_submit", container["id"], "U-linked",
        "No scope", "body",
        files=[_slack_image_file(name="a.png"), _slack_image_file(name="b.png")],
    )
    headers, body = _sign(_payload_form(payload))
    r = await client.post("/api/slack/interactions", content=body, headers=headers)
    assert r.status_code == 200, r.text
    assert r.json() == {"response_action": "clear"}  # issue creation still succeeds

    assert "### Screenshots" not in fake_issue.calls[0]["body"]

    assert len(dm_calls) == 1
    joined = " ".join(
        b["elements"][0]["text"] for b in dm_calls[0]["blocks"] if b.get("type") == "context"
    )
    assert "files:read" in joined
    assert "reinstall" in joined


async def test_view_submission_partial_screenshot_failure_counted_honestly(
        client, container, make_agent, db, slack_enabled, token_env, monkeypatch):
    """2 of 3 screenshots land — the confirmation card must say '2/3', never claim
    all 3 landed and never fail the whole issue-filing flow."""
    await _bind_repo(client, container["id"])
    fake_issue = _fake_issue_post(number=202, title="Partial")
    monkeypatch.setattr(slack_routes, "_gh_post_issue", fake_issue)
    dm_calls = []
    monkeypatch.setattr(slack_routes, "call_slack_api",
                        lambda method, token, payload: (dm_calls.append(payload) if method == "chat.postMessage" else None, {"ok": True})[1])
    monkeypatch.setattr(slack_files, "download_slack_file", lambda url, token: b"bytes")

    calls = {"n": 0}

    def flaky_put(repo, token, path, data, message):
        calls["n"] += 1
        if calls["n"] == 2:
            raise slack_routes.GithubPermissionError("403")
        return {"content": {"download_url": f"https://raw.githubusercontent.com/{repo}/main/{path}"}}

    monkeypatch.setattr(slack_routes, "_gh_put_contents", flaky_put)
    await _link_slack_member(client, container, make_agent, db, "U-linked")

    payload = _submission_payload(
        "create_github_issue_submit", container["id"], "U-linked",
        "Partial", "",
        files=[_slack_image_file(name=f"s{i}.png") for i in range(3)],
    )
    headers, body = _sign(_payload_form(payload))
    r = await client.post("/api/slack/interactions", content=body, headers=headers)
    assert r.status_code == 200, r.text

    issue_body = fake_issue.calls[0]["body"]
    assert issue_body.count("![") == 2  # only the 2 that landed are embedded

    joined = " ".join(
        b["elements"][0]["text"] for b in dm_calls[0]["blocks"] if b.get("type") == "context"
    )
    assert "2/3 screenshots attached" in joined


async def test_view_submission_with_task_lands_images_on_task_attachments(
        client, container, make_agent, db, slack_enabled, monkeypatch, att_dir, caplog):
    """The founder's actual goal: for the 'Create Orcha task' shortcut, downloaded
    images land on the created task's own attachment store DIRECTLY — task-first
    means no GitHub commit happens at creation time at all (the agent commits them
    to the repo itself, per the new DoD, when it later files the issue)."""
    monkeypatch.setattr(slack_routes, "call_slack_api", lambda method, token, payload: {"ok": True})
    monkeypatch.setattr(slack_files, "download_slack_file", lambda url, token: b"\x89PNGrealbytes")
    put_calls = []
    monkeypatch.setattr(slack_routes, "_gh_put_contents",
                        lambda *a, **k: put_calls.append(1) or {"content": {"download_url": "https://raw/x"}})
    await _link_slack_member(client, container, make_agent, db, "U-linked")

    payload = _submission_payload(
        "create_orcha_task_submit", container["id"], "U-linked",
        "Task with screenshot", "",
        files=[_slack_image_file(name="proof.png")],
    )
    headers, body = _sign(_payload_form(payload))
    import logging as _logging
    # CI-only failure forensics (this test has failed on the runner while passing
    # locally under identical flags): capture the slack file-filter verdicts and
    # attach-write path at DEBUG so a red run SAYS which gate dropped the image.
    caplog.set_level(_logging.DEBUG, logger="orcha.slack")
    caplog.set_level(_logging.DEBUG, logger="portal_backend.slack_files")
    caplog.set_level(_logging.DEBUG)
    r = await client.post("/api/slack/interactions", content=body, headers=headers)
    assert r.status_code == 200, r.text

    assert put_calls == []  # no GitHub commit — task-first never touches GitHub

    listed = (await client.get(f"/api/containers/{container['id']}/tasks")).json()["tasks"]
    t = [x for x in listed if x["title"] == "Task with screenshot"][0]
    msgs = (await client.get(f"/api/tasks/{t['id']}/messages")).json()["messages"]
    attach_msgs = [m for m in msgs if m.get("attachments")]
    on_disk = sorted(str(q.relative_to(att_dir)) for q in att_dir.rglob("*") if q.is_file())
    assert len(attach_msgs) == 1, (
        f"no attachment message landed — messages={msgs!r}\n"
        f"interactions response body: {r.text!r}\n"
        f"att_dir files on disk: {on_disk!r}\n"
        f"captured logs:\n{caplog.text}"
    )
    refs = attach_msgs[0]["attachments"]
    assert len(refs) == 1
    assert refs[0]["name"] == "proof.png"
    assert refs[0]["kind"] == "image"
    # The stored bytes are actually on disk under this task's attachment dir.
    stored_path = att_dir / t["id"] / refs[0]["id"]
    assert stored_path.exists()
    assert stored_path.read_bytes() == b"\x89PNGrealbytes"


async def test_view_submission_with_task_screenshot_disallowed_extension_skipped(
        client, container, make_agent, db, slack_enabled, monkeypatch, att_dir):
    """End-to-end: a Slack file reporting mimetype image/svg+xml (which passes the
    upstream image/* selection filter) but named with a disallowed extension must be
    skipped by the task-attachment landing step — never written into the attachment
    store un-gated. (SVG is deliberately excluded from ATTACHMENT_TYPES — 'never
    served renderable' per attachment_routes.upload_attachment's docstring.)"""
    monkeypatch.setattr(slack_routes, "call_slack_api", lambda method, token, payload: {"ok": True})
    monkeypatch.setattr(slack_files, "download_slack_file", lambda url, token: b"<svg onload=alert(1)></svg>")
    await _link_slack_member(client, container, make_agent, db, "U-linked")

    payload = _submission_payload(
        "create_orcha_task_submit", container["id"], "U-linked",
        "Disallowed ext", "",
        files=[_slack_image_file(name="exploit.svg", mimetype="image/svg+xml")],
    )
    headers, body = _sign(_payload_form(payload))
    r = await client.post("/api/slack/interactions", content=body, headers=headers)
    assert r.status_code == 200, r.text

    listed = (await client.get(f"/api/containers/{container['id']}/tasks")).json()["tasks"]
    t = [x for x in listed if x["title"] == "Disallowed ext"][0]
    msgs = (await client.get(f"/api/tasks/{t['id']}/messages")).json()["messages"]
    # No attachment message at all — the one candidate file was rejected outright.
    assert not any(m.get("attachments") for m in msgs)
    # Nothing landed on disk under this task's attachment dir either.
    task_dir = att_dir / t["id"]
    assert not task_dir.exists() or not any(task_dir.iterdir())


async def test_view_submission_with_task_screenshot_honesty_note_on_card(
        client, container, make_agent, db, slack_enabled, monkeypatch, att_dir):
    """Mandatory honesty line survives the redesign — the count of screenshots
    attached to the TASK (not a GitHub issue, since none exists) still appears."""
    dm_calls = []

    def fake_call_slack_api(method, token, payload):
        if method == "chat.postMessage":
            dm_calls.append(payload)
        return {"ok": True}

    monkeypatch.setattr(slack_routes, "call_slack_api", fake_call_slack_api)
    monkeypatch.setattr(slack_files, "download_slack_file", lambda url, token: b"\x89PNGbytes")
    await _link_slack_member(client, container, make_agent, db, "U-linked")

    payload = _submission_payload(
        "create_orcha_task_submit", container["id"], "U-linked",
        "Honesty check", "",
        files=[_slack_image_file(name="a.png"), _slack_image_file(name="b.png")],
    )
    headers, body = _sign(_payload_form(payload))
    r = await client.post("/api/slack/interactions", content=body, headers=headers)
    assert r.status_code == 200, r.text

    joined = " ".join(
        b["elements"][0]["text"] for b in dm_calls[0]["blocks"] if b.get("type") == "context"
    )
    assert "2 screenshots attached" in joined


async def test_view_submission_issue_only_shortcut_does_not_touch_task_attachments(
        client, container, make_agent, db, slack_enabled, token_env, monkeypatch, att_dir):
    """The issue-only shortcut ('Create GitHub issue') must NOT land images on any
    task attachment store — there is no task. Only the chained 'Create Orcha task'
    shortcut does that."""
    await _bind_repo(client, container["id"])
    fake_issue = _fake_issue_post(number=204, title="Issue only, no task")
    monkeypatch.setattr(slack_routes, "_gh_post_issue", fake_issue)
    monkeypatch.setattr(slack_routes, "call_slack_api", lambda method, token, payload: {"ok": True})
    monkeypatch.setattr(slack_files, "download_slack_file", lambda url, token: b"bytes")
    monkeypatch.setattr(slack_routes, "_gh_put_contents",
                        lambda repo, token, path, data, message: {"content": {"download_url": "https://raw/x"}})
    await _link_slack_member(client, container, make_agent, db, "U-linked")

    payload = _submission_payload(
        "create_github_issue_submit", container["id"], "U-linked",
        "Issue only, no task", "",
        files=[_slack_image_file(name="shot.png")],
    )
    headers, body = _sign(_payload_form(payload))
    r = await client.post("/api/slack/interactions", content=body, headers=headers)
    assert r.status_code == 200, r.text

    listed = (await client.get(f"/api/containers/{container['id']}/tasks")).json()["tasks"]
    assert not any("GH #204:" in t["title"] for t in listed)
    # Nothing was ever written under the attachments root for this container's tasks.
    assert not any(att_dir.iterdir())


# ------------------------- block_actions: Start Orcha task button -------------------------

async def test_block_action_start_issue_acks_immediately_then_dms_started_card(
        client, container, make_agent, db, slack_enabled, token_env, monkeypatch):
    """Post-ack-timing-fix shape: the click acks with a minimal, blocks-free ephemeral
    IMMEDIATELY (the button's own live GitHub title fetch + task_start_core round trip
    no longer happen before the ack) — the actual "Task started" card is delivered as a
    DM once the background pipeline finishes."""
    await _bind_repo(client, container["id"])
    monkeypatch.setattr(hub, "_gh_get", _fake_issue_get(55, "Started via button"))
    dm_calls = []

    def fake_call_slack_api(method, token, payload):
        if method == "chat.postMessage":
            dm_calls.append(payload)
        return {"ok": True}

    monkeypatch.setattr(slack_routes, "call_slack_api", fake_call_slack_api)
    await _link_slack_member(client, container, make_agent, db, "U-linked")

    payload = {
        "type": "block_actions",
        "user": {"id": "U-linked"},
        "actions": [{"action_id": slack_routes.START_ISSUE_ACTION_ID, "value": "55"}],
    }
    headers, body = _sign(_payload_form(payload))
    r = await client.post("/api/slack/interactions", content=body, headers=headers)
    assert r.status_code == 200, r.text
    j = r.json()
    assert j == {"response_type": "ephemeral"}  # the ack — no blocks, nothing to render

    assert len(dm_calls) == 1
    assert dm_calls[0]["channel"] == "U-linked"
    assert dm_calls[0]["blocks"][0]["text"]["text"] == "🚀 Task started"

    listed = (await client.get(f"/api/containers/{container['id']}/tasks")).json()["tasks"]
    t = [x for x in listed if x["title"].startswith("GH #55:")][0]
    assert t["title"] == "GH #55: Started via button"


async def test_block_action_start_issue_idempotent_dms_already_tracked(
        client, container, make_agent, db, slack_enabled, token_env, monkeypatch):
    await _bind_repo(client, container["id"])
    monkeypatch.setattr(hub, "_gh_get", _fake_issue_get(56, "dup via button"))
    dm_calls = []

    def fake_call_slack_api(method, token, payload):
        if method == "chat.postMessage":
            dm_calls.append(payload)
        return {"ok": True}

    monkeypatch.setattr(slack_routes, "call_slack_api", fake_call_slack_api)
    await _link_slack_member(client, container, make_agent, db, "U-linked")

    payload = {
        "type": "block_actions",
        "user": {"id": "U-linked"},
        "actions": [{"action_id": slack_routes.START_ISSUE_ACTION_ID, "value": "56"}],
    }
    for _ in range(2):
        headers, body = _sign(_payload_form(payload))
        r = await client.post("/api/slack/interactions", content=body, headers=headers)
        assert r.status_code == 200, r.text
    assert len(dm_calls) == 2
    assert dm_calls[-1]["blocks"][0]["text"]["text"] == "↩️ Already tracked"


async def test_block_action_start_issue_reuses_shared_start_core(
        client, container, make_agent, db, slack_enabled, token_env, monkeypatch):
    """Confirms the block_actions Start button is not a separate/drifted implementation
    — it produces a task with the SAME title/DoD template as any other GH-issue start
    path (e.g. the slash command)."""
    await _bind_repo(client, container["id"])
    monkeypatch.setattr(hub, "_gh_get", _fake_issue_get(200, "Shared core proof"))
    await _link_slack_member(client, container, make_agent, db, "U-linked")

    payload = {
        "type": "block_actions",
        "user": {"id": "U-linked"},
        "actions": [{"action_id": slack_routes.START_ISSUE_ACTION_ID, "value": "200"}],
    }
    headers, body = _sign(_payload_form(payload))
    r = await client.post("/api/slack/interactions", content=body, headers=headers)
    assert r.status_code == 200, r.text

    listed = (await client.get(f"/api/containers/{container['id']}/tasks")).json()["tasks"]
    t = [x for x in listed if x["title"].startswith("GH #200:")][0]
    assert "Fix GH #200 per its description" in t["definition_of_done"]


async def test_block_action_unlinked_user_gets_ephemeral_never_acts(
        client, container, slack_enabled):
    payload = {
        "type": "block_actions",
        "user": {"id": "U-unlinked"},
        "actions": [{"action_id": slack_routes.START_ISSUE_ACTION_ID, "value": "1"}],
    }
    headers, body = _sign(_payload_form(payload))
    r = await client.post("/api/slack/interactions", content=body, headers=headers)
    assert r.status_code == 200, r.text
    assert "link" in r.json()["text"].lower()


# ------------------------- Block Kit composers: pure-function unit tests -------------------------

def test_blocks_issue_filed_structure_with_interactive_button():
    blocks = slack_notify.blocks_issue_filed(
        42, "https://github.com/acme/site/issues/42", "Fix the thing", None,
    )
    assert blocks[0]["text"]["text"] == "📝 Issue filed"
    assert "<https://github.com/acme/site/issues/42|#42 Fix the thing>" in blocks[1]["text"]["text"]
    actions = blocks[2]["elements"]
    start_btn = [el for el in actions if el.get("action_id") == "slack_start_issue"][0]
    assert start_btn["value"] == "42"
    assert start_btn["style"] == "primary"
    open_btn = [el for el in actions if el.get("url")][0]
    assert open_btn["text"]["text"] == "Open on GitHub"


def test_blocks_issue_filed_start_command_variant_no_interactive_button():
    blocks = slack_notify.blocks_issue_filed(
        42, "https://github.com/acme/site/issues/42", "Fix the thing", None,
        start_command="/orcha start issue 42",
    )
    ctx = blocks[2]["elements"][0]["text"]
    assert "/orcha start issue 42" in ctx
    assert not any(el.get("action_id") for b in blocks if b["type"] == "actions" for el in b["elements"])


def test_blocks_github_permission_error_structure():
    blocks = slack_notify.blocks_github_permission_error()
    assert blocks[0]["text"]["text"] == "🔒 Can't file that issue"
    assert "Issues: Read and write" in blocks[1]["text"]["text"]


def test_blocks_issue_usage_help_shows_syntax():
    blocks = slack_notify.blocks_issue_usage_help()
    text = blocks[1]["text"]["text"]
    assert "/orcha issue <title> [-- <body>]" in text


def test_blocks_task_created_success_structure():
    blocks = slack_notify.blocks_task_created(
        9, "https://github.com/acme/site/issues/9", "A title",
        "https://app.example.com/tasks?cid=c&task=t",
    )
    assert blocks[0]["text"]["text"] == "🚀 Task created"
    assert "#9 A title" in blocks[1]["text"]["text"]
    urls = [el["url"] for el in blocks[-1]["elements"]]
    assert "https://github.com/acme/site/issues/9" in urls
    assert "https://app.example.com/tasks?cid=c&task=t" in urls


def test_blocks_task_created_half_failure_structure():
    blocks = slack_notify.blocks_task_created(
        9, "https://github.com/acme/site/issues/9", "A title", None,
        start_failed=True, gh_number_for_retry=9,
    )
    assert blocks[0]["text"]["text"] == "🚀 Task created"
    ctx = blocks[-2]["elements"][0]["text"] if blocks[-1]["type"] == "actions" else blocks[-1]["elements"][0]["text"]
    assert "run `/orcha start issue 9` to retry" in ctx
    # no task-link button in the half-failure card
    assert not any(
        el.get("url", "").startswith("https://app.example.com/tasks")
        for b in blocks if b["type"] == "actions" for el in b["elements"]
    )


def test_blocks_task_created_from_slack_structure():
    """The task-first confirmation card: '🚀 Task created' header, a link straight
    to the Orcha task (there is no GitHub issue yet), a context line explaining the
    agent will file the refined issue and post the link to the task thread, and the
    mandatory screenshot-honesty line when given."""
    blocks = slack_notify.blocks_task_created_from_slack(
        "Login button is misaligned", "https://app.example.com/tasks?cid=c&task=t1",
        screenshot_note="2 screenshots attached",
    )
    assert blocks[0]["text"]["text"] == "🚀 Task created"
    assert "Login button is misaligned" in blocks[1]["text"]["text"]
    joined_context = " ".join(
        b["elements"][0]["text"] for b in blocks if b.get("type") == "context"
    )
    assert "agent files the refined github issue" in joined_context.lower()
    assert "link arrives in the task thread" in joined_context.lower()
    assert "2 screenshots attached" in joined_context
    buttons = [b for b in blocks if b.get("type") == "actions"]
    assert len(buttons) == 1
    assert buttons[0]["elements"][0]["url"] == "https://app.example.com/tasks?cid=c&task=t1"


def test_blocks_task_created_from_slack_no_link_omits_button():
    """Without a configured ORCHA_PORTAL_BASE_URL there's no task deep link — the
    card must still render (title + context), just without a button, same
    degradation convention as every other composer in this module."""
    blocks = slack_notify.blocks_task_created_from_slack(
        "No link case", None, screenshot_note=None,
    )
    assert not any(b.get("type") == "actions" for b in blocks)


def test_blocks_task_created_from_slack_escapes_title():
    blocks = slack_notify.blocks_task_created_from_slack(
        "Fix <script> handling & more", "https://x/y", screenshot_note=None,
    )
    assert "&lt;script&gt;" in blocks[1]["text"]["text"]
    assert "&amp;" in blocks[1]["text"]["text"]


def test_build_create_issue_modal_issue_only_shape():
    view = slack_notify.build_create_issue_modal("A title", "A body", private_metadata="c1|U1")
    assert view["callback_id"] == "create_github_issue_submit"
    assert view["private_metadata"] == "c1|U1"
    assert len(view["blocks"]) == 2
    assert view["blocks"][0]["element"]["initial_value"] == "A title"


def test_build_create_issue_modal_truncates_long_title():
    view = slack_notify.build_create_issue_modal("x" * 200, "", private_metadata="")
    assert len(view["blocks"][0]["element"]["initial_value"]) == 80


def test_build_create_issue_modal_with_task_adds_assignee_select():
    view = slack_notify.build_create_issue_modal(
        "T", "B", private_metadata="c1|U1", with_task=True,
        assignee_options=[{"id": "a1", "alias": "atlas"}],
    )
    assert view["callback_id"] == "create_orcha_task_submit"
    assert view["submit"]["text"] == "Create task"
    assert len(view["blocks"]) == 3
    options = view["blocks"][2]["element"]["options"]
    assert options[0]["text"]["text"] == "atlas"
    assert options[0]["value"] == "a1"


def test_build_create_issue_modal_with_task_empty_roster_still_renders_select():
    view = slack_notify.build_create_issue_modal(
        "T", "B", private_metadata="c1|U1", with_task=True, assignee_options=[],
    )
    options = view["blocks"][2]["element"]["options"]
    assert len(options) == 1
    assert options[0]["value"] == slack_notify.ASSIGNEE_UNASSIGNED_VALUE


def test_build_unlinked_user_modal_reuses_unlinked_copy():
    view = slack_notify.build_unlinked_user_modal()
    assert view["title"]["text"] == "Not linked"
    assert view["blocks"] == slack_notify.blocks_unlinked_user()
