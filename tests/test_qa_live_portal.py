"""Orcha QA portal: the live device view. Latest frame only, in memory; member read; a person only
can take a device over, and what they type is never read back."""
import pytest

from portal_backend import qa_live_routes as live
from conftest import run_task_id


@pytest.fixture
async def people(make_agent):
    human = await make_agent("Hussein", "owner", kind="human")
    other = await make_agent("Maya", "owner", kind="human")
    bot = await make_agent("qa-bot")
    return {"human": human["agent_id"], "other": other["agent_id"], "bot": bot["agent_id"]}


@pytest.fixture(autouse=True)
def clean():
    live._LIVE.clear()
    yield
    live._LIVE.clear()


def jpeg(n: int = 0) -> bytes:
    return b"\xff\xd8\xff\xe0" + bytes([n]) * 32


async def _session(client, cid, bot, platform="ios", kind="explore"):
    r = await client.post(f"/api/containers/{cid}/qa/sessions", json={"actor_agent_id": bot, "kind": kind, "platform": platform, "task_id": await run_task_id(client, cid, bot)})
    assert r.status_code == 201, r.text
    return r.json()["id"]


async def _put(client, sid, bot, data, **params):
    return await client.put(f"/api/qa/sessions/{sid}/live/frame", params={"actor_agent_id": bot, **params}, content=data,
                            headers={"content-type": "image/jpeg"})


async def _beat(client, sid, bot, **body):
    r = await client.post(f"/api/qa/sessions/{sid}/live/beat", json={"actor_agent_id": bot, **body})
    assert r.status_code == 200, r.text
    return r.json()


async def _takeover(client, sid, who, on=True, still=False):
    return await client.post(f"/api/qa/sessions/{sid}/live/takeover", json={"actor_agent_id": who, "on": on, "still": still})


async def _input(client, sid, who, kind="tap", args=None):
    return await client.post(f"/api/qa/sessions/{sid}/live/input", json={"actor_agent_id": who, "kind": kind, "args": args or {"x": 10, "y": 20}})


async def test_only_the_latest_frame_is_kept_and_no_row_or_file_is_made(client, container, people):
    sid = await _session(client, container["id"], people["bot"])
    assert (await _put(client, sid, people["bot"], jpeg(1), screen_w=390, screen_h=844)).json() == {"n": 1}
    assert (await _put(client, sid, people["bot"], jpeg(2), cmd_seq=4)).json() == {"n": 2}

    meta = (await client.get(f"/api/qa/sessions/{sid}/live")).json()
    assert (meta["n"], meta["cmd_seq"], meta["screen_w"], meta["screen_h"]) == (2, 4, 390, 844)
    r = await client.get(f"/api/qa/sessions/{sid}/live/frame", params={"v": 2})
    assert r.status_code == 200 and r.content == jpeg(2)
    assert r.headers["content-type"] == "image/jpeg" and r.headers["cache-control"] == "no-store"

    detail = (await client.get(f"/api/qa/sessions/{sid}")).json()
    assert detail["frames_count"] == 0


async def test_a_frame_must_be_a_small_jpeg_from_a_member(client, container, people):
    sid = await _session(client, container["id"], people["bot"])
    r = await client.put(f"/api/qa/sessions/{sid}/live/frame", params={"actor_agent_id": people["bot"]}, content=jpeg(), headers={"content-type": "text/plain"})
    assert r.status_code == 415
    assert (await _put(client, sid, people["bot"], b"not a jpeg")).status_code == 400
    assert (await _put(client, sid, people["bot"], b"\xff\xd8\xff" + b"0" * live.MAX_LIVE_FRAME_BYTES)).status_code == 413
    assert (await _put(client, sid, "99999999-9999-4999-8999-999999999999", jpeg())).status_code == 404


async def test_no_frame_yet_is_a_404_and_an_ended_session_drops_its_frame(client, container, people):
    bot = people["bot"]
    sid = await _session(client, container["id"], bot)
    assert (await client.get(f"/api/qa/sessions/{sid}/live/frame")).status_code == 404
    assert (await client.get(f"/api/qa/sessions/{sid}/live")).json()["n"] == 0
    await _put(client, sid, bot, jpeg())
    r = await client.patch(f"/api/qa/sessions/{sid}", json={"actor_agent_id": bot, "status": "done"})
    assert r.status_code == 200
    # The tool server stops on this answer.
    assert (await _put(client, sid, bot, jpeg())).status_code == 409
    assert (await client.post(f"/api/qa/sessions/{sid}/live/beat", json={"actor_agent_id": bot})).status_code == 409
    meta = (await client.get(f"/api/qa/sessions/{sid}/live")).json()
    assert meta["status"] == "done" and meta["n"] == 0
    assert sid not in live._LIVE
    assert (await client.get(f"/api/qa/sessions/{sid}/live/frame")).status_code == 404


async def test_the_tool_server_drops_the_frame_when_it_stops(client, container, people):
    sid = await _session(client, container["id"], people["bot"])
    await _put(client, sid, people["bot"], jpeg())
    r = await client.delete(f"/api/qa/sessions/{sid}/live", params={"actor_agent_id": people["bot"]})
    assert r.status_code == 204 and sid not in live._LIVE


async def test_memory_stays_bounded(client, container, people, monkeypatch):
    monkeypatch.setattr(live, "MAX_LIVE_SESSIONS", 2)
    bot = people["bot"]
    sids = [await _session(client, container["id"], bot) for _ in range(3)]
    for sid in sids:
        await _put(client, sid, bot, jpeg())
    assert len(live._LIVE) == 2 and sids[0] not in live._LIVE
    now = [live._clock() + live.LIVE_FORGET_S + 1]
    monkeypatch.setattr(live, "_clock", lambda: now[0])
    new = await _session(client, container["id"], bot)
    await _put(client, new, bot, jpeg())
    assert list(live._LIVE) == [new]


async def test_activity_follows_the_screen_and_the_steps_not_the_beat(client, container, people, monkeypatch):
    bot = people["bot"]
    sid = await _session(client, container["id"], bot)
    now = [1000.0]
    monkeypatch.setattr(live, "_clock", lambda: now[0])
    await _put(client, sid, bot, jpeg())
    now[0] += 120
    await _beat(client, sid, bot, steps=0)
    meta = (await client.get(f"/api/qa/sessions/{sid}/live")).json()
    assert meta["activity_age_ms"] == 120_000 and meta["beat_age_ms"] == 0
    await _beat(client, sid, bot, steps=7)
    assert (await client.get(f"/api/qa/sessions/{sid}/live")).json()["activity_age_ms"] == 0


async def test_a_person_takes_over_and_their_inputs_reach_the_tool_server_once(client, container, people):
    bot, human = people["bot"], people["human"]
    sid = await _session(client, container["id"], bot)
    await _beat(client, sid, bot, screen_w=390, screen_h=844, stream=True)
    r = await _takeover(client, sid, human)
    assert r.status_code == 200 and r.json()["takeover"]["by_id"] == human
    assert (await _beat(client, sid, bot))["takeover"]["by"] == "Hussein"

    assert (await _input(client, sid, human)).status_code == 201
    r = await _input(client, sid, human, "press", {"key": "home"})
    assert r.json()["seq"] == 2 and r.json()["status"] == "pending"
    got = await _beat(client, sid, bot)
    assert [(c["seq"], c["kind"]) for c in got["inputs"]] == [(1, "tap"), (2, "press")]
    assert (await _beat(client, sid, bot))["inputs"] == []

    await _beat(client, sid, bot, cmd_seq=2, results=[{"seq": 1, "ok": True, "result": "tapped"}, {"seq": 2, "ok": False, "result": "error: no"}])
    meta = (await client.get(f"/api/qa/sessions/{sid}/live")).json()
    assert [(i["seq"], i["status"], i["result"]) for i in meta["inputs"]] == [(1, "done", "tapped"), (2, "failed", "error: no")]
    assert meta["cmd_seq"] == 2

    r = await _takeover(client, sid, human, on=False)
    assert r.json()["takeover"] is None
    assert (await _beat(client, sid, bot))["takeover"] is None
    assert (await _input(client, sid, human)).status_code == 409


async def test_inputs_made_before_handing_back_still_play(client, container, people):
    bot, human = people["bot"], people["human"]
    sid = await _session(client, container["id"], bot)
    await _beat(client, sid, bot)
    await _takeover(client, sid, human)
    await _input(client, sid, human)
    await _takeover(client, sid, human, on=False)
    got = await _beat(client, sid, bot)
    assert got["takeover"] is None and [c["seq"] for c in got["inputs"]] == [1]


async def test_only_a_person_can_drive(client, container, people):
    bot, human = people["bot"], people["human"]
    sid = await _session(client, container["id"], bot)
    await _beat(client, sid, bot)
    assert (await _takeover(client, sid, bot)).status_code == 403
    await _takeover(client, sid, human)
    assert (await _input(client, sid, bot)).status_code == 403


async def test_one_person_at_a_time_and_only_the_one_who_took_it(client, container, people):
    bot, human, other = people["bot"], people["human"], people["other"]
    sid = await _session(client, container["id"], bot)
    await _beat(client, sid, bot)
    await _takeover(client, sid, human)
    r = await _takeover(client, sid, other)
    assert r.status_code == 409 and "Hussein" in r.json()["detail"]
    assert (await _input(client, sid, other)).status_code == 409


async def test_no_tool_server_means_no_takeover(client, container, people, monkeypatch):
    bot, human = people["bot"], people["human"]
    sid = await _session(client, container["id"], bot)
    assert (await _takeover(client, sid, human)).status_code == 409
    await _beat(client, sid, bot)
    now = [live._clock() + live.BEAT_GONE_S + 1]
    monkeypatch.setattr(live, "_clock", lambda: now[0])
    assert (await _takeover(client, sid, human)).status_code == 409


async def test_what_a_person_typed_is_never_read_back(client, container, people):
    bot, human = people["bot"], people["human"]
    sid = await _session(client, container["id"], bot)
    await _beat(client, sid, bot)
    await _takeover(client, sid, human)
    r = await _input(client, sid, human, "type", {"text": "hunter2"})
    assert r.status_code == 201 and "hunter2" not in r.text and r.json()["args"] == {"chars": 7}
    assert "hunter2" not in (await client.get(f"/api/qa/sessions/{sid}/live")).text
    # The tool server needs it, once.
    got = await _beat(client, sid, bot)
    assert got["inputs"][0]["args"] == {"text": "hunter2"}
    assert "hunter2" not in (await client.get(f"/api/qa/sessions/{sid}/live")).text


async def test_a_takeover_ends_when_its_page_goes_or_nothing_is_done(client, container, people, monkeypatch):
    bot, human = people["bot"], people["human"]
    sid = await _session(client, container["id"], bot)
    await _beat(client, sid, bot)
    await _takeover(client, sid, human)
    now = [live._clock()]
    monkeypatch.setattr(live, "_clock", lambda: now[0])
    now[0] += live.TAKEOVER_GONE_S + 1
    assert (await _beat(client, sid, bot))["takeover"] is None
    assert "closed" in (await client.get(f"/api/qa/sessions/{sid}/live")).json()["notice"]

    await _takeover(client, sid, human)
    await _input(client, sid, human)
    for _ in range(11):  # the page stays open, nobody touches it
        now[0] += 55
        await _takeover(client, sid, human, still=True)
        await _beat(client, sid, bot)
    assert (await _beat(client, sid, bot))["takeover"] is None
    assert "Ended after 10 minutes idle. Your 1 input was kept." == (await client.get(f"/api/qa/sessions/{sid}/live")).json()["notice"]


@pytest.mark.parametrize("kind,args", [
    ("tap", {"x": "1", "y": 2}), ("tap", {"x": -1, "y": 2}), ("tap", {"x": True, "y": 2}), ("swipe", {"direction": "sideways"}),
    ("press", {"key": "power"}), ("type", {"text": ""}), ("type", {"text": "x" * 2001}), ("open_url", {"url": "file:///etc/passwd"}),
])
async def test_inputs_are_checked(client, container, people, kind, args):
    bot, human = people["bot"], people["human"]
    sid = await _session(client, container["id"], bot)
    await _beat(client, sid, bot)
    await _takeover(client, sid, human)
    assert (await _input(client, sid, human, kind, args)).status_code == 422


async def test_a_finish_or_a_script_is_not_an_input(client, container, people):
    bot, human = people["bot"], people["human"]
    sid = await _session(client, container["id"], bot)
    await _beat(client, sid, bot)
    await _takeover(client, sid, human)
    assert (await _input(client, sid, human, "finish", {})).status_code == 422


async def test_extra_args_do_not_travel(client, container, people):
    bot, human = people["bot"], people["human"]
    sid = await _session(client, container["id"], bot)
    await _beat(client, sid, bot)
    await _takeover(client, sid, human)
    await _input(client, sid, human, "tap", {"x": 1, "y": 2, "evil": "yes"})
    got = await _beat(client, sid, bot)
    assert got["inputs"][0]["args"] == {"x": 1, "y": 2}


async def test_a_page_left_open_cannot_take_the_device_back(client, container, people):
    bot, human = people["bot"], people["human"]
    sid = await _session(client, container["id"], bot)
    await _beat(client, sid, bot)
    await _takeover(client, sid, human)
    await _takeover(client, sid, human, on=False)
    r = await _takeover(client, sid, human, still=True)
    assert r.status_code == 200 and r.json()["takeover"] is None
