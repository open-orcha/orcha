"""The Verdikt auto-fix loop (mig 068, portal_backend/verdikt_autofix.py).

Send to Verdikt → FAIL → back to the agent (as system:verdikt) → the agent reworks → Verdikt →
… until PASS, the attempt cap, no progress, a non-fail outcome, a person stepping in, or Stop
auto-fix. Real HTTP to the scripted fake Verdikt; the agent is a stub that records a new run
and calls /done again. Covers: the full loop to a pass (the task is NEVER completed), the cap,
no progress (no diff · the same diff · the same failure twice), non-fail outcomes, a person's
reject / cancel / Stop, idempotency (the same finished run judged twice → one rework), the
per-task override, settings + permissions + /openapi.json, the background sweep endpoint and
the notifier's sweep cadence."""
import json
import threading

import pytest

from fake_verdikt import FakeVerdikt, scripted
from test_evidence_verdikt import DIFF, OCTO, HUBOT, VERA, _members, _run, _wait
from conftest import ts_ago, ts_from_now

DOD = """- All tests pass
- The login page shows "Wrong password" after a bad password
- The error text is red
"""
C1 = 'The login page shows "Wrong password" after a bad password'
C2 = "The error text is red"


def _fail(actual, *, c1="pass"):
    return scripted("fail", [
        {"text": C1, "outcome": c1, "expected": "the message", "actual": "no message" if c1 == "fail" else None},
        {"text": C2, "outcome": "fail", "expected": "red text", "actual": actual, "evidence_seq": 1},
    ], reason="error colour", evidence=[("error text colour", "major")])


PASS = scripted("pass", [{"text": C1, "outcome": "pass"}, {"text": C2, "outcome": "pass"}], reason="all good")


def _diff(n):
    out = DIFF.replace("Wrong password</p>;", f"Wrong password</p>; // rework {n}")
    assert out != DIFF
    return out


@pytest.fixture
def fake():
    f = FakeVerdikt()
    f.base = f.start()
    f.add_project("shop-web", "Shop web")
    yield f
    f.stop()


class Loop:
    """One task in a project with Verdikt (trigger 'always') + auto-fix on, worked by a stub agent."""

    def __init__(self, client, db, cid, hid, wid, headers, tid):
        self.client, self.db, self.cid, self.hid, self.wid, self.headers, self.tid = \
            client, db, cid, hid, wid, headers, tid
        self.reworks = 0

    def runs(self):
        return self.db.execute("SELECT * FROM verdikt_runs WHERE task_id=%s ORDER BY created_at", (self.tid,))

    def status(self):
        return self.db.execute("SELECT status FROM tasks WHERE id=%s", (self.tid,))[0]["status"]

    def _handed_off(self, n):
        # The auto-trigger thread commits the run row first and stamps verdikt_request_id after
        # the send, so wait for the handoff too, not just the row (a sweep in between sees an
        # unsent run and judges nothing).
        rows = self.runs()
        return len(rows) >= n and all(r["verdikt_request_id"] or r["status"] != "queued" for r in rows)

    async def wait_runs(self, n):
        assert _wait(lambda: self._handed_off(n), timeout=8), f"expected {n} Verdikt runs, got {len(self.runs())}"

    async def sweep(self):
        r = await self.client.post(f"/api/containers/{self.cid}/verdikt/sweep", json={})
        assert r.status_code == 200, r.text
        return r.json()

    async def state(self):
        r = await self.client.get(f"/api/tasks/{self.tid}/verdikt/autofix")
        assert r.status_code == 200, r.text
        return r.json()

    async def rework(self, diff=None, *, run=True):
        """The stub agent: records a new work run (its diff) and marks the task done again."""
        self.reworks += 1
        if run:
            _run(self.db, self.wid, self.tid, output="fixed it", diff=diff if diff is not None else _diff(self.reworks),
                 started=ts_from_now(1))
        r = await self.client.post(f"/api/tasks/{self.tid}/done",
                                   json={"agent_id": self.wid, "result": f"rework {self.reworks}"},
                                   headers=self.headers)
        assert r.status_code == 200, r.text


async def _setup(client, container, make_agent, make_task, work_headers, db, fake, *, autofix=True,
                 max_attempts=3, trigger="always", first=None):
    cid = container["id"]
    hid = (await make_agent("root", "operator", kind="human"))["agent_id"]
    body = {"actor_agent_id": hid, "enabled": True, "base_url": fake.base, "verdikt_project": "shop-web",
            "target_kind": "web", "target_locator": "http://127.0.0.1:5173/login", "trigger_mode": trigger,
            "autofix_enabled": autofix, "autofix_max_attempts": max_attempts}
    r = await client.put(f"/api/containers/{cid}/verdikt", json=body)
    assert r.status_code == 200, r.text
    worker = await make_agent("Pixel", "frontend")
    wid = worker["agent_id"]
    task = await make_task("Show login error", DOD, assignee_alias="Pixel", description="Bad passwords must say so.")
    tid = task["id"]
    headers = await work_headers(wid)
    if first is not None:
        fake.script(first)
    lp = Loop(client, db, cid, hid, wid, headers, tid)
    _run(db, wid, tid, output="built it", diff=DIFF)
    r = await client.post(f"/api/tasks/{tid}/done", json={"agent_id": wid, "result": "Wired the login error."},
                          headers=headers)
    assert r.status_code == 200, r.text
    return lp


def _events(db, tid, kind):
    return db.execute("SELECT * FROM events WHERE entity_id=%s AND event_type=%s ORDER BY id", (tid, kind))


# ------------------------------------------------------------------ the loop to a pass

async def test_full_loop_fail_fail_pass(client, container, make_agent, make_task, work_headers, db, fake):
    fake.script(_fail("the error text is black"), _fail("the error text is dark red"), PASS)
    lp = await _setup(client, container, make_agent, make_task, work_headers, db, fake)
    await lp.wait_runs(1)
    assert lp.runs()[0]["autofix"] is True and lp.runs()[0]["trigger"] == "auto"
    s = await lp.sweep()  # the background check: nobody is looking at the task
    assert s["judged"] == 1
    # attempt 1 failed → back to the agent, as the system identity
    assert lp.status() == "in_progress"
    ev = _events(db, lp.tid, "verdikt_auto_rework")
    assert len(ev) == 1 and ev[0]["actor_type"] == "system" and ev[0]["actor_id"] is None
    assert ev[0]["detail"]["actor"] == "system:verdikt" and ev[0]["detail"]["attempt"] == 1
    assert ev[0]["detail"]["failed"] == [{"text": C2, "expected": "red text", "actual": "the error text is black"}]
    # the agent's rework directive: the bus event that wakes it + the task thread
    bus = db.execute("SELECT payload FROM agent_events WHERE target_id=%s AND event_name='task_verified'", (lp.wid,))
    assert len(bus) == 1
    p = bus[0]["payload"]
    assert p["approved"] is False and p["by"] == "system:verdikt" and p["verdikt_auto_rework"] is True
    fb = p["feedback"]
    assert fb.startswith("Verdikt failed this task on attempt 1 of 3.")
    assert "Failed criteria:\n1. The error text is red\n   Expected: red text\n   Actual: the error text is black" in fb
    vr = lp.runs()[0]
    assert f"Screenshot: /api/tasks/{lp.tid}/verdikt/runs/{vr['id']}/artifact?path=" in fb
    assert f"Report: /api/tasks/{lp.tid}/verdikt/runs/{vr['id']}/report" in fb
    assert "Tested: web:http://127.0.0.1:5173/login" in fb and "Passed: 1 of 2 criteria." in fb
    assert fb.index("Failed criteria") < fb.index("Report:")  # failures first
    msgs = db.execute("SELECT author_id, body FROM task_messages WHERE task_id=%s ORDER BY created_at", (lp.tid,))
    assert msgs[-1]["author_id"] is None and msgs[-1]["body"].startswith("[Verdikt auto-fix] Verdikt failed")
    st = await lp.state()
    assert st["loop"]["status"] == "running" and st["loop"]["current_attempt"] == 2
    assert [a["action"] for a in st["loop"]["attempts"]] == ["reworked"]
    # rework 1 → attempt 2 fails differently → back again
    await lp.rework()
    await lp.wait_runs(2)
    assert lp.runs()[1]["autofix"] is True
    await lp.sweep()
    assert lp.status() == "in_progress"
    assert len(_events(db, lp.tid, "verdikt_auto_rework")) == 2
    # rework 2 → attempt 3 passes: the loop stops; the task waits for a person
    await lp.rework()
    await lp.wait_runs(3)
    await lp.sweep()
    assert lp.status() == "needs_verification"
    st = await lp.state()
    loop = st["loop"]
    assert loop["status"] == "stopped" and loop["stop_kind"] == "pass"
    assert loop["stop_reason"] == "Verdikt passed on attempt 3 of 3 — ready for your review"
    assert [(a["attempt"], a["outcome"], a["action"]) for a in loop["attempts"]] == \
        [(1, "fail", "reworked"), (2, "fail", "reworked"), (3, "pass", "passed")]
    assert all(a["changes"]["href"] and a["report_url"] for a in loop["attempts"])
    # the human is told
    humans = db.execute("SELECT payload FROM agent_events WHERE target_id=%s AND event_name='verdikt_autofix_stopped'",
                        (lp.hid,))
    assert len(humans) == 1 and humans[0]["payload"]["message"].startswith("Verdikt passed on attempt 3")
    # never self-certify: nothing completed or verified it
    assert db.execute("SELECT count(*) AS n FROM events WHERE entity_id=%s AND event_type='verified'",
                      (lp.tid,))[0]["n"] == 0
    # the evidence + Needs-you summary carry the loop's outcome
    ev = (await client.get(f"/api/tasks/{lp.tid}/evidence")).json()
    assert ev["autofix"]["stop_kind"] == "pass" and ev["summary"]["autofix"]["attempts_made"] == 3
    sums = (await client.get(f"/api/containers/{lp.cid}/evidence-summaries")).json()["summaries"]
    assert sums[lp.tid]["autofix"]["stop_reason"].startswith("Verdikt passed")
    # each rework began a new verification round (the evidence counts only the rework's runs)
    assert ev["round_started_at"]
    # more sweeps change nothing
    await lp.sweep()
    assert len(_events(db, lp.tid, "verdikt_auto_rework")) == 2 and lp.status() == "needs_verification"


async def test_attempt_cap(client, container, make_agent, make_task, work_headers, db, fake):
    fake.script(_fail("black"), _fail("grey"), _fail("blue"))
    lp = await _setup(client, container, make_agent, make_task, work_headers, db, fake)
    await lp.wait_runs(1)
    await lp.sweep()
    await lp.rework()
    await lp.wait_runs(2)
    await lp.sweep()
    await lp.rework()
    await lp.wait_runs(3)
    await lp.sweep()
    assert lp.status() == "needs_verification"
    loop = (await lp.state())["loop"]
    assert loop["stop_kind"] == "attempt_limit" and loop["stop_label"] == "Attempt limit reached"
    assert loop["stop_reason"].startswith("Verdikt failed 3 of 3 attempts")
    assert [a["action"] for a in loop["attempts"]] == ["reworked", "reworked", "stopped"]
    assert len(_events(db, lp.tid, "verdikt_auto_rework")) == 2


async def test_max_attempts_one_never_sends_back(client, container, make_agent, make_task, work_headers, db, fake):
    lp = await _setup(client, container, make_agent, make_task, work_headers, db, fake, max_attempts=1,
                      first=_fail("black"))
    await lp.wait_runs(1)
    await lp.sweep()
    assert lp.status() == "needs_verification"
    assert (await lp.state())["loop"]["stop_kind"] == "attempt_limit"


# ------------------------------------------------------------------ no progress

async def test_no_progress_rework_without_any_change(client, container, make_agent, make_task, work_headers, db, fake):
    lp = await _setup(client, container, make_agent, make_task, work_headers, db, fake, first=_fail("black"))
    await lp.wait_runs(1)
    await lp.sweep()
    assert lp.status() == "in_progress"
    await lp.rework(run=False)  # marked done again without a single work run
    assert _wait(lambda: lp.db.execute("SELECT status FROM verdikt_autofix_loops WHERE task_id=%s",
                                       (lp.tid,))[0]["status"] == "stopped")
    loop = (await lp.state())["loop"]
    assert loop["stop_kind"] == "no_diff" and "without changing any code" in loop["stop_reason"]
    assert lp.status() == "needs_verification"


async def test_no_progress_same_diff(client, container, make_agent, make_task, work_headers, db, fake):
    fake.script(_fail("black"), _fail("grey"))
    lp = await _setup(client, container, make_agent, make_task, work_headers, db, fake)
    await lp.wait_runs(1)
    await lp.sweep()
    await lp.rework(diff=DIFF)  # the very same changes as attempt 1
    await lp.wait_runs(2)
    await lp.sweep()
    loop = (await lp.state())["loop"]
    assert loop["stop_kind"] == "no_diff" and "exactly the same code changes" in loop["stop_reason"]
    assert lp.status() == "needs_verification"
    assert len(_events(db, lp.tid, "verdikt_auto_rework")) == 1


async def test_no_progress_same_failure_twice(client, container, make_agent, make_task, work_headers, db, fake):
    fake.script(_fail("the error text is black"), _fail("The error text is  BLACK"))
    lp = await _setup(client, container, make_agent, make_task, work_headers, db, fake)
    await lp.wait_runs(1)
    await lp.sweep()
    await lp.rework()
    await lp.wait_runs(2)
    await lp.sweep()
    loop = (await lp.state())["loop"]
    assert loop["stop_kind"] == "same_failure"
    assert loop["stop_reason"].startswith("No progress: the same 1 criterion failed with the same result on attempts 1 and 2")
    assert lp.status() == "needs_verification"


# ------------------------------------------------------------------ non-fail outcomes

@pytest.mark.parametrize("second,kind_text", [
    (scripted("blocked", [{"text": C2, "outcome": "blocked"}], reason="login wall"), "was blocked"),
    (scripted("warning", [{"text": C2, "outcome": "warning"}]), "only raised warnings"),
    (scripted(error="the worker crashed"), "failed to run"),
    (scripted(cancel=True), "was cancelled"),
])
async def test_non_fail_outcome_stops(client, container, make_agent, make_task, work_headers, db, fake,
                                      second, kind_text):
    fake.script(_fail("black"), second)
    lp = await _setup(client, container, make_agent, make_task, work_headers, db, fake)
    await lp.wait_runs(1)
    await lp.sweep()
    await lp.rework()
    await lp.wait_runs(2)
    await lp.sweep()
    loop = (await lp.state())["loop"]
    assert loop["stop_kind"] == "non_fail" and kind_text in loop["stop_reason"]
    assert "isn't a test fail" in loop["stop_reason"]
    assert lp.status() == "needs_verification"
    assert len(_events(db, lp.tid, "verdikt_auto_rework")) == 1


async def test_unavailable_verdikt_stops(client, container, make_agent, make_task, work_headers, db, fake):
    lp = await _setup(client, container, make_agent, make_task, work_headers, db, fake, first=_fail("black"))
    await lp.wait_runs(1)
    await lp.sweep()
    fake.stop()  # Verdikt goes away while the agent reworks
    await lp.rework()
    await lp.wait_runs(2)
    assert _wait(lambda: lp.runs()[1]["status"] == "unavailable")
    await lp.sweep()
    loop = (await lp.state())["loop"]
    assert loop["stop_kind"] == "non_fail" and "Verdikt was unavailable" in loop["stop_reason"]


async def test_first_non_fail_never_starts_a_loop(client, container, make_agent, make_task, work_headers, db, fake):
    lp = await _setup(client, container, make_agent, make_task, work_headers, db, fake, first=PASS)
    await lp.wait_runs(1)
    await lp.sweep()
    assert (await lp.state())["loop"] is None and lp.status() == "needs_verification"


# ------------------------------------------------------------------ people end the loop

async def test_human_reject_ends_the_loop_and_a_late_fail_does_nothing(client, container, make_agent, make_task,
                                                                      work_headers, db, fake):
    lp = await _setup(client, container, make_agent, make_task, work_headers, db, fake, first=_fail("black"))
    await lp.wait_runs(1)
    await lp.sweep()
    await lp.rework()  # no scripted answer: attempt 2 stays queued in Verdikt
    await lp.wait_runs(2)
    r = await client.post(f"/api/tasks/{lp.tid}/verify",
                          json={"approve": False, "actor_agent_id": lp.hid, "feedback": "I'll take it from here"})
    assert r.status_code == 200, r.text
    loop = (await lp.state())["loop"]
    assert loop["stop_kind"] == "human" and loop["stop_reason"] == "root rejected the task — auto-fix ended"
    assert loop["stopped_by"] == lp.hid
    # Verdikt answers late with a fail: nothing is sent back by the loop
    req = fake.tables["run_requests"][-1]
    fake.complete(req["id"], "fail", [{"text": C2, "outcome": "fail", "actual": "x"}])
    await lp.sweep()
    assert len(_events(db, lp.tid, "verdikt_auto_rework")) == 1


async def test_cancel_and_reassign_end_the_loop(client, container, make_agent, make_task, work_headers, db, fake):
    lp = await _setup(client, container, make_agent, make_task, work_headers, db, fake, first=_fail("black"))
    await lp.wait_runs(1)
    await lp.sweep()
    other = await make_agent("Forge", "backend")
    r = await client.post(f"/api/tasks/{lp.tid}/assign",
                          json={"agent_id": other["agent_id"], "actor_agent_id": lp.hid, "reassign": True})
    assert r.status_code == 200, r.text
    loop = (await lp.state())["loop"]
    assert loop["stop_kind"] == "human" and "reassigned" in loop["stop_reason"]


async def test_stop_button(client, container, make_agent, make_task, work_headers, db, fake):
    lp = await _setup(client, container, make_agent, make_task, work_headers, db, fake, first=_fail("black"))
    await lp.wait_runs(1)
    await lp.sweep()
    ai = (await make_agent("Bot"))["agent_id"]
    assert (await client.post(f"/api/tasks/{lp.tid}/verdikt/autofix/stop", json={"actor_agent_id": ai})).status_code == 403
    r = await client.post(f"/api/tasks/{lp.tid}/verdikt/autofix/stop", json={"actor_agent_id": lp.hid})
    assert r.status_code == 200, r.text
    assert r.json()["loop"]["stop_kind"] == "stopped_by_human" and r.json()["loop"]["stop_reason"] == "root stopped auto-fix"
    assert (await client.post(f"/api/tasks/{lp.tid}/verdikt/autofix/stop",
                              json={"actor_agent_id": lp.hid})).status_code == 409
    # the agent finishes its rework: Verdikt still checks it, but no new loop starts
    fake.script(_fail("grey"))
    await lp.rework()
    await lp.wait_runs(2)
    await lp.sweep()
    assert lp.status() == "needs_verification"
    assert len(_events(db, lp.tid, "verdikt_auto_rework")) == 1
    # a person's reject begins a new review cycle: then a fail may start a fresh loop
    await client.post(f"/api/tasks/{lp.tid}/verify", json={"approve": False, "actor_agent_id": lp.hid, "feedback": "x"})
    fake.script(_fail("blue"))
    await lp.rework()
    await lp.wait_runs(3)
    await lp.sweep()
    assert lp.status() == "in_progress"
    loops = db.execute("SELECT status FROM verdikt_autofix_loops WHERE task_id=%s ORDER BY started_at", (lp.tid,))
    assert [l["status"] for l in loops] == ["stopped", "running"]


async def test_budget_and_paused_agent_stop(client, container, make_agent, make_task, work_headers, db, fake):
    lp = await _setup(client, container, make_agent, make_task, work_headers, db, fake, first=_fail("black"))
    await lp.wait_runs(1)
    db.execute("INSERT INTO agent_reachability (agent_id, wake_enabled) VALUES (%s, false) "
               "ON CONFLICT (agent_id) DO UPDATE SET wake_enabled=false", (lp.wid,))
    await lp.sweep()
    loop = (await lp.state())["loop"]
    assert loop["stop_kind"] == "agent_paused" and "Pixel is paused" in loop["stop_reason"]
    assert lp.status() == "needs_verification"


# ------------------------------------------------------------------ idempotency

async def test_same_run_judged_once(client, container, make_agent, make_task, work_headers, db, fake):
    from portal_backend import verdikt_autofix as vaf

    lp = await _setup(client, container, make_agent, make_task, work_headers, db, fake, first=_fail("black"))
    await lp.wait_runs(1)
    rid = str(lp.runs()[0]["id"])
    # the person's "Check now", the evidence read and the sweep all see the finished run at once
    r = await client.post(f"/api/tasks/{lp.tid}/verdikt/runs/{rid}/refresh")
    assert r.status_code == 200
    threads = [threading.Thread(target=vaf.process_task, args=(lp.tid,)) for _ in range(6)]
    [t.start() for t in threads]
    [t.join() for t in threads]
    await lp.sweep()
    await lp.sweep()
    await client.get(f"/api/tasks/{lp.tid}/evidence")
    # re-judging the run directly is refused too (autofix_done_at + the unique attempt key)
    db.execute("UPDATE verdikt_runs SET autofix_done_at=NULL WHERE id=%s", (rid,))
    vaf.process_task(lp.tid)
    assert len(_events(db, lp.tid, "verdikt_auto_rework")) == 1
    assert db.execute("SELECT count(*) AS n FROM verdikt_autofix_attempts WHERE task_id=%s", (lp.tid,))[0]["n"] == 1
    assert len(db.execute("SELECT 1 FROM agent_events WHERE target_id=%s AND event_name='task_verified'", (lp.wid,))) == 1


# ------------------------------------------------------------------ off / override / manual mode

async def test_off_by_default_and_override(client, container, make_agent, make_task, work_headers, db, fake):
    lp = await _setup(client, container, make_agent, make_task, work_headers, db, fake, autofix=False,
                      first=_fail("black"))
    await lp.wait_runs(1)
    assert lp.runs()[0]["autofix"] is False
    await lp.sweep()
    assert lp.status() == "needs_verification" and (await lp.state())["loop"] is None
    st = await lp.state()
    assert st["effective"] is False and st["why"] == "Auto-fix is off for this project" and st["override"] == "inherit"
    # per-task override on → the next automatic run drives the loop
    r = await client.put(f"/api/tasks/{lp.tid}/verdikt/autofix", json={"actor_agent_id": lp.hid, "mode": "on"})
    assert r.status_code == 200 and r.json()["effective"] is True and r.json()["override"] == "on"
    fake.script(_fail("grey"))
    r = await client.post(f"/api/tasks/{lp.tid}/verify", json={"approve": False, "actor_agent_id": lp.hid, "feedback": "x"})
    await lp.rework()
    await lp.wait_runs(2)
    assert lp.runs()[1]["autofix"] is True
    await lp.sweep()
    assert lp.status() == "in_progress" and (await lp.state())["loop"]["status"] == "running"
    # override off → the running loop ends as turned off
    r = await client.put(f"/api/tasks/{lp.tid}/verdikt/autofix", json={"actor_agent_id": lp.hid, "mode": "off"})
    assert r.json()["loop"]["stop_kind"] == "turned_off" and r.json()["why"] == "Auto-fix is off for this task"
    r = await client.put(f"/api/tasks/{lp.tid}/verdikt/autofix", json={"actor_agent_id": lp.hid, "mode": "inherit"})
    assert r.json()["override"] == "inherit"


async def test_manual_trigger_mode_disables_autofix(client, container, make_agent, make_task, work_headers, db, fake):
    lp = await _setup(client, container, make_agent, make_task, work_headers, db, fake, trigger="manual")
    st = await lp.state()
    assert st["effective"] is False and "run automatically" in st["why"] and st["project"]["applies"] is False
    s = (await client.get(f"/api/containers/{lp.cid}/verdikt")).json()
    assert s["autofix_enabled"] is True and s["autofix_applies"] is False
    # a manual run's fail never sends the task back
    fake.script(_fail("black"))
    r = await client.post(f"/api/tasks/{lp.tid}/verdikt/runs", json={"actor_agent_id": lp.hid})
    assert r.status_code == 201 and r.json()["autofix"] is False
    await lp.sweep()
    assert lp.status() == "needs_verification" and (await lp.state())["loop"] is None


async def test_ui_changes_mode_checks_every_rework(client, container, make_agent, make_task, work_headers, db, fake):
    """'ui_changes' alone would skip a rework that touched no UI file; a running loop checks it."""
    fake.script(_fail("black"), PASS)
    lp = await _setup(client, container, make_agent, make_task, work_headers, db, fake, trigger="ui_changes")
    await lp.wait_runs(1)
    await lp.sweep()
    await lp.rework(diff="diff --git a/api/x.py b/api/x.py\n--- a/api/x.py\n+++ b/api/x.py\n@@ -1 +1 @@\n-a\n+b\n")
    await lp.wait_runs(2)
    await lp.sweep()
    assert (await lp.state())["loop"]["stop_kind"] == "pass"


async def test_turning_the_project_setting_off_ends_running_loops(client, container, make_agent, make_task,
                                                                work_headers, db, fake):
    lp = await _setup(client, container, make_agent, make_task, work_headers, db, fake, first=_fail("black"))
    await lp.wait_runs(1)
    await lp.sweep()
    r = await client.put(f"/api/containers/{lp.cid}/verdikt", json={
        "actor_agent_id": lp.hid, "enabled": True, "base_url": fake.base, "verdikt_project": "shop-web",
        "target_locator": "http://127.0.0.1:5173/login", "trigger_mode": "manual"})
    assert r.status_code == 200 and r.json()["autofix_enabled"] is True  # omitted → kept
    loop = (await lp.state())["loop"]
    assert loop["stop_kind"] == "turned_off"


# ------------------------------------------------------------------ settings, permissions, openapi

@pytest.fixture
def trust_proxy(monkeypatch):
    monkeypatch.setenv("ORCHA_TRUST_PROXY_USER", "1")
    monkeypatch.setenv("ORCHA_PLAN", "team")


async def test_settings_validation_and_defaults(client, container, make_agent):
    cid = container["id"]
    hid = (await make_agent("root", "operator", kind="human"))["agent_id"]
    d = (await client.get(f"/api/containers/{cid}/verdikt")).json()
    assert d["autofix_enabled"] is False and d["autofix_max_attempts"] == 3 and d["autofix_applies"] is False
    put = lambda body: client.put(f"/api/containers/{cid}/verdikt", json={"actor_agent_id": hid, **body})
    assert (await put({"autofix_max_attempts": 0})).status_code == 422
    assert (await put({"autofix_max_attempts": 11})).status_code == 422
    s = (await put({"enabled": True, "base_url": "http://127.0.0.1:31100", "verdikt_project": "shop-web",
                    "trigger_mode": "always", "autofix_enabled": True, "autofix_max_attempts": 5})).json()
    assert s["autofix_enabled"] is True and s["autofix_max_attempts"] == 5 and s["autofix_applies"] is True
    # an older client that doesn't send the fields keeps them
    s = (await put({"enabled": True, "base_url": "http://127.0.0.1:31100", "verdikt_project": "shop-web",
                    "trigger_mode": "ui_changes"})).json()
    assert s["autofix_enabled"] is True and s["autofix_max_attempts"] == 5


async def test_permissions_under_proxy_identity(client, container, make_agent, make_task, trust_proxy, fake):
    cid = container["id"]
    hubot, _vera = await _members(client, cid, make_agent)
    task = await make_task("t", "The page works")
    tid = task["id"]
    body = {"enabled": True, "base_url": fake.base, "verdikt_project": "shop-web",
            "target_locator": "http://127.0.0.1:5173", "trigger_mode": "always", "autofix_enabled": True}
    # settings: owner or manage_repo
    assert (await client.put(f"/api/containers/{cid}/verdikt", json=body, headers=HUBOT)).status_code == 403
    assert (await client.put(f"/api/containers/{cid}/verdikt", json=body, headers=VERA)).status_code == 403
    assert (await client.put(f"/api/containers/{cid}/verdikt", json=body, headers=OCTO)).status_code == 200
    # the per-task override: same authority
    ov = {"mode": "off"}
    assert (await client.put(f"/api/tasks/{tid}/verdikt/autofix", json=ov, headers=VERA)).status_code == 403
    assert (await client.put(f"/api/tasks/{tid}/verdikt/autofix", json=ov, headers=HUBOT)).status_code == 403
    assert (await client.put(f"/api/tasks/{tid}/verdikt/autofix", json=ov, headers=OCTO)).status_code == 200
    g = await client.patch(f"/api/containers/{cid}/members/{hubot}", json={"grants": ["manage_repo"]}, headers=OCTO)
    assert g.status_code == 200
    assert (await client.put(f"/api/tasks/{tid}/verdikt/autofix", json=ov, headers=HUBOT)).status_code == 200
    # reading: members (a viewer included); strangers 403
    assert (await client.get(f"/api/tasks/{tid}/verdikt/autofix", headers=VERA)).status_code == 200
    assert (await client.get(f"/api/tasks/{tid}/verdikt/autofix",
                             headers={"X-Auth-Request-User": "mallory"})).status_code == 403
    # Stop: a viewer can't; the sweep: a viewer can't (machine lane = non-viewer members)
    assert (await client.post(f"/api/tasks/{tid}/verdikt/autofix/stop", json={}, headers=VERA)).status_code == 403
    assert (await client.post(f"/api/containers/{cid}/verdikt/sweep", json={}, headers=VERA)).status_code == 403
    assert (await client.post(f"/api/containers/{cid}/verdikt/sweep", json={}, headers=OCTO)).status_code == 200
    # the header-less daemon lane
    assert (await client.post(f"/api/containers/{cid}/verdikt/sweep", json={})).status_code == 200


async def test_openapi_documents_the_loop(client):
    spec = (await client.get("/openapi.json")).json()
    paths = spec["paths"]
    assert {"get", "put"} <= set(paths["/api/tasks/{tid}/verdikt/autofix"])
    assert "post" in paths["/api/tasks/{tid}/verdikt/autofix/stop"]
    assert "post" in paths["/api/containers/{cid}/verdikt/sweep"]
    props = spec["components"]["schemas"]["VerdiktSettingsBody"]["properties"]
    assert "autofix_enabled" in props and props["autofix_max_attempts"]["anyOf"][0]["maximum"] == 10
    modes = spec["components"]["schemas"]["AutofixOverrideBody"]["properties"]["mode"]
    assert set(modes["enum"]) == {"inherit", "on", "off"}


# ------------------------------------------------------------------ the background check

async def test_sweep_endpoint_reports_and_closes_the_loop(client, container, make_agent, make_task, work_headers,
                                                          db, fake):
    lp = await _setup(client, container, make_agent, make_task, work_headers, db, fake)  # nothing scripted
    await lp.wait_runs(1)
    s = await lp.sweep()
    assert s["in_flight"] == 1 and s["judged"] == 0 and lp.status() == "needs_verification"
    # 3am: Verdikt's worker finishes while nobody has the task open
    req = fake.tables["run_requests"][0]
    fake.complete(req["id"], "fail", [{"text": C2, "outcome": "fail", "expected": "red", "actual": "black"}])
    db.execute(f"UPDATE verdikt_runs SET last_polled_at = {ts_ago(60)}")
    from portal_backend import verdikt_autofix as vaf

    out = vaf.sweep(None)  # what the portal's own timer runs
    assert out["judged"] == 1 and out["in_flight"] == 0 and out["loops_running"] == 1
    assert lp.status() == "in_progress"
    assert (await client.post("/api/containers/not-a-uuid/verdikt/sweep", json={})).status_code == 400


def test_notifier_sweep_cadence():
    from orcha_cli import notifier_verdikt_sweep as ns

    calls = []
    answers = [{"in_flight": 2, "judged": 0}, {"in_flight": 0, "judged": 1}]
    now = [100.0]

    def post(url, body):
        calls.append(url)
        return answers.pop(0) if answers else None

    st = ns.SweepState()
    assert ns.maybe_sweep("http://p", "c1", st, post=post, clock=lambda: now[0])["in_flight"] == 2
    assert calls == ["http://p/api/containers/c1/verdikt/sweep"]
    now[0] += 5
    assert ns.maybe_sweep("http://p", "c1", st, post=post, clock=lambda: now[0]) is None  # not due yet
    now[0] += ns.ACTIVE_EVERY_S
    ns.maybe_sweep("http://p", "c1", st, post=post, clock=lambda: now[0])
    assert len(calls) == 2 and st.in_flight == 0
    now[0] += ns.ACTIVE_EVERY_S  # idle now: waits the long interval
    assert ns.maybe_sweep("http://p", "c1", st, post=post, clock=lambda: now[0]) is None
    now[0] += ns.IDLE_EVERY_S
    assert ns.maybe_sweep("http://p", "c1", st, post=post, clock=lambda: now[0]) is None  # portal down → None
    assert len(calls) == 3
    assert ns.maybe_sweep("http://p", "c1", ns.SweepState(), post=post, dry_run=True) is None


def test_message_is_actionable_and_failures_first():
    from portal_backend import verdikt_autofix as vaf

    run = {"id": "r1", "task_id": "t1", "trigger": "auto", "status": "completed", "verdict": "fail", "reason": "colour",
           "target_kind": "web", "locator": "http://x/login", "base_url": "http://v", "verdikt_run_id": "vr",
           "report_url": "http://v/runs/vr",
           "criteria": [{"text": "A", "outcome": "pass"},
                        {"text": "B", "outcome": "fail", "expected": "red", "actual": "black", "evidence_seq": 1}],
           "screenshots": [{"path": "vr/evidence/001-major.png", "seq": 1, "kind": "evidence", "label": "B"}],
           "_preview": None}
    msg = vaf.build_message({"id": "t1-abcdef", "title": "Login"}, run, attempt=2, max_attempts=3)
    lines = msg.splitlines()
    assert lines[0].startswith("Verdikt failed this task on attempt 2 of 3.")
    assert "This is the last automatic check." not in msg and "(1 more check before a person takes over)" in msg
    assert lines[2:6] == ["Failed criteria:", "1. B", "   Expected: red", "   Actual: black"]
    assert lines[6] == "   Screenshot: /api/tasks/t1/verdikt/runs/r1/artifact?path=vr/evidence/001-major.png"
    assert "Report: /api/tasks/t1/verdikt/runs/r1/report" in msg and "Tested: web:http://x/login" in msg
    assert vaf.failure_signature(run) == vaf.failure_signature({**run, "criteria": list(reversed(run["criteria"]))})
    last = vaf.build_message({"id": "t1", "title": "x"}, run, attempt=3, max_attempts=3)
    assert "This is the last automatic check." in last
    assert json.dumps(msg)  # plain text, no structures
