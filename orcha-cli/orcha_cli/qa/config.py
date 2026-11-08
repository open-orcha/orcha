"""Who the QA tools act as, and against which portal (docs/orcha-qa-plan.md "Identity").

- The portal and the container come from `.claude/orcha.json` (`api_base_url`,
  `current_container_id`), found by walking up from the working directory. A worker's worktree
  carries an overlay copy, so the walk finds it there first.
- The acting agent comes from `$ORCHA_ALIAS` → `.claude/orcha-tabs/<alias>.json`, else the single
  binding file when there is exactly one (the skills' rule). The tabs folder is looked for next to
  the `orcha.json` that was found, then upwards from the working directory.
- Overrides win over both: `ORCHA_QA_API`, `ORCHA_QA_CID`, `ORCHA_QA_AGENT_ID`.

`resolve()` never raises: what it could not find is listed in `Identity.problems`, and the tools
answer `error: ...` with it.
"""

from __future__ import annotations

import json
import os
import pathlib
from dataclasses import dataclass, field
from typing import Any, Mapping, Optional

ENV_API = "ORCHA_QA_API"
ENV_CID = "ORCHA_QA_CID"
ENV_AGENT = "ORCHA_QA_AGENT_ID"
ENV_ALIAS = "ORCHA_ALIAS"


@dataclass
class Identity:
    api_base: str = ""
    container_id: str = ""
    agent_id: str = ""
    alias: str = ""
    orcha_json: Optional[pathlib.Path] = None
    binding: Optional[pathlib.Path] = None
    sources: dict[str, str] = field(default_factory=dict)  # what each value came from
    problems: list[str] = field(default_factory=list)

    @property
    def ok(self) -> bool:
        """Enough to call the portal as an agent."""
        return bool(self.api_base and self.container_id and self.agent_id)

    def describe(self) -> str:
        parts = [
            f"portal: {self.api_base or '(none)'} [{self.sources.get('api', '-')}]",
            f"container: {self.container_id or '(none)'} [{self.sources.get('container', '-')}]",
            f"agent: {(self.alias + ' ') if self.alias else ''}{self.agent_id or '(none)'} [{self.sources.get('agent', '-')}]",
        ]
        return "\n".join(parts + [f"problem: {p}" for p in self.problems])


def _read_json(path: pathlib.Path) -> dict[str, Any]:
    try:
        data = json.loads(path.read_text())
    except (OSError, ValueError):
        return {}
    return data if isinstance(data, dict) else {}


def find_upwards(start: pathlib.Path, rel: str) -> Optional[pathlib.Path]:
    """The first `<dir>/<rel>` from `start` up to the filesystem root, or None."""
    try:
        here = start.resolve()
    except OSError:
        here = start
    for d in (here, *here.parents):
        candidate = d / rel
        if candidate.exists():
            return candidate
    return None


def normalise_api(base: str) -> str:
    """`http://host:port` with no trailing slash and no trailing `/api` (routes add it)."""
    base = (base or "").strip().rstrip("/")
    if base.endswith("/api"):
        base = base[: -len("/api")]
    return base


def _binding(tabs: Optional[pathlib.Path], alias: str) -> tuple[Optional[pathlib.Path], str]:
    """(binding file, problem) for `alias`, or the single binding when no alias is given."""
    if tabs is None or not tabs.is_dir():
        return None, "no .claude/orcha-tabs folder found (register the agent, or set ORCHA_QA_AGENT_ID)"
    if alias:
        f = tabs / f"{alias}.json"
        if f.is_file():
            return f, ""
        return None, f"$ORCHA_ALIAS={alias!r} but {f} does not exist"
    files = sorted(tabs.glob("*.json"))
    if len(files) == 1:
        return files[0], ""
    if not files:
        return None, f"no binding in {tabs} (register the agent, or set ORCHA_QA_AGENT_ID)"
    names = ", ".join(f.stem for f in files)
    return None, f"several bindings in {tabs} ({names}): set ORCHA_ALIAS to pick the acting agent"


def resolve(cwd: Optional[pathlib.Path | str] = None, env: Optional[Mapping[str, str]] = None) -> Identity:
    """The identity the QA tools act as (see the module doc). Never raises."""
    env = os.environ if env is None else env
    start = pathlib.Path(cwd) if cwd is not None else pathlib.Path.cwd()
    ident = Identity()
    cfg_path = find_upwards(start, ".claude/orcha.json")
    cfg = _read_json(cfg_path) if cfg_path else {}
    ident.orcha_json = cfg_path

    api = (env.get(ENV_API) or "").strip()
    if api:
        ident.api_base, ident.sources["api"] = normalise_api(api), ENV_API
    elif cfg.get("api_base_url"):
        ident.api_base, ident.sources["api"] = normalise_api(str(cfg["api_base_url"])), str(cfg_path)

    alias = (env.get(ENV_ALIAS) or "").strip()
    ident.alias = alias
    tabs = None
    if cfg_path is not None and (cfg_path.parent / "orcha-tabs").is_dir():
        tabs = cfg_path.parent / "orcha-tabs"
    else:
        tabs = find_upwards(start, ".claude/orcha-tabs")
    binding_file, binding_problem = _binding(tabs, alias)
    binding = _read_json(binding_file) if binding_file else {}
    ident.binding = binding_file

    agent = (env.get(ENV_AGENT) or "").strip()
    if agent:
        ident.agent_id, ident.sources["agent"] = agent, ENV_AGENT
    elif binding.get("agent_id"):
        ident.agent_id, ident.sources["agent"] = str(binding["agent_id"]), str(binding_file)
        ident.alias = ident.alias or str(binding.get("alias") or binding_file.stem if binding_file else "")
    elif binding_problem:
        ident.problems.append(binding_problem)

    cid = (env.get(ENV_CID) or "").strip()
    if cid:
        ident.container_id, ident.sources["container"] = cid, ENV_CID
    elif cfg.get("current_container_id"):
        ident.container_id, ident.sources["container"] = str(cfg["current_container_id"]), str(cfg_path)
    elif binding.get("container_id"):
        ident.container_id, ident.sources["container"] = str(binding["container_id"]), str(binding_file)

    if not ident.api_base:
        ident.problems.append("no portal: no .claude/orcha.json with api_base_url above the working directory (or set ORCHA_QA_API)")
    if not ident.container_id:
        ident.problems.append("no container: .claude/orcha.json has no current_container_id (or set ORCHA_QA_CID)")
    if not ident.agent_id and not any("binding" in p or "ORCHA_ALIAS" in p or "orcha-tabs" in p for p in ident.problems):
        ident.problems.append("no acting agent (set ORCHA_ALIAS or ORCHA_QA_AGENT_ID)")
    return ident
