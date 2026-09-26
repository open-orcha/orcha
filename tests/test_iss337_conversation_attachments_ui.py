"""#337 — file attachments on agent CONVERSATIONS (parity with #330 task-thread attachments).

The conversation-attachment BACKEND + agent-feed landed with #338 (upload/serve routes,
``conversation_turns.attachments``, ``render_attachment_feed`` — covered by
``test_iss338_attachment_feed``). #337 closes the loop on the FRONTEND: a paperclip /
drag-drop / paste composer that stages + uploads to the conversation-scoped store, rides
the stored ids on the turn POST, and renders attachments in the read view (image
thumbnails w/ lightbox, file download chips).

MIGRATED (portal React migration Phase 7): the composer lives in the React SPA —
frontend/src/pages/agents/Conversation.tsx (+ agents.css for the styles). The node
behavioral harnesses (real upload→send path; the Gate P1 stale-upload/remount race)
moved to Vitest: frontend/src/pages/agents/Conversation.test.tsx. The static guards
below pin the wiring in the React SOURCE.
"""
import pathlib

REPO = pathlib.Path(__file__).resolve().parent.parent
SRC = REPO / "orcha-cli" / "orcha_cli" / "templates" / "portal" / "frontend" / "src"


def _conv() -> str:
    return (SRC / "pages" / "agents" / "Conversation.tsx").read_text()


# ---------- static guards: composer affordance ----------

def test_conversation_composer_has_attachment_affordance():
    js = _conv()
    # paperclip button + hidden file input + staging tray in the composer
    assert 'id="convAttach"' in js and 'id="convAttachInput"' in js, "no attach button / file input in the composer"
    assert 'id="convTray"' in js, "no staging tray in the composer"
    assert 'type="file"' in js and 'accept=".png' in js, "file input missing the type-allowlist accept"
    # wired on the composer (paperclip click / drag-drop / paste)
    assert "uploadConvFiles" in js, "attach controls not wired to the upload path"
    assert "onDragEnter" in js and "onDragOver" in js and "onDrop" in js, "no drag-drop wiring"
    assert "onPaste" in js, "no paste-to-attach wiring"


# ---------- static guards: upload is conversation-scoped + get-or-create first ----------

def test_conversation_upload_is_conversation_scoped():
    js = _conv()
    assert '"/api/conversations/" + encodeURIComponent(cid) + "/attachments"' in js, \
        "upload not posted to the conversation-scoped attachments route"
    assert "const ensureConv" in js, "no get-or-create helper before a conv-scoped upload"
    assert "FormData" in js and 'fd.append("file"' in js, "upload doesn't send the file as multipart"
    # client-side extension allowlist mirrors the backend allowlist
    assert "ACCEPT_EXT" in js and '"png"' in js and '"pdf"' in js, "no client-side extension allowlist"


# ---------- static guards: the turn POST carries refs + attachment-only is allowed ----------

def test_turn_post_carries_attachments_and_allows_attachment_only():
    js = _conv()
    assert "attachments: atts.length ? atts : undefined" in js, "turn POST doesn't carry staged attachment refs"
    assert "done.map((s) => ({ id: s.ref.id, name: s.ref.name }))" in js, \
        "doesn't send minimal {id,name} refs (server re-validates size/type from disk)"
    # attachment-only turns (no text) are allowed; a truly-empty send is still blocked
    assert "if (!v && !done.length) return;" in js, "doesn't allow attachment-only turns / doesn't block truly-empty"
    assert 'toast("Wait for uploads to finish"' in js, "doesn't block send while an upload is still in flight"
    # the original turn contract is preserved
    assert 'role: "human", author_agent_id: h.id, content: v' in js, "broke the human-turn POST contract"


# ---------- static guards: read view renders attachments + lightbox ----------

def test_read_view_renders_attachments_with_lightbox():
    js = _conv()
    assert "function AttRow" in js, "no read-view attachment renderer"
    assert "t.attachments" in js and "msg-atts" in js, "Bubble doesn't render the turn's attachments"
    assert "att-img" in js and "onZoom" in js, "image attachments not rendered as lightbox thumbnails"
    assert "att-file" in js, "non-image attachments not rendered as download chips"
    assert "att-lightbox" in js, "no lightbox overlay"
    # Escape closes the lightbox
    assert 'e.key === "Escape") setLightbox(null)' in js, "lightbox doesn't close on Escape"


# ---------- static guards: agents.css styles the surface without breaking the §3b lock ----------

def test_agents_css_styles_the_attachment_surface():
    css = (SRC / "pages" / "agents" / "agents.css").read_text()
    for sel in (".conv-attach", ".conv-tray", ".att-chip", ".msg-atts", ".att-img",
                ".att-file", ".att-lightbox", ".conv.dragover"):
        assert sel in css, f"agents.css missing attachment style {sel}"
    # MUST NOT break the §3b lock-dim adjacency (conv-lock must still immediately precede composer)
    assert ".conv-lock:not([hidden]) + .conv-composer" in css, "lock-dim adjacency rule lost"


# ---------- behavioral coverage moved to Vitest ----------

def test_behavioral_coverage_lives_in_vitest():
    """The real upload→send path (conv-scoped URL, get-or-create-first ordering, the
    {id,name} ref on the turn POST) and the Gate P1 stale-upload/remount race (agent A's
    in-flight upload must never leak into agent B's conversation/turn) are exercised
    against the rendered component in frontend/src/pages/agents/Conversation.test.tsx."""
    test = (SRC / "pages" / "agents" / "Conversation.test.tsx").read_text()
    assert "get-or-create first, ref on the turn POST" in test, "Vitest upload→send case missing"
    assert "Gate P1" in test, "Vitest stale-race case missing"
