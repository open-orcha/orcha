"""What the QA onboarding reads beside its row: the sign-in and sandbox scans on the We found
sheet, the device list (booted simulators and attached Android devices, read the way a session
finds them), a session's newest steps, the picked device reaching the agent's task, and a first
run that streams before its first verdict."""
import asyncio
import json
import subprocess
import time

import pytest

from conftest import BACKEND, run_task_id
from orcha_cli.qa.device import android_u2, ios_idb, listing, locks
from orcha_cli.qa.onboarding import auth_scan, found, sandbox_scan
from portal_backend import qa_onboarding as qo


def write(root, files):
    for rel, text in files.items():
        p = root / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(text)


# ---------------------------------------------------------------- the sign-in scan

def test_auth_scan_names_the_apps_own_sign_in(tmp_path):
    write(tmp_path, {"src/screens/Login.tsx": "signInWithEmailAndPassword(auth, email, password)\n"})
    got = auth_scan.detect(tmp_path)
    assert got["methods"] == ["email_password"]
    assert got["sure"] is True
    assert got["summary"] == "We found email login in your code."


def test_a_local_signin_component_is_not_clerk(tmp_path):
    write(tmp_path, {"src/App.tsx": 'import { SignIn } from "./pages/SignIn";\n<SignIn onIn={setUser} />\n', "src/pages/SignIn.tsx": '<input type="password" />\n'})
    assert "Clerk" not in auth_scan.detect(tmp_path)["summary"]


def test_auth_scan_ignores_tests_and_tooling(tmp_path):
    write(tmp_path, {"e2e/login.spec.ts": "signInWithEmailAndPassword(a, b, c)\n", "scripts/seed.ts": "signInWithEmailAndPassword(a, b, c)\n"})
    assert auth_scan.detect(tmp_path)["methods"] == []


def test_auth_scan_is_unsure_with_too_many_methods(tmp_path):
    write(tmp_path, {"src/a.ts": "GoogleAuthProvider\nsignInWithPhoneNumber\n", "src/b.ts": "signInWithEmailAndPassword\nsignInWithOtp\n",
                     "src/c.ts": "'otpauth'\n"})
    got = auth_scan.detect(tmp_path)
    assert got["sure"] is False and got["preselect"] == []
    assert "picked none" in got["summary"]


# ---------------------------------------------------------------- the sandbox scan

def test_stripe_test_keys_are_ready_and_their_value_is_never_kept(tmp_path):
    write(tmp_path, {".env.local": "STRIPE_KEY=sk_test_abcdef123\n"})
    got = sandbox_scan.detect(tmp_path, [{"kind": "web", "app_id": "http://localhost:3000"}])
    assert got == {"web": {"payments": {"ready": True, "evidence": "Stripe test keys in .env.local"}}}
    assert "abcdef" not in json.dumps(got)


def test_a_live_stripe_key_is_reported_never_a_sandbox(tmp_path):
    write(tmp_path, {".env": "STRIPE_KEY=sk_live_abcdef123\n"})
    got = sandbox_scan.detect(tmp_path, [{"kind": "web"}])
    assert got["web"]["payments"] == {"ready": None, "evidence": "live Stripe keys in .env, no test keys"}


def test_purchases_are_never_ready_from_the_repository(tmp_path):
    write(tmp_path, {"App/Products.storekit": "{}", "App.xcodeproj/xcshareddata/xcschemes/App.xcscheme": "<StoreKitConfigurationFileReference/>"})
    got = sandbox_scan.detect(tmp_path, [{"kind": "ios"}, {"kind": "android"}])
    assert got["ios"]["purchases"]["ready"] is None
    assert "App scheme" in got["ios"]["purchases"]["evidence"]
    assert "android" not in got


def test_a_mail_sink_is_ready_only_where_the_app_runs_locally(tmp_path):
    write(tmp_path, {".env": "MAIL_HOST=mailpit\n"})
    got = sandbox_scan.detect(tmp_path, [{"kind": "web", "app_id": "http://localhost:3000"}, {"kind": "ios"}])
    assert got["web"]["email"]["ready"] is True
    assert got["ios"]["email"]["ready"] is None and got["ios"]["email"]["evidence"].endswith("for local runs only")


def test_found_sheet_carries_auth_and_sandboxes(tmp_path):
    write(tmp_path, {"package.json": json.dumps({"name": "shop", "dependencies": {"next": "14", "react-dom": "18"}, "scripts": {"dev": "next dev"}}),
                     "app/page.tsx": "export default function P() { return null; }\n",
                     "app/login/page.tsx": "signInWithEmailAndPassword(auth, e, p)\n", ".env.local": "KEY=pk_test_abc\n"})
    sheet = found.read_folder(tmp_path)
    assert sheet["auth"]["summary"] == "We found email login in your code."
    assert sheet["sandboxes"]["web"]["payments"]["ready"] is True


def test_found_sheet_leaves_out_what_it_did_not_see(tmp_path):
    write(tmp_path, {"README.md": "Nothing here\n"})
    sheet = found.read_folder(tmp_path)
    assert "auth" not in sheet and "sandboxes" not in sheet


# ---------------------------------------------------------------- the device list

BOOTED = {"devices": {"com.apple.CoreSimulator.SimRuntime.iOS-26-5": [
    {"udid": "U1", "name": "iPhone 17 Pro", "state": "Booted", "deviceTypeIdentifier": "x"},
    {"udid": "U2", "name": "iPad Pro 13-inch (M5)", "state": "Shutdown"},
]}}


def test_lists_only_what_is_booted_and_attached(monkeypatch, tmp_path):
    monkeypatch.setattr(locks, "LOCK_ROOT", tmp_path)
    (tmp_path / "claude-sim-lock-R58M").mkdir()
    def run(cmd, **_):
        if cmd[0] == "xcrun":
            assert cmd[:4] == ["xcrun", "simctl", "list", "devices"] and "create" not in cmd and "boot" not in cmd
            return subprocess.CompletedProcess(cmd, 0, json.dumps(BOOTED), "")
        return subprocess.CompletedProcess(cmd, 0, "List of devices attached\nemulator-5554\tdevice\nR58M\tdevice\n192.168.1.9:5555\tdevice\nX1\tunauthorized\n", "")
    monkeypatch.setattr(subprocess, "run", run)
    monkeypatch.setattr(android_u2, "avd_name", lambda s: {"emulator-5554": "Pixel_9_Pro"}.get(s))
    assert listing.available() == [
        {"kind": "ios", "name": "iPhone 17 Pro", "udid": "U1", "runtime": "iOS 26.5", "state": "booted", "held_by": None},
        {"kind": "android", "name": "Pixel_9_Pro", "serial": "emulator-5554", "state": "device", "held_by": None},
        {"kind": "android", "name": "R58M", "serial": "R58M", "state": "device", "physical": True, "connection": "usb",
         "held_by": {"device": "R58M", "since": pytest.approx(time.time(), abs=60)}},
        {"kind": "android", "name": "192.168.1.9:5555", "serial": "192.168.1.9:5555", "state": "device", "physical": True, "connection": "network", "held_by": None},
    ]


def test_a_missing_tool_lists_nothing(monkeypatch):
    def boom(*_a, **_k):
        raise FileNotFoundError("xcrun")
    monkeypatch.setattr(ios_idb, "booted_simulators", boom)
    monkeypatch.setattr(android_u2, "adb_devices", lambda: [])
    assert listing.available() == []


@pytest.mark.parametrize("error", [subprocess.TimeoutExpired("xcrun", 5), subprocess.CalledProcessError(1, "xcrun"), ValueError("bad json")])
def test_a_failing_simctl_lists_nothing(monkeypatch, error):
    def boom():
        raise error
    monkeypatch.setattr(ios_idb, "booted_simulators", boom)
    assert listing.ios_devices() == []


async def test_devices_route(client, container, monkeypatch):
    rows = [{"kind": "ios", "name": "iPhone 17 Pro", "udid": "U1", "runtime": "iOS 26.5", "state": "booted"}]
    monkeypatch.setattr(listing, "available", lambda: rows)
    res = await client.get(f"/api/containers/{container['id']}/qa/devices")
    assert res.status_code == 200
    assert res.json() == {"devices": rows, "available": True}


async def test_devices_route_on_a_portal_without_the_cli(client, container, monkeypatch):
    real = qo.importlib.import_module

    def missing(name, *a):
        if name == "orcha_cli.qa.device.listing":
            raise ImportError(name)
        return real(name, *a)
    monkeypatch.setattr(qo.importlib, "import_module", missing)
    res = await client.get(f"/api/containers/{container['id']}/qa/devices")
    assert res.json() == {"devices": [], "available": False}


async def test_devices_route_needs_a_known_project(client):
    res = await client.get("/api/containers/00000000-0000-0000-0000-000000000000/qa/devices")
    assert res.status_code == 404


# ---------------------------------------------------------------- the task says the device

def test_the_task_tells_the_agent_which_device():
    row = {"found": {"platforms": [{"kind": "ios", "app_id": "com.acme"}]}, "options": {}}
    _, body, _ = qo._task_texts("live", row, {"platform": "ios", "device": {"kind": "ios", "name": "iPhone 17 Pro"}})
    assert 'Device: pass device="iPhone 17 Pro" to start_session.' in body
    _, body, _ = qo._task_texts("first_run", row, {"platform": "ios", "scenario_id": "s1", "device": {"kind": "web", "viewport": "mobile"}})
    assert 'device="mobile"' in body


def test_the_smoke_set_is_named_in_the_task_and_is_the_riskiest_few():
    row = {"found": {"platforms": [{"kind": "ios", "app_id": "com.acme"}]}, "options": {}}
    _, body, _ = qo._task_texts("first_run", row, {"platform": "ios", "scenario_ids": ["s1", "s2"]})
    assert "Check these scenarios, riskiest first: s1, s2." in body
    risky = {"id": "a", "platform": "ios", "risk": {"score": 9}, "scenarios": [{"id": f"a{i}", "status": "draft", "name": f"a{i}"} for i in range(3)]}
    calm = [{"id": f"s{i}", "platform": "ios", "risk": {"score": 1}, "scenarios": [{"id": f"c{i}", "status": "draft", "name": "c"}]} for i in range(12)]
    other = {"id": "b", "platform": "android", "risk": {"score": 10}, "scenarios": [{"id": "b0", "status": "validated", "name": "b"}]}
    ids = qo._smoke_ids(None, "cid", [risky, *calm, other], "ios")
    assert len(ids) == qo.SMOKE_SIZE and ids[0] == "a0" and "a1" not in ids and "b0" not in ids


def test_the_saved_target_wins_over_what_the_scan_guessed():
    row = {"found": {"platforms": [{"kind": "web", "app_id": "http://localhost:5173"}]}, "options": {}}
    _, body, _ = qo._task_texts("live", row, {"platform": "web"}, {"web": "http://127.0.0.1:5181/"})
    assert "http://127.0.0.1:5181/" in body and "5173" not in body
    assert "http://localhost:5173" in qo._task_texts("live", row, {"platform": "web"})[1]


def test_gaps_are_named_by_the_key_the_tag_takes():
    row = {"found": {"platforms": [{"kind": "web"}]}, "options": {}}
    _, body, _ = qo._task_texts("bring_in", row, {"platform": "web", "gap_screen_ids": ["screen:web:/cart", "screen:web:/books/*"]})
    assert "/cart, /books/*." in body and "screen:web:" not in body


def test_each_ui_test_is_a_flow_with_steps_in_the_order_it_names_them():
    Test = type("T", (), {})
    t, lost = Test(), Test()
    t.path, t.name, t.line, t.framework, t.body = "e2e/a.spec.ts", "buys", 3, "playwright", 'goto("/cart"); goto("/signin")'
    lost.path, lost.name, lost.line, lost.framework, lost.body = "e2e/b.spec.ts", "nothing", 1, "playwright", ""
    links = {"/signin": [{"path": "e2e/a.spec.ts", "name": "buys"}], "/cart": [{"path": "e2e/a.spec.ts", "name": "buys"}]}
    nodes, edges = qo.test_flows([t, lost], links)
    assert [n["label"] for n in nodes] == ["buys", "nothing"] and nodes[0]["detail"]["framework"] == "playwright"
    assert [(e["to_key"], e["detail"]["order"]) for e in edges] == [("/cart", 0), ("/signin", 1)]
    assert all(e["kind"] == "steps" and e["from_kind"] == "flow" for e in edges)


def test_no_pick_says_no_device_and_a_name_stays_one_line():
    row = {"found": {"platforms": [{"kind": "ios"}]}, "options": {}}
    assert "Device:" not in qo._task_texts("live", row, {"platform": "ios"})[1]
    _, body, _ = qo._task_texts("live", row, {"platform": "ios", "device": {"name": "A\nB   C" + "x" * 300}})
    line = next(ln for ln in body.splitlines() if "Device:" in ln)
    assert 'device="A B C' in line and len(line) < 700


# ---------------------------------------------------------------- the portal, end to end

async def test_latest_steps_are_the_newest_first_in_a_long_session(client, container, make_agent):
    bot = (await make_agent("qa-bot"))["agent_id"]
    cid = container["id"]
    r = await client.post(f"/api/containers/{cid}/qa/sessions", json={"actor_agent_id": bot, "kind": "map", "platform": "web", "task_id": await run_task_id(client, cid, bot)})
    assert r.status_code < 300, r.text
    sid = r.json()["id"]
    steps = [{"seq": i, "kind": "tap", "args": {"target": {"label": f"Step {i}"}}, "result": "ok", "at": "2026-11-05T10:00:00Z"} for i in range(1, 13)]
    r = await client.post(f"/api/qa/sessions/{sid}/steps", json={"actor_agent_id": bot, "steps": steps})
    assert r.status_code < 300, r.text
    got = (await client.get(f"/api/qa/sessions/{sid}/steps/latest")).json()["steps"]
    assert [s["seq"] for s in got] == [12, 11, 10, 9, 8, 7, 6, 5]
    assert [s["seq"] for s in (await client.get(f"/api/qa/sessions/{sid}/steps/latest?limit=2")).json()["steps"]] == [12, 11]
    assert (await client.get(f"/api/qa/sessions/{sid}/steps/latest?limit=0")).status_code == 422


async def test_latest_steps_of_an_unknown_session(client):
    r = await client.get("/api/qa/sessions/00000000-0000-0000-0000-000000000000/steps/latest")
    assert r.status_code == 404


async def test_confirm_keeps_the_build_path_typed_on_the_sheet(client, container, make_agent, tmp_path, monkeypatch):
    write(tmp_path, {"package.json": json.dumps({"name": "shop", "dependencies": {"next": "14", "react-dom": "18"}, "scripts": {"dev": "next dev -p 4100"}}),
                     "app/page.tsx": "export default function P() { return null; }\n"})
    monkeypatch.setenv("ORCHA_LOCAL_REPO_DIR", str(tmp_path))
    monkeypatch.setattr(qo, "POLL_S", 0.01)
    human = (await make_agent("Hussein", "owner", kind="human"))["agent_id"]
    cid = container["id"]
    url = f"/api/containers/{cid}/qa/onboarding"
    assert (await client.post(url, json={"actor_agent_id": human, "action": "start"})).status_code == 202
    for _ in range(500):
        if (await client.get(url)).json()["phases"]["found"]["state"] == "done":
            break
        await asyncio.sleep(0.02)
    r = await client.post(url, json={"actor_agent_id": human, "action": "confirm",
                                     "options": {"platforms": [{"kind": "web", "build_path": "/builds/web.zip"}]}})
    assert r.status_code == 202, r.text
    targets = (await client.get(f"/api/containers/{cid}/qa/targets")).json()["targets"]
    assert next(t for t in targets if t["platform"] == "web")["build_path"] == "/builds/web.zip"
