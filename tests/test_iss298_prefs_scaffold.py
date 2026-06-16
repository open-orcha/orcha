"""#298 — the project-preferences file is a PACKAGED TEMPLATE asset, scaffolded by the CLI.

Kedar's scope addendum: ship `orcha_cli/templates/project-preferences.md` (headers + fillable
blocks) so EVERY project gets docs/orcha-project-preferences.md at `orcha init` regardless of
install method (pypi/homebrew/source) — never hand-seeded by an agent. `orcha up`/`orcha upgrade`
backfill it for existing projects. The autonomy LEVEL is never written into the file (the DB column
containers.autonomy_level is the sole engine-enforced source of truth); the file holds only the
loose zone + merge-target.

Host-CLI unit tests only — no docker, no live API. Every docker/daemon/bridge side effect that
cmd_init / cmd_up / cmd_upgrade trigger is stubbed, so we assert purely on the materialized file.
"""
import argparse
import json
import pathlib
import re

from orcha_cli import __main__ as cli  # noqa: E402  (conftest puts orcha-cli on sys.path)
from orcha_cli import terminal_bridge as tb


PREFS_REL = pathlib.Path("docs") / "orcha-project-preferences.md"


# --------------------------------------------------------------------------- helpers

def _init_namespace(**over) -> argparse.Namespace:
    ns = dict(
        name="demo", api_port=None, db_port=None, bridge_port=None,
        force=False, reset_data=False, no_container=True, objective=None,
        as_user="tester",
    )
    ns.update(over)
    return argparse.Namespace(**ns)


def _stub_externals(monkeypatch):
    monkeypatch.setattr(cli, "_compose", lambda *a, **k: None)
    monkeypatch.setattr(cli, "_copy_tree", lambda *a, **k: None)
    monkeypatch.setattr(cli, "ensure_daemon", lambda *a, **k: None)
    monkeypatch.setattr(cli, "_wait_for_portal", lambda *a, **k: None)
    monkeypatch.setattr(cli, "_install_orcha_skill_templates", lambda root: ([], []))
    monkeypatch.setattr(cli, "_write_hook_config", lambda *a, **k: False)
    monkeypatch.setattr(cli, "_install_llm_util", lambda *a, **k: None)
    monkeypatch.setattr(tb, "ensure_bridge", lambda *a, **k: None)
    monkeypatch.setattr(cli, "_find_free_port", lambda start, span=100: start)


def _make_existing_project(tmp_path: pathlib.Path) -> None:
    orcha = tmp_path / ".orcha"
    orcha.mkdir()
    (orcha / "docker-compose.yml").write_text("services: {}\n")
    claude = tmp_path / ".claude"
    claude.mkdir()
    cfg = {"project_name": "demo", "db_port": 5436, "api_port": 8003,
           "bridge_port": 8765, "api_base_url": "http://localhost:8003"}
    (claude / "orcha.json").write_text(json.dumps(cfg, indent=2) + "\n")


# --------------------------------------------------------------------------- the packaged asset

def test_template_asset_ships_and_omits_the_db_level():
    """The packaged template must exist (so it's in the wheel/sdist) AND must NOT mirror the
    autonomy level value — the DB is the sole source of truth (Kedar's CORRECTION)."""
    text = (cli.PKG_TEMPLATES / "project-preferences.md").read_text()
    assert text.strip()                                   # non-empty asset shipped
    # The read-semantics + merge-target zone are present …
    assert "min(DB ceiling, prefs" in text
    assert "Merge target branch" in text
    # … but the file never claims to STORE/serve the level: the level lives in the DB, read via API.
    assert "sole source of truth" in text
    assert "never read\n   it from here" in text or "never read it from here" in text.replace("\n   ", " ")
    # ABSENCE TOOTH (Gate 2nd-pass, req 2f1e3efd; broadened per Helm rework c2c6eec5): the
    # disclaimer prose above is necessary but not SUFFICIENT — the file must also never ASSIGN a
    # level value to autonomy. Injecting e.g. `autonomy_level = full` (or the sneakier `autonomy:
    # full` / `level = 2`) would turn the file into a second, drifting source of truth alongside the
    # DB. The tooth bans an assignment LITERAL: `autonomy_level` / `autonomy` / `level` immediately
    # followed (modulo quotes/whitespace) by `=`/`:` then a level value (the plan|pr|full enum, plus
    # near-miss tokens merge|none|0-3 a drift might use). It does NOT flag legit prose that merely
    # NAMES the column — "`autonomy_level` (DB, engine-enforced) = the CEILING" (the `=` is separated
    # from the name by other text), "What each level grants", "the DB level" — because none of those
    # put `[:=]`+value directly after the token. (Verified: zero matches on the clean template.)
    assert not re.search(
        r"\b(?:autonomy_level|autonomy|level)\b[\s\"'`]*[:=][\s\"'`]*(?:plan|pr|merge|full|none|[0-3])\b",
        text, re.IGNORECASE,
    ), "prefs template must NOT assign a level value to autonomy — the DB is the sole source of truth"


# --------------------------------------------------------------------------- init

def test_init_materializes_prefs_from_template(tmp_path, monkeypatch):
    """`orcha init` writes docs/orcha-project-preferences.md byte-for-byte from the template."""
    _stub_externals(monkeypatch)
    monkeypatch.chdir(tmp_path)

    cli.cmd_init(_init_namespace())

    written = (tmp_path / PREFS_REL).read_text()
    assert written == (cli.PKG_TEMPLATES / "project-preferences.md").read_text()


# --------------------------------------------------------------------------- backfill: up & upgrade

def test_up_backfills_prefs_when_absent(tmp_path, monkeypatch):
    """`orcha up` on a pre-#298 project (no prefs file) backfills it."""
    _stub_externals(monkeypatch)
    _make_existing_project(tmp_path)
    monkeypatch.chdir(tmp_path)
    assert not (tmp_path / PREFS_REL).exists()

    cli.cmd_up(argparse.Namespace(project=None))

    assert (tmp_path / PREFS_REL).exists()


def test_upgrade_backfills_prefs_when_absent(tmp_path, monkeypatch):
    """`orcha upgrade` on a pre-#298 project backfills the prefs file."""
    _stub_externals(monkeypatch)
    _make_existing_project(tmp_path)
    monkeypatch.chdir(tmp_path)

    cli.cmd_upgrade(argparse.Namespace(no_bridge=True))

    assert (tmp_path / PREFS_REL).exists()


# --------------------------------------------------------------------------- idempotence (never clobber)

def test_backfill_is_idempotent_never_clobbers_edits(tmp_path, monkeypatch):
    """The backfill writes only when ABSENT — a project's hand-edited rules survive up/upgrade.
    This is the tooth: drop the `if exists` guard and an operator's edits get overwritten."""
    _stub_externals(monkeypatch)
    _make_existing_project(tmp_path)
    monkeypatch.chdir(tmp_path)
    prefs = tmp_path / PREFS_REL
    prefs.parent.mkdir(parents=True, exist_ok=True)
    prefs.write_text("# edited by the operator — do not clobber\n")

    cli.cmd_upgrade(argparse.Namespace(no_bridge=True))
    cli.cmd_up(argparse.Namespace(project=None))

    assert prefs.read_text() == "# edited by the operator — do not clobber\n"


def test_install_helper_returns_path_only_on_write(tmp_path):
    """`_install_project_preferences` returns the path when it writes, None when it skips."""
    first = cli._install_project_preferences(tmp_path)
    assert first == tmp_path / PREFS_REL and first.exists()
    second = cli._install_project_preferences(tmp_path)
    assert second is None                                  # already present → skip
