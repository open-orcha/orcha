"""GH #258 PR 1 (plan Part 4 §S8) — API response-shape parity recorder.

Drives ONE fixed, deterministic scenario through the real FastAPI app, then GETs a fixed list
of read endpoints and reduces every response to three dialect-sensitive facts:

  * a TYPE TREE — every key → "str" / "int" / "float" / "bool" / "null" / "iso-datetime" /
    "iso-date"; lists become ``[<merged element shape>]`` (``[]`` when empty); a field whose
    type differs across list elements becomes a union (``"null|str"``, or
    ``{"anyOf": [...]}`` when a dict/list is involved); a key missing from some list elements
    carries ``"absent"`` in its union; dict keys that are UUIDs collapse to ``"<uuid>"``.
  * the VALUE of every boolean, keyed by JSON path (list indexes become ``[*]`` and the values
    at that path are recorded as a sorted list, so row order never matters).
  * the FORMAT of every datetime string, keyed the same way — the UTC offset suffix
    (``"+00:00"`` / ``"Z"`` / ``"naive"`` / other) and the date/time separator.

Nothing volatile is recorded: no ids, no timestamp values, no free-text values.

The recording made on Postgres is committed as ``tests/fixtures/parity_postgres.json``. The
normal run compares the live run against it (type tree equal, booleans equal, every datetime
ISO-8601 with ``+00:00``) and fails with a readable per-endpoint / per-path diff. This is the
guard the SQLite port (Workstream S) must keep green: it catches ``EXISTS(...)``/bool columns
coming back as ``0/1`` (iOS decodes ``Bool`` strictly), JSON aggregates coming back as strings,
``Decimal`` → ``float`` drift, and any datetime that lost its ``+00:00``.

Regenerate the fixture (only when a response shape changes ON PURPOSE; the fixture is a
contract, so review the diff):

    pytest tests/test_dialect_parity.py --regen-parity

Scenario substitutions vs the plan text are documented in ``_run_scenario``.
"""
import io
import json
import pathlib
import re

import pytest

import main

FIXTURE = pathlib.Path(__file__).resolve().parent / "fixtures" / "parity_postgres.json"

_UUID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", re.I)
# Loose detector: anything shaped like an ISO date-time (with or without an offset) is a datetime,
# so a value that LOST its offset is still typed "iso-datetime" and then fails the format check.
_DATETIME_RE = re.compile(
    r"^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}(:?\d{2})?)?$"
)
_DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
# The contract: ISO-8601, 'T' separator, seconds, optional fraction, explicit +00:00.
_STRICT_UTC_RE = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?\+00:00$")


# --------------------------------------------------------------------------------------------- #
# recorder
# --------------------------------------------------------------------------------------------- #

def _scalar_type(v):
    if v is None:
        return "null"
    if isinstance(v, bool):  # before int: bool is an int subclass
        return "bool"
    if isinstance(v, int):
        return "int"
    if isinstance(v, float):
        return "float"
    if isinstance(v, str):
        if _DATETIME_RE.match(v):
            return "iso-datetime"
        if _DATE_RE.match(v):
            return "iso-date"
        return "str"
    raise TypeError(f"unexpected JSON value type {type(v).__name__}")


def _norm_key(k):
    return "<uuid>" if _UUID_RE.match(k) else k


def _alts(t):
    """A type node as a list of alternatives (scalar names, dict shapes, list shapes)."""
    if isinstance(t, str):
        return t.split("|")
    if isinstance(t, dict) and set(t) == {"anyOf"}:
        return list(t["anyOf"])
    return [t]


def _from_alts(alts):
    scalars = sorted({a for a in alts if isinstance(a, str)})
    dicts = [a for a in alts if isinstance(a, dict)]
    lists = [a for a in alts if isinstance(a, list)]
    structured = []
    if dicts:
        merged = dicts[0]
        for d in dicts[1:]:
            merged = _merge_dicts(merged, d)
        structured.append(merged)
    if lists:
        merged = lists[0]
        for lst in lists[1:]:
            merged = _merge_lists(merged, lst)
        structured.append(merged)
    if not structured:
        return "|".join(scalars)
    if not scalars and len(structured) == 1:
        return structured[0]
    return {"anyOf": scalars + structured}


def _merge_dicts(a, b):
    out = {}
    for k in sorted(set(a) | set(b)):
        if k in a and k in b:
            out[k] = _merge(a[k], b[k])
        else:
            out[k] = _merge(a.get(k, "absent"), b.get(k, "absent"))
    return out


def _merge_lists(a, b):
    if not a:
        return b
    if not b:
        return a
    return [_merge(a[0], b[0])]


def _merge(a, b):
    if a == b:
        return a
    if isinstance(a, dict) and isinstance(b, dict) and "anyOf" not in a and "anyOf" not in b:
        return _merge_dicts(a, b)
    if isinstance(a, list) and isinstance(b, list):
        return _merge_lists(a, b)
    return _from_alts(_alts(a) + _alts(b))


def type_tree(v):
    if isinstance(v, dict):
        out = {}
        for k in sorted(v):
            nk = _norm_key(k)
            t = type_tree(v[k])
            out[nk] = _merge(out[nk], t) if nk in out else t
        return out
    if isinstance(v, list):
        if not v:
            return []
        merged = type_tree(v[0])
        for item in v[1:]:
            merged = _merge(merged, type_tree(item))
        return [merged]
    return _scalar_type(v)


def _dt_format(s):
    sep = "T" if "T" in s else "space"
    if s.endswith("+00:00"):
        off = "+00:00"
    elif s.endswith("Z"):
        off = "Z"
    else:
        m = re.search(r"[+-]\d{2}(:?\d{2})?$", s[10:])
        off = m.group(0) if m else "naive"
    return f"{sep}{off}"


def collect_leaves(v, path="$", bools=None, datetimes=None):
    """Booleans + datetime formats by stable JSON path ('[*]' for list positions)."""
    if bools is None:
        bools, datetimes = {}, {}
    if isinstance(v, dict):
        for k in sorted(v):
            collect_leaves(v[k], f"{path}.{_norm_key(k)}", bools, datetimes)
    elif isinstance(v, list):
        for item in v:
            collect_leaves(item, f"{path}[*]", bools, datetimes)
    elif isinstance(v, bool):
        bools.setdefault(path, []).append(v)
    elif isinstance(v, str) and _DATETIME_RE.match(v):
        datetimes.setdefault(path, set()).add(_dt_format(v))
    return bools, datetimes


def record(body):
    bools, datetimes = collect_leaves(body)
    return {
        "types": type_tree(body),
        # a path with no list/uuid wildcard holds exactly one value → record it bare
        "booleans": {
            p: (vals[0] if len(vals) == 1 and "[*]" not in p and "<uuid>" not in p
                else sorted(vals))
            for p, vals in sorted(bools.items())
        },
        "datetime_formats": {p: sorted(f) for p, f in sorted(datetimes.items())},
    }


def bad_datetimes(body):
    """Every datetime string that is NOT ISO-8601 'T…+00:00' → [(path, value), …]."""
    out = []

    def walk(v, path):
        if isinstance(v, dict):
            for k in sorted(v):
                walk(v[k], f"{path}.{k}")
        elif isinstance(v, list):
            for i, item in enumerate(v):
                walk(item, f"{path}[{i}]")
        elif isinstance(v, str) and _DATETIME_RE.match(v) and not _STRICT_UTC_RE.match(v):
            out.append((path, v))

    walk(body, "$")
    return out


# --------------------------------------------------------------------------------------------- #
# diff
# --------------------------------------------------------------------------------------------- #

def _node_name(t):
    if isinstance(t, list):
        return "list" if t else "list(empty)"
    if isinstance(t, dict):
        return "dict"
    return t


def _flatten_types(t, path="$", out=None):
    """Type tree → {path: "str" | "dict" | "list" | "null|dict" …} so a diff names one path."""
    if out is None:
        out = {}
    alts = t["anyOf"] if isinstance(t, dict) and set(t) == {"anyOf"} else [t]
    out[path] = "|".join(_node_name(a) for a in alts)
    for a in alts:
        if isinstance(a, dict):
            for k, sub in a.items():
                _flatten_types(sub, f"{path}.{k}", out)
        elif isinstance(a, list) and a:
            _flatten_types(a[0], f"{path}[*]", out)
    return out


def _diff_maps(section, exp, got):
    lines = []
    for p in sorted(set(exp) | set(got)):
        e, g = exp.get(p, "<missing>"), got.get(p, "<missing>")
        if e != g:
            lines.append(f"    {section} {p}: expected {e!r}, got {g!r}")
    return lines


def diff_recordings(expected, got):
    lines = []
    for ep in sorted(set(expected) | set(got)):
        if ep not in got:
            lines.append(f"  {ep}: endpoint missing from the live run")
            continue
        if ep not in expected:
            lines.append(f"  {ep}: endpoint not in the fixture (regenerate with --regen-parity)")
            continue
        e, g = expected[ep], got[ep]
        sub = []
        sub += _diff_maps("type", _flatten_types(e["types"]), _flatten_types(g["types"]))
        sub += _diff_maps("bool", e["booleans"], g["booleans"])
        sub += _diff_maps("datetime", e["datetime_formats"], g["datetime_formats"])
        if sub:
            lines.append(f"  {ep}:")
            lines += sub
    return lines


# --------------------------------------------------------------------------------------------- #
# the fixed scenario
# --------------------------------------------------------------------------------------------- #

async def _ok(resp, *codes):
    assert resp.status_code in (codes or (200, 201)), f"{resp.request.url}: {resp.status_code} {resp.text}"
    return resp.json()


async def _run_scenario(client, container, make_agent, make_task, make_request, work_headers):
    """The fixed scenario (plan §S8). Everything is created in the same order every run.

    Substitutions vs the plan text:
      * "2 agents" = two AI agents (dev, reviewer) PLUS one human (op). The human is required:
        /assign and a human conversation turn are human-gated, so the plan's two agents alone
        cannot drive them.
      * "a wake-scan" is a GET (the scan only stamps containers.last_wake_scan_at); it is issued
        once as a step and then recorded like every other read.
      * "a claim" = POST /api/agents/{aid}/next after a human /assign (a task created with an
        assignee is already in_progress, so it can't be claimed).
    Extras (cheap, widen coverage): a follow-up (chained) request, run stream lines, a memory
    digest, a conversation agent turn linked to a conversation-lane worker run.
    """
    cid = container["id"]
    human = await make_agent("op", "operator", kind="human")
    dev = await make_agent("dev", "engineer")
    rev = await make_agent("reviewer", "reviewer")
    op_id, dev_id, rev_id = human["agent_id"], dev["agent_id"], rev["agent_id"]

    # three tasks with dependencies: t1 ← t2 ← t3 (t3 pre-assigned to the reviewer)
    t1 = await make_task("parity: build", "the build passes", priority=10,
                         description="build it", created_by=op_id)
    t2 = await make_task("parity: test", "tests pass", depends_on=[t1["task_id"]], priority=20)
    t3 = await make_task("parity: review", "review done", assignee_alias="reviewer",
                         depends_on=[t1["task_id"], t2["task_id"]], priority=30)
    t1_id = t1["task_id"]

    # request chain with an answer: dev → reviewer (parent), reviewer → dev (child), both answered
    parent = await make_request(dev_id, "Which lint config?", target_alias="reviewer")
    child = await make_request(rev_id, "Is the new rule on?", target_alias="dev",
                               parent_request_id=parent["request_id"])
    await _ok(await client.post(f"/api/requests/{child['request_id']}/respond",
                                json={"responder_agent_id": dev_id, "response": "yes"}))
    await _ok(await client.post(f"/api/requests/{parent['request_id']}/respond",
                                json={"responder_agent_id": rev_id, "response": "strict"}))

    # conversation: human ↔ dev, a human turn + an agent turn linked to a conversation-lane run
    conv = await _ok(await client.post(f"/api/agents/{dev_id}/conversations",
                                       json={"actor_agent_id": op_id}))
    conv_id = conv["conversation"]["id"]
    await _ok(await client.post(f"/api/conversations/{conv_id}/turns",
                                json={"role": "human", "author_agent_id": op_id,
                                      "content": "status?"}))
    conv_run = await _ok(await client.post(
        f"/api/agents/{dev_id}/runs",
        json={"wake_kind": "resident", "conversation_id": conv_id, "lane": "conversation"}))
    await _ok(await client.post(f"/api/conversations/{conv_id}/turns",
                                json={"role": "agent", "author_agent_id": dev_id,
                                      "content": "on it", "run_id": conv_run["run_id"]}))

    # claim: human assigns t1 to dev (stays ready), dev claims it via /next
    await _ok(await client.post(f"/api/tasks/{t1_id}/assign",
                                json={"actor_agent_id": op_id, "agent_id": dev_id}))
    hdrs = await work_headers(dev_id)
    claimed = await _ok(await client.post(f"/api/agents/{dev_id}/next", headers=hdrs))
    assert claimed["task"]["id"] == t1_id

    # worker run with tokens, attributed to t1, with a couple of streamed lines
    run = await _ok(await client.post(f"/api/agents/{dev_id}/runs",
                                      json={"wake_kind": "ephemeral", "task_id": t1_id}))
    run_id = run["run_id"]
    await _ok(await client.post(f"/api/runs/{run_id}/lines", json={
        "start_seq": 1,
        "lines": [json.dumps({"type": "system", "subtype": "init"}),
                  json.dumps({"type": "assistant", "message": {"content": []}})]}))

    # task message with an attachment (upload first, then reference it)
    up = await _ok(await client.post(
        f"/api/tasks/{t1_id}/attachments",
        files={"file": ("notes.txt", io.BytesIO(b"parity notes"), "text/plain")}))
    await _ok(await client.post(f"/api/tasks/{t1_id}/messages",
                                json={"author_agent_id": dev_id, "body": "log attached",
                                      "attachments": [{"id": up["id"], "name": up["name"]}]}))
    await _ok(await client.post(f"/api/tasks/{t1_id}/messages",
                                json={"author_agent_id": op_id, "body": "thanks"}))

    await _ok(await client.post(f"/api/runs/{run_id}/finish", json={
        "status": "exited", "exit_code": 0, "input_tokens": 100, "output_tokens": 200,
        "cache_read_input_tokens": 5000, "cache_creation_input_tokens": 50,
        "total_cost_usd": 0.0042}))

    # memory digest for dev (so /digest and /rehydrate have a row)
    await _ok(await client.post(f"/api/agents/{dev_id}/digest", json={
        "current_focus": "parity build",
        "decisions": [{"text": "use strict lint"}],
        "learnings": ["tests are fast"],
        "open_threads": []}))

    # wake-scan (fixed thresholds → no wall-clock dependence)
    await _ok(await client.get(f"/api/containers/{cid}/wake-scan",
                               params={"cooldown": 3600, "min_idle": 3600}))

    # done → needs_verification
    done = await _ok(await client.post(f"/api/tasks/{t1_id}/done",
                                       json={"agent_id": dev_id, "result": "built"},
                                       headers=hdrs))
    assert done["status"] == "needs_verification", done

    return {
        "cid": cid, "op": op_id, "dev": dev_id, "rev": rev_id,
        "t1": t1_id, "t2": t2["task_id"], "t3": t3["task_id"],
        "rid": parent["request_id"], "conv": conv_id, "run": run_id,
    }


def _endpoints(ids):
    """(label, path, params) — label is the stable fixture key (ids replaced by placeholders)."""
    c, op, dev, rev = ids["cid"], ids["op"], ids["dev"], ids["rev"]
    t1, t3, rid, conv = ids["t1"], ids["t3"], ids["rid"], ids["conv"]
    return [
        ("GET /api/containers", "/api/containers", None),
        ("GET /api/containers/{cid}", f"/api/containers/{c}", None),
        ("GET /api/snapshot/{cid}", f"/api/snapshot/{c}", None),
        ("GET /api/containers/{cid}/tasks", f"/api/containers/{c}/tasks", None),
        ("GET /api/containers/{cid}/requests", f"/api/containers/{c}/requests", None),
        ("GET /api/containers/{cid}/members", f"/api/containers/{c}/members", None),
        ("GET /api/containers/{cid}/wake-scan",
         f"/api/containers/{c}/wake-scan", {"cooldown": 3600, "min_idle": 3600}),
        ("GET /api/containers/{cid}/metrics", f"/api/containers/{c}/metrics", None),
        ("GET /api/containers/{cid}/metrics/insights",
         f"/api/containers/{c}/metrics/insights", None),
        ("GET /api/containers/{cid}/metrics/agents/{dev}/spend",
         f"/api/containers/{c}/metrics/agents/{dev}/spend", None),
        ("GET /api/containers/{cid}/token-usage", f"/api/containers/{c}/token-usage", None),
        ("GET /api/containers/{cid}/active-conversations",
         f"/api/containers/{c}/active-conversations", None),
        ("GET /api/containers/{cid}/running-runs", f"/api/containers/{c}/running-runs", None),
        ("GET /api/containers/{cid}/wake-backoff", f"/api/containers/{c}/wake-backoff", None),
        ("GET /api/agents/{rev}/inbox", f"/api/agents/{rev}/inbox", None),
        ("GET /api/agents/{dev}/outbox", f"/api/agents/{dev}/outbox", None),
        ("GET /api/agents/{dev}/outbox?include_closed=true",
         f"/api/agents/{dev}/outbox", {"include_closed": "true"}),
        ("GET /api/agents/{dev}/notifications", f"/api/agents/{dev}/notifications", None),
        ("GET /api/agents/{rev}/notifications", f"/api/agents/{rev}/notifications", None),
        ("GET /api/agents/{dev}/digest", f"/api/agents/{dev}/digest", None),
        ("GET /api/agents/{dev}/rehydrate", f"/api/agents/{dev}/rehydrate", None),
        ("GET /api/agents/{dev}/persona", f"/api/agents/{dev}/persona", None),
        ("GET /api/agents/{dev}/protocol?task_id={t1}",
         f"/api/agents/{dev}/protocol", {"task_id": t1}),
        ("GET /api/agents/{dev}/reachability", f"/api/agents/{dev}/reachability", None),
        ("GET /api/agents/{dev}/runs", f"/api/agents/{dev}/runs", None),
        ("GET /api/agents/{dev}/resident-runs", f"/api/agents/{dev}/resident-runs", None),
        ("GET /api/agents/{dev}/conversation", f"/api/agents/{dev}/conversation", None),
        ("GET /api/conversations/{conv}", f"/api/conversations/{conv}", None),
        ("GET /api/conversations/{conv}/turns", f"/api/conversations/{conv}/turns", None),
        ("GET /api/tasks/{t1}/messages", f"/api/tasks/{t1}/messages", None),
        ("GET /api/tasks/{t1}/messages?limit=5", f"/api/tasks/{t1}/messages", {"limit": 5}),
        ("GET /api/tasks/{t1}/runs", f"/api/tasks/{t1}/runs", None),
        ("GET /api/tasks/{t1}/close-implications", f"/api/tasks/{t1}/close-implications", None),
        ("GET /api/tasks/{t3}/close-implications", f"/api/tasks/{t3}/close-implications", None),
        ("GET /api/requests/{rid}", f"/api/requests/{rid}", None),
        ("GET /api/me?cid={cid}", "/api/me", {"cid": c}),
    ]


# --------------------------------------------------------------------------------------------- #
# the test
# --------------------------------------------------------------------------------------------- #

async def test_api_response_shape_parity(request, client, container, make_agent, make_task,
                                         make_request, work_headers, tmp_path, monkeypatch):
    att = tmp_path / "orcha-attachments"
    att.mkdir()
    monkeypatch.setattr(main, "ATTACHMENTS_DIR", att)

    ids = await _run_scenario(client, container, make_agent, make_task, make_request,
                              work_headers)

    live, bad_dt = {}, []
    for label, path, params in _endpoints(ids):
        r = await client.get(path, params=params)
        assert r.status_code == 200, f"{label}: {r.status_code} {r.text[:300]}"
        body = r.json()
        live[label] = record(body)
        bad_dt += [f"  {label} {p}: {v!r}" for p, v in bad_datetimes(body)]

    if request.config.getoption("--regen-parity"):
        FIXTURE.parent.mkdir(parents=True, exist_ok=True)
        FIXTURE.write_text(json.dumps(
            {"_meta": {"backend": "postgres",
                       "regenerate": "pytest tests/test_dialect_parity.py --regen-parity",
                       "spec": "docs/superpowers/plans/2026-09-28-no-docker-no-postgres-"
                               "implementation-plan.md Part 4 S8"},
             "endpoints": live},
            indent=2, sort_keys=True) + "\n")
        assert not bad_dt, "refusing to bless non-'+00:00' datetimes:\n" + "\n".join(bad_dt)
        pytest.skip(f"parity fixture regenerated → {FIXTURE}")

    assert FIXTURE.exists(), f"{FIXTURE} missing — run with --regen-parity on Postgres"
    expected = json.loads(FIXTURE.read_text())["endpoints"]
    problems = diff_recordings(expected, live)
    if bad_dt:
        problems += ["  datetimes that are not ISO-8601 'T…+00:00':"] + bad_dt
    assert not problems, (
        "API response shape drifted from tests/fixtures/parity_postgres.json "
        "(expected = fixture, got = live run):\n" + "\n".join(problems)
    )


# --------------------------------------------------------------------------------------------- #
# the recorder's own teeth (pure; no DB)
# --------------------------------------------------------------------------------------------- #

def test_recorder_types_bools_and_datetimes():
    body = {
        "tasks": [
            {"id": "6f1c1a52-0c1b-4c4e-9d1e-2b1f0f7e3a11", "is_root": True, "priority": 1,
             "created_at": "2026-09-29T10:00:00.123456+00:00", "result": None, "cost": 0.5},
            {"id": "7a2d2b63-1d2c-4d5f-8e2f-3c2a1a8f4b22", "is_root": False, "priority": 2,
             "created_at": "2026-09-29T10:00:01+00:00", "result": {"text": "x"}, "extra": "y"},
        ],
        "by_agent": {"6f1c1a52-0c1b-4c4e-9d1e-2b1f0f7e3a11": {"n": 1}},
        "empty": [],
        "paused": False,
    }
    rec = record(body)
    t = rec["types"]["tasks"][0]
    assert t["is_root"] == "bool" and t["priority"] == "int" and t["cost"] == "absent|float"
    assert t["created_at"] == "iso-datetime" and t["id"] == "str"
    assert t["result"] == {"anyOf": ["null", {"text": "str"}]}
    assert t["extra"] == "absent|str"
    assert rec["types"]["by_agent"] == {"<uuid>": {"n": "int"}}
    assert rec["types"]["empty"] == []
    assert rec["booleans"] == {"$.paused": False, "$.tasks[*].is_root": [False, True]}
    assert rec["datetime_formats"] == {"$.tasks[*].created_at": ["T+00:00"]}
    assert bad_datetimes(body) == []


def test_recorder_catches_int_bool_and_naive_datetime():
    good = {"is_root": True, "created_at": "2026-09-29T10:00:00+00:00"}
    bad = {"is_root": 1, "created_at": "2026-09-29T10:00:00"}
    lines = diff_recordings({"GET /x": record(good)}, {"GET /x": record(bad)})
    text = "\n".join(lines)
    assert "type $.is_root: expected 'bool', got 'int'" in text
    assert "bool $.is_root: expected True, got '<missing>'" in text
    assert "datetime $.created_at: expected ['T+00:00'], got ['Tnaive']" in text
    assert bad_datetimes(bad) == [("$.created_at", "2026-09-29T10:00:00")]
    # a JSON aggregate that comes back as a string is a type change too
    agg = "\n".join(diff_recordings({"e": record({"assignees": ["a"]})},
                                     {"e": record({"assignees": '["a"]'})}))
    assert "type $.assignees: expected 'list', got 'str'" in agg
