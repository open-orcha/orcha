"""Read the CI workflow that runs a team's suite and propose an environment from it (ported from
`test_import/ci.py`).

The workflow already says how the app is built and served, which seed commands prepare its data,
which variables it needs and which devices it runs on. This module reads that (GitHub Actions,
GitLab CI, CircleCI, Bitrise, Azure Pipelines, Codemagic, plus the Playwright, Cypress and Detox
configs) and proposes: the app's URL or the command that serves it, the seed commands, the
platforms and devices, and the names of the variables (never their values; a value that comes
from a secret store is only named). A person confirms the proposal before anything is saved.

Read-only and deterministic: line patterns over the files, no YAML evaluation, nothing run.
"""

from __future__ import annotations

import re
from pathlib import Path
from typing import Any
from orcha_cli.qa.onboarding import ignored

CI_FILES = (
    ".gitlab-ci.yml", ".circleci/config.yml", "bitrise.yml", "azure-pipelines.yml", "codemagic.yaml",
    "Jenkinsfile", ".buildkite/pipeline.yml",
)
CONFIG_GLOBS = ("playwright.config.*", "cypress.config.*", ".detoxrc*", "detox.config.*")
MAX_BYTES = 200_000

_TEST_CMD = re.compile(r"(?:npx|pnpm|yarn|bunx|npm run)?\s*(?:playwright test|cypress run|detox test|jest\b|vitest\b|maestro test|xcodebuild\b[^\n]*\btest\b|gradlew\s+connected\w*|fastlane\s+\w*test)[^\n]*")
_SERVE = re.compile(r"(?:pnpm|npm run|yarn|bun)\s+(?:dev|start|serve|preview)\b[^\n&]*|next start[^\n&]*|vite preview[^\n&]*|start-server-and-test[^\n]*|docker compose up[^\n]*|python -m http\.server[^\n]*")
_SEED = re.compile(r"[^\n]*(?:\bseed\b|db:seed|db:reset|prisma db seed|prisma migrate reset|fixtures?:load|loaddata|rails db:setup|knex seed)[^\n]*", re.I)
_URL_ENV = re.compile(r"^\s*-?\s*(?P<k>(?:PLAYWRIGHT_|CYPRESS_|E2E_|APP_|WEB_|TEST_)?BASE_?URL|APP_URL|SITE_URL|E2E_URL)\s*[:=]\s*['\"]?(?P<v>https?://[^\s'\"]+)", re.M | re.I)
_ENV_KEY = re.compile(r"^\s+(?P<k>[A-Z][A-Z0-9_]{2,})\s*:\s*(?P<v>.*)$", re.M)
_BASE_URL_CFG = re.compile(r"""base_?url\s*:\s*(?:process\.env\.\w+\s*(?:\?\?|\|\|)\s*)?['"`](?P<v>https?://[^'"`]+)""", re.I)
_WEBSERVER = re.compile(r"""webServer\s*:\s*\{[^}]*?command\s*:\s*['"`](?P<cmd>[^'"`]+)['"`][^}]*?(?:url\s*:\s*['"`](?P<url>[^'"`]+))?""", re.S)
_IOS_DEVICE = re.compile(r"name=([^,'\"\n]+)")
_API_LEVEL = re.compile(r"api-level\s*:\s*(\d+)")
_DETOX_DEVICE = re.compile(r"""(?:avdName|type)\s*:\s*['"]([^'"]+)['"]""")


def _read(path: Path) -> str | None:
    try:
        if path.stat().st_size > MAX_BYTES:
            return None
        return path.read_text(errors="replace")
    except OSError:
        return None


def ci_files(repo: Path) -> list[Path]:
    out: list[Path] = []
    wf = repo / ".github" / "workflows"
    if wf.is_dir():
        out += sorted(p for p in wf.iterdir() if p.suffix in (".yml", ".yaml"))
    out += [repo / f for f in CI_FILES if (repo / f).is_file()]
    return out


def config_files(repo: Path) -> list[Path]:
    """Test-runner configs at the root and two folders down (`apps/web/playwright.config.ts`)."""
    out: list[Path] = []

    unread = ignored.matcher(repo)

    def subdirs(p: Path) -> list[Path]:
        try:
            return [c for c in sorted(p.iterdir()) if c.is_dir() and not c.name.startswith(".") and c.name not in ("node_modules", "dist", "build") and not unread(c)][:40]
        except OSError:
            return []

    level1 = subdirs(repo)
    for base in [repo] + level1 + [g for d in level1 for g in subdirs(d)]:
        for g in CONFIG_GLOBS:
            out += sorted(base.glob(g))
    return out


def _clean_cmd(cmd: str) -> str:
    cmd = re.sub(r"^\s*-?\s*(?:run|script|command)\s*:\s*", "", cmd.strip())
    return cmd.strip().strip("'\"").rstrip("&").strip()


_COMMAND_START = re.compile(r"^(?:npx|pnpm|npm|yarn|bun|bunx|node|tsx|python3?|rails|bundle|php|make|docker|supabase|\./|bash|sh|go|cargo|gradle|\.\/gradlew|mix)\b")


def _commands(text: str) -> list[str]:
    """The shell commands a CI file runs: `run:`/`script:`/`command:` values and the lines of a
    `run: |` block. Comments and step names are not commands."""
    out: list[str] = []
    block_indent: int | None = None
    for raw in text.splitlines():
        stripped = raw.strip()
        indent = len(raw) - len(raw.lstrip())
        if block_indent is not None:
            if stripped and indent < block_indent:
                block_indent = None
            elif stripped and not stripped.startswith("#"):
                out.append(stripped)
                continue
            else:
                continue
        m = re.match(r"^\s*-?\s*(?:run|script|command|cmd)\s*:\s*(.*)$", raw)
        if m:
            value = m.group(1).strip()
            if value in ("|", ">", "|-", ">-", ""):
                block_indent = indent + 1
            else:
                out.append(value.strip("'\""))
            continue
        if re.match(r"^\s*-\s+(?!name:|uses:|with:)", raw) and _COMMAND_START.match(stripped.lstrip("- ").strip()):
            out.append(stripped.lstrip("- ").strip())
    return out


def _file_info(path: Path, rel: str, text: str) -> dict[str, Any]:
    info: dict[str, Any] = {"rel": rel, "tests": [], "serve": None, "seeds": [], "url": None, "env": [], "secrets": [], "platforms": [], "devices": []}
    commands = _commands(text) if path.suffix in (".yml", ".yaml") or path.name == "Jenkinsfile" else []
    for cmd in commands:
        if _TEST_CMD.search(cmd):
            info["tests"].append(_clean_cmd(_TEST_CMD.search(cmd).group(0))[:200])
        s = _SERVE.search(cmd)
        if s and not info["serve"]:
            info["serve"] = _clean_cmd(s.group(0))[:200]
        if _SEED.fullmatch(cmd) and _COMMAND_START.match(cmd) and len(cmd) < 200:
            info["seeds"].append(cmd)
    for m in _URL_ENV.finditer(text):
        info["url"] = info["url"] or (m.group("v") if "$" not in m.group("v") else None)
    for m in _BASE_URL_CFG.finditer(text):
        info["url"] = info["url"] or (m.group("v") if "$" not in m.group("v") else None)
    ws = _WEBSERVER.search(text)
    if ws:
        info["serve"] = info["serve"] or ws.group("cmd")
        info["url"] = info["url"] or ws.group("url")
    if commands:
        for m in _ENV_KEY.finditer(text):
            k, v = m.group("k"), m.group("v")
            if re.search(r"secrets\.|\$\{\{\s*secrets", v) or re.search(r"KEY|TOKEN|SECRET|PASSWORD|PASSPHRASE", k):
                info["secrets"].append(k)
            else:
                info["env"].append(k)
    low = text.lower()
    if "playwright" in low or "cypress" in low:
        info["platforms"].append("web")
    if "xcodebuild" in low or "ios simulator" in low or "simctl" in low:
        info["platforms"].append("ios")
    if "emulator" in low or "connectedandroidtest" in low:
        info["platforms"].append("android")
    info["devices"] += [d.strip() for d in _IOS_DEVICE.findall(text) if "$" not in d]
    info["devices"] += [f"Android API {n}" for n in _API_LEVEL.findall(text)]
    info["devices"] += [d for d in _DETOX_DEVICE.findall(text) if "$" not in d]
    return info


def propose(repo_dir: Path | str) -> dict[str, Any] | None:
    """The environment the CI suggests, or None when the repo has no CI file or config to read.
    `{sources, url, serve, seeds, env, secrets, platforms, devices, test_commands}`. Only the files
    that run the suite (a test command, or a test-runner config) are read for it, so a deploy or
    backup workflow does not leak its variables into the proposal."""
    repo = Path(repo_dir).expanduser()
    if not repo.is_dir():
        return None
    infos = []
    for path in ci_files(repo) + config_files(repo):
        text = _read(path)
        if text:
            infos.append(_file_info(path, path.relative_to(repo).as_posix(), text))
    suite = [i for i in infos if i["tests"] or i["url"] or (i["serve"] and not i["rel"].startswith((".github", ".gitlab", ".circleci")))]
    if not suite:
        return None
    out: dict[str, Any] = {"sources": [], "url": None, "serve": None, "seeds": [], "env": [], "secrets": [], "platforms": [], "devices": [], "test_commands": []}
    for i in suite:
        out["sources"].append(i["rel"])
        out["url"] = out["url"] or i["url"]
        out["serve"] = out["serve"] or i["serve"]
        for key, src in (("seeds", "seeds"), ("env", "env"), ("secrets", "secrets"), ("platforms", "platforms"), ("devices", "devices"), ("test_commands", "tests")):
            for v in i[src]:
                if v not in out[key]:
                    out[key].append(v)
    out["env"] = [k for k in out["env"] if k not in out["secrets"]]
    return out
