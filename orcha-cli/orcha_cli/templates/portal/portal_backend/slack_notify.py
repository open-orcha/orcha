"""Outbound Slack (Feature B) — Block Kit message composers + the needs_verification
ping, IF the container has a slack_webhook_url configured.

This module is the ONE home for every Slack-facing Block Kit composer — the outbound
needs_verification ping AND the ephemeral replies slack_routes.py sends for its slash
commands. Keeping them together means one design language (header + mrkdwn section +
muted context line + button) and one place that escapes mrkdwn (`_mrkdwn_escape`) so a
title containing `<`, `>`, or `&` can never break a message's block structure.

Every composer here is a small PURE function: (data in) -> block array (out). No DB, no
network, no request object — trivially unit-testable against the JSON shape, and reused
identically whether the caller is the outbound webhook path or an inbound slash reply.

Outbound contract — non-fatal, by construction, exactly like push_outbox:
  * Called AFTER the route handler's own commit, outside its transaction. A Slack ping
    is advisory delivery, never domain state — the transition must land identically
    whether or not Slack is configured or reachable. Every path swallows EVERY exception
    (a missing column on a half-migrated stack, a dead webhook, a network timeout).
  * Cheapest gate first: no webhook configured → return without touching the network.
  * Re-reads the transition in its OWN connection (post-commit rows are visible) so it
    only pings a task that is genuinely at needs_verification.

The webhook URL is a container-level Slack Incoming Webhook (mig 044). We POST the Block
Kit JSON with stdlib urllib (no httpx dependency), a short timeout, and never raise.

Issue-creation composers (`blocks_issue_filed`, `blocks_github_permission_error`,
`blocks_issue_usage_help`, `build_create_issue_modal`) extend the same design language
to the "file a GitHub issue from Slack" flow (`/orcha issue ...` and the "Create GitHub
issue" message shortcut, both in slack_routes.py) — still pure functions, still one
escaping seam. `call_slack_api` is the ONE network leaf for authenticated Slack Web API
calls (`views.open`, `views.update`, `chat.postEphemeral`) the interactive flow needs,
kept separate from `_post_webhook` (which posts to a container's incoming webhook with
no auth) because Web API calls carry `SLACK_BOT_TOKEN` and CAN be on the fatal path
(e.g. a modal that fails to open should surface, not vanish silently).
"""

import json
import os
import urllib.error
import urllib.request

from portal_backend.database import db_cursor

SLACK_POST_TIMEOUT_SECONDS = 5
# The modal body textarea's practical cap (Slack's own plain_text_input hard limit is
# 3000 chars; GitHub issue bodies can run far longer, but a Slack conversation excerpt
# has no business being that large — this keeps the modal render snappy and leaves
# headroom for the provenance footer this module's caller appends).
MAX_ISSUE_BODY_CHARS = 2800
# The portal base URL for deep links. Slack buttons need an ABSOLUTE, externally
# reachable URL (Slack's servers fetch/redirect through it — unlike phone LAN pairing,
# there is no "derive from the inbound request host" that is safe here: a box behind a
# reverse proxy may see 127.0.0.1 or an internal container hostname on request.url).
# ORCHA_PORTAL_BASE_URL is the existing, documented config-based source for this
# (same channel as other deployment config, e.g. ORCHA_LLM_API_KEY). Optional: without
# it, messages still carry the task title — a button is a nicety, not a requirement.
PORTAL_BASE_URL_ENV = "ORCHA_PORTAL_BASE_URL"


def portal_base_url() -> str:
    """The configured portal base URL, or "" when unset. Single source every Slack
    composer/link builder in this module (and slack_routes.py) reads through."""
    return (os.environ.get(PORTAL_BASE_URL_ENV) or "").strip().rstrip("/")


def portal_task_link(container_id, task_id):
    """Absolute deep link to a task, or None without a configured base URL.

    NOTE: the served route is the extensionless `/tasks` (dashboard_routes.tasks_page)
    — static files are mounted at /assets, not at the site root, so `/tasks.html` 404s.
    The route reads `?cid=` + optional `?task=` (tasks-boot.js), matching the same
    `withCid`-built links the portal's own sidebar/cards use (app-shell.js).
    """
    base = portal_base_url()
    if not base:
        return None
    return f"{base}/tasks?cid={container_id}&task={task_id}"


# ---- mrkdwn escaping --------------------------------------------------------------

def _mrkdwn_escape(text: str) -> str:
    """Slack's mrkdwn requires literal `&`, `<`, `>` in message text to be entity-escaped
    (Slack's own documented escaping order: & first, then < and >) — otherwise a title
    containing those characters (e.g. "Fix <script> handling & the > operator") can be
    misread as a broken/expanded link/mention token by Slack's renderer."""
    text = text or ""
    return text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def _mrkdwn_link(url: str, text: str) -> str:
    """Slack mrkdwn link syntax `<url|text>` with the visible text escaped (the URL
    itself is not mrkdwn-escaped — Slack does not entity-decode URLs)."""
    return f"<{url}|{_mrkdwn_escape(text)}>"


# ---- shared block primitives -------------------------------------------------------

def _header(emoji: str, text: str) -> dict:
    return {"type": "header", "text": {"type": "plain_text", "text": f"{emoji} {text}"}}


def _section_mrkdwn(text: str) -> dict:
    return {"type": "section", "text": {"type": "mrkdwn", "text": text}}


def _context(text: str) -> dict:
    """A muted context line (Slack renders `context` blocks in a smaller, greyed style)."""
    return {"type": "context", "elements": [{"type": "mrkdwn", "text": text}]}


def _button(text: str, url: str, style: str = None) -> dict:
    button = {"type": "button", "text": {"type": "plain_text", "text": text}, "url": url}
    if style:
        button["style"] = style
    return {"type": "actions", "elements": [button]}


def _link_button_el(text: str, url: str, style: str = None) -> dict:
    """A single link-button ELEMENT (not wrapped in its own `actions` block) — for
    composing a multi-button row via `_actions_row` alongside an interactive button."""
    button = {"type": "button", "text": {"type": "plain_text", "text": text}, "url": url}
    if style:
        button["style"] = style
    return button


def _action_button_el(text: str, action_id: str, value: str, style: str = None) -> dict:
    """A single INTERACTIVE button element — routes through POST /api/slack/interactions
    as a `block_actions` payload (action_id + value) rather than a URL. Used for the
    "Start Orcha task" button on the issue-filed card, so a click drives the SAME shared
    start core (task_start_core.start_task_from_github) every other dispatch path uses,
    without the caller needing to know Orcha's URLs."""
    button = {
        "type": "button",
        "text": {"type": "plain_text", "text": text},
        "action_id": action_id,
        "value": value,
    }
    if style:
        button["style"] = style
    return button


def _actions_row(*elements: dict) -> dict:
    """One `actions` block holding MULTIPLE button elements side by side (as opposed to
    `_button`, which always wraps a single link button in its own block)."""
    return {"type": "actions", "elements": list(elements)}


# ---- composers: outbound needs_verification ping -----------------------------------

def blocks_needs_verification(container_name: str, task_title: str, task_link,
                               project_name: str = None, agent_alias: str = None) -> list:
    """'Needs your verification' — ONE message: header, the task as a mrkdwn section,
    a muted context line (project + agent), and a single 'Verify in Orcha' button when
    we have a link. No channel noise beyond this one message."""
    blocks = [
        _header("🛡️", "Needs your verification"),
        _section_mrkdwn(_mrkdwn_link(task_link, task_title) if task_link
                        else _mrkdwn_escape(task_title)),
    ]
    ctx_parts = []
    if project_name:
        ctx_parts.append(_mrkdwn_escape(project_name))
    if agent_alias:
        ctx_parts.append(_mrkdwn_escape(agent_alias))
    if ctx_parts:
        blocks.append(_context(" · ".join(ctx_parts)))
    if task_link:
        blocks.append(_button("Verify in Orcha", task_link, style="primary"))
    return blocks


# ---- composers: /orcha start ... ----------------------------------------------------

def blocks_start_success(label: str, number: int, html_url, gh_title: str, task_link) -> list:
    """'🚀 Task started' — the GH item as a mrkdwn link (falls back to plain '#N' text
    when we couldn't resolve an html_url), a muted context line explaining routing +
    the verification gate, and an 'Open task in Orcha' button when we have a link."""
    item_text = (_mrkdwn_link(html_url, f"#{number} {gh_title}".strip()) if html_url
                else _mrkdwn_escape(f"#{number} {gh_title}".strip()))
    blocks = [
        _header("🚀", "Task started"),
        _section_mrkdwn(f"{label} {item_text}"),
        _context("assigned: Atlas routes it · a human verifies before anything merges"),
    ]
    if task_link:
        blocks.append(_button("Open task in Orcha", task_link))
    return blocks


def blocks_already_tracked(label: str, number: int, task_link) -> list:
    """'↩️ Already tracked' — this issue/PR already has an open Orcha task; the button
    goes straight to the existing task instead of creating a duplicate."""
    blocks = [
        _header("↩️", "Already tracked"),
        _section_mrkdwn(f"{label} #{number} already has an open Orcha task."),
    ]
    if task_link:
        blocks.append(_button("Open task in Orcha", task_link))
    return blocks


def blocks_unlinked_user() -> list:
    """Friendly explainer for a Slack caller with no linked Orcha member — never acts,
    just points them at Settings."""
    return [
        _header("🔗", "Link your Slack account"),
        _section_mrkdwn(
            "This Slack account isn't linked to an Orcha member yet, so `/orcha` "
            "commands can't act on your behalf."
        ),
        _context("ask an owner to link your Slack ID in Orcha → Settings → Members"),
    ]


def build_unlinked_user_modal() -> dict:
    """A minimal informational modal opened when a message-shortcut invocation
    (views.open IS the ack for a shortcut — there is no other way to respond within
    Slack's 3s window for that payload type) comes from an unlinked Slack user. Reuses
    blocks_unlinked_user's copy so the message matches the slash-command version of
    this same explainer; no "submit" action — Cancel is the only way out, since an
    unlinked caller can never act."""
    return {
        "type": "modal",
        "title": {"type": "plain_text", "text": "Not linked"},
        "close": {"type": "plain_text", "text": "OK"},
        "blocks": blocks_unlinked_user(),
    }


def blocks_usage_help() -> list:
    """Compact usage block for bad/empty slash-command args — the four commands."""
    return [
        _header("❔", "Orcha commands"),
        _section_mrkdwn(
            "*`/orcha start issue <N>`*  —  start a task from GitHub issue #N\n"
            "*`/orcha start pr <N>`*  —  start a task from GitHub PR #N\n"
            "*`/orcha issue <title> [-- <body>]`*  —  file a new GitHub issue\n"
            "*`/orcha tasks`*  —  what needs you in this project"
        ),
    ]


# ---- composers: /orcha issue (+ the message-shortcut modal flow) --------------------

def blocks_issue_filed(number: int, html_url: str, issue_title: str, task_link,
                       start_command: str = None, screenshot_note: str = None) -> list:
    """'📝 Issue filed' — the created GitHub issue as a mrkdwn link, an 'Open on GitHub'
    button, and a second action: a real 'Start Orcha task' button (routes through
    POST /api/slack/interactions as a block_actions click, driving the SAME shared
    task_start_core.start_task_from_github every other dispatch path uses) when
    `task_link` is falsy-irrelevant here — the button is ALWAYS interactive, never a
    URL, so it's offered whenever we have a valid `number` to start from. When
    `start_command` is given instead (no interactivity endpoint reachable — not the
    normal path once /api/slack/interactions ships, but kept for callers that pass
    it), the context line tells the member to run that command instead of showing a
    non-functional button.

    `screenshot_note`, when given (e.g. "2 screenshots attached" or "1/2 screenshots
    attached (some skipped)" — slack_routes._screenshot_status_note), appends ONE more
    muted context line reporting the image-attachment honesty count. Omitted (None)
    when the source message carried no images at all, so a card for a plain-text
    message looks exactly as it did before screenshots existed.
    """
    item_text = _mrkdwn_link(html_url, f"#{number} {issue_title}".strip()) if html_url \
        else _mrkdwn_escape(f"#{number} {issue_title}".strip())
    blocks = [
        _header("📝", "Issue filed"),
        _section_mrkdwn(item_text),
    ]
    if start_command:
        blocks.append(_context(f"run `{start_command}` to start an Orcha task from this"))
        if screenshot_note:
            blocks.append(_context(screenshot_note))
        if html_url:
            blocks.append(_button("Open on GitHub", html_url))
        return blocks

    if screenshot_note:
        blocks.append(_context(screenshot_note))
    buttons = []
    if html_url:
        buttons.append(_link_button_el("Open on GitHub", html_url))
    buttons.append(_action_button_el(
        "Start Orcha task", "slack_start_issue", str(number), style="primary",
    ))
    blocks.append(_actions_row(*buttons))
    return blocks


def blocks_github_permission_error() -> list:
    """A friendly ephemeral card for a 403 from GitHub on issue creation — the GitHub
    App installation lacks the Issues:write permission. Never a stack trace/raw error:
    Slack members aren't expected to read GitHub API error bodies."""
    return [
        _header("🔒", "Can't file that issue"),
        _section_mrkdwn(
            "The GitHub App needs the *Issues: Read and write* permission to file "
            "issues from Slack. Ask an owner to grant it (GitHub → App settings → "
            "Permissions) and reinstall the App, then try again."
        ),
    ]


def blocks_task_created(number: int, issue_html_url: str, issue_title: str,
                        task_link, *, start_failed: bool = False,
                        gh_number_for_retry: int = None,
                        screenshot_note: str = None) -> list:
    """'🚀 Task created' — the "Create Orcha task" shortcut's confirmation: the newly
    filed GitHub issue AND the Orcha task it started, both linked, from the ONE chained
    pipeline (issue create -> task_start_core.start_task_from_github).

    Honesty contract: if the issue was created but starting the task failed
    (`start_failed=True`), this does NOT pretend the task exists — it shows the issue
    link plus a plain-text line telling the member to run `/orcha start issue <N>`
    themselves, exactly like the degraded-fallback copy elsewhere in this module. It
    never silently half-succeeds by rendering a task link that doesn't resolve.

    `screenshot_note`, when given, appends ONE more muted context line reporting the
    image-attachment honesty count (same convention as blocks_issue_filed) — shown
    either way (success or start_failed), since the images landed on the GitHub issue
    independently of whether the task-start step itself succeeded.
    """
    item_text = _mrkdwn_link(issue_html_url, f"#{number} {issue_title}".strip()) if issue_html_url \
        else _mrkdwn_escape(f"#{number} {issue_title}".strip())
    blocks = [
        _header("🚀", "Task created"),
        _section_mrkdwn(f"Issue {item_text}"),
    ]
    if start_failed:
        retry_n = gh_number_for_retry if gh_number_for_retry is not None else number
        blocks.append(_context(
            f"issue filed, but starting the Orcha task failed — run "
            f"`/orcha start issue {retry_n}` to retry"
        ))
        if screenshot_note:
            blocks.append(_context(screenshot_note))
        if issue_html_url:
            blocks.append(_button("Open issue on GitHub", issue_html_url))
        return blocks

    blocks.append(_context("assigned: Atlas routes it · a human verifies before anything merges"))
    if screenshot_note:
        blocks.append(_context(screenshot_note))
    buttons = []
    if issue_html_url:
        buttons.append(_link_button_el("Open issue on GitHub", issue_html_url))
    if task_link:
        buttons.append(_link_button_el("Open task in Orcha", task_link))
    if buttons:
        blocks.append(_actions_row(*buttons))
    return blocks


def blocks_task_created_from_slack(task_title: str, task_link, *,
                                   screenshot_note: str = None) -> list:
    """'🚀 Task created' — the TASK-FIRST confirmation card (the 'Create Orcha task'
    shortcut's redesigned flow: no GitHub issue is filed by the portal anymore; the
    dispatched/routed agent files it per its own DoD — see
    task_start_core.build_slack_captured_dod). Unlike `blocks_task_created` (the
    OLD chained issue-then-task card, no longer used by any production path after
    this redesign but kept with its own unit coverage), this card links ONLY to the
    Orcha task — there is no issue link to show yet; a context line tells the
    member the agent files the refined GitHub issue and posts its link back to the
    task's thread.

    `screenshot_note`, when given, appends the same mandatory-honesty context line
    every other confirmation card in this module uses (see
    slack_routes._screenshot_status_note) — omitted (None) when the source message
    had no screenshots at all.
    """
    blocks = [
        _header("🚀", "Task created"),
        _section_mrkdwn(_mrkdwn_escape(task_title)),
        _context("the agent files the refined GitHub issue — link arrives in the task thread"),
    ]
    if screenshot_note:
        blocks.append(_context(screenshot_note))
    if task_link:
        blocks.append(_button("Open task in Orcha", task_link, style="primary"))
    return blocks


def blocks_github_unreachable_error() -> list:
    """A friendly ephemeral card for a non-403 GitHub/network failure while filing an
    issue (rate limit, timeout, 5xx) — distinct from blocks_github_permission_error
    (that one names a specific fix: grant Issues:write); this one just says try again,
    since there's nothing actionable for the member to configure."""
    return [
        _header("⚠️", "Couldn't file that issue"),
        _section_mrkdwn("Couldn't reach GitHub just now. Try again in a moment."),
    ]


def blocks_issue_usage_help() -> list:
    """Usage card for `/orcha issue` called with no title (or an all-whitespace one)."""
    return [
        _header("❔", "Usage: /orcha issue"),
        _section_mrkdwn(
            "*`/orcha issue <title> [-- <body>]`*\n"
            "Everything before an optional ` -- ` becomes the issue title; anything "
            "after becomes the issue body.\n"
            "Example: `/orcha issue Login button is misaligned -- happens only on "
            "Safari, see screenshot`"
        ),
    ]


# Two message shortcuts share this ONE modal layout, distinguished by the view's own
# `callback_id` (view_submission's routing key — see slack_routes._handle_view_submission):
#   * "Create GitHub issue" -> MODAL_CALLBACK_ID           -> files the issue only.
#   * "Create Orcha task"   -> MODAL_CALLBACK_ID_WITH_TASK -> files the issue AND
#     immediately starts an Orcha task from it (task_start_core, same as every other
#     dispatch path), with an optional assignee picked in-modal.
MODAL_CALLBACK_ID = "create_github_issue_submit"
MODAL_CALLBACK_ID_WITH_TASK = "create_orcha_task_submit"
_MODAL_TITLE_MAX = 80
ASSIGNEE_ACTION_ID = "assignee_select"
ASSIGNEE_BLOCK_ID = "assignee_block"
# static_select's "no selection" sentinel value — Slack has no built-in "unassigned"
# semantics; the caller reads back option "value" and treats this literal as None.
ASSIGNEE_UNASSIGNED_VALUE = "__unassigned__"


def build_create_issue_modal(prefill_title: str, prefill_body: str, *, private_metadata: str = "",
                             with_task: bool = False, assignee_options: list = None) -> dict:
    """The 'Create GitHub issue' / 'Create Orcha task' modal view (views.open payload's
    `view` field) opened from either message shortcut. `prefill_title` is the source
    message's first line, truncated to Slack's plain_text_input practical limit;
    `prefill_body` already carries the full message text + the "— from Slack
    conversation" provenance footer (composed by the caller — this function only lays
    out the view, it doesn't know about Slack messages). `private_metadata` carries
    whatever the submission handler needs back (here: the container_id string) since
    view_submission payloads don't otherwise carry request-time context.

    `with_task=True` (the "Create Orcha task" shortcut) adds an OPTIONAL assignee
    static_select ("Let the orchestrator route it" placeholder — omitting a selection
    means unassigned, Atlas routes it, exactly like a bare `/orcha start`) and changes
    the submit label to "Create task" / title to "Create Orcha task". `assignee_options`
    is a list of {id, alias} dicts for the container's live AI agents — required when
    `with_task=True` (may be empty: an empty roster just means no one to pick, the
    select still renders with only the unassigned option).
    """
    title = (prefill_title or "").strip()[:_MODAL_TITLE_MAX]
    blocks = [
        {
            "type": "input",
            "block_id": "title_block",
            "label": {"type": "plain_text", "text": "Title"},
            "element": {
                "type": "plain_text_input",
                "action_id": "title_input",
                "initial_value": title,
                "max_length": 256,
            },
        },
        {
            "type": "input",
            "block_id": "body_block",
            "label": {"type": "plain_text", "text": "Body"},
            "optional": True,
            "element": {
                "type": "plain_text_input",
                "action_id": "body_input",
                "multiline": True,
                "initial_value": (prefill_body or "")[:MAX_ISSUE_BODY_CHARS],
            },
        },
    ]
    if with_task:
        options = [
            {"text": {"type": "plain_text", "text": a["alias"]}, "value": str(a["id"])}
            for a in (assignee_options or [])
        ]
        blocks.append({
            "type": "input",
            "block_id": ASSIGNEE_BLOCK_ID,
            "label": {"type": "plain_text", "text": "Assignee"},
            "optional": True,
            "element": {
                "type": "static_select",
                "action_id": ASSIGNEE_ACTION_ID,
                "placeholder": {"type": "plain_text", "text": "Let the orchestrator route it"},
                "options": options,
            } if options else {
                # Slack rejects a static_select with an empty `options` array — with no
                # AI agents in the container, degrade to a single disabled-in-spirit
                # "unassigned" option rather than omitting the block (keeps the modal
                # shape/block_id stable for the submission handler either way).
                "type": "static_select",
                "action_id": ASSIGNEE_ACTION_ID,
                "placeholder": {"type": "plain_text", "text": "Let the orchestrator route it"},
                "options": [{
                    "text": {"type": "plain_text", "text": "Unassigned (orchestrator routes it)"},
                    "value": ASSIGNEE_UNASSIGNED_VALUE,
                }],
            },
        })

    return {
        "type": "modal",
        "callback_id": MODAL_CALLBACK_ID_WITH_TASK if with_task else MODAL_CALLBACK_ID,
        "private_metadata": private_metadata,
        "title": {"type": "plain_text",
                  "text": "Create Orcha task" if with_task else "Create GitHub issue"},
        "submit": {"type": "plain_text", "text": "Create task" if with_task else "File issue"},
        "close": {"type": "plain_text", "text": "Cancel"},
        "blocks": blocks,
    }


# ---- composers: /orcha tasks ---------------------------------------------------------

_MAX_VERIFY_LINKS = 5


def blocks_tasks_summary(needs_verification: list, open_requests_count: int,
                          ready_unassigned_count: int, task_link_fn) -> list:
    """'🔔 Needs you' — up to 5 needs_verification task titles as links, then the
    open-requests / ready-unassigned counts. All-zero renders the portal's own
    zero-state phrasing (home-state.js) so the copy matches across surfaces.

    `needs_verification` is a list of {id, title} dicts — callers may pass the FULL set
    (no need to pre-cap at _MAX_VERIFY_LINKS themselves); this composer caps the LINKED
    list itself while still reporting the true total count in the "(n)" label.
    `task_link_fn(task_id) -> str|None` builds each deep link.
    """
    total = len(needs_verification) + open_requests_count + ready_unassigned_count
    blocks = [_header("🔔", "Needs you")]
    if total == 0:
        blocks.append(_section_mrkdwn("✓ Nothing needs you right now."))
        return blocks

    if needs_verification:
        lines = []
        for t in needs_verification[:_MAX_VERIFY_LINKS]:
            link = task_link_fn(t["id"])
            title = _mrkdwn_link(link, t["title"]) if link else _mrkdwn_escape(t["title"])
            lines.append(f"• {title}")
        blocks.append(_section_mrkdwn(
            f"*To verify ({len(needs_verification)})*\n" + "\n".join(lines)
        ))
    else:
        blocks.append(_section_mrkdwn("*To verify (0)*"))

    blocks.append(_context(
        f"Open requests ({open_requests_count}) · "
        f"Ready · unassigned ({ready_unassigned_count})"
    ))
    return blocks


# ---- outbound webhook plumbing -------------------------------------------------------

def _post_webhook(webhook_url: str, payload: dict) -> None:
    body = json.dumps(payload).encode("utf-8")
    request = urllib.request.Request(
        webhook_url,
        data=body,
        headers={"Content-Type": "application/json", "User-Agent": "orcha-portal"},
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=SLACK_POST_TIMEOUT_SECONDS) as response:
        response.read()  # drain; Slack replies 'ok'


SLACK_API = "https://slack.com/api"


def call_slack_api(method: str, bot_token: str, payload: dict) -> dict:
    """POST a Slack Web API method (`views.open`, `views.update`, `chat.postEphemeral`,
    `chat.postMessage`, …) authenticated with the bot token (`SLACK_BOT_TOKEN`) — the
    interactive counterpart to `_post_webhook` (which posts to a container's incoming
    webhook with no auth at all). Slack's Web API always replies HTTP 200 with a JSON
    body carrying `ok: bool`; a non-2xx or a network failure raises RuntimeError so the
    caller can decide fatal-vs-swallow per call site (unlike the outbound ping, some of
    these ARE on the interactive request path and their failure should surface as an
    ephemeral error rather than silently vanish). This is the ONE network leaf for
    calls; tests monkeypatch this function, never urllib directly.
    """
    url = f"{SLACK_API}/{method}"
    request = urllib.request.Request(
        url,
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "Authorization": f"Bearer {bot_token}",
            "Content-Type": "application/json; charset=utf-8",
            "User-Agent": "orcha-portal",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=SLACK_POST_TIMEOUT_SECONDS) as response:
            return json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        raise RuntimeError(f"slack_api_status:{exc.code}") from exc
    except Exception as exc:  # DNS, timeout, TLS, bad JSON — one graceful shape
        raise RuntimeError(f"slack_api_unreachable:{exc}") from exc


def notify_task_needs_verification(container_id, task_id) -> None:
    """A task parked at needs_verification — ping the container's Slack webhook if set.

    Non-fatal and silent by contract: any failure (no column, no webhook, dead URL,
    network error) returns without surfacing. Mirrors push_outbox.push_task_verify.
    """
    try:
        with db_cursor() as (_, cur):
            cur.execute(
                "SELECT name, slack_webhook_url FROM containers WHERE id=%s",
                (container_id,),
            )
            crow = cur.fetchone()
            if not crow or not (crow.get("slack_webhook_url") or "").strip():
                return  # dormant default: no webhook → no network, ever
            cur.execute(
                """SELECT t.title, a.alias AS agent_alias
                     FROM tasks t
                     LEFT JOIN agent_tasks at ON at.task_id = t.id
                                              AND at.assignment_status IN
                                                  ('assigned','accepted','working','done')
                     LEFT JOIN agents a ON a.id = at.agent_id
                    WHERE t.id=%s AND t.container_id=%s AND t.status='needs_verification'
                    ORDER BY at.assignment_status = 'done' DESC
                    LIMIT 1""",
                (task_id, container_id),
            )
            trow = cur.fetchone()
            if not trow:
                return
            webhook = crow["slack_webhook_url"].strip()
            container_name = crow["name"] or "Orcha"
            title = trow["title"]
            agent_alias = trow.get("agent_alias")
        link = portal_task_link(container_id, task_id)
        payload = {
            "blocks": blocks_needs_verification(
                container_name, title, link,
                project_name=container_name, agent_alias=agent_alias,
            ),
            "text": f"Needs verification in {container_name}: {title}",
        }
        _post_webhook(webhook, payload)
    except Exception:
        pass  # best-effort by contract — Slack must never surface in the main flow
