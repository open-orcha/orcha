# Private Homebrew Distribution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the `orcha` CLI through a private Homebrew tap with clean install/upgrade/downgrade, per the approved spec at `docs/superpowers/specs/2026-06-11-homebrew-distribution-design.md`.

**Architecture:** The formula in a private tap (`Quantal-Labs-AI/homebrew-orcha`) installs the CLI from a git tag of the private source repo over SSH, with Python as a hidden brew dependency. A tag-driven GitHub workflow builds + smoke-tests the wheel, creates a GitHub Release, and pushes regenerated formulae (tracking `orcha.rb` + frozen `orcha@X.Y.Z.rb`) to the tap. `orcha update` learns to self-upgrade brew-managed installs. No PyPI while private (§10 of the spec covers the later flip).

**Tech Stack:** Python 3.10+ (CLI), hatchling (build), pytest (tests), GitHub Actions on the existing self-hosted Mac runner pool, Homebrew formula DSL (Ruby, generated — never hand-edited).

**Conventions you must follow (this repo):**
- All work on branch `feat/homebrew-distribution`.
- Tests live in `tests/`, run from the repo root with `pytest tests/<file> -v`. `tests/conftest.py` puts `orcha-cli/` on `sys.path`, so CLI tests import `from orcha_cli import __main__ as cli` **without installing the package**. The CLI tests in this plan are fully monkeypatched — they do NOT need the Postgres test DB.
- CI runs on `runs-on: self-hosted` (Mac pool; hosted minutes are exhausted) and uses Homebrew `python3.11` in a throwaway venv — never `actions/setup-python` (non-relocatable on these runners). Match `.github/workflows/test.yml`'s patterns.
- No HTTP routes or DB shapes change anywhere in this plan ⇒ `docs/orcha.postman_collection.json` must NOT be touched (FT-DEPLOY-4 parity is unaffected).
- Commit messages: conventional prefix (`feat:`, `docs:`, `ci:`, `test:`), ending with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

**One-time local setup for build steps (Tasks 1, 11):**

```bash
cd /Users/husseinmohamed/Desktop/quantal-projects/Orcha
python3 -m venv .plan-venv
./.plan-venv/bin/pip install --upgrade pip build twine pytest
```

`.plan-venv/` is throwaway — never `git add` it.

---

### Task 1: Package metadata — pyproject 0.2.0, license, README

A PyPI-quality `pyproject.toml` (prep for the going-public flip; harmless while private), plus the `LICENSE` and package `README.md` that hatchling needs to find *inside* `orcha-cli/`.

**Files:**
- Modify: `orcha-cli/pyproject.toml`
- Create: `orcha-cli/LICENSE` (copy of repo-root `LICENSE`)
- Create: `orcha-cli/README.md`

- [ ] **Step 1: Copy the license into the package dir**

```bash
cp LICENSE orcha-cli/LICENSE
```

- [ ] **Step 2: Create `orcha-cli/README.md`** (the package's own page; the repo README stays the full manual)

```markdown
# orcha-cli

**Human-authoritative multi-agent orchestration as Claude Code slash commands.**

`orcha` bootstraps a per-project Docker stack (Postgres + FastAPI portal) and
installs slash-command skills so multiple Claude Code sessions collaborate on
one objective under standing human authority.

- Source, full README, issues: <https://github.com/Quantal-Labs-AI/Orcha>
- Requires Docker Desktop (or OrbStack/Colima).

Quick start:

```bash
orcha init --objective "Build the thing" --as YourName
# then open Claude Code in that directory and use /orcha-* commands
```
```

- [ ] **Step 3: Replace `orcha-cli/pyproject.toml` with:**

```toml
[project]
name = "orcha-cli"
version = "0.2.0"
description = "Orcha: human-authoritative multi-agent orchestration via Claude Code skills"
readme = "README.md"
license = "MIT"
license-files = ["LICENSE"]
authors = [{ name = "Quantal Labs AI" }]
requires-python = ">=3.10"
# S3 §3b: the host-side live-terminal PTY/websocket bridge (`orcha terminal-bridge`) needs a
# websocket server. Imported lazily, so the rest of the CLI still runs if it's not yet installed.
dependencies = ["websockets>=12"]
classifiers = [
  "Development Status :: 4 - Beta",
  "Environment :: Console",
  "Intended Audience :: Developers",
  "Operating System :: MacOS",
  "Operating System :: POSIX :: Linux",
  "Programming Language :: Python :: 3",
  "Topic :: Software Development :: Build Tools",
]

[project.urls]
Homepage = "https://github.com/Quantal-Labs-AI/Orcha"
Issues = "https://github.com/Quantal-Labs-AI/Orcha/issues"
Changelog = "https://github.com/Quantal-Labs-AI/Orcha/blob/main/CHANGELOG.md"

[project.scripts]
orcha = "orcha_cli.__main__:main"

[build-system]
requires = ["hatchling"]
build-backend = "hatchling.build"

[tool.hatch.build]
include = [
  "orcha_cli/**/*.py",
  "orcha_cli/templates/**",
]

[tool.hatch.build.targets.wheel]
packages = ["orcha_cli"]
```

- [ ] **Step 4: Verify the package builds and passes twine**

```bash
rm -rf dist && ./.plan-venv/bin/python -m build orcha-cli --outdir dist
./.plan-venv/bin/twine check dist/*
```

Expected: both `orcha_cli-0.2.0-py3-none-any.whl` and `orcha_cli-0.2.0.tar.gz` build; twine prints `PASSED` for both. (If hatchling rejects `license = "MIT"` as a string, the installed hatchling is too old for PEP 639 — use `license = { text = "MIT" }` and drop `license-files` instead.)

- [ ] **Step 5: Commit**

```bash
git add orcha-cli/pyproject.toml orcha-cli/LICENSE orcha-cli/README.md
git commit -m "feat: orcha-cli 0.2.0 package metadata (license, readme, classifiers, URLs)

Prep for distribution (Orcha#17): first versioned release.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: `orcha --version`

The CLI has no version flag; the formula's `test do` block, the release smoke test, and support all need one.

**Files:**
- Modify: `orcha-cli/orcha_cli/__main__.py` (imports block ~line 11-21; `build_parser()` ~line 1810)
- Create: `tests/test_cli_version.py`

- [ ] **Step 1: Write the failing tests** — create `tests/test_cli_version.py`:

```python
"""`orcha --version` — the distribution/support surface (Homebrew formula `test do`,
release smoke test, bug reports). Reads the installed dist version; falls back to a
sentinel when running from a source tree where orcha-cli isn't pip-installed
(exactly how this test suite imports it, via conftest sys.path)."""
import re

import pytest

from orcha_cli import __main__ as cli


def test_version_flag_prints_version_and_exits_zero(capsys):
    with pytest.raises(SystemExit) as exc:
        cli.build_parser().parse_args(["--version"])
    assert exc.value.code == 0
    out = capsys.readouterr().out.strip()
    assert re.fullmatch(r"orcha \S+", out), out


def test_cli_version_falls_back_when_dist_not_installed(monkeypatch):
    def _missing(name):
        raise cli.PackageNotFoundError(name)
    monkeypatch.setattr(cli, "_pkg_version", _missing)
    assert cli._cli_version() == "0.0.0+source"
```

- [ ] **Step 2: Run to verify failure**

```bash
./.plan-venv/bin/pytest tests/test_cli_version.py -v
```

Expected: both FAIL — the first with `SystemExit: 2` (argparse: unrecognized `--version`), the second with `AttributeError: ... has no attribute 'PackageNotFoundError'`.

- [ ] **Step 3: Implement.** In `orcha-cli/orcha_cli/__main__.py`, add to the stdlib imports block (after `import importlib.resources as pkg_res`):

```python
from importlib.metadata import PackageNotFoundError
from importlib.metadata import version as _pkg_version
```

Add below the `PKG_TEMPLATES = ...` line:

```python
def _cli_version() -> str:
    """Installed orcha-cli distribution version. Source-tree runs (tests import via
    sys.path without installing) have no dist metadata — return a sentinel."""
    try:
        return _pkg_version("orcha-cli")
    except PackageNotFoundError:
        return "0.0.0+source"
```

In `build_parser()`, immediately after `p = argparse.ArgumentParser(...)`:

```python
    p.add_argument("--version", action="version", version=f"%(prog)s {_cli_version()}")
```

- [ ] **Step 4: Run to verify pass**

```bash
./.plan-venv/bin/pytest tests/test_cli_version.py tests/test_cli_update.py -v
```

Expected: all PASS (test_cli_update.py guards against parser regressions).

- [ ] **Step 5: Commit**

```bash
git add orcha-cli/orcha_cli/__main__.py tests/test_cli_version.py
git commit -m "feat: orcha --version (importlib.metadata, source-tree fallback)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: Detect a Homebrew-managed install (`_brew_keg`)

`cmd_update` phase 0 needs to know "was this orcha installed by brew, and under which formula name?". Brew links `$(brew --prefix)/bin/orcha` → `../Cellar/<formula>/<version>/...`, so: resolve symlinks, look for a `Cellar` path component, return the next component (`orcha` or `orcha@0.2.1`).

**Files:**
- Modify: `orcha-cli/orcha_cli/__main__.py` (add helper next to `_cli_source_root`, ~line 620)
- Modify: `tests/test_cli_update.py` (append tests)

- [ ] **Step 1: Write the failing tests** — append to `tests/test_cli_update.py`:

```python
# ---- Homebrew-managed install detection (spec: private brew distribution) ----

def test_brew_keg_detects_cellar_install_through_symlink(tmp_path, monkeypatch):
    """brew links bin/orcha -> ../Cellar/orcha/<ver>/...; detection must resolve
    the symlink and read the formula name from the Cellar path."""
    real = tmp_path / "Cellar" / "orcha" / "0.2.0" / "libexec" / "bin" / "orcha"
    real.parent.mkdir(parents=True)
    real.write_text("#!/bin/sh\n")
    link = tmp_path / "bin" / "orcha"
    link.parent.mkdir()
    link.symlink_to(real)
    monkeypatch.setattr(cli.shutil, "which", lambda name: str(link))
    assert cli._brew_keg() == "orcha"


def test_brew_keg_returns_versioned_formula_name(tmp_path, monkeypatch):
    p = tmp_path / "Cellar" / "orcha@0.2.1" / "0.2.1" / "bin" / "orcha"
    p.parent.mkdir(parents=True)
    p.write_text("")
    monkeypatch.setattr(cli.shutil, "which", lambda name: str(p))
    assert cli._brew_keg() == "orcha@0.2.1"


def test_brew_keg_none_for_non_brew_install(tmp_path, monkeypatch):
    p = tmp_path / "venv" / "bin" / "orcha"
    p.parent.mkdir(parents=True)
    p.write_text("")
    monkeypatch.setattr(cli.shutil, "which", lambda name: str(p))
    assert cli._brew_keg() is None


def test_brew_keg_none_when_orcha_not_on_path(monkeypatch):
    monkeypatch.setattr(cli.shutil, "which", lambda name: None)
    assert cli._brew_keg() is None
```

- [ ] **Step 2: Run to verify failure**

```bash
./.plan-venv/bin/pytest tests/test_cli_update.py -v -k brew_keg
```

Expected: 4 FAIL with `AttributeError: ... no attribute '_brew_keg'`.

- [ ] **Step 3: Implement.** In `orcha-cli/orcha_cli/__main__.py`, directly below `_cli_source_root` (~line 628), add:

```python
def _brew_keg() -> Optional[str]:
    """Return the Homebrew formula name ('orcha', or 'orcha@X.Y.Z' for a pinned
    downgrade) IFF the running `orcha` resolves into a Homebrew Cellar keg — else
    None. Resolving symlinks first matters: brew puts a link at
    $(brew --prefix)/bin/orcha pointing into the Cellar."""
    exe = shutil.which("orcha")
    if not exe:
        return None
    try:
        parts = pathlib.Path(exe).resolve().parts
    except OSError:
        return None
    for i, part in enumerate(parts[:-1]):
        if part == "Cellar":
            return parts[i + 1]
    return None
```

- [ ] **Step 4: Run to verify pass**

```bash
./.plan-venv/bin/pytest tests/test_cli_update.py -v
```

Expected: all PASS (new + pre-existing).

- [ ] **Step 5: Commit**

```bash
git add orcha-cli/orcha_cli/__main__.py tests/test_cli_update.py
git commit -m "feat: detect Homebrew-managed orcha installs (_brew_keg)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: Brew-aware `orcha update` phase 0

Today phase 0 self-reinstalls editable installs and only prints guidance for packaged ones. Add a third arm: brew-managed → `brew upgrade quantal-labs-ai/orcha/orcha` → re-exec `orcha update --no-self`, mirroring the editable path. Versioned kegs (`orcha@X.Y.Z`) are a deliberate user pin — never auto-upgraded.

**Files:**
- Modify: `orcha-cli/orcha_cli/__main__.py` (`_reinstall_cli` neighborhood ~line 632; phase 0 of `cmd_update` ~line 668-688)
- Modify: `tests/test_cli_update.py` (append tests; adjust one existing test)

- [ ] **Step 1: Write the failing tests** — append to `tests/test_cli_update.py`:

```python
# ---- phase-0 brew arm: upgrade via brew, then re-exec (mirrors editable path) ----

def test_self_update_brew_managed_upgrades_via_brew_and_reexecs(tmp_path, monkeypatch, restarts):
    monkeypatch.chdir(tmp_path)
    _make_project(tmp_path)
    monkeypatch.setattr(cli, "_cli_source_root", lambda: None)
    monkeypatch.setattr(cli, "_brew_keg", lambda: "orcha")
    upgraded = {}
    monkeypatch.setattr(cli, "_brew_upgrade", lambda keg: upgraded.setdefault("keg", keg) or True)
    forwarded = {}

    class _Done(Exception):
        pass

    def _fake_run(cmd, *a, **k):
        forwarded["cmd"] = cmd
        raise _Done

    monkeypatch.setattr(cli.subprocess, "run", _fake_run)

    with pytest.raises(_Done):
        cli.cmd_update(_ns(no_self=False))

    assert upgraded["keg"] == "orcha"
    assert forwarded["cmd"][1:] == ["update", "--no-self"]
    assert restarts["upgrade"] == 0     # phases 1-3 deferred to the re-exec'd child


def test_self_update_brew_failure_continues_in_process(tmp_path, monkeypatch, restarts):
    monkeypatch.chdir(tmp_path)
    _make_project(tmp_path)
    monkeypatch.setattr(cli, "_cli_source_root", lambda: None)
    monkeypatch.setattr(cli, "_brew_keg", lambda: "orcha")
    monkeypatch.setattr(cli, "_brew_upgrade", lambda keg: False)

    cli.cmd_update(_ns(no_self=False))   # must not raise; runs phases 1-3 with current code

    assert restarts["upgrade"] == 1 and restarts["daemon"] == [True]


def test_brew_upgrade_never_moves_a_versioned_pin(monkeypatch, capsys):
    """orcha@X.Y.Z is an explicit downgrade pin; _brew_upgrade must refuse without
    ever invoking brew."""
    monkeypatch.setattr(cli.subprocess, "run",
                        lambda *a, **k: pytest.fail("must not invoke brew for a pinned keg"))
    assert cli._brew_upgrade("orcha@0.2.1") is False
    assert "pinned" in capsys.readouterr().out


def test_brew_upgrade_warns_when_brew_missing(monkeypatch, capsys):
    monkeypatch.setattr(cli.shutil, "which", lambda name: None)
    assert cli._brew_upgrade("orcha") is False
    assert "brew" in capsys.readouterr().err
```

Also **adjust the existing** `test_self_update_skipped_for_packaged_install`: it monkeypatches only `_cli_source_root`; once phase 0 also consults `_brew_keg`, the test would depend on the dev machine's real PATH. Add one line right after its `_cli_source_root` monkeypatch:

```python
    monkeypatch.setattr(cli, "_brew_keg", lambda: None)
```

- [ ] **Step 2: Run to verify failure**

```bash
./.plan-venv/bin/pytest tests/test_cli_update.py -v -k "brew_upgrade or brew_managed or brew_failure"
```

Expected: 4 FAIL (`_brew_upgrade` missing / brew arm not taken).

- [ ] **Step 3: Implement.** In `orcha-cli/orcha_cli/__main__.py`, below `_reinstall_cli`, add:

```python
def _brew_upgrade(keg: str) -> bool:
    """Self-upgrade a Homebrew-managed orcha. A versioned keg (orcha@X.Y.Z) is an
    explicit user pin — refuse so `orcha update` never silently moves a downgrade."""
    if "@" in keg:
        print(f"[orcha] host CLI is pinned to versioned formula {keg} — skipping "
              "self-upgrade (brew install quantal-labs-ai/orcha/orcha to track releases).")
        return False
    brew = shutil.which("brew")
    if not brew:
        print("[orcha] warn: Homebrew install detected but `brew` is not on PATH; "
              "upgrade manually with `brew upgrade orcha`.", file=sys.stderr)
        return False
    cmd = [brew, "upgrade", f"quantal-labs-ai/orcha/{keg}"]
    print(f"[orcha] upgrading host CLI via Homebrew\n        $ {' '.join(cmd)}")
    try:
        return subprocess.run(cmd).returncode == 0
    except (OSError, subprocess.SubprocessError) as e:
        print(f"[orcha] warn: could not launch brew ({e})", file=sys.stderr)
        return False
```

Then replace phase 0 of `cmd_update` (the whole `if not args.no_self:` block) with:

```python
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
```

(The editable arm is byte-identical to today's behavior; only the `elif keg`/`else` split is new. Keep the existing comment lines.)

- [ ] **Step 4: Run to verify pass**

```bash
./.plan-venv/bin/pytest tests/test_cli_update.py tests/test_cli_version.py -v
```

Expected: all PASS, including the pre-existing editable/packaged/refusal tests.

- [ ] **Step 5: Commit**

```bash
git add orcha-cli/orcha_cli/__main__.py tests/test_cli_update.py
git commit -m "feat: orcha update self-upgrades Homebrew-managed installs via brew

Mirrors the editable-install phase 0: brew upgrade + re-exec --no-self.
Versioned kegs (orcha@X.Y.Z) are an explicit pin and are never auto-upgraded.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: Formula template + renderer

Formulae are **generated**, never hand-edited: one template, rendered twice per release — tracking `orcha.rb` and frozen `orcha@X.Y.Z.rb` (the downgrade story). Pure-stdlib script so the release workflow and humans run it identically.

**Files:**
- Create: `packaging/homebrew/orcha.rb.tmpl`
- Create: `packaging/homebrew/render_formula.py`
- Test: `tests/test_homebrew_formula.py`

- [ ] **Step 1: Write the failing tests** — create `tests/test_homebrew_formula.py`:

```python
"""Formula rendering for the private Homebrew tap (spec:
docs/superpowers/specs/2026-06-11-homebrew-distribution-design.md §1-§3).
The release workflow renders a tracking `orcha.rb` plus a frozen
`orcha@X.Y.Z.rb` per release; these tests pin the contract."""
import importlib.util
import pathlib

import pytest

_SCRIPT = (pathlib.Path(__file__).resolve().parents[1]
           / "packaging" / "homebrew" / "render_formula.py")
_spec = importlib.util.spec_from_file_location("render_formula", _SCRIPT)
rf = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(rf)

SHA = "a" * 40


def test_class_name_plain():
    assert rf.class_name("orcha") == "Orcha"


def test_class_name_versioned_follows_brew_at_convention():
    # brew: foo@1.2.3 -> FooAT123 (non-alphanumerics dropped after AT)
    assert rf.class_name("orcha@0.2.1") == "OrchaAT021"


def test_tracking_formula_pins_tag_and_revision_no_leftover_placeholders():
    out = rf.render("0.2.0", SHA, versioned=False)
    assert "class Orcha < Formula" in out
    assert 'tag:      "v0.2.0"' in out
    assert f'revision: "{SHA}"' in out
    assert 'version "0.2.0"' in out
    assert "conflicts_with" not in out
    assert "{{" not in out and "}}" not in out


def test_versioned_formula_conflicts_with_tracking_formula():
    out = rf.render("0.2.0", SHA, versioned=True)
    assert "class OrchaAT020 < Formula" in out
    assert 'conflicts_with "orcha"' in out


def test_main_writes_both_formulae(tmp_path, monkeypatch):
    monkeypatch.setattr(rf.sys, "argv",
                        ["render_formula.py", "0.2.0", SHA, str(tmp_path)])
    rf.main()
    assert (tmp_path / "orcha.rb").exists()
    assert (tmp_path / "orcha@0.2.0.rb").exists()


@pytest.mark.parametrize("version,revision", [
    ("0.2", SHA),            # not X.Y.Z
    ("v0.2.0", SHA),         # leading v belongs to the tag, not the version
    ("0.2.0", "short-sha"),  # not a 40-char commit sha
])
def test_main_rejects_malformed_inputs(tmp_path, monkeypatch, version, revision):
    monkeypatch.setattr(rf.sys, "argv",
                        ["render_formula.py", version, revision, str(tmp_path)])
    with pytest.raises(SystemExit):
        rf.main()
```

- [ ] **Step 2: Run to verify failure**

```bash
./.plan-venv/bin/pytest tests/test_homebrew_formula.py -v
```

Expected: collection error — `FileNotFoundError` for `packaging/homebrew/render_formula.py`.

- [ ] **Step 3: Create `packaging/homebrew/orcha.rb.tmpl`:**

```ruby
class {{CLASS_NAME}} < Formula
  include Language::Python::Virtualenv

  desc "Human-authoritative multi-agent orchestration for Claude Code"
  homepage "https://github.com/Quantal-Labs-AI/Orcha"
  # Private repo: git-over-SSH — the installer's GitHub org access IS the auth.
  # `revision` pins the exact commit (the git-source equivalent of a sha256).
  url "git@github.com:Quantal-Labs-AI/Orcha.git",
      using:    :git,
      tag:      "v{{VERSION}}",
      revision: "{{REVISION}}"
  version "{{VERSION}}"
  license "MIT"
{{CONFLICTS}}
  depends_on "python@3.13"

  # The CLI's single runtime dep, pinned. Bump together with the
  # `dependencies` line in orcha-cli/pyproject.toml.
  resource "websockets" do
    url "https://files.pythonhosted.org/packages/04/24/4b2031d72e840ce4c1ccb255f693b15c334757fc50023e4db9537080b8c4/websockets-16.0.tar.gz"
    sha256 "5f6261a5e56e8d5c42a4497b364ea24d94d9563e8fbd44e78ac40879c60179b5"
  end

  def install
    venv = virtualenv_create(libexec, "python3.13")
    venv.pip_install resources
    venv.pip_install buildpath/"orcha-cli"
    bin.install_symlink libexec/"bin/orcha"
  end

  def caveats
    <<~EOS
      Orcha drives per-project Docker stacks. Docker Desktop (or OrbStack/
      Colima) must be installed and running before `orcha init`:
        https://docs.docker.com/desktop/setup/install/mac-install/

      Note: DB migrations are forward-only. Downgrading the CLI keeps the
      newer (additive) schema; a true rollback is `orcha down -v` + re-init
      (DESTRUCTIVE: wipes that project's data).
    EOS
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/orcha --version")
  end
end
```

- [ ] **Step 4: Create `packaging/homebrew/render_formula.py`:**

```python
#!/usr/bin/env python3
"""Render the Homebrew formulae for a release: a tracking Formula/orcha.rb plus a
frozen Formula/orcha@X.Y.Z.rb (the downgrade target). Pure stdlib — used by
.github/workflows/publish.yml and runnable by hand.

Usage: render_formula.py VERSION REVISION OUT_DIR
  VERSION   release version, X.Y.Z (no leading v)
  REVISION  full 40-char commit sha the vX.Y.Z tag points at
  OUT_DIR   directory to write orcha.rb and orcha@X.Y.Z.rb into
"""
import pathlib
import re
import sys

TEMPLATE = pathlib.Path(__file__).with_name("orcha.rb.tmpl")


def class_name(formula_name: str) -> str:
    """Homebrew's name→class rule: capitalize -/_ segments; '@' becomes 'AT' with
    non-alphanumerics dropped: orcha@0.2.1 → OrchaAT021 (cf. python@3.13 → PythonAT313)."""
    base, _, ver = formula_name.partition("@")
    cls = "".join(seg.capitalize() for seg in re.split(r"[-_]", base))
    if ver:
        cls += "AT" + re.sub(r"[^A-Za-z0-9]", "", ver)
    return cls


def render(version: str, revision: str, *, versioned: bool) -> str:
    name = f"orcha@{version}" if versioned else "orcha"
    conflicts = (
        "\n  # A frozen downgrade target — can't coexist with the tracking formula.\n"
        '  conflicts_with "orcha", because: "both install an `orcha` binary"\n'
        if versioned else ""
    )
    return (
        TEMPLATE.read_text()
        .replace("{{CLASS_NAME}}", class_name(name))
        .replace("{{VERSION}}", version)
        .replace("{{REVISION}}", revision)
        .replace("{{CONFLICTS}}", conflicts)
    )


def main() -> None:
    if len(sys.argv) != 4:
        sys.exit(__doc__)
    version, revision, out = sys.argv[1], sys.argv[2], pathlib.Path(sys.argv[3])
    if not re.fullmatch(r"\d+\.\d+\.\d+", version):
        sys.exit(f"error: VERSION must be X.Y.Z (no leading v), got {version!r}")
    if not re.fullmatch(r"[0-9a-f]{40}", revision):
        sys.exit(f"error: REVISION must be a full 40-char commit sha, got {revision!r}")
    out.mkdir(parents=True, exist_ok=True)
    (out / "orcha.rb").write_text(render(version, revision, versioned=False))
    (out / f"orcha@{version}.rb").write_text(render(version, revision, versioned=True))
    print(f"rendered orcha.rb + orcha@{version}.rb -> {out}")


if __name__ == "__main__":
    main()
```

- [ ] **Step 5: Run to verify pass**

```bash
./.plan-venv/bin/pytest tests/test_homebrew_formula.py -v
```

Expected: all 7 PASS.

- [ ] **Step 6: Commit**

```bash
git add packaging/homebrew/orcha.rb.tmpl packaging/homebrew/render_formula.py tests/test_homebrew_formula.py
git commit -m "feat: Homebrew formula template + renderer (tracking + frozen orcha@X.Y.Z)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6: Tap seed (README + tap CI) + one-time bootstrap script

The tap repo is pure derived artifact: `Formula/` is owned by the release workflow; the seed is just the tap's README and its CI. The bootstrap script creates + seeds the private repo once (human runs it — needs org repo-create rights).

**Files:**
- Create: `packaging/homebrew/tap-seed/README.md`
- Create: `packaging/homebrew/tap-seed/.github/workflows/test.yml`
- Create: `packaging/homebrew/bootstrap_tap.sh`

- [ ] **Step 1: Create `packaging/homebrew/tap-seed/README.md`:**

```markdown
# homebrew-orcha — private tap for the `orcha` CLI

**Access = Quantal-Labs-AI org membership + a working GitHub SSH key**
(`ssh -T git@github.com` should greet you). Formulae fetch the private source
repo over SSH; there are no tokens to configure.

## Install

```bash
brew tap quantal-labs-ai/orcha git@github.com:Quantal-Labs-AI/homebrew-orcha.git
brew install quantal-labs-ai/orcha/orcha
```

Docker Desktop (or OrbStack/Colima) is required before `orcha init` — the
formula prints the same caveat.

## Upgrade

```bash
brew upgrade orcha     # CLI only
orcha update           # in a project: CLI (via brew) + templates + portal + DB
```

## Hold a version

```bash
brew pin orcha         # brew upgrade skips it until brew unpin
```

## Downgrade

Every release leaves a frozen formula behind:

```bash
brew uninstall orcha
brew install quantal-labs-ai/orcha/orcha@0.2.0
```

`orcha update` will NOT auto-upgrade a versioned install (it's treated as a
deliberate pin). Note: DB migrations are forward-only — a downgraded CLI runs
fine against the newer (additive) schema; a true schema rollback is
`orcha down -v` + re-init (DESTRUCTIVE: wipes that project's data).

## Maintenance

`Formula/*.rb` are **generated** by the
[Orcha release workflow](https://github.com/Quantal-Labs-AI/Orcha/blob/main/.github/workflows/publish.yml).
Don't edit them here — change `packaging/homebrew/` in the main repo and cut a
release.
```

- [ ] **Step 2: Create `packaging/homebrew/tap-seed/.github/workflows/test.yml`:**

```yaml
name: tap-ci

on:
  pull_request:
  push:
    branches: [main]

concurrency:
  group: tap-ci-${{ github.ref }}
  cancel-in-progress: true

jobs:
  audit-and-install:
    # Self-hosted Mac pool (same as the main repo): has brew, and its SSH key
    # can read the private source repo — required because the formula's
    # `url` is git-over-SSH.
    runs-on: self-hosted
    steps:
      - uses: actions/checkout@v4

      - name: Expose this checkout as the tap
        # brew only audits/installs formulae that live inside a tap directory,
        # so symlink the checkout into brew's Taps tree for the duration.
        run: |
          TAP_DIR="$(brew --repository)/Library/Taps/quantal-labs-ai/homebrew-orcha"
          mkdir -p "$(dirname "$TAP_DIR")"
          rm -rf "$TAP_DIR"
          ln -s "$GITHUB_WORKSPACE" "$TAP_DIR"

      - name: Audit
        # plain audit (not --strict): --strict rejects non-public URLs, and the
        # formula URL is intentionally git-over-SSH while the repo is private.
        run: brew audit --tap quantal-labs-ai/orcha || true

      - name: Install from source + smoke test
        run: |
          brew install --build-from-source quantal-labs-ai/orcha/orcha
          "$(brew --prefix)/bin/orcha" --version

      - name: Clean up
        if: always()
        run: |
          brew uninstall --force orcha || true
          rm -f "$(brew --repository)/Library/Taps/quantal-labs-ai/homebrew-orcha"
```

- [ ] **Step 3: Create `packaging/homebrew/bootstrap_tap.sh`:**

```bash
#!/usr/bin/env bash
# One-time bootstrap of the PRIVATE tap repo Quantal-Labs-AI/homebrew-orcha.
# Seeds README + CI only — Formula/ is owned by the release workflow, which
# pushes rendered formulae on every vX.Y.Z tag (so the tap stays installable
# only after the first release exists).
#
# Requires: `gh` authenticated with rights to create org repos, and SSH push
# access to the new repo. Safe to re-run: repo creation is skipped if it
# exists; the seed push is a plain commit (no force).
set -euo pipefail

ORG="Quantal-Labs-AI"
TAP_REPO="homebrew-orcha"
HERE="$(cd "$(dirname "$0")" && pwd)"

gh repo view "$ORG/$TAP_REPO" >/dev/null 2>&1 || {
  echo "creating private repo $ORG/$TAP_REPO ..."
  gh repo create "$ORG/$TAP_REPO" --private \
    -d "Private Homebrew tap for the orcha CLI (formulae are generated by the release workflow)"
}

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
git clone "git@github.com:$ORG/$TAP_REPO.git" "$WORK/tap"
cp -R "$HERE/tap-seed/." "$WORK/tap/"
git -C "$WORK/tap" add -A
if git -C "$WORK/tap" diff --cached --quiet; then
  echo "tap already seeded — nothing to push"
else
  git -C "$WORK/tap" commit -m "seed tap: README + CI (formulae arrive with the first release)"
  git -C "$WORK/tap" push origin HEAD:main
fi
echo "✓ tap ready: https://github.com/$ORG/$TAP_REPO"
echo "  next: add TAP_GITHUB_TOKEN secret to $ORG/Orcha, then tag v0.2.0"
```

- [ ] **Step 4: Validate the script parses and the workflow is well-formed YAML**

```bash
bash -n packaging/homebrew/bootstrap_tap.sh && chmod +x packaging/homebrew/bootstrap_tap.sh
./.plan-venv/bin/python -c "import yaml,sys; yaml.safe_load(open('packaging/homebrew/tap-seed/.github/workflows/test.yml')); print('yaml ok')"
```

Expected: no output from `bash -n`; `yaml ok`. (If PyYAML isn't in the venv: `./.plan-venv/bin/pip install pyyaml`.)

- [ ] **Step 5: Commit**

```bash
git add packaging/homebrew/tap-seed packaging/homebrew/bootstrap_tap.sh
git commit -m "feat: tap seed (README + tap CI) and one-time bootstrap script

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 7: CHANGELOG.md

Keep-a-Changelog format; the release workflow (Task 9) extracts the tagged version's section for the GitHub Release body and **fails the release if the section is missing** — that's the semver-discipline guard from issue #17.

**Files:**
- Create: `CHANGELOG.md`

- [ ] **Step 1: Create `CHANGELOG.md`:**

```markdown
# Changelog

User-visible changes to the `orcha` CLI. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
semver (0.x until the agent-suggestion path lands — Orcha#17). **Every PR that
ships a user-visible change adds a bullet under [Unreleased]**; cutting a
release renames that section to the version + date. The release workflow
publishes the tagged section as the GitHub Release notes and fails if it's
missing.

## [Unreleased]

## [0.2.0] - 2026-06-11

### Added
- `orcha --version`.
- Private Homebrew distribution: `brew tap quantal-labs-ai/orcha
  git@github.com:Quantal-Labs-AI/homebrew-orcha.git && brew install
  quantal-labs-ai/orcha/orcha`. Python arrives as a hidden brew dependency.
- `orcha update` self-upgrades a Homebrew-managed CLI (`brew upgrade`) before
  updating the project — one command for CLI + templates + portal + DB.
  Versioned installs (`orcha@X.Y.Z`) are treated as pins and never moved.
- Tag-driven release workflow: build + smoke test + GitHub Release + tap
  formula bump, including a frozen `orcha@X.Y.Z` formula per release for
  downgrades.

### Changed
- First versioned release. Everything before 0.2.0 was installed from a
  source clone (`uv tool install --from ... orcha-cli`).
```

(If the v0.2.0 tag ends up cut on a different day, update the date in the same PR that tags.)

- [ ] **Step 2: Verify the extraction command the workflow will use finds the section**

```bash
awk -v ver="0.2.0" '$0 ~ "^## \\[" ver "\\]" {flag=1; next} /^## \[/ {flag=0} flag' CHANGELOG.md
```

Expected: prints the `### Added` / `### Changed` body (non-empty).

- [ ] **Step 3: Commit**

```bash
git add CHANGELOG.md
git commit -m "docs: CHANGELOG.md (Keep-a-Changelog; 0.2.0 section feeds release notes)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 8: PR build-check workflow

Catches packaging breakage at PR time (spec §7): build sdist+wheel, `twine check`, install the wheel in a clean venv, run `orcha --version`.

**Files:**
- Create: `.github/workflows/build-check.yml`

- [ ] **Step 1: Create `.github/workflows/build-check.yml`:**

```yaml
name: build-check

on:
  pull_request:
    paths:
      - "orcha-cli/**"
      - "packaging/**"
      - ".github/workflows/build-check.yml"

concurrency:
  group: build-check-${{ github.ref }}
  cancel-in-progress: true

jobs:
  build:
    # Self-hosted Mac pool; Homebrew python3.11 in a throwaway venv —
    # actions/setup-python is non-relocatable on these runners (see test.yml).
    runs-on: self-hosted
    steps:
      - uses: actions/checkout@v4

      - name: Build sdist + wheel, twine check, wheel smoke test
        run: |
          PY="$(command -v python3.11 || echo /opt/homebrew/bin/python3.11)"
          rm -rf .build-venv dist
          "$PY" -m venv .build-venv
          ./.build-venv/bin/pip install --upgrade pip build twine
          ./.build-venv/bin/python -m build orcha-cli --outdir dist
          ./.build-venv/bin/twine check dist/*
          rm -rf .smoke-venv
          "$PY" -m venv .smoke-venv
          ./.smoke-venv/bin/pip install dist/*.whl
          ./.smoke-venv/bin/orcha --version

      - name: Clean up venvs
        if: always()
        run: rm -rf .build-venv .smoke-venv dist
```

- [ ] **Step 2: Validate YAML**

```bash
./.plan-venv/bin/python -c "import yaml; yaml.safe_load(open('.github/workflows/build-check.yml')); print('yaml ok')"
```

Expected: `yaml ok`.

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/build-check.yml
git commit -m "ci: PR build-check for orcha-cli packaging (build + twine + wheel smoke)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 9: Release workflow (`publish.yml`)

Tag `vX.Y.Z` → guard → build → smoke → GitHub Release (notes from CHANGELOG) → render + push formulae to the tap. `workflow_dispatch` runs only build + smoke (the spec §7 dry-run — pipeline testable before the first real tag).

**Files:**
- Create: `.github/workflows/publish.yml`

- [ ] **Step 1: Create `.github/workflows/publish.yml`:**

```yaml
name: release

on:
  push:
    tags: ["v*"]
  # Dry-run: build + smoke only — no release, no tap push. Lets us validate the
  # pipeline before the first real tag (spec §7).
  workflow_dispatch:

concurrency:
  group: release-${{ github.ref }}
  cancel-in-progress: false

jobs:
  release:
    # Self-hosted Mac pool; Homebrew python3.11 venv (see test.yml for why not
    # actions/setup-python). tomllib needs 3.11+ — this venv provides it.
    runs-on: self-hosted
    steps:
      - uses: actions/checkout@v4

      - name: Create venv
        run: |
          PY="$(command -v python3.11 || echo /opt/homebrew/bin/python3.11)"
          rm -rf .release-venv
          "$PY" -m venv .release-venv
          ./.release-venv/bin/pip install --upgrade pip build twine

      - name: Guard — tag must equal pyproject version
        if: github.event_name == 'push'
        run: |
          TAG_V="${GITHUB_REF_NAME#v}"
          PKG_V="$(./.release-venv/bin/python -c "import tomllib;print(tomllib.load(open('orcha-cli/pyproject.toml','rb'))['project']['version'])")"
          if [ "$TAG_V" != "$PKG_V" ]; then
            echo "::error::tag ${GITHUB_REF_NAME} != pyproject version ${PKG_V} — bump orcha-cli/pyproject.toml first" >&2
            exit 1
          fi

      - name: Build sdist + wheel
        run: |
          rm -rf dist
          ./.release-venv/bin/python -m build orcha-cli --outdir dist
          ./.release-venv/bin/twine check dist/*

      - name: Smoke test the wheel
        run: |
          PY="$(command -v python3.11 || echo /opt/homebrew/bin/python3.11)"
          rm -rf .smoke-venv
          "$PY" -m venv .smoke-venv
          ./.smoke-venv/bin/pip install dist/*.whl
          OUT="$(./.smoke-venv/bin/orcha --version)"
          PKG_V="$(./.release-venv/bin/python -c "import tomllib;print(tomllib.load(open('orcha-cli/pyproject.toml','rb'))['project']['version'])")"
          echo "smoke: '$OUT' (want 'orcha $PKG_V')"
          [ "$OUT" = "orcha $PKG_V" ]

      - name: Extract release notes from CHANGELOG.md
        if: github.event_name == 'push'
        run: |
          VERSION="${GITHUB_REF_NAME#v}"
          awk -v ver="$VERSION" '$0 ~ "^## \\[" ver "\\]" {flag=1; next} /^## \[/ {flag=0} flag' CHANGELOG.md > .release-notes.md
          if ! [ -s .release-notes.md ]; then
            echo "::error::CHANGELOG.md has no '## [${VERSION}]' section — add it before tagging" >&2
            exit 1
          fi

      - name: Create GitHub release (private repo => release stays private)
        if: github.event_name == 'push'
        env:
          GH_TOKEN: ${{ github.token }}
        run: |
          gh release create "$GITHUB_REF_NAME" dist/* \
            --title "orcha $GITHUB_REF_NAME" \
            --notes-file .release-notes.md

      - name: Render + push tap formulae (tracking orcha.rb + frozen orcha@X.Y.Z.rb)
        if: github.event_name == 'push'
        env:
          TAP_TOKEN: ${{ secrets.TAP_GITHUB_TOKEN }}
        run: |
          VERSION="${GITHUB_REF_NAME#v}"
          # rev-list dereferences annotated tags to the commit the formula must pin.
          REVISION="$(git rev-list -n1 "$GITHUB_REF_NAME")"
          WORK="$(mktemp -d)"
          git clone "https://x-access-token:${TAP_TOKEN}@github.com/Quantal-Labs-AI/homebrew-orcha.git" "$WORK/tap"
          ./.release-venv/bin/python packaging/homebrew/render_formula.py "$VERSION" "$REVISION" "$WORK/tap/Formula"
          git -C "$WORK/tap" add Formula
          if git -C "$WORK/tap" diff --cached --quiet; then
            echo "tap already at $VERSION — nothing to push (idempotent re-run)"
          else
            git -C "$WORK/tap" -c user.name=orcha-release-bot -c user.email=releases@quantal-labs.ai \
              commit -m "orcha ${VERSION}"
            git -C "$WORK/tap" push origin HEAD:main
          fi
          rm -rf "$WORK"

      - name: Clean up venvs
        if: always()
        run: rm -rf .release-venv .smoke-venv dist .release-notes.md
```

- [ ] **Step 2: Validate YAML**

```bash
./.plan-venv/bin/python -c "import yaml; yaml.safe_load(open('.github/workflows/publish.yml')); print('yaml ok')"
```

Expected: `yaml ok`.

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/publish.yml
git commit -m "ci: tag-driven release — build, smoke, GitHub Release, tap formula bump

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 10: README restructure + CONTRIBUTING.md

README leads with the brew install (spec §5); the local-clone/editable/cache-clean material moves to `CONTRIBUTING.md` together with the release runbook.

**Files:**
- Modify: `README.md` (the `## Prerequisites` table row for uv ~line 398, and the whole `## Install the \`orcha\` CLI` section, lines ~404-431)
- Create: `CONTRIBUTING.md`

- [ ] **Step 1: In `README.md`, update the Prerequisites table** — replace the `**\`uv\`**` row:

```markdown
| **Homebrew** | installs the orcha CLI | <https://brew.sh> |
```

- [ ] **Step 2: Replace the body of `## Install the `orcha` CLI`** (everything from "While unpublished (pre-PyPI)..." through the "When this gets published, it'll be one of:" code block, keeping the `## Install the \`orcha\` CLI` heading and the trailing `---`) with:

```markdown
One-time tap (private repo — your GitHub org SSH access is the auth):

```bash
brew tap quantal-labs-ai/orcha git@github.com:Quantal-Labs-AI/homebrew-orcha.git
brew install quantal-labs-ai/orcha/orcha
```

Verify:

```bash
orcha --version
orcha --help
```

Upgrade with `brew upgrade orcha` — or just run `orcha update` inside a
project: it upgrades the CLI via brew, then the project's templates, portal,
and DB in one shot. Downgrade via the frozen per-release formulae
(`brew install quantal-labs-ai/orcha/orcha@<version>`); details in the
[tap README](https://github.com/Quantal-Labs-AI/homebrew-orcha).

Hacking on Orcha itself (editable install from a clone)? See
[CONTRIBUTING.md](./CONTRIBUTING.md).
```

- [ ] **Step 3: Create `CONTRIBUTING.md`:**

```markdown
# Contributing / hacking on Orcha

## Local (editable) install

End users install via the private Homebrew tap (see README). For working on
the CLI itself, install from your clone:

```bash
git clone git@github.com:Quantal-Labs-AI/Orcha.git ~/src/orcha
uv tool install --from ~/src/orcha/orcha-cli orcha-cli
```

### The uv wheel-cache footgun

uv caches the built wheel **by version number** — editing source without
bumping the version means `--force`/`--reinstall` alone can hand you the stale
wheel. Always do the full dance after template/CLI edits:

```bash
uv cache clean orcha-cli
uv tool install --reinstall --from ~/src/orcha/orcha-cli orcha-cli
```

Then re-render in a scratch project:

```bash
cd /tmp/orcha-demo && orcha down -v 2>/dev/null; rm -rf .orcha .claude && orcha init
```

(End users never hit this: brew installs a fresh keg per version.)

Editable installs get a bonus: `orcha update` detects the source checkout and
self-reinstalls from it before updating the project.

## Tests

```bash
make test-install   # once: test deps (pip)
pytest -q           # needs Postgres at ORCHA_TEST_ADMIN_URL (default localhost:5432, user/pass orcha)
```

The CLI/distribution tests run without a DB:

```bash
pytest tests/test_cli_update.py tests/test_cli_version.py tests/test_homebrew_formula.py -q
```

## Cutting a release

1. In the release PR: bump `version` in `orcha-cli/pyproject.toml` and rename
   the `[Unreleased]` section of `CHANGELOG.md` to `[X.Y.Z] - <date>`.
   Semver 0.x discipline: patch bump per user-visible change (Orcha#17).
2. Merge, then tag the merge commit and push the tag:

   ```bash
   git tag vX.Y.Z && git push origin vX.Y.Z
   ```

3. `.github/workflows/publish.yml` does the rest: version guard, build, wheel
   smoke test, GitHub Release (notes = the CHANGELOG section), and pushes the
   regenerated formulae (tracking `orcha.rb` + frozen `orcha@X.Y.Z.rb`) to the
   private tap.
4. Dry-run any time via the workflow's "Run workflow" button
   (`workflow_dispatch` = build + smoke only).

First-time setup (once per org, already done if the tap exists): run
`packaging/homebrew/bootstrap_tap.sh`, then add a fine-grained PAT with
contents:write on `homebrew-orcha` as the `TAP_GITHUB_TOKEN` secret in this
repo. Going public later (PyPI + public tap) is spec'd in
`docs/superpowers/specs/2026-06-11-homebrew-distribution-design.md` §10.
```

- [ ] **Step 4: Sanity-check the README edits render** — view the section and confirm no broken fences:

```bash
sed -n '393,435p' README.md
```

Expected: prerequisites table shows Homebrew (uv row gone), install section shows the tap+install commands, no dangling ``` fences.

- [ ] **Step 5: Commit**

```bash
git add README.md CONTRIBUTING.md
git commit -m "docs: brew-first install in README; move dev install + release runbook to CONTRIBUTING

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 11: Final verification + PR

- [ ] **Step 1: Run the full touched-test set + a clean build**

```bash
./.plan-venv/bin/pytest tests/test_cli_update.py tests/test_cli_version.py tests/test_homebrew_formula.py tests/test_iss40_upgrade_hooks.py -v
rm -rf dist && ./.plan-venv/bin/python -m build orcha-cli --outdir dist && ./.plan-venv/bin/twine check dist/*
```

Expected: all tests PASS; build + twine PASS. (`test_iss40_upgrade_hooks.py` guards `cmd_upgrade`, which Task 4's phase-0 edit sits next to — run it to be sure.)

- [ ] **Step 2: Confirm the Postman collection is untouched**

```bash
git diff main --stat -- docs/orcha.postman_collection.json
```

Expected: empty output (no API/DB change in this plan ⇒ FT-DEPLOY-4 parity holds).

- [ ] **Step 3: Push and open the PR**

```bash
git push -u origin feat/homebrew-distribution
gh pr create --title "Private Homebrew distribution for orcha-cli (Orcha#17)" --body "$(cat <<'EOF'
## What

Closes the distribution half of #17 (PyPI deferred to the going-public flip — spec §10):

- **Install:** private tap — `brew tap quantal-labs-ai/orcha git@github.com:Quantal-Labs-AI/homebrew-orcha.git && brew install quantal-labs-ai/orcha/orcha`. Python is a hidden brew dep; org SSH access is the auth.
- **Upgrade:** `brew upgrade orcha`, or just `orcha update` — phase 0 now self-upgrades brew-managed installs (mirrors the editable path) before updating templates/portal/DB.
- **Downgrade:** every release pushes a frozen `orcha@X.Y.Z` formula; versioned installs are treated as pins (`orcha update` won't move them). Forward-only-migration caveat documented in formula caveats + tap README.
- **Release pipeline:** tag `vX.Y.Z` → version guard → build + wheel smoke → GitHub Release (notes from CHANGELOG) → render+push tap formulae. `workflow_dispatch` = dry-run.
- `orcha --version`, CHANGELOG.md, CONTRIBUTING.md (dev install + release runbook), README brew-first install, PR build-check workflow.

Spec: `docs/superpowers/specs/2026-06-11-homebrew-distribution-design.md`
Plan: `docs/superpowers/plans/2026-06-11-homebrew-distribution.md`

## Post-merge (one-time, human)

1. `packaging/homebrew/bootstrap_tap.sh` (creates + seeds the private tap repo)
2. Add `TAP_GITHUB_TOKEN` secret (fine-grained PAT, contents:write on homebrew-orcha)
3. `git tag v0.2.0 && git push origin v0.2.0`

## Notes

- No HTTP routes / DB shapes changed ⇒ Postman collection untouched (FT-DEPLOY-4 unaffected).
- Tap CI + release workflow run on the self-hosted Mac pool (SSH access to the private repos; hosted minutes exhausted).

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 4: Report.** Summarize for the user: PR URL, the three post-merge manual steps, and that the first installable release is the `v0.2.0` tag.
