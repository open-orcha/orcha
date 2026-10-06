"""Agent runs on an API key (migration 071) — for users with no Claude/ChatGPT subscription.

  * migration 071: container_provider_keys.use_for_agents BOOLEAN NOT NULL DEFAULT false
  * routes: GET …/settings/provider-keys (+ llm-key) report it; PUT …/{provider}/agent-use sets it
    (strict body, human-gated, anthropic/openai only, needs a stored key); all in /openapi.json
  * wake-scan: the opted-in key rides SEALED to the header-less daemon lane only (agent_keys_enc)
  * daemon: the key is opened in memory and put ONLY into the agent child env —
      Claude → ANTHROPIC_API_KEY (CLAUDE_CODE_OAUTH_TOKEN / ANTHROPIC_AUTH_TOKEN dropped)
      Codex  → CODEX_API_KEY + OPENAI_API_KEY (CODEX_ACCESS_TOKEN dropped)
    off → env untouched; never in argv / repr / daemon os.environ / logs; sandbox forwards it.
  * codex metering: `turn.completed` usage → the Claude token fields; cost estimated server-side.
"""
import json
import os
import pathlib
import sys

import pytest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent / "orcha-cli"))
from orcha_cli import notifier, notifier_agent_keys, notifier_headless, sandbox, secret_box  # noqa: E402

MASTER = "agent-keys-master-key-0123456789"
ANTH_KEY = "sk-ant-api03-AGENTRUN-KEY-7777"
OPENAI_KEY = "sk-proj-AGENTRUN-OPENAI-KEY-8888"


@pytest.fixture(autouse=True)
def _reset_agent_keys():
    notifier_agent_keys.reset()
    yield
    notifier_agent_keys.reset()


async def _human(make_agent):
    return (await make_agent("Operator", kind="human"))["agent_id"]


def _by_provider(payload):
    return {k["provider"]: k for k in payload["keys"]}


# =============================================================================================
# migration 071
# =============================================================================================

def test_migration_adds_use_for_agents_default_false(db):
    cols = db.execute(
        "SELECT data_type, is_nullable, column_default FROM information_schema.columns "
        "WHERE table_name='container_provider_keys' AND column_name='use_for_agents'"
    )
    assert cols, "migration 071 must add container_provider_keys.use_for_agents"
    assert cols[0]["data_type"] == "boolean"
    assert cols[0]["is_nullable"] == "NO"
    assert cols[0]["column_default"] == "false"


def test_migration_is_idempotent(db):
    sql = (pathlib.Path(__file__).resolve().parent.parent / "orcha-cli" / "orcha_cli" / "templates"
           / "migrations" / "071_provider_key_agent_use.sql").read_text()
    db.execute(sql)  # re-applying must not fail
    db.execute(sql)


# =============================================================================================
# routes
# =============================================================================================

async def test_list_reports_agent_fields_default_off(client, container, monkeypatch):
    monkeypatch.delenv("ORCHA_LLM_API_KEY", raising=False)
    by = _by_provider((await client.get(f"/api/containers/{container['id']}/settings/provider-keys")).json())
    assert by["anthropic"]["agent_runtime"] == "claude" and by["anthropic"]["use_for_agents"] is False
    assert by["openai"]["agent_runtime"] == "codex" and by["openai"]["agent_only"] is True
    assert by["openai"]["stored"] is False
    assert by["xai"]["agent_runtime"] is None and by["xai"]["use_for_agents"] is False


async def test_openai_agent_only_slot_store_toggle_replace_delete(client, container, make_agent, monkeypatch, db):
    monkeypatch.setenv("ORCHA_SECRET_KEY", MASTER)
    # the helpers' env override never applies to the agent-only OpenAI slot
    monkeypatch.setenv("ORCHA_LLM_API_KEY", "sk-env-override-0000")
    cid = container["id"]
    hid = await _human(make_agent)
    r = await client.put(f"/api/containers/{cid}/settings/provider-keys/openai",
                         json={"actor_agent_id": hid, "api_key": OPENAI_KEY})
    assert r.status_code == 200, r.text
    assert r.json()["masked"] == "sk-...8888"
    by = _by_provider((await client.get(f"/api/containers/{cid}/settings/provider-keys")).json())
    assert by["openai"]["source"] == "db" and by["openai"]["stored"] is True
    assert by["openai"]["use_for_agents"] is False

    r = await client.put(f"/api/containers/{cid}/settings/provider-keys/openai/agent-use",
                         json={"actor_agent_id": hid, "use_for_agents": True})
    assert r.status_code == 200, r.text
    assert r.json() == {"provider": "openai", "use_for_agents": True, "agent_runtime": "codex"}
    by = _by_provider((await client.get(f"/api/containers/{cid}/settings/provider-keys")).json())
    assert by["openai"]["use_for_agents"] is True
    # audit-logged (the key itself never lands in the audit detail)
    ev = db.execute("SELECT detail FROM events WHERE event_type='llm_key_agent_use_set'")
    assert ev and ev[-1]["detail"] == {"provider": "openai", "use_for_agents": True}

    # replacing the key keeps the opt-in
    r = await client.put(f"/api/containers/{cid}/settings/provider-keys/openai",
                         json={"actor_agent_id": hid, "api_key": OPENAI_KEY + "X"})
    assert r.status_code == 200
    by = _by_provider((await client.get(f"/api/containers/{cid}/settings/provider-keys")).json())
    assert by["openai"]["use_for_agents"] is True

    # deleting the key drops it (and the opt-in with the row); DELETE never reports the env key
    r = await client.request("DELETE", f"/api/containers/{cid}/settings/provider-keys/openai",
                             json={"actor_agent_id": hid})
    assert r.status_code == 200
    assert r.json()["configured"] is False and r.json()["source"] is None
    by = _by_provider((await client.get(f"/api/containers/{cid}/settings/provider-keys")).json())
    assert by["openai"]["use_for_agents"] is False and by["openai"]["stored"] is False


async def test_anthropic_toggle_via_llm_key_route_state(client, container, make_agent, monkeypatch):
    monkeypatch.delenv("ORCHA_LLM_API_KEY", raising=False)
    monkeypatch.setenv("ORCHA_SECRET_KEY", MASTER)
    cid = container["id"]
    hid = await _human(make_agent)
    await client.put(f"/api/containers/{cid}/settings/llm-key", json={"actor_agent_id": hid, "api_key": ANTH_KEY})
    g = (await client.get(f"/api/containers/{cid}/settings/llm-key")).json()
    assert g["stored"] is True and g["use_for_agents"] is False and g["agent_runtime"] == "claude"
    r = await client.put(f"/api/containers/{cid}/settings/provider-keys/anthropic/agent-use",
                         json={"actor_agent_id": hid, "use_for_agents": True})
    assert r.status_code == 200, r.text
    g = (await client.get(f"/api/containers/{cid}/settings/llm-key")).json()
    assert g["use_for_agents"] is True
    assert ANTH_KEY not in json.dumps(g)
    r = await client.put(f"/api/containers/{cid}/settings/provider-keys/anthropic/agent-use",
                         json={"actor_agent_id": hid, "use_for_agents": False})
    assert r.json()["use_for_agents"] is False


async def test_agent_use_requires_a_stored_key(client, container, make_agent):
    hid = await _human(make_agent)
    r = await client.put(f"/api/containers/{container['id']}/settings/provider-keys/anthropic/agent-use",
                         json={"actor_agent_id": hid, "use_for_agents": True})
    assert r.status_code == 409, r.text


async def test_agent_use_only_for_anthropic_and_openai(client, container, make_agent):
    hid = await _human(make_agent)
    for provider in ("xai", "gemini", "nope"):
        r = await client.put(f"/api/containers/{container['id']}/settings/provider-keys/{provider}/agent-use",
                             json={"actor_agent_id": hid, "use_for_agents": True})
        assert r.status_code == 400, (provider, r.text)


async def test_agent_use_is_human_gated(client, container, make_agent, monkeypatch):
    monkeypatch.setenv("ORCHA_SECRET_KEY", MASTER)
    cid = container["id"]
    hid = await _human(make_agent)
    ai = (await make_agent("Bot", kind="ai"))["agent_id"]
    await client.put(f"/api/containers/{cid}/settings/provider-keys/openai",
                     json={"actor_agent_id": hid, "api_key": OPENAI_KEY})
    r = await client.put(f"/api/containers/{cid}/settings/provider-keys/openai/agent-use",
                         json={"actor_agent_id": ai, "use_for_agents": True})
    assert r.status_code == 403, r.text


async def test_agent_use_body_is_strict(client, container, make_agent):
    hid = await _human(make_agent)
    url = f"/api/containers/{container['id']}/settings/provider-keys/openai/agent-use"
    for body in (
        {"actor_agent_id": hid, "use_for_agents": "true"},   # a string is not a bool
        {"actor_agent_id": hid, "use_for_agents": 1},        # nor an int
        {"actor_agent_id": hid},                              # required
        {"actor_agent_id": hid, "use_for_agents": True, "extra": 1},  # extra fields forbidden
    ):
        r = await client.put(url, json=body)
        assert r.status_code == 422, (body, r.text)


async def test_openapi_documents_agent_use(client):
    spec = (await client.get("/openapi.json")).json()
    path = spec["paths"]["/api/containers/{cid}/settings/provider-keys/{provider}/agent-use"]
    assert "put" in path
    schemas = spec["components"]["schemas"]
    body = schemas["ProviderKeyAgentUse"]
    assert set(body["required"]) == {"actor_agent_id", "use_for_agents"}
    assert body["properties"]["use_for_agents"]["type"] == "boolean"
    assert body.get("additionalProperties") is False
    status = schemas["ProviderKeyStatus"]["properties"]
    assert {"use_for_agents", "agent_runtime", "stored", "agent_only"} <= set(status)
    get = spec["paths"]["/api/containers/{cid}/settings/provider-keys"]["get"]
    ref = json.dumps(get["responses"]["200"])
    assert "ProviderKeyList" in ref


# =============================================================================================
# wake-scan: sealed, daemon lane only
# =============================================================================================

async def test_wake_scan_carries_sealed_agent_key_only_when_on(client, container, make_agent, monkeypatch):
    monkeypatch.setenv("ORCHA_SECRET_KEY", MASTER)
    monkeypatch.delenv("ORCHA_LLM_API_KEY", raising=False)
    cid = container["id"]
    hid = await _human(make_agent)
    await client.put(f"/api/containers/{cid}/settings/provider-keys/openai",
                     json={"actor_agent_id": hid, "api_key": OPENAI_KEY})
    scan = (await client.get(f"/api/containers/{cid}/wake-scan")).json()
    assert scan["agent_keys_enc"] == {"claude": None, "codex": None}  # off → nothing

    await client.put(f"/api/containers/{cid}/settings/provider-keys/openai/agent-use",
                     json={"actor_agent_id": hid, "use_for_agents": True})
    scan = (await client.get(f"/api/containers/{cid}/wake-scan")).json()
    blob = scan["agent_keys_enc"]["codex"]
    assert blob and blob.startswith("v1:") and OPENAI_KEY not in json.dumps(scan)  # sealed on the wire
    assert secret_box.unseal(blob) == OPENAI_KEY
    assert scan["agent_keys_enc"]["claude"] is None


async def test_wake_scan_hides_agent_keys_from_browser(client, container, make_agent, monkeypatch):
    from portal_backend import wake_scan_routes as ws
    monkeypatch.setenv("ORCHA_PLAN", "team")
    monkeypatch.setenv("ORCHA_TRUST_PROXY_USER", "1")
    monkeypatch.setattr(ws, "agent_keys_enc", lambda cur, cid: {"claude": "SEALED", "codex": "SEALED"})
    cid = container["id"]
    octo = {"X-Auth-Request-User": "octocat"}
    await make_agent("root", "operator", kind="human")
    await client.get(f"/api/me?cid={cid}", headers=octo)
    daemon = (await client.get(f"/api/containers/{cid}/wake-scan")).json()
    assert daemon["agent_keys_enc"] == {"claude": "SEALED", "codex": "SEALED"}
    browser = (await client.get(f"/api/containers/{cid}/wake-scan", headers=octo)).json()
    assert browser["agent_keys_enc"] == {"claude": None, "codex": None}


# =============================================================================================
# daemon: env injection (headless + resident, host + sandbox), on/off, never leaked
# =============================================================================================

def _project(tmp_path, *, sandboxed=False, cid="CID-AGENTKEYS"):
    (tmp_path / ".claude").mkdir()
    cfg = {"api_base_url": "http://127.0.0.1:8000", "current_container_id": cid}
    if sandboxed:
        cfg["sandbox"] = {"enabled": True}
        (tmp_path / ".orcha").mkdir()
        (tmp_path / ".orcha" / "docker-compose.yml").write_text("name: orcha-proj\n")
    (tmp_path / ".claude" / "orcha.json").write_text(json.dumps(cfg))
    return tmp_path


def _seal(monkeypatch, key):
    monkeypatch.setenv("ORCHA_SECRET_KEY", MASTER)
    return secret_box.seal(key, env={"ORCHA_SECRET_KEY": MASTER})


class _Popen:
    calls: list = []

    def __init__(self, argv, **kw):
        _Popen.calls.append({"argv": list(argv), "env": dict(kw.get("env") or {})})
        self.pid = 4242


@pytest.fixture
def popen(monkeypatch):
    _Popen.calls = []
    monkeypatch.setattr(notifier.subprocess, "Popen", _Popen)
    monkeypatch.setattr(notifier, "_resolve_runtime_executable", lambda runtime: f"/usr/bin/{runtime}")
    monkeypatch.setitem(notifier_headless._CODEX_HOOK_TRUST_BYPASS, "/usr/bin/codex", False)
    return _Popen


def _host_env(monkeypatch):
    """A subscription-shaped daemon env: OAuth logins present, no API keys."""
    for k in ("ANTHROPIC_API_KEY", "OPENAI_API_KEY", "CODEX_API_KEY", "ORCHA_LLM_API_KEY"):
        monkeypatch.delenv(k, raising=False)
    monkeypatch.setenv("CLAUDE_CODE_OAUTH_TOKEN", "sk-ant-oat01-subscription")
    monkeypatch.setenv("ANTHROPIC_AUTH_TOKEN", "proxy-bearer")
    monkeypatch.setenv("CODEX_ACCESS_TOKEN", "chatgpt-access")


def test_claude_run_gets_api_key_and_drops_oauth_when_on(tmp_path, monkeypatch, popen, capsys):
    _host_env(monkeypatch)
    proj = _project(tmp_path)
    notifier._remember_agent_keys("CID-AGENTKEYS", {"agent_keys_enc": {"claude": _seal(monkeypatch, ANTH_KEY), "codex": None}})
    sent, repr_, proc = notifier.spawn_headless(str(proj), "do it", None, False, alias="Ada", runtime="claude")
    assert sent is True
    env = popen.calls[-1]["env"]
    assert env["ANTHROPIC_API_KEY"] == ANTH_KEY
    assert "CLAUDE_CODE_OAUTH_TOKEN" not in env and "ANTHROPIC_AUTH_TOKEN" not in env
    assert "CODEX_API_KEY" not in env
    # never in argv, the repr, the daemon's own env, or any output
    assert ANTH_KEY not in json.dumps(popen.calls[-1]["argv"]) and ANTH_KEY not in repr_
    assert os.environ.get("ANTHROPIC_API_KEY") != ANTH_KEY
    out = capsys.readouterr()
    assert ANTH_KEY not in out.out + out.err


def test_codex_run_gets_codex_and_openai_key_when_on(tmp_path, monkeypatch, popen):
    _host_env(monkeypatch)
    proj = _project(tmp_path)
    notifier._remember_agent_keys("CID-AGENTKEYS", {"agent_keys_enc": {"claude": None, "codex": _seal(monkeypatch, OPENAI_KEY)}})
    sent, repr_, _ = notifier.spawn_headless(str(proj), "do it", None, False, alias="Ada", runtime="codex")
    assert sent is True
    call = popen.calls[-1]
    assert call["argv"][:2] == ["/usr/bin/codex", "exec"]
    env = call["env"]
    assert env["CODEX_API_KEY"] == OPENAI_KEY and env["OPENAI_API_KEY"] == OPENAI_KEY
    assert "CODEX_ACCESS_TOKEN" not in env
    # the Claude subscription login is untouched on a Codex run
    assert env["CLAUDE_CODE_OAUTH_TOKEN"] == "sk-ant-oat01-subscription"
    assert OPENAI_KEY not in json.dumps(call["argv"]) and OPENAI_KEY not in repr_


def test_claude_on_does_not_touch_codex_runs_and_vice_versa(tmp_path, monkeypatch, popen):
    _host_env(monkeypatch)
    proj = _project(tmp_path)
    notifier._remember_agent_keys("CID-AGENTKEYS", {"agent_keys_enc": {"claude": _seal(monkeypatch, ANTH_KEY), "codex": None}})
    notifier.spawn_headless(str(proj), "x", None, False, runtime="codex")
    env = popen.calls[-1]["env"]
    assert "CODEX_API_KEY" not in env and env.get("CODEX_ACCESS_TOKEN") == "chatgpt-access"
    assert env.get("ANTHROPIC_API_KEY") is None


@pytest.mark.parametrize("runtime", ["claude", "codex"])
def test_off_leaves_env_exactly_as_before(tmp_path, monkeypatch, popen, runtime):
    _host_env(monkeypatch)
    proj = _project(tmp_path)
    # toggle off: the scan says no key for either runtime
    notifier._remember_agent_keys("CID-AGENTKEYS", {"agent_keys_enc": {"claude": None, "codex": None}})
    notifier.spawn_headless(str(proj), "x", None, False, runtime=runtime)
    off_env = popen.calls[-1]["env"]
    # an older portal that never mentions agent keys: identical env
    notifier_agent_keys.reset()
    notifier._remember_agent_keys("CID-AGENTKEYS", {"candidates": []})
    notifier.spawn_headless(str(proj), "x", None, False, runtime=runtime)
    assert popen.calls[-1]["env"] == off_env
    assert off_env["CLAUDE_CODE_OAUTH_TOKEN"] == "sk-ant-oat01-subscription"
    assert off_env["CODEX_ACCESS_TOKEN"] == "chatgpt-access"
    for k in ("ANTHROPIC_API_KEY", "OPENAI_API_KEY", "CODEX_API_KEY"):
        assert k not in off_env


def test_turning_off_stops_injection_on_next_scan(tmp_path, monkeypatch, popen):
    _host_env(monkeypatch)
    proj = _project(tmp_path)
    notifier._remember_agent_keys("CID-AGENTKEYS", {"agent_keys_enc": {"claude": _seal(monkeypatch, ANTH_KEY)}})
    notifier.spawn_headless(str(proj), "x", None, False, runtime="claude")
    assert popen.calls[-1]["env"]["ANTHROPIC_API_KEY"] == ANTH_KEY
    notifier._remember_agent_keys("CID-AGENTKEYS", {"agent_keys_enc": {"claude": None, "codex": None}})
    notifier.spawn_headless(str(proj), "x", None, False, runtime="claude")
    assert "ANTHROPIC_API_KEY" not in popen.calls[-1]["env"]


def test_unopenable_key_falls_back_silently_without_leaking(tmp_path, monkeypatch, popen, capsys):
    _host_env(monkeypatch)
    proj = _project(tmp_path)
    blob = _seal(monkeypatch, ANTH_KEY)
    monkeypatch.setenv("ORCHA_SECRET_KEY", "a-different-master-key-xxxxxxxx")  # rotated / wrong master
    notifier._remember_agent_keys("CID-AGENTKEYS", {"agent_keys_enc": {"claude": blob}})
    sent, _, _ = notifier.spawn_headless(str(proj), "x", None, False, runtime="claude")
    assert sent is True
    env = popen.calls[-1]["env"]
    assert "ANTHROPIC_API_KEY" not in env and env["CLAUDE_CODE_OAUTH_TOKEN"] == "sk-ant-oat01-subscription"
    out = capsys.readouterr()
    assert "could not be opened" in out.err
    assert ANTH_KEY not in out.out + out.err and blob not in out.out + out.err


def test_task_worktree_cwd_resolves_container_from_workspace_root(tmp_path, monkeypatch, popen):
    _host_env(monkeypatch)
    (tmp_path / "root").mkdir()
    root = _project(tmp_path / "root")
    wt = tmp_path / "wt"
    wt.mkdir()
    (wt / ".git").write_text(f"gitdir: {root}/.git/worktrees/wt\n")
    (root / ".git" / "worktrees" / "wt").mkdir(parents=True)
    # two containers remembered → resolution must come from the worktree's workspace root
    notifier._remember_agent_keys("OTHER-CID", {"agent_keys_enc": {"claude": None}})
    notifier._remember_agent_keys("CID-AGENTKEYS", {"agent_keys_enc": {"claude": _seal(monkeypatch, ANTH_KEY)}})
    notifier.spawn_headless(str(wt), "x", None, False, runtime="claude")
    assert popen.calls[-1]["env"]["ANTHROPIC_API_KEY"] == ANTH_KEY


def test_resident_claude_worker_gets_the_key(tmp_path, monkeypatch, popen):
    _host_env(monkeypatch)
    proj = _project(tmp_path)
    notifier._remember_agent_keys("CID-AGENTKEYS", {"agent_keys_enc": {"claude": _seal(monkeypatch, ANTH_KEY)}})
    sent, repr_, _ = notifier.spawn_resident(str(proj), alias="Ada", runtime="claude")
    assert sent is True
    env = popen.calls[-1]["env"]
    assert env["ANTHROPIC_API_KEY"] == ANTH_KEY and "CLAUDE_CODE_OAUTH_TOKEN" not in env
    assert ANTH_KEY not in repr_


@pytest.mark.parametrize("runtime,key,var", [("codex", OPENAI_KEY, "CODEX_API_KEY"),
                                             ("claude", ANTH_KEY, "ANTHROPIC_API_KEY")])
def test_sandboxed_run_forwards_injected_key_by_name_only(tmp_path, monkeypatch, popen, runtime, key, var):
    _host_env(monkeypatch)
    proj = _project(tmp_path, sandboxed=True)
    monkeypatch.setattr(sandbox, "preflight", lambda cfg, ws: None)
    monkeypatch.setattr(sandbox, "cap_defers_spawn", lambda cfg: None)
    monkeypatch.setattr(sandbox, "write_api_config", lambda cwd, name: str(tmp_path / "api.json"))
    monkeypatch.setattr(sandbox, "ensure_agent_home", lambda ws: None)
    notifier._remember_agent_keys("CID-AGENTKEYS", {"agent_keys_enc": {runtime: _seal(monkeypatch, key)}})
    sent, repr_, _ = notifier.spawn_headless(str(proj), "x", None, False, runtime=runtime)
    assert sent is True
    call = popen.calls[-1]
    argv = call["argv"]
    assert argv[0] == "docker"
    # `-e NAME` passthrough: the value rides the docker client's env, never argv
    pairs = {argv[i + 1] for i, a in enumerate(argv[:-1]) if a == "-e"}
    assert var in pairs and "CODEX_API_KEY" in pairs
    assert call["env"][var] == key
    assert key not in json.dumps(argv) and key not in repr_


def test_sandbox_passthrough_includes_codex_api_key():
    assert "CODEX_API_KEY" in sandbox.ENV_PASSTHROUGH


def test_preview_env_never_carries_agent_keys(monkeypatch):
    from orcha_cli import notifier_preview
    for k in ("CODEX_API_KEY", "CODEX_ACCESS_TOKEN", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY", "OPENAI_API_KEY"):
        monkeypatch.setenv(k, "secret-" + k)
    env = notifier_preview.preview_env(5555)
    for k in ("CODEX_API_KEY", "CODEX_ACCESS_TOKEN", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY", "OPENAI_API_KEY"):
        assert k not in env


def test_tick_remembers_agent_keys_from_the_scan(monkeypatch):
    blob = _seal(monkeypatch, OPENAI_KEY)
    scan = {"active": False, "container_status": "paused", "agent_keys_enc": {"claude": None, "codex": blob}}
    monkeypatch.setattr(notifier, "_get_json", lambda url, *a, **k: scan)
    notifier.tick("http://portal", "CID-TICK", dry_run=True, cooldown=0, min_idle=0, quiet=True)
    assert notifier_agent_keys._SEALED["CID-TICK"] == {"claude": None, "codex": blob}


# =============================================================================================
# codex metering
# =============================================================================================

def _write_log(tmp_path, *lines) -> str:
    p = tmp_path / "codex.jsonl"
    p.write_text("".join((json.dumps(o) if not isinstance(o, str) else o) + "\n" for o in lines))
    return str(p)


def test_codex_turn_completed_usage_maps_to_token_fields(tmp_path):
    log = _write_log(
        tmp_path,
        {"type": "thread.started", "thread_id": "t1"},
        {"type": "turn.started"},
        {"type": "item.completed", "item": {"id": "i1", "type": "agent_message", "text": "done"}},
        {"type": "turn.completed", "usage": {"input_tokens": 24763, "cached_input_tokens": 24448,
                                              "output_tokens": 122, "reasoning_output_tokens": 64}},
    )
    assert notifier._usage_from_log(log) == {
        "input_tokens": 315, "cache_read_input_tokens": 24448, "output_tokens": 122,
        "cache_creation_input_tokens": 0, "total_cost_usd": None,
    }


def test_codex_legacy_token_count_event(tmp_path):
    log = _write_log(tmp_path, {"id": "0", "msg": {"type": "token_count", "info": {
        "total_token_usage": {"input_tokens": 100, "cached_input_tokens": 40, "output_tokens": 7}}}})
    u = notifier._usage_from_log(log)
    assert u["input_tokens"] == 60 and u["cache_read_input_tokens"] == 40 and u["output_tokens"] == 7


@pytest.mark.parametrize("lines", [
    [{"type": "turn.completed"}],                                   # no usage
    [{"type": "turn.completed", "usage": "lots"}],                  # not an object
    [{"type": "turn.completed", "usage": {"input_tokens": "x", "output_tokens": None}}],  # junk counts
    [{"type": "turn.failed", "error": {"message": "boom"}}],        # failed turn, no usage
    [[1, 2, 3]],                                                    # non-object JSON line
    [{"type": "item.completed"}],                                   # unrelated shape
])
def test_codex_unknown_shapes_never_meter_never_crash(tmp_path, lines):
    assert notifier._usage_from_log(_write_log(tmp_path, *lines)) == {}


def test_codex_cached_larger_than_input_is_clamped(tmp_path):
    log = _write_log(tmp_path, {"type": "turn.completed", "usage": {
        "input_tokens": 10, "cached_input_tokens": 50, "output_tokens": 1}})
    u = notifier._usage_from_log(log)
    assert u["input_tokens"] == 0 and u["cache_read_input_tokens"] == 10


def test_claude_result_parsing_unchanged(tmp_path):
    log = _write_log(tmp_path, {"type": "result", "total_cost_usd": 0.5,
                                "usage": {"input_tokens": 1, "output_tokens": 2,
                                          "cache_read_input_tokens": 3, "cache_creation_input_tokens": 4}})
    assert notifier._usage_from_log(log) == {"input_tokens": 1, "output_tokens": 2,
                                             "cache_read_input_tokens": 3,
                                             "cache_creation_input_tokens": 4, "total_cost_usd": 0.5}


def test_codex_price_table_estimate():
    from portal_backend.codex_pricing import estimate_codex_cost_usd
    # gpt-5.4: $2.50 in / $0.25 cached / $15 out per 1M (an ESTIMATE)
    assert estimate_codex_cost_usd("gpt-5.4", input_tokens=1_000_000, cache_read_input_tokens=1_000_000,
                                   output_tokens=1_000_000) == pytest.approx(17.75)
    assert estimate_codex_cost_usd("gpt-unknown", input_tokens=10, output_tokens=10) is None
    assert estimate_codex_cost_usd(None, input_tokens=10) is None
    assert estimate_codex_cost_usd("gpt-5.4") is None  # no tokens → no cost, never $0


async def test_finish_estimates_codex_cost_from_agent_model(client, make_agent, db):
    aid = (await make_agent("Cody", "eng"))["agent_id"]
    db.execute("UPDATE agents SET model='gpt-5.4' WHERE id=%s", (aid,))
    rid = (await client.post(f"/api/agents/{aid}/runs",
                             json={"wake_kind": "ephemeral", "runtime": "codex"})).json()["run_id"]
    f = await client.post(f"/api/runs/{rid}/finish", json={
        "status": "exited", "exit_code": 0, "input_tokens": 315, "cache_read_input_tokens": 24448,
        "output_tokens": 122, "cache_creation_input_tokens": 0})
    assert f.status_code == 200, f.text
    row = db.execute("SELECT * FROM worker_runs WHERE run_id=%s", (rid,))[0]
    assert row["input_tokens"] == 315 and row["cache_read_input_tokens"] == 24448
    expected = (315 * 2.50 + 24448 * 0.25 + 122 * 15.00) / 1_000_000
    assert float(row["total_cost_usd"]) == pytest.approx(expected, rel=1e-4)


async def test_finish_never_estimates_a_claude_run(client, make_agent, db):
    aid = (await make_agent("Claudia", "eng"))["agent_id"]
    rid = (await client.post(f"/api/agents/{aid}/runs",
                             json={"wake_kind": "ephemeral", "runtime": "claude"})).json()["run_id"]
    await client.post(f"/api/runs/{rid}/finish", json={
        "status": "exited", "exit_code": 0, "input_tokens": 10, "output_tokens": 10})
    row = db.execute("SELECT total_cost_usd FROM worker_runs WHERE run_id=%s", (rid,))[0]
    assert row["total_cost_usd"] is None
