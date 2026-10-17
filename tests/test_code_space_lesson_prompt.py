"""Learn tab — the agent-facing wake payload for `teach` / `why` code threads nudges the
answer into the lesson shape the portal's LessonCard steps through (title, one-line
summary, numbered steps citing line refs, key concepts, follow-ups).

Backward compatibility is the point of half of these tests: `question` / `note`
payloads must be byte-identical to the pre-lesson format, and the reply instruction +
deep link must survive any question length (the payload is capped at MAX_PAYLOAD_LEN).
The end-to-end test runs the real create route against the test Postgres, stubbing only
the GitHub network leaf (same convention as test_code_space_api.py).
"""
import pytest

from portal_backend import code_space_routes as cs
from portal_backend import github_repo_browse_routes as browse
from portal_backend.limits import MAX_PAYLOAD_LEN

TID = "11111111-2222-3333-4444-555555555555"
ANCHOR = {"repo": "acme/site", "sha": "a" * 40, "path": "src/a.py", "start_line": 10, "end_line": 12}


def _legacy(thread_id, anchor, kind, body):
    """The exact pre-lesson rendering (kept here as the compatibility oracle)."""
    location = f"{anchor['path']}:{anchor['start_line']}-{anchor['end_line']}"
    return (
        f"[code thread — {kind}] {anchor['repo']}@{anchor['sha'][:7]} {location}\n"
        f"{body}\n\n"
        f"reply via POST /api/code/threads/{thread_id}/messages with your agent id as actor_agent_id\n"
        f"view/reply in the portal: /code?path=src/a.py&thread={thread_id}"
    )


@pytest.mark.parametrize("kind", ["teach", "why"])
def test_lesson_kinds_carry_the_step_format_guide(kind):
    text = cs._render_wake_payload(TID, ANCHOR, kind, "Teach me this concept.")
    assert text.startswith(f"[code thread — {kind}] acme/site@aaaaaaa src/a.py:10-12\n")
    assert "Teach me this concept." in text
    # the structure LessonCard parses
    for marker in ("# <lesson title>", "> <one-line summary>", "## Steps", "(L<start>-<end>)",
                   "## Key concepts", "## Follow-ups"):
        assert marker in text, marker
    # it's a nudge, not a hard contract
    assert "plain prose is still accepted" in text
    # guide sits between the question and the reply instruction, which still ends it
    assert text.index("## Steps") > text.index("Teach me this concept.")
    assert text.index("## Steps") < text.index("reply via POST")
    assert text.endswith(f"view/reply in the portal: /code?path=src/a.py&thread={TID}")


@pytest.mark.parametrize("kind", ["question", "note"])
def test_other_kinds_are_byte_identical_to_the_legacy_payload(kind):
    body = "How does this work?"
    assert cs._render_wake_payload(TID, ANCHOR, kind, body) == _legacy(TID, ANCHOR, kind, body)
    assert "## Steps" not in cs._render_wake_payload(TID, ANCHOR, kind, body)


def test_long_question_is_shortened_never_the_instructions():
    body = "x" * (MAX_PAYLOAD_LEN * 2)
    text = cs._render_wake_payload(TID, ANCHOR, "teach", body)
    assert len(text) <= MAX_PAYLOAD_LEN
    assert "…" in text
    assert "## Steps" in text
    assert f"reply via POST /api/code/threads/{TID}/messages" in text
    assert text.endswith(f"&thread={TID}")


def test_short_payloads_are_not_truncated():
    body = "why did we do it this way?"
    text = cs._render_wake_payload(TID, ANCHOR, "why", body)
    assert "…" not in text
    assert f"\n{body}\n\n" in text


def test_tiny_max_len_still_returns_a_bounded_string():
    text = cs._render_wake_payload(TID, ANCHOR, "teach", "question", max_len=40)
    assert len(text) <= 40


# ---- end to end: the directed request created for a teach thread carries the guide ----

@pytest.fixture
def token_env(monkeypatch, tmp_path):
    token_file = tmp_path / "github-token"
    token_file.write_text("ghs_hubtoken\n")
    monkeypatch.setenv("ORCHA_GITHUB_TOKEN_FILE", str(token_file))
    monkeypatch.delenv("ORCHA_GITHUB_TOKENS_FILE", raising=False)
    browse._TREE_CACHE.clear()
    browse._DEFAULT_BRANCH_CACHE.clear()
    yield
    browse._TREE_CACHE.clear()
    browse._DEFAULT_BRANCH_CACHE.clear()


def _stub_gh(monkeypatch):
    def fake_get(path, token):
        if "/commits/" in path:
            return {"sha": "a" * 40}
        if path == "/repos/acme/site":
            return {"default_branch": "main"}
        raise AssertionError(f"unexpected path {path}")

    monkeypatch.setattr(browse, "_gh_get", fake_get)
    monkeypatch.setattr(cs, "_gh_get", fake_get)


@pytest.mark.parametrize("kind,expect_guide", [("teach", True), ("why", True), ("question", False)])
async def test_created_thread_request_payload(client, db, container, make_agent, token_env, monkeypatch,
                                              kind, expect_guide):
    cid = container["id"]
    r = await client.put(f"/api/containers/{cid}/github", json={"repo": "acme/site"})
    assert r.status_code == 200, r.text
    author = await make_agent("Author")
    tagged = await make_agent("Tagged")
    _stub_gh(monkeypatch)

    r = await client.post(
        f"/api/containers/{cid}/code/threads",
        json={
            "actor_agent_id": author["agent_id"], "tagged_agent_id": tagged["agent_id"],
            "path": "src/a.py", "start_line": 10, "end_line": 12,
            "kind": kind, "body": "Explain this file.",
        },
    )
    assert r.status_code == 201, r.text
    thread_id = r.json()["id"]
    request_id = r.json()["request_id"]
    row = db.execute("SELECT payload, agent_payload FROM requests WHERE id=%s", (request_id,))[0]
    # mig 065: people see just the question; the agent's wake text rides agent_payload
    assert row["payload"] == "Explain this file."
    payload = row["agent_payload"]
    assert "Explain this file." in payload
    assert ("## Steps" in payload) is expect_guide
    assert ("## Follow-ups" in payload) is expect_guide
    assert f"POST /api/code/threads/{thread_id}/messages" in payload
    assert f"view/reply in the portal: /code?path=src/a.py&thread={thread_id}" in payload
