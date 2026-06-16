"""ISS-84 / #235 — the live-terminal bridge port must be PER-PROJECT.

Root cause (verified at file:line in the plan on task e4f59967): `BRIDGE_PORT = 8765`
is a module constant (terminal_bridge.py), so every project's bridge bound the SAME
127.0.0.1:8765 and the portal advertised a FIXED `ws://127.0.0.1:8765`
(templates/portal/main.py: TERMINAL_WS_URL). api_port + db_port were already chosen
per-project via `_find_free_port` and stored in orcha.json; the bridge port alone wasn't.
So a 2nd project's browser dialled the 1st project's bridge, which authorised the actor
against the WRONG container → ws close 4403 ("actor not human"). The fix closes that
asymmetry: a per-project `bridge_port` in orcha.json, injected into the portal compose env
as `ORCHA_TERMINAL_WS_URL`, read back by the bridge bind, and backfilled on `orcha upgrade`.

These are host-CLI unit tests only — no docker, no live API. The docker/file-tree side
effects (`_compose`, `ensure_daemon`, the terminal-bridge spawn, portal readiness, the
container/human API POSTs) are stubbed so we assert purely on orcha.json + the rendered
compose + the bridge's port resolution.
"""
import argparse
import json
import pathlib

from orcha_cli import __main__ as cli  # noqa: E402  (conftest puts orcha-cli on sys.path)
from orcha_cli import terminal_bridge as tb


# --------------------------------------------------------------------------- helpers

def _init_namespace(**over) -> argparse.Namespace:
    """A full `orcha init` Namespace with the API/container path disabled
    (`no_container=True`) so the test never needs a live stack."""
    ns = dict(
        name="demo", api_port=None, db_port=None, bridge_port=None,
        force=False, reset_data=False, no_container=True, objective=None,
        as_user="tester",
    )
    ns.update(over)
    return argparse.Namespace(**ns)


def _stub_externals(monkeypatch):
    """Stub every docker / daemon / bridge side effect cmd_init + cmd_upgrade trigger."""
    monkeypatch.setattr(cli, "_compose", lambda *a, **k: None)
    monkeypatch.setattr(cli, "_copy_tree", lambda *a, **k: None)
    monkeypatch.setattr(cli, "ensure_daemon", lambda *a, **k: None)
    monkeypatch.setattr(cli, "_wait_for_portal", lambda *a, **k: None)
    # init/upgrade import ensure_bridge from the module object — patch it there.
    monkeypatch.setattr(tb, "ensure_bridge", lambda *a, **k: None)


def _compose_text(project_root: pathlib.Path) -> str:
    return (project_root / ".orcha" / "docker-compose.yml").read_text()


def _orcha_json(project_root: pathlib.Path) -> dict:
    return json.loads((project_root / ".claude" / "orcha.json").read_text())


def _make_existing_project(tmp_path: pathlib.Path, *, with_bridge_port=None) -> None:
    """Lay down a minimal EXISTING project (the two existence gates cmd_upgrade checks).
    `with_bridge_port=None` models a project created BEFORE the bridge_port field existed."""
    orcha = tmp_path / ".orcha"
    orcha.mkdir()
    (orcha / "docker-compose.yml").write_text("services: {}\n")
    claude = tmp_path / ".claude"
    claude.mkdir()
    cfg = {"project_name": "demo", "db_port": 5436, "api_port": 8003,
           "api_base_url": "http://localhost:8003"}
    if with_bridge_port is not None:
        cfg["bridge_port"] = with_bridge_port
    (claude / "orcha.json").write_text(json.dumps(cfg, indent=2) + "\n")


# --------------------------------------------------------------------------- init

def test_init_stores_bridge_port_and_injects_compose_env(tmp_path, monkeypatch):
    """`orcha init` writes a per-project bridge_port and renders the advertised ws URL."""
    _stub_externals(monkeypatch)
    monkeypatch.chdir(tmp_path)
    # Pin the chosen port so the assertion is deterministic (no free-port scan dependence).
    monkeypatch.setattr(cli, "_find_free_port", lambda start, span=100: start)

    cli.cmd_init(_init_namespace())

    cfg = _orcha_json(tmp_path)
    assert cfg["bridge_port"] == 8765            # scan-start, first project keeps 8765
    compose = _compose_text(tmp_path)
    assert "ORCHA_TERMINAL_WS_URL: ws://127.0.0.1:8765" in compose
    assert "{{ bridge_port }}" not in compose    # placeholder fully substituted


def test_init_honors_explicit_bridge_port_flag(tmp_path, monkeypatch):
    """`--bridge-port` overrides the free-port scan, mirroring --api-port/--db-port."""
    _stub_externals(monkeypatch)
    monkeypatch.chdir(tmp_path)
    monkeypatch.setattr(cli, "_find_free_port", lambda start, span=100: start)

    cli.cmd_init(_init_namespace(bridge_port=9999))

    assert _orcha_json(tmp_path)["bridge_port"] == 9999
    assert "ORCHA_TERMINAL_WS_URL: ws://127.0.0.1:9999" in _compose_text(tmp_path)


# --------------------------------------------------------------------------- two-project sim

def test_two_projects_resolve_distinct_bridge_ports(tmp_path, monkeypatch):
    """The crux of #235: two projects must NOT share one bridge port. Simulate the
    free-port scan honouring an already-bound 8765 (project A) so project B shifts to
    8766, then assert each project's bridge binds its OWN port (no cross-dial)."""
    _stub_externals(monkeypatch)
    # The scan returns the lowest port at/after `start` not already occupied. 8765 is free
    # initially, so project A claims it; once A's bridge owns it, project B shifts to 8766.
    taken = set()
    monkeypatch.setattr(
        cli, "_find_free_port",
        lambda start, span=100: next(p for p in range(start, start + span) if p not in taken))

    proj_a = tmp_path / "a"
    proj_a.mkdir()
    monkeypatch.chdir(proj_a)
    cli.cmd_init(_init_namespace(name="a"))
    port_a = _orcha_json(proj_a)["bridge_port"]
    taken.add(port_a)   # A's bridge now occupies its port

    proj_b = tmp_path / "b"
    proj_b.mkdir()
    monkeypatch.chdir(proj_b)
    cli.cmd_init(_init_namespace(name="b"))
    port_b = _orcha_json(proj_b)["bridge_port"]

    assert port_a == 8765 and port_b == 8766
    assert port_a != port_b
    # And each project advertises its OWN port to its browser — no cross-dial.
    assert f"ws://127.0.0.1:{port_a}" in _compose_text(proj_a)
    assert f"ws://127.0.0.1:{port_b}" in _compose_text(proj_b)


# --------------------------------------------------------------------------- bridge bind resolution

def _run_bridge_resolve(monkeypatch, tmp_path, *, args_port=None, cfg_bridge_port="unset"):
    """Drive cmd_terminal_bridge with serve_bridge stubbed; return the port it would bind."""
    claude = tmp_path / ".claude"
    claude.mkdir(exist_ok=True)
    cfg = {"api_base_url": "http://localhost:8003"}
    if cfg_bridge_port != "unset":
        cfg["bridge_port"] = cfg_bridge_port
    (claude / "orcha.json").write_text(json.dumps(cfg))
    monkeypatch.chdir(tmp_path)

    captured = {}

    def _fake_serve(api_base, cwd, host=None, port=None, quiet=False):
        captured["port"] = port
        captured["api_base"] = api_base

    monkeypatch.setattr(tb, "serve_bridge", _fake_serve)
    # serve_bridge is run via asyncio.run on a coroutine; our stub is sync, so wrap it.
    import asyncio
    monkeypatch.setattr(asyncio, "run", lambda coro: None)
    # Make the coroutine-less call work: cmd_terminal_bridge calls asyncio.run(serve_bridge(...)),
    # which evaluates serve_bridge(...) FIRST (capturing), then asyncio.run no-ops on the result.
    ns = argparse.Namespace(host=None, port=args_port, api_base=None, quiet=True, ensure=False)
    cli.cmd_terminal_bridge(ns)
    return captured.get("port")


def test_bridge_binds_per_project_port_from_config(tmp_path, monkeypatch):
    """The bridge reads bridge_port from orcha.json — the spawned `terminal-bridge` child
    (ensure_bridge passes no --port) thus binds the per-project port automatically."""
    assert _run_bridge_resolve(monkeypatch, tmp_path, cfg_bridge_port=8766) == 8766


def test_bridge_falls_back_to_8765_when_field_absent(tmp_path, monkeypatch):
    """Back-compat: an orcha.json predating bridge_port → the 8765 constant default."""
    assert _run_bridge_resolve(monkeypatch, tmp_path, cfg_bridge_port="unset") == tb.BRIDGE_PORT
    assert tb.BRIDGE_PORT == 8765


def test_bridge_explicit_port_flag_wins_over_config(tmp_path, monkeypatch):
    """An explicit --port still overrides the stored bridge_port (advanced/manual use)."""
    assert _run_bridge_resolve(monkeypatch, tmp_path, args_port=7000, cfg_bridge_port=8766) == 7000


# --------------------------------------------------------------------------- upgrade backfill

def test_upgrade_backfills_missing_bridge_port(tmp_path, monkeypatch):
    """An existing project with no bridge_port gets one backfilled + injected on upgrade."""
    _stub_externals(monkeypatch)
    _make_existing_project(tmp_path, with_bridge_port=None)
    monkeypatch.chdir(tmp_path)
    monkeypatch.setattr(cli, "_find_free_port", lambda start, span=100: start)

    cli.cmd_upgrade(argparse.Namespace())

    cfg = _orcha_json(tmp_path)
    assert cfg["bridge_port"] == 8765
    assert "ORCHA_TERMINAL_WS_URL: ws://127.0.0.1:8765" in _compose_text(tmp_path)
    assert "{{ bridge_port }}" not in _compose_text(tmp_path)


def test_upgrade_preserves_existing_bridge_port(tmp_path, monkeypatch):
    """Upgrade must NOT churn a bridge_port that's already set — no re-scan, value kept."""
    _stub_externals(monkeypatch)
    _make_existing_project(tmp_path, with_bridge_port=8770)
    monkeypatch.chdir(tmp_path)
    # If the scan were (wrongly) invoked, it'd return 8765 and this would fail.
    monkeypatch.setattr(cli, "_find_free_port", lambda start, span=100: 8765)

    cli.cmd_upgrade(argparse.Namespace())

    assert _orcha_json(tmp_path)["bridge_port"] == 8770
    assert "ORCHA_TERMINAL_WS_URL: ws://127.0.0.1:8770" in _compose_text(tmp_path)


# ------------------------------------------------------------------- P1: connect propagation
# Gate 2nd-pass gap: `orcha connect` wrote no bridge_port, so a connected client for a 2nd+
# project fell back to the fixed 8765 in cmd_terminal_bridge — reintroducing the very collision.
# Fix: connect resolves the REMOTE stack's advertised port via GET /api/terminal/config.

def test_resolve_bridge_port_parses_ws_url(monkeypatch):
    """_resolve_bridge_port extracts the port the portal advertises (per-project)."""
    monkeypatch.setattr(cli, "_get_json", lambda url, **k: {"ws_url": "ws://127.0.0.1:8766"})
    assert cli._resolve_bridge_port("http://localhost:8003") == 8766


def test_resolve_bridge_port_none_when_portal_unreachable(monkeypatch):
    """Best-effort: portal down (or portless URL) → None, so connect omits the field and the
    bridge keeps the 8765 back-compat fallback rather than crashing the connect."""
    monkeypatch.setattr(cli, "_get_json", lambda url, **k: None)
    assert cli._resolve_bridge_port("http://localhost:8003") is None
    monkeypatch.setattr(cli, "_get_json", lambda url, **k: {"ws_url": "ws://127.0.0.1"})
    assert cli._resolve_bridge_port("http://localhost:8003") is None


def test_connect_propagates_per_project_bridge_port(tmp_path, monkeypatch):
    """End-to-end of the P1 fix: connecting to a stack whose portal advertises 8766 writes
    bridge_port=8766 into the connected folder's orcha.json — so its `terminal-bridge --ensure`
    binds 8766, NOT the fixed 8765. This is the exact 2nd-project collision #235 closes."""
    monkeypatch.chdir(tmp_path)
    monkeypatch.setattr(cli, "_discover_stacks",
                        lambda: [{"project_short": "remote", "api_port": 8003, "db_port": 5436}])
    monkeypatch.setattr(cli, "_wait_for_portal", lambda *a, **k: None)
    monkeypatch.setattr(cli, "_install_orcha_skill_templates", lambda cwd: (["/orcha-x"], ["x"]))
    monkeypatch.setattr(cli, "_write_hook_config", lambda *a, **k: False)

    def _fake_get(url, **k):
        if url.endswith("/api/containers"):
            return {"containers": [{"id": "cid-1", "name": "Remote"}]}
        if url.endswith("/api/terminal/config"):
            return {"ws_url": "ws://127.0.0.1:8766"}   # remote stack's per-project port
        return None

    monkeypatch.setattr(cli, "_get_json", _fake_get)

    cli.cmd_connect(argparse.Namespace(project_name="remote", as_user=None))

    cfg = _orcha_json(tmp_path)
    assert cfg["connected"] is True
    assert cfg["bridge_port"] == 8766            # propagated from the portal, not 8765
    # And the connected folder's bridge would bind that port (no --port, reads orcha.json).
    assert _run_bridge_resolve(monkeypatch, tmp_path, cfg_bridge_port=8766) == 8766


# ------------------------------------------------------------------- P2: --no-bridge honored
# Gate 2nd-pass gap: cmd_update runs cmd_upgrade (Phase 1) BEFORE its --no-bridge Phase-3
# guard, and cmd_upgrade restarted the bridge unconditionally → --no-bridge was defeated.
# Fix: cmd_upgrade's bridge restart is gated on getattr(args, "no_bridge", False).

def _upgrade_recording_bridge(tmp_path, monkeypatch, ns):
    """Run cmd_upgrade with everything stubbed EXCEPT a recorder on the bridge restart;
    return the list of ensure_bridge calls (each a (args, kwargs) tuple)."""
    monkeypatch.setattr(cli, "_compose", lambda *a, **k: None)
    monkeypatch.setattr(cli, "_copy_tree", lambda *a, **k: None)
    monkeypatch.setattr(cli, "ensure_daemon", lambda *a, **k: None)
    monkeypatch.setattr(cli, "_install_orcha_skill_templates", lambda cwd: ([], []))
    monkeypatch.setattr(cli, "_write_hook_config", lambda *a, **k: False)
    _make_existing_project(tmp_path, with_bridge_port=8770)
    monkeypatch.chdir(tmp_path)
    calls = []
    monkeypatch.setattr(tb, "ensure_bridge", lambda *a, **k: calls.append((a, k)))
    cli.cmd_upgrade(ns)
    return calls


def test_upgrade_no_bridge_suppresses_bridge_restart(tmp_path, monkeypatch):
    """--no-bridge (forwarded from `orcha update --no-bridge`) suppresses the rebind so a
    headless host with no terminal panel isn't churned."""
    calls = _upgrade_recording_bridge(tmp_path, monkeypatch, argparse.Namespace(no_bridge=True))
    assert calls == []


def test_upgrade_default_still_restarts_bridge(tmp_path, monkeypatch):
    """Standalone `orcha upgrade` (no --no-bridge flag) still rebinds — the ISS-84 deploy
    path. getattr defaults to False, so the rebind fires."""
    calls = _upgrade_recording_bridge(tmp_path, monkeypatch, argparse.Namespace())
    assert len(calls) == 1
    assert calls[0][1].get("restart") is True
