"""Orcha QA identity, portal client and CLI wiring (`orcha_cli/qa/{config,portal,cli}.py`).

Identity: `.claude/orcha.json` found upwards from the cwd, the acting agent from `$ORCHA_ALIAS`
-> `.claude/orcha-tabs/<alias>.json` or the single binding, env overrides. The portal client is
exercised over real HTTP against an in-process stub. The CLI: `orcha qa` parses, `enable` /
`disable` call launch.py, `map build` tolerates a missing code map and posts the payload.
"""

from __future__ import annotations

import json
import pathlib
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer

import pytest

from orcha_cli.qa import cli as qa_cli
from orcha_cli.qa import config
from orcha_cli.qa.portal import PortalClient, PortalError


def _project(root: pathlib.Path, *, tabs: dict[str, str] | None = None, cfg: dict | None = None) -> pathlib.Path:
    (root / ".claude").mkdir(parents=True, exist_ok=True)
    (root / ".claude" / "orcha.json").write_text(json.dumps(cfg if cfg is not None else
                                                            {"api_base_url": "http://127.0.0.1:8123/", "current_container_id": "CID"}))
    for alias, aid in (tabs or {}).items():
        (root / ".claude" / "orcha-tabs").mkdir(exist_ok=True)
        (root / ".claude" / "orcha-tabs" / f"{alias}.json").write_text(json.dumps({"alias": alias, "agent_id": aid, "container_id": "CID"}))
    return root


# ---------- identity ----------


def test_identity_walks_up_and_uses_the_single_binding(tmp_path):
    root = _project(tmp_path, tabs={"forge": "AID-1"})
    deep = root / "a" / "b"
    deep.mkdir(parents=True)
    ident = config.resolve(deep, env={})
    assert ident.ok
    assert (ident.api_base, ident.container_id, ident.agent_id, ident.alias) == ("http://127.0.0.1:8123", "CID", "AID-1", "forge")


def test_identity_alias_picks_among_several_bindings(tmp_path):
    root = _project(tmp_path, tabs={"forge": "AID-1", "atlas": "AID-2"})
    assert config.resolve(root, env={"ORCHA_ALIAS": "atlas"}).agent_id == "AID-2"
    ident = config.resolve(root, env={})
    assert not ident.ok and any("several bindings" in p and "ORCHA_ALIAS" in p for p in ident.problems)
    missing = config.resolve(root, env={"ORCHA_ALIAS": "ghost"})
    assert not missing.ok and any("ghost" in p for p in missing.problems)


def test_identity_env_overrides_and_api_suffix(tmp_path):
    root = _project(tmp_path, tabs={"forge": "AID-1"})
    ident = config.resolve(root, env={"ORCHA_QA_API": "http://h:9/api/", "ORCHA_QA_CID": "C2", "ORCHA_QA_AGENT_ID": "A9"})
    assert (ident.api_base, ident.container_id, ident.agent_id) == ("http://h:9", "C2", "A9")
    assert ident.sources == {"api": "ORCHA_QA_API", "container": "ORCHA_QA_CID", "agent": "ORCHA_QA_AGENT_ID"}


def test_identity_container_falls_back_to_the_binding_and_reports_what_is_missing(tmp_path):
    root = _project(tmp_path, tabs={"forge": "AID-1"}, cfg={"api_base_url": "http://x"})
    assert config.resolve(root, env={}).container_id == "CID"
    empty = tmp_path / "elsewhere"
    empty.mkdir()
    ident = config.resolve(empty, env={})
    # a tmp dir has no orcha.json above it (unless the machine's home has one: then only check it never raises)
    if ident.orcha_json is None:
        assert not ident.ok and any("no portal" in p for p in ident.problems)


def test_identity_in_a_worktree_overlay(tmp_path):
    """A worker's cwd is a worktree carrying an overlay copy of .claude/orcha.json and orcha-tabs."""
    main = _project(tmp_path / "main", tabs={"atlas": "AID-MAIN", "forge": "AID-F"})
    wt = _project(main / ".orcha-worktrees" / "task-1", tabs={"atlas": "AID-WT", "forge": "AID-F"},
                  cfg={"api_base_url": "http://wt", "current_container_id": "CID-WT"})
    ident = config.resolve(wt, env={"ORCHA_ALIAS": "atlas"})
    assert (ident.api_base, ident.container_id, ident.agent_id) == ("http://wt", "CID-WT", "AID-WT")


# ---------- portal client over HTTP ----------


class _Stub(BaseHTTPRequestHandler):
    seen: list = []

    def log_message(self, *a):  # noqa: D401
        pass

    def _body(self):
        n = int(self.headers.get("Content-Length") or 0)
        return self.rfile.read(n) if n else b""

    def _send(self, code, payload):
        data = json.dumps(payload).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        _Stub.seen.append(("GET", self.path, None, None))
        if self.path.startswith("/api/containers/CID/qa/targets"):
            return self._send(200, {"targets": [{"platform": "ios", "app_id": "com.x"}]})
        if self.path == "/":
            return self._send(200, {})
        return self._send(404, {"detail": "nothing here"})

    def do_POST(self):
        raw = self._body()
        _Stub.seen.append(("POST", self.path, raw, self.headers.get("Content-Type")))
        if "/frames" in self.path:
            return self._send(200, {"frame_id": "F1"})
        if self.path.endswith("/scenarios"):
            return self._send(422, {"detail": [{"loc": ["body", "criteria"], "msg": "at least 2 items"}]})
        return self._send(200, {"ok": True})

    def do_PATCH(self):
        raw = self._body()
        _Stub.seen.append(("PATCH", self.path, raw, None))
        return self._send(409, {"detail": "a passed walk needs its last step reached"})


@pytest.fixture()
def stub():
    _Stub.seen = []
    srv = HTTPServer(("127.0.0.1", 0), _Stub)
    th = threading.Thread(target=srv.serve_forever, daemon=True)
    th.start()
    yield f"http://127.0.0.1:{srv.server_address[1]}"
    srv.shutdown()


def test_portal_client_over_http(stub):
    p = PortalClient(stub, "CID", "AID")
    assert p.ping()
    assert p.targets() == {"targets": [{"platform": "ios", "app_id": "com.x"}]}
    assert p.upload_frame("S1", b"\xff\xd8jpeg") == "F1"
    method, path, raw, ctype = _Stub.seen[-1]
    assert path == "/api/qa/sessions/S1/frames?actor_agent_id=AID" and raw == b"\xff\xd8jpeg" and ctype == "image/jpeg"
    p.post_steps("S1", [{"seq": 1, "kind": "screen"}])
    body = json.loads(_Stub.seen[-1][2])
    assert body == {"steps": [{"seq": 1, "kind": "screen"}], "actor_agent_id": "AID"}
    with pytest.raises(PortalError) as e:
        p.patch_walk("W1", {"outcome": "passed"})
    assert str(e.value) == "HTTP 409 on PATCH /api/qa/walks/W1: a passed walk needs its last step reached" and e.value.status == 409
    with pytest.raises(PortalError, match=r"HTTP 422 .*criteria: at least 2 items"):
        p.propose_scenario({"name": "x"})
    with pytest.raises(PortalError, match="HTTP 404"):
        p.get_map("ios")


def test_portal_client_unreachable_and_unconfigured():
    with pytest.raises(PortalError, match="portal unreachable"):
        PortalClient("http://127.0.0.1:9", "CID", "AID", timeout=1).targets()
    with pytest.raises(PortalError, match="no portal configured"):
        PortalClient("", "CID").targets()
    with pytest.raises(PortalError, match="no container configured"):
        PortalClient("http://x", "").targets()
    assert PortalClient("http://x", "C").upload_frame("S", b"") is None


# ---------- CLI ----------


def _parse(argv):
    from orcha_cli.__main__ import build_parser

    return build_parser().parse_args(argv)


def test_qa_subcommands_parse():
    a = _parse(["qa", "doctor", "--json"])
    assert a.qa_cmd == "doctor" and a.json and a.func is qa_cli.cmd_qa
    a = _parse(["qa", "map", "build", "--platform", "android", "--repo", "/tmp/app"])
    assert (a.qa_cmd, a.map_cmd, a.platform, a.repo) == ("map", "build", "android", "/tmp/app")
    a = _parse(["qa", "targets", "--platform", "ios", "--app-id", "com.x", "--device", "iPhone 17 Pro"])
    assert (a.app_id, a.device) == ("com.x", "iPhone 17 Pro")
    for cmd in ("mcp", "enable", "disable"):
        assert _parse(["qa", cmd]).qa_cmd == cmd
    assert _parse(["qa", "map", "build", "--platform", "web"]).platform == "web"
    with pytest.raises(SystemExit):
        _parse(["qa", "map", "build", "--platform", "desktop"])


def test_qa_cli_imports_nothing_heavy():
    import subprocess
    import sys

    code = ("import sys; import orcha_cli.__main__ as m; m.build_parser(); "
            "bad=[k for k in ('mcp','PIL','idb','uiautomator2','adbutils') if k in sys.modules]; print(bad)")
    out = subprocess.run([sys.executable, "-c", code], capture_output=True, text=True, check=True).stdout.strip()
    assert out == "[]"


def test_enable_and_disable(tmp_path, monkeypatch, capsys):
    from orcha_cli.qa import launch

    _project(tmp_path)
    monkeypatch.chdir(tmp_path)
    qa_cli.cmd_qa(_parse(["qa", "enable"]))
    out = capsys.readouterr().out
    path = tmp_path / ".orcha" / "qa" / "mcp.json"
    assert path.is_file() and str(path) in out and "next wake" in out
    assert launch.config_path(tmp_path) == path
    qa_cli.cmd_qa(_parse(["qa", "disable"]))
    assert not path.exists() and "off" in capsys.readouterr().out
    qa_cli.cmd_qa(_parse(["qa", "disable"]))
    assert "already off" in capsys.readouterr().out


def test_doctor_reports_qa_tools_state(tmp_path, monkeypatch):
    from orcha_cli.qa import launch

    _project(tmp_path, tabs={"forge": "AID"})
    monkeypatch.chdir(tmp_path)
    monkeypatch.setattr(qa_cli, "booted_simulators", lambda: ([{"name": "iPhone 17 Pro", "udid": "U", "runtime": "iOS-26-5"}], ""))
    monkeypatch.setattr(qa_cli, "adb_devices", lambda: ([], ""))
    monkeypatch.setattr(PortalClient, "ping", lambda self: False)
    checks = qa_cli.doctor_report(tmp_path)
    assert set(checks) >= {"python extra [qa]", "idb_companion", "xcrun simctl", "booted simulators", "adb", "adb devices",
                           "portal", "acting agent", "QA tools for agents"}
    assert checks["booted simulators"]["ok"] and "iPhone 17 Pro" in checks["booted simulators"]["detail"]
    assert not checks["adb devices"]["ok"]
    assert not checks["portal"]["ok"] and "not reachable" in checks["portal"]["detail"]
    assert checks["acting agent"]["ok"]
    assert not checks["QA tools for agents"]["ok"]
    launch.enable(tmp_path)
    assert qa_cli.doctor_report(tmp_path)["QA tools for agents"]["ok"]


def test_map_build_tolerates_a_missing_code_map(tmp_path, monkeypatch, capsys):
    import builtins

    real = builtins.__import__

    def no_codemap(name, globals=None, locals=None, fromlist=(), level=0):
        if name == "codemap" and level == 1 or name.endswith("qa.codemap"):
            raise ImportError("no codemap in this build")
        return real(name, globals, locals, fromlist, level)

    monkeypatch.setattr(builtins, "__import__", no_codemap)
    with pytest.raises(SystemExit) as e:
        qa_cli.cmd_qa(_parse(["qa", "map", "build", "--platform", "ios", "--repo", str(tmp_path)]))
    assert e.value.code == 1
    assert "code map reader is not available" in capsys.readouterr().err


def test_map_build_posts_the_payload(tmp_path, monkeypatch, capsys):
    import sys
    import types

    fake = types.ModuleType("orcha_cli.qa.codemap")
    fake.build_payload = lambda repo, platform: {"platform": platform, "source": "code", "nodes": [{"kind": "screen", "key": "Home"}], "edges": [], "features": []}
    fake.counts = lambda payload: {"screens": len(payload["nodes"])}
    monkeypatch.setitem(sys.modules, "orcha_cli.qa.codemap", fake)
    import orcha_cli.qa as qa_pkg

    monkeypatch.setattr(qa_pkg, "codemap", fake, raising=False)
    sent = []
    monkeypatch.setattr(PortalClient, "map_import", lambda self, payload: sent.append(payload) or {"created": 1})
    _project(tmp_path, tabs={"forge": "AID"})
    monkeypatch.chdir(tmp_path)
    qa_cli.cmd_qa(_parse(["qa", "map", "build", "--platform", "ios", "--repo", str(tmp_path)]))
    out = capsys.readouterr().out
    assert sent and sent[0]["nodes"][0]["key"] == "Home" and sent[0]["platform"] == "ios"
    assert "screens 1" in out and "imported" in out
    qa_cli.cmd_qa(_parse(["qa", "map", "build", "--platform", "ios", "--repo", str(tmp_path), "--dry-run"]))
    assert len(sent) == 1


def test_targets_lists_and_sets(tmp_path, monkeypatch, capsys):
    _project(tmp_path, tabs={"forge": "AID"})
    monkeypatch.chdir(tmp_path)
    monkeypatch.setattr(PortalClient, "targets", lambda self: {"targets": [{"platform": "ios", "app_id": "com.x", "device_name": None},
                                                                            {"platform": "android", "app_id": "com.y"}]})
    put = []
    monkeypatch.setattr(PortalClient, "put_target", lambda self, p, body: put.append((p, body)) or {"platform": p, **body})
    qa_cli.cmd_qa(_parse(["qa", "targets", "--platform", "android"]))
    out = capsys.readouterr().out
    assert "android: com.y" in out and "ios" not in out
    qa_cli.cmd_qa(_parse(["qa", "targets", "--platform", "ios", "--app-id", "com.z", "--device", "iPhone 17 Pro"]))
    assert put == [("ios", {"app_id": "com.z", "device_name": "iPhone 17 Pro"})]
    with pytest.raises(SystemExit):
        qa_cli.cmd_qa(_parse(["qa", "targets", "--app-id", "com.z"]))


def test_targets_for_the_web_check_url_and_viewport(tmp_path, monkeypatch, capsys):
    _project(tmp_path, tabs={"forge": "AID"})
    monkeypatch.chdir(tmp_path)
    put = []
    monkeypatch.setattr(PortalClient, "put_target", lambda self, p, body: put.append((p, body)) or {"platform": p, **body})
    for bad in (["--app-id", "shop.example.com"], ["--app-id", "https://shop.example.com", "--device", "tablet"]):
        with pytest.raises(SystemExit) as e:
            qa_cli.cmd_qa(_parse(["qa", "targets", "--platform", "web", *bad]))
        assert e.value.code == 2
    qa_cli.cmd_qa(_parse(["qa", "targets", "--platform", "web", "--app-id", "https://shop.example.com", "--device", "mobile",
                          "--notes", "Allowed: https://pay.example.com"]))
    assert put == [("web", {"app_id": "https://shop.example.com", "device_name": "mobile", "notes": "Allowed: https://pay.example.com"})]


def test_doctor_checks_playwright_and_chromium(monkeypatch):
    import importlib.util

    real = importlib.util.find_spec
    monkeypatch.setattr(importlib.util, "find_spec", lambda name, *a: None if name == "playwright" else real(name, *a))
    st = qa_cli.chromium_status()
    assert not st["ok"] and "playwright install chromium" in st["detail"]
    monkeypatch.setattr(importlib.util, "find_spec", real)
    monkeypatch.setattr(qa_cli, "_run", lambda cmd, timeout=10.0: (0, "/nowhere/chromium\n"))
    if real("playwright") is not None:
        st = qa_cli.chromium_status()
        assert not st["ok"] and "playwright install chromium" in st["detail"]
    monkeypatch.setattr(qa_cli, "_run", lambda cmd, timeout=10.0: (0, __file__ + "\n"))
    if real("playwright") is not None:
        assert qa_cli.chromium_status()["ok"]
