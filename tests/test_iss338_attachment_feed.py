"""#338 ATTACHMENTS feed-to-agent — conversation storage layer (mirror of #301/#330 onto
conversation turns) + the pure feed-to-agent renderers that hand a file's LOCATION + metadata
to the agent at every injection point (task threads + conversations, Claude + Codex).

Storage path mirrors test_iss301 (upload → on-disk → turn persist → read-back → serve), with the
security teeth re-checked for the conversation scope (cross-conversation ref = poison, fabricated
ref, traversal). The feed renderers are pure, so they get direct unit teeth.
"""
import io

import pytest
import pytest_asyncio

import main
from orcha_cli.conversation_prefix import (
    render_attachment_feed,
    format_conversation_history,
    would_truncate,
)


@pytest_asyncio.fixture
async def att_dir(tmp_path, monkeypatch):
    d = tmp_path / "orcha-attachments"
    d.mkdir()
    monkeypatch.setattr(main, "ATTACHMENTS_DIR", d)
    return d


async def _open_conversation(client, ai_id, human_id):
    resp = await client.post(f"/api/agents/{ai_id}/conversations",
                             json={"actor_agent_id": human_id})
    assert resp.status_code in (200, 201), resp.text
    return resp.json()["conversation"]["id"]


@pytest_asyncio.fixture
async def convo(client, make_agent):
    """An active conversation between a human and an AI agent + the ids needed to drive it."""
    ai = await make_agent("dev", "eng", kind="ai")
    human = await make_agent("boss", "lead", kind="human")
    cid = await _open_conversation(client, ai["agent_id"], human["agent_id"])
    return {"conv_id": cid, "ai_id": ai["agent_id"], "human_id": human["agent_id"]}


async def _upload(client, conv_id, filename, content, ctype="application/octet-stream"):
    return await client.post(
        f"/api/conversations/{conv_id}/attachments",
        files={"file": (filename, io.BytesIO(content), ctype)},
    )


async def _append_human_turn(client, conv_id, human_id, content, attachments=None):
    body = {"role": "human", "author_agent_id": human_id, "content": content}
    if attachments is not None:
        body["attachments"] = attachments
    return await client.post(f"/api/conversations/{conv_id}/turns", json=body)


# ---------------- conversation storage (mirror of #301) ----------------

async def test_conv_upload_returns_conversation_scoped_ref(client, convo, att_dir):
    cid = convo["conv_id"]
    r = await _upload(client, cid, "diagram.png", b"\x89PNG\r\n\x1a\nfakepng")
    assert r.status_code == 201, r.text
    ref = r.json()
    assert ref["kind"] == "image" and ref["content_type"] == "image/png"
    # url is conversation-scoped, NOT task-scoped
    assert ref["url"] == f"/api/conversations/{cid}/attachments/{ref['id']}"
    # bytes land under the conversations/<cid>/ subdir (never collide with a task id dir)
    assert (att_dir / "conversations" / cid / ref["id"]).read_bytes().startswith(b"\x89PNG")


async def test_conv_upload_unknown_conversation_404(client, att_dir):
    r = await _upload(client, "00000000-0000-0000-0000-000000000000", "n.txt", b"hi")
    assert r.status_code == 404, r.text


async def test_conv_turn_persists_and_surfaces_attachments(client, convo, att_dir):
    cid, human = convo["conv_id"], convo["human_id"]
    up = (await _upload(client, cid, "notes.txt", b"hello")).json()
    # the client re-sends the ref it got from upload (id + display name)
    r = await _append_human_turn(client, cid, human, "see attached", attachments=[up])
    assert r.status_code == 201, r.text
    turn = r.json()["turn"]
    assert turn["attachments"][0]["id"] == up["id"]
    assert turn["attachments"][0]["name"] == "notes.txt"
    # surfaced by BOTH read paths (list_turns + the agent-convenience endpoint the feed reads)
    lt = (await client.get(f"/api/conversations/{cid}/turns")).json()["turns"]
    assert lt[-1]["attachments"][0]["id"] == up["id"]
    ac = (await client.get(f"/api/agents/{convo['ai_id']}/conversation")).json()["turns"]
    assert ac[-1]["attachments"][0]["id"] == up["id"]


async def test_task_upload_caches_extracted_text_and_message_persists_it(
        client, make_agent, make_task, att_dir, monkeypatch):
    monkeypatch.setenv("ORCHA_LLM_API_KEY", "sk-test-vision")
    calls = []

    def fake_describe(data, content_type, **kwargs):
        calls.append({"data": data, "content_type": content_type, "api_key": kwargs.get("api_key")})
        return "OCR: task diagram text"

    monkeypatch.setattr(main.llm_util, "describe_image", fake_describe)
    await make_agent("taskdev", "eng")
    task = await make_task("image task", "done", assignee_alias="taskdev")
    up = (await client.post(
        f"/api/tasks/{task['task_id']}/attachments",
        files={"file": ("diagram.png", io.BytesIO(b"\x89PNGdata"), "image/png")},
    )).json()
    assert up["extracted_text"] == "OCR: task diagram text"
    assert calls == [{"data": b"\x89PNGdata", "content_type": "image/png",
                      "api_key": "sk-test-vision"}]

    # The client may send back only the id/name; validation rehydrates the cached text from the
    # server-side sidecar and persists it on the task message row without re-OCRing.
    r = await client.post(
        f"/api/tasks/{task['task_id']}/messages",
        json={"body": "see image", "attachments": [{"id": up["id"], "name": "diagram.png"}]},
    )
    assert r.status_code == 201, r.text
    msg = (await client.get(f"/api/tasks/{task['task_id']}/messages")).json()["messages"][-1]
    assert msg["attachments"][0]["extracted_text"] == "OCR: task diagram text"
    assert len(calls) == 1
    line = main._render_attachment_feed_line(msg["attachments"])
    assert "auto-transcribed text: OCR: task diagram text" in line


async def test_conv_upload_caches_extracted_text_and_turn_persists_it(
        client, convo, att_dir, monkeypatch):
    monkeypatch.setenv("ORCHA_LLM_API_KEY", "sk-test-vision")
    calls = []

    def fake_describe(data, content_type, **kwargs):
        calls.append((data, content_type, kwargs.get("api_key")))
        return "OCR: conversation image text"

    monkeypatch.setattr(main.llm_util, "describe_image", fake_describe)
    cid, human = convo["conv_id"], convo["human_id"]
    up = (await _upload(client, cid, "whiteboard.png", b"\x89PNGboard", "image/png")).json()
    assert up["extracted_text"] == "OCR: conversation image text"
    assert calls == [(b"\x89PNGboard", "image/png", "sk-test-vision")]

    r = await _append_human_turn(
        client, cid, human, "see the board",
        attachments=[{"id": up["id"], "name": "whiteboard.png"}],
    )
    assert r.status_code == 201, r.text
    assert r.json()["turn"]["attachments"][0]["extracted_text"] == "OCR: conversation image text"
    assert len(calls) == 1


async def test_upload_extraction_failure_is_fail_open(client, convo, att_dir, monkeypatch):
    monkeypatch.setenv("ORCHA_LLM_API_KEY", "sk-test-vision")

    def boom(*args, **kwargs):
        raise RuntimeError("vision unavailable")

    monkeypatch.setattr(main.llm_util, "describe_image", boom)
    r = await _upload(client, convo["conv_id"], "still.png", b"\x89PNGstill", "image/png")
    assert r.status_code == 201, r.text
    assert "extracted_text" not in r.json()


async def test_conv_turn_without_attachments_is_empty_list(client, convo, att_dir):
    cid, human = convo["conv_id"], convo["human_id"]
    r = await _append_human_turn(client, cid, human, "just text")
    assert r.status_code == 201, r.text
    assert r.json()["turn"]["attachments"] == []


async def test_conv_serve_roundtrip_and_disposition(client, convo, att_dir):
    cid = convo["conv_id"]
    up = (await _upload(client, cid, "a.txt", b"bytes-on-disk")).json()
    r = await client.get(up["url"])
    assert r.status_code == 200, r.text
    assert r.content == b"bytes-on-disk"
    # non-image → forced download (never renders in the portal origin), nosniff set
    assert "attachment" in r.headers["content-disposition"]
    assert r.headers["x-content-type-options"] == "nosniff"


# ---------------- security teeth (conversation scope) ----------------

async def test_conv_turn_rejects_fabricated_ref(client, convo, att_dir):
    cid, human = convo["conv_id"], convo["human_id"]
    # an id that was never uploaded must 400 (JSONB can only hold real, this-conversation files)
    r = await _append_human_turn(client, cid, human, "x",
                                 attachments=[{"id": "deadbeef_ghost.txt"}])
    assert r.status_code == 400, r.text


async def test_conv_ref_cannot_cross_conversations(client, make_agent, att_dir):
    # Upload to conversation A, then try to reference that stored id from conversation B → 400.
    cid_a = await _open_conversation(
        client, (await make_agent("a1", kind="ai"))["agent_id"],
        (await make_agent("h1", kind="human"))["agent_id"])
    b_h = (await make_agent("h2", kind="human"))["agent_id"]
    cid_b = await _open_conversation(client, (await make_agent("a2", kind="ai"))["agent_id"], b_h)
    up = (await _upload(client, cid_a, "secret.txt", b"owned by A")).json()
    r = await _append_human_turn(client, cid_b, b_h, "steal", attachments=[{"id": up["id"]}])
    assert r.status_code == 400, r.text   # B's dir has no such file → rejected


async def test_conv_serve_rejects_path_traversal(client, convo, att_dir):
    cid = convo["conv_id"]
    r = await client.get(f"/api/conversations/{cid}/attachments/..%2f..%2fsecret")
    assert r.status_code in (400, 404), r.text


# ---------------- pure feed renderers (the agent-facing teeth) ----------------

_ATTS = [
    {"id": "a_pic.png", "name": "pic.png", "kind": "image",
     "content_type": "image/png", "size": 2048, "url": "/api/conversations/C/attachments/a_pic.png"},
    {"id": "b_doc.pdf", "name": "doc.pdf", "kind": "file",
     "content_type": "application/pdf", "size": 10, "url": "/api/conversations/C/attachments/b_doc.pdf"},
]


def test_feed_lists_files_with_absolute_urls():
    out = render_attachment_feed(_ATTS, api_base="http://host:8003/", runtime="claude")
    assert "pic.png" in out and "doc.pdf" in out
    # relative ref becomes an absolute, directly-fetchable URL (no double slash)
    assert "http://host:8003/api/conversations/C/attachments/a_pic.png" in out
    assert "http://host:8003//api" not in out


def test_feed_runtime_guidance_differs():
    claude = render_attachment_feed(_ATTS, api_base="http://h", runtime="claude")
    codex = render_attachment_feed(_ATTS, api_base="http://h", runtime="codex")
    # Claude is told it can SEE images (native vision via Read); Codex is told it CANNOT.
    assert "SEE" in claude or "render visually" in claude
    assert "CANNOT view image" in codex


def test_feed_empty_is_blank():
    assert render_attachment_feed([]) == ""
    assert render_attachment_feed(None) == ""
    # a non-dict junk ref is filtered, not rendered
    assert render_attachment_feed(["nonsense", 5]) == ""


def test_history_marks_shared_files_and_is_cache_stable():
    turns = [{"role": "human", "content": "look", "attachments": _ATTS},
             {"role": "agent", "content": "ok"}]
    block = format_conversation_history(turns)
    assert "attached 2 file(s)" in block and "pic.png" in block
    # byte-identical across identical inputs (prompt-cache invariant)
    assert format_conversation_history(turns) == block


def test_history_marker_changes_truncation_signal():
    # attachments add rendered length → would_truncate must account for them (no drift between the
    # formatter and its budget oracle, which both route through _render/_line).
    turns = [{"role": "human", "content": "x" * 50, "attachments": _ATTS}]
    # with a budget below the attachment-inflated render, the formatter trims (signal True)
    assert would_truncate(turns, char_budget=40) is True


def test_history_keeps_attachment_only_turn():
    # #338 gap: current delivery allows attachment-only turns (no text), so once such a turn
    # becomes history its file context MUST survive cold boot. The prior content-only filter
    # dropped it — losing the file entirely. Now an attachment-only turn renders its marker.
    turns = [{"role": "human", "content": "", "attachments": _ATTS},
             {"role": "agent", "content": "ack"}]
    block = format_conversation_history(turns)
    assert "attached 2 file(s)" in block and "pic.png" in block
    # the budget oracle agrees the turn is kept (non-empty render, not dropped to "")
    assert would_truncate([turns[0]]) is False
    # a truly empty turn (no content, no valid attachments) is still dropped
    assert format_conversation_history([{"role": "human", "content": "", "attachments": []}]) == ""
    assert format_conversation_history([{"role": "human", "content": "  "}]) == ""


# ---------------- Codex image->text (scope point 4: NOT deferred, V1) ----------------
# A text-only Codex runtime cannot view image/PDF pixels, so describe_image OCRs the bytes to
# text and the feed inlines it. The conversion uses the Orcha-managed key (works for Codex) and
# FAILS OPEN — a miss leaves the agent the URL, never breaks the spawn.

from orcha_cli import llm_util as L  # noqa: E402


class _FakeVision(L.Provider):
    name = "fake"

    def __init__(self, *, text=None, raise_exc=None):
        self._text = text
        self._raise = raise_exc
        self.calls = []

    def complete(self, *, spec, system, messages, tools=None, tool_choice=None, api_key):
        self.calls.append({"system": system, "messages": messages, "spec": spec})
        if self._raise:
            raise self._raise
        return {"text": self._text, "tool_calls": [], "usage": {}, "stop_reason": "end_turn"}


def test_can_describe_images_and_pdf_only():
    assert L.can_describe("image/png") and L.can_describe("application/pdf")
    assert not L.can_describe("text/plain") and not L.can_describe(None)


def test_describe_image_sends_image_block_and_returns_text():
    prov = _FakeVision(text="invoice total $42")
    out = L.describe_image(b"\x89PNG-bytes", "image/png", provider=prov)
    assert out == "invoice total $42"
    # the bytes were sent as a base64 IMAGE content block (not text) to a vision model
    blocks = prov.calls[0]["messages"][0]["content"]
    img = next(b for b in blocks if b["type"] == "image")
    assert img["source"]["type"] == "base64" and img["source"]["media_type"] == "image/png"
    assert img["source"]["data"]  # base64 payload present


def test_describe_pdf_uses_document_block():
    prov = _FakeVision(text="page 1 text")
    out = L.describe_image(b"%PDF-1.4", "application/pdf", provider=prov)
    assert out == "page 1 text"
    blocks = prov.calls[0]["messages"][0]["content"]
    assert any(b["type"] == "document" for b in blocks)


def test_describe_image_unsupported_type_is_blank_no_call():
    prov = _FakeVision(text="should not happen")
    assert L.describe_image(b"plain", "text/plain", provider=prov) == ""
    assert prov.calls == []  # never hits the model for a non-OCR-able type


def test_describe_image_fails_open_on_provider_error():
    prov = _FakeVision(raise_exc=RuntimeError("api down"))
    # a flaky vision call must NEVER raise — it degrades to "" (agent still gets the URL)
    assert L.describe_image(b"\x89PNG", "image/png", provider=prov) == ""


def test_describe_image_empty_output_is_blank():
    assert L.describe_image(b"\x89PNG", "image/png", provider=_FakeVision(text="   ")) == ""


# ---------------- feed inlines extracted text for the text-only runtime ----------------

def test_feed_inlines_extracted_text_for_codex():
    out = render_attachment_feed(
        _ATTS, api_base="http://h", runtime="codex",
        extracted={"a_pic.png": "OCR: hello from the image"})
    assert "OCR: hello from the image" in out
    assert "auto-transcribed" in out
    # exactly ONE file got an inline transcription block (the ↳ marker); the other image has no
    # extracted entry so it is not given a phantom block.
    assert out.count("↳ auto-transcribed") == 1


def test_feed_reads_cached_extracted_text_from_attachment_ref():
    atts = [dict(_ATTS[0], extracted_text="OCR: cached ref text")]
    out = render_attachment_feed(atts, api_base="http://h", runtime="codex")
    assert "OCR: cached ref text" in out
    assert "auto-transcribed" in out


def test_feed_does_not_auto_inline_cached_text_for_claude():
    atts = [dict(_ATTS[0], extracted_text="OCR: cached ref text")]
    out = render_attachment_feed(atts, api_base="http://h", runtime="claude")
    assert "OCR: cached ref text" not in out
    assert "auto-transcribed" not in out


def test_feed_without_extracted_has_no_inline_block():
    out = render_attachment_feed(_ATTS, api_base="http://h", runtime="claude")
    assert "auto-transcribed" not in out  # Claude has native vision; no OCR inlined


# ---------------- notifier wiring: Codex worker consumes cached image text ----------------

def test_notifier_extract_attachment_text_uses_cached_refs():
    from orcha_cli import notifier as N
    atts = [dict(_ATTS[0], extracted_text="cached image"),
            dict(_ATTS[1], extracted_text="cached pdf")]
    got = N._extract_attachment_text(atts, "http://h")
    assert got["a_pic.png"] == "cached image"
    assert got["b_doc.pdf"] == "cached pdf"


def test_notifier_extract_skips_refs_without_cached_text():
    from orcha_cli import notifier as N
    txt = [{"id": "c.txt", "name": "c.txt", "kind": "file", "content_type": "text/plain",
            "url": "/api/conversations/C/attachments/c.txt"}]
    assert N._extract_attachment_text(txt, "http://h") == {}
    assert N._extract_attachment_text(_ATTS, "http://h") == {}


def test_conversation_worker_prompt_uses_cached_text_without_wake_time_ocr():
    from orcha_cli import notifier as N
    pending = [{"seq": 7, "content": "", "attachments": [
        dict(_ATTS[0], extracted_text="OCR: prompt-visible image")
    ]}]
    out = N._conversation_worker_prompt("dev", pending, [], api_base="http://h")
    assert "OCR: prompt-visible image" in out
    assert "auto-transcribed" in out
