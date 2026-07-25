"""`orcha` CLI — bootstrap + lifecycle for the Orcha backing stack in any project.

Usage:
    orcha init [--name NAME] [--api-port N] [--db-port N] [--force]
    orcha up
    orcha down [-v]
    orcha status
"""
from __future__ import annotations

import argparse
import importlib.resources as pkg_res
from importlib.metadata import PackageNotFoundError
from importlib.metadata import version as _pkg_version
import json
import os
import pathlib
import re
import shutil
import subprocess
import sys
from typing import Optional

from orcha_cli.notifier import (  # Epic A: wake daemon / cron stopgap
    cmd_notifier, ensure_daemon, stop_daemon, stop_daemon_for_container)
# Self-contained helper groups split out of this entrypoint. Re-imported here so
# `orcha_cli.__main__.<fn>` references (and the tests that patch them) resolve unchanged.
from orcha_cli.cli_text import (  # pure text / front-matter helpers
    _codex_skill_body, _frontmatter_value, _sanitize_name, _strip_frontmatter)
from orcha_cli.cli_env import (  # dotenv-file primitives
    _append_env_file, _read_env_file_value, _tighten_env_file)
from orcha_cli.cli_http import _get_json, _post_json, _wait_for_portal  # tiny urllib JSON helpers
from orcha_cli import cli_project_setup as _project_setup
from orcha_cli import cli_bindings as _cli_bindings
from orcha_cli import cli_project_commands as _cli_project_commands
from orcha_cli import cli_connect as _cli_connect
from orcha_cli import cli_init as _cli_init
from orcha_cli import cli_hooks as _cli_hooks
from orcha_cli import cli_lifecycle as _cli_lifecycle
from orcha_cli import cli_rehydrate as _cli_rehydrate
from orcha_cli import cli_session_hooks as _cli_session_hooks
from orcha_cli import cli_stacks as _cli_stacks
from orcha_cli import cli_transcript as _cli_transcript
from orcha_cli import cli_watch as _cli_watch
from orcha_cli import cli_watch_state as _cli_watch_state


PKG_ROOT = pkg_res.files("orcha_cli")
PKG_TEMPLATES = PKG_ROOT / "templates"

# #294 Item 1: secret_box master-key env var (must match secret_box._MASTER_ENV). The CLI
# auto-generates + persists one to .orcha/.env on up/upgrade so stored-key storage works
# out of the box; see _ensure_secret_key.
_MASTER_KEY_ENV = "ORCHA_SECRET_KEY"
_PAIRING_HOST_ENV = "ORCHA_PAIRING_HOST"


# Pure-stdlib shared modules that the portal container imports top-level (`import <name>`) but
# whose single git source lives in the orcha_cli package (the host daemon imports them as
# `orcha_cli.<name>`). Copied into the portal build dir at scaffold so each file is never
# hand-maintained in two places — same single-source pattern as migrations.
#   * llm_util    (#290) — universal LLM client
#   * secret_box  (#294) — at-rest encryption for the per-container LLM API key
#   * digest_curate (#287) — write-side digest dedup + boot-copy trim
_PORTAL_SHARED_MODULES = (
    "llm_util.py",
    "llm_catalog.py",
    "llm_decisions.py",
    "llm_formats.py",
    "llm_http.py",
    "llm_observability.py",
    "llm_providers.py",
    "llm_stream.py",
    "llm_vision.py",
    "secret_box.py",
    "digest_curate.py",
    "digest_recalibrate.py",
    "digest_summary.py",
)


def _install_llm_util(orcha_dir: pathlib.Path) -> None:
    """Place the pure-stdlib shared modules (llm_util #290, secret_box #294, digest_curate #287)
    into the portal build dir.

    The portal runs in its own container (Dockerfile `COPY . .`), so it needs a copy of each
    shared module alongside `main.py` to `import <name>`. Copied here (like migrations are a
    single source copied into the deploy), so the files are never hand-maintained in two places.
    """
    portal_dir = orcha_dir / "portal"
    portal_dir.mkdir(parents=True, exist_ok=True)
    for mod in _PORTAL_SHARED_MODULES:
        (portal_dir / mod).write_bytes((PKG_ROOT / mod).read_bytes())


def _cli_version() -> str:
    """Installed orcha-cli distribution version. Source-tree runs (tests import via
    sys.path without installing) have no dist metadata — return a sentinel."""
    try:
        return _pkg_version("orcha-cli")
    except PackageNotFoundError:
        return "0.0.0+source"


# ---------- helpers ----------
# Pure text / front-matter helpers (_sanitize_name, _strip_frontmatter,
# _frontmatter_value, _codex_skill_body) live in cli_text.py; dotenv-file
# primitives in cli_env.py; tiny urllib JSON helpers in cli_http.py — all
# re-imported at the top of this module.

def _find_free_port(start: int, span: int = 100) -> int:
    return _project_setup.find_free_port(start, span)


def _copy_tree(src, dst: pathlib.Path) -> None:
    """Recursively copy from a Traversable (importlib.resources) to a Path."""
    _project_setup.copy_tree(src, dst)


def _install_orcha_skill_templates(project_root: pathlib.Path) -> tuple[pathlib.Path, pathlib.Path]:
    """Install Orcha command prompts for Claude Code and Codex into this workspace."""
    return _project_setup.install_skill_templates(
        project_root, PKG_TEMPLATES, _codex_skill_body
    )


def _install_project_preferences(project_root: pathlib.Path) -> Optional[pathlib.Path]:
    """#298: materialize docs/orcha-project-preferences.md from the packaged template.

    The prefs file is the canonical, agent-read home for the LOOSELY-HARDENED rules (gh/git
    conventions + merge-target branch). It is shipped as a packaged template asset so EVERY
    project gets it at `orcha init` regardless of install method (pypi/homebrew/source) — never
    hand-seeded by an agent. The autonomy *level* is NEVER written here: the DB column
    (containers.autonomy_level, mig 021) is the sole engine-enforced source of truth; agents read
    the level live from the API and combine it with this file as `min(DB ceiling, prefs)`.

    Idempotent BACKFILL semantics — writes only when ABSENT, so it never clobbers a project's
    edited rules (init re-run with --force, `orcha up`/`upgrade` on an existing project). Returns
    the path when written, else None.
    """
    return _project_setup.install_project_preferences(project_root, PKG_TEMPLATES)


def _ensure_secret_key(orcha_dir: pathlib.Path) -> None:
    """#294 Item 1: guarantee a secret_box master key (ORCHA_SECRET_KEY) is present in the env
    BEFORE `compose up` interpolates the portal env, so stored-key PUT/read works out of the box.

    PROVENANCE (Helm ruling, req eec616d8): auto-generate-and-persist, NOT operator-mandatory —
    an out-of-box `orcha up`/`upgrade` must yield a working stored-key flow with zero manual env
    setup. Precedence, highest first:
      1. operator-supplied ``ORCHA_SECRET_KEY`` in the host env  → used as-is, NOT persisted
         (the operator owns its lifecycle; we never write their secret to our .env).
      2. a previously-persisted key in ``.orcha/.env``           → loaded into the process env.
      3. neither → mint ``secrets.token_urlsafe(32)``, persist it to ``.orcha/.env`` (0600), and
         export it for this process.
    The key is exported into ``os.environ`` so the inherited ``compose`` subprocess interpolates
    ``${ORCHA_SECRET_KEY:-}`` from it — independent of Compose's own .env auto-discovery. The
    same .env (idiomatic to Compose) also persists the value across CLI invocations + upgrades,
    so an existing deployment gets its key BACKFILLED the first time it hits this on `up`.

    Honest threat-model note (mirrors secret_box's docstring): this master key sits next to the
    DB on the same host — it's defense-in-depth for leaked DB snapshots, not a trust boundary."""
    _project_setup.ensure_secret_key(
        orcha_dir, _read_env_file_value, _append_env_file, _tighten_env_file
    )


def _usable_pairing_ip(value: str) -> Optional[str]:
    """Return a phone-reachable LAN-ish IP, or None for localhost/link-local/etc."""
    return _project_setup.usable_pairing_ip(value)


def _discover_pairing_host() -> Optional[str]:
    """Best-effort host LAN IP discovery for mobile pairing.

    This runs on the Mac/host before Docker starts. Doing it inside the portal container would
    usually find Docker's bridge address, which a phone cannot reach.
    """
    return _project_setup.discover_pairing_host()


def _export_pairing_host() -> None:
    """Expose the host LAN IP to docker compose for the portal's pairing endpoint."""
    _project_setup.export_pairing_host(_discover_pairing_host)


def _compose(orcha_dir: pathlib.Path, *args: str, check: bool = True, capture: bool = False) -> subprocess.CompletedProcess:
    return _project_setup.compose(
        orcha_dir,
        *args,
        check=check,
        capture=capture,
        ensure_key=_ensure_secret_key,
        export_host=_export_pairing_host,
    )


# ---------- commands ----------

def _prune_stale_bindings(tabs_dir: pathlib.Path, keep_cid: str) -> int:
    """#255: delete `orcha-tabs/*.json` bindings whose container_id != keep_cid.

    `init --force --reset-data` wipes the DB and creates a NEW container, but the per-alias tab
    bindings on disk still carry the OLD (now-404) container_id — so those aliases keep resolving
    to dead agents. Prune them, keeping only bindings for the freshly-created container (e.g. the
    new human binding written just after). A binding with no readable container_id is left alone
    (don't delete what we can't classify). Returns the count removed."""
    if not (keep_cid and tabs_dir.is_dir()):
        return 0
    removed = 0
    for f in tabs_dir.glob("*.json"):
        try:
            cid = json.loads(f.read_text()).get("container_id")
        except (OSError, ValueError):
            continue                                   # unreadable/garbage — leave it
        if cid and cid != keep_cid:
            try:
                f.unlink()
                removed += 1
            except OSError:
                pass
    return removed


def cmd_init(args: argparse.Namespace) -> None:
    """Initialize a project through the focused workflow module."""
    _cli_init.cmd_init(args, sys.modules[__name__])

def _resolve_bridge_port(api_base: str) -> Optional[int]:
    return _cli_connect.resolve_bridge_port(api_base, get_json=_get_json)


def cmd_connect(args: argparse.Namespace) -> None:
    _cli_connect.connect_command(
        args,
        sanitize_name=_sanitize_name,
        discover_stacks=_discover_stacks,
        wait_for_portal=_wait_for_portal,
        get_json=_get_json,
        resolve_port=_resolve_bridge_port,
        install_skill_templates=_install_orcha_skill_templates,
        write_hook_config=_write_hook_config,
        post_json=_post_json,
    )


def _discover_stacks() -> list[dict]:
    return _cli_stacks.discover_stacks(parse_host_port=_parse_host_port)


def _full_project(project_name: str) -> str:
    return _cli_stacks.full_project(project_name)


def _by_project(project_name: str, *args: str) -> None:
    _cli_stacks.by_project(
        project_name, *args, export_pairing_host=_export_pairing_host
    )


def _project_exists(project_name: str) -> bool:
    return _cli_stacks.project_exists(project_name)


def cmd_up(args: argparse.Namespace) -> None:
    """Start a project stack through the focused workflow module."""
    _cli_project_commands.cmd_up(args, sys.modules[__name__])


def cmd_down(args: argparse.Namespace) -> None:
    """Stop a project stack through the focused workflow module."""
    _cli_project_commands.cmd_down(args, sys.modules[__name__])


def cmd_migrate(args: argparse.Namespace) -> None:
    """Apply migrations through the focused workflow module."""
    _cli_project_commands.cmd_migrate(args, sys.modules[__name__])


def cmd_upgrade(args: argparse.Namespace) -> None:
    """Upgrade project assets through the focused workflow module."""
    _cli_project_commands.cmd_upgrade(args, sys.modules[__name__])


def _cli_source_root() -> Optional[pathlib.Path]:
    """Return the orcha-cli/ source dir IFF this CLI is an editable/source install
    (a pyproject.toml sits beside the installed package) — else None for a packaged
    wheel install, which is updated via the user's package manager, not from source."""
    try:
        pkg_dir = pathlib.Path(str(pkg_res.files("orcha_cli")))
    except Exception:
        return None
    root = pkg_dir.parent  # .../orcha-cli/orcha_cli -> .../orcha-cli
    return root if (root / "pyproject.toml").exists() else None


def _brew_keg() -> Optional[str]:
    """Return the Homebrew formula name ('orcha', or 'orcha@X.Y.Z' for a pinned
    downgrade) IFF the running `orcha` resolves into a Homebrew Cellar keg — else
    None. Resolving symlinks first matters: brew puts a link at
    $(brew --prefix)/bin/orcha pointing into the Cellar."""
    exe = shutil.which("orcha")
    if not exe:
        return None
    parts = pathlib.Path(exe).resolve().parts
    for i, part in enumerate(parts[:-1]):
        if part == "Cellar":
            return parts[i + 1]
    return None


def _reinstall_cli(src_root: pathlib.Path) -> bool:
    """Reinstall the host CLI from its source checkout (the documented manual step:
    `uv tool install --reinstall --editable .`). Prefers uv; falls back to pip -e."""
    uv = shutil.which("uv")
    if uv:
        cmd = [uv, "tool", "install", "--reinstall", "--editable", str(src_root)]
    else:
        cmd = [sys.executable, "-m", "pip", "install", "-e", str(src_root)]
    print(f"[orcha] reinstalling host CLI from {src_root}\n        $ {' '.join(cmd)}")
    try:
        return subprocess.run(cmd).returncode == 0
    except (OSError, subprocess.SubprocessError) as e:
        print(f"[orcha] warn: could not launch reinstall ({e})", file=sys.stderr)
        return False


def _brew_upgrade(keg: str) -> bool:
    """Self-upgrade a Homebrew-managed orcha. A versioned keg (orcha@X.Y.Z) is an
    explicit user pin — refuse so `orcha update` never silently moves a downgrade."""
    if "@" in keg:
        print(f"[orcha] host CLI is pinned to versioned formula {keg} — skipping "
              f"self-upgrade (to track releases again: brew uninstall {keg} && "
              "brew install open-orcha/orcha/orcha).")
        return False
    brew = shutil.which("brew")
    if not brew:
        print("[orcha] warn: Homebrew install detected but `brew` is not on PATH; "
              "fix your PATH (or reinstall Homebrew), then "
              "`brew upgrade open-orcha/orcha/orcha`.", file=sys.stderr)
        return False
    cmd = [brew, "upgrade", f"open-orcha/orcha/{keg}"]
    print(f"[orcha] upgrading host CLI via Homebrew\n        $ {' '.join(cmd)}")
    try:
        return subprocess.run(cmd).returncode == 0
    except (OSError, subprocess.SubprocessError) as e:
        print(f"[orcha] warn: could not launch brew ({e})", file=sys.stderr)
        return False


def cmd_update(args: argparse.Namespace) -> None:
    """Apply the host and project update phases through the compatibility entrypoint."""
    from orcha_cli.cli_update import update_command

    update_command(
        args,
        source_root=_cli_source_root,
        brew_keg=_brew_keg,
        reinstall_cli=_reinstall_cli,
        brew_upgrade=_brew_upgrade,
        upgrade=cmd_upgrade,
        ensure_notifier=ensure_daemon,
    )


def cmd_status(_: argparse.Namespace) -> None:
    orcha_dir = pathlib.Path.cwd() / ".orcha"
    config_path = pathlib.Path.cwd() / ".claude" / "orcha.json"
    if not config_path.exists():
        sys.exit("error: no .claude/orcha.json — run `orcha init` first")

    config = json.loads(config_path.read_text())
    print(f"project:              {config.get('project_name', '?')}")
    print(f"api base URL:         {config.get('api_base_url', '?')}")
    print(f"db port:              {config.get('db_port', '?')}")
    print(f"current container_id: {config.get('current_container_id', '(none — run /orcha-container)')}")
    print()

    if (orcha_dir / "docker-compose.yml").exists():
        _compose(orcha_dir, "ps")
        print()
        print(f"tail logs:  docker compose -f {orcha_dir / 'docker-compose.yml'} logs -f")
        print(f"db shell:   docker compose -f {orcha_dir / 'docker-compose.yml'} exec db psql -U orcha -d orcha")


def cmd_ls(_: argparse.Namespace) -> None:
    """List running orcha-* Docker compose stacks, each with its (single) container.

    Stack:db:container is 1:1:1 — so each row shows the one container's name + status
    by querying that stack's /api/containers endpoint. Use `orcha connect <project>`
    from any folder to point that folder at one of these stacks.
    """
    stacks = _discover_stacks()
    if not stacks:
        print("no orcha stacks running. cd to a project and `orcha up`, or `orcha init` to bootstrap.")
        return

    header = f"{'PROJECT':<22} {'API':<28} {'DB':<6} {'CONTAINER':<28} {'STATUS':<10}"
    print(header)
    print("-" * len(header))
    for s in stacks:
        api_port = s["api_port"] or "?"
        db_port = s["db_port"] or "?"
        api_url = f"http://localhost:{api_port}/"
        container_name = "(none — run orcha init)"
        container_status = "-"
        if s["api_port"]:
            data = _get_json(f"http://localhost:{s['api_port']}/api/containers")
            if data and data.get("containers"):
                c = data["containers"][0]
                container_name = (c.get("name") or "(unnamed)")[:27]
                container_status = c.get("status") or "-"
        print(f"{s['project_short']:<22} {api_url:<28} {db_port:<6} "
              f"{container_name:<28} {container_status:<10}")


def _parse_host_port(ports_str: str, container_port: str) -> Optional[str]:
    """Extract host port from a docker ports string like '0.0.0.0:8001->8000/tcp, ...'."""
    for chunk in ports_str.split(","):
        chunk = chunk.strip()
        if f"->{container_port}/" in chunk and "0.0.0.0:" in chunk:
            try:
                return chunk.split("0.0.0.0:")[1].split("->")[0]
            except (IndexError, ValueError):
                pass
    return None


def _resolve_human_agent_id(cwd: pathlib.Path) -> str:
    """Resolve the acting human through the focused binding module."""
    return _cli_bindings.resolve_human_agent_id(cwd)


def _resolve_any_binding(
    cwd: pathlib.Path, alias_override: Optional[str] = None
) -> Optional[dict]:
    """Resolve any local agent binding without raising."""
    return _cli_bindings.resolve_any_binding(cwd, alias_override)


def _require_any_binding(
    cwd: pathlib.Path, alias_override: Optional[str], *, verb: str
) -> dict:
    """Require a binding while preserving the compatibility patch seam."""
    return _cli_bindings.require_any_binding(
        cwd, alias_override, verb=verb, services=sys.modules[__name__]
    )


def _watch_state_path(cwd: pathlib.Path, alias: str) -> pathlib.Path:
    return _cli_watch_state.watch_state_path(cwd, alias)


def _watch_pid_path(cwd: pathlib.Path, alias: str) -> pathlib.Path:
    return _cli_watch_state.watch_pid_path(cwd, alias)


def _read_watch_state(cwd: pathlib.Path, alias: str) -> dict:
    return _cli_watch_state.read_watch_state(cwd, alias, sys.modules[__name__])


def _atomic_write_json(path: pathlib.Path, data: dict) -> None:
    _cli_watch_state.atomic_write_json(path, data)


def _skip_managed_embodiment_hook(hook: str) -> bool:
    return _cli_watch_state.skip_managed_embodiment_hook(hook)


def cmd_watch(args: argparse.Namespace) -> None:
    """Run the background watcher through its focused workflow module."""
    _cli_watch.cmd_watch(args, sys.modules[__name__])


def cmd_unwatch(args: argparse.Namespace) -> None:
    """Stop background watchers through their focused workflow module."""
    _cli_watch.cmd_unwatch(args)


def _detect_tmux_target() -> Optional[str]:
    """Return this session's tmux pane through the focused hook module."""
    return _cli_hooks.detect_tmux_target()


def cmd_reachability(args: argparse.Namespace) -> None:
    """Record the current session's wake transport without breaking startup."""
    _cli_hooks.record_reachability(args, sys.modules[__name__])


def _write_hook_config(claude_dir: pathlib.Path) -> bool:
    """Install managed hooks while preserving existing settings entries."""
    return _cli_hooks.write_hook_config(claude_dir)


def cmd_enable_hook(_: argparse.Namespace) -> None:
    """Enable managed hooks in an existing connected workspace."""
    _cli_hooks.enable_hooks(sys.modules[__name__])


def cmd_poll_inbox(args: argparse.Namespace) -> None:
    """Surface events queued by the background watcher."""
    _cli_session_hooks.poll_inbox(args, sys.modules[__name__])


# GH #91/#90: the task-claim/mutation surface a CONVERSATION embodiment must NOT touch. Keyed by the
# skill's slash-name (SlashCommand tool passes it as tool_input.command). The conversation lane is a
# responder — it dispatches work (creates/assigns tasks, replies inline) but never claims/advances a
# task itself; that's the WORK lane's job. This is the SECONDARY floor — the server's _require_work_lane
# gate (a conversation token can't pass) is the PRIMARY one; this hook just gives the model a clean,
# early deny instead of letting it burn a turn on a call the server would 403.
_CONV_BLOCKED_SLASH = _cli_session_hooks.CONV_BLOCKED_SLASH
# File-mutating tools a conversation responder shouldn't reach for (it dispatches code work to a task,
# it doesn't do the edits itself). Dispatch + read + conversation-reply tools stay allowed.
_CONV_BLOCKED_TOOLS = _cli_session_hooks.CONV_BLOCKED_TOOLS
# PR R5: the ONE file surface a conversation embodiment must keep — its persistent Claude Code
# file-memory (~/.claude/projects/<project>/memory/...). A warm resident that can't write memory
# silently stops persisting what it learns across sessions; memory writes are self-bookkeeping,
# not the "code work" the lane guard exists to farm out.
_CONV_MEMORY_DIR_RE = _cli_session_hooks.CONV_MEMORY_DIR_RE


def _conv_is_memory_write(tool_input: dict) -> bool:
    """Return whether a write targets the conversation agent's own memory."""
    return _cli_session_hooks.is_memory_write(tool_input)


def cmd_conv_guard(_: argparse.Namespace) -> None:
    """Deny work-lane mutations from a conversation embodiment."""
    _cli_session_hooks.conversation_guard(sys.modules[__name__])


def _fmt_rehydrate_brief(b: dict) -> str:
    """Render the session-start continuity response."""
    return _cli_rehydrate.format_brief(b)


def cmd_rehydrate(args: argparse.Namespace) -> None:
    """Print the session-start continuity brief when available."""
    _cli_rehydrate.rehydrate(args, sys.modules[__name__])


def _live_boot_prefix(
    api_base: Optional[str], agent_id: Optional[str]
) -> Optional[str]:
    """Compatibility facade for cold-boot persona and conversation context."""
    from orcha_cli import cli_live

    return cli_live.live_boot_prefix(api_base, agent_id, get_json=_get_json)


from orcha_cli.cli_live import (  # public compatibility constants
    RUNTIME_CLAUDE,
    RUNTIME_CODEX,
    ORCHA_CLAUDE_EXEC,
    ORCHA_CODEX_EXEC,
)
from orcha_cli import cli_live as _cli_live

_CODEX_EXEC_FALLBACKS = _cli_live.CODEX_EXEC_FALLBACKS


def _normalize_runtime(runtime: Optional[str], model: Optional[str] = None) -> str:
    return _cli_live.normalize_runtime(runtime, model)


def _executable_override(env_var: str) -> Optional[str]:
    return _cli_live.executable_override(env_var)


def _runtime_executable(runtime: Optional[str]) -> str:
    return _cli_live.runtime_executable(runtime)


def _resolve_runtime_executable(runtime: Optional[str]) -> Optional[str]:
    return _cli_live.resolve_runtime_executable(
        runtime, fallbacks=_CODEX_EXEC_FALLBACKS
    )


def _build_live_argv(
    cold: bool,
    resume_sid: Optional[str],
    boot_prefix: Optional[str],
    model: Optional[str] = None,
    runtime: Optional[str] = None,
) -> list:
    return _cli_live.build_live_argv(cold, resume_sid, boot_prefix, model, runtime)


def _live_agent_launch(
    api_base: Optional[str], agent_id: Optional[str]
) -> tuple[Optional[str], str]:
    return _cli_live.live_agent_launch(api_base, agent_id, get_json=_get_json)


def _live_agent_model(
    api_base: Optional[str], agent_id: Optional[str]
) -> Optional[str]:
    """Return the server-resolved model used for a cold live boot."""
    return _live_agent_launch(api_base, agent_id)[0]


def _exec_live_session(
    cwd: pathlib.Path, alias: str, binding_file: pathlib.Path
) -> None:
    """Compatibility facade retaining the live-session monkeypatch seams."""
    _cli_live.exec_live_session(
        cwd,
        alias,
        binding_file,
        boot_prefix=_live_boot_prefix,
        agent_launch=_live_agent_launch,
        build_argv=_build_live_argv,
        resolve_executable=_resolve_runtime_executable,
        runtime_leaf=_runtime_executable,
        normalize=_normalize_runtime,
    )


def cmd_use(args: argparse.Namespace) -> None:
    """Print an alias export or become the selected live agent."""
    _cli_live.use_command(args, exec_session=_exec_live_session)


def cmd_terminal_bridge(args: argparse.Namespace) -> None:
    """Run or ensure the embedded-terminal websocket bridge."""
    from orcha_cli.cli_bridge import terminal_bridge_command

    terminal_bridge_command(args)


def _read_hook_stdin() -> dict:
    """SessionEnd/Stop hooks receive a JSON payload on stdin ({session_id,
    transcript_path, hook_event_name, ...}). Return it parsed, or {} when there's
    nothing to read (e.g. a manual `orcha snapshot` from a terminal). Never raises."""
    return _cli_transcript.read_hook_input(sys.stdin)


def _iter_transcript_records(transcript_path: Optional[str]):
    """Yield parsed JSONL records from a Claude Code transcript, oldest→newest.
    Silent (yields nothing) on any problem — callers degrade gracefully."""
    yield from _cli_transcript.iter_records(transcript_path)


def _rich_digest_posted_this_session(transcript_path: Optional[str], agent_id: str) -> bool:
    """C1 precedence: did the worker already author a RICH digest this session
    (via /orcha-snapshot, e.g. from /orcha-done)? We detect a POST to this agent's
    /digest endpoint anywhere in the transcript. If so, the SessionEnd fallback must
    NOT write a thin row that would shadow it (the digest table is append-only, so the
    latest row wins). Best-effort string match on the agent's own /digest call."""
    return _cli_transcript.rich_digest_posted(transcript_path, agent_id)


def _last_assistant_text_full(transcript_path: Optional[str]) -> Optional[str]:
    """The worker's LAST assistant text turn, whitespace-condensed but UNTRUNCATED.
    Shared by `_focus_from_transcript` (which trims to one line for the digest) and the
    GH #152 claim-scan (`_extract_claimed_task_ids`), which needs to see the whole reply —
    a 280-char summary could cut off a task id it must check. Returns None if nothing
    usable is found."""
    return _cli_transcript.last_assistant_text(transcript_path)


def _focus_from_transcript(transcript_path: Optional[str]) -> Optional[str]:
    """Best-effort current_focus: the worker's LAST assistant text turn, condensed to
    one line. These are the agent's OWN words (we extract, never synthesize) so the
    fallback digest stays agent-grounded. Returns None if nothing usable is found."""
    return _cli_transcript.focus_from_transcript(transcript_path)


# ---- GH #152: hard-fail a hallucinated task-creation claim ----------------------------
# An agent can narrate "I created/started task <id>" in its reply text without the
# underlying create-task/accept-task API call ever actually persisting (call skipped,
# failed silently, or the model's text ran ahead of the tool result). Below: a best-effort
# scan for that claim shape, cross-checked against the live container task list.
_TASK_CLAIM_VERB_RE = re.compile(
    r"\b(created|creating|spawned|spawning|started|starting|accepted|in_progress|assigned to me)\b",
    re.IGNORECASE,
)
# The word 'task' (optionally 'task id' or 'task_id') must sit DIRECTLY against the uuid —
# only a short run of separator chars between them — not merely "somewhere nearby" in the
# sentence. That's what keeps "created request <id> for task follow-up" from being swept
# in: 'task' does appear in that sentence, but not adjacent to <id>, so it must never match
# it. Review-round-3: `\btask\b` alone never matches "task_id" — '_' is a word character, so
# there is no boundary between "task" and "_id" — which missed the orcha-task-new skill's
# own success-report phrasing ("task_id: <uuid>"). `(?:[\s_]id)?` covers both the space and
# underscore spellings, and '=' joins the separator class for "task_id=<uuid>".
_TASK_CLAIM_ADJACENT_RE = re.compile(
    r"\btask(?:[\s_]id)?\b[\s:#=-]{0,3}"
    r"([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})\b",
    re.IGNORECASE,
)
# Review-round-4: the orcha-task-new skill's own step-6 success report is TERSE and has
# no creation verb at all — just "task_id: <uuid>, status: ready" (or pending/in_progress)
# — so requiring a verb-bearing sentence (above) silently let that exact skill-taught
# phrasing through. This second pattern recognizes that shape on its own terms: a
# task-id-adjacent uuid followed, within a short run of the same line, by a
# "status: ready|pending|in_progress" field. That status field IS the claim — the skill
# only ever prints it after a confirmed 2xx create/accept — so no separate verb is needed.
# Review-round-5: step 6 is reported as a bulleted list ("- task_id: ...", "- status:
# ..."), one field per line, which is the MORE common shape than the single-line form —
# so task_id and status usually sit on ADJACENT lines, not the same line. The gap below
# allows the field to fall on the same line OR up to two short lines further down (each
# capped at 60 chars, so it still can't reach across an unrelated block of text further
# into a long reply) to cover both the plain-multiline and the bulleted-list renderings.
_TERSE_STATUS_GAP = r"[^\n]{0,60}(?:\n[ \t]{0,4}(?:[-*•]\s*)?[^\n]{0,60}){0,2}?"
_TASK_ID_TERSE_STATUS_RE = re.compile(
    r"\btask(?:[\s_]id)?\b[\s:#=-]{0,3}"
    r"([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})\b"
    rf"{_TERSE_STATUS_GAP}\bstatus\b\s*[:=]\s*(?:ready|pending|in_progress)\b",
    re.IGNORECASE,
)
_SENTENCE_SPLIT_RE = re.compile(r"(?<=[.!?])\s+|\n+")
# Markdown/code-formatted ids (review-round-4): an agent reporting `task_id: `<uuid>`` or
# wrapping the whole claim in a code span would otherwise dodge both patterns above purely
# because of the extra backtick characters between the label and the uuid. Backticks carry
# no meaning for claim detection, so they're stripped before either pattern runs.
_BACKTICK_RE = re.compile("`+")


def _extract_claimed_task_ids(text: Optional[str]) -> list:
    """Best-effort scan for 'task <uuid> created/started' style claims in an agent's own
    reply text (GH #152). A hit needs EITHER (a) a creation/start verb somewhere in the
    sentence AND the literal word 'task' (optionally 'task id') sitting DIRECTLY against
    the uuid, OR (b) the terse skill-taught 'task_id: <uuid>, status: ready|pending|
    in_progress' report shape (same line, or split across the next line/bullet — see
    review-round-5), which is itself a claim regardless of verb wording. Tight enough that
    an unrelated uuid in the same sentence (a request id, an agent id) never gets swept in
    just because the sentence also happens to use the word 'task' elsewhere (e.g. "created
    request <id> for task follow-up" must not flag <id>). Markdown/code backticks around
    the label or id are ignored. Returns deduped, lowercased uuids in first-seen order.
    Never raises."""
    if not text:
        return []
    found: list = []
    seen: set = set()
    normalized = _BACKTICK_RE.sub("", text)
    # Review-round-5: run over the whole (backtick-stripped) reply, not per-sentence —
    # `_SENTENCE_SPLIT_RE` splits on every newline, which is exactly where the task_id and
    # status fields of a bulleted/multiline report sit, so splitting first would hide the
    # match `_TASK_ID_TERSE_STATUS_RE` is meant to catch. The regex's own bounded gap keeps
    # this from reaching across an unrelated block further into a long reply.
    for m in _TASK_ID_TERSE_STATUS_RE.finditer(normalized):
        uid = m.group(1).lower()
        if uid not in seen:
            seen.add(uid)
            found.append(uid)
    for sentence in _SENTENCE_SPLIT_RE.split(normalized):
        if not _TASK_CLAIM_VERB_RE.search(sentence):
            continue
        for m in _TASK_CLAIM_ADJACENT_RE.finditer(sentence):
            uid = m.group(1).lower()
            if uid not in seen:
                seen.add(uid)
                found.append(uid)
    return found


def _flag_agent_digest(api_base: str, agent_id: str, warning: str) -> None:
    """Carry the prior digest forward (same convention as `cmd_snapshot`'s fallback) but
    override `current_focus` with the hard-fail warning, so the next `orcha rehydrate`
    can't miss it. Best-effort — swallows all errors, never raises."""
    prior: dict = {}
    try:
        got = _get_json(f"{api_base}/api/agents/{agent_id}/digest", timeout=4.0)
        if isinstance(got, dict) and isinstance(got.get("digest"), dict):
            prior = got["digest"]
    except Exception:
        prior = {}

    def _carry(key: str) -> list:
        v = prior.get(key)
        return list(v) if isinstance(v, list) else []

    prior_audience = prior.get("audience")
    audience = prior_audience if isinstance(prior_audience, str) and prior_audience else None
    open_threads = _carry("open_threads")
    flag = {"text": warning}
    if flag not in open_threads:
        open_threads.insert(0, flag)

    body = {
        "current_focus": warning,
        "decisions": _carry("decisions"),
        "learnings": _carry("learnings"),
        "open_threads": open_threads,
        "audience": audience,
    }
    try:
        _post_json(f"{api_base}/api/agents/{agent_id}/digest", body)
    except Exception:
        pass


def _flag_thread_or_escalate(api_base: str, cid: str, agent_id: str, alias: Optional[str],
                              listing: dict, warning: str) -> None:
    """Surface the hard-fail somewhere a human will see it: post to the agent's own live
    in_progress task thread if it has one, else escalate a new request straight to a
    human (an omitted `target_alias` is treated as escalated-to-human at birth — same
    convention `/orcha-ask` uses for `-`/`--human`). Best-effort, never raises."""
    live_task_id = None
    for t in (listing.get("tasks") or []):
        if alias and alias in (t.get("assignees") or []) and t.get("status") == "in_progress":
            live_task_id = t.get("id")
            break

    if live_task_id:
        try:
            _post_json(f"{api_base}/api/tasks/{live_task_id}/messages",
                       {"author_agent_id": agent_id, "body": warning})
            return
        except Exception:
            pass  # fall through to escalation

    try:
        _post_json(f"{api_base}/api/containers/{cid}/requests", {
            "requester_agent_id": agent_id,
            "payload": warning,
            "priority": 10,
            "type": "info",
        })
    except Exception:
        pass


def _fetch_task_listing_covering(api_base: str, cid: str, claimed_ids, timeout: float = 6.0,
                                  max_pages: int = 50) -> Optional[dict]:
    """GH #152 review-fix: `GET .../tasks` defaults to a 10-row page (100 max) — a single
    fetch can miss a real task that's simply further down the list, which would make the
    claim-guard hard-fail on a claim that actually persisted. Page through (100 rows/page)
    until every id in `claimed_ids` has been located or the list is exhausted, capped at
    `max_pages` as a runaway backstop against a server bug that never clears `has_more`
    (50 pages * 100 rows = 5000 tasks, far past anything a real container holds).

    Returns a single listing dict shaped like one page's response ({"tasks": [...]}) with
    every task seen so far, or None if the API is unreachable — same "don't false-alarm on
    an outage" contract the caller already relies on."""
    remaining = {str(tid).lower() for tid in claimed_ids}
    all_tasks: list = []
    offset = 0
    for _ in range(max_pages):
        page = _get_json(f"{api_base}/api/containers/{cid}/tasks?limit=100&offset={offset}",
                          timeout=timeout)
        if not isinstance(page, dict):
            return None
        tasks = page.get("tasks") or []
        all_tasks.extend(tasks)
        remaining -= {str(t.get("id") or "").lower() for t in tasks}
        if not remaining or not page.get("has_more") or not tasks:
            break
        offset += len(tasks)
    return {"tasks": all_tasks}


def cmd_task_claim_guard(args: argparse.Namespace) -> None:
    """GH #152 — SessionEnd audit: cross-check any 'I created/started task <id>' claim in
    the session's last reply against the live container task list, and hard-fail LOUDLY
    on a mismatch instead of letting a hallucinated tool result stand as a silent success
    narrative.

    Registered as a SessionEnd hook. Stop hooks don't fire for headless `claude -p`
    workers (see `cmd_snapshot`'s docstring) — the exact population most likely to
    hallucinate unattended — so SessionEnd is the only reliable place this can run, and it
    can't block the session from ending (SessionEnd hooks are fire-and-forget). "Hard
    fail" here means: unmissable on the NEXT wake (a digest override `orcha rehydrate`
    prints) and unmissable to a human (a task-thread message, or an escalated request
    when the agent has no live task to post on) — not a silently-swallowed log line.

    NEVER raises — a broken audit must not break the worker's teardown."""
    try:
        payload = _read_hook_stdin()
        transcript_path = payload.get("transcript_path")
        text = _last_assistant_text_full(transcript_path)
        claimed = _extract_claimed_task_ids(text)
        if not claimed:
            return  # nothing claimed this turn — fast, silent no-op; no API calls made

        cwd = pathlib.Path.cwd()
        config_path = cwd / ".claude" / "orcha.json"
        if not config_path.exists():
            return
        config = json.loads(config_path.read_text())
        api_base = config.get("api_base_url")
        if not api_base:
            return
        binding = _resolve_any_binding(cwd, getattr(args, "alias", None))
        if not binding:
            return
        agent_id = binding.get("agent_id")
        alias = binding.get("alias")
        cid = binding.get("container_id")
        if not (agent_id and cid):
            return

        listing = _fetch_task_listing_covering(api_base, cid, claimed, timeout=6.0)
        if listing is None:
            return  # can't reach the API — don't false-alarm on an outage
        real_ids = {str(t.get("id") or "").lower() for t in (listing.get("tasks") or [])}

        missing = [tid for tid in claimed if tid not in real_ids]
        if not missing:
            return  # every claim checks out — silent, as it should be

        warning = (
            f"⚠️ GH #152 HARD-FAIL: last session claimed task(s) {', '.join(missing)} — "
            f"NOT FOUND in the container's task list. That claim did not persist to the "
            f"DB. Do not trust it; re-verify via the container task list before "
            f"continuing or reporting it as real work."
        )
        print(f"[orcha] {warning}")

        _flag_agent_digest(api_base, agent_id, warning)
        _flag_thread_or_escalate(api_base, cid, agent_id, alias, listing, warning)
    except Exception:
        return


def cmd_snapshot(args: argparse.Namespace) -> None:
    """Epic C / C1 — digest write-on-exit for headless wake workers.

    Registered as a SessionEnd hook. A woken worker (notifier sets
    ORCHA_HEADLESS_WORKER=1) snapshots a continuity digest before exiting, so the
    next wake rehydrates (C2) what this one was doing. The RICH, agent-authored
    digest is written DURING the turn by /orcha-snapshot (e.g. via /orcha-done); to
    avoid shadowing it with a thin transcript-derived row, we SKIP when the
    transcript shows the agent already POSTed its /digest this session.

    Gated to headless workers ONLY — interactive human tabs author via the
    /orcha-snapshot skill and are unaffected (immediate no-op). NEVER raises and
    always exits 0: a SessionEnd hook that errors must not disrupt anything."""
    # Act ONLY inside an Orcha-managed embodiment whose continuity must be captured on exit:
    # a headless wake worker (ORCHA_HEADLESS_WORKER) OR an S3 live terminal session
    # (ORCHA_LIVE, set by the PTY bridge). Interactive human tabs (neither set) author via
    # /orcha-snapshot and no-op here. For the live session this is the best-effort SessionEnd
    # path; the bridge also drives a reliable pre-release drain-turn snapshot.
    if not (os.environ.get("ORCHA_HEADLESS_WORKER") or os.environ.get("ORCHA_LIVE")):
        return
    try:
        payload = _read_hook_stdin()
        transcript_path = payload.get("transcript_path")

        cwd = pathlib.Path.cwd()
        config_path = cwd / ".claude" / "orcha.json"
        if not config_path.exists():
            return
        config = json.loads(config_path.read_text())
        api_base = config.get("api_base_url")
        if not api_base:
            return
        binding = _resolve_any_binding(cwd, getattr(args, "alias", None))
        if not binding:
            return
        agent_id = binding.get("agent_id")
        alias = binding.get("alias") or agent_id
        if not agent_id:
            return

        if _rich_digest_posted_this_session(transcript_path, agent_id):
            print(f"[orcha] snapshot: {alias} already authored a digest this session — skipping fallback")
            return

        embodiment = "Live terminal session" if os.environ.get("ORCHA_LIVE") else "Headless wake worker"
        focus = _focus_from_transcript(transcript_path) or (
            f"{embodiment} exited without an explicit /orcha-snapshot this session."
        )
        # Carry forward the prior digest's accumulated reasoning. rehydrate reads ONLY
        # the latest row, so a thin fallback that posted empty decisions/learnings would
        # SHADOW an earlier wake's rich digest and erase it from rehydrate — defeating
        # "continuity accrues across wakes". We keep the prior non-empty lists and only
        # update current_focus to reflect this wake (+ a resume hint on open_threads).
        prior: dict = {}
        try:
            got = _get_json(f"{api_base}/api/agents/{agent_id}/digest", timeout=4.0)
            if isinstance(got, dict) and isinstance(got.get("digest"), dict):
                prior = got["digest"]
        except Exception:
            prior = {}

        def _carry(key: str) -> list:
            v = prior.get(key)
            return list(v) if isinstance(v, list) else []

        # #325: audience is free TEXT (the plain-language register), not a list. A thin
        # fallback that omitted it would write a latest digest WITHOUT audience, and since
        # rehydrate reads only the latest row the next wake would silently lose the
        # "who you're talking to" slice and revert to jargon. Carry the prior string
        # forward verbatim — this wake authored no new register, so the last one stands.
        prior_audience = prior.get("audience")
        audience = prior_audience if isinstance(prior_audience, str) and prior_audience else None

        resume_hint = {"text": "Resume: re-read the assigned task thread; "
                               "this wake ended without a detailed self-snapshot."}
        open_threads = _carry("open_threads")
        if resume_hint not in open_threads:
            open_threads.append(resume_hint)

        body = {
            "current_focus": focus,
            "decisions": _carry("decisions"),    # preserved from the prior rich digest
            "learnings": _carry("learnings"),     # (this thin wake authored none)
            "open_threads": open_threads,
            "audience": audience,                  # #325: carry the plain-language register
        }
        try:
            _post_json(f"{api_base}/api/agents/{agent_id}/digest", body)
            print(f"[orcha] snapshot: continuity digest written for {alias} (write-on-exit)")
        except Exception:
            return
    except Exception:
        # SessionEnd hook must never break the worker's teardown.
        return


def _parse_self_wake_delay(raw: str) -> int:
    return _cli_lifecycle.parse_self_wake_delay(raw)


def _read_project_api_base(cwd: pathlib.Path) -> str:
    return _cli_lifecycle.read_project_api_base(cwd)


def _self_wake_request(url: str, *, method: str, body: Optional[dict] = None) -> dict:
    return _cli_lifecycle.self_wake_request(url, method=method, body=body)


def cmd_self_wake(args: argparse.Namespace) -> None:
    """GH #122: schedule or cancel a one-shot task resume wake for the acting work agent."""
    _cli_lifecycle.self_wake_command(
        args,
        require_binding=_require_any_binding,
        parse_delay=_parse_self_wake_delay,
        read_api_base=_read_project_api_base,
        request=_self_wake_request,
    )


def _lifecycle_call(container_id: Optional[str], new_status: str, verb: str) -> None:
    _cli_lifecycle.lifecycle_call(
        container_id,
        new_status,
        verb,
        resolve_human_agent_id=_resolve_human_agent_id,
    )


def cmd_pause(args: argparse.Namespace) -> None:
    _lifecycle_call(args.container_id, "paused", "pause")


def cmd_resume(args: argparse.Namespace) -> None:
    _lifecycle_call(args.container_id, "active", "resume")


def cmd_stop(args: argparse.Namespace) -> None:
    new_status = "cancelled" if args.cancel else "completed"
    _lifecycle_call(args.container_id, new_status, "stop")


# ---------- entry ----------

def build_parser() -> argparse.ArgumentParser:
    """Build the public parser while keeping handler objects patchable in this module."""
    from .cli_parser import build_parser as assemble_parser

    handlers = {
        "init": cmd_init, "up": cmd_up, "down": cmd_down, "migrate": cmd_migrate,
        "upgrade": cmd_upgrade, "update": cmd_update, "status": cmd_status, "ls": cmd_ls,
        "connect": cmd_connect, "poll-inbox": cmd_poll_inbox, "conv-guard": cmd_conv_guard,
        "watch": cmd_watch, "unwatch": cmd_unwatch, "rehydrate": cmd_rehydrate, "use": cmd_use,
        "snapshot": cmd_snapshot, "task-claim-guard": cmd_task_claim_guard,
        "self-wake": cmd_self_wake, "reachability": cmd_reachability,
        "enable-hook": cmd_enable_hook, "notifier": cmd_notifier,
        "terminal-bridge": cmd_terminal_bridge, "pause": cmd_pause, "resume": cmd_resume,
        "stop": cmd_stop,
    }
    return assemble_parser(_cli_version(), handlers)


def main() -> None:
    args = build_parser().parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
