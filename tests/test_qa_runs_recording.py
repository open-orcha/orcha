"""What a session records for its run page: log lines, network calls and step times."""
import re

from orcha_cli.qa.device import logs as native_logs
from orcha_cli.qa.session_state import LiveSession


def session():
    return LiveSession(id="s1", platform="web", kind="explore", app_id="https://a.test")


def test_step_times_carry_milliseconds():
    step = session().record("tap", {"target": "e1"}, "ok")
    assert re.fullmatch(r"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z", step["at"])


def test_telemetry_is_numbered_and_filed_under_the_step_in_hand():
    live = session()
    live.record("tap", {}, "ok")
    at = live.started_at + 1.5
    live.note_telemetry([{"at": at, "level": "error", "source": "console", "text": "boom"}],
                        [{"at": at, "kind": "xhr", "method": "GET", "url": "https://a.test/x", "status": 200}])
    live.record("tap", {}, "ok")
    live.note_telemetry([{"at": at, "level": "info", "source": "console", "text": "next"}], [])
    assert [(r["seq"], r["step_seq"]) for r in live.unsent_logs] == [(1, 1), (2, 2)]
    assert live.unsent_logs[0]["at_ms"] == 1500 and "at" not in live.unsent_logs[0]
    assert live.unsent_requests[0]["seq"] == 1 and live.unsent_requests[0]["url"] == "https://a.test/x"


def test_an_android_log_line_becomes_a_row():
    line = "11-05 10:00:01.123  4242  4242 E AndroidRuntime: FATAL EXCEPTION: main"
    rows = native_logs.parse_android_logcat(line)
    assert rows and rows[0].level == "error" and "FATAL EXCEPTION" in rows[0].text


def test_repeats_collapse_with_a_count():
    a = native_logs.LogEntry(source="device", level="warn", text="same")
    b = native_logs.LogEntry(source="device", level="warn", text="same")
    rows = native_logs.dedupe_entries([a, b])
    assert len(rows) == 1 and rows[0].detail["count"] == 2


def test_steps_left_by_a_quiet_agent_go_out_on_the_live_beat():
    import asyncio

    from orcha_cli.qa.portal import PortalError
    from test_qa_mcp import make, run

    class Clock:
        now = 100.0

        def __call__(self):
            return self.now

    clock = Clock()
    tools, portal, _device, _seen = make([], clock=clock) if False else make(clock=clock)
    run(tools.start_session("ios", "map", minutes=0))
    run(tools.swipe("up"))
    assert portal.steps == {}  # under the batch, and no time has passed

    class Frames:
        published_seq = 0

    live = tools.live
    live.frames = Frames()
    beats = []

    def beat(_sid, _body):
        beats.append(1)
        if len(beats) > 1:
            raise PortalError("gone", status=404)
        return {}

    portal.live_beat = beat
    clock.now += 5
    asyncio.run(tools._live_loop(live, portal))
    assert sorted(portal.steps)[:2] == [1, 2]
