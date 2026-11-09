"""Quality workflows as blocks (contract: docs/orcha-qa-plan.md, "Embedding a Quality workflow in any
workflow"). One catalogue: `GET C/workflow-blocks` serves these four, and the whole-workflow presets
are a block spliced after a Build step.

A block's `draft` is shaped like a preset's. It holds the block's own steps and may name two steps
that are not: `build` (the step before it, where work goes back to) and `next` (what follows it).
`splice` puts those to real steps. The result is an ordinary draft, checked by the same preview as
any other: a splice the engine would refuse is refused here, with the engine's sentence.
"""

from __future__ import annotations

from typing import Any, Optional

from portal_backend import qa_handoff
from portal_backend.workflow_graph import conflict

BUILD = "build"
NEXT = "next"
QA_OUTCOMES = [{"name": "pass", "kind": "success"}, {"name": "fail", "kind": "failure"}]
TRIAGE_OUTCOMES = [{"name": "fix", "kind": "changes"}, {"name": "clear", "kind": "success"}, {"name": "needs_person", "kind": "custom"}]
PLACEHOLDERS = {BUILD: "the step before", NEXT: "what follows"}
BUILD_STEP = {"client_key": BUILD, "title": "Build", "description": "", "definition_of_done": "The change is built and ready to test.",
              "assignee_id": None, "priority": 10, "depends_on": []}
_DONE_QA = "The change does what it should on the device."


def _step(key: str, title: str, dod: str, agent: Optional[str], depends: list[str], *, outcomes: Optional[list] = None,
          routes: Optional[list] = None, qa: Optional[dict] = None) -> dict:
    out = {"client_key": key, "title": title, "description": "", "definition_of_done": dod, "assignee_id": agent, "depends_on": depends}
    if outcomes:
        out["outcomes"] = [dict(o) for o in outcomes]
    if routes:
        out["routes"] = routes
    if qa:
        out["qa"] = qa
    return out


def _route(outcome: str, destination: str, task: Optional[str] = None) -> dict:
    return {"outcome": outcome, "destination": destination, **({"destination_task": task} if task else {})}


def _group(name: str, members: list[str], review: str, exit_outcome: str, rounds: int) -> dict:
    return {"name": name, "member_tasks": members, "review_task": review, "exit_outcome": exit_outcome, "max_rounds": rounds}


def _block(key: str, name: str, description: str, title: str, goal: str, tasks: list[dict], group: dict, tails: list[str], *,
           closing: Optional[dict] = None) -> dict:
    """`tails`: what the step after the block waits for. `closing`: the step it adds when nothing
    follows it and a pass needs somewhere to go."""
    return {"key": key, "name": name, "description": description, "placeholders": PLACEHOLDERS, "tails": tails, "closing": closing,
            "draft": {"title": title, "goal": goal, "execution_mode": "serial", "semantics_version": 2, "tasks": tasks, "repeat_groups": [group]}}


def _closing() -> dict:
    return _step(NEXT, "Sum up", "Say what was built and what QA proved.", None, [])


def check_and_fix(conf: dict, platform: Optional[str], kind: str) -> dict:
    agent = conf["agent_id"]
    return _block(
        "check_and_fix", "Check and fix", "Check the change, diagnose what fails, and send only confirmed bugs back to the build step, "
        "until it passes or the rounds run out. A pass skips triage.", "Check and fix", "A change that passes its checks, with only real bugs fixed.",
        [_step("qa", "Check", _DONE_QA, agent, [BUILD], outcomes=QA_OUTCOMES,
               routes=[_route("pass", "step", NEXT), _route("fail", "step", "triage")], qa={"kind": kind, "platform": platform}),
         _step("triage", "Triage", "Every finding has a diagnosis.", agent, ["qa"], outcomes=TRIAGE_OUTCOMES,
               routes=[_route("fix", "return", BUILD), _route("clear", "exit_group"), _route("needs_person", "ask_owner")],
               qa={"kind": "triage", "platform": platform})],
        _group("Check and fix", [BUILD, "qa", "triage"], "triage", "clear", conf["max_rounds"]), ["qa", "triage"], closing=_closing())


def explore_and_draft(conf: dict, platform: Optional[str]) -> dict:
    agent = conf["agent_id"]
    return _block(
        "explore_and_draft", "Explore and draft", "Explore the app, then draft scenarios from what was found. A person reviews every draft.",
        "Explore and draft", "Drafted scenarios from what an exploration found.",
        [_step("explore", "Explore", "The exploration ended and its result is in.", agent, [BUILD], outcomes=QA_OUTCOMES,
               routes=[_route("pass", "step", "draft"), _route("fail", "step", "draft")], qa={"kind": "explore", "platform": platform}),
         _step("draft", "Draft scenarios", "The drafted scenarios are in for a person to review.", agent, ["explore"], outcomes=QA_OUTCOMES,
               routes=[_route("pass", "exit_group"), _route("fail", "return", "explore")], qa={"kind": "draft", "platform": platform})],
        _group("Explore and draft", ["explore", "draft"], "draft", "pass", conf["max_rounds"]), ["draft"])


def map_the_app(conf: dict, platform: Optional[str]) -> dict:
    agent = conf["agent_id"]
    return _block(
        "map_the_app", "Map the app", "Map the app, then sum up what the map covers. Gaps send the map round again.",
        "Map the app", "A map of the app and what it covers.",
        [_step("map", "Map", "The map session ended and its result is in.", agent, [BUILD], outcomes=QA_OUTCOMES,
               routes=[_route("pass", "step", "coverage"), _route("fail", "ask_owner")], qa={"kind": "map", "platform": platform}),
         _step("coverage", "Coverage summary", "Say what the map covers and what it misses, area by area.", agent, ["map"],
               outcomes=[{"name": "complete", "kind": "success"}, {"name": "gaps", "kind": "changes"}],
               routes=[_route("complete", "exit_group"), _route("gaps", "return", "map")])],
        _group("Map the app", ["map", "coverage"], "coverage", "complete", conf["max_rounds"]), ["coverage"])


PLATFORM_WORD = {"ios": "iOS", "android": "Android", "web": "Web"}


def release_check(conf: dict, platforms: list[Optional[str]]) -> dict:
    agent = conf["agent_id"]
    keys = {p: f"check_{p}" if p else "check" for p in platforms}
    checks = [_step(key, f"Check {PLATFORM_WORD.get(p, p)}" if p else "Check", "Every validated scenario has a verdict.", agent, [BUILD], outcomes=QA_OUTCOMES,
                    routes=[_route("pass", "next"), _route("fail", "next")],
                    qa={"kind": "check", "platform": p, "focus": "Every validated scenario."}) for p, key in keys.items()]
    first = checks[0]["client_key"]
    triage = _step("triage", "Triage", "Every finding has a diagnosis.", agent, [c["client_key"] for c in checks],
                   outcomes=[*TRIAGE_OUTCOMES, {"name": "release", "kind": "custom"}, {"name": "retest", "kind": "custom"}],
                   routes=[_route("fix", "ask_owner"), _route("clear", "ask_owner"), _route("needs_person", "ask_owner"),
                           _route("release", "exit_group"), _route("retest", "return", first)], qa={"kind": "triage"})
    return _block(
        "release_check", "Release check", "Check every validated scenario on each platform, diagnose what fails, then ask the owner.",
        "Release check", "A release the owner has decided on, with every validated scenario checked.", [*checks, triage],
        _group("Release check", [*[c["client_key"] for c in checks], "triage"], "triage", "release", conf["max_rounds"]), ["triage"])


def _inputs(cur, cid: str) -> tuple[dict, Optional[str], str, list[Optional[str]]]:
    conf = qa_handoff.settings(cur, cid)
    platform = qa_handoff._platform(cur, cid, None, conf)
    cur.execute("SELECT platform FROM qa_targets WHERE container_id=%s AND app_id IS NOT NULL ORDER BY platform", (cid,))
    platforms: list[Optional[str]] = [r["platform"] for r in cur.fetchall()]
    return conf, platform, qa_handoff._kind_for(cur, cid, platform), platforms or [platform]


def catalogue(cur, cid: str) -> list[dict]:
    """The four blocks, for this project: its QA agent, its platforms, its rounds."""
    conf, platform, kind, platforms = _inputs(cur, cid)
    return [check_and_fix(conf, platform, kind), explore_and_draft(conf, platform), map_the_app(conf, platform), release_check(conf, platforms)]


def _ancestors(key: str, deps: dict[str, list[str]]) -> set[str]:
    seen: set[str] = set()
    frontier = [key]
    while frontier:
        for d in deps.get(frontier.pop(), []):
            if d not in seen:
                seen.add(d)
                frontier.append(d)
    return seen


def splice(draft: dict, block: dict, after: list[str], build_step: Optional[str] = None, *, prefix: Optional[str] = None,
           titles: Optional[dict[str, str]] = None) -> tuple[dict, list[str]]:
    """`(draft, added keys)`: `block` in `draft` after the steps `after`. What followed them now
    waits for the block. `build_step` is where work goes back to, by default the step before."""
    tasks = [dict(t) for t in draft.get("tasks") or []]
    known = {t["client_key"] for t in tasks} | set(draft.get("existing_task_ids") or [])
    for key in [*after, *([build_step] if build_step else [])]:
        if key not in known:
            conflict("unknown_step", f"“{key}” is not a step of this draft.", status=422)
    own = block["draft"]["tasks"]
    group = block["draft"]["repeat_groups"][0]
    build = build_step or (after[-1] if after else None)
    wants_build = BUILD in group["member_tasks"] or any(r.get("destination_task") == BUILD for t in own for r in t.get("routes", []))
    if wants_build and not build:
        conflict("block_needs_step", f"{block['name']} sends work back to a step, so add that step first or insert the block after it.", status=422)
    used = {t["client_key"] for t in tasks}
    if prefix is None:
        prefix = f"{block['key']}_"
        n = 2
        while any(prefix + t["client_key"] in used for t in own):
            prefix, n = f"{block['key']}_{n}_", n + 1
    follows = [t for t in tasks if set(t.get("depends_on") or []) & set(after)] if after else [t for t in tasks if not t.get("depends_on")]
    closing = block.get("closing") if not follows else None
    mapped = {t["client_key"]: prefix + t["client_key"] for t in own}
    if closing:
        mapped[NEXT] = prefix + NEXT if prefix + NEXT not in used and prefix else (NEXT if NEXT not in used else f"{block['key']}_{NEXT}")
    next_key = follows[0]["client_key"] if follows else mapped.get(NEXT)
    label = {"key": block["key"], "name": block["name"]}

    def name(key: Optional[str]) -> Optional[str]:
        return {BUILD: build, NEXT: next_key}.get(key, mapped.get(key, key)) if key else key

    before = [t for t in tasks if t["client_key"] in after]
    base = max([int(t.get("priority") or 0) for t in before], default=0)
    added: list[dict] = []
    for i, step in enumerate([*own, *([closing] if closing else [])]):
        t = {**step, "client_key": mapped[step["client_key"]], "priority": base + 10 * (i + 1), "block": label}
        t["depends_on"] = list(dict.fromkeys(k for d in step.get("depends_on") or [] for k in (after if d == BUILD else [name(d)])))
        if step.get("routes"):
            t["routes"] = [{**r, "destination_task": name(r.get("destination_task"))} if r.get("destination_task") else dict(r) for r in step["routes"]]
        if titles and step["client_key"] in titles:
            t["title"] = titles[step["client_key"]]
        added.append(t)
    if closing:
        added[-1]["depends_on"] = [mapped[k] for k in block["tails"]]
        if before and not added[-1].get("assignee_id"):
            added[-1]["assignee_id"] = before[-1].get("assignee_id")
    tails = [mapped[k] for k in block["tails"]]
    for t in follows:
        t["depends_on"] = list(dict.fromkeys([*[d for d in t.get("depends_on") or [] if d not in after], *tails]))
    entry = added[0]["client_key"]
    for t in before:  # a branch to what followed now branches to the block
        t["routes"] = [{**r, "destination_task": entry} if r.get("destination") == "step" and r.get("destination_task") in {f["client_key"] for f in follows} else r
                       for r in t.get("routes") or []]
    deps = {t["client_key"]: t.get("depends_on") or [] for t in tasks}
    between = [k for k in deps if build and build in _ancestors(k, deps) and (k in after or k in set().union(*[_ancestors(a, deps) for a in after] or [set()]))]
    members = [build, *between, *[mapped[k] for k in group["member_tasks"] if k != BUILD]] if BUILD in group["member_tasks"] else [mapped[k] for k in group["member_tasks"]]
    taken = {g["name"].strip().casefold() for g in draft.get("repeat_groups") or []}
    title, n = group["name"], 2
    while title.casefold() in taken:
        title, n = f"{group['name']} {n}", n + 1
    spliced = {**group, "name": title, "member_tasks": list(dict.fromkeys(members)), "review_task": mapped[group["review_task"]]}
    at = max([i + 1 for i, t in enumerate(tasks) if t["client_key"] in after], default=0)
    return ({**draft, "semantics_version": 2, "tasks": [*tasks[:at], *added, *tasks[at:]],
             "repeat_groups": [*(draft.get("repeat_groups") or []), spliced]}, [t["client_key"] for t in added])


def _preset(key: str, name: str, description: str, title: str, goal: str, block: dict, group_name: str) -> dict:
    """A whole workflow: a Build step and a block. Fill `tasks[0].assignee_id`, the title and goal."""
    base = {"title": title, "goal": goal, "execution_mode": "serial", "semantics_version": 2, "tasks": [dict(BUILD_STEP)], "repeat_groups": []}
    draft, _ = splice(base, block, [BUILD], prefix="", titles={"qa": "QA"})
    draft["repeat_groups"][-1]["name"] = group_name
    return {"key": key, "name": name, "description": description, "draft": draft}


def presets(cur, cid: str) -> list[dict]:
    """Drafts the UI can POST through the normal preview and create routes. "Build, QA, fix": a
    failed QA sends the work back to the build step with its findings and a pass ends the loop.
    "Build, QA, triage, fix" is Build plus Check and fix: `fix` goes back with only the confirmed
    findings, `clear` goes on, `needs_person` asks the owner. `max_rounds` covers the whole loop."""
    conf, platform, kind, _ = _inputs(cur, cid)
    plain = _block("check_and_fix", "Check and fix", "", "", "",
                   [_step("qa", "Check", _DONE_QA, conf["agent_id"], [BUILD], outcomes=QA_OUTCOMES,
                          routes=[_route("pass", "exit_group"), _route("fail", "return", BUILD)], qa={"kind": kind, "platform": platform})],
                   _group("Check and fix", [BUILD, "qa"], "qa", "pass", conf["max_rounds"]), ["qa"])
    return [_preset("build_qa_fix", "Build, QA, fix", "Build the change, have QA test it, and fix what QA finds, until it passes or the rounds run "
                    "out. A person accepts each step.", "Build, QA, fix", "A change that passes QA.", plain, "Build and QA"),
            _preset("build_qa_triage_fix", "Build, QA, triage, fix", "Build the change, have QA test it, and diagnose what fails before anyone "
                    "fixes it. Only confirmed bugs go back to be fixed. A person accepts each step.", "Build, QA, triage, fix",
                    "A change that passes QA, with only real bugs fixed.", check_and_fix(conf, platform, kind), "Build, QA and triage")]
