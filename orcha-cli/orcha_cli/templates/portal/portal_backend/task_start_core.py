"""The single source of truth for "start an Orcha task from an external trigger".

Feature A (the GitHub hub's POST /github/start) and Feature B (the Slack
`/orcha start ...` slash command) both create an Orcha task from a GitHub
issue/PR. Rather than duplicate the task-creation + assignment mechanics — or
worse, let the two drift — both call ONE function here: `start_task_from_github`.

It reuses the EXACT DB mechanics `task_creation_routes.create_task` uses (the same
`tasks` INSERT columns/defaults, the same `agent_tasks` 'working' row + no-bump +
`recompute_agent_status` + targeted `task_assigned` event, the same `events`
audit row), so a task born from the hub, from Slack, or from the tasks API is
indistinguishable downstream. The caller owns the transaction (passes the open
`cur`) and the commit — this function never commits, so it composes inside a
route handler's `db_cursor()` block and its writes roll back atomically with the
handler on any error.

Idempotency (spec): an OPEN task whose title already carries the `GH #<N>: `
prefix for the same (container, number) is returned with existing=True instead of
creating a duplicate — a double-click on Start, or a Slack retry, is a no-op.

GitHub round-trip comment (fresh starts only): once the task row lands, this posts
a short "🤖 Orcha started task ..." comment back on the source issue/PR — the ONE
place every dispatch path (hub Start/Fix, Slack start) goes through, so it fires
exactly once regardless of caller. It is deliberately posted from HERE, after the
INSERT but still inside the caller's transaction span (the comment itself is not
transactional — a GitHub POST cannot be rolled back — but it only fires once the
task row is built in-memory with a real id, and never on an `existing=True` hit).
Non-fatal by construction, same contract as slack_notify's outbound ping: any
failure (repo not bound, no installation token, GitHub 403/404/network error) is
caught and swallowed — a dead GitHub comment must never break task creation.

Automatic triage (unassigned tasks): an assigned task's targeted `task_assigned`
event is what wakes its assignee — but an UNASSIGNED task (Atlas-routed) had no
symmetric doorbell, so it could sit in `ready` indefinitely with nothing to route
it. `_finish_task_insert`'s unassigned branch now emits a targeted
`task_created_unassigned` event at the container's orchestrator agent (see
`find_orchestrator_agent`), reusing `publish_event` exactly as the assigned branch
does, so the existing notifier wake-scan wakes the orchestrator on its next tick.
No orchestrator agent in the container -> silent no-op, never an error.
"""

import json
import urllib.error
import urllib.request

from portal_backend.agent_status import log_event, recompute_agent_status
from portal_backend.events import publish_event
from portal_backend.github_routes import _read_token, _read_token_map

GITHUB_API = "https://api.github.com"
GITHUB_COMMENT_TIMEOUT_SECONDS = 10

# The GitHub-hub / Slack task title prefix. `GH #<number>: <title>` — the prefix is
# also the idempotency key (a LIKE 'GH #N: %' probe over the container's open tasks).
GH_TITLE_PREFIX = "GH #"

# The opening literal of every round-trip comment `_compose_start_comment` writes, and
# therefore the signature that identifies a comment on an issue/PR as ORCHA'S OWN.
# It is a shared constant (not an inlined f-string) because a second reader depends on
# it: github_hub_routes._orcha_authored_comment subtracts Orcha's own comments from the
# "review feedback to address" count a Fix dispatch puts in the task's DoD. Without that
# subtraction the start comment posted by Fix click #1 is counted back as outstanding
# human feedback by Fix click #2 (GH: "a Fix dispatch's own bot comment gets counted as
# PR review feedback"). If this literal ever changes, comments already on GitHub carrying
# the OLD literal stop being recognised — so prefer appending to the message over editing
# this prefix.
ORCHA_START_COMMENT_MARKER = "🤖 Orcha started task"

# Non-terminal statuses that count as "already tracked" for idempotency. A task in any
# of these is live work for this issue/PR; a completed/cancelled one does NOT block a
# fresh start (you can re-trigger an issue after its first task closed).
_OPEN_STATUSES = ("pending", "ready", "not_ready", "in_progress", "needs_verification")

_ISSUE_DOD = (
    "Before implementing: post a triage comment on GH issue #{n} with codebase-grounded "
    "analysis — the specific modules/files involved, the most likely cause ranked "
    "against the actual code, and what logs/repro would confirm it. Then proceed to "
    "the fix. Fix GH #{n} per its description. Open a PR referencing #{n}. "
    "Fresh-session review, then human review. Never merge."
)
_PULL_DOD = (
    "Resolve CI failures / review feedback on PR #{n}. Push to its branch. "
    "NOT merged without human review."
)

# What the two kinds are called in copy. Keep in sync with the DoD templates above.
_KIND_LABEL = {"issue": "issue", "pull": "pull request"}

# The DoD for a task captured DIRECTLY from a raw Slack report (the "Create Orcha
# task" shortcut's task-first flow — slack_routes._run_task_first_pipeline). Distinct
# from _ISSUE_DOD/_PULL_DOD, which both assume a GitHub issue/PR already exists at
# task-creation time: a slack-captured task has NO GitHub issue yet, so its first
# instruction is to create one — the agent does the refinement the portal used to do
# with an LLM call (see docs/slack-integration.md).
_SLACK_CAPTURED_DOD = (
    "This task was captured from a raw Slack report — no GitHub issue exists for it "
    "yet. Before anything else:\n"
    "1. File a professional GitHub issue for this report in the connected repo: an "
    "imperative, concise title; a structured body with Summary/Observed/Expected/"
    "Technical context sections grounded in the actual codebase (not invented); embed "
    "the screenshots attached to this task (commit them to the repo per its "
    ".github/orcha-attachments convention); quote the reporter's original message "
    "verbatim; and a provenance footer noting it was captured from Slack via Orcha. "
    "Post the new issue's link back as a message on this Orcha task's own thread.\n"
    "2. Then post a codebase-grounded triage comment on that issue — the specific "
    "modules/files involved, the most likely cause ranked against the actual code, "
    "and what logs/repro would confirm it.\n"
    "3. Then proceed to implement per the standard protocol: fix it, open a PR "
    "referencing the issue, fresh-session review, then human review. Never merge "
    "without a human verifying."
)


def build_task_fields(kind: str, number: int, gh_title: str, body_excerpt: str,
                      html_url: str, dod_override: str = None) -> dict:
    """Compose the {title, description, definition_of_done} an external GH trigger
    creates — the spec's templated shape. Pure (no DB), so tests can assert the copy
    directly and both trigger seams share one template. `kind` is 'issue' | 'pull'.

    `dod_override`, when given, REPLACES the generic static `_PULL_DOD`/`_ISSUE_DOD`
    template outright — the GitHub hub's PR "Fix" dispatch (github_hub_routes.py)
    passes a context-aware DoD composed from the PR's actual live state (failing
    checks by name, pending count, review-comment count, draft/mergeable_state) instead
    of this generic fallback; the Slack seam and issue dispatches never pass one, so
    their behavior is unchanged.
    """
    title = f"{GH_TITLE_PREFIX}{number}: {gh_title}".strip()
    dod = dod_override if dod_override else (_PULL_DOD if kind == "pull" else _ISSUE_DOD).format(n=number)
    excerpt = (body_excerpt or "").strip()
    parts = []
    if excerpt:
        parts.append(excerpt)
    if html_url:
        parts.append(html_url)
    parts.append("Triggered from the GitHub hub")
    description = "\n\n".join(parts)
    return {"title": title, "description": description, "definition_of_done": dod}


def _resolve_repo_token(repo: str):
    """The installation token that can read/write `owner/name`, or None when the App
    isn't wired for this owner. Duplicates github_hub_routes._resolve_repo_token's
    logic (rather than importing it) to avoid a circular import: github_hub_routes
    already imports THIS module. Same multi-org-then-legacy-file resolution."""
    owner = (repo or "").split("/", 1)[0].lower()
    token_map = _read_token_map()
    if token_map and owner in token_map:
        return token_map[owner]
    return _read_token()


def _gh_post_comment(repo: str, number: int, token: str, body: str) -> None:
    """POST a comment on a GitHub issue OR pull request. GitHub's REST API treats PR
    comments as issue comments on the SAME endpoint
    (`/repos/{repo}/issues/{number}/comments`) — no separate PR-comment call needed.
    Requires the App's Issues:write permission (docs/byoc-guide.md's permission table;
    already required for `gh issue create`). stdlib urllib, matching every other
    GitHub leaf in this codebase. Raises on failure; the caller swallows it — this
    function itself never degrades silently so tests can assert on the raise.
    """
    url = f"{GITHUB_API}/repos/{repo}/issues/{number}/comments"
    request = urllib.request.Request(
        url,
        data=json.dumps({"body": body}).encode("utf-8"),
        headers={
            "Authorization": f"token {token}",
            "Accept": "application/vnd.github+json",
            "Content-Type": "application/json",
            "User-Agent": "orcha-portal",
        },
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=GITHUB_COMMENT_TIMEOUT_SECONDS) as response:
        response.read()


def _compose_start_comment(task_id: str, assignee_alias) -> str:
    """The round-trip comment body: who's on it, and the standing verification gate.
    `assignee_alias` is None for an unassigned (Atlas-routed) start."""
    who = f"assigned to **{assignee_alias}**" if assignee_alias \
        else "unassigned — the orchestrator routes it"
    short_id = str(task_id)[:8]
    return (
        f"{ORCHA_START_COMMENT_MARKER} `{short_id}` for this — {who}.\n"
        "Work arrives as a PR; a human verifies before anything merges."
    )


def _post_start_comment(cur, container_id, kind: str, number: int, task_id: str,
                        assignee_agent_id) -> None:
    """Best-effort GitHub round-trip comment on a FRESH start (never on an
    existing=True re-click — the caller only invokes this after a real INSERT).
    Non-fatal by construction, same contract as slack_notify's outbound ping: no
    bound repo, no installation token, or any GitHub/network failure is caught and
    swallowed — a dead comment must never break task creation. Runs from the shared
    core so every dispatch path (hub, Slack) gets it exactly once.
    """
    try:
        cur.execute("SELECT github_repo FROM containers WHERE id=%s", (container_id,))
        row = cur.fetchone()
        repo = row["github_repo"] if row else None
        if not repo:
            return
        token = _resolve_repo_token(repo)
        if not token:
            return
        assignee_alias = None
        if assignee_agent_id:
            cur.execute("SELECT alias FROM agents WHERE id=%s", (assignee_agent_id,))
            arow = cur.fetchone()
            assignee_alias = arow["alias"] if arow else None
        body = _compose_start_comment(task_id, assignee_alias)
        _gh_post_comment(repo, number, token, body)
    except Exception:
        pass  # best-effort by contract — a GitHub comment failure never breaks the start


def find_open_gh_tasks(cur, container_id, numbers) -> dict:
    """Batched form of find_open_gh_task: the container's OPEN task id for EVERY number
    in `numbers`, in ONE query — {number: task_id} for numbers that have an open task
    (a number with none is simply absent from the dict, never a None entry). This is
    THE lookup GitHub-hub list/detail rows use to surface "tracked" state up front
    (github_hub_routes' `tracked_task_id` field) — sharing this helper with
    find_open_gh_task (below, which is just this batched form for one number) is
    deliberate: the idempotency check and the hub's "is this already tracked" display
    must use the IDENTICAL title-prefix/status rule or the two can silently drift (a
    row the idempotency check would treat as open but the hub UI doesn't show as
    tracked, or vice versa).

    Matches each number's `GH #<number>: ` title prefix (the exact string
    build_task_fields writes) via a single unnest()+LATERAL join — a LIKE-per-number
    loop would be N queries; this is one, regardless of how many numbers are asked
    about. Only non-terminal statuses count (mirrors find_open_gh_task). Numbers list
    may be empty (returns {} without a query).
    """
    numbers = [int(n) for n in (numbers or [])]
    if not numbers:
        return {}
    cur.execute(
        """SELECT v.number AS number, t.id AS task_id
             FROM (SELECT unnest(%s::int[]) AS number) v
             JOIN LATERAL (
               SELECT id FROM tasks
                WHERE container_id=%s
                  AND status = ANY(%s)
                  AND title LIKE %s || v.number::text || ': %%'
                ORDER BY created_at ASC, id ASC
                LIMIT 1
             ) t ON true""",
        (numbers, container_id, list(_OPEN_STATUSES), GH_TITLE_PREFIX),
    )
    return {int(row["number"]): str(row["task_id"]) for row in cur.fetchall()}


def find_open_gh_task(cur, container_id, number: int):
    """The container's OPEN task already tracking GH #<number>, or None.

    Matches on the `GH #<number>: ` title prefix (the exact string build_task_fields
    writes) so the probe cannot false-match `GH #12` against `GH #123`. Only
    non-terminal tasks count — a finished/cancelled prior task never blocks a
    re-trigger. Returns the task id (str) or None.

    Implemented as the single-number case of find_open_gh_tasks (the batched helper
    the hub's list/detail endpoints use) so the idempotency check and the "tracked"
    display can never drift apart — one SQL shape, two call shapes.
    """
    return find_open_gh_tasks(cur, container_id, [number]).get(number)


def start_task_from_github(cur, container_id, *, kind: str, number: int,
                           gh_title: str, body_excerpt: str, html_url: str,
                           created_by_agent_id, assignee_agent_id=None,
                           source: str = "github_hub", dod_override: str = None):
    """Create (or idempotently return) the Orcha task for a GitHub issue/PR.

    Reuses create_task's DB mechanics verbatim. Returns
    {"task_id": <str>, "existing": <bool>}:
      * existing=True  → an OPEN task already tracked GH #number; nothing was written.
      * existing=False → a new task was created (and, if assignee_agent_id was given,
                         assigned + the assignee woken via a targeted task_assigned).

    `created_by_agent_id` is the resolved acting member (the hub/Slack route resolves
    it through the same identity gate task creation uses); it is attributed as the
    creator and audited. `assignee_agent_id`, when present, must be a live AI agent in
    THIS container — the caller validates that before calling (mirroring create_task's
    assignee_alias resolution, but by id since the hub dropdown/Slack carry agent ids).
    `source` is a free-text provenance tag ('github_hub' | 'slack') recorded on the
    audit + wake events so the two seams are distinguishable in the log. `dod_override`
    passes straight through to build_task_fields — see that function's docstring.

    The caller owns the commit. Never commits or opens its own connection.
    """
    if kind not in ("issue", "pull"):
        raise ValueError(f"kind must be 'issue' or 'pull', got {kind!r}")

    existing = find_open_gh_task(cur, container_id, number)
    if existing:
        return {"task_id": existing, "existing": True}

    fields = build_task_fields(kind, number, gh_title, body_excerpt, html_url, dod_override)

    result = _finish_task_insert(
        cur, container_id,
        title=fields["title"],
        description=fields["description"],
        definition_of_done=fields["definition_of_done"],
        created_by_agent_id=created_by_agent_id,
        assignee_agent_id=assignee_agent_id,
        source=source,
        audit_extra={"gh_kind": kind, "gh_number": number},
    )
    tid = result["task_id"]
    assignee_id = str(assignee_agent_id) if assignee_agent_id else None

    # Fresh start only (never on an existing=True hit, which returns above before this
    # point) — the round-trip "Orcha started this" comment. Best-effort; see
    # _post_start_comment's docstring for the non-fatal contract.
    _post_start_comment(cur, container_id, kind, number, tid, assignee_id)
    return {"task_id": tid, "existing": False}


def find_orchestrator_agent(cur, container_id):
    """The container's orchestrator agent, or None if it doesn't have one.

    "Orchestrator" has no first-class flag anywhere in the schema (`agents.role` is
    free text) — the only existing signal is the persona/role string itself, matched
    the same way the frontend's `ORCHESTRATOR_ROLE_RE` heuristic already does
    (static/pages/github-state.js) for its own display purposes. This is the backend
    mirror of that convention: a live (`terminated_at IS NULL`), AI (`kind='ai'`)
    agent in the container whose `role` contains "orchestrat" (case-insensitive),
    matching e.g. "orchestrator / system architect", "orchestrator & architect".
    Deterministic tie-break when more than one matches: oldest first
    (`created_at ASC`, then `id ASC` for equal timestamps) — the container's
    original/primary orchestrator, not whichever was created most recently.

    Returns the agent id (str) or None. None is a normal, expected outcome (a
    container with no orchestrator persona at all) — callers must treat it as a
    graceful no-op, never an error.
    """
    cur.execute(
        """SELECT id FROM agents
            WHERE container_id=%s AND kind='ai' AND terminated_at IS NULL
              AND role ILIKE %s
            ORDER BY created_at ASC, id ASC
            LIMIT 1""",
        (container_id, "%orchestrat%"),
    )
    row = cur.fetchone()
    return str(row["id"]) if row else None


def _finish_task_insert(cur, container_id, *, title: str, description: str,
                        definition_of_done: str, created_by_agent_id,
                        assignee_agent_id, source: str, audit_extra: dict) -> dict:
    """Shared INSERT/assign/wake/audit tail for both start_task_from_github and
    start_task_from_slack_capture — the two functions differ only in HOW they build
    `title`/`description`/`definition_of_done` and whether an idempotency probe runs
    first; once those fields are decided, task creation itself must be identical
    (same INSERT columns/defaults, same agent_tasks 'working' row + no-bump +
    recompute_agent_status + targeted task_assigned, same audit event) so a task
    born from ANY external trigger is indistinguishable downstream from one born via
    task_creation_routes.create_task. `audit_extra` carries the caller-specific
    fields (gh_kind/gh_number for a GitHub-triggered start; nothing extra for a
    Slack capture) merged into the 'created' event's payload.

    Mirror create_task: an explicitly-assigned task starts 'in_progress' with
    started_at stamped; an unassigned one lands 'ready' (Atlas routes it). No deps
    and no protocol on an externally-triggered task, so the branchy create_task
    logic collapses to exactly these two cases. On assignment: a 'working'
    agent_tasks row, NO bump_agent (that would shrink idle_seconds and suppress the
    wake), recompute_agent_status off the row, then a targeted task_assigned so the
    wake machinery fires.

    Automatic triage (unassigned case): a task that lands 'ready' with nobody
    assigned previously sat inert until something happened to poke it — nothing woke
    the orchestrator to route it. Mirroring the assigned branch's task_assigned wake
    exactly (same publish_event call shape, same container/payload conventions),
    an unassigned task now emits a "task_created_unassigned" event targeted at the
    container's orchestrator agent (see find_orchestrator_agent), so the existing
    notifier wake-scan machinery wakes it on its next tick and it routes the task per
    its persona. If the container has no orchestrator agent, this is a silent,
    log-safe no-op — no event, no error — since routing without an orchestrator to
    route is simply not this container's setup.

    The caller owns the commit. Never commits or opens its own connection.
    """
    assignee_id = str(assignee_agent_id) if assignee_agent_id else None
    initial_status = "in_progress" if assignee_id else "ready"
    started_clause = "now()" if assignee_id else "NULL"

    cur.execute(
        f"""INSERT INTO tasks
              (container_id, title, description, definition_of_done,
               status, priority, created_by_agent_id, started_at)
            VALUES (%s, %s, %s, %s, %s, %s, %s, {started_clause})
            RETURNING id""",
        (
            container_id,
            title,
            description,
            definition_of_done,
            initial_status,
            100,
            created_by_agent_id,
        ),
    )
    tid = str(cur.fetchone()["id"])

    if assignee_id:
        cur.execute(
            """INSERT INTO agent_tasks (agent_id, task_id, assignment_status)
               VALUES (%s, %s, 'working')""",
            (assignee_id, tid),
        )
        recompute_agent_status(cur, assignee_id)
        publish_event(
            cur,
            str(container_id),
            assignee_id,
            "task_assigned",
            {"task_id": tid, "title": title, "via": f"{source} start"},
        )
    else:
        orchestrator_id = find_orchestrator_agent(cur, container_id)
        if orchestrator_id:
            publish_event(
                cur,
                str(container_id),
                orchestrator_id,
                "task_created_unassigned",
                {"task_id": tid, "title": title, "via": f"{source} start"},
            )
        # else: no orchestrator agent in this container — log-safe no-op, no event,
        # no error. The task still lands 'ready'; it simply has nothing to wake.

    actor_type = "ai" if created_by_agent_id else "human"
    log_event(
        cur,
        str(container_id),
        actor_type,
        created_by_agent_id,
        "task",
        tid,
        "created",
        {
            "title": title,
            "status": initial_status,
            "source": source,
            "assignee_agent_id": assignee_id,
            **audit_extra,
        },
    )
    return {"task_id": tid, "existing": False}


def build_slack_captured_dod() -> str:
    """The definition_of_done for a task captured directly from a raw Slack report
    (the "Create Orcha task" shortcut's task-first flow — see slack_routes.py's
    `_run_task_first_pipeline`). Distinct from `_ISSUE_DOD`/`_PULL_DOD`, which
    both assume a GitHub issue/PR already exists at task-creation time: a
    slack-captured task has NO GitHub issue yet, so its first instruction is to
    create one (the agent does the refinement the portal used to do with an LLM
    call — see docs/slack-integration.md), post the link back to this task's own
    thread, THEN triage, THEN implement. Pure (no DB); tests assert the literal
    copy directly."""
    return _SLACK_CAPTURED_DOD


def start_task_from_slack_capture(cur, container_id, *, title: str, description: str,
                                  created_by_agent_id, assignee_agent_id=None,
                                  source: str = "slack_capture"):
    """Create an Orcha task directly from a raw Slack message (the "Create Orcha
    task" shortcut's task-first flow), with NO chained GitHub issue creation and NO
    idempotency probe (there is no GH number to key an idempotency check against —
    every invocation creates a fresh task; a double-click/retry at the Slack layer
    is out of scope here, unlike start_task_from_github's GH-number-keyed probe).

    `title`/`description` are used VERBATIM (raw is fine — the assigned agent's own
    DoD, see `build_slack_captured_dod`, instructs it to refine and file the real
    GitHub issue itself). Returns {"task_id": <str>, "existing": False} — always
    False, kept in the return shape only so callers can share code with
    start_task_from_github's {"task_id", "existing"} contract.

    The caller owns the commit. Never commits or opens its own connection.
    """
    return _finish_task_insert(
        cur, container_id,
        title=title,
        description=description,
        definition_of_done=build_slack_captured_dod(),
        created_by_agent_id=created_by_agent_id,
        assignee_agent_id=assignee_agent_id,
        source=source,
        audit_extra={},
    )
