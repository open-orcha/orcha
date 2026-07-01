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
import secrets
import shutil
import socket
import subprocess
import sys
from typing import Optional

from orcha_cli.notifier import (  # Epic A: wake daemon / cron stopgap
    cmd_notifier, ensure_daemon, stop_daemon, stop_daemon_for_container)


PKG_ROOT = pkg_res.files("orcha_cli")
PKG_TEMPLATES = PKG_ROOT / "templates"

# #294 Item 1: secret_box master-key env var (must match secret_box._MASTER_ENV). The CLI
# auto-generates + persists one to .orcha/.env on up/upgrade so stored-key storage works
# out of the box; see _ensure_secret_key.
_MASTER_KEY_ENV = "ORCHA_SECRET_KEY"


# Pure-stdlib shared modules that the portal container imports top-level (`import <name>`) but
# whose single git source lives in the orcha_cli package (the host daemon imports them as
# `orcha_cli.<name>`). Copied into the portal build dir at scaffold so each file is never
# hand-maintained in two places — same single-source pattern as migrations.
#   * llm_util    (#290) — universal LLM client
#   * secret_box  (#294) — at-rest encryption for the per-container LLM API key
#   * digest_curate (#287) — write-side digest dedup + boot-copy trim
_PORTAL_SHARED_MODULES = ("llm_util.py", "secret_box.py", "digest_curate.py",
                          "auth_tokens.py")


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

def _sanitize_name(s: str) -> str:
    out = "".join(c if (c.isalnum() or c in "-_") else "-" for c in s.lower())
    return out.strip("-") or "orcha"


def _find_free_port(start: int, span: int = 100) -> int:
    for port in range(start, start + span):
        try:
            with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
                s.bind(("127.0.0.1", port))
                return port
        except OSError:
            continue
    raise SystemExit(f"error: no free port in range {start}..{start + span}")


def _copy_tree(src, dst: pathlib.Path) -> None:
    """Recursively copy from a Traversable (importlib.resources) to a Path."""
    dst.mkdir(parents=True, exist_ok=True)
    for item in src.iterdir():
        target = dst / item.name
        if item.is_dir():
            _copy_tree(item, target)
        else:
            target.write_bytes(item.read_bytes())


def _strip_frontmatter(text: str) -> str:
    if not text.startswith("---\n"):
        return text
    end = text.find("\n---", 4)
    if end < 0:
        return text
    rest = text.find("\n", end + 4)
    return text[rest + 1:] if rest >= 0 else ""


def _frontmatter_value(text: str, key: str) -> Optional[str]:
    if not text.startswith("---\n"):
        return None
    end = text.find("\n---", 4)
    if end < 0:
        return None
    prefix = key + ":"
    for raw in text[4:end].splitlines():
        line = raw.strip()
        if line.startswith(prefix):
            return line[len(prefix):].strip().strip("\"'")
    return None


def _codex_skill_body(name: str, command_md: str) -> str:
    desc = _frontmatter_value(command_md, "description") or f"Run the Orcha {name} workflow."
    body = _strip_frontmatter(command_md).strip()
    return (
        "---\n"
        f"name: {name}\n"
        f"description: {json.dumps(desc)}\n"
        "---\n\n"
        f"# {name}\n\n"
        f"This is the Codex skill mirror of the Claude Code `/{name}` command.\n\n"
        "When invoked from Codex, treat any inline text after the skill mention as the "
        "`$ARGUMENTS` referenced below. If the copied command template mentions "
        "`AskUserQuestion`, ask the user a concise clarifying question directly. When it "
        "suggests another `/orcha-*` slash command, use the matching `$orcha-*` Codex skill.\n\n"
        f"{body}\n"
    )


def _install_orcha_skill_templates(project_root: pathlib.Path) -> tuple[pathlib.Path, pathlib.Path]:
    """Install Orcha command prompts for Claude Code and Codex into this workspace."""
    claude_commands = project_root / ".claude" / "commands"
    codex_skills = project_root / ".agents" / "skills"
    claude_commands.mkdir(parents=True, exist_ok=True)
    codex_skills.mkdir(parents=True, exist_ok=True)
    for md_file in (PKG_TEMPLATES / "skills").iterdir():
        if not md_file.name.endswith(".md"):
            continue
        command_md = md_file.read_text()
        claude_name = md_file.name
        skill_name = md_file.name[:-3]
        (claude_commands / claude_name).write_text(command_md)
        skill_dir = codex_skills / skill_name
        skill_dir.mkdir(parents=True, exist_ok=True)
        (skill_dir / "SKILL.md").write_text(_codex_skill_body(skill_name, command_md))
    return claude_commands, codex_skills


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
    prefs_path = project_root / "docs" / "orcha-project-preferences.md"
    if prefs_path.exists():
        return None
    prefs_path.parent.mkdir(parents=True, exist_ok=True)
    prefs_path.write_text((PKG_TEMPLATES / "project-preferences.md").read_text())
    return prefs_path


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
    if os.environ.get(_MASTER_KEY_ENV):
        return  # operator-provided — respect it, don't persist or override
    env_file = orcha_dir / ".env"
    persisted = _read_env_file_value(env_file, _MASTER_KEY_ENV)
    if persisted:
        os.environ[_MASTER_KEY_ENV] = persisted
        # A previously-persisted key may live in a .env that pre-dates the 0600 clamp (e.g. a
        # hand-created 0644 file, or one written before _append_env_file tightened on every
        # append). The mint path clamps; this load path never appends, so tighten here too —
        # otherwise a world-readable secret survives, contradicting the 0600 we advertise.
        _tighten_env_file(env_file)
        return
    key = secrets.token_urlsafe(32)
    try:
        _append_env_file(env_file, _MASTER_KEY_ENV, key)
        print(f"[orcha] generated a secret_box master key ({_MASTER_KEY_ENV}) and persisted it to "
              f"{env_file} (0600) — encrypted at-rest storage of per-container LLM keys is enabled.")
    except OSError as e:
        # Couldn't persist — still export for THIS run so up works, but warn it won't survive
        # (a key that changes between runs makes previously-stored blobs un-decryptable).
        print(f"[orcha] WARNING: could not persist {_MASTER_KEY_ENV} to {env_file} ({e}); using an "
              f"ephemeral key for this run only — stored LLM keys won't survive a restart.")
    os.environ[_MASTER_KEY_ENV] = key


def _read_env_file_value(env_file: pathlib.Path, name: str) -> Optional[str]:
    """Read ``NAME=value`` from a dotenv-style file (first match wins). None if absent/unreadable."""
    try:
        for line in env_file.read_text().splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            if k.strip() == name:
                return v.strip()
    except OSError:
        return None
    return None


def _append_env_file(env_file: pathlib.Path, name: str, value: str) -> None:
    """Append ``NAME=value`` to ``.orcha/.env``, creating it 0600. Raises OSError on failure.

    The file holds secrets for compose interpolation, so its mode is clamped to 0600 after
    EVERY append — including when it pre-existed at a laxer mode (e.g. a hand-created 0644 .env
    that now gathers a generated ORCHA_SECRET_KEY). Clamping only on creation would leave a
    world-readable secret on disk, contradicting the 0600 we advertise."""
    env_file.parent.mkdir(parents=True, exist_ok=True)
    existed = env_file.exists()
    with env_file.open("a", encoding="utf-8") as fh:
        if not existed:
            fh.write("# Generated by `orcha` — secrets for docker compose interpolation. "
                     "Do NOT commit.\n")
        fh.write(f"{name}={value}\n")
    # Clamp to 0600 whether or not the file pre-existed — we just wrote a secret into it.
    _tighten_env_file(env_file)


def _tighten_env_file(env_file: pathlib.Path) -> None:
    """Clamp ``.orcha/.env`` to 0600. Best-effort: a missing file or chmod failure (e.g. an
    unsupported filesystem) is swallowed — the env holds secrets but losing the tightening must
    not break ``up``."""
    try:
        env_file.chmod(0o600)
    except OSError:
        pass


def _compose(orcha_dir: pathlib.Path, *args: str, check: bool = True, capture: bool = False) -> subprocess.CompletedProcess:
    if "up" in args:
        # SSE: the portal bind-mounts the host wake-log dir (../.claude/.orcha-wakes). Create
        # it (as the user) BEFORE `compose up`, else on Linux Docker creates the missing bind
        # source as ROOT and the user-space notifier can't write logs → spawn_headless falls
        # back to DEVNULL and SSE + reap-time capture both go silently empty.
        try:
            (orcha_dir.parent / ".claude" / ".orcha-wakes").mkdir(parents=True, exist_ok=True)
        except OSError:
            pass
        # #301: the portal bind-mounts a WRITABLE attachments dir (../.claude/.orcha-attachments)
        # where it writes task-message file uploads. Same rationale as .orcha-wakes above —
        # create it (as the user) BEFORE `compose up` so Linux doesn't bind-create the missing
        # source as ROOT, which would make the portal's user-space uploads fail with EACCES.
        try:
            (orcha_dir.parent / ".claude" / ".orcha-attachments").mkdir(parents=True, exist_ok=True)
        except OSError:
            pass
        # #294 Item 1: ensure the secret_box master key exists + is exported so the portal env
        # gets it on this up (init / up / upgrade all funnel through here).
        _ensure_secret_key(orcha_dir)
    cmd = ["docker", "compose", "-f", str(orcha_dir / "docker-compose.yml"), *args]
    return subprocess.run(cmd, check=check, capture_output=capture, text=capture)


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
    project_root = pathlib.Path.cwd()
    orcha_dir = project_root / ".orcha"
    claude_config = project_root / ".claude" / "orcha.json"
    tabs_dir = project_root / ".claude" / "orcha-tabs"
    # #255: the container this checkout was bound to BEFORE this (re-)init — captured before
    # step 4 overwrites orcha.json. On `--reset-data` its daemon + tab bindings are now stale.
    old_container_id: Optional[str] = None
    if claude_config.exists():
        try:
            old_container_id = json.loads(claude_config.read_text()).get("current_container_id")
        except (OSError, ValueError):
            old_container_id = None

    if orcha_dir.exists() and not args.force:
        sys.exit("error: .orcha/ already exists; pass --force to overwrite")

    project_name = _sanitize_name(args.name or project_root.name)
    db_port = args.db_port or _find_free_port(start=5432)
    api_port = args.api_port or _find_free_port(start=8000)
    # ISS-84/#235: the live-terminal bridge port must be per-project too — api_port/db_port
    # already are, but the bridge port was a fixed 8765 constant, so a 2nd project's browser
    # dialled the 1st project's bridge (auth against the wrong container -> 4403). Scan starts
    # at 8765 so the first project keeps the familiar port; only 2nd+ shift.
    bridge_port = args.bridge_port or _find_free_port(start=8765)
    api_base = f"http://localhost:{api_port}"

    # Orcha#30: figure out who the first human is.
    human_alias = args.as_user or os.environ.get("USER") or "operator"
    human_alias = human_alias.strip() or "operator"

    # 1. Render docker-compose template
    template_text = (PKG_TEMPLATES / "docker-compose.yml.j2").read_text()
    rendered = (
        template_text
        .replace("{{ project_name }}", project_name)
        .replace("{{ db_port }}", str(db_port))
        .replace("{{ api_port }}", str(api_port))
        .replace("{{ bridge_port }}", str(bridge_port))
    )
    orcha_dir.mkdir(parents=True, exist_ok=True)
    (orcha_dir / "docker-compose.yml").write_text(rendered)

    # 2. Copy migrations/ and portal/
    _copy_tree(PKG_TEMPLATES / "migrations", orcha_dir / "migrations")
    _copy_tree(PKG_TEMPLATES / "portal", orcha_dir / "portal")
    _install_llm_util(orcha_dir)  # #290 llm_util + #294 secret_box + #287 digest_curate into portal build

    # 3. Copy Orcha command templates for Claude Code and Codex.
    claude_commands, codex_skills = _install_orcha_skill_templates(project_root)

    # 3b. #298: materialize the project-preferences file (loosely-hardened gh/git rules agents
    #     read). Packaged template → docs/orcha-project-preferences.md, so every project gets it
    #     at init regardless of install method. The autonomy LEVEL is never written here (DB-only).
    prefs_path = _install_project_preferences(project_root)
    if prefs_path:
        print(f"[orcha] wrote {prefs_path} (loosely-hardened project rules — commit it)")

    # 4. Write .claude/orcha.json (preserve current_container_id if present + --force)
    existing: dict = {}
    if claude_config.exists() and args.force:
        try:
            existing = json.loads(claude_config.read_text())
        except Exception:
            existing = {}
    config = {
        "api_base_url": api_base,
        "project_name": project_name,
        "api_port": api_port,
        "db_port": db_port,
        "bridge_port": bridge_port,
    }
    claude_config.parent.mkdir(parents=True, exist_ok=True)
    claude_config.write_text(json.dumps(config, indent=2) + "\n")

    # 4b. Orcha#33: register the PostToolUse poll-inbox hook so working agents
    #     notice incoming asks within ~5s. Idempotent w.r.t. existing settings.json.
    _write_hook_config(claude_config.parent)

    # 4c. --reset-data: drop this project's Postgres volume for a PRISTINE start.
    #     Without it, `init --force` REUSES the existing named volume
    #     (orcha-<project>_pgdata), so the previous container + all agents/tasks/
    #     requests survive and create_container 409s on re-init (Tim's reset task).
    #     `down -v` removes the volume → fresh initdb on the next `up` → empty DB.
    #     Explicit flag ONLY — init NEVER wipes data implicitly. The just-written
    #     compose file names the same project, so this targets the right volume.
    if args.reset_data:
        print(f"[orcha] --reset-data: dropping DB volume for project '{project_name}' "
              f"(DESTRUCTIVE — wiping all prior data) ...")
        _compose(orcha_dir, "down", "-v", check=False)

    # 5. docker compose up
    print(f"[orcha] starting stack '{project_name}' on api={api_port}, db={db_port} ...")
    _compose(orcha_dir, "up", "-d", "--build")

    # 6. Wait for portal readiness — the next two API calls need it up.
    if not args.no_container:
        _wait_for_portal(api_base)

    # 7. Orcha#29: bootstrap the container.
    container_id: Optional[str] = None
    if args.no_container:
        print("[orcha] --no-container set; skipping container creation.")
    else:
        objective = (args.objective or "").strip()
        if not objective:
            # Default to the project name as the objective; can be renamed later.
            objective = project_root.name
            print(f"[orcha] no --objective; defaulting to '{objective}' (rename later via API).")
        try:
            data = _post_json(f"{api_base}/api/containers", {"name": objective})
            container_id = data["container_id"]
            config["current_container_id"] = container_id
            claude_config.write_text(json.dumps(config, indent=2) + "\n")
            print(f"[orcha] ✓ container created: {container_id}  name='{objective}'")
        except Exception as e:
            msg = str(e)
            # The stack already had a container (init --force reuses the volume by
            # design). Don't silently wipe — point the user at the explicit reset.
            if "already has a container" in msg or "409" in msg:
                sys.exit(
                    "error: this stack already has a container; its data was preserved.\n"
                    "  `orcha init --force` reuses the existing DB volume by design.\n"
                    "  To start COMPLETELY fresh (wipes all agents/tasks/requests):\n"
                    "      orcha init --force --reset-data\n"
                    "  …or drop the volume manually first:  orcha down -v && orcha init"
                )
            sys.exit(f"error: container creation failed: {e}")

    # 8. Orcha#30: register the first human agent (kind='human').
    if container_id is not None:
        try:
            data = _post_json(
                f"{api_base}/api/containers/{container_id}/agents",
                {
                    "alias": human_alias,
                    "role": "operator",
                    "kind": "human",
                    # prompt intentionally omitted — humans don't carry a system prompt
                },
            )
            human_agent_id = data["agent_id"]
            tabs_dir.mkdir(parents=True, exist_ok=True)
            binding = {
                "alias": human_alias,
                "agent_id": human_agent_id,
                "container_id": container_id,
                "kind": "human",
            }
            (tabs_dir / f"{human_alias}.json").write_text(
                json.dumps(binding, indent=2) + "\n"
            )
            print(f"[orcha] ✓ first human registered: {human_alias}  (agent_id {human_agent_id})")
        except Exception as e:
            print(f"[orcha] warn: human registration failed ({e}); register manually with /orcha-register-human")

    # 8a. #255: --reset-data host cleanup. The DB volume was dropped (step 4c) and a NEW
    #     container created, so anything on disk keyed to the OLD container is now stale:
    #     - tab bindings for the wiped fleet still carry the dead container_id → prune them
    #       (the fresh human binding, written just above with the NEW cid, is kept).
    #     - the daemon bound to the OLD container keeps polling a now-404 container forever;
    #       ensure_daemon(restart=True) below only stops the daemon for the NEW cid (orcha.json
    #       was overwritten in step 7), so stop the OLD one explicitly by its container id.
    if args.reset_data and old_container_id and old_container_id != container_id:
        pruned = _prune_stale_bindings(tabs_dir, container_id or "")
        if pruned:
            print(f"[orcha] --reset-data: pruned {pruned} stale tab binding(s) for the old container")
        if stop_daemon_for_container(old_container_id, quiet=True):
            print(f"[orcha] --reset-data: stopped the stale daemon bound to the old container")

    # 8b. Epic A: bring the wake daemon up with the workspace (ON by default).
    #     restart=True so a re-init binds the daemon to the JUST-created container
    #     (it resolves its container once at startup; a stale daemon would watch the
    #     old, dead container). Idempotent otherwise.
    try:
        ensure_daemon(project_root, restart=True)
    except Exception as e:
        print(f"[orcha] warn: notifier daemon didn't start ({e}); start it with `orcha notifier --ensure`")
    try:    # S3 §3b: bring the host-side live-terminal bridge up with the workspace too. restart=True
            # so a re-init binds a fresh bridge to the JUST-created container (mirrors the daemon).
        from orcha_cli.terminal_bridge import ensure_bridge
        ensure_bridge(project_root, restart=True)
    except Exception as e:
        print(f"[orcha] warn: terminal bridge didn't start ({e}); start it with `orcha terminal-bridge --ensure`")

    # 9. Report
    print()
    print(f"[orcha] ✓ initialized in {project_root}")
    print(f"        api:      {api_base}/")
    print(f"        db:       postgresql://orcha:orcha@localhost:{db_port}/orcha")
    print(f"        skills:   {claude_commands}")
    print(f"        codex:    {codex_skills}")
    print(f"        config:   {claude_config}")
    if container_id:
        print(f"        container_id: {container_id}")
    print()
    print("Next steps:")
    print(f"  1. In your shell:  export ORCHA_ALIAS={human_alias}")
    print( "     (so /orcha-* commands attribute actions to you without needing --alias every time)")
    print( "  2. Open Claude Code or Codex in this directory.")
    print( "  3. Register your first AI agent:")
    print(f"       /orcha-register-agent <Alias> --role \"...\" --prompt \"...\" [--initial-task \"...\" --task-dod \"...\"]")
    print( "  4. Inspect anytime:  /orcha-status in Claude or $orcha-status in Codex")


def _resolve_bridge_port(api_base: str) -> Optional[int]:
    """ISS-84/#235: ask the portal which terminal-bridge port it advertises, so a connected
    client binds the same per-project port. GET /api/terminal/config returns
    {"ws_url": "ws://127.0.0.1:<port>"}; we extract <port>. Best-effort: returns None if the
    portal is unreachable or the URL has no port (caller then omits bridge_port → 8765 fallback)."""
    import urllib.parse
    data = _get_json(f"{api_base}/api/terminal/config")
    if not data:
        return None
    ws_url = data.get("ws_url") or ""
    try:
        return urllib.parse.urlparse(ws_url).port
    except ValueError:
        return None


def cmd_connect(args: argparse.Namespace) -> None:
    """Orcha#28: adopt an existing stack from the CURRENT folder.

    Stack:db:container is 1:1:1, so "connect to a container" means "point this
    folder's .claude/orcha.json at a running stack's API." After this you can
    run any /orcha-* skill (e.g. /orcha-register-agent) from THIS folder and
    it lands in the named stack's DB. Optionally registers an additional
    human (kind='human') via --as <alias> in one shot.

    Does NOT create a .orcha/ directory — this folder is a client, not a host.
    """
    cwd = pathlib.Path.cwd()
    claude_dir = cwd / ".claude"
    claude_config = claude_dir / "orcha.json"
    tabs_dir = claude_dir / "orcha-tabs"

    project_short = _sanitize_name(args.project_name)
    stacks = _discover_stacks()
    match = next((s for s in stacks if s["project_short"] == project_short), None)
    if not match:
        available = ", ".join(s["project_short"] for s in stacks) or "(none)"
        sys.exit(
            f"error: no running stack named '{project_short}'.\n"
            f"  running stacks: {available}\n"
            f"  start one with `orcha up --project <name>` or `orcha init` in a fresh dir."
        )
    if not match["api_port"]:
        sys.exit(f"error: stack '{project_short}' is running but its portal port is unknown.")

    api_base = f"http://localhost:{match['api_port']}"

    # Refuse to clobber an existing local stack — if this folder ran `orcha init`,
    # it has its OWN docker-compose; connect would silently divert its skills to
    # someone else's stack.
    if (cwd / ".orcha").exists():
        sys.exit(
            f"error: this folder has its own .orcha/ stack — connecting would point "
            f"its skills at '{project_short}' instead of the local stack. "
            f"Either run this from a fresh folder, or remove .orcha/ first."
        )

    _wait_for_portal(api_base, timeout_s=5.0)

    # Verify a container actually exists in the target stack.
    data = _get_json(f"{api_base}/api/containers")
    if not data or not data.get("containers"):
        sys.exit(
            f"error: stack '{project_short}' has no container yet — run "
            f"`orcha init` in its owning folder first."
        )
    container = data["containers"][0]
    container_id = container["id"]

    # ISS-84/#235: resolve the REMOTE stack's per-project bridge port so this connected
    # folder's `terminal-bridge --ensure` (SessionStart hook, installed below) binds the
    # port the portal advertises — not the fixed 8765 fallback. The portal is the source of
    # truth: GET /api/terminal/config returns ws_url = ws://127.0.0.1:<bridge_port>, set from
    # the ORCHA_TERMINAL_WS_URL compose env. Without this, a connected client for a 2nd+
    # project would bind 8765 while the portal points elsewhere — the very collision #235 fixes.
    bridge_port = _resolve_bridge_port(api_base)

    # Lay down command templates so /orcha-* works in Claude and $orcha-* works in Codex.
    claude_commands, codex_skills = _install_orcha_skill_templates(cwd)

    # Write the client config. project_name + ports reflect the REMOTE stack so
    # cohabiting tools (e.g. `orcha status` in this folder) talk to the right one.
    config = {
        "api_base_url": api_base,
        "project_name": project_short,
        "api_port": match["api_port"],
        "db_port": match["db_port"],
        "current_container_id": container_id,
        "connected": True,  # client-only marker — distinguishes from a host folder
    }
    if bridge_port:
        config["bridge_port"] = bridge_port
    claude_config.parent.mkdir(parents=True, exist_ok=True)
    claude_config.write_text(json.dumps(config, indent=2) + "\n")
    tabs_dir.mkdir(parents=True, exist_ok=True)

    # Orcha#33: register the poll-inbox PostToolUse hook here too. A connected
    # folder typically registers AI agents (via /orcha-register-agent) that
    # benefit from the same near-real-time inbox surfacing.
    _write_hook_config(claude_config.parent)

    # Optional: register an additional human in one step.
    human_agent_id: Optional[str] = None
    human_alias = (args.as_user or "").strip() or None
    if human_alias:
        try:
            resp = _post_json(
                f"{api_base}/api/containers/{container_id}/agents",
                {"alias": human_alias, "role": "operator", "kind": "human"},
            )
            human_agent_id = resp["agent_id"]
            binding = {
                "alias": human_alias,
                "agent_id": human_agent_id,
                "container_id": container_id,
                "kind": "human",
            }
            (tabs_dir / f"{human_alias}.json").write_text(
                json.dumps(binding, indent=2) + "\n"
            )
            print(f"[orcha] ✓ registered as human '{human_alias}' (agent_id {human_agent_id})")
        except Exception as e:
            print(
                f"[orcha] warn: --as registration failed ({e}); "
                f"add yourself manually with /orcha-register-human"
            )

    print()
    print(f"[orcha] ✓ connected '{cwd}' → stack '{project_short}'")
    print(f"        api:           {api_base}/")
    print(f"        container:     {container.get('name')}  ({container_id})")
    print(f"        config:        {claude_config}")
    print(f"        skills:        {claude_commands}")
    print(f"        codex:         {codex_skills}")
    print()
    print("Next steps:")
    if human_agent_id:
        print(f"  1. export ORCHA_ALIAS={human_alias}  (in your shell, for sticky identity)")
        print( "  2. Open Claude Code or Codex here and use Orcha commands as usual.")
    else:
        print( "  1. Register yourself as a human (recommended for cross-folder collab):")
        print( "       /orcha-register-human <YourName>")
        print( "  2. Or register an AI agent now:")
        print( "       /orcha-register-agent <Alias> --role \"...\" --prompt \"...\"")


def _wait_for_portal(api_base: str, timeout_s: float = 30.0) -> None:
    """Block until the portal returns 200 on GET / (or timeout)."""
    import urllib.error
    import urllib.request
    import time as _time
    deadline = _time.time() + timeout_s
    last_err: Optional[Exception] = None
    while _time.time() < deadline:
        try:
            with urllib.request.urlopen(f"{api_base}/", timeout=2) as _:
                return
        except Exception as e:  # URLError, ConnectionRefused, etc.
            last_err = e
            _time.sleep(0.5)
    raise SystemExit(f"error: portal didn't come up within {timeout_s}s: {last_err}")


def _post_json(url: str, body: dict) -> dict:
    """Tiny urllib POST helper; returns parsed JSON. Raises on non-2xx."""
    import urllib.error
    import urllib.request
    req = urllib.request.Request(
        url,
        data=json.dumps(body).encode(),
        method="POST",
        headers={"Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            return json.loads(resp.read())
    except urllib.error.HTTPError as e:
        raise RuntimeError(f"HTTP {e.code} {e.read().decode(errors='replace')[:500]}") from e


def _get_json(url: str, timeout: float = 5.0) -> Optional[dict]:
    """Tiny urllib GET → JSON helper. Returns None on connection/HTTP error.

    Used by `orcha ls` to enrich the stack listing with container info — a
    silent fall-through is intentional so an unreachable stack still appears
    in the table (its row just won't show the container columns).
    """
    import urllib.error
    import urllib.request
    try:
        with urllib.request.urlopen(url, timeout=timeout) as resp:
            return json.loads(resp.read())
    except (urllib.error.URLError, urllib.error.HTTPError, ValueError):
        return None


def _discover_stacks() -> list[dict]:
    """Find all running orcha-* docker compose stacks on this host.

    Returns a list of dicts: {project, project_short, api_port, db_port,
    portal_status}. Cross-folder discovery (Orcha#28) — used by both
    `orcha ls` and `orcha connect`.
    """
    result = subprocess.run(
        ["docker", "ps", "--format",
         "{{.Names}}\t{{.Status}}\t{{.Ports}}\t{{.Label \"com.docker.compose.project\"}}"],
        capture_output=True, text=True, check=False,
    )
    if result.returncode != 0:
        sys.exit(f"error running docker ps:\n{result.stderr}")

    from collections import defaultdict
    by_project: dict[str, list[tuple[str, str, str]]] = defaultdict(list)
    for ln in result.stdout.splitlines():
        parts = ln.split("\t")
        if len(parts) < 4:
            continue
        name, status, ports, project = parts
        if project.startswith("orcha-"):
            by_project[project].append((name, status, ports))

    out: list[dict] = []
    for project in sorted(by_project):
        api_port = None
        db_port = None
        portal_status = ""
        for name, status, ports in by_project[project]:
            if "portal" in name:
                portal_status = status
                api_port = _parse_host_port(ports, "8000")
            elif "db" in name:
                db_port = _parse_host_port(ports, "5432")
        out.append({
            "project": project,
            "project_short": project.removeprefix("orcha-"),
            "api_port": api_port,
            "db_port": db_port,
            "portal_status": portal_status,
        })
    return out


def _full_project(project_name: str) -> str:
    """Always prepend 'orcha-' to match what `orcha ls` displays.

    `orcha ls` always strips ONE leading 'orcha-' from the docker compose project name
    for display, so users who type the displayed name need the prefix added back.
    Whatever they type, we wrap with 'orcha-'.
    """
    return f"orcha-{project_name}"


def _by_project(project_name: str, *args: str) -> None:
    """Run `docker compose -p orcha-<name> <args...>` from anywhere."""
    cmd = ["docker", "compose", "-p", _full_project(project_name), *args]
    subprocess.run(cmd, check=True)


def _project_exists(project_name: str) -> bool:
    """Check if a docker compose project with that name has containers."""
    result = subprocess.run(
        ["docker", "ps", "-a",
         "--filter", f"label=com.docker.compose.project={_full_project(project_name)}",
         "--format", "{{.Names}}"],
        capture_output=True, text=True, check=False,
    )
    return bool(result.stdout.strip())


def cmd_up(args: argparse.Namespace) -> None:
    if args.project:
        if not _project_exists(args.project):
            sys.exit(
                f"error: no docker compose project named '{_full_project(args.project)}' found. "
                f"Run `orcha ls` to see available projects, or `orcha init` in a fresh dir."
            )
        _by_project(args.project, "up", "-d")
        return
    orcha_dir = pathlib.Path.cwd() / ".orcha"
    if not (orcha_dir / "docker-compose.yml").exists():
        sys.exit(
            "error: no .orcha/docker-compose.yml here — run `orcha init` first, "
            "or pass `--project <name>` to target a specific stack from anywhere."
        )
    _compose(orcha_dir, "up", "-d")
    # #298: backfill the project-preferences file if a pre-#298 project is missing it.
    prefs_path = _install_project_preferences(pathlib.Path.cwd())
    if prefs_path:
        print(f"[orcha] backfilled {prefs_path} (#298 loosely-hardened project rules)")
    # Epic A: relaunching the workspace brings the wake daemon back up too.
    try:
        ensure_daemon(pathlib.Path.cwd())
    except Exception as e:
        print(f"[orcha] warn: notifier daemon didn't start ({e}); start it with `orcha notifier --ensure`")
    try:    # S3 §3b: and the host-side live-terminal bridge
        from orcha_cli.terminal_bridge import ensure_bridge
        ensure_bridge(pathlib.Path.cwd())
    except Exception as e:
        print(f"[orcha] warn: terminal bridge didn't start ({e}); start it with `orcha terminal-bridge --ensure`")


def cmd_down(args: argparse.Namespace) -> None:
    extra = ["-v"] if args.volumes else []
    # Epic A: the wake daemon dies with the stack — otherwise a daemon would keep
    # polling a DB that's going away (and, with -v, a wiped one). Best-effort, local
    # cwd only (a --project down from elsewhere can't locate that project's pidfile).
    try:
        stop_daemon(pathlib.Path.cwd())
    except Exception:
        pass
    try:    # S3 §3b: the live-terminal bridge dies with the stack too (else it holds the port +
            # points at a going-away DB; the portal would still advertise its ws URL).
        from orcha_cli.terminal_bridge import stop_bridge
        stop_bridge(pathlib.Path.cwd())
    except Exception:
        pass
    if args.project:
        if not _project_exists(args.project):
            sys.exit(
                f"error: no docker compose project named '{_full_project(args.project)}' found. "
                f"Run `orcha ls` to see available projects."
            )
        _by_project(args.project, "down", *extra)
        return
    orcha_dir = pathlib.Path.cwd() / ".orcha"
    if not (orcha_dir / "docker-compose.yml").exists():
        sys.exit(
            "error: no .orcha/docker-compose.yml here — nothing to bring down. "
            "Pass `--project <name>` to target a specific stack from anywhere."
        )
    _compose(orcha_dir, "down", *extra)


def cmd_migrate(_: argparse.Namespace) -> None:
    """R1: apply pending DB migrations on demand (the portal also runs them on startup,
    so `orcha up` already migrates; this is the explicit, on-demand path)."""
    cwd = pathlib.Path.cwd()
    config_path = cwd / ".claude" / "orcha.json"
    if not config_path.exists():
        sys.exit("error: no .claude/orcha.json — run `orcha init` first")
    api_base = json.loads(config_path.read_text()).get("api_base_url")
    if not api_base:
        sys.exit("error: api_base_url missing from .claude/orcha.json")
    try:
        data = _post_json(f"{api_base}/api/admin/migrate", {})
    except Exception as e:
        sys.exit(f"error: migrate request failed ({e}); is the stack up? (`orcha up`)")
    applied = data.get("applied") or []
    print(f"[orcha] migrations applied: {applied}" if applied else "[orcha] schema already up to date")


def cmd_upgrade(args: argparse.Namespace) -> None:
    """Upgrade an EXISTING project to the installed CLI's templates WITHOUT a data wipe.

    Re-renders docker-compose.yml (ports/name preserved from .claude/orcha.json), re-copies
    portal/ + migrations/ + skills, then rebuilds the portal. This is the upgrade story for
    features that change the portal/compose (e.g. R1's migration runner + the portal mount):
    `orcha up` can only migrate an existing volume AFTER the portal is on the new build+compose,
    which this delivers. Data is preserved (no `down -v`); pending migrations then apply on the
    portal's startup (or `orcha migrate`).
    """
    cwd = pathlib.Path.cwd()
    orcha_dir = cwd / ".orcha"
    config_path = cwd / ".claude" / "orcha.json"
    if not (orcha_dir / "docker-compose.yml").exists() or not config_path.exists():
        sys.exit("error: no .orcha/ + .claude/orcha.json here — `orcha upgrade` is for an "
                 "existing project (run `orcha init` to bootstrap a new one).")
    cfg = json.loads(config_path.read_text())
    project_name = cfg.get("project_name") or _sanitize_name(cwd.name)
    db_port, api_port = cfg.get("db_port"), cfg.get("api_port")
    if not db_port or not api_port:
        sys.exit("error: db_port/api_port missing from .claude/orcha.json; re-init instead.")
    # ISS-84/#235: backfill the per-project bridge_port for projects created before this field
    # existed. Pick a free port (8765 scan-start so the first project keeps the familiar port),
    # persist it to orcha.json, and re-render it into the compose env below — keeping the
    # advertised ws URL and the bridge's actual bind in lockstep. The bridge is restarted at the
    # end so it rebinds to this port.
    bridge_port = cfg.get("bridge_port")
    if not bridge_port:
        bridge_port = _find_free_port(start=8765)
        cfg["bridge_port"] = bridge_port
        config_path.write_text(json.dumps(cfg, indent=2) + "\n")
        print(f"[orcha] backfilled per-project bridge_port={bridge_port} (ISS-84/#235)")
    rendered = (
        (PKG_TEMPLATES / "docker-compose.yml.j2").read_text()
        .replace("{{ project_name }}", project_name)
        .replace("{{ db_port }}", str(db_port))
        .replace("{{ api_port }}", str(api_port))
        .replace("{{ bridge_port }}", str(bridge_port))
    )
    (orcha_dir / "docker-compose.yml").write_text(rendered)
    _copy_tree(PKG_TEMPLATES / "migrations", orcha_dir / "migrations")
    _copy_tree(PKG_TEMPLATES / "portal", orcha_dir / "portal")
    _install_llm_util(orcha_dir)  # #290 llm_util + #294 secret_box + #287 digest_curate into portal build
    claude_commands, codex_skills = _install_orcha_skill_templates(cwd)
    # #298: backfill the project-preferences file for projects created before it existed.
    prefs_path = _install_project_preferences(cwd)
    if prefs_path:
        print(f"[orcha] backfilled {prefs_path} (#298 loosely-hardened project rules)")
    print("[orcha] re-rendered compose + re-copied portal/migrations/skills from templates")
    print(f"[orcha] refreshed Claude commands: {claude_commands}")
    print(f"[orcha] refreshed Codex skills: {codex_skills}")
    # ISS-40/ISS-20: re-register the notification hooks so newly-shipped template
    # hooks (e.g. C1's SessionEnd `orcha snapshot`) reach an EXISTING workspace on
    # upgrade — init/connect call this, but upgrade previously didn't, so new hooks
    # never landed without a manual `orcha enable-hook`. Idempotent + additive: only
    # missing hooks are added; existing settings.json entries are untouched.
    if _write_hook_config(config_path.parent):
        print("[orcha] registered newly-shipped notification hooks in .claude/settings.json")
    else:
        print("[orcha] notification hooks already up to date (.claude/settings.json)")
    print("[orcha] rebuilding portal (data preserved — no volume wipe) ...")
    _compose(orcha_dir, "up", "-d", "--build")
    try:
        ensure_daemon(cwd, restart=True)
    except Exception as e:
        print(f"[orcha] warn: notifier daemon didn't restart ({e}); start it with `orcha notifier --ensure`")
    # ISS-84/#235: restart the bridge so it rebinds to the per-project bridge_port (a backfill
    # changes the port from the old fixed 8765; even with no change a restart is harmless and
    # matches the daemon's restart-on-upgrade). The bridge reads bridge_port from orcha.json.
    # Honor --no-bridge when upgrade is invoked from `orcha update` on a headless host (no
    # terminal panel): standalone `orcha upgrade` has no such flag, so getattr defaults to
    # False and it still rebinds. Without this guard, update's Phase-3 --no-bridge suppression
    # is defeated because Phase-1 (this cmd_upgrade) already restarted the bridge.
    if not getattr(args, "no_bridge", False):
        try:
            from orcha_cli import terminal_bridge
            terminal_bridge.ensure_bridge(cwd, restart=True, quiet=True)
        except Exception as e:
            print(f"[orcha] warn: terminal bridge didn't restart ({e}); start it with `orcha terminal-bridge --ensure`")
    print("[orcha] ✓ upgraded. Pending migrations apply on portal startup; `orcha migrate` to force now.")


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
    """ONE idempotent command to apply a code change to a running project — safe to
    re-run even when nothing changed, and even when a portal rebuild / daemon respawn /
    bridge respawn isn't strictly required (every step is a no-op-or-refresh).

    Folds the whole host dance into one command so operators never hand-kill/respawn
    host processes:
      0. (auto) self-update the host CLI — editable/source installs reinstall from
         source; Homebrew-managed installs run `brew upgrade` (a versioned orcha@X.Y.Z
         keg is a user pin and is never moved) — then re-exec under the new code so the
         steps below run the just-pulled logic. Any other packaged install skips this
         and is updated via the user's package manager.
      1. `upgrade` — re-copy portal/migrations/skills templates, re-render compose,
         re-register hooks, rebuild the portal (NO data wipe). Pending DB migrations
         then apply on the portal's startup.
      2. restart the notifier wake daemon — picks up new notifier/runtime code.
      3. restart the live-terminal bridge — picks up new bridge code.
    Steps 2–3 are a brief, safe respawn; an unchanged daemon simply comes back identical.
    """
    cwd = pathlib.Path.cwd()
    if not (cwd / ".orcha" / "docker-compose.yml").exists() or not (cwd / ".claude" / "orcha.json").exists():
        sys.exit("error: no .orcha/ + .claude/orcha.json here — run `orcha update` from an "
                 "existing project directory (or `orcha init` to bootstrap a new one).")

    # ── Phase 0: self-update the host CLI, then re-exec under new code ──
    if not args.no_self:
        src = _cli_source_root()
        keg = None if src else _brew_keg()
        if src is not None:
            if _reinstall_cli(src):
                exe = shutil.which("orcha") or "orcha"
                print("[orcha] ✓ host CLI reinstalled — re-running update under the new code ...\n")
                # Re-exec the freshly-installed CLI for the remaining phases so a change to
                # `update` itself takes effect this run. --no-self prevents an infinite loop.
                forward = [exe, "update", "--no-self"]
                if args.no_bridge:
                    forward.append("--no-bridge")
                sys.exit(subprocess.run(forward).returncode)
            else:
                print("[orcha] warn: CLI self-reinstall failed — continuing with the "
                      "currently-installed code.", file=sys.stderr)
        elif keg is not None:
            if _brew_upgrade(keg):
                exe = shutil.which("orcha") or "orcha"
                print("[orcha] ✓ host CLI upgraded via brew — re-running update under the new code ...\n")
                forward = [exe, "update", "--no-self"]
                if args.no_bridge:
                    forward.append("--no-bridge")
                sys.exit(subprocess.run(forward).returncode)
            else:
                print("[orcha] continuing with the currently-installed CLI.")
        else:
            print("[orcha] host CLI is a packaged install — update it via your package "
                  "manager (e.g. `uv tool upgrade orcha-cli` or `pip install -U orcha-cli`), "
                  "then re-run `orcha update`. Skipping CLI self-update.")

    # ── Phase 1: portal/templates/compose/hooks + rebuild (data preserved) ──
    cmd_upgrade(args)

    # ── Phase 2: restart the wake daemon so new notifier/runtime code takes effect ──
    try:
        ensure_daemon(cwd, restart=True)
    except Exception as e:
        print(f"[orcha] warn: notifier daemon restart failed ({e}); "
              f"start it with `orcha notifier --ensure`", file=sys.stderr)

    # ── Phase 3: restart the live-terminal bridge (unless suppressed) ──
    if not args.no_bridge:
        try:
            from orcha_cli.terminal_bridge import ensure_bridge
            ensure_bridge(cwd, restart=True)
        except Exception as e:
            print(f"[orcha] warn: terminal bridge restart failed ({e}); "
                  f"start it with `orcha terminal-bridge --ensure`", file=sys.stderr)

    print("[orcha] ✓ update complete — portal rebuilt, hooks current, daemon + bridge restarted.")


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
    """Find the acting human's agent_id for human-only CLI calls (pause/resume/stop).

    Order matches the skills' 4-step resolution, minus the AskUserQuestion fallback
    (the CLI is non-interactive):
      1. $ORCHA_ALIAS → .claude/orcha-tabs/<alias>.json
      2. Single binding file in .claude/orcha-tabs/ if exactly one exists
    Anything else → exit with a clear message.
    """
    tabs_dir = cwd / ".claude" / "orcha-tabs"

    env_alias = (os.environ.get("ORCHA_ALIAS") or "").strip()
    if env_alias:
        f = tabs_dir / f"{env_alias}.json"
        if not f.exists():
            sys.exit(
                f"error: $ORCHA_ALIAS='{env_alias}' but {f} doesn't exist. "
                f"Register first via `orcha init --as {env_alias}` or `/orcha-register-human {env_alias}`."
            )
        return json.loads(f.read_text())["agent_id"]

    if tabs_dir.exists():
        bindings = sorted(tabs_dir.glob("*.json"))
        if len(bindings) == 1:
            return json.loads(bindings[0].read_text())["agent_id"]
        if len(bindings) > 1:
            names = ", ".join(b.stem for b in bindings)
            sys.exit(
                f"error: multiple bindings in {tabs_dir} ({names}). "
                f"Set ORCHA_ALIAS=<name> in your shell to pick which human is acting."
            )

    sys.exit(
        "error: no human binding found. Run `orcha init --as <YourName>` first, "
        "or set $ORCHA_ALIAS to a registered human alias."
    )


def _resolve_any_binding(cwd: pathlib.Path, alias_override: Optional[str] = None) -> Optional[dict]:
    """Find ANY binding (ai or human) for hook-friendly polling.

    Returns the binding dict {alias, agent_id, container_id, kind?} or None.
    Order: explicit alias arg → $ORCHA_ALIAS → single binding. **Never raises.**
    A hook running in a session that isn't an Orcha project must be a silent
    no-op; raising would break unrelated Claude work.
    """
    tabs_dir = cwd / ".claude" / "orcha-tabs"
    if not tabs_dir.exists():
        return None

    pick = (alias_override or os.environ.get("ORCHA_ALIAS") or "").strip()
    if pick:
        f = tabs_dir / f"{pick}.json"
        if not f.exists():
            return None
        try:
            return json.loads(f.read_text())
        except Exception:
            return None

    bindings = sorted(tabs_dir.glob("*.json"))
    if len(bindings) != 1:
        return None
    try:
        return json.loads(bindings[0].read_text())
    except Exception:
        return None


def _watch_state_path(cwd: pathlib.Path, alias: str) -> pathlib.Path:
    return cwd / ".claude" / f".orcha-watch-state-{alias}.json"


def _watch_pid_path(cwd: pathlib.Path, alias: str) -> pathlib.Path:
    return cwd / ".claude" / f".orcha-watch-{alias}.pid"


def _read_watch_state(cwd: pathlib.Path, alias: str) -> dict:
    """Returns {seen_ids: list[str], queued: list[dict]}; defaults if file is absent/corrupt."""
    p = _watch_state_path(cwd, alias)
    if not p.exists():
        return {"seen_ids": [], "queued": []}
    try:
        data = json.loads(p.read_text())
        if not isinstance(data, dict):
            return {"seen_ids": [], "queued": []}
        data.setdefault("seen_ids", [])
        data.setdefault("queued", [])
        return data
    except Exception:
        return {"seen_ids": [], "queued": []}


def _atomic_write_json(path: pathlib.Path, data: dict) -> None:
    """Write JSON atomically — write to a sibling tmp file, then rename."""
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(data) + "\n")
    tmp.replace(path)


def _skip_managed_embodiment_hook(hook: str) -> bool:
    """ISS-21 + R1/S3: the interactive SessionStart hooks must NOT run inside an Orcha-managed
    embodiment — a headless wake worker (ORCHA_HEADLESS_WORKER, set by the notifier on every
    worker it spawns) OR an S3 live terminal session (ORCHA_LIVE, set by the PTY bridge).

    Both boot AS the agent with persona+digest+history already injected at spawn
    (`--append-system-prompt`, or in-session on a warm `--resume`). Re-running `rehydrate`
    would DOUBLE-inject that brief — and re-inject on a warm resume, breaking R1's cache-safe
    "no re-injection" contract. `watch` would wedge a one-shot worker / add poller noise to a
    live session, and `reachability` / `notifier --ensure` are the daemon's job, not the
    embodiment's. Interactive human tabs (neither flag) are unaffected.

    ORCHA_LIVE is only READ here, never unset, so cmd_snapshot's SessionEnd gate still fires.
    Returns True if we no-op."""
    marker = ("headless worker" if os.environ.get("ORCHA_HEADLESS_WORKER")
              else "live terminal session" if os.environ.get("ORCHA_LIVE") else None)
    if marker:
        print(f"[orcha] {marker} — skipping interactive SessionStart hook '{hook}'")
        return True
    return False


def cmd_watch(args: argparse.Namespace) -> None:
    """Orcha#33: per-session background watcher (polls every 10s by default).

    Polls `/api/agents/<aid>/inbox` + `/api/agents/<aid>/outbox?status=answered`
    for the bound AI agent. Items whose request_id isn't in `seen_ids` get
    queued for the next PostToolUse hook fire (which is just a file read —
    no API call from inside Claude's reasoning loop).

    Process model:
      • `--detach`: fork, parent returns immediately (so SessionStart can finish);
        child runs the loop. macOS/Linux only.
      • Exits when the parent Claude process dies (PID watch). Belt: also exits
        on SIGTERM from `orcha unwatch`.

    Silent no-op for: no .claude/orcha.json, no resolvable binding, kind='human'
    (humans don't get the automated nag), an existing live watcher for this alias.
    """
    if _skip_managed_embodiment_hook("watch"):   # ISS-21: the poller would wedge a one-shot worker
        return
    import signal
    import time

    cwd = pathlib.Path.cwd()
    config_path = cwd / ".claude" / "orcha.json"
    if not config_path.exists():
        return
    try:
        config = json.loads(config_path.read_text())
        api_base = config.get("api_base_url")
        if not api_base:
            return
    except Exception:
        return

    binding = _resolve_any_binding(cwd, args.alias)
    if not binding or binding.get("kind") == "human":
        return
    agent_id = binding.get("agent_id")
    alias = binding.get("alias")
    if not agent_id or not alias:
        return

    pid_path = _watch_pid_path(cwd, alias)
    # If a live watcher is already running for this alias, this is a no-op.
    if pid_path.exists():
        try:
            old_pid = int(pid_path.read_text().strip())
            os.kill(old_pid, 0)
            return  # already running
        except (ValueError, ProcessLookupError, PermissionError):
            try:
                pid_path.unlink()
            except FileNotFoundError:
                pass

    parent_pid = os.getppid()

    if args.detach:
        # Fork; parent returns so the hook command completes promptly.
        try:
            pid = os.fork()
        except OSError:
            # No fork on this platform — fall through and run inline.
            pid = 0
        if pid > 0:
            return
        # Child: detach from controlling terminal so the loop survives session end
        # gracefully (we still rely on parent_pid watch to actually exit).
        try:
            os.setsid()
        except OSError:
            pass

    pid_path.parent.mkdir(parents=True, exist_ok=True)
    pid_path.write_text(str(os.getpid()))

    stop_requested = False

    def _handle_term(signum, frame):
        nonlocal stop_requested
        stop_requested = True

    signal.signal(signal.SIGTERM, _handle_term)
    signal.signal(signal.SIGINT, _handle_term)

    inbox_url = f"{api_base}/api/agents/{agent_id}/inbox"
    outbox_url = f"{api_base}/api/agents/{agent_id}/outbox?status=answered"
    try:
        while not stop_requested:
            # Exit cleanly when Claude (the parent) is gone — keeps stale watchers
            # from accumulating across `claude` invocations in the same folder.
            try:
                os.kill(parent_pid, 0)
            except ProcessLookupError:
                break

            inbox = _get_json(inbox_url, timeout=3.0) or {}
            outbox = _get_json(outbox_url, timeout=3.0) or {}

            state = _read_watch_state(cwd, alias)
            seen = set(state["seen_ids"])
            queued = state["queued"]
            had_new = False

            for r in inbox.get("open_requests") or []:
                rid = r.get("id")
                if rid and rid not in seen:
                    queued.append({
                        "channel": "inbox",
                        "id": rid,
                        "type": r.get("type", "info"),
                        "priority": r.get("priority"),
                        "from": r.get("requester_alias"),
                        "preview": (r.get("payload") or "")[:160],
                        "chain_depth": r.get("chain_depth") or 0,
                        "created_at": r.get("created_at"),
                    })
                    seen.add(rid)
                    had_new = True

            for r in outbox.get("outgoing_requests") or outbox.get("requests") or []:
                rid = r.get("id")
                if rid and rid not in seen:
                    queued.append({
                        "channel": "outbox-answered",
                        "id": rid,
                        "type": r.get("type", "info"),
                        "to": r.get("target_alias"),
                        "preview": (r.get("payload") or "")[:160],
                        "answer_preview": (r.get("response") or "")[:160],
                        "responded_at": r.get("responded_at"),
                    })
                    seen.add(rid)
                    had_new = True

            if had_new:
                _atomic_write_json(_watch_state_path(cwd, alias), {
                    "seen_ids": sorted(seen),
                    "queued": queued,
                })

            # Sleep in short slices so SIGTERM is responsive.
            slept = 0.0
            while slept < args.interval and not stop_requested:
                time.sleep(min(0.5, args.interval - slept))
                slept += 0.5
                try:
                    os.kill(parent_pid, 0)
                except ProcessLookupError:
                    stop_requested = True
                    break
    finally:
        try:
            current = int(pid_path.read_text().strip())
            if current == os.getpid():
                pid_path.unlink()
        except (FileNotFoundError, ValueError, PermissionError):
            pass


def cmd_unwatch(_: argparse.Namespace) -> None:
    """Orcha#33: SessionEnd partner — SIGTERM the watcher(s) in this folder.

    Targets the per-alias PID files written by `orcha watch`. Silent no-op if
    no PID file exists or the pid is stale.
    """
    import signal
    cwd = pathlib.Path.cwd()
    claude_dir = cwd / ".claude"
    if not claude_dir.exists():
        return
    for pid_path in claude_dir.glob(".orcha-watch-*.pid"):
        try:
            pid = int(pid_path.read_text().strip())
        except (ValueError, OSError):
            try:
                pid_path.unlink()
            except FileNotFoundError:
                pass
            continue
        try:
            os.kill(pid, signal.SIGTERM)
        except (ProcessLookupError, PermissionError):
            pass
        try:
            pid_path.unlink()
        except FileNotFoundError:
            pass


def _detect_tmux_target() -> Optional[str]:
    """This session's tmux pane "session:window.pane", or None if not under tmux.

    Optional — most Orcha users run plain Claude Code CLI (no tmux) and rely on the
    headless wake transport. Only populated when tmux is installed AND we're inside a
    session, enabling the live-pane send-keys transport.
    """
    if not shutil.which("tmux") or not os.environ.get("TMUX"):
        return None
    try:
        out = subprocess.run(
            ["tmux", "display-message", "-p", "#{session_name}:#{window_index}.#{pane_index}"],
            capture_output=True, text=True, timeout=3,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    return (out.stdout.strip() or None) if out.returncode == 0 else None


def cmd_reachability(args: argparse.Namespace) -> None:
    """Epic A: record THIS session's bound-agent reachability so the notifier can wake it.

    Posts headless_cwd (this project dir, where `claude -p` wakes spawn) plus the tmux
    pane if we happen to be under tmux. Run at SessionStart (hook, registered by init)
    and right after `/orcha-register-agent`, so every agent is wakeable with zero manual
    steps — `orcha init` is all a user runs. Silent no-op when this isn't an Orcha
    project, there's no resolvable AI binding, or the binding is a human (humans aren't
    woken). Must never break the session it runs in.
    """
    if _skip_managed_embodiment_hook("reachability"):   # ISS-21: a worker is already reachable; no per-wake re-record
        return
    cwd = pathlib.Path.cwd()
    cfg = cwd / ".claude" / "orcha.json"
    if not cfg.exists():
        return
    try:
        api_base = json.loads(cfg.read_text()).get("api_base_url")
    except Exception:
        return
    if not api_base:
        return
    binding = _resolve_any_binding(cwd, args.alias)
    if not binding or binding.get("kind") == "human":
        return
    aid = binding.get("agent_id")
    if not aid:
        return
    body = {"headless_cwd": str(cwd)}
    tgt = _detect_tmux_target()
    if tgt:
        body["tmux_target"] = tgt
    try:
        _post_json(f"{api_base}/api/agents/{aid}/reachability", body)
    except Exception:
        return  # a recording failure must never break the session
    if not args.quiet:
        extra = f", tmux={tgt}" if tgt else ""
        print(f"[orcha] reachability recorded for {binding.get('alias')} "
              f"(headless_cwd={cwd}{extra}) — daemon can now wake it")


def _write_hook_config(claude_dir: pathlib.Path) -> bool:
    """Orcha#33: register the three notification hooks in .claude/settings.json.

    - SessionStart  → `orcha watch --detach` (spawns the per-session poller)
    - SessionEnd    → `orcha unwatch`        (SIGTERMs the poller)
    - SessionEnd    → `orcha snapshot`       (C1: headless worker writes its
                                              continuity digest before exiting)
    - PostToolUse   → `orcha poll-inbox`     (drains the watcher's queue into
                                              Claude's next-turn context)

    Each entry is added independently and idempotently — re-running this with
    a partially-present config will fill in whatever's missing without touching
    existing entries. SessionStart/SessionEnd don't take a `matcher` field.

    Returns True if any entry was added, False if all three were already wired
    or the file is structurally too unusual to safely merge.
    """
    settings_path = claude_dir / "settings.json"

    settings: dict = {}
    if settings_path.exists():
        try:
            settings = json.loads(settings_path.read_text())
            if not isinstance(settings, dict):
                settings = {}
        except Exception:
            # Corrupted JSON — refuse to clobber the user's file.
            return False

    hooks_block = settings.setdefault("hooks", {})
    if not isinstance(hooks_block, dict):
        return False

    def _ensure(event: str, command: str, matcher: Optional[str]) -> bool:
        """Add a hook for `event` if no entry with the same command exists yet."""
        entries = hooks_block.setdefault(event, [])
        if not isinstance(entries, list):
            return False
        for entry in entries:
            if not isinstance(entry, dict):
                continue
            for h in entry.get("hooks", []) or []:
                if isinstance(h, dict) and h.get("command") == command:
                    return False
        new_entry: dict = {"hooks": [{"type": "command", "command": command}]}
        if matcher is not None:
            new_entry["matcher"] = matcher
        entries.append(new_entry)
        return True

    added_any = False
    added_any |= _ensure("PostToolUse",  "orcha poll-inbox",   matcher="*")
    added_any |= _ensure("SessionStart", "orcha watch --detach", matcher=None)
    # Epic C: a SECOND SessionStart entry, alongside watch — prints the rehydrate
    # brief. Independent + idempotent: the two entries don't clobber each other.
    added_any |= _ensure("SessionStart", "orcha rehydrate",     matcher=None)
    added_any |= _ensure("SessionEnd",   "orcha unwatch",       matcher=None)
    # Epic C / C1: digest write-on-exit. A SECOND SessionEnd entry, alongside
    # unwatch — a woken headless worker snapshots its continuity digest before it
    # exits. `orcha snapshot` is an internal no-op unless ORCHA_HEADLESS_WORKER=1,
    # so interactive human tabs (which author via /orcha-snapshot) are unaffected.
    added_any |= _ensure("SessionEnd",   "orcha snapshot",      matcher=None)
    # Epic A: wake daemon comes up with the workspace (idempotent singleton), so an
    # idle agent gets woken out-of-band without anyone hand-starting a daemon.
    added_any |= _ensure("SessionStart", "orcha notifier --ensure", matcher=None)
    # S3 §3b: the host-side live-terminal bridge comes up the same way (idempotent singleton),
    # so the embedded terminal can connect without anyone hand-starting it.
    added_any |= _ensure("SessionStart", "orcha terminal-bridge --ensure", matcher=None)
    # Epic A: record this session's bound-agent reachability (headless_cwd / tmux pane)
    # so the daemon knows HOW to wake it — every agent wakeable with zero manual steps.
    added_any |= _ensure("SessionStart", "orcha reachability --quiet", matcher=None)

    if added_any:
        claude_dir.mkdir(parents=True, exist_ok=True)
        settings_path.write_text(json.dumps(settings, indent=2) + "\n")
    return added_any


def cmd_enable_hook(_: argparse.Namespace) -> None:
    """Orcha#33: opt an existing folder into the PostToolUse poll-inbox hook."""
    cwd = pathlib.Path.cwd()
    claude_dir = cwd / ".claude"
    if not (claude_dir / "orcha.json").exists():
        sys.exit(
            "error: no .claude/orcha.json in CWD. Run `orcha init` (or `orcha connect`) "
            "first so the hook has somewhere to poll."
        )
    added = _write_hook_config(claude_dir)
    if added:
        print(f"[orcha] ✓ PostToolUse hook registered in {claude_dir / 'settings.json'}")
        print("        Working agents in this folder will now check inbox between tool calls.")
    else:
        print(f"[orcha] hook already present in {claude_dir / 'settings.json'} (no change)")


def cmd_poll_inbox(args: argparse.Namespace) -> None:
    """Orcha#33: PostToolUse hook — surface items the background watcher queued.

    This is a CHEAP file read, not an API call. The actual polling happens in
    `orcha watch` (spawned by SessionStart, killed by SessionEnd). The hook
    just drains the watcher's queue on every tool-call boundary so the agent
    sees pending work in its next-turn context.

    Silent no-op when there's no `.claude/orcha.json`, no resolvable binding,
    the binding's kind='human', or the queue is empty. Must NEVER break the
    Claude session it runs inside.
    """
    cwd = pathlib.Path.cwd()
    if not (cwd / ".claude" / "orcha.json").exists():
        return

    binding = _resolve_any_binding(cwd, args.alias)
    if not binding or binding.get("kind") == "human":
        return
    alias = binding.get("alias")
    if not alias:
        return

    state = _read_watch_state(cwd, alias)
    queued = state.get("queued") or []
    if not queued:
        return

    # Drain the queue atomically: we've taken ownership of these items; the
    # next watcher cycle won't re-queue them because their ids are in seen_ids.
    state["queued"] = []
    try:
        _atomic_write_json(_watch_state_path(cwd, alias), state)
    except Exception:
        # If we can't clear the queue, abandon surfacing — better to print the
        # same items next turn than to lose them, and better to lose nothing
        # than to flood Claude with repeats.
        return

    n = len(queued)
    print(f"[orcha] 🔔 {n} new item{'s' if n != 1 else ''} for {alias} (from background watcher):")
    incoming = [q for q in queued if q.get("channel") == "inbox"]
    answered = [q for q in queued if q.get("channel") == "outbox-answered"]

    for q in incoming[:5]:
        rid_short = (q.get("id") or "")[:8]
        prio = q.get("priority", "?")
        kind = q.get("type", "info")
        sender = q.get("from") or "?"
        preview = (q.get("preview") or "").replace("\n", " ").strip()
        if len(preview) > 100:
            preview = preview[:97] + "..."
        chain = ""
        depth = q.get("chain_depth") or 0
        if depth:
            chain = f" chain-depth={depth}"
        print(f"  ← {kind} {rid_short} from {sender} (p={prio}){chain}: \"{preview}\"")
    if len(incoming) > 5:
        print(f"  ← ...and {len(incoming) - 5} more incoming")

    for q in answered[:5]:
        rid_short = (q.get("id") or "")[:8]
        target = q.get("to") or "?"
        ans = (q.get("answer_preview") or "").replace("\n", " ").strip()
        if len(ans) > 100:
            ans = ans[:97] + "..."
        print(f"  → answer to your ask {rid_short} ({target}): \"{ans}\"")
    if len(answered) > 5:
        print(f"  → ...and {len(answered) - 5} more answered outgoing")

    print(
        f"Handle at the next step boundary: `/orcha-inbox --alias {alias}` "
        f"for full thread, or `/orcha-outbox --alias {alias}` for answered asks."
    )


def _fmt_rehydrate_brief(b: dict) -> str:
    """Render the 'where we left off' brief from GET /api/agents/{aid}/rehydrate.

    Plain text on stdout — the SessionStart hook injects stdout into Claude's
    next-turn context (same channel as poll-inbox). Deliberately carries NO
    Claude Code file-memory: that loads via its own parallel injector. This brief
    is ONLY the agent's work/reasoning state (Epic C ownership boundary).
    """
    ident = b.get("identity") or {}
    alias = ident.get("alias", "?")
    role = ident.get("role", "?")
    lines = [
        f"[orcha] ⏪ Rehydrated session — you are {alias} ({role}).",
        f"        agent_id {ident.get('id', '?')} · status {ident.get('status', '?')} "
        f"· turns {ident.get('turns_used', '?')}/{ident.get('turn_budget', '?')}",
    ]

    tasks = b.get("tasks") or []
    if tasks:
        lines.append(f"  Your live tasks ({len(tasks)}):")
        for t in tasks[:6]:
            lines.append(f"    • [{t.get('status')}] {t.get('title')}  (id {str(t.get('id'))[:8]})")
            last = t.get("last_message")
            if last:
                lines.append(f"        last note: {last[:140]}")

    inbox = b.get("inbox") or []
    if inbox:
        lines.append(f"  Inbox — open requests to answer ({len(inbox)}):")
        for i in inbox[:6]:
            lines.append(f"    ← {i.get('requester_alias')}: {(i.get('payload') or '')[:120]}  (id {str(i.get('id'))[:8]})")

    outbox = b.get("outbox") or []
    if outbox:
        lines.append(f"  Your asks now answered ({len(outbox)}):")
        for o in outbox[:6]:
            lines.append(f"    → {o.get('target_alias')}: {(o.get('response') or '')[:120]}  (id {str(o.get('id'))[:8]})")

    digest = b.get("digest")
    if digest:
        lines.append("  Memory digest (your prior reasoning; re-check external state before trusting it):")
        lines.append("    Treat PR/issue/task/request status, review state, and who-owes-what as pointers")
        lines.append("    to verify live before acting or deciding there is nothing to do.")
        if digest.get("current_focus"):
            lines.append(f"    focus: {digest['current_focus']}")
        for label in ("decisions", "learnings", "open_threads"):
            items = digest.get(label) or []
            if items:
                lines.append(f"    {label}:")
                for it in items[:5]:
                    txt = it.get("text") if isinstance(it, dict) else str(it)
                    lines.append(f"      - {txt}")
    else:
        lines.append("  Memory digest: none yet — run /orcha-snapshot to capture your reasoning.")

    lines.append(f"  Resume: handle inbox first if any, else /orcha-next --alias {alias} "
                 f"(or /loop /orcha-listen --alias {alias}).")
    return "\n".join(lines)


def cmd_rehydrate(args: argparse.Namespace) -> None:
    """Epic C / D2 + D4: SessionStart 'where we left off' brief.

    Detects the stack (.claude/orcha.json), rebinds the alias from the binding
    file / $ORCHA_ALIAS (same resolver `orcha watch` uses), fetches the rehydrate
    brief and prints it to stdout so SessionStart injects it into Claude's
    context — no command typed by the user.

    Silent no-op (like watch/poll-inbox) when there's no config, no resolvable
    binding, or the stack is unreachable. MUST NEVER raise: a hook that breaks an
    unrelated Claude session is worse than one that stays quiet.
    """
    if _skip_managed_embodiment_hook("rehydrate"):   # ISS-21: notifier already injects persona+digest via --append-system-prompt
        return
    try:
        cwd = pathlib.Path.cwd()
        config_path = cwd / ".claude" / "orcha.json"
        if not config_path.exists():
            return
        config = json.loads(config_path.read_text())
        api_base = config.get("api_base_url")
        if not api_base:
            return
        binding = _resolve_any_binding(cwd, args.alias)
        if not binding:
            return
        agent_id = binding.get("agent_id")
        if not agent_id:
            return
        brief = _get_json(f"{api_base}/api/agents/{agent_id}/rehydrate", timeout=4.0)
        if not brief:
            return
        print(_fmt_rehydrate_brief(brief))
    except Exception:
        # Never let a SessionStart hook break the session.
        return


def _live_boot_prefix(api_base: Optional[str], agent_id: Optional[str]) -> Optional[str]:
    """COLD-boot `--append-system-prompt` text for an S3 live embodiment: the agent's persona
    + latest memory digest (Epic A/C, via notifier.format_persona) followed by recent
    conversation history (V1 #120 formatter). This reuses the SAME assembly the headless wake
    path injects, so a terminal session boots AS the agent with full continuity instead of as
    a generic Claude. Best-effort: returns whatever it could fetch (or None) — a live boot must
    never fail on a missing digest / unreachable API."""
    if not api_base or not agent_id:
        return None
    parts = []
    try:
        from orcha_cli import notifier  # reuse format_persona + _build_persona (persona + digest)
        p = notifier._build_persona(api_base, agent_id)
        if p:
            parts.append(p)
    except Exception:
        pass
    try:
        from orcha_cli.conversation_prefix import format_conversation_history
        conv = _get_json(f"{api_base}/api/agents/{agent_id}/conversation", timeout=4.0)
        hist = format_conversation_history((conv or {}).get("turns") or [])
        if hist:
            parts.append(hist)
    except Exception:
        pass
    return "\n\n".join(parts) if parts else None


RUNTIME_CLAUDE = "claude"
RUNTIME_CODEX = "codex"
ORCHA_CLAUDE_EXEC = "ORCHA_CLAUDE_EXEC"
ORCHA_CODEX_EXEC = "ORCHA_CODEX_EXEC"
_CODEX_EXEC_FALLBACKS = (
    "/Applications/Codex.app/Contents/Resources/codex",
    "/opt/homebrew/bin/codex",
    "/usr/local/bin/codex",
    "~/.local/bin/codex",
)


def _normalize_runtime(runtime: Optional[str], model: Optional[str] = None) -> str:
    if runtime == RUNTIME_CODEX:
        return RUNTIME_CODEX
    if runtime == RUNTIME_CLAUDE:
        return RUNTIME_CLAUDE
    if model and not str(model).startswith("claude-"):
        return RUNTIME_CODEX
    return RUNTIME_CLAUDE


def _executable_override(env_var: str) -> Optional[str]:
    override = os.environ.get(env_var)
    if not override:
        return None
    if shutil.which(override):
        return override
    p = pathlib.Path(override).expanduser()
    return str(p) if p.is_file() and os.access(p, os.X_OK) else None


def _runtime_executable(runtime: Optional[str]) -> str:
    return "codex" if _normalize_runtime(runtime) == RUNTIME_CODEX else "claude"


def _resolve_runtime_executable(runtime: Optional[str]) -> Optional[str]:
    runtime = _normalize_runtime(runtime)
    leaf = _runtime_executable(runtime)
    override = _executable_override(ORCHA_CODEX_EXEC if runtime == RUNTIME_CODEX else ORCHA_CLAUDE_EXEC)
    if override:
        return override
    if shutil.which(leaf):
        return leaf
    if runtime == RUNTIME_CODEX:
        for candidate in _CODEX_EXEC_FALLBACKS:
            p = pathlib.Path(candidate).expanduser()
            if p.is_file() and os.access(p, os.X_OK):
                return str(p)
    return None


def _build_live_argv(cold: bool, resume_sid: Optional[str],
                     boot_prefix: Optional[str], model: Optional[str] = None,
                     runtime: Optional[str] = None) -> list:
    """Pure: argv for an S3 live embodiment.

    Claude COLD injects the persona/digest/history boot prefix via `--append-system-prompt`;
    Codex COLD sends that same prefix as the initial prompt. Both pin the selected model with
    `--model`. WARM resumes never re-pass a model: the pinned session already booted on its
    model, and set_agent_model clears that session on a change so the next COLD reconnect picks
    the new one. A WARM boot with no session_id degrades to a plain runtime launch.
    """
    runtime = _normalize_runtime(runtime, model)
    if runtime == RUNTIME_CODEX:
        argv = ["codex"]
        if cold:
            if model:
                argv += ["--model", model]
            if boot_prefix:
                argv.append(boot_prefix)
        elif resume_sid:
            argv += ["resume", resume_sid]
        return argv

    argv = ["claude"]
    if cold:
        if boot_prefix:
            argv += ["--append-system-prompt", boot_prefix]
        if model:
            argv += ["--model", model]
    elif resume_sid:
        argv += ["--resume", resume_sid]
    return argv


def _live_agent_launch(api_base: Optional[str], agent_id: Optional[str]) -> tuple[Optional[str], str]:
    """Resolved (model, runtime) for a live session boot/resume, from GET /persona.

    Best-effort like _live_agent_model: the embedded terminal should still open if the
    API is unreachable. Missing runtime is inferred from the model id for compatibility
    with older portals that did not yet return model_runtime.
    """
    if not api_base or not agent_id:
        return None, RUNTIME_CLAUDE
    try:
        persona = _get_json(f"{api_base}/api/agents/{agent_id}/persona", timeout=4.0) or {}
        model = persona.get("model")
        return model, _normalize_runtime(persona.get("model_runtime"), model)
    except Exception:
        return None, RUNTIME_CLAUDE


def _live_agent_model(api_base: Optional[str], agent_id: Optional[str]) -> Optional[str]:
    """The model to boot a COLD live session on, resolved server-side via GET /persona (retired/
    unknown → DEFAULT_MODEL; human → None). Best-effort: a live boot must never fail on an
    unreachable API, so any error → None (claude falls back to its own default)."""
    return _live_agent_launch(api_base, agent_id)[0]


def _exec_live_session(cwd: pathlib.Path, alias: str, binding_file: pathlib.Path) -> None:
    """Replace THIS process with the agent's interactive coding CLI (S3 live embodiment).

    Invoked by `cmd_use` when the host PTY bridge spawned us with ORCHA_LIVE=1 inside a tty.
    Env from the bridge (sourced from its wake-claim(kind='live') response): ORCHA_LIVE_COLD=
    1|0 and ORCHA_LIVE_RESUME_SID=<sid> on a warm resume. COLD → boot prefix; WARM → --resume.
    ORCHA_ALIAS is propagated so the agent's work-skills + the SessionEnd snapshot resolve to
    this agent.

    ORCHA_LIVE_EXEC: a test seam (R2 smoke gate). When set, it names the program to exec in
    place of the runtime binary — the built argv is preserved and passed through, so a stub can
    assert the cold/warm boot decision + env + cwd while EVERY other seam (bridge ⇄ /persona ⇄
    lease ⇄ PTY ⇄ close ⇄ release) stays real. It only substitutes the editor leaf, never the
    path under test. Unset in production → the selected runtime binary."""
    try:
        binding = json.loads(binding_file.read_text())
    except Exception:
        binding = {}
    agent_id = binding.get("agent_id")
    api_base = None
    config_path = cwd / ".claude" / "orcha.json"
    if config_path.exists():
        try:
            api_base = json.loads(config_path.read_text()).get("api_base_url")
        except Exception:
            api_base = None
    cold = os.environ.get("ORCHA_LIVE_COLD", "1") != "0"
    boot_prefix = _live_boot_prefix(api_base, agent_id) if cold else None
    # GAP A: pin the agent's selected model on a COLD boot (the WARM --resume keeps the session's
    # booted model — see _build_live_argv). Runtime is fetched on warm too so a Codex agent resumes
    # with `codex resume` rather than falling back to Claude.
    # #297: PREFER the model+runtime the PTY bridge already resolved and handed down via
    # ORCHA_LIVE_MODEL/ORCHA_LIVE_RUNTIME — that came from the bridge's own /persona fetch (the one
    # that authorized this terminal), so it's authoritative and skips a SECOND fail-open round-trip.
    # The bridge sets ORCHA_LIVE_RUNTIME whenever it resolved a target (model-less human → 'claude'),
    # so its presence marks a bridge-spawn. Only a DIRECT `orcha use` (no bridge) re-resolves from
    # /persona — and that fallback is now non-silent so a degrade-to-default is diagnosable (#297).
    env_runtime = os.environ.get("ORCHA_LIVE_RUNTIME")
    if env_runtime:
        env_model = os.environ.get("ORCHA_LIVE_MODEL") or None
        live_model, runtime = env_model, _normalize_runtime(env_runtime, env_model)
    else:
        live_model, runtime = _live_agent_launch(api_base, agent_id)
        if live_model is None and api_base and agent_id:
            sys.stderr.write(
                f"orcha live: could not resolve the agent's selected model from {api_base}"
                f"/api/agents/{agent_id}/persona — booting the runtime default instead. "
                "The terminal may not match the agent's configured model/runtime (#297).\n")
    model = live_model if cold else None
    argv = _build_live_argv(cold, os.environ.get("ORCHA_LIVE_RESUME_SID"),
                            boot_prefix, model, runtime)
    exec_cmd = os.environ.get("ORCHA_LIVE_EXEC") or _resolve_runtime_executable(runtime)
    if not exec_cmd:
        leaf = _runtime_executable(runtime)
        hint = (f" Install Codex CLI or set {ORCHA_CODEX_EXEC}=/absolute/path/to/codex."
                if runtime == RUNTIME_CODEX
                else f" Install Claude Code or set {ORCHA_CLAUDE_EXEC}=/absolute/path/to/claude.")
        sys.exit(f"error: `{leaf}` not found — cannot start the live session.{hint}")
    if os.environ.get("ORCHA_LIVE_EXEC") and not shutil.which(exec_cmd):
        sys.exit(f"error: `{exec_cmd}` not found on PATH — cannot start the live session.")
    argv[0] = exec_cmd   # substitute the editor leaf (claude, or the ORCHA_LIVE_EXEC test stub)
    env = dict(os.environ)
    env["ORCHA_ALIAS"] = alias
    env["ORCHA_AGENT_RUNTIME"] = runtime
    # Replace the process image: the PTY now runs the coding CLI directly AS the agent, so the
    # terminal IS the agent's session and the bridge relays its stdio.
    os.execvpe(exec_cmd, argv, env)


def cmd_use(args: argparse.Namespace) -> None:
    """Print `export ORCHA_ALIAS=<alias>` for the user to eval into their shell — OR, when the
    S3 PTY bridge spawns us with ORCHA_LIVE=1, BECOME the agent: exec an interactive `claude`
    booted AS this agent (persona+digest+history on cold, `--resume` on warm).

    A slash command / hook can't mutate the parent shell's env, so the default follows the
    ssh-agent idiom: `eval "$(orcha use Vault)"` sets the var in YOUR shell so every subsequent
    /orcha-* skill (and a fresh `claude`) resolves to that agent without --alias. Validates the
    binding exists so typos fail loudly.
    """
    cwd = pathlib.Path.cwd()
    alias = args.alias
    binding_file = cwd / ".claude" / "orcha-tabs" / f"{alias}.json"
    if not binding_file.exists():
        sys.exit(
            f"error: no binding for alias '{alias}' in .claude/orcha-tabs/. "
            f"Register it first (/orcha-register-agent {alias} ...) or check the spelling."
        )
    # S3 live embodiment (set by the host PTY bridge): become the agent's interactive claude.
    if os.environ.get("ORCHA_LIVE"):
        _exec_live_session(cwd, alias, binding_file)
        return  # unreachable — execvpe replaced the process image
    print(f"export ORCHA_ALIAS={alias}")


def cmd_terminal_bridge(args: argparse.Namespace) -> None:
    """S3 §3b: run the host-side PTY/websocket bridge for the LIVE embedded-terminal embodiment.

    Resolves the API base from --api-base or .claude/orcha.json, then serves the localhost
    websocket forever. `websockets` is imported lazily inside serve_bridge so the rest of the
    CLI works without the dependency installed."""
    import asyncio
    from orcha_cli import terminal_bridge

    cwd = pathlib.Path.cwd()
    # `--ensure`: idempotent singleton spawn (used by up/init/SessionStart). Returns immediately;
    # the spawned child runs the server. A managed embodiment skips it (handled in ensure_bridge).
    if getattr(args, "ensure", False):
        terminal_bridge.ensure_bridge(cwd, quiet=args.quiet)
        return
    api_base = args.api_base
    cfg_bridge_port = None
    cfg_path = cwd / ".claude" / "orcha.json"
    if cfg_path.exists():
        try:
            _cfg = json.loads(cfg_path.read_text())
            if not api_base:
                api_base = _cfg.get("api_base_url")
            cfg_bridge_port = _cfg.get("bridge_port")
        except (OSError, ValueError):
            pass
    if not api_base:
        sys.exit("error: no api_base_url — pass --api-base or run from a project with .claude/orcha.json")
    host = args.host or terminal_bridge.BRIDGE_HOST
    # ISS-84/#235: per-project bridge port — explicit --port wins, else orcha.json's bridge_port,
    # else the 8765 back-compat constant (orcha.json predating this field).
    port = args.port or cfg_bridge_port or terminal_bridge.BRIDGE_PORT
    try:
        asyncio.run(terminal_bridge.serve_bridge(
            api_base, str(cwd), host=host, port=port, quiet=args.quiet))
    except KeyboardInterrupt:
        pass


def _read_hook_stdin() -> dict:
    """SessionEnd/Stop hooks receive a JSON payload on stdin ({session_id,
    transcript_path, hook_event_name, ...}). Return it parsed, or {} when there's
    nothing to read (e.g. a manual `orcha snapshot` from a terminal). Never raises."""
    try:
        if sys.stdin is None or sys.stdin.isatty():
            return {}
        raw = sys.stdin.read()
    except Exception:
        return {}
    if not raw or not raw.strip():
        return {}
    try:
        data = json.loads(raw)
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}


def _iter_transcript_records(transcript_path: Optional[str]):
    """Yield parsed JSONL records from a Claude Code transcript, oldest→newest.
    Silent (yields nothing) on any problem — callers degrade gracefully."""
    if not transcript_path:
        return
    try:
        p = pathlib.Path(transcript_path)
        if not p.exists():
            return
        for line in p.read_text(errors="replace").splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                yield json.loads(line)
            except Exception:
                continue
    except Exception:
        return


def _rich_digest_posted_this_session(transcript_path: Optional[str], agent_id: str) -> bool:
    """C1 precedence: did the worker already author a RICH digest this session
    (via /orcha-snapshot, e.g. from /orcha-done)? We detect a POST to this agent's
    /digest endpoint anywhere in the transcript. If so, the SessionEnd fallback must
    NOT write a thin row that would shadow it (the digest table is append-only, so the
    latest row wins). Best-effort string match on the agent's own /digest call."""
    if not agent_id:
        return False
    needle = f"/agents/{agent_id}/digest"
    for rec in _iter_transcript_records(transcript_path):
        try:
            blob = json.dumps(rec)
        except Exception:
            continue
        if needle in blob and "digest" in blob:
            # A bare GET of /digest (rehydrate uses /rehydrate, not /digest) is unlikely;
            # treat any appearance of the agent's own /digest call as "already snapshotted".
            return True
    return False


def _focus_from_transcript(transcript_path: Optional[str]) -> Optional[str]:
    """Best-effort current_focus: the worker's LAST assistant text turn, condensed to
    one line. These are the agent's OWN words (we extract, never synthesize) so the
    fallback digest stays agent-grounded. Returns None if nothing usable is found."""
    last_text: Optional[str] = None
    for rec in _iter_transcript_records(transcript_path):
        if rec.get("type") == "assistant" or rec.get("role") == "assistant":
            msg = rec.get("message") if isinstance(rec.get("message"), dict) else rec
            content = msg.get("content")
            text = None
            if isinstance(content, str):
                text = content
            elif isinstance(content, list):
                parts = [b.get("text") for b in content
                         if isinstance(b, dict) and b.get("type") == "text" and b.get("text")]
                text = " ".join(parts).strip() or None
            if text:
                last_text = text
    if not last_text:
        return None
    return " ".join(last_text.split())[:280]


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


def _lifecycle_call(container_id: Optional[str], new_status: str, verb: str) -> None:
    """Shared helper for pause/resume/stop: POST /api/containers/{cid}/status.

    The portal API (Orcha#30) now requires actor_agent_id and enforces
    kind='human'. We resolve the acting human from $ORCHA_ALIAS or the single
    binding file under .claude/orcha-tabs/ — see _resolve_human_agent_id.
    """
    cwd = pathlib.Path.cwd()
    config_path = cwd / ".claude" / "orcha.json"
    if not config_path.exists():
        sys.exit(
            "error: no .claude/orcha.json in CWD. cd to your project root (the dir where "
            "`orcha init` was run), or use a slash skill from inside Claude Code."
        )
    config = json.loads(config_path.read_text())
    api_base = config.get("api_base_url")
    if not api_base:
        sys.exit("error: api_base_url missing from .claude/orcha.json — re-init with `orcha init --force`?")
    cid = container_id or config.get("current_container_id")
    if not cid:
        sys.exit(
            "error: no container_id given and no current_container_id in .claude/orcha.json. "
            f"Pass it as: `orcha {verb} <container_id>`."
        )
    actor_agent_id = _resolve_human_agent_id(cwd)

    import urllib.error
    import urllib.request

    url = f"{api_base}/api/containers/{cid}/status"
    body = json.dumps({"status": new_status, "actor_agent_id": actor_agent_id}).encode()
    req = urllib.request.Request(
        url, data=body, method="POST",
        headers={"Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            data = json.loads(resp.read())
    except urllib.error.HTTPError as e:
        sys.exit(f"error: HTTP {e.code} from {url}\n{e.read().decode(errors='replace')}")
    except urllib.error.URLError as e:
        sys.exit(f"error: cannot reach {url} — is the stack up? ({e.reason})")

    print(f"container {cid}: {data.get('from', '?')} → {data.get('status', '?')}")


def cmd_pause(args: argparse.Namespace) -> None:
    _lifecycle_call(args.container_id, "paused", "pause")


def cmd_resume(args: argparse.Namespace) -> None:
    _lifecycle_call(args.container_id, "active", "resume")


def cmd_stop(args: argparse.Namespace) -> None:
    new_status = "cancelled" if args.cancel else "completed"
    _lifecycle_call(args.container_id, new_status, "stop")


# ---------- entry ----------

def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="orcha", description="Orcha installer + lifecycle.")
    p.add_argument("--version", action="version", version=f"%(prog)s {_cli_version()}")
    sub = p.add_subparsers(dest="cmd", required=True)

    init = sub.add_parser("init", help="bootstrap Orcha in the current directory")
    init.add_argument("--name", default=None, help="project name (default: CWD basename)")
    init.add_argument("--api-port", type=int, default=None, help="host port for API (default: first free 8000+)")
    init.add_argument("--db-port", type=int, default=None, help="host port for DB (default: first free 5432+)")
    init.add_argument("--bridge-port", type=int, default=None,
                      help="host port for the live-terminal bridge (default: first free 8765+)")
    init.add_argument("--force", action="store_true", help="overwrite existing .orcha/")
    init.add_argument(
        "--reset-data", action="store_true",
        help="DESTRUCTIVE: drop this project's Postgres volume before starting so the DB "
             "comes up empty (wipes the old container + all agents/tasks/requests). "
             "Use with --force for a genuinely pristine re-init.",
    )
    # Orcha#29: bootstrap a container at init time so users don't have to /orcha-container manually
    init.add_argument("--objective", default=None,
                      help="high-level objective for the auto-created container (default: project dir name)")
    init.add_argument("--no-container", action="store_true",
                      help="skip auto-container creation (advanced: scripted setups)")
    # Orcha#30: first human agent registered at init so the human is a first-class participant
    init.add_argument("--as", dest="as_user", default=None,
                      help="alias for the first human agent (default: $USER or 'operator')")
    init.set_defaults(func=cmd_init)

    up = sub.add_parser(
        "up", help="start the stack (CWD's .orcha/, or --project <name> from anywhere)",
    )
    up.add_argument(
        "--project", default=None,
        help="target a specific project by name (sans 'orcha-' prefix); works from any directory",
    )
    up.set_defaults(func=cmd_up)

    down = sub.add_parser(
        "down", help="stop the stack (CWD's .orcha/, or --project <name> from anywhere)",
    )
    down.add_argument("-v", "--volumes", action="store_true", help="also drop the DB volume")
    down.add_argument(
        "--project", default=None,
        help="target a specific project by name (sans 'orcha-' prefix); works from any directory",
    )
    down.set_defaults(func=cmd_down)

    migrate = sub.add_parser(
        "migrate",
        help="R1: apply any pending DB migrations (migrations/*.sql) to the live DB now, "
             "without a wipe. The portal also runs them on startup, so `orcha up` migrates "
             "automatically; use this for an explicit, on-demand apply.",
    )
    migrate.set_defaults(func=cmd_migrate)

    upgrade = sub.add_parser(
        "upgrade",
        help="upgrade an existing project to the installed CLI's templates (re-render compose, "
             "re-copy portal/migrations/skills, rebuild portal) WITHOUT a data wipe. Use after a "
             "CLI reinstall so an existing project gets new portal code + compose (e.g. the R1 "
             "migration runner); then `orcha up`/startup migrates the live volume.",
    )
    upgrade.set_defaults(func=cmd_upgrade)

    update = sub.add_parser(
        "update",
        help="ONE command to apply a code change to a running project (idempotent; safe to "
             "re-run when nothing changed): reinstall the host CLI from source if editable, "
             "re-copy portal/migrations/skills + rebuild the portal with NO data wipe, apply "
             "pending migrations on startup, re-register hooks, and restart the notifier daemon "
             "+ terminal bridge so new host code takes effect — no manual kill/respawn.",
    )
    update.add_argument("--no-self", action="store_true",
                        help="skip the host-CLI reinstall/re-exec (just upgrade the project + restart daemons)")
    update.add_argument("--no-bridge", action="store_true",
                        help="don't restart the live-terminal bridge (headless host with no terminal panel)")
    update.set_defaults(func=cmd_update)

    st = sub.add_parser("status", help="show stack status + config")
    st.set_defaults(func=cmd_status)

    ls = sub.add_parser(
        "ls",
        help="list running orcha Docker stacks with their (single) container (across all projects)",
    )
    ls.set_defaults(func=cmd_ls)

    connect = sub.add_parser(
        "connect",
        help="point THIS folder at an existing orcha stack (so /orcha-* skills here "
             "target that stack's container). Use `orcha ls` to find <project-name>.",
    )
    connect.add_argument("project_name",
                         help="stack to adopt (the PROJECT column from `orcha ls`)")
    connect.add_argument("--as", dest="as_user", default=None,
                         help="register an additional human (kind='human') with this alias in one step")
    connect.set_defaults(func=cmd_connect)

    poll = sub.add_parser(
        "poll-inbox",
        help="PostToolUse hook entry — drains the background watcher's queue into "
             "Claude's next-turn context (Orcha#33). Cheap file read, not an API "
             "call; the actual polling lives in `orcha watch`.",
    )
    poll.add_argument("--alias", default=None,
                      help="binding to use (overrides $ORCHA_ALIAS and single-binding fallback)")
    poll.add_argument("--min-interval", type=float, default=5.0,
                      help="[deprecated] accepted for back-compat with older settings.json; ignored "
                           "now that polling moved to `orcha watch`")
    poll.set_defaults(func=cmd_poll_inbox)

    watch = sub.add_parser(
        "watch",
        help="background per-session poller (Orcha#33). Polls inbox + answered "
             "outbox every --interval seconds; queues new items for the PostToolUse "
             "hook to surface. SessionStart hook spawns `orcha watch --detach`; "
             "SessionEnd kills it via `orcha unwatch`.",
    )
    watch.add_argument("--alias", default=None,
                       help="binding to watch (overrides $ORCHA_ALIAS and single-binding fallback)")
    watch.add_argument("--interval", type=float, default=10.0,
                       help="seconds between API polls (default 10.0)")
    watch.add_argument("--detach", action="store_true",
                       help="fork to background and exit the parent immediately (used by SessionStart)")
    watch.set_defaults(func=cmd_watch)

    unwatch = sub.add_parser(
        "unwatch",
        help="SessionEnd partner — SIGTERMs any `orcha watch` running in this folder.",
    )
    unwatch.set_defaults(func=cmd_unwatch)

    rehydrate = sub.add_parser(
        "rehydrate",
        help="Epic C SessionStart brief — detect the stack, rebind the alias, and "
             "print a 'where we left off' summary (tasks + inbox/outbox + memory "
             "digest) into Claude's context. Runs ALONGSIDE `orcha watch`; silent "
             "no-op outside an Orcha project.",
    )
    rehydrate.add_argument("--alias", default=None,
                           help="binding to rehydrate (overrides $ORCHA_ALIAS and single-binding fallback)")
    rehydrate.set_defaults(func=cmd_rehydrate)

    use = sub.add_parser(
        "use",
        help="print `export ORCHA_ALIAS=<alias>` for eval into your shell "
             "(ssh-agent idiom): `eval \"$(orcha use Vault)\"` so /orcha-* skills "
             "resolve to that agent without --alias.",
    )
    use.add_argument("alias", help="the registered agent alias this shell should act as")
    use.set_defaults(func=cmd_use)

    snapshot = sub.add_parser(
        "snapshot",
        help="Epic C / C1: digest write-on-exit. Registered as a SessionEnd hook; a "
             "woken headless worker (ORCHA_HEADLESS_WORKER=1) snapshots a continuity "
             "digest before exiting. Immediate no-op for interactive tabs (they author "
             "via /orcha-snapshot). Reads the hook JSON payload on stdin.",
    )
    snapshot.add_argument("--alias", default=None,
                          help="binding to snapshot (overrides $ORCHA_ALIAS and single-binding fallback)")
    snapshot.set_defaults(func=cmd_snapshot)

    reach = sub.add_parser(
        "reachability",
        help="Epic A: record this session's bound-agent reachability (headless_cwd + tmux "
             "pane if any) so the notifier daemon can wake it. Registered as a SessionStart "
             "hook by init; also run by /orcha-register-agent. Silent no-op outside an Orcha project.",
    )
    reach.add_argument("--alias", default=None,
                       help="binding to record (overrides $ORCHA_ALIAS and single-binding fallback)")
    reach.add_argument("--quiet", action="store_true", help="suppress output")
    reach.set_defaults(func=cmd_reachability)

    enable = sub.add_parser(
        "enable-hook",
        help="register the SessionStart + SessionEnd + PostToolUse hooks in this "
             "folder's .claude/settings.json (idempotent). orcha init/connect do "
             "this automatically; use this for folders that pre-date Orcha#33.",
    )
    enable.set_defaults(func=cmd_enable_hook)

    notifier = sub.add_parser(
        "notifier",
        help="Epic A wake daemon — wakes IDLE agents out-of-band (tmux send-keys or "
             "`claude -p`) when they have pending events or an assigned ready task, so "
             "they resume without a human nudge. `--once` is the phase-0 cron stopgap; "
             "no flag runs the long-running daemon. NON-AI; never self-certifies.",
    )
    notifier.add_argument("--once", action="store_true",
                          help="run a single scan-and-wake tick and exit (the cron stopgap)")
    notifier.add_argument("--ensure", action="store_true",
                          help="start the daemon detached iff one isn't already running (idempotent "
                               "singleton; used by `orcha init`/`up` + the SessionStart hook)")
    notifier.add_argument("--restart", action="store_true",
                          help="ISS-22: stop the running daemon for this project's container "
                               "(bounded wait, SIGKILL after an ~8s grace) then start a FRESH one — "
                               "use after host-CLI/runtime changes")
    notifier.add_argument("--stop", action="store_true",
                          help="ISS-22: stop the notifier daemon for this project's container and exit "
                               "(no-op with a clear message if none is running). Distinct from `orcha "
                               "down`, which tears down the whole stack")
    notifier.add_argument("--dry-run", action="store_true",
                          help="print wake decisions + the exact transport command WITHOUT "
                               "sending keystrokes, spawning claude, or advancing any cursor")
    notifier.add_argument("--interval", type=float, default=2.0,
                          help="daemon loop seconds between scans (default 2.0; ignored with --once)")
    notifier.add_argument("--cooldown", type=float, default=15.0,
                          help="per-agent seconds to wait before re-waking (debounce; default 15)")
    notifier.add_argument("--min-idle", type=float, default=30.0,
                          help="only wake an agent whose last heartbeat is older than this many "
                               "seconds, i.e. it looks idle/quiescent (default 30)")
    notifier.add_argument("--lease-ttl", type=float, default=1200.0,
                          help="R2.4 single-flight + ISS-31 hard-cap backstop: seconds a headless "
                               "worker's exclusive wake lease is held (no second worker spawns until "
                               "it exits/is-killed, releasing early). Generous so a slow-but-progressing "
                               "worker isn't reaped mid-work; default 1200 (20 min)")
    notifier.add_argument("--stall-secs", type=float, default=120.0,
                          help="ISS-31: kill a headless worker only if its stream-json log hasn't grown "
                               "for this many seconds (genuinely stalled) — NOT at a fixed deadline, so "
                               "a worker that's still producing output runs to completion (default 120)")
    notifier.add_argument("--api-base", default=None,
                          help="override the API base URL (default: from .claude/orcha.json)")
    notifier.add_argument("--container", default=None,
                          help="override the container_id (default: current_container_id)")
    notifier.add_argument("--quiet", action="store_true", help="suppress per-tick output")
    notifier.set_defaults(func=cmd_notifier)

    tbridge = sub.add_parser(
        "terminal-bridge",
        help="S3 §3b: run the host-side PTY/websocket bridge for the LIVE embedded-terminal "
             "embodiment. The portal's xterm panel connects here; the bridge claims the agent's "
             "`live` lease, provisions an isolated worktree, spawns `orcha use <agent>` in a PTY, "
             "and relays stdio. Localhost/trusted-local only.",
    )
    tbridge.add_argument("--host", default=None, help="bind host (default 127.0.0.1)")
    tbridge.add_argument("--port", type=int, default=None, help="bind port (default 8765)")
    tbridge.add_argument("--api-base", default=None,
                         help="override the API base URL (default: from .claude/orcha.json)")
    tbridge.add_argument("--quiet", action="store_true", help="suppress per-session output")
    tbridge.add_argument("--ensure", action="store_true",
                         help="idempotent singleton spawn (used by up/init/SessionStart); returns immediately")
    tbridge.set_defaults(func=cmd_terminal_bridge)

    pause = sub.add_parser(
        "pause",
        help="pause an Orcha container (the project/milestone entity in the current project's DB). "
             "Uses .claude/orcha.json from CWD to find the API.",
    )
    pause.add_argument(
        "container_id", nargs="?", default=None,
        help="UUID of the Orcha container; defaults to current_container_id from .claude/orcha.json",
    )
    pause.set_defaults(func=cmd_pause)

    resume = sub.add_parser(
        "resume",
        help="resume a paused Orcha container (sets status back to active)",
    )
    resume.add_argument(
        "container_id", nargs="?", default=None,
        help="UUID of the Orcha container; defaults to current_container_id from .claude/orcha.json",
    )
    resume.set_defaults(func=cmd_resume)

    stop = sub.add_parser(
        "stop",
        help="mark an Orcha container completed (or --cancel for cancelled). "
             "NOTE: this does NOT stop the Docker stack — use `orcha down` for that.",
    )
    stop.add_argument(
        "container_id", nargs="?", default=None,
        help="UUID of the Orcha container; defaults to current_container_id from .claude/orcha.json",
    )
    stop.add_argument(
        "--cancel", action="store_true",
        help="mark cancelled instead of completed",
    )
    stop.set_defaults(func=cmd_stop)

    return p


def main() -> None:
    args = build_parser().parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
