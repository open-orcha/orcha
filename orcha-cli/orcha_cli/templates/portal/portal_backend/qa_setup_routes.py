"""Orcha QA setup from the portal: what a project needs before QA can run, so a native portal needs
no terminal step. The tools are `orcha qa enable` (`orcha_cli.qa.launch` writes
`.orcha/qa/mcp.json`) in the folder `ORCHA_LOCAL_REPO_DIR` names. A portal without the package or
the folder (a container) says so in a sentence.

  GET  /api/containers/{cid}/qa/tools        {tools_on, can_enable, reason}
  POST /api/containers/{cid}/qa/tools        turn the tools on (a person)
  GET  /api/containers/{cid}/qa/setup        the same plus ai_agents
  POST /api/containers/{cid}/qa/setup/tools  turn the tools on (a person), answering like setup
  POST /api/containers/{cid}/qa/setup/tools/off  take them away again (a person), answering like setup
  POST /api/containers/{cid}/qa/agent        add the QA agent, give it the waiting QA tasks (a person)
  GET  /api/containers/{cid}/qa/setup/readiness  one row per platform: ready, or what is missing
  POST /api/containers/{cid}/qa/setup/browser    download the web test browser now (a person)
"""

from __future__ import annotations

import importlib
import threading
import time
from typing import Any, Optional

from fastapi import HTTPException, Request
from pydantic import BaseModel

from portal_backend import agent_registration_routes, qa_handoff, qa_onboarding, qa_store as qs
from portal_backend.application import app
from portal_backend.database import db_cursor
from portal_backend.schemas import AgentCreate

NO_PACKAGE = ("This portal runs without the Orcha QA package, so it can't turn the QA tools on. "
              "Run `orcha qa enable` in the project folder instead.")
NO_FOLDER = "This portal has no project folder. Run `orcha qa enable` in the project instead."
NO_LIBRARIES = "This copy of Embodent is missing its QA tools ({missing}). Update or reinstall Embodent."
#: Readiness reads simctl and adb: an open Quality tab polls, and a poll in between serves the last answer.
READINESS_TTL_S = 5.0
QA_ALIAS, QA_ROLE = "QA", "QA"
#: The same words as the UI's Add a QA agent.
QA_PROMPT = ("You are the project's QA agent. You test the app on a device or in a browser with the Orcha QA tools, and "
             "report what you find with screenshots. You judge the work; you do not fix it. A person verifies every task.")


class QaToolsBody(BaseModel):
    actor_agent_id: Optional[str] = None


class QaAgentBody(BaseModel):
    actor_agent_id: Optional[str] = None


class QaBrowserState(BaseModel):
    """The web test browser (`orcha_cli.qa.browser_setup.status`). `state`: missing, downloading,
    ready or failed; `percent` while downloading; `error` one plain sentence after a failure."""
    installed: bool
    state: str
    percent: Optional[int] = None
    size: Optional[str] = None
    error: Optional[str] = None
    message: Optional[str] = None


class QaPlatformReadiness(BaseModel):
    """Can a session run on this platform now. `words`: what is ready, or what is missing and how
    to get it; `link`: a page that helps; `browser`: the web test browser (web only)."""
    platform: str
    ready: bool
    words: str
    link: Optional[str] = None
    browser: Optional[QaBrowserState] = None


class QaReadiness(BaseModel):
    """`available` false: this portal cannot check (no QA package); `reason` says why."""
    available: bool
    reason: Optional[str] = None
    platforms: list[QaPlatformReadiness] = []


def _launch() -> Optional[Any]:
    """`orcha_cli.qa.launch` when this portal runs in the CLI's interpreter, else None."""
    try:
        return importlib.import_module("orcha_cli.qa.launch")
    except ImportError:
        return None


def _qa_module(name: str) -> Optional[Any]:
    try:
        return importlib.import_module(f"orcha_cli.qa.{name}")
    except ImportError:
        return None


def missing_libraries() -> list[str]:
    """Inside the Mac app: the QA packages its runtime lacks (an old or broken install). Elsewhere
    []: a source install's doctor names them, and the tools can still be turned on."""
    tools, readiness = _qa_module("device.tools"), _qa_module("readiness")
    if tools is None or readiness is None or not tools.in_app():
        return []
    return readiness.missing_libraries()


def tools_state() -> dict[str, Any]:
    launch, root = _launch(), qa_onboarding.repo_dir()
    if launch is None:
        return {"tools_on": False, "can_enable": False, "reason": NO_PACKAGE}
    if root is None:
        return {"tools_on": False, "can_enable": False, "reason": NO_FOLDER}
    on = launch.config_path(root) is not None
    if missing := missing_libraries():
        return {"tools_on": on, "can_enable": False, "reason": NO_LIBRARIES.format(missing=", ".join(missing))}
    return {"tools_on": on, "can_enable": True, "reason": None}


_readiness: dict[str, Any] = {"at": -READINESS_TTL_S, "rows": []}
_readiness_guard = threading.Lock()


def readiness_state() -> dict[str, Any]:
    """The rows for the Quality tab; the device checks at most every `READINESS_TTL_S`, the web
    browser's download progress fresh each time."""
    readiness = _qa_module("readiness")
    if readiness is None:
        return {"available": False, "reason": NO_PACKAGE, "platforms": []}
    with _readiness_guard:
        if time.monotonic() - _readiness["at"] >= READINESS_TTL_S:
            _readiness["rows"] = readiness.platforms()
            _readiness["at"] = time.monotonic()
        rows = list(_readiness["rows"])
    fresh = readiness.web()
    return {"available": True, "reason": None, "platforms": [fresh if r["platform"] == "web" else r for r in rows]}


def _setup(cur, cid: str) -> dict[str, Any]:
    cur.execute("SELECT count(*) AS n FROM agents WHERE container_id=%s AND kind='ai' AND terminated_at IS NULL", (cid,))
    return {**tools_state(), "ai_agents": int(cur.fetchone()["n"] or 0)}


def _turn_on(cid: str, body: QaToolsBody, request: Request) -> None:
    with db_cursor(readonly=True) as (_, cur):
        qs.container_read(cur, request, cid)
        qs.human(cur, request, cid, body.actor_agent_id, "turn the QA tools on")
    state, launch, root = tools_state(), _launch(), qa_onboarding.repo_dir()
    if launch is None or root is None:
        raise HTTPException(409, state["reason"])
    try:
        launch.enable(root)
    except OSError as e:
        raise HTTPException(409, f"Couldn't write the QA settings to the project folder: {e}. Run `orcha qa enable` there instead.") from e


@app.get("/api/containers/{cid}/qa/tools")
def get_qa_tools(cid: str, request: Request):
    """Are the QA tools on for this project, and can this portal turn them on; `reason` says why not."""
    with db_cursor(readonly=True) as (_, cur):
        qs.container_read(cur, request, cid)
    return tools_state()


@app.post("/api/containers/{cid}/qa/tools")
def post_qa_tools(cid: str, body: QaToolsBody, request: Request):
    _turn_on(cid, body, request)
    return tools_state()


@app.get("/api/containers/{cid}/qa/setup")
def get_qa_setup(cid: str, request: Request):
    with db_cursor(readonly=True) as (_, cur):
        qs.container_read(cur, request, cid)
        return _setup(cur, cid)


@app.post("/api/containers/{cid}/qa/setup/tools")
def enable_qa_tools(cid: str, body: QaToolsBody, request: Request):
    _turn_on(cid, body, request)
    with db_cursor(readonly=True) as (_, cur):
        return _setup(cur, cid)


@app.post("/api/containers/{cid}/qa/setup/tools/off")
def disable_qa_tools(cid: str, body: QaToolsBody, request: Request):
    """Agents lose the QA tools from their next run; a run already going keeps them until it ends."""
    with db_cursor(readonly=True) as (_, cur):
        qs.container_read(cur, request, cid)
        qs.human(cur, request, cid, body.actor_agent_id, "turn the QA tools off")
    state, launch, root = tools_state(), _launch(), qa_onboarding.repo_dir()
    if launch is None or root is None:
        raise HTTPException(409, state["reason"])
    try:
        launch.disable(root)
    except OSError as e:
        raise HTTPException(409, f"Couldn't change the QA settings in the project folder: {e}. Run `orcha qa disable` there instead.") from e
    with db_cursor(readonly=True) as (_, cur):
        return _setup(cur, cid)


@app.get("/api/containers/{cid}/qa/setup/readiness", response_model=QaReadiness)
def get_qa_readiness(cid: str, request: Request):
    """One row per platform (ios, android, web): can a Quality session run on it from this
    install, and if not, what a person does. The same checks as `orcha qa doctor`."""
    with db_cursor(readonly=True) as (_, cur):
        qs.container_read(cur, request, cid)
    return readiness_state()


@app.post("/api/containers/{cid}/qa/setup/browser", response_model=QaBrowserState)
def download_qa_browser(cid: str, body: QaToolsBody, request: Request):
    """Start downloading the web test browser now (a person); a download already going is joined.
    Answers its state; read progress from the readiness route."""
    with db_cursor(readonly=True) as (_, cur):
        qs.container_read(cur, request, cid)
        qs.human(cur, request, cid, body.actor_agent_id, "download the test browser")
    browser_setup = _qa_module("browser_setup")
    if browser_setup is None:
        raise HTTPException(409, NO_PACKAGE)
    return browser_setup.start()


@app.post("/api/containers/{cid}/qa/agent")
def add_qa_agent(cid: str, body: QaAgentBody, request: Request):
    """The project's QA agent, then every waiting QA task assigned to it, so a phase that sat `ready`
    goes on with the task it has. An agent that is already QA's is used as it is. Answers
    `{agent_id, alias, created, assigned_task_ids, tools_on}`."""
    with db_cursor(readonly=True) as (_, cur):
        qs.container_read(cur, request, cid)
        who = qs.human(cur, request, cid, body.actor_agent_id, "add a QA agent")
        conf = qa_handoff.settings(cur, cid)
        taken = _aliases(cur, cid)
    agent_id, alias, created = conf["agent_id"], conf["agent_alias"], False
    if not agent_id:
        alias = next(a for a in (QA_ALIAS, *(f"{QA_ALIAS}{n}" for n in range(2, 100))) if a.lower() not in taken)
        made = agent_registration_routes.register_agent(cid, AgentCreate(alias=alias, role=QA_ROLE, prompt=QA_PROMPT), request)
        agent_id, created = made.agent_id, True
    assigned = qa_onboarding.give_waiting_tasks(cid, who, str(agent_id))
    return {"agent_id": str(agent_id), "alias": alias, "created": created, "assigned_task_ids": assigned,
            "tools_on": tools_state()["tools_on"]}


def _aliases(cur, cid: str) -> set[str]:
    """Every alias in the project, retired ones too: an alias is never reused."""
    cur.execute("SELECT alias FROM agents WHERE container_id=%s", (cid,))
    return {str(r["alias"]).lower() for r in cur.fetchall()}
