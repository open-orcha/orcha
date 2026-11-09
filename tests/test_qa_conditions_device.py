"""Run conditions on the device side: what is asked, what Orcha sets, what it puts back, and the
scenario format's `Conditions:` line."""
from __future__ import annotations

import asyncio
from types import SimpleNamespace

from orcha_cli.qa import conditions as c
from orcha_cli.qa import scenario_format as sf


def test_normalize_keeps_only_what_is_allowed():
    got = c.normalize({"os": " Android 13 ", "text_size": "LARGE", "appearance": "sepia", "network": "slow", "locale": "not a locale!", "x": 1, "account": ""})
    assert got == {"os": "Android 13", "text_size": "large", "network": "slow"}
    assert c.normalize('{"locale": "sw-KE"}') == {"locale": "sw-KE"}
    assert c.normalize("nonsense") == {}


def test_a_run_overrides_its_scenario_key_by_key():
    assert c.merge({"os": "13", "locale": "sw-KE"}, {"locale": "fr-FR", "text_size": "larger"}) == {"os": "13", "locale": "fr-FR", "text_size": "larger"}


def test_os_versions_match_on_what_was_asked():
    assert c.os_matches("Android 13", "13") and c.os_matches("13", "13.0.1") and c.os_matches("iOS 18.2", "iOS 18.2.1")
    assert c.os_matches("13", "16") is False and c.os_matches("iOS 18", "iOS 26.5") is False
    assert c.os_matches("Android 13", None) is None


def test_ios_language_is_launch_arguments():
    assert c.apple_locale("sw-KE") == ["-AppleLanguages", "(sw)", "-AppleLocale", "sw_KE"]


def test_the_scenario_format_carries_conditions_both_ways():
    text = "## Pay\nConditions: os=Android 13; locale=sw-KE; text_size=larger; account=A subscribed user\n1. The plan shows Premium\n2. Paying works\n"
    s = sf.parse_scenarios(text)[0]
    assert s.conditions == {"os": "Android 13", "locale": "sw-KE", "text_size": "larger", "account": "A subscribed user"}
    assert "Conditions: os=Android 13; locale=sw-KE; text_size=larger; account=A subscribed user" in sf.render_scenario(s)
    assert sf.to_row(s)["conditions"] == s.conditions
    assert sf.from_row({"name": "Pay", "criteria": ["a", "b"], "conditions": {"network": "offline"}}).conditions == {"network": "offline"}
    assert sf.format_conditions({"setup": "Fetch one; then sign in"}) == "setup=Fetch one, then sign in"


class FakeAndroid:
    serial, app_id = "emulator-5554", "com.x"


def test_android_sets_what_it_can_says_what_it_cannot_and_puts_each_back(monkeypatch, tmp_path):
    monkeypatch.setattr(c, "LEDGER_DIR", tmp_path)
    calls: list[list[str]] = []
    answers = {"ro.build.version.release": "16", "ro.build.version.sdk": "36", "font_scale": "1.0", "night": "Night mode: no"}

    async def run(cmd):
        calls.append(cmd)
        if cmd[-1] in answers and cmd[-2] in ("getprop", "system", "uimode") and "put" not in cmd:
            return 0, answers[cmd[-1]]
        return 0, ""

    monkeypatch.setattr(c, "_run", run)

    async def go():
        a = await c.apply(FakeAndroid(), "android", {"os": "13", "locale": "sw-KE", "text_size": "larger", "appearance": "dark",
                                                     "network": "offline", "account": "A subscribed user"})
        text = a.text()
        assert "conditions NOT met: the case needs 13, this device runs Android 16" in text
        assert "the account: A subscribed user" in text and "com.x runs in sw-KE" in text
        ledger = tmp_path / "emulator-5554.json"
        assert ledger.is_file()  # kept on disk while the run goes
        assert "set: text size larger (font scale 1.3)" in a.log_items() and any(x.startswith("not met:") for x in a.log_items())
        calls.clear()
        said = await c.restore(a)
        assert said[0] == "mobile data back on" and "font scale back to 1.0" in said
        assert not ledger.exists()  # put back: nothing left for the next run
        assert await c.restore(a) == []  # twice is harmless
        return calls

    undone = asyncio.run(go())
    assert ["adb", "-s", "emulator-5554", "shell", "settings", "put", "system", "font_scale", "1.0"] in undone
    assert ["adb", "-s", "emulator-5554", "shell", "cmd", "uimode", "night", "no"] in undone
    assert ["adb", "-s", "emulator-5554", "shell", "svc", "wifi", "enable"] in undone


def test_nothing_asked_changes_nothing():
    assert asyncio.run(c.apply(object(), "ios", {})).text() == ""


def test_a_crashed_runs_changes_are_put_back_before_the_next_run(monkeypatch, tmp_path):
    monkeypatch.setattr(c, "LEDGER_DIR", tmp_path)
    calls: list[list[str]] = []

    async def run(cmd):
        calls.append(cmd)
        return 0, "1.0" if cmd[-1] == "font_scale" else "Night mode: no" if cmd[-1] == "night" else "16" if "getprop" in cmd else ""

    monkeypatch.setattr(c, "_run", run)

    async def go():
        await c.apply(FakeAndroid(), "android", {"text_size": "largest", "appearance": "dark"})  # the run dies here: no restore
        calls.clear()
        said, items = await c.recover(FakeAndroid(), "android")
        again, _ = await c.recover(FakeAndroid(), "android")
        return said, again, items

    said, again, items = asyncio.run(go())
    assert said == "conditions: put back 2 settings an earlier run left on this device" and again is None
    assert items == ["night mode back to no", "font scale back to 1.0"]
    assert ["adb", "-s", "emulator-5554", "shell", "settings", "put", "system", "font_scale", "1.0"] in calls
    assert ["adb", "-s", "emulator-5554", "shell", "cmd", "uimode", "night", "no"] in calls
    assert not list(tmp_path.iterdir())


def test_a_ledger_only_ever_runs_device_tools(monkeypatch, tmp_path):
    monkeypatch.setattr(c, "LEDGER_DIR", tmp_path)
    (tmp_path / "emulator-5554.json").write_text('{"commands": [["rm", "-rf", "/"], ["adb", "-s", "emulator-5554", "shell", "true"]]}')
    ran: list[list[str]] = []

    async def run(cmd):
        ran.append(cmd)
        return 0, ""

    monkeypatch.setattr(c, "_run", run)
    asyncio.run(c.recover(FakeAndroid(), "android"))
    assert ran == [["adb", "-s", "emulator-5554", "shell", "true"]]


def test_the_run_log_shows_what_conditions_did():
    from portal_backend import qa_run_log as rl

    assert rl.step_words("note", {"conditions": "set", "title": "Set the run's conditions on the device"}, "") == "Set the run's conditions on the device"
    assert rl.step_words("note", {"title": "A thought"}, "") == "Noted: A thought"


def test_a_session_logs_setting_its_conditions_and_putting_them_back(monkeypatch, tmp_path):
    """Through the real tool server: the run's log gets one line when the conditions are set and
    one when the device is put back, each with every item, so a person can check both happened."""
    from orcha_cli.qa.mcp_server import QATools
    from test_qa_mcp import HOME, Clock
    from test_qa_mcp_fakes import FakeDevice, FakePortal, Identity, opener

    monkeypatch.setattr(c, "LEDGER_DIR", tmp_path)
    settings = {"content_size": "large", "appearance": "light"}

    async def run(cmd):
        if cmd[:3] == ["xcrun", "simctl", "ui"]:
            if len(cmd) == 5:
                return 0, settings[cmd[4]]
            settings[cmd[4]] = cmd[5]
        return 0, ""

    monkeypatch.setattr(c, "_run", run)
    portal, device = FakePortal(), FakeDevice([HOME, HOME, HOME])
    tools = QATools(identity=Identity(), portal=portal, device_opener=opener(device, []), clock=Clock())

    async def go():
        out = await tools.start_session("ios", "check", task_id="task-1",
                                        conditions={"text_size": "largest", "appearance": "dark", "account": "A subscribed user"})
        assert "conditions: text size largest" in out and "the account: A subscribed user" in out
        assert settings == {"content_size": "accessibility-extra-extra-large", "appearance": "dark"}
        ended = await tools.end_session("done")
        assert "ended" in ended, ended

    asyncio.run(go())
    assert settings == {"content_size": "large", "appearance": "light"}  # put back
    notes = [s for s in portal.steps.values() if s["kind"] == "note" and s["args"].get("conditions")]
    assert [n["args"]["conditions"] for n in notes] == ["set", "restored"]
    assert "set: dark appearance" in notes[0]["args"]["items"] and "agent sets up: the account: A subscribed user" in notes[0]["args"]["items"]
    assert notes[1]["args"]["items"] == ["appearance back to light", "text size back to large"]
    assert not list(tmp_path.iterdir())


def test_a_physical_phone_refuses_what_it_cannot_take(monkeypatch, tmp_path):
    monkeypatch.setattr(c, "LEDGER_DIR", tmp_path)

    async def run(cmd):
        return 0, "16" if "getprop" in cmd else ""

    monkeypatch.setattr(c, "_run", run)
    phone = SimpleNamespace(phone={"os": "iOS 26.6.1"}, udid="00008150-00167C982240401C", launch_args=[])
    a = asyncio.run(c.apply(phone, "ios", {"locale": "fr-FR", "text_size": "larger", "network": "offline", "account": "A subscribed user"}))
    assert a.lines == ["the app opens in fr-FR (launch arguments)"] and phone.launch_args[:2] == ["-AppleLanguages", "(fr)"]
    assert "text size cannot be set on a physical phone: pick a simulator or an emulator for it" in a.unmet
    assert "network cannot be set on a physical phone: pick a simulator or an emulator for it" in a.unmet
    assert a.agent == ["the account: A subscribed user"]  # the agent still sets the account up
    android_phone = SimpleNamespace(serial="R58M", app_id="com.x")
    b = asyncio.run(c.apply(android_phone, "android", {"text_size": "larger", "timezone": "Africa/Nairobi"}))
    assert any(x.startswith("text size larger") for x in b.lines)  # adb sets it on an Android phone
    assert "timezone cannot be set on a physical phone: pick a simulator or an emulator for it" in b.unmet


def test_a_language_the_app_has_no_translation_for_is_not_met(monkeypatch, tmp_path):
    monkeypatch.setattr(c, "LEDGER_DIR", tmp_path)
    bundle = tmp_path / "App.app"
    (bundle / "en.lproj").mkdir(parents=True)
    (bundle / "sw.lproj").mkdir()
    (bundle / "Base.lproj").mkdir()

    async def run(cmd):
        return (0, str(bundle)) if "get_app_container" in cmd else (0, "")

    monkeypatch.setattr(c, "_run", run)
    sim = SimpleNamespace(udid="SIM", runtime="iOS 26.5", app_id="com.x", client=SimpleNamespace(launch_args=[]))
    a = asyncio.run(c.apply(sim, "ios", {"locale": "fr-FR"}))
    assert a.unmet == ["the app has no fr-FR translation (it has en, sw), so it would show its default language"]
    b = asyncio.run(c.apply(sim, "ios", {"locale": "sw-KE"}))
    assert b.lines == ["the app opens in sw-KE (launch arguments)"] and not b.unmet
