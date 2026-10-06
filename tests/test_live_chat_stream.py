"""Live chat: an agent's reply streams into the portal as it is produced (like a terminal).

Covers the three hops between a resident's stream-json log and the browser:
  1. daemon feed (notifier_run_feed): Claude `--include-partial-messages` text deltas are
     kept — compacted, never invented — instead of dropped; a posted `result` is reported;
  2. daemon idle gap (notifier_fast_lane): live logs are pumped every ~0.2s, and the gap
     ends at once on a human turn (container SSE) or a finished reply;
  3. portal run SSE: an idle stream is woken by POST /lines (no fixed 1s poll), resumes
     after a seq (id:/Last-Event-ID/?after_seq=), and run/reply notices reach the
     container event stream (container-wide only — they never wake an agent).
"""

import asyncio
import json
import threading
import time
import uuid

import pytest

from orcha_cli import notifier
from orcha_cli import notifier_fast_lane as fast_lane
from orcha_cli import notifier_run_feed as run_feed

SID = {"session_id": "9182b3c7-da6c-498b-a13b-f4fa8624efef", "parent_tool_use_id": None}


def se(event, **extra):
    """A stream_event line in the exact shape claude writes (read from a real Atlas run)."""
    return json.dumps({"type": "stream_event", "event": event, **SID,
                       "uuid": str(uuid.uuid4()), **extra})


def text_delta(text, index=0):
    return se({"type": "content_block_delta", "index": index,
               "delta": {"type": "text_delta", "text": text}})


ASSISTANT_TEXT = json.dumps({"type": "assistant", "message": {"content": [
    {"type": "text", "text": "Let me verify all of it."}]}, **SID})
RESULT = json.dumps({"type": "result", "subtype": "success", "result": "done", **SID})


# ---------- 1. the daemon feed keeps the reply's text deltas (compacted) ----------

def test_compact_joins_text_deltas_exactly_and_keeps_order():
    lines = [
        se({"type": "message_start", "message": {"id": "msg_1", "content": []}}),
        se({"type": "content_block_start", "index": 0, "content_block": {"type": "text", "text": ""}}),
        text_delta("Let me "), text_delta("verify "), text_delta("all of it."),
        ASSISTANT_TEXT,
        se({"type": "content_block_stop", "index": 0}),
        se({"type": "content_block_start", "index": 1, "content_block": {
            "type": "tool_use", "id": "toolu_1", "name": "Bash", "input": {}, "caller": {"type": "direct"}}}),
        se({"type": "content_block_delta", "index": 1,
            "delta": {"type": "input_json_delta", "partial_json": "{\"command\": \"ls"}}),
        se({"type": "message_delta", "delta": {"stop_reason": "tool_use"}, "usage": {"output_tokens": 9}}),
        se({"type": "message_stop"}),
    ]
    out = run_feed.compact_stream_events(lines)
    parsed = [json.loads(line) for line in out]
    # exactly: one joined delta, the complete assistant block, one slim tool start
    assert [p["type"] for p in parsed] == ["stream_event", "assistant", "stream_event"]
    joined = parsed[0]
    assert joined["event"] == {"type": "content_block_delta", "index": 0,
                               "delta": {"type": "text_delta", "text": "Let me verify all of it."}}
    assert joined["orcha_coalesced"] == 3
    assert joined["session_id"] == SID["session_id"] and joined["parent_tool_use_id"] is None
    assert out[1] == ASSISTANT_TEXT                        # complete events pass through untouched
    assert parsed[2]["event"] == {"type": "content_block_start", "index": 1,
                                  "content_block": {"type": "tool_use", "id": "toolu_1", "name": "Bash"}}


def test_compact_never_merges_across_blocks_or_subagents():
    sub = json.dumps({"type": "stream_event", "event": {"type": "content_block_delta", "index": 0,
                      "delta": {"type": "text_delta", "text": "sub"}}, "parent_tool_use_id": "toolu_9"})
    out = [json.loads(x) for x in run_feed.compact_stream_events(
        [text_delta("a", 0), text_delta("b", 0), text_delta("c", 2), sub, text_delta("d", 2)])]
    texts = [(o["event"]["index"], o.get("parent_tool_use_id"), o["event"]["delta"]["text"]) for o in out]
    assert texts == [(0, None, "ab"), (2, None, "c"), (0, "toolu_9", "sub"), (2, None, "d")]


def test_pump_posts_compacted_deltas_and_reports_the_result(monkeypatch, tmp_path):
    posts = []
    log = tmp_path / "resident.log"
    log.write_text("\n".join([text_delta("Hel"), text_delta("lo")]) + "\n")
    w = {"log_path": str(log), "run_id": "R", "lines_offset": 0, "lines_seq": 1, "lines_buf": b""}
    post = lambda url, body: (posts.append(body) or {"ok": True})  # noqa: E731

    assert run_feed.pump_one("http://x", w, post) is False
    assert len(posts) == 1 and len(posts[0]["lines"]) == 1
    assert json.loads(posts[0]["lines"][0])["event"]["delta"]["text"] == "Hello"
    assert w["lines_seq"] == 2

    with log.open("a") as f:
        f.write(ASSISTANT_TEXT + "\n" + RESULT + "\n")
    assert run_feed.pump_one("http://x", w, post) is True   # the turn's result was just posted
    assert posts[1]["start_seq"] == 2 and posts[1]["lines"] == [ASSISTANT_TEXT, RESULT]


def test_pump_keeps_a_failed_batch_for_retry(tmp_path):
    log = tmp_path / "w.log"
    log.write_text(text_delta("x") + "\n")
    w = {"log_path": str(log), "run_id": "R", "lines_offset": 0, "lines_seq": 1, "lines_buf": b""}
    assert run_feed.pump_one("http://x", w, lambda url, body: None) is False
    assert w["lines_offset"] == 0 and w["lines_seq"] == 1   # nothing lost: re-read next pass


# ---------- 2. the daemon's idle gap ----------

class FakeClock:
    def __init__(self):
        self.t = 0.0

    def now(self):
        return self.t

    def sleep(self, s):
        self.t += s


def test_idle_wait_pumps_live_logs_every_step_for_the_whole_gap():
    clock = FakeClock()
    pumped = []
    worker = {"agent_id": "A", "run_id": "R"}
    got = fast_lane.idle_wait(2.0, {"flag": False}, live_workers={"A": worker}, live_residents={},
                              pump=lambda w: pumped.append(clock.t) or False,
                              sleep=clock.sleep, clock=clock.now)
    assert got is None
    assert len(pumped) >= 10                               # ~every 0.2s, not once per 2s scan
    assert max(b - a for a, b in zip(pumped, pumped[1:])) <= fast_lane.PUMP_STEP_S + 1e-9


def test_idle_wait_ends_early_on_a_finished_reply_but_only_for_a_turn_in_flight():
    clock = FakeClock()
    busy = {"awaiting_result": True, "current_run_id": "R1"}
    idle = {"awaiting_result": False, "current_run_id": None}
    calls = []

    def pump(w):
        calls.append(w)
        return clock.t >= 0.4                               # the result line lands at t=0.4

    got = fast_lane.idle_wait(2.0, {"flag": False}, live_workers={},
                              live_residents={"c1": busy, "c2": idle}, pump=pump,
                              sleep=clock.sleep, clock=clock.now)
    assert got == "result"
    assert clock.t < 0.5                                    # not the full 2s gap
    assert idle not in calls                                # between turns a log belongs to no run


def test_idle_wait_ends_at_once_on_a_human_turn():
    clock = FakeClock()
    wake = threading.Event()

    def sleep(s):
        clock.sleep(s)
        if clock.t >= 0.6:
            wake.set()

    got = fast_lane.idle_wait(2.0, {"flag": False}, live_workers={}, live_residents={},
                              pump=lambda w: False, wake=wake, sleep=sleep, clock=clock.now)
    assert got == "turn" and clock.t <= 0.8 and not wake.is_set()


def test_turn_watcher_wakes_only_on_a_human_turn_and_advances_its_cursor():
    w = fast_lane.TurnEventWatcher("http://x", "C")
    w.handle_line(": heartbeat 1\n")
    w.handle_line('data: {"event": "worker_run_started", "ts": 5e9}')
    assert not w.wake.is_set() and w._cursor == 5e9
    w.handle_line('data: {"event": "conversation_turn", "ts": 5e9, "conversation_id": "x"}')
    assert w.wake.is_set()


def test_turn_watcher_reads_a_real_sse_body_and_survives_a_dead_portal():
    w = fast_lane.TurnEventWatcher("http://x", "C", opener=lambda url: (_ for _ in ()).throw(OSError("down")))

    class Body:
        def __enter__(self):
            return iter([b": stream open\n", b"\n", b'data: {"event": "conversation_turn", "ts": 1}\n'])

        def __exit__(self, *a):
            return False

    urls = []

    def opener(url):
        urls.append(url)
        if len(urls) == 1:
            raise OSError("portal restarting")
        return Body()

    w._open = opener
    w._stop.wait = lambda s: len(urls) >= 2 and w.wake.is_set()  # no real backoff sleep
    w._run()
    assert w.wake.is_set() and urls[0].startswith("http://x/api/containers/C/events?since_ts=")


def test_facade_pump_returns_the_result_flag(monkeypatch, tmp_path):
    monkeypatch.setattr(notifier, "_post_json", lambda url, body, **k: {"ok": True})
    log = tmp_path / "w.log"
    log.write_text(RESULT + "\n")
    w = {"log_path": str(log), "run_id": "R", "lines_offset": 0, "lines_seq": 1, "lines_buf": b""}
    assert notifier._pump_one("http://x", "A", w) is True


# ---------- 3. the portal run stream ----------

async def _start_run(client, make_agent, **body):
    a = await make_agent("Atlas", "eng")
    rid = (await client.post(f"/api/agents/{a['agent_id']}/runs",
                             json={"wake_kind": "resident", "lane": "conversation", **body})).json()["run_id"]
    return a["agent_id"], rid


async def test_stream_frames_carry_ids_and_resume_after_a_seq(client, make_agent):
    aid, rid = await _start_run(client, make_agent)
    await client.post(f"/api/runs/{rid}/lines", json={"start_seq": 1, "lines": ["a", "b", "c"]})
    await client.post(f"/api/runs/{rid}/finish", json={"status": "exited", "exit_code": 0})

    r = await client.get(f"/api/agents/{aid}/runs/{rid}/stream")
    assert r.headers["x-accel-buffering"] == "no"            # proxies pass each event through
    assert [l for l in r.text.splitlines() if l.startswith("id:")] == ["id: 1", "id: 2", "id: 3"]

    def seqs(text):
        return [json.loads(l[5:])["seq"] for l in text.splitlines() if l.startswith("data:") and '"line"' in l]

    assert seqs((await client.get(f"/api/agents/{aid}/runs/{rid}/stream?after_seq=2")).text) == [3]
    # a browser's automatic reconnect sends Last-Event-ID
    r = await client.get(f"/api/agents/{aid}/runs/{rid}/stream", headers={"Last-Event-ID": "1"})
    assert seqs(r.text) == [2, 3]
    assert json.loads([l for l in r.text.splitlines() if l.startswith("data:")][-1][5:])["done"] is True


async def test_an_idle_stream_gets_a_new_batch_as_soon_as_it_is_posted(client, make_agent):
    """Before: an idle stream re-read the table once a second, so a line waited up to ~1s.
    Now POST /lines wakes it — measured here well under the old interval."""
    from portal_backend import stream_signal

    from starlette.requests import Request
    from portal_backend.worker_run_read_routes import stream_worker_run

    aid, rid = await _start_run(client, make_agent)
    got = {}
    # httpx's ASGITransport buffers a whole response, so read the SSE generator directly
    req = Request({"type": "http", "method": "GET", "path": "/", "headers": [], "query_string": b""})
    resp = await stream_worker_run(aid, rid, req, after_seq=None)

    async def reader():
        async for chunk in resp.body_iterator:
            text = chunk if isinstance(chunk, str) else chunk.decode()
            for line in text.splitlines():
                if line.startswith("data:") and '"line"' in line:
                    got["at"] = time.perf_counter()
                    got["line"] = json.loads(line[5:])["line"]
                    return

    task = asyncio.create_task(reader())
    for _ in range(100):                                    # wait until the stream is idle-waiting
        if stream_signal.waiter_count(rid):
            break
        await asyncio.sleep(0.01)
    await asyncio.sleep(0.15)
    sent = time.perf_counter()
    await client.post(f"/api/runs/{rid}/lines", json={"start_seq": 1, "lines": [text_delta("Hi")]})
    await asyncio.wait_for(task, timeout=3)
    latency = got["at"] - sent
    assert json.loads(got["line"])["event"]["delta"]["text"] == "Hi"
    assert latency < 0.5, f"line took {latency:.3f}s to reach the stream"
    print(f"\n[live-chat] POST /lines → SSE frame: {latency * 1000:.1f} ms (old path: up to 1000 ms)")
    await resp.body_iterator.aclose()
    assert stream_signal.waiter_count(rid) == 0           # the stream unregistered on close


async def test_run_and_reply_notices_reach_the_container_stream_but_never_an_agent(
        client, make_agent, container, db):
    human = await make_agent("Hussein", "owner", kind="human")
    aid, rid = await _start_run(client, make_agent)
    conv = (await client.post(f"/api/agents/{aid}/conversations",
                              json={"actor_agent_id": human["agent_id"]})).json()["conversation"]
    await client.post(f"/api/conversations/{conv['id']}/turns",
                      json={"role": "agent", "author_agent_id": aid, "content": "Done.", "run_id": rid})
    await client.post(f"/api/runs/{rid}/finish", json={"status": "exited", "exit_code": 0})

    names = [r["event_name"] for r in db.event_rows(f"c:{container['id']}")]
    for n in ("worker_run_started", "conversation_reply", "worker_run_finished"):
        assert n in names, names
    agent_names = [r["event_name"] for r in db.event_rows(aid)]
    assert not {"worker_run_started", "conversation_reply", "worker_run_finished"} & set(agent_names)
    reply = next(r for r in db.event_rows(f"c:{container['id']}") if r["event_name"] == "conversation_reply")
    assert reply["target_id"] is None and reply["payload"]["run_id"] == rid


async def test_a_human_turn_wakes_event_waiters_at_once(client, make_agent, container):
    """The daemon's turn watcher (container /events) and /wait long-polls used to see a new
    human turn only on their next 0.5s DB poll; the turn POST now wakes them after commit.
    The poll interval here is 5s, so only the wake-up can make this fast."""
    from portal_backend import stream_signal
    from portal_backend.events import wait_for_event

    human = await make_agent("Hussein", "owner", kind="human")
    aid, _ = await _start_run(client, make_agent)
    conv = (await client.post(f"/api/agents/{aid}/conversations",
                              json={"actor_agent_id": human["agent_id"]})).json()["conversation"]
    since = time.time()
    waiters = [asyncio.create_task(wait_for_event(k, since, 5.0, poll_interval_s=5.0))
               for k in (f"c:{container['id']}", aid)]
    await asyncio.sleep(0.2)                                 # both are parked on their wait
    sent = time.perf_counter()
    r = await client.post(f"/api/conversations/{conv['id']}/turns",
                          json={"role": "human", "author_agent_id": human["agent_id"], "content": "hi"})
    assert r.status_code == 201, r.text
    got = await asyncio.wait_for(asyncio.gather(*waiters), timeout=3)
    latency = time.perf_counter() - sent
    assert [e["event"] for e in got] == ["conversation_turn", "conversation_turn"]
    assert latency < 1.0, f"{latency:.3f}s"
    print(f"\n[live-chat] human turn POST → event waiters woken: {latency * 1000:.1f} ms "
          "(old path: up to 500 ms poll)")
    assert stream_signal.waiter_count(aid) == 0
