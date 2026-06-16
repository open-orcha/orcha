"""R1 / S3 — live-embodiment continuity (Vault span of the V1 continuity bundle).

The host PTY bridge spawns `orcha use <alias>` with ORCHA_LIVE=1 in a tty; cmd_use then
BECOMES the agent — execs an interactive `claude` booted AS the agent (persona+digest+history
on a COLD boot, `--resume <sid>` on a WARM one), and on exit the SessionEnd `orcha snapshot`
hook writes a C1 continuity digest (the gate now fires for ORCHA_LIVE too).

These tests exercise the CLI decision logic only (no live stack / no real exec): the prefix
assembly reuses notifier.format_persona + conversation_prefix, covered elsewhere.
"""
import argparse
import json
import os
import pathlib

from orcha_cli import __main__ as cli

AID = "11111111-2222-3333-4444-555555555555"


def _bind(tmp_path: pathlib.Path, *, api="http://test:8000", alias="Vault"):
    claude = tmp_path / ".claude"
    (claude / "orcha-tabs").mkdir(parents=True)
    (claude / "orcha.json").write_text(json.dumps({"api_base_url": api}))
    (claude / "orcha-tabs" / f"{alias}.json").write_text(
        json.dumps({"alias": alias, "agent_id": AID, "container_id": "c"}))


# ---- _build_live_argv (pure) --------------------------------------------------

def test_argv_cold_injects_boot_prefix():
    argv = cli._build_live_argv(True, None, "PERSONA+DIGEST+HISTORY")
    assert argv == ["claude", "--append-system-prompt", "PERSONA+DIGEST+HISTORY"]


def test_argv_cold_without_prefix_is_plain_claude():
    # cold but nothing to inject (API unreachable / no digest) → still a valid launch
    assert cli._build_live_argv(True, None, None) == ["claude"]


def test_argv_warm_resumes_session_and_never_reinjects():
    # WARM must --resume and must NOT carry a boot prefix even if one is passed (cache-safe)
    argv = cli._build_live_argv(False, "sess-123", "SHOULD-NOT-APPEAR")
    assert argv == ["claude", "--resume", "sess-123"]
    assert "--append-system-prompt" not in argv


def test_argv_warm_without_sid_degrades_to_plain_claude():
    assert cli._build_live_argv(False, None, None) == ["claude"]


# ---- GAP A: --model on the live spawn surface (#136/ISS-58) -------------------

def test_argv_cold_pins_selected_model():
    # (a) a selected (currently-spawnable) model → --model on the cold boot, after the prefix
    argv = cli._build_live_argv(True, None, "BOOT", "claude-fable-5")
    assert argv == ["claude", "--append-system-prompt", "BOOT", "--model", "claude-fable-5"]


def test_argv_cold_model_without_prefix():
    # model but no boot prefix (API gave no persona/digest) → still pins the model
    assert cli._build_live_argv(True, None, None, "claude-opus-4-8") == \
        ["claude", "--model", "claude-opus-4-8"]


def test_argv_cold_no_model_omits_flag():
    # (c) no model (human, or unresolved) → no --model, exactly like the other surfaces
    assert cli._build_live_argv(True, None, "BOOT", None) == \
        ["claude", "--append-system-prompt", "BOOT"]


def test_argv_warm_never_pins_model():
    # WARM keeps the session's booted model — --model must NOT appear even if one is passed
    argv = cli._build_live_argv(False, "sess-123", None, "claude-fable-5")
    assert argv == ["claude", "--resume", "sess-123"]
    assert "--model" not in argv


def test_argv_codex_cold_uses_initial_prompt():
    argv = cli._build_live_argv(True, None, "BOOT", "gpt-5.5", "codex")
    assert argv == ["codex", "--model", "gpt-5.5", "BOOT"]


def test_argv_codex_warm_resumes_session():
    argv = cli._build_live_argv(False, "sess-123", "SHOULD-NOT-APPEAR", "gpt-5.5", "codex")
    assert argv == ["codex", "resume", "sess-123"]
    assert "SHOULD-NOT-APPEAR" not in argv


def test_resolve_runtime_executable_finds_codex_app_fallback(monkeypatch, tmp_path):
    codex = tmp_path / "codex"
    codex.write_text("#!/bin/sh\n")
    codex.chmod(0o755)
    monkeypatch.setattr(cli.shutil, "which", lambda x: None)
    monkeypatch.setattr(cli, "_CODEX_EXEC_FALLBACKS", (str(codex),))
    assert cli._resolve_runtime_executable("codex") == str(codex)


# ---- _live_agent_model (resolved-model fetch) --------------------------------

def test_live_agent_model_reads_resolved_persona(monkeypatch):
    # /persona carries the server-resolved model; the CLI consumes it verbatim
    monkeypatch.setattr(cli, "_get_json",
                        lambda url, timeout=4.0: {"model": "claude-fable-5", "model_runtime": "claude"})
    assert cli._live_agent_model("http://test:8000", AID) == "claude-fable-5"
    assert cli._live_agent_launch("http://test:8000", AID) == ("claude-fable-5", "claude")


def test_live_agent_launch_reads_codex_runtime(monkeypatch):
    monkeypatch.setattr(cli, "_get_json",
                        lambda url, timeout=4.0: {"model": "gpt-5.5", "model_runtime": "codex"})
    assert cli._live_agent_launch("http://test:8000", AID) == ("gpt-5.5", "codex")


def test_live_agent_launch_infers_codex_runtime_for_old_portal(monkeypatch):
    monkeypatch.setattr(cli, "_get_json",
                        lambda url, timeout=4.0: {"model": "gpt-5.5"})
    assert cli._live_agent_launch("http://test:8000", AID) == ("gpt-5.5", "codex")


def test_live_agent_model_none_for_human(monkeypatch):
    # humans carry no model → /persona returns model=None → no flag downstream
    monkeypatch.setattr(cli, "_get_json", lambda url, timeout=4.0: {"model": None})
    assert cli._live_agent_model("http://test:8000", AID) is None


def test_live_agent_model_best_effort_on_failure(monkeypatch):
    # a live boot must never fail on an unreachable API → None (claude uses its own default)
    def _boom(url, timeout=4.0):
        raise RuntimeError("API down")
    monkeypatch.setattr(cli, "_get_json", _boom)
    assert cli._live_agent_model("http://test:8000", AID) is None
    assert cli._live_agent_model(None, AID) is None
    assert cli._live_agent_model("http://test:8000", None) is None


# ---- _live_boot_prefix (composition) -----------------------------------------

def test_boot_prefix_none_without_api_or_agent():
    assert cli._live_boot_prefix(None, AID) is None
    assert cli._live_boot_prefix("http://test:8000", None) is None


def test_boot_prefix_composes_persona_digest_then_history(monkeypatch):
    from orcha_cli import notifier
    monkeypatch.setattr(notifier, "_build_persona", lambda api, aid: "PERSONA+DIGEST")
    # _get_json returns the conversation read; format_conversation_history renders the turns
    monkeypatch.setattr(cli, "_get_json",
                        lambda url, timeout=4.0: {"turns": [{"role": "human", "content": "hi"}]})
    out = cli._live_boot_prefix("http://test:8000", AID)
    assert out.startswith("PERSONA+DIGEST")
    assert "## Conversation so far" in out               # history block appended after persona
    assert out.index("PERSONA+DIGEST") < out.index("## Conversation so far")


def test_boot_prefix_survives_history_fetch_failure(monkeypatch):
    from orcha_cli import notifier
    monkeypatch.setattr(notifier, "_build_persona", lambda api, aid: "PERSONA+DIGEST")
    def _boom(url, timeout=4.0):
        raise RuntimeError("API down")
    monkeypatch.setattr(cli, "_get_json", _boom)
    # persona still injected even if the conversation fetch throws
    assert cli._live_boot_prefix("http://test:8000", AID) == "PERSONA+DIGEST"


# ---- cmd_use dispatch ---------------------------------------------------------

def test_cmd_use_prints_export_when_not_live(tmp_path, monkeypatch, capsys):
    """Default (no ORCHA_LIVE): the ssh-agent idiom is unchanged — print the export, no exec."""
    monkeypatch.delenv("ORCHA_LIVE", raising=False)
    monkeypatch.chdir(tmp_path)
    _bind(tmp_path)
    execs = []
    monkeypatch.setattr(cli.os, "execvpe", lambda f, a, e: execs.append((f, a, e)))
    cli.cmd_use(argparse.Namespace(alias="Vault"))
    assert "export ORCHA_ALIAS=Vault" in capsys.readouterr().out
    assert execs == []                                   # never execs in the default path


def test_cmd_use_live_cold_execs_claude_as_agent(tmp_path, monkeypatch):
    """ORCHA_LIVE + cold → exec `claude --append-system-prompt <prefix>` with ORCHA_ALIAS set."""
    monkeypatch.setenv("ORCHA_LIVE", "1")
    monkeypatch.setenv("ORCHA_LIVE_COLD", "1")
    monkeypatch.chdir(tmp_path)
    _bind(tmp_path)
    monkeypatch.setattr(cli.shutil, "which", lambda x: "/usr/bin/claude")
    monkeypatch.setattr(cli, "_live_boot_prefix", lambda api, aid: "BOOT")
    monkeypatch.setattr(cli, "_live_agent_launch", lambda api, aid: ("claude-sonnet-4-6", "claude"))
    captured = {}
    def _fake_exec(file, argv, env):
        captured.update(file=file, argv=argv, env=env)
    monkeypatch.setattr(cli.os, "execvpe", _fake_exec)
    cli.cmd_use(argparse.Namespace(alias="Vault"))
    assert captured["file"] == "claude"
    # GAP A: a cold live boot now also pins the agent's selected model
    assert captured["argv"] == ["claude", "--append-system-prompt", "BOOT",
                                "--model", "claude-sonnet-4-6"]
    assert captured["env"]["ORCHA_ALIAS"] == "Vault"
    assert captured["env"]["ORCHA_AGENT_RUNTIME"] == "claude"


def test_cmd_use_live_cold_execs_codex_as_agent(tmp_path, monkeypatch):
    """ORCHA_LIVE + Codex model → exec `codex --model <model> <boot prompt>`."""
    monkeypatch.setenv("ORCHA_LIVE", "1")
    monkeypatch.setenv("ORCHA_LIVE_COLD", "1")
    monkeypatch.chdir(tmp_path)
    _bind(tmp_path)
    monkeypatch.setattr(cli.shutil, "which", lambda x: f"/usr/bin/{x}")
    monkeypatch.setattr(cli, "_live_boot_prefix", lambda api, aid: "BOOT")
    monkeypatch.setattr(cli, "_live_agent_launch", lambda api, aid: ("gpt-5.5", "codex"))
    captured = {}
    monkeypatch.setattr(cli.os, "execvpe",
                        lambda f, a, e: captured.update(file=f, argv=a, env=e))
    cli.cmd_use(argparse.Namespace(alias="Vault"))
    assert captured["file"] == "codex"
    assert captured["argv"] == ["codex", "--model", "gpt-5.5", "BOOT"]
    assert captured["env"]["ORCHA_ALIAS"] == "Vault"
    assert captured["env"]["ORCHA_AGENT_RUNTIME"] == "codex"


def test_cmd_use_live_cold_execs_codex_app_fallback(tmp_path, monkeypatch):
    """Codex.app's bundled CLI may not be on the PTY PATH; use the resolved executable."""
    codex = tmp_path / "codex"
    codex.write_text("#!/bin/sh\n")
    codex.chmod(0o755)
    monkeypatch.setenv("ORCHA_LIVE", "1")
    monkeypatch.setenv("ORCHA_LIVE_COLD", "1")
    monkeypatch.chdir(tmp_path)
    _bind(tmp_path)
    monkeypatch.setattr(cli.shutil, "which", lambda x: None)
    monkeypatch.setattr(cli, "_CODEX_EXEC_FALLBACKS", (str(codex),))
    monkeypatch.setattr(cli, "_live_boot_prefix", lambda api, aid: "BOOT")
    monkeypatch.setattr(cli, "_live_agent_launch", lambda api, aid: ("gpt-5.5", "codex"))
    captured = {}
    monkeypatch.setattr(cli.os, "execvpe",
                        lambda f, a, e: captured.update(file=f, argv=a, env=e))
    cli.cmd_use(argparse.Namespace(alias="Vault"))
    assert captured["file"] == str(codex)
    assert captured["argv"] == [str(codex), "--model", "gpt-5.5", "BOOT"]


def test_cmd_use_live_warm_resumes(tmp_path, monkeypatch):
    """ORCHA_LIVE + warm (COLD=0 + a resume sid) → exec `claude --resume <sid>`, no prefix."""
    monkeypatch.setenv("ORCHA_LIVE", "1")
    monkeypatch.setenv("ORCHA_LIVE_COLD", "0")
    monkeypatch.setenv("ORCHA_LIVE_RESUME_SID", "sess-abc")
    monkeypatch.chdir(tmp_path)
    _bind(tmp_path)
    monkeypatch.setattr(cli.shutil, "which", lambda x: "/usr/bin/claude")
    # a cold prefix must NOT be built on a warm boot
    monkeypatch.setattr(cli, "_live_boot_prefix",
                        lambda api, aid: (_ for _ in ()).throw(AssertionError("must not build prefix when warm")))
    monkeypatch.setattr(cli, "_live_agent_launch", lambda api, aid: ("claude-sonnet-4-6", "claude"))
    captured = {}
    monkeypatch.setattr(cli.os, "execvpe", lambda f, a, e: captured.update(argv=a))
    cli.cmd_use(argparse.Namespace(alias="Vault"))
    assert captured["argv"] == ["claude", "--resume", "sess-abc"]


def test_cmd_use_live_warm_resumes_codex(tmp_path, monkeypatch):
    monkeypatch.setenv("ORCHA_LIVE", "1")
    monkeypatch.setenv("ORCHA_LIVE_COLD", "0")
    monkeypatch.setenv("ORCHA_LIVE_RESUME_SID", "sess-abc")
    monkeypatch.chdir(tmp_path)
    _bind(tmp_path)
    monkeypatch.setattr(cli.shutil, "which", lambda x: f"/usr/bin/{x}")
    monkeypatch.setattr(cli, "_live_boot_prefix",
                        lambda api, aid: (_ for _ in ()).throw(AssertionError("must not build prefix when warm")))
    monkeypatch.setattr(cli, "_live_agent_launch", lambda api, aid: ("gpt-5.5", "codex"))
    captured = {}
    monkeypatch.setattr(cli.os, "execvpe",
                        lambda f, a, e: captured.update(file=f, argv=a, env=e))
    cli.cmd_use(argparse.Namespace(alias="Vault"))
    assert captured["file"] == "codex"
    assert captured["argv"] == ["codex", "resume", "sess-abc"]


# ---- #297: prefer the bridge-handed model/runtime over a 2nd /persona fetch ----

def _no_refetch(*a, **k):
    raise AssertionError("_live_agent_launch must NOT be called when the bridge handed env down")


def test_cmd_use_live_prefers_bridge_env_runtime_no_refetch(tmp_path, monkeypatch):
    """ORCHA_LIVE_RUNTIME present → trust the env the bridge resolved; do NOT re-fetch /persona
    (the second fail-open round-trip is the #297 regression). Cold pins the env model."""
    monkeypatch.setenv("ORCHA_LIVE", "1")
    monkeypatch.setenv("ORCHA_LIVE_COLD", "1")
    monkeypatch.setenv("ORCHA_LIVE_MODEL", "claude-opus-4-8")
    monkeypatch.setenv("ORCHA_LIVE_RUNTIME", "claude")
    monkeypatch.chdir(tmp_path)
    _bind(tmp_path)
    monkeypatch.setattr(cli.shutil, "which", lambda x: "/usr/bin/claude")
    monkeypatch.setattr(cli, "_live_boot_prefix", lambda api, aid: "BOOT")
    monkeypatch.setattr(cli, "_live_agent_launch", _no_refetch)   # bites: any refetch fails the test
    captured = {}
    monkeypatch.setattr(cli.os, "execvpe",
                        lambda f, a, e: captured.update(file=f, argv=a, env=e))
    cli.cmd_use(argparse.Namespace(alias="Vault"))
    assert captured["argv"] == ["claude", "--append-system-prompt", "BOOT",
                                "--model", "claude-opus-4-8"]
    assert captured["env"]["ORCHA_AGENT_RUNTIME"] == "claude"


def test_cmd_use_live_prefers_bridge_env_codex_runtime(tmp_path, monkeypatch):
    """ORCHA_LIVE_RUNTIME=codex from the bridge → boot codex (not the claude fallback), no refetch."""
    monkeypatch.setenv("ORCHA_LIVE", "1")
    monkeypatch.setenv("ORCHA_LIVE_COLD", "1")
    monkeypatch.setenv("ORCHA_LIVE_MODEL", "gpt-5.5")
    monkeypatch.setenv("ORCHA_LIVE_RUNTIME", "codex")
    monkeypatch.chdir(tmp_path)
    _bind(tmp_path)
    monkeypatch.setattr(cli.shutil, "which", lambda x: f"/usr/bin/{x}")
    monkeypatch.setattr(cli, "_live_boot_prefix", lambda api, aid: "BOOT")
    monkeypatch.setattr(cli, "_live_agent_launch", _no_refetch)
    captured = {}
    monkeypatch.setattr(cli.os, "execvpe",
                        lambda f, a, e: captured.update(file=f, argv=a, env=e))
    cli.cmd_use(argparse.Namespace(alias="Vault"))
    assert captured["file"] == "codex"
    assert captured["argv"] == ["codex", "--model", "gpt-5.5", "BOOT"]
    assert captured["env"]["ORCHA_AGENT_RUNTIME"] == "codex"


def test_cmd_use_live_human_target_env_runtime_no_model(tmp_path, monkeypatch):
    """A human target: the bridge set ORCHA_LIVE_RUNTIME=claude but NO ORCHA_LIVE_MODEL → boot
    claude with no --model (still no refetch — env presence marks a trusted bridge spawn)."""
    monkeypatch.setenv("ORCHA_LIVE", "1")
    monkeypatch.setenv("ORCHA_LIVE_COLD", "1")
    monkeypatch.delenv("ORCHA_LIVE_MODEL", raising=False)
    monkeypatch.setenv("ORCHA_LIVE_RUNTIME", "claude")
    monkeypatch.chdir(tmp_path)
    _bind(tmp_path)
    monkeypatch.setattr(cli.shutil, "which", lambda x: "/usr/bin/claude")
    monkeypatch.setattr(cli, "_live_boot_prefix", lambda api, aid: "BOOT")
    monkeypatch.setattr(cli, "_live_agent_launch", _no_refetch)
    captured = {}
    monkeypatch.setattr(cli.os, "execvpe",
                        lambda f, a, e: captured.update(argv=a))
    cli.cmd_use(argparse.Namespace(alias="Vault"))
    assert captured["argv"] == ["claude", "--append-system-prompt", "BOOT"]   # no --model


def test_cmd_use_live_no_env_falls_back_to_persona(tmp_path, monkeypatch):
    """A DIRECT `orcha use` (no bridge → no ORCHA_LIVE_RUNTIME) still resolves from /persona."""
    monkeypatch.setenv("ORCHA_LIVE", "1")
    monkeypatch.setenv("ORCHA_LIVE_COLD", "1")
    monkeypatch.delenv("ORCHA_LIVE_RUNTIME", raising=False)
    monkeypatch.delenv("ORCHA_LIVE_MODEL", raising=False)
    monkeypatch.chdir(tmp_path)
    _bind(tmp_path)
    monkeypatch.setattr(cli.shutil, "which", lambda x: "/usr/bin/claude")
    monkeypatch.setattr(cli, "_live_boot_prefix", lambda api, aid: "BOOT")
    fetched = []
    monkeypatch.setattr(cli, "_live_agent_launch",
                        lambda api, aid: fetched.append((api, aid)) or ("claude-sonnet-4-6", "claude"))
    captured = {}
    monkeypatch.setattr(cli.os, "execvpe", lambda f, a, e: captured.update(argv=a))
    cli.cmd_use(argparse.Namespace(alias="Vault"))
    assert fetched == [("http://test:8000", AID)]      # resolved from /persona, the no-bridge path
    assert captured["argv"][-2:] == ["--model", "claude-sonnet-4-6"]


def test_cmd_use_live_warns_on_persona_degrade(tmp_path, monkeypatch, capsys):
    """#297: when the no-bridge /persona resolution yields no model, the degrade-to-default is
    now NON-silent so it's diagnosable (was a silent claude+DEFAULT_MODEL fall-through)."""
    monkeypatch.setenv("ORCHA_LIVE", "1")
    monkeypatch.setenv("ORCHA_LIVE_COLD", "1")
    monkeypatch.delenv("ORCHA_LIVE_RUNTIME", raising=False)
    monkeypatch.chdir(tmp_path)
    _bind(tmp_path)
    monkeypatch.setattr(cli.shutil, "which", lambda x: "/usr/bin/claude")
    monkeypatch.setattr(cli, "_live_boot_prefix", lambda api, aid: "BOOT")
    monkeypatch.setattr(cli, "_live_agent_launch", lambda api, aid: (None, "claude"))
    monkeypatch.setattr(cli.os, "execvpe", lambda f, a, e: None)
    cli.cmd_use(argparse.Namespace(alias="Vault"))
    err = capsys.readouterr().err
    assert "could not resolve" in err and "#297" in err


# ---- cmd_snapshot gate now includes the live embodiment -----------------------

def test_snapshot_fires_for_live_embodiment(tmp_path, monkeypatch):
    """ORCHA_LIVE set (terminal session) → SessionEnd writes a continuity digest, same as a
    headless worker (the gate now admits both)."""
    monkeypatch.delenv("ORCHA_HEADLESS_WORKER", raising=False)
    monkeypatch.setenv("ORCHA_LIVE", "1")
    posted = []
    monkeypatch.setattr(cli, "_post_json", lambda url, body: posted.append((url, body)) or {})
    monkeypatch.setattr(cli, "_get_json", lambda url, timeout=5.0: {"digest": None})
    monkeypatch.setattr(cli, "_read_hook_stdin", lambda: {"transcript_path": None, "session_id": "s1"})
    monkeypatch.chdir(tmp_path)
    _bind(tmp_path)
    cli.cmd_snapshot(argparse.Namespace(alias="Vault"))
    assert len(posted) == 1
    url, body = posted[0]
    assert url == f"http://test:8000/api/agents/{AID}/digest"
    assert "Live terminal session" in body["current_focus"]   # embodiment-aware fallback focus


# ---- [P1 review] SessionStart hooks must no-op for a live embodiment (no double-inject) ----

def test_managed_embodiment_guard_skips_for_both_markers(monkeypatch):
    monkeypatch.delenv("ORCHA_HEADLESS_WORKER", raising=False)
    monkeypatch.delenv("ORCHA_LIVE", raising=False)
    assert cli._skip_managed_embodiment_hook("rehydrate") is False    # interactive tab → runs
    monkeypatch.setenv("ORCHA_LIVE", "1")
    assert cli._skip_managed_embodiment_hook("rehydrate") is True     # live → no-op (the fix)
    monkeypatch.delenv("ORCHA_LIVE")
    monkeypatch.setenv("ORCHA_HEADLESS_WORKER", "1")
    assert cli._skip_managed_embodiment_hook("watch") is True


def test_rehydrate_noops_under_live_so_no_double_injection(tmp_path, monkeypatch, capsys):
    """[P1] In a live session persona+digest+history is already in the boot prefix, so the
    SessionStart `rehydrate` hook MUST emit nothing — else the brief double-injects (and
    re-injects on a warm resume). It must also leave ORCHA_LIVE set for the SessionEnd snapshot."""
    monkeypatch.setenv("ORCHA_LIVE", "1")
    monkeypatch.delenv("ORCHA_HEADLESS_WORKER", raising=False)
    # if the hook didn't short-circuit it would fetch the brief — make that fail loudly
    monkeypatch.setattr(cli, "_get_json",
                        lambda *a, **k: (_ for _ in ()).throw(AssertionError("rehydrate must not fetch under ORCHA_LIVE")))
    monkeypatch.chdir(tmp_path)
    _bind(tmp_path)
    cli.cmd_rehydrate(argparse.Namespace(alias="Vault"))
    out = capsys.readouterr().out
    assert "skipping interactive SessionStart hook 'rehydrate'" in out   # the no-op message
    assert "Where you left off" not in out and "Conversation so far" not in out   # NO brief emitted
    assert os.environ.get("ORCHA_LIVE") == "1"                           # preserved for SessionEnd snapshot


def test_snapshot_still_noops_when_neither_marker_set(tmp_path, monkeypatch):
    monkeypatch.delenv("ORCHA_HEADLESS_WORKER", raising=False)
    monkeypatch.delenv("ORCHA_LIVE", raising=False)
    posted = []
    monkeypatch.setattr(cli, "_post_json", lambda url, body: posted.append(1) or {})
    monkeypatch.setattr(cli, "_read_hook_stdin", lambda: {"transcript_path": "x"})
    monkeypatch.chdir(tmp_path)
    _bind(tmp_path)
    cli.cmd_snapshot(argparse.Namespace(alias="Vault"))
    assert posted == []
