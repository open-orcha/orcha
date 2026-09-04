"""Agent→PR (docs/agent-prs.md): runner-image gh CLI + always-fresh auth wrapper.

Static assertions on the shipped templates/runner files (gh installed from the
official apt repo; the /usr/local/bin/gh wrapper present, executable, POSIX-sh)
plus BEHAVIOR tests of the wrapper itself: a copy with the production gh path
rewritten to a capturing fake runs against a REAL workspace layout — proving
the token is resolved from $ORCHA_WORKSPACE_ROOT/.orcha/github-token (the env
the path-identical sandbox stamps), that an unset env falls back to walking UP
from $PWD (host mode / worktree cwd), that the token is re-read fresh on every
invocation, a missing token file yields an empty (not unset) GH_TOKEN, args
pass through untouched, and the token never rides in argv.

No Docker required.
"""
import os
import pathlib
import stat
import subprocess

RUNNER_DIR = (pathlib.Path(__file__).resolve().parent.parent
              / "orcha-cli" / "orcha_cli" / "templates" / "runner")
DOCKERFILE = RUNNER_DIR / "Dockerfile"
WRAPPER = RUNNER_DIR / "gh"

TOKEN_RELPATH = ".orcha/github-token"
ROOT_ENV = "ORCHA_WORKSPACE_ROOT"
REAL_GH = "/usr/bin/gh"


# --------------------------------------------------------------- static: Dockerfile

def test_dockerfile_installs_gh_from_official_apt_repo():
    text = DOCKERFILE.read_text()
    assert "cli.github.com/packages" in text                      # the official repo
    assert "githubcli-archive-keyring.gpg" in text                # signed, not blind-trusted
    assert "signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg" in text
    # gh is installed as a distinct word on an apt-get install line
    install_lines = [ln for ln in text.splitlines()
                     if "apt-get install" in ln and " gh " in f"{ln} "]
    assert install_lines, "no apt-get install line installing gh"
    # nothing pinned beyond the repo itself (no gh=<version>)
    assert "gh=" not in text


def test_dockerfile_ships_wrapper_over_real_gh():
    text = DOCKERFILE.read_text()
    assert "COPY gh /usr/local/bin/gh" in text
    assert "chmod 0755 /usr/local/bin/gh" in text
    # the wrapper must land BEFORE the USER drop (root can write /usr/local/bin)
    assert text.index("COPY gh /usr/local/bin/gh") < text.index("USER node")


def test_dockerfile_has_no_baked_workspace_workdir():
    # Path-identical mounting: /workspace no longer exists in-container. The
    # spawner always passes -w <real spawn cwd>; a baked WORKDIR pointing at
    # the dead remap would silently mask a missing -w.
    text = DOCKERFILE.read_text()
    assert "WORKDIR /workspace" not in text


# --------------------------------------------------------------- static: wrapper file

def test_wrapper_present_executable_posix_sh():
    assert WRAPPER.is_file()
    assert WRAPPER.stat().st_mode & stat.S_IXUSR, "wrapper template not executable"
    lines = WRAPPER.read_text().splitlines()
    assert lines[0] == "#!/bin/sh"                                # POSIX sh, no bash needed
    body = "\n".join(ln for ln in lines if not ln.lstrip().startswith("#"))
    for bashism in ("[[", "function ", "${GH_TOKEN:0", "local "):
        assert bashism not in body, f"bashism in wrapper: {bashism!r}"
    # the contract: env-rooted token path with a $PWD walk-up fallback
    assert ROOT_ENV in body
    assert TOKEN_RELPATH in body
    assert "$PWD" in body                                         # the fallback seed
    assert f'exec {REAL_GH} "$@"' in body
    # no stale absolute /workspace path survives the path-identical redesign
    assert "/workspace" not in body
    # the token is read into the env, never echoed
    assert "echo" not in body and "printf" not in body


# --------------------------------------------------------------- behavior harness

def _run_wrapper(tmp_path, args, token=None, root_env=True, cwd=None):
    """Run a gh-rewritten copy of the REAL wrapper against a capturing fake gh
    and a real workspace layout (<tmp>/ws/.orcha/github-token). Returns the
    captured lines (GH_TOKEN=..., then ARG:... per argv word)."""
    src = WRAPPER.read_text()
    assert REAL_GH in src                          # rewrite target really present
    ws = tmp_path / "ws"
    (ws / ".orcha").mkdir(parents=True, exist_ok=True)
    token_file = ws / ".orcha" / "github-token"
    fake_gh = tmp_path / "real-gh"
    capture = tmp_path / "capture.log"

    if token is None:
        token_file.unlink(missing_ok=True)
    else:
        token_file.write_text(token)

    fake_gh.write_text(
        "#!/bin/sh\n"
        '{\n'
        '  printf \'GH_TOKEN=%s\\n\' "${GH_TOKEN-__UNSET__}"\n'
        '  for a in "$@"; do printf \'ARG:%s\\n\' "$a"; done\n'
        '} >> "$CAPTURE"\n'
    )
    fake_gh.chmod(0o755)

    rewritten = tmp_path / "gh-wrapper"
    rewritten.write_text(src.replace(REAL_GH, str(fake_gh)))
    capture.write_text("")
    env = dict(os.environ, CAPTURE=str(capture))
    env.pop("GH_TOKEN", None)                     # prove the wrapper sets it, not us
    if root_env:
        env[ROOT_ENV] = str(ws)                   # the sandbox-stamped root
    else:
        env.pop(ROOT_ENV, None)                   # host mode: fall back to $PWD walk-up
    result = subprocess.run(["sh", str(rewritten), *args],
                            capture_output=True, text=True, env=env, timeout=30,
                            cwd=str(cwd) if cwd else None)
    assert result.returncode == 0, result.stderr
    # no token anywhere on the wrapper's own stdout/stderr
    return capture.read_text().splitlines(), result


def test_wrapper_reads_token_fresh_on_every_invocation(tmp_path):
    lines1, _ = _run_wrapper(tmp_path, ["auth", "status"], token="ghs_FIRST")
    assert "GH_TOKEN=ghs_FIRST" in lines1
    # rotate the file — the SAME wrapper must pick up the new token, no restart
    lines2, _ = _run_wrapper(tmp_path, ["auth", "status"], token="ghs_SECOND")
    assert "GH_TOKEN=ghs_SECOND" in lines2
    assert "GH_TOKEN=ghs_FIRST" not in lines2


def test_wrapper_walks_up_from_pwd_without_root_env(tmp_path):
    # Host mode / manual container: no ORCHA_WORKSPACE_ROOT. From a nested cwd
    # (e.g. a worktree under the root) the wrapper walks UP until it finds
    # .orcha/github-token — resolving the ROOT's token.
    nested = tmp_path / "ws" / ".orcha-worktrees" / "resident-C1" / "src"
    nested.mkdir(parents=True)
    lines, _ = _run_wrapper(tmp_path, ["auth", "status"], token="ghs_WALKED",
                            root_env=False, cwd=nested)
    assert "GH_TOKEN=ghs_WALKED" in lines


def test_wrapper_missing_token_file_yields_empty_gh_token(tmp_path):
    lines, _ = _run_wrapper(tmp_path, ["pr", "list"], token=None)
    assert "GH_TOKEN=" in lines                   # set-but-empty, not __UNSET__
    assert not any(ln.startswith("GH_TOKEN=__UNSET__") for ln in lines)


def test_wrapper_missing_token_no_env_no_match_yields_empty(tmp_path):
    # The walk-up can terminate at / without ever finding a token file — still
    # a clean empty GH_TOKEN, never a hang or an error exit.
    nested = tmp_path / "nowhere" / "deep"
    nested.mkdir(parents=True)
    lines, _ = _run_wrapper(tmp_path, ["pr", "list"], token=None,
                            root_env=False, cwd=nested)
    assert "GH_TOKEN=" in lines
    assert not any(ln.startswith("GH_TOKEN=__UNSET__") for ln in lines)


def test_wrapper_passes_args_through_untouched(tmp_path):
    args = ["pr", "create", "--title", "two words here", "--body", "line\nbreak"]
    lines, _ = _run_wrapper(tmp_path, args, token="ghs_T")
    text = "\n".join(lines[lines.index("GH_TOKEN=ghs_T") + 1:])
    for a in args:
        assert f"ARG:{a}" in text                 # each arg intact — spaces and all
    assert text.count("ARG:") == len(args)        # nothing added, nothing split


def test_wrapper_never_puts_token_in_argv_or_output(tmp_path):
    token = "ghs_SUPERSECRET"
    lines, result = _run_wrapper(tmp_path, ["pr", "view", "1"], token=token)
    argv_lines = [ln for ln in lines if ln.startswith("ARG:")]
    assert not any(token in ln for ln in argv_lines)
    assert token not in result.stdout and token not in result.stderr
