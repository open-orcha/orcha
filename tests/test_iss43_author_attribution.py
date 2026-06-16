"""ISS-43 (#102) — an AI agent's task-thread posts must NOT render as a human.

The fix relaxes the POST guard to container-membership: any non-retired member may post
ATTRIBUTED (so author_id stays non-null and is_human is correct), while a forged /
cross-container id is still rejected.

UPDATED by #271 (harden AI-actor enforcement): is_human is now `author_id IS NOT NULL AND
agents.kind='human'`. A NULL author is NO LONGER treated as human — the old
`author_id IS NULL OR ...` let an AI fabricate a human-looking post by simply omitting its
id. The NULL-author-renders-human assertion below is replaced by a renders-neutral assertion;
the full #271 matrix lives in tests/test_iss271_actor_hardening.py.
"""
import pytest

pytestmark = pytest.mark.asyncio


async def _last(client, tid):
    msgs = (await client.get(f"/api/tasks/{tid}/messages")).json()["messages"]
    return msgs[-1]


async def test_nonassigned_member_post_is_attributed_and_ai(client, make_agent, make_task):
    """The core ISS-43 fix: a reviewer who is NOT assigned to the task can still post,
    the post keeps their attribution, and it renders as an AI post (is_human False).
    Before the fix this 403'd and the only way through was a NULL (→ human) author."""
    dev = await make_agent("Dev")
    reviewer = await make_agent("Reviewer")
    task = await make_task("build it", "done", assignee_alias="Dev")
    tid = task["id"]

    r = await client.post(f"/api/tasks/{tid}/messages",
                          json={"author_agent_id": reviewer["agent_id"],
                                "body": "[Reviewer] LGTM — approving the PR"})
    assert r.status_code == 201, r.text

    m = await _last(client, tid)
    assert m["is_human"] is False, "a non-assigned AI reviewer's post must NOT render as human"
    assert m["author_alias"] == "Reviewer"
    assert m["author_id"] == reviewer["agent_id"]


async def test_assigned_agent_post_still_ai(client, make_agent, make_task):
    """Regression guard: the assignee path (the one that already worked) still renders AI."""
    dev = await make_agent("Dev")
    task = await make_task("t", "d", assignee_alias="Dev")
    tid = task["id"]
    r = await client.post(f"/api/tasks/{tid}/messages",
                          json={"author_agent_id": dev["agent_id"], "body": "progress note"})
    assert r.status_code == 201, r.text
    m = await _last(client, tid)
    assert m["is_human"] is False
    assert m["author_alias"] == "Dev"


async def test_null_author_post_renders_neutral_not_human(client, make_task):
    """#271: a post with NO author_agent_id is NO LONGER rendered as a human. It is accepted
    (system/legacy posts still work) but is_human is now False — an AI can't fabricate a
    human-attributed post by omitting its id. (Was test_null_author_post_renders_human.)"""
    task = await make_task("t", "d")
    tid = task["id"]
    r = await client.post(f"/api/tasks/{tid}/messages", json={"body": "please rebase onto main"})
    assert r.status_code == 201, r.text
    m = await _last(client, tid)
    assert m["is_human"] is False, "a NULL-author post must NOT render as human (#271 V1 fix)"
    assert m["author_id"] is None


async def test_human_agent_attributed_post_renders_human(client, make_agent, make_task):
    """A kind='human' agent posting WITH its id resolves to a human via agents.kind."""
    human = await make_agent("Kedar", kind="human")
    task = await make_task("t", "d")
    tid = task["id"]
    r = await client.post(f"/api/tasks/{tid}/messages",
                          json={"author_agent_id": human["agent_id"], "body": "human note"})
    assert r.status_code == 201, r.text
    m = await _last(client, tid)
    assert m["is_human"] is True, "a kind=human author must render as human even when attributed"
    assert m["author_alias"] == "Kedar"


async def test_forged_nonmember_author_rejected(client, make_task):
    """Authorship can't be forged: a well-formed author_agent_id that is NOT a member of the
    task's container (here, a non-existent agent) is rejected — the relaxation is
    container-membership, not 'anyone with a UUID'."""
    task = await make_task("t", "d")
    tid = task["id"]
    bogus = "00000000-0000-4000-8000-000000000000"   # valid UUID, not an agent in this container
    r = await client.post(f"/api/tasks/{tid}/messages",
                          json={"author_agent_id": bogus, "body": "i should be blocked"})
    assert r.status_code == 403, r.text
