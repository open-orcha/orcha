"""What a check does before a scenario: clear the app's data or keep it, grant permissions or leave
them to the prompt, one Examples row at a time, a sealed value typed unseen."""
import pytest

from orcha_cli.qa import app_permissions, fresh_state, mcp_server, scenario_format as sf
from orcha_cli.qa.session_state import LiveSession


class Device:
    def __init__(self):
        self.calls, self.udid, self.typed = [], "SIM", None

    async def terminate_app(self):
        self.calls.append("terminate")

    async def launch_app(self):
        self.calls.append("launch")


class Portal:
    def __init__(self, row):
        self.row = row

    def get_scenario(self, _id):
        return self.row

    def reveal_example(self, _id, ref):
        return {"value": "hunter2"}


def tools(row, platform="ios"):
    t = mcp_server.QATools.__new__(mcp_server.QATools)
    t.portal = Portal(row)
    t.live = LiveSession(id="s1", platform=platform, kind="check", app_id="com.acme", device=Device())
    t.ident = None
    return t


@pytest.fixture
def seen(monkeypatch):
    calls = []
    monkeypatch.setattr(fresh_state, "reset_app", lambda kind, dev, app: (calls.append("reset"), fresh_state.ResetResult(True, "cleared"))[1])
    monkeypatch.setattr(app_permissions, "grant_ios", lambda dev, app: (calls.append("grant"), app_permissions.GrantResult(granted=["photos"]))[1])
    return calls


@pytest.mark.parametrize("row,expected", [
    ({}, ["reset", "grant"]),
    ({"fresh": False}, ["grant"]),
    ({"session": "admin"}, ["grant"]),
    ({"session": "admin", "tags": ["setup"]}, ["reset", "grant"]),
    ({"fresh": True, "session": "admin"}, ["reset", "grant"]),
    ({"permissions": "ask"}, ["reset"]),
    ({"description": "The app asks to allow notifications"}, ["reset"]),
])
async def test_start_scenario_honours_fresh_and_permissions(seen, row, expected):
    t = tools({"id": "a", "name": "A", "platform": "ios", "status": "validated", "criteria": [], **row})
    out = await t.start_scenario("a")
    assert seen == expected, out
    assert t.live.device.calls == ["terminate", "launch"]


async def test_a_reset_that_failed_says_to_block_the_scenario(monkeypatch, seen):
    monkeypatch.setattr(fresh_state, "reset_app", lambda *a: fresh_state.ResetResult(False, "no", needs_setup="no reset"))
    out = await tools({"id": "a", "name": "A", "platform": "ios", "status": "draft"}).start_scenario("a")
    assert "blocked" in out


async def test_retired_and_other_platforms_never_start(seen):
    assert "retired" in await tools({"id": "a", "name": "A", "platform": "ios", "status": "retired"}).start_scenario("a")
    assert "android only" in await tools({"id": "a", "name": "A", "platform": "android", "status": "validated"}).start_scenario("a")
    await tools({"id": "a", "name": "A", "platform": "android", "shared": True, "status": "validated"}).start_scenario("a")


async def test_quarantine_is_said_and_rows_are_named(seen):
    row = {"id": "a", "name": "A", "platform": "ios", "status": "validated", "quarantined_at": "2026-01-01",
           "examples": {"columns": ["email", "password"], "rows": [["a@b.co", "secret:sec_0123456789ab"]]}}
    out = await tools(row).start_scenario("a", 0)
    assert "does not fail this check" in out and "email = a@b.co" in out
    assert "sec_0123456789ab" not in out and "type_secret" in out


async def test_type_secret_records_no_value(seen, monkeypatch):
    row = {"id": "a", "name": "A", "platform": "ios", "status": "validated",
           "examples": {"columns": ["password"], "rows": [["secret:sec_0123456789ab"]]}}
    t = tools(row)
    await t.start_scenario("a", 0)
    acted = {}

    async def act(kind, args, label, call, sealed=None):
        acted.update(args=args, label=label)
        assert sealed == "hunter2"  # what must not come back
        return "typed"

    t._act = act
    await t.type_secret("Password", "a", "password")
    assert acted["args"] == {"target": "Password", "secret": True} and "hunter2" not in str(acted)


def test_the_format_round_trips_how_it_runs():
    row = {"id": "x", "name": "N", "criteria": ["A", "B"], "seed": ["POST /a {} as a"], "cleanup": ["DELETE /a/1"],
           "events": ['network: "x"'], "session": "admin", "permissions": "ask", "fresh": False,
           "examples": {"columns": ["c"], "rows": [["1"]]}}
    s = sf.from_row(row)
    text = sf.render_scenario(s)
    assert "Fresh: no" in text and "Permissions: ask" in text and "Seed: POST /a {} as a" in text and "Session: admin" in text
    back = sf.to_row(s)
    assert back["fresh"] is False and back["seed"] == row["seed"] and back["events"] == row["events"] and back["examples"]["rows"] == [["1"]]
