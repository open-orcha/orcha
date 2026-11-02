"""Drive real notifier/API/database delivery with isolated Git repositories.

Provider replies are injected into the output files read by the real notifier;
local child processes exercise liveness only. No real provider, live portal,
agent account, database or worktree is used.
"""
from __future__ import annotations

import asyncio
import json
from pathlib import Path
import subprocess
import time
from contextlib import nullcontext

import pytest

from orcha_cli import notifier, notifier_startup_preflight as preflight
from orcha_cli import worktree_cleanup as cleanup, worktree_git as query
from orcha_cli import worktree_lifecycle as lifecycle
from test_pr396_git_compatibility import git, repository  # noqa: F401


def inactive(rows):
    return {"complete": True, "busy": [], "contexts": {}}


@pytest.mark.parametrize("scenario", ["cold", "resume", "git_failure", "held_lock", "preview_failure",
                                      "cancelled_preview", "cleanup_success", "interrupted_cleanup"])
async def test_two_agents_reply_once_and_recover_visible_startup_errors(
    client, container, make_agent, db, monkeypatch, repository, scenario
):
    human = await make_agent("Fixture owner", "human", kind="human")
    actors = {}
    for runtime in ("codex", "claude"):
        actor = await make_agent("Fixture " + runtime)
        aid = actor["agent_id"]
        response = await client.post(f"/api/agents/{aid}/conversations",
                                     json={"actor_agent_id": human["agent_id"]})
        assert response.status_code < 300, response.text
        conv_id = response.json()["conversation"]["id"]
        response = await client.post(f"/api/conversations/{conv_id}/turns", json={
            "role": "human", "author_agent_id": human["agent_id"], "content": "Please reply once."})
        assert response.status_code == 201, response.text
        actors[aid] = {"runtime": runtime, "conversation_id": conv_id}
    loop = asyncio.get_running_loop()
    calls, processes, spawn_options = [], [], []

    def call(method, url, body=None):
        path = "/" + url.split("://", 1)[1].split("/", 1)[1]
        coro = client.post(path, json=body) if method == "POST" else client.get(path)
        response = asyncio.run_coroutine_threadsafe(coro, loop).result(timeout=30)
        calls.append((method, path.split("?")[0], response.status_code, body))
        if response.status_code >= 400:
            return None
        data = response.json()
        if path.endswith("active-conversations"):
            for candidate in data.get("conversations", []):
                candidate["model_runtime"] = actors[candidate["agent_id"]]["runtime"]
                if scenario == "resume":
                    candidate.update(session_id="fixture-session", cold_required=False)
        return data

    def spawn(cwd, *args, **kwargs):
        # The only real command is a local, supervised child; no provider or network.
        proc = subprocess.Popen(["sleep", "120"], stdin=subprocess.PIPE)
        processes.append(proc)
        spawn_options.append(kwargs)
        return True, "fixture-provider", proc

    monkeypatch.setattr(notifier, "_get_json", lambda url, **kw: call("GET", url))
    monkeypatch.setattr(notifier, "_post_json", lambda url, body, **kw: call("POST", url, body))
    monkeypatch.setattr(notifier, "_build_persona", lambda *a, **kw: "Fixture persona")
    monkeypatch.setattr(notifier, "spawn_headless", spawn)
    monkeypatch.setattr(notifier, "spawn_resident", spawn)
    live = {}
    first = next(iter(actors.values()))["conversation_id"]
    first_checkout = repository / ".orcha-worktrees" / ("resident-" + notifier._safe_ref(first))
    plan = None
    real_preserve = cleanup._preserve

    async def tick():
        await asyncio.to_thread(notifier.service_residents, "http://fixture", container["id"], live,
                                quiet=True, base_cwd=str(repository))

    async def conversation(aid):
        response = await client.get(f"/api/agents/{aid}/conversation?limit=200")
        assert response.status_code == 200
        return response.json()

    def retry_now():
        for actor in actors.values():
            entry = preflight._BACKOFF.get(actor["conversation_id"])
            if entry:
                entry["next_attempt"] = 0

    try:
        # Preview/cancel/success use the real cleanup controller in the fixture.
        if scenario in {"preview_failure", "cancelled_preview", "cleanup_success"}:
            unused = repository.parent / "inactive"
            git(repository, "worktree", "add", "-q", "--detach", str(unused))
            plan = cleanup.preview(repository, (lambda rows: None) if scenario == "preview_failure" else inactive)
            assert plan["status"] == ("failed" if scenario == "preview_failure" else "ready")
            if scenario == "cleanup_success":
                done = cleanup.execute(repository, plan["plan_id"], inactive)
                assert done["status"] == "done" and len(done["removed"]) == 1
                assert not unused.exists()
            else:
                assert unused.exists()  # cancel means no confirmation, so no removal

        if scenario == "interrupted_cleanup":
            git(repository, "worktree", "add", "-qb", "resident-kept", str(first_checkout))
            plan = cleanup.preview(repository, inactive)
            assert plan["candidate_count"] == 1

            def interrupted(*args):
                raise KeyboardInterrupt("fixture controller interrupted")

            monkeypatch.setattr(cleanup, "_preserve", interrupted)
            with pytest.raises(KeyboardInterrupt):
                cleanup.execute(repository, plan["plan_id"], inactive)
            monkeypatch.setattr(cleanup, "_preserve", real_preserve)

        real_git = query.gc.git
        if scenario == "git_failure":
            # Reproduce the exact successful-option-echo failure, not a generic exception.
            monkeypatch.setattr(query.gc, "git", lambda args, cwd, **kw: (0, "--path-format=absolute\n.git\n")
                                if args == ["rev-parse", "--git-common-dir"] else real_git(args, cwd, **kw))
        guard = lifecycle.locked(repository) if scenario == "held_lock" else nullcontext()
        with guard:
            before = time.monotonic()
            await tick()
            assert time.monotonic() - before < 15, "one blocked checkout must not hang the notifier"

        failed = scenario in {"git_failure", "held_lock", "interrupted_cleanup"}
        if failed:
            blocked = 0
            for aid, actor in actors.items():
                state = await conversation(aid)
                if scenario == "interrupted_cleanup" and actor["conversation_id"] != first:
                    assert actor["conversation_id"] in live, "unrelated agent still starts"
                    continue
                blocked += 1
                notice = state["startup_blocked"]
                assert notice and not notice["setup_available"]
                assert notice["blocker"] in {"checkout_busy", "checkout_startup_failed"}
                assert [turn["role"] for turn in state["turns"]] == ["human"]
                lease = db.execute("SELECT conv_lease_until FROM agent_wake_state WHERE agent_id=%s", (aid,))
                assert not lease or lease[0]["conv_lease_until"] is None
            assert blocked
            attempts = len([call for call in calls if call[1].endswith("wake-claim")])
            await tick()
            assert len([call for call in calls if call[1].endswith("wake-claim")]) == attempts
            monkeypatch.setattr(query.gc, "git", real_git)
            if scenario == "interrupted_cleanup":
                assert cleanup.execute(repository, plan["plan_id"], inactive)["status"] == "done"
            # Model daemon restart: process-local startup backoff is empty, durable
            # cleanup claims and API pending messages remain authoritative.
            preflight._BACKOFF.clear()
            await tick()

        assert len(processes) == 2 and len(live) == 2
        if scenario == "resume":
            assert all(options.get("resume_session_id") == "fixture-session" for options in spawn_options)
        for aid, actor in actors.items():
            assert (await conversation(aid))["startup_blocked"] is None
            resident = live[actor["conversation_id"]]
            assert resident.get("current_run_id")
            if actor["runtime"] == "codex":
                path = Path(resident["last_message_path"])
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text("Fixture reply from codex")
                resident["proc"].terminate()
                resident["proc"].wait(timeout=10)
            else:
                path = Path(resident["log_path"])
                path.parent.mkdir(parents=True, exist_ok=True)
                with path.open("a") as stream:
                    stream.write(json.dumps({"type": "result", "subtype": "success", "num_turns": 1,
                                             "result": "Fixture reply from claude", "session_id": "fixture-session"}) + "\n")
        await tick()
        for proc in processes:
            if proc.poll() is None:
                proc.terminate()
                proc.wait(timeout=10)
        for _ in range(3):
            retry_now()
            await tick()
        assert len(processes) == 2 and not live
        for aid in actors:
            state = await conversation(aid)
            assert [turn["role"] for turn in state["turns"]] == ["human", "agent"]
            assert state["startup_blocked"] is None
            runs = db.execute("SELECT status FROM worker_runs WHERE agent_id=%s", (aid,))
            assert runs and all(row["status"] != "running" for row in runs)
            assert db.execute("SELECT conv_lease_until FROM agent_wake_state WHERE agent_id=%s", (aid,))[0]["conv_lease_until"] is None
        replies = [c for c in calls if c[0] == "POST" and c[1].endswith("/turns")]
        assert len(replies) == 2 and all(c[2] == 201 for c in replies)
    finally:
        for proc in processes:
            if proc.poll() is None:
                proc.kill()
                proc.wait(timeout=10)
        for actor in actors.values():
            preflight.record_success(actor["conversation_id"])
