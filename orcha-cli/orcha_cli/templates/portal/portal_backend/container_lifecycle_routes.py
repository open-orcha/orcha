"""Create, reset, and list the container(s) owned by an Orcha stack."""

import psycopg
from fastapi import HTTPException, Request

from portal_backend.agent_status import log_event
from portal_backend.application import app
from portal_backend.database import db_cursor
from portal_backend.guards import require_kind, valid_uuid
from portal_backend.identity_routes import (
    enforce_grant,
    has_grant,
    proxy_login,
    trusted_actor,
)
from portal_backend.schemas import (
    ContainerCreate,
    ContainerCreateResponse,
    ContainerReset,
)


@app.post(
    "/api/containers",
    response_model=ContainerCreateResponse,
    status_code=201,
)
def create_container(body: ContainerCreate, request: Request):
    """Create a container ("project") with its root task.

    Default (`additional` omitted/false) keeps the Orcha#28 `orcha init` contract:
    a stack holds AT MOST one container — 409 if one already exists in this DB
    (reset with `orcha down -v && orcha init`, which wipes the volume).

    Multi-project (mig 037): `additional: true` — the portal's "New project" flow —
    creates ANOTHER container in the same stack and seeds its founding human agent
    (mirroring what `orcha init` registers via POST .../agents): kind='human',
    role='operator', member_role='owner'. When the trusted proxy identity is present
    (ORCHA_TRUST_PROXY_USER=1 + X-Auth-Request-User) the creating GitHub user IS that
    human — alias + github_login preset to the login, so /api/me resolves them in the
    new project immediately, no binding-rule pass needed. NB: an additional container
    gets full portal CRUD but NO agent wakes until host-side glue binds a workspace
    (`orcha init` binding / fleet provisioner) — see containers.last_wake_scan_at.
    """
    with db_cursor() as (conn, cur):
        if not body.additional:
            cur.execute("SELECT id, name, status FROM containers LIMIT 1")
            existing = cur.fetchone()
            if existing:
                raise HTTPException(
                    409,
                    f"this stack already has a container ({existing['id']}, "
                    f"name='{existing['name']}', status='{existing['status']}'). "
                    f"Stack:db:container is 1:1:1 — to start a new container, "
                    f"run `orcha down -v && orcha init` to wipe the volume first. "
                    f"(The portal's New-project flow passes additional=true.)",
                )
        try:
            cur.execute(
                "INSERT INTO containers (name, description) VALUES (%s, %s) RETURNING id",
                (body.name, body.description),
            )
        except psycopg.errors.UniqueViolation:
            # containers_name_uq (mig 037): project names are unique per stack,
            # case-insensitively — same 409 convention as a duplicate agent alias.
            raise HTTPException(
                409, f"a project named '{body.name}' already exists in this stack"
            )
        cid = str(cur.fetchone()["id"])
        cur.execute(
            """INSERT INTO tasks
                 (container_id, title, description, definition_of_done,
                  status, priority, is_root)
               VALUES (%s, %s, %s, %s, 'ready', 0, true)
               RETURNING id""",
            (
                cid,
                body.name,
                body.description or body.name,
                "Container objective met: all child tasks completed and verified.",
            ),
        )
        root_id = str(cur.fetchone()["id"])
        cur.execute("UPDATE containers SET root_task_id=%s WHERE id=%s", (root_id, cid))
        human_agent_id = None
        if body.additional:
            # Seed the founding human OWNER (register_agent's first-human-is-owner
            # invariant, guaranteed here by construction: the container is brand new).
            # The init path deliberately does NOT seed — the CLI registers the human
            # itself (unix username) via POST .../agents right after this call.
            login = proxy_login(request)
            alias = login or "operator"
            cur.execute(
                """INSERT INTO agents
                     (container_id, alias, role, kind, github_login, member_role)
                   VALUES (%s, %s, 'operator', 'human', %s, 'owner')
                   RETURNING id""",
                (cid, alias, login),
            )
            human_agent_id = str(cur.fetchone()["id"])
        log_event(
            cur,
            cid,
            "human",
            None,
            "container",
            cid,
            "created",
            {"name": body.name, "root_task_id": root_id},
        )
        log_event(
            cur,
            cid,
            "human",
            None,
            "task",
            root_id,
            "created",
            {"title": body.name, "is_root": True},
        )
        if human_agent_id is not None:
            log_event(
                cur,
                cid,
                "human",
                None,
                "agent",
                human_agent_id,
                "created",
                {"alias": alias, "role": "operator", "kind": "human"},
            )
        conn.commit()
    return ContainerCreateResponse(
        container_id=cid,
        root_task_id=root_id,
        name=body.name,
        human_agent_id=human_agent_id,
    )


@app.post("/api/containers/{cid}/reset", status_code=200)
def reset_container(cid: str, body: ContainerReset, request: Request):
    """Wipe ALL data in this (1:1:1) container — agents, tasks, requests, decisions,
    conversations, worker runs, memory digests, events — and recreate a single empty
    root task. The `containers` row itself is KEPT (so `current_container_id` and the
    portal stay valid); only its contents are cleared.

    In-app counterpart to the CLI `orcha init --force --reset-data` (which instead drops
    the Postgres volume for a pristine initdb). DESTRUCTIVE, so doubly gated:
      * human actor (kind='human'), and
      * typed confirmation — `confirm` must equal the container's current name.
    Returns per-table deleted-row counts.

    NB: every container-scoped table must be listed below; a NEW such table added to the
    schema must be added here too, or reset will leave orphan rows — or, for a table whose
    agent/request FK has no ON DELETE CASCADE (device_tokens, code_threads), fail the
    whole reset with a ForeignKeyViolation. `tests/test_container_reset.py::_seed` seeds
    one row per table as the regression fixture.

    KEPT on purpose (project *configuration*, not data — like the github_repo binding,
    provider keys and model settings that reset has always preserved): the sealed
    per-project GitHub PAT (container_github_pat). Wiping it while keeping the repo
    binding would leave a half-configured project.
    """
    if not valid_uuid(cid):
        raise HTTPException(404, "container not found")
    with db_cursor() as (conn, cur):
        cur.execute("SELECT id, name FROM containers WHERE id=%s", (cid,))
        cont = cur.fetchone()
        if not cont:
            raise HTTPException(404, "container not found")
        # Per-project identity: a trusted proxy login IS the actor (403 non-member).
        # Access model: the destructive reset is owner-or-manage_autonomy (plus the
        # typed-confirmation gate below).
        enforce_grant(cur, request, cid, "manage_autonomy")
        body.actor_agent_id = trusted_actor(cur, request, cid, body.actor_agent_id)
        require_kind(cur, body.actor_agent_id, ("human",))
        if body.confirm != cont["name"]:
            raise HTTPException(
                400,
                "reset not confirmed: `confirm` must equal the container name "
                f"'{cont['name']}'.",
            )

        deleted: dict = {}

        def delete_rows(table, sql, params):
            cur.execute(sql, params)
            deleted[table] = cur.rowcount

        cur.execute("UPDATE containers SET root_task_id=NULL WHERE id=%s", (cid,))
        agents_of = "SELECT id FROM agents WHERE container_id=%s"
        tasks_of = "SELECT id FROM tasks WHERE container_id=%s"
        delete_rows(
            "worker_run_lines",
            f"DELETE FROM worker_run_lines WHERE run_id IN "
            f"(SELECT run_id FROM worker_runs WHERE agent_id IN ({agents_of}))",
            (cid,),
        )
        delete_rows(
            "conversation_turns",
            "DELETE FROM conversation_turns WHERE conversation_id IN "
            "(SELECT id FROM conversations WHERE container_id=%s)",
            (cid,),
        )
        delete_rows(
            "conversations", "DELETE FROM conversations WHERE container_id=%s", (cid,)
        )
        delete_rows(
            "worker_runs",
            f"DELETE FROM worker_runs WHERE agent_id IN ({agents_of})",
            (cid,),
        )
        delete_rows("decisions", "DELETE FROM decisions WHERE container_id=%s", (cid,))
        # Code Space threads (mig 045) reference requests AND agents without cascade:
        # they must go before `requests` and `agents` below.
        delete_rows(
            "code_thread_messages",
            "DELETE FROM code_thread_messages WHERE thread_id IN "
            "(SELECT id FROM code_threads WHERE container_id=%s)",
            (cid,),
        )
        delete_rows(
            "code_threads", "DELETE FROM code_threads WHERE container_id=%s", (cid,)
        )
        # Per-phone bearer tokens (mig 038) reference agents without cascade — every
        # paired device of a wiped human is revoked outright (its human no longer exists).
        delete_rows(
            "device_tokens", "DELETE FROM device_tokens WHERE container_id=%s", (cid,)
        )
        # Wake-loop circuit breaker state (mig 048) — cascades on agents, but listed so
        # the wipe is explicit and counted.
        delete_rows(
            "wake_backoff", "DELETE FROM wake_backoff WHERE container_id=%s", (cid,)
        )
        # Push outbox rows (mig 041) point at task/request ids that are about to vanish.
        delete_rows(
            "push_outbox", "DELETE FROM push_outbox WHERE container_id=%s", (cid,)
        )
        # The LLM roster analysis (mig 047) describes the agents being wiped.
        delete_rows(
            "roster_analysis", "DELETE FROM roster_analysis WHERE container_id=%s", (cid,)
        )
        delete_rows(
            "agent_memory_digests",
            "DELETE FROM agent_memory_digests WHERE container_id=%s",
            (cid,),
        )
        delete_rows("requests", "DELETE FROM requests WHERE container_id=%s", (cid,))
        delete_rows(
            "task_messages",
            f"DELETE FROM task_messages WHERE task_id IN ({tasks_of})",
            (cid,),
        )
        delete_rows(
            "task_dependencies",
            f"DELETE FROM task_dependencies WHERE task_id IN ({tasks_of})",
            (cid,),
        )
        delete_rows(
            "agent_tasks",
            f"DELETE FROM agent_tasks WHERE task_id IN ({tasks_of})",
            (cid,),
        )
        delete_rows(
            "agent_reachability",
            f"DELETE FROM agent_reachability WHERE agent_id IN ({agents_of})",
            (cid,),
        )
        delete_rows(
            "agent_wake_state",
            f"DELETE FROM agent_wake_state WHERE agent_id IN ({agents_of})",
            (cid,),
        )
        delete_rows(
            "agent_events",
            f"DELETE FROM agent_events WHERE container_id=%s OR target_id IN ({agents_of})",
            (cid, cid),
        )
        delete_rows("events", "DELETE FROM events WHERE container_id=%s", (cid,))
        delete_rows("tasks", "DELETE FROM tasks WHERE container_id=%s", (cid,))
        delete_rows("agents", "DELETE FROM agents WHERE container_id=%s", (cid,))
        cur.execute(
            """INSERT INTO tasks
                 (container_id, title, description, definition_of_done,
                  status, priority, is_root)
               VALUES (%s, %s, %s, %s, 'ready', 0, true)
               RETURNING id""",
            (
                cid,
                cont["name"],
                cont["name"],
                "Container objective met: all child tasks completed and verified.",
            ),
        )
        root_id = str(cur.fetchone()["id"])
        cur.execute("UPDATE containers SET root_task_id=%s WHERE id=%s", (root_id, cid))
        log_event(
            cur,
            cid,
            "human",
            body.actor_agent_id,
            "container",
            cid,
            "reset",
            {"deleted": deleted, "new_root_task_id": root_id},
        )
        conn.commit()
    return {"container_id": cid, "root_task_id": root_id, "deleted": deleted}


@app.get("/api/containers")
def list_containers(request: Request):
    """List this stack's projects (containers) — the switcher AND the /projects
    landing page read this.

    PROJECT ISOLATION (access model): under the trusted proxy lane the list is
    FILTERED to containers where the signed-in GitHub login is a live human member —
    a member of nothing sees nothing. Containers still in the UNMAPPED bootstrap
    state (no live human carries a github_login) stay visible to every trusted user:
    a fresh stack must show its founder the world, or the binding rule could never
    run. Trust off / no header (self-host, CLI, daemon) lists everything, unchanged.

    Zero rows = empty stack (run `orcha init`); since mig 037 the portal can add
    MORE projects (POST /api/containers, additional=true), so several rows are
    possible. Ordered FOUNDING-FIRST (created_at ASC): CLI consumers (`orcha
    connect`/`orcha status`) take [0], and the founding container is the one a
    host workspace + notifier daemon are bound to. Per row, for the switcher and
    the landing-page cards:
      * agents            — live (non-terminated) agent count;
      * tasks             — non-root task count;
      * needs_you         — tasks at needs_verification + open human-facing
                            requests (target a human or escalated) — the card badge;
      * member_count      — live human members;
      * members           — the human roster ({alias, github_login, member_role}),
                            ONLY where the caller may see it (trust off, unmapped
                            bootstrap, or owner/manage_members in THAT container);
                            null otherwise — roster privacy holds here too;
      * last_wake_scan_at — the notifier's most recent wake-scan poll (stamped by
        GET .../wake-scan). Recent ⇒ a host-side daemon serves this project's
        wakes; NULL/stale ⇒ portal-only (CRUD works, nothing wakes).
    """
    login = proxy_login(request)
    with db_cursor() as (_, cur):
        member_filter = ""
        params: tuple = ()
        if login:
            member_filter = """
               WHERE EXISTS (SELECT 1 FROM agents m
                              WHERE m.container_id = containers.id
                                AND m.kind='human' AND m.terminated_at IS NULL
                                AND lower(m.github_login)=lower(%s))
                  OR NOT EXISTS (SELECT 1 FROM agents b
                                  WHERE b.container_id = containers.id
                                    AND b.kind='human' AND b.terminated_at IS NULL
                                    AND b.github_login IS NOT NULL)"""
            params = (login,)
        cur.execute(
            f"""SELECT id, name, description, status, root_task_id, github_repo,
                      created_at, completed_at, last_wake_scan_at,
                      (SELECT count(*) FROM agents a
                        WHERE a.container_id = containers.id
                          AND a.terminated_at IS NULL) AS agents,
                      (SELECT count(*) FROM tasks t
                        WHERE t.container_id = containers.id
                          AND NOT t.is_root) AS tasks,
                      (SELECT count(*) FROM tasks t
                        WHERE t.container_id = containers.id
                          AND t.status = 'needs_verification')
                      + (SELECT count(*) FROM requests r
                          WHERE r.container_id = containers.id
                            AND (r.status = 'escalated' OR (r.status = 'open'
                                 AND (r.target_id IS NULL OR EXISTS (
                                      SELECT 1 FROM agents h WHERE h.id = r.target_id
                                        AND h.kind='human'))))) AS needs_you,
                      (SELECT count(*) FROM agents h
                        WHERE h.container_id = containers.id
                          AND h.kind='human' AND h.terminated_at IS NULL)
                        AS member_count,
                      EXISTS (SELECT 1 FROM agents b2
                               WHERE b2.container_id = containers.id
                                 AND b2.kind='human' AND b2.terminated_at IS NULL
                                 AND b2.github_login IS NOT NULL) AS mapped
               FROM containers
               {member_filter}
               ORDER BY created_at ASC""",
            params,
        )
        rows = cur.fetchall()

        # Roster previews for the landing cards, privacy-gated per container.
        cur.execute(
            """SELECT container_id, id, alias, github_login, member_role, grants
               FROM agents
               WHERE kind='human' AND terminated_at IS NULL
               ORDER BY created_at ASC, id ASC""",
        )
        humans_by_cid: dict = {}
        for h in cur.fetchall():
            humans_by_cid.setdefault(str(h["container_id"]), []).append(h)

    def may_see_roster(row) -> bool:
        if not login:
            return True  # trust off / no header: pre-collab behavior
        if not row["mapped"]:
            return True  # bootstrap container: nothing to hide yet
        me = next(
            (h for h in humans_by_cid.get(str(row["id"]), [])
             if (h["github_login"] or "").lower() == login.lower()),
            None,
        )
        return has_grant(me, "manage_members")

    out = []
    for row in rows:
        entry = dict(row)
        del entry["mapped"]
        entry["members"] = (
            [
                {
                    "alias": h["alias"],
                    "github_login": h["github_login"],
                    "member_role": h["member_role"],
                }
                for h in humans_by_cid.get(str(row["id"]), [])
            ]
            if may_see_roster(row)
            else None
        )
        out.append(entry)
    return {"containers": out}
