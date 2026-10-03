"""Human text vs agent instructions on a request (mig 065) + code-thread auto-resolve +
one-click Resolve.

A code-thread question used to store the agent's full wake text as the request's `payload`,
so people saw "[code thread — teach] …", the lesson guide placeholders and "reply via POST
/api/code/threads/…". Now `payload` is just the question and the wake text is `agent_payload`.
The point of half these tests is that AGENTS DO NOT REGRESS: every agent read path still
delivers the reply instruction + lesson guide, byte-identical to the old payload.
"""
import pathlib

import pytest

import main  # noqa: F401  (conftest binds the app before import)
from orcha_cli import notifier  # noqa: E402
from portal_backend import code_space_routes as cs
from portal_backend import github_repo_browse_routes as browse

MIGRATION_065 = (
    pathlib.Path(__file__).resolve().parents[1]
    / "orcha-cli/orcha_cli/templates/migrations/065_request_agent_payload.sql"
)
QUESTION = (
    "Give me a tour of the deploy/ folder, starting from docker-compose.yml: what lives here, "
    "how the files fit together, and where to start reading."
)


@pytest.fixture
def gh(monkeypatch, tmp_path):
    token_file = tmp_path / "github-token"
    token_file.write_text("ghs_hubtoken\n")
    monkeypatch.setenv("ORCHA_GITHUB_TOKEN_FILE", str(token_file))
    monkeypatch.delenv("ORCHA_GITHUB_TOKENS_FILE", raising=False)
    browse._TREE_CACHE.clear()
    browse._DEFAULT_BRANCH_CACHE.clear()

    def fake_get(path, token):
        if "/commits/" in path:
            return {"sha": "8cf5234" + "a" * 33}
        return {"default_branch": "main"}

    monkeypatch.setattr(browse, "_gh_get", fake_get)
    monkeypatch.setattr(cs, "_gh_get", fake_get)
    yield
    browse._TREE_CACHE.clear()
    browse._DEFAULT_BRANCH_CACHE.clear()


async def _thread(client, cid, author_id, tagged_id, *, kind="teach", body=QUESTION,
                  path="deploy/docker-compose.yml", start=1, end=1):
    r = await client.put(f"/api/containers/{cid}/github", json={"repo": "acme/site"})
    assert r.status_code == 200, r.text
    r = await client.post(
        f"/api/containers/{cid}/code/threads",
        json={"actor_agent_id": author_id, "tagged_agent_id": tagged_id, "path": path,
              "start_line": start, "end_line": end, "kind": kind, "body": body},
    )
    assert r.status_code == 201, r.text
    return r.json()


def _req(db, rid):
    return db.execute("SELECT * FROM requests WHERE id=%s", (rid,))[0]


# ------------------------------------------------------------- the split ---

async def test_human_text_is_clean_and_agent_text_is_the_old_payload(client, db, container, make_agent, gh):
    cid = container["id"]
    human = await make_agent("Kedar", kind="human")
    atlas = await make_agent("Atlas")
    t = await _thread(client, cid, human["agent_id"], atlas["agent_id"])
    row = _req(db, t["request_id"])

    # human side: just the question, a clean title, the thread link
    assert row["payload"] == QUESTION
    for leak in ("[code thread", "reply via POST", "actor_agent_id", "<lesson title>", "view/reply"):
        assert leak not in row["payload"]
    assert row["detail"]["display_title"] == "Teach · Tour of the deploy/ folder — docker-compose.yml L1"
    ct = row["detail"]["code_thread"]
    assert ct["thread_id"] == t["id"] and ct["kind"] == "teach"
    assert ct["link"] == f"/code?path=deploy/docker-compose.yml&thread={t['id']}"

    # agent side: byte-identical to what the payload used to be
    anchor = {"repo": "acme/site", "sha": t["sha"], "path": "deploy/docker-compose.yml",
              "start_line": 1, "end_line": 1}
    assert row["agent_payload"] == cs._render_wake_payload(t["id"], anchor, "teach", QUESTION)
    assert row["type"] == "info"


async def test_agent_still_receives_reply_instructions_and_lesson_guide(client, db, container, make_agent, gh):
    """Every agent read path delivers the instructions (no regression from the split)."""
    cid = container["id"]
    human = await make_agent("Kedar", kind="human")
    atlas = await make_agent("Atlas")
    t = await _thread(client, cid, human["agent_id"], atlas["agent_id"])
    rid, aid = t["request_id"], atlas["agent_id"]
    reply_line = f"reply via POST /api/code/threads/{t['id']}/messages with your agent id as actor_agent_id"

    # 1. /inbox (the /orcha-inbox + /orcha-checkpoint skills read this)
    inbox = (await client.get(f"/api/agents/{aid}/inbox")).json()["open_requests"]
    item = next(r for r in inbox if str(r["id"]) == rid)
    assert reply_line in item["agent_payload"]
    for marker in ("# <lesson title>", "## Steps", "## Key concepts", "## Follow-ups"):
        assert marker in item["agent_payload"], marker
    assert item["payload"] == QUESTION

    # 2. the request_created wake event (-> wake manifest -> wake prompt) previews the AGENT text,
    #    exactly as before the split
    ev = [e for e in db.event_rows(aid) if e["event_name"] == "request_created"]
    assert ev and ev[-1]["payload"]["preview"] == item["agent_payload"][:120]
    assert ev[-1]["payload"]["preview"].startswith("[code thread — teach] acme/site@8cf5234")
    scan = (await client.get(f"/api/containers/{cid}/wake-scan",
                             params={"cooldown": 0, "min_idle": 0})).json()
    cand = next(c for c in scan["candidates"] if c["agent_id"] == aid)
    note = next(n for n in cand["notifications"] if (n.get("deeplink") or {}).get("id") == rid)
    assert note["preview"].startswith("[code thread — teach]")
    assert "[code thread — teach]" in notifier.build_wake_prompt(cand)

    # 3. /rehydrate (the `orcha rehydrate` SessionStart brief) shows the agent text
    brief = (await client.get(f"/api/agents/{aid}/rehydrate")).json()
    b = next(r for r in brief["inbox"] if str(r["id"]) == rid)
    assert b["payload"].startswith("[code thread — teach]")
    assert reply_line in b["agent_payload"]
    from orcha_cli.cli_rehydrate import format_brief
    assert "carries its own reply instructions" in format_brief(brief)

    # 4. the container request list (documented in openapi) carries it too
    lst = (await client.get(f"/api/containers/{cid}/requests")).json()["requests"]
    assert reply_line in next(r for r in lst if str(r["id"]) == rid)["agent_payload"]

    # 5. a nudge to the agent previews the agent text
    r = await client.post(f"/api/requests/{rid}/nudge", json={"actor_agent_id": human["agent_id"]})
    assert r.status_code == 200 and r.json()["nudged"] is True, r.text
    prompt = [e for e in db.event_rows(aid) if e["event_name"] == "prompt"][-1]
    assert "[code thread — teach]" in prompt["payload"]["message"]


async def test_human_surfaces_never_carry_agent_text(client, db, container, make_agent, gh):
    cid = container["id"]
    human = await make_agent("Kedar", kind="human")
    atlas = await make_agent("Atlas")
    t = await _thread(client, cid, human["agent_id"], atlas["agent_id"])
    snap = (await client.get(f"/api/containers/{cid}")).json()
    r = next(x for x in snap["requests"] if str(x["id"]) == t["request_id"])
    assert r["payload"] == QUESTION
    assert "agent_payload" not in r
    # the audit/activity event previews the question, not the wake text
    ev = db.execute("SELECT detail FROM events WHERE entity_id=%s AND event_type='created'",
                    (t["request_id"],))
    assert ev and ev[0]["detail"]["preview"] == QUESTION[:120]


async def test_code_thread_question_is_never_promoted_to_a_task(client, db, container, make_agent, gh):
    """A request that carries its own agent instructions (a code-thread question answered IN the
    thread) skips the GH #71 work-verb auto-promotion: 'Fix this bug please' stays info."""
    cid = container["id"]
    human = await make_agent("Kedar", kind="human")
    atlas = await make_agent("Atlas")
    t = await _thread(client, cid, human["agent_id"], atlas["agent_id"], kind="question",
                      body="Fix this bug please")
    assert _req(db, t["request_id"])["type"] == "info"


async def test_plain_requests_are_unchanged(client, db, container, make_agent, make_request):
    a = await make_agent("Asker")
    await make_agent("Bob")
    d = await make_request(a["agent_id"], "What is the ETA?", target_alias="Bob")
    row = _req(db, d["id"])
    assert row["agent_payload"] is None and row["payload"] == "What is the ETA?"
    ev = [e for e in db.execute("SELECT payload FROM agent_events WHERE event_name='request_created' "
                                "AND payload->>'request_id'=%s", (d["id"],))]
    assert ev[0]["payload"]["preview"] == "What is the ETA?"


async def test_openapi_documents_agent_payload(client):
    spec = (await client.get("/openapi.json")).json()
    schemas = spec["components"]["schemas"]
    assert "agent_payload" in schemas["RequestCreate"]["properties"]
    assert "agent_payload" in schemas["RequestRow"]["properties"]
    ok = spec["paths"]["/api/containers/{cid}/requests"]["get"]["responses"]["200"]
    assert ok["content"]["application/json"]["schema"]["$ref"].endswith("/RequestListResponse")
    inbox = spec["paths"]["/api/agents/{aid}/inbox"]["get"]["responses"]["200"]
    assert inbox["content"]["application/json"]["schema"]["$ref"].endswith("/AgentInboxResponse")


# ------------------------------------------------------------ old rows ---

async def test_migration_065_backfills_legacy_combined_rows(client, db, container, make_agent, gh):
    cid = container["id"]
    human = await make_agent("Kedar", kind="human")
    atlas = await make_agent("Atlas")
    t = await _thread(client, cid, human["agent_id"], atlas["agent_id"])
    rid = t["request_id"]
    legacy = _req(db, rid)["agent_payload"]
    # rewind the row to the pre-065 shape: combined text in payload, no agent_payload/detail
    db.execute("UPDATE requests SET payload=%s, agent_payload=NULL, detail=NULL WHERE id=%s", (legacy, rid))
    plain = await make_request_row(db, cid, human["agent_id"], atlas["agent_id"], "Unrelated ask")

    _run_sql(MIGRATION_065.read_text())
    row = _req(db, rid)
    assert row["agent_payload"] == legacy          # the agent's view is unchanged
    assert row["payload"] == QUESTION              # people see the question
    assert row["detail"]["code_thread"]["thread_id"] == t["id"]
    assert row["detail"]["code_thread"]["link"] == f"/code?path=deploy/docker-compose.yml&thread={t['id']}"
    other = _req(db, plain)
    assert other["agent_payload"] is None and other["payload"] == "Unrelated ask"
    _run_sql(MIGRATION_065.read_text())            # idempotent
    assert _req(db, rid)["payload"] == QUESTION


def _run_sql(sql):
    """Run a migration file as the runner does (no bind params, so LIKE '%' is literal)."""
    import psycopg
    from conftest import TEST_URL
    with psycopg.connect(TEST_URL, autocommit=True) as conn:
        conn.execute(sql)


async def make_request_row(db, cid, requester, target, payload):
    return str(db.execute(
        """INSERT INTO requests (container_id, type, requester_id, target_id, priority, status, payload,
                                 expires_at, chain_depth)
           VALUES (%s, 'info', %s, %s, 100, 'open', %s, now() + interval '1 hour', 0) RETURNING id""",
        (cid, requester, target, payload))[0]["id"])


# -------------------------------------------------------- auto-resolve ---

async def test_agent_answer_in_thread_auto_resolves_a_humans_request(client, db, container, make_agent, gh):
    cid = container["id"]
    human = await make_agent("Kedar", kind="human")
    atlas = await make_agent("Atlas")
    t = await _thread(client, cid, human["agent_id"], atlas["agent_id"])
    rid = t["request_id"]
    r = await client.post(f"/api/code/threads/{t['id']}/messages",
                          json={"actor_agent_id": atlas["agent_id"], "body": "# Deploy tour\nCompose runs it."})
    assert r.status_code == 201 and r.json()["status"] == "answered", r.text
    row = _req(db, rid)
    assert row["status"] == "closed"
    assert row["response"] == "# Deploy tour\nCompose runs it."
    assert row["responded_at"] is not None and row["closed_at"] is not None
    assert row["detail"]["auto_resolved"] == "thread_answered"
    # the asker is notified of the answer; the agent's request_created is acked (no re-wake)
    assert any(e["event_name"] == "request_answered" and e["payload"]["request_id"] == rid
               for e in db.event_rows(human["agent_id"]))
    created = [e for e in db.event_rows(atlas["agent_id"]) if e["event_name"] == "request_created"]
    acked = db.execute("SELECT 1 FROM agent_event_acks WHERE agent_id=%s AND event_id=%s",
                       (atlas["agent_id"], created[-1]["id"]))
    assert acked
    assert not [e for e in db.event_rows(atlas["agent_id"]) if e["event_name"] == "request_closed"]
    # a second reply changes nothing
    r = await client.post(f"/api/code/threads/{t['id']}/messages",
                          json={"actor_agent_id": atlas["agent_id"], "body": "also X"})
    assert r.status_code == 201
    assert _req(db, rid)["response"] == "# Deploy tour\nCompose runs it."


async def test_agent_answer_leaves_an_ai_askers_request_answered(client, db, container, make_agent, gh):
    cid = container["id"]
    asker = await make_agent("Scout")
    atlas = await make_agent("Atlas")
    t = await _thread(client, cid, asker["agent_id"], atlas["agent_id"], kind="question", body="Why?")
    await client.post(f"/api/code/threads/{t['id']}/messages",
                      json={"actor_agent_id": atlas["agent_id"], "body": "Because."})
    row = _req(db, t["request_id"])
    assert row["status"] == "answered" and row["response"] == "Because."
    assert any(e["event_name"] == "request_answered" for e in db.event_rows(asker["agent_id"]))


async def test_human_resolving_the_thread_closes_its_request(client, db, container, make_agent, gh):
    cid = container["id"]
    human = await make_agent("Kedar", kind="human")
    atlas = await make_agent("Atlas")
    t = await _thread(client, cid, human["agent_id"], atlas["agent_id"], kind="question", body="Why?")
    r = await client.post(f"/api/code/threads/{t['id']}/messages",
                          json={"actor_agent_id": human["agent_id"], "body": "never mind", "resolve": True})
    assert r.status_code == 201 and r.json()["status"] == "resolved"
    row = _req(db, t["request_id"])
    assert row["status"] == "closed" and row["detail"]["auto_resolved"] == "thread_resolved"
    assert any(e["event_name"] == "request_closed" for e in db.event_rows(atlas["agent_id"]))


# ------------------------------------------------------ one-click resolve ---

async def test_one_click_resolve_is_the_requesters_reasonless_close(client, db, container, make_agent, make_request):
    """The portal's Resolve sends POST /close {requester_agent_id} with NO reason: allowed for the
    requester's own answered question (never forced, no reason decision), idempotent on retry."""
    human = await make_agent("Kedar", kind="human")
    atlas = await make_agent("Atlas")
    d = await make_request(human["agent_id"], "What is the ETA?", target_alias="Atlas")
    await client.post(f"/api/requests/{d['id']}/respond",
                      json={"responder_agent_id": atlas["agent_id"], "response": "Today."})
    r = await client.post(f"/api/requests/{d['id']}/close", json={"requester_agent_id": human["agent_id"]})
    assert r.status_code == 200, r.text
    assert r.json() == {"request_id": d["id"], "status": "closed", "forced_by_human": False}
    assert _req(db, d["id"])["status"] == "closed"
    assert not db.execute("SELECT 1 FROM decisions WHERE subject_id=%s", (d["id"],))
    again = await client.post(f"/api/requests/{d['id']}/close", json={"requester_agent_id": human["agent_id"]})
    assert again.status_code == 200 and again.json()["already_closed"] is True
    # someone else's request still needs a reason (the dialog path, unchanged)
    other = await make_agent("Mira", kind="human")
    d2 = await make_request(human["agent_id"], "Second?", target_alias="Atlas")
    r = await client.post(f"/api/requests/{d2['id']}/close", json={"requester_agent_id": other["agent_id"]})
    assert r.status_code == 422
