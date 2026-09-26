"""GitHub hub (Feature A) — issues/pulls list, checks rollup, 60s cache, and Start
(task creation + idempotency + assignment + grant enforcement + repo-not-connected).

Per the test-teeth convention, the ONLY thing stubbed is the network leaf
(`github_hub_routes._gh_get`) plus the installation-token file read — the routes,
schema validation, task-creation internals, cache, and grant gate all run for real.

Any test here that binds a repo + a working token AND drives a FRESH start (not an
idempotent existing=True hit) also stubs `task_start_core._gh_post_comment` — the
round-trip "Orcha started this" comment leaf task_start_core fires on every fresh
start. Without the stub, a bound repo + resolvable token would make that leaf attempt
a REAL network call to api.github.com from a unit test. See test_task_start_core.py
for the comment feature's own dedicated coverage (composition, fresh-vs-existing,
non-fatal failure).
"""
import uuid

import pytest

from portal_backend import github_hub_routes as hub
from portal_backend import task_start_core as core


@pytest.fixture(autouse=True)
def _stub_start_comment(monkeypatch):
    """Autouse: no test in this file exercises the GitHub round-trip comment itself
    (that lives in test_task_start_core.py) — stub the leaf everywhere so a bound
    repo + working token never makes a real network call as a side effect of testing
    something else entirely."""
    monkeypatch.setattr(core, "_gh_post_comment", lambda repo, number, token, body: None)


@pytest.fixture(autouse=True)
def _clear_cache():
    """The 60s TTL cache is a module dict — reset it around every test so one test's
    cached payload never leaks into the next."""
    hub._CACHE.clear()
    yield
    hub._CACHE.clear()


@pytest.fixture
def token_env(monkeypatch, tmp_path):
    """Wire a legacy single installation-token file so _resolve_repo_token yields a
    token (the multi-org map is absent). Mirrors github_binding's token fixture."""
    token_file = tmp_path / "github-token"
    token_file.write_text("ghs_hubtoken\n")
    monkeypatch.setenv("ORCHA_GITHUB_TOKEN_FILE", str(token_file))
    monkeypatch.delenv("ORCHA_GITHUB_TOKENS_FILE", raising=False)
    return "ghs_hubtoken"


async def _bind_repo(client, cid, repo="acme/site"):
    r = await client.put(f"/api/containers/{cid}/github", json={"repo": repo})
    assert r.status_code == 200, r.text


def _fake_issue_get(number, title, repo="acme/site"):
    """A fake `_gh_get` serving the single-item issue-detail shape
    `github_hub_routes._fetch_gh_item` requests — mirrors test_slack_routes.py's
    helper of the same name/shape (kept local rather than shared to avoid a
    test-to-test import)."""
    def fake_get(path, token):
        assert path == f"/repos/{repo}/issues/{number}"
        return {"number": number, "title": title,
                "html_url": f"https://github.com/{repo}/issues/{number}", "body": ""}
    return fake_get


# ------------------------- repo not connected -------------------------

async def test_issues_repo_not_connected(client, container):
    r = await client.get(f"/api/containers/{container['id']}/github/issues")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["available"] is False and body["reason"] == "repo_not_connected"


async def test_pulls_repo_not_connected(client, container):
    r = await client.get(f"/api/containers/{container['id']}/github/pulls")
    assert r.status_code == 200
    assert r.json()["reason"] == "repo_not_connected"


async def test_issues_bad_cid_400_and_unknown_404(client):
    r = await client.get("/api/containers/not-a-uuid/github/issues")
    assert r.status_code == 400
    r = await client.get(f"/api/containers/{uuid.uuid4()}/github/issues")
    assert r.status_code == 404


# ------------------------- issues shape -------------------------

async def test_issues_shape_filters_prs(client, container, token_env, monkeypatch):
    cid = container["id"]
    await _bind_repo(client, cid)

    def fake_get(path, token):
        assert token == "ghs_hubtoken"
        assert "/repos/acme/site/issues" in path
        return [
            {"number": 7, "title": "Bug: crash on boot",
             "labels": [{"name": "bug", "color": "d73a4a"}, {"name": "p1", "color": "e99695"}],
             "assignee": {"login": "octocat"},
             "updated_at": "2026-07-01T00:00:00Z",
             "html_url": "https://github.com/acme/site/issues/7",
             "body": "x" * 500},
            # A PR masquerading in the issues list — must be filtered out.
            {"number": 8, "title": "a pr", "pull_request": {"url": "..."},
             "html_url": "https://github.com/acme/site/pull/8"},
        ]

    monkeypatch.setattr(hub, "_gh_get", fake_get)
    r = await client.get(f"/api/containers/{cid}/github/issues")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["available"] is True and body["repo"] == "acme/site"
    assert len(body["issues"]) == 1
    issue = body["issues"][0]
    assert issue == {
        "number": 7, "title": "Bug: crash on boot",
        "labels": [{"name": "bug", "color": "d73a4a"}, {"name": "p1", "color": "e99695"}],
        "assignee": "octocat", "updated_at": "2026-07-01T00:00:00Z",
        "html_url": "https://github.com/acme/site/issues/7",
        "body_excerpt": "x" * 200,   # first 200 chars only
        "tracked_task_id": None,     # no open Orcha task for #7 in this test
    }


async def test_issues_label_missing_color_omits_field(client, container, token_env, monkeypatch):
    """A label GitHub sends with no color at all still serializes — `color` is simply
    None, and the frontend falls back to its deterministic palette for that one tag."""
    cid = container["id"]
    await _bind_repo(client, cid)

    def fake_get(path, token):
        return [{"number": 9, "title": "no-color label", "labels": [{"name": "triage"}],
                  "assignee": None, "updated_at": "2026-07-01T00:00:00Z",
                  "html_url": "https://github.com/acme/site/issues/9", "body": ""}]

    monkeypatch.setattr(hub, "_gh_get", fake_get)
    r = await client.get(f"/api/containers/{cid}/github/issues")
    assert r.json()["issues"][0]["labels"] == [{"name": "triage", "color": None}]


# ------------------------- pulls list: single-call, lazy checks -------------------------

async def test_pulls_list_is_one_github_call_and_checks_is_null(
        client, container, token_env, monkeypatch):
    """The perf fix's core contract: the list route makes EXACTLY ONE GitHub call (the
    /pulls list itself) — never the per-PR status/check-runs fetches _checks_rollup used
    to make inline. `checks` comes back null ("not loaded yet"), not a rollup dict — a
    mutation that reintroduces an inline per-PR checks fetch on the list path must fail
    this test (call count > 1)."""
    cid = container["id"]
    await _bind_repo(client, cid)
    calls = []

    def fake_get(path, token):
        calls.append(path)
        if path.endswith("/pulls?state=open&per_page=100"):
            return [{
                "number": 12, "title": "Add feature", "draft": False,
                "updated_at": "2026-07-02T00:00:00Z",
                "html_url": "https://github.com/acme/site/pull/12",
                "head": {"ref": "feat/x", "sha": "deadbeef"},
                "requested_reviewers": [{"login": "hubot"}],
                "mergeable_state": "clean",
            }, {
                "number": 13, "title": "Second PR", "draft": False,
                "updated_at": "2026-07-02T00:00:00Z",
                "html_url": "https://github.com/acme/site/pull/13",
                "head": {"ref": "feat/y", "sha": "cafef00d"},
                "requested_reviewers": [],
                "mergeable_state": "unstable",
            }]
        # If the list route ever calls the checks surfaces, that's the exact regression
        # this test guards against — fail loudly rather than quietly returning data.
        raise AssertionError(f"list route must not fetch checks — unexpected path {path}")

    monkeypatch.setattr(hub, "_gh_get", fake_get)
    r = await client.get(f"/api/containers/{cid}/github/pulls")
    assert r.status_code == 200, r.text
    body = r.json()
    assert len(calls) == 1  # exactly one GitHub round-trip for the whole list
    pulls = body["pulls"]
    assert len(pulls) == 2
    assert pulls[0]["checks"] is None and pulls[1]["checks"] is None
    assert pulls[0]["head"] == "feat/x"
    assert pulls[0]["requested_reviewers"] == ["hubot"]
    assert pulls[0]["mergeable_state"] == "clean"


# ------------------------- batch checks endpoint -------------------------

def _fake_pulls_and_checks(calls, extra_numbers=()):
    """A fake _gh_get that serves a 2-PR (+ optional extras) /pulls list and, for any
    commits/<sha>/status|check-runs path, a rollup keyed by sha suffix so different PRs
    get distinguishable math. Every call is recorded in `calls` for concurrency/cache
    assertions."""
    base_pulls = [
        {"number": 12, "title": "Add feature", "draft": False,
         "updated_at": "2026-07-02T00:00:00Z",
         "html_url": "https://github.com/acme/site/pull/12",
         "head": {"ref": "feat/x", "sha": "sha12"},
         "requested_reviewers": [], "mergeable_state": "clean"},
        {"number": 13, "title": "Second PR", "draft": False,
         "updated_at": "2026-07-02T00:00:00Z",
         "html_url": "https://github.com/acme/site/pull/13",
         "head": {"ref": "feat/y", "sha": "sha13"},
         "requested_reviewers": [], "mergeable_state": "unstable"},
    ]
    for n in extra_numbers:
        base_pulls.append({
            "number": n, "title": f"PR {n}", "draft": False,
            "updated_at": "2026-07-02T00:00:00Z",
            "html_url": f"https://github.com/acme/site/pull/{n}",
            "head": {"ref": f"feat/{n}", "sha": f"sha{n}"},
            "requested_reviewers": [], "mergeable_state": "clean",
        })

    def fake_get(path, token):
        calls.append(path)
        if path.endswith("/pulls?state=open&per_page=100"):
            return base_pulls
        if path.startswith("/repos/acme/site/commits/") and path.endswith("/status"):
            return {"statuses": [{"state": "success"}]}
        if path.startswith("/repos/acme/site/commits/") and path.endswith("/check-runs"):
            return {"check_runs": [{"status": "completed", "conclusion": "failure"}]}
        raise AssertionError(f"unexpected path {path}")

    return fake_get


async def test_checks_batch_shape_and_math(client, container, token_env, monkeypatch):
    cid = container["id"]
    await _bind_repo(client, cid)
    calls = []
    monkeypatch.setattr(hub, "_gh_get", _fake_pulls_and_checks(calls))

    r = await client.get(f"/api/containers/{cid}/github/checks?numbers=12,13")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["available"] is True
    # 1 status success + 1 check-run failure -> 1 passed, 1 failing, per number
    assert body["checks"]["12"] == {"passed": 1, "failing": 1, "pending": 0, "total": 2}
    assert body["checks"]["13"] == {"passed": 1, "failing": 1, "pending": 0, "total": 2}


async def test_checks_batch_absent_number_is_silently_skipped(
        client, container, token_env, monkeypatch):
    """A requested number that isn't in the current open-PR list (closed/merged since,
    or simply wrong) is just absent from the response — not an error."""
    cid = container["id"]
    await _bind_repo(client, cid)
    calls = []
    monkeypatch.setattr(hub, "_gh_get", _fake_pulls_and_checks(calls))

    r = await client.get(f"/api/containers/{cid}/github/checks?numbers=12,999")
    assert r.status_code == 200, r.text
    body = r.json()
    assert "12" in body["checks"]
    assert "999" not in body["checks"]


async def test_checks_batch_cap_rejects_over_30_numbers(client, container, token_env):
    cid = container["id"]
    await _bind_repo(client, cid)
    too_many = ",".join(str(n) for n in range(1, 32))  # 31 numbers
    r = await client.get(f"/api/containers/{cid}/github/checks?numbers={too_many}")
    assert r.status_code == 400


async def test_checks_batch_bad_numbers_400(client, container, token_env):
    cid = container["id"]
    await _bind_repo(client, cid)
    r = await client.get(f"/api/containers/{cid}/github/checks?numbers=abc,def")
    assert r.status_code == 400


async def test_checks_batch_empty_numbers_returns_empty(client, container, token_env):
    cid = container["id"]
    await _bind_repo(client, cid)
    r = await client.get(f"/api/containers/{cid}/github/checks?numbers=")
    assert r.status_code == 200
    assert r.json() == {"available": True, "checks": {}}


async def test_checks_batch_missing_numbers_param_422(client, container):
    """`numbers` is a required query param (Query(...)) — omitting it entirely is a
    clean FastAPI validation 422, not a 500."""
    cid = container["id"]
    r = await client.get(f"/api/containers/{cid}/github/checks")
    assert r.status_code == 422


async def test_checks_batch_reuses_warm_pulls_cache_no_second_list_call(
        client, container, token_env, monkeypatch):
    """The batch endpoint must resolve head shas from the ALREADY-cached pulls list (from
    a prior GET .../pulls) rather than re-fetching the list — a warm cache means the
    batch call's ONLY GitHub traffic is the per-number checks fetches."""
    cid = container["id"]
    await _bind_repo(client, cid)
    calls = []
    monkeypatch.setattr(hub, "_gh_get", _fake_pulls_and_checks(calls))

    await client.get(f"/api/containers/{cid}/github/pulls")
    list_call_count = len(calls)
    assert list_call_count == 1

    r = await client.get(f"/api/containers/{cid}/github/checks?numbers=12,13")
    assert r.status_code == 200, r.text
    # no additional /pulls list call — only the per-number status+check-runs fetches
    list_calls_after = [c for c in calls if c.endswith("/pulls?state=open&per_page=100")]
    assert len(list_calls_after) == 1
    assert len(calls) == list_call_count + 4  # 2 numbers * (status + check-runs)


async def test_checks_batch_refetches_list_when_cache_cold(
        client, container, token_env, monkeypatch):
    """No warm pulls cache (e.g. the batch call races ahead of/without a prior list GET)
    -> the batch route fetches the list itself ONCE to resolve shas, then proceeds."""
    cid = container["id"]
    await _bind_repo(client, cid)
    calls = []
    monkeypatch.setattr(hub, "_gh_get", _fake_pulls_and_checks(calls))

    r = await client.get(f"/api/containers/{cid}/github/checks?numbers=12")
    assert r.status_code == 200, r.text
    list_calls = [c for c in calls if c.endswith("/pulls?state=open&per_page=100")]
    assert len(list_calls) == 1
    assert body_checks_present(r, "12")


def body_checks_present(r, number):
    return number in r.json()["checks"]


async def test_checks_batch_cached_per_number_and_sha(
        client, container, token_env, monkeypatch):
    """Repeat batch reads for the SAME number+sha are served from the 60s cache; past the
    TTL GitHub is hit again for that number."""
    cid = container["id"]
    await _bind_repo(client, cid)
    calls = []
    monkeypatch.setattr(hub, "_gh_get", _fake_pulls_and_checks(calls))

    await client.get(f"/api/containers/{cid}/github/checks?numbers=12")
    n_after_first = len(calls)
    await client.get(f"/api/containers/{cid}/github/checks?numbers=12")
    assert len(calls) == n_after_first  # served from cache — no new GitHub calls

    base = hub.time.monotonic()
    monkeypatch.setattr(hub.time, "monotonic", lambda: base + hub.CACHE_TTL_SECONDS + 1)
    await client.get(f"/api/containers/{cid}/github/checks?numbers=12")
    assert len(calls) > n_after_first


async def test_checks_batch_concurrency_is_bounded(
        client, container, token_env, monkeypatch):
    """Fan-out across the requested numbers happens concurrently (not strictly serial —
    the whole point of the perf fix), but never exceeds CHECKS_POOL_SIZE in flight at
    once. Instrument _gh_get to track concurrent in-flight calls via a lock + counter."""
    import threading
    import time as time_mod

    cid = container["id"]
    await _bind_repo(client, cid)
    lock = threading.Lock()
    state = {"inflight": 0, "max_inflight": 0}
    numbers = list(range(20, 20 + 12))  # 12 PRs -> exercises the pool bound (8)

    pulls_list = [{
        "number": n, "title": f"PR {n}", "draft": False,
        "updated_at": "2026-07-02T00:00:00Z",
        "html_url": f"https://github.com/acme/site/pull/{n}",
        "head": {"ref": f"feat/{n}", "sha": f"sha{n}"},
        "requested_reviewers": [], "mergeable_state": "clean",
    } for n in numbers]

    def fake_get(path, token):
        if path.endswith("/pulls?state=open&per_page=100"):
            return pulls_list
        # Only the per-sha check surfaces below simulate concurrent network latency —
        # a real GitHub round-trip takes measurable wall time, so overlapping calls
        # only show up as concurrent if we hold the "in flight" window open briefly.
        with lock:
            state["inflight"] += 1
            state["max_inflight"] = max(state["max_inflight"], state["inflight"])
        try:
            time_mod.sleep(0.05)
        finally:
            with lock:
                state["inflight"] -= 1
        if path.endswith("/status"):
            return {"statuses": []}
        return {"check_runs": []}

    monkeypatch.setattr(hub, "_gh_get", fake_get)
    numbers_param = ",".join(str(n) for n in numbers)
    r = await client.get(f"/api/containers/{cid}/github/checks?numbers={numbers_param}")
    assert r.status_code == 200, r.text
    assert len(r.json()["checks"]) == 12
    # concurrency actually happened (>1 in flight at once) …
    assert state["max_inflight"] > 1
    # … but never exceeded the bounded pool size.
    assert state["max_inflight"] <= hub.CHECKS_POOL_SIZE


async def test_checks_batch_403_degrades_to_zeros_per_number(
        client, container, token_env, monkeypatch):
    """The existing 403-unreadable-checks degradation (_checks_rollup catching
    RuntimeError -> zeros) applies per-number in the batch route too — one PR's checks
    being forbidden must not fail the whole batch."""
    cid = container["id"]
    await _bind_repo(client, cid)
    calls = []

    def fake_get(path, token):
        calls.append(path)
        if path.endswith("/pulls?state=open&per_page=100"):
            return [{
                "number": 12, "title": "x", "draft": False,
                "updated_at": "2026-07-02T00:00:00Z",
                "html_url": "https://github.com/acme/site/pull/12",
                "head": {"ref": "feat/x", "sha": "deadbeef"},
                "requested_reviewers": [], "mergeable_state": "clean",
            }]
        raise RuntimeError("github_status:403")

    monkeypatch.setattr(hub, "_gh_get", fake_get)
    r = await client.get(f"/api/containers/{cid}/github/checks?numbers=12")
    assert r.status_code == 200, r.text
    assert r.json()["checks"]["12"] == {"passed": 0, "failing": 0, "pending": 0, "total": 0}


async def test_checks_batch_repo_not_connected(client, container):
    r = await client.get(f"/api/containers/{container['id']}/github/checks?numbers=1")
    assert r.status_code == 200
    assert r.json()["reason"] == "repo_not_connected"


async def test_checks_batch_bad_cid_400_and_unknown_404(client):
    r = await client.get("/api/containers/not-a-uuid/github/checks?numbers=1")
    assert r.status_code == 400
    r = await client.get(f"/api/containers/{uuid.uuid4()}/github/checks?numbers=1")
    assert r.status_code == 404


async def test_checks_batch_trusted_non_member_403(
        client, container, make_agent, trust_proxy):
    cid = container["id"]
    await _bind_owner(client, container, make_agent)
    r = await client.get(f"/api/containers/{cid}/github/checks?numbers=1", headers=MALLORY)
    assert r.status_code == 403, r.text


# ------------------------- cache TTL behavior -------------------------

async def test_issues_cached_60s(client, container, token_env, monkeypatch):
    cid = container["id"]
    await _bind_repo(client, cid)
    calls = {"n": 0}

    def fake_get(path, token):
        calls["n"] += 1
        return []

    monkeypatch.setattr(hub, "_gh_get", fake_get)
    await client.get(f"/api/containers/{cid}/github/issues")
    await client.get(f"/api/containers/{cid}/github/issues")
    assert calls["n"] == 1  # second read served from the 60s cache

    # Advance past the TTL → GitHub is hit again.
    base = hub.time.monotonic()
    monkeypatch.setattr(hub.time, "monotonic", lambda: base + hub.CACHE_TTL_SECONDS + 1)
    await client.get(f"/api/containers/{cid}/github/issues")
    assert calls["n"] == 2


# ------------------------- error mapping (rate limit / 404) -------------------------

async def test_issues_rate_limited_403(client, container, token_env, monkeypatch):
    cid = container["id"]
    await _bind_repo(client, cid)

    def fake_get(path, token):
        raise RuntimeError("github_status:403")

    monkeypatch.setattr(hub, "_gh_get", fake_get)
    r = await client.get(f"/api/containers/{cid}/github/issues")
    assert r.status_code == 200  # graceful, never a 5xx
    assert r.json()["reason"] == "rate_limited"


async def test_pulls_404_reads_as_not_connected(client, container, token_env, monkeypatch):
    cid = container["id"]
    await _bind_repo(client, cid)
    monkeypatch.setattr(hub, "_gh_get",
                        lambda p, t: (_ for _ in ()).throw(RuntimeError("github_status:404")))
    r = await client.get(f"/api/containers/{cid}/github/pulls")
    assert r.json()["reason"] == "repo_not_connected"


# ------------------------- start: creation + idempotency + assignment -------------------------

async def test_start_issue_creates_task(client, container, make_task):
    cid = container["id"]
    r = await client.post(
        f"/api/containers/{cid}/github/start",
        json={"kind": "issue", "number": 42, "title": "Fix the thing",
              "body_excerpt": "it is broken",
              "html_url": "https://github.com/acme/site/issues/42"},
    )
    assert r.status_code == 201, r.text
    body = r.json()
    assert body["existing"] is False and body["task_id"]
    # The created task carries the templated shape.
    listed = (await client.get(f"/api/containers/{cid}/tasks")).json()["tasks"]
    t = [x for x in listed if x["id"] == body["task_id"]][0]
    assert t["title"] == "GH #42: Fix the thing"
    assert "Fix GH #42 per its description" in t["definition_of_done"]
    assert "Never merge" in t["definition_of_done"]
    assert t["status"] == "ready"  # unassigned → ready


async def test_start_pull_dod_template(client, container):
    cid = container["id"]
    r = await client.post(
        f"/api/containers/{cid}/github/start",
        json={"kind": "pull", "number": 9, "title": "WIP"},
    )
    assert r.status_code == 201, r.text
    tid = r.json()["task_id"]
    listed = (await client.get(f"/api/containers/{cid}/tasks")).json()["tasks"]
    t = [x for x in listed if x["id"] == tid][0]
    assert t["title"] == "GH #9: WIP"
    assert "Resolve CI failures / review feedback on PR #9" in t["definition_of_done"]
    assert "NOT merged without human review" in t["definition_of_done"]


async def test_start_idempotent_same_number(client, container):
    cid = container["id"]
    r1 = await client.post(f"/api/containers/{cid}/github/start",
                           json={"kind": "issue", "number": 42, "title": "A"})
    r2 = await client.post(f"/api/containers/{cid}/github/start",
                           json={"kind": "issue", "number": 42, "title": "A"})
    assert r1.json()["existing"] is False
    assert r2.json()["existing"] is True
    assert r2.json()["task_id"] == r1.json()["task_id"]
    # only ONE task exists for GH #42
    listed = (await client.get(f"/api/containers/{cid}/tasks")).json()["tasks"]
    assert sum(1 for t in listed if t["title"].startswith("GH #42:")) == 1


async def test_start_prefix_does_not_false_match(client, container):
    """GH #12 must not be mistaken for GH #123 (the LIKE probe uses the ': ' delimiter)."""
    cid = container["id"]
    await client.post(f"/api/containers/{cid}/github/start",
                      json={"kind": "issue", "number": 12, "title": "twelve"})
    r = await client.post(f"/api/containers/{cid}/github/start",
                          json={"kind": "issue", "number": 123, "title": "one-two-three"})
    assert r.json()["existing"] is False  # a distinct task, not a false idempotency hit


# ------------------------- tracked_task_id: list/detail know up front -------------------------
#
# Founder-caught gap: issue #232 started via Slack still showed a fresh "Start ->" on
# the hub's list/detail — the frontend's "already tracked" chip only appeared AFTER a
# click returned {existing:true}, since the list/detail endpoints never told it a task
# was already tracked. Fix: every list/detail response now carries `tracked_task_id`
# (str|None) per item, computed via the SAME open-task lookup POST /start's idempotency
# check uses (task_start_core.find_open_gh_tasks) — so the two can't drift, and a task
# started through ANY path (hub click, Slack `/orcha start`) shows as tracked on the
# very next hub fetch, not just within the browser session that started it.

async def test_issues_list_carries_tracked_task_id_for_started_item(
        client, container, token_env, monkeypatch):
    cid = container["id"]
    await _bind_repo(client, cid)

    def fake_get(path, token):
        # Serves BOTH shapes _gh_get is asked for here: the LIST fetch (the issues
        # page render) and the SINGLE-item detail fetch POST /start now ALSO makes
        # (the authoritative-title live fetch, `_fetch_gh_item`) — a real GitHub
        # token would equally answer either path against the same underlying issue.
        if path == "/repos/acme/site/issues/232":
            return {"number": 232, "title": "Clinician dashboard",
                    "html_url": "https://github.com/acme/site/issues/232", "body": ""}
        return [
            {"number": 232, "title": "Clinician dashboard", "html_url": "https://github.com/acme/site/issues/232"},
            {"number": 50, "title": "untouched", "html_url": "https://github.com/acme/site/issues/50"},
        ]

    monkeypatch.setattr(hub, "_gh_get", fake_get)
    # Start #232 the way EITHER dispatch path would — directly through the shared core
    # here (task_start_core), so this test doesn't depend on the Slack route at all.
    start_r = await client.post(f"/api/containers/{cid}/github/start",
                                json={"kind": "issue", "number": 232, "title": "Clinician dashboard"})
    assert start_r.status_code == 201, start_r.text
    tid = start_r.json()["task_id"]

    r = await client.get(f"/api/containers/{cid}/github/issues")
    assert r.status_code == 200, r.text
    by_number = {it["number"]: it for it in r.json()["issues"]}
    assert by_number[232]["tracked_task_id"] == tid
    assert by_number[50]["tracked_task_id"] is None


async def test_issues_list_reflects_tracked_state_even_when_gh_cache_is_warm(
        client, container, token_env, monkeypatch):
    """tracked_task_id is computed OUTSIDE the 60s GitHub-list cache — a task tracked
    AFTER the list was cached still shows as tracked on the very next fetch, without
    waiting for the GitHub cache to expire. Seeds the tracked task directly via the
    plain tasks API (the SAME 'GH #300: ' title-prefix idempotency key
    find_open_gh_tasks matches on — see test_start_pull_idempotent_skips_live_refetch's
    identical seeding technique) rather than through POST /start, since THAT route's
    own _cache_invalidate would confound this test's "still warm" premise with its
    own (separate, pre-existing, intentional) full-cache invalidation on every start."""
    cid = container["id"]
    await _bind_repo(client, cid)
    calls = {"n": 0}

    def fake_get(path, token):
        calls["n"] += 1
        return [{"number": 300, "title": "x", "html_url": "https://github.com/acme/site/issues/300"}]

    monkeypatch.setattr(hub, "_gh_get", fake_get)
    r1 = await client.get(f"/api/containers/{cid}/github/issues")
    assert r1.json()["issues"][0]["tracked_task_id"] is None
    assert calls["n"] == 1

    seeded = await client.post(f"/api/containers/{cid}/tasks", json={
        "title": "GH #300: seed", "description": "", "definition_of_done": "x",
    })
    assert seeded.status_code == 201, seeded.text
    tid = seeded.json()["task_id"]

    # Second list fetch: GitHub cache still warm (no new _gh_get call)…
    r2 = await client.get(f"/api/containers/{cid}/github/issues")
    assert calls["n"] == 1   # still cached — no extra GitHub call
    # …but tracked_task_id is fresh, not stale from the cached payload.
    assert r2.json()["issues"][0]["tracked_task_id"] == tid


async def test_pull_detail_carries_tracked_task_id(client, container, token_env, monkeypatch):
    cid = container["id"]
    await _bind_repo(client, cid)
    pr = _pr_object(77)
    monkeypatch.setattr(hub, "_gh_get", lambda p, t: [] if "/files" in p else pr)
    start_r = await client.post(f"/api/containers/{cid}/github/start",
                                json={"kind": "pull", "number": 77, "title": "x"})
    assert start_r.status_code == 201, start_r.text

    r = await client.get(f"/api/containers/{cid}/github/pulls/77")
    assert r.status_code == 200, r.text
    assert r.json()["pull"]["tracked_task_id"] == start_r.json()["task_id"]


async def test_issue_detail_carries_tracked_task_id_none_when_untracked(
        client, container, token_env, monkeypatch):
    cid = container["id"]
    await _bind_repo(client, cid)
    monkeypatch.setattr(hub, "_gh_get", lambda p, t: {
        "number": 5, "title": "x", "state": "open", "body": "", "user": {"login": "octocat"},
        "labels": [], "assignee": None, "assignees": [], "comments": 0,
    } if "/comments" not in p else [])
    r = await client.get(f"/api/containers/{cid}/github/issues/5")
    assert r.status_code == 200, r.text
    assert r.json()["issue"]["tracked_task_id"] is None


async def test_pulls_list_batches_tracked_lookup_into_one_query(
        client, container, token_env, monkeypatch, db):
    """Call-count assertion: N items in the list must cost exactly ONE call into the
    shared tracked-lookup helper (task_start_core.find_open_gh_tasks), not N — the
    whole point of the batched helper over a find_open_gh_task-per-row loop. Wraps the
    helper itself (still delegating to the real implementation) rather than the
    cursor's `execute` — psycopg's Cursor.execute is a read-only C-level attribute and
    can't be monkeypatched per-instance."""
    cid = container["id"]
    await _bind_repo(client, cid)
    numbers = list(range(1, 11))
    monkeypatch.setattr(hub, "_gh_get", lambda p, t: [
        {**_pr_object(n), "number": n} for n in numbers
    ])

    calls = {"n": 0}
    real_find = hub.find_open_gh_tasks

    def counting_find(cur, container_id, nums):
        calls["n"] += 1
        return real_find(cur, container_id, nums)

    # Patch the name INSIDE github_hub_routes's own namespace (where
    # _with_tracked_list/_with_tracked_one actually resolve it from) — a
    # `from ... import find_open_gh_tasks` binds a separate reference in this
    # module's globals, so patching task_start_core.find_open_gh_tasks directly
    # would silently miss it (same pitfall slack_routes.py's _gh_get had).
    monkeypatch.setattr(hub, "find_open_gh_tasks", counting_find)
    r = await client.get(f"/api/containers/{cid}/github/pulls")
    assert r.status_code == 200, r.text
    assert len(r.json()["pulls"]) == 10
    assert calls["n"] == 1   # ONE call for all 10 numbers, not 10


async def test_start_with_assignee_assigns_and_wakes(client, container, make_agent, db):
    cid = container["id"]
    agent = await make_agent("worker-1", kind="ai")
    aid = agent["agent_id"]
    r = await client.post(
        f"/api/containers/{cid}/github/start",
        json={"kind": "issue", "number": 5, "title": "assign me",
              "assignee_agent_id": aid},
    )
    assert r.status_code == 201, r.text
    tid = r.json()["task_id"]
    # A 'working' agent_tasks row exists (assignment happened) …
    rows = db.execute(
        "SELECT assignment_status FROM agent_tasks WHERE task_id=%s AND agent_id=%s",
        (tid, aid))
    assert rows and rows[0]["assignment_status"] == "working"
    # … the task is in_progress (assigned), and a targeted task_assigned wake fired.
    listed = (await client.get(f"/api/containers/{cid}/tasks")).json()["tasks"]
    t = [x for x in listed if x["id"] == tid][0]
    assert t["status"] == "in_progress"
    evs = db.execute(
        "SELECT 1 FROM agent_events WHERE event_key=%s AND event_name='task_assigned'",
        (aid,))
    assert evs, "assignee should have received a targeted task_assigned wake"


async def test_start_assignee_must_be_ai_in_container(client, container, make_agent):
    cid = container["id"]
    # a human is not a valid assignee
    human = await make_agent("ops", kind="human")
    r = await client.post(
        f"/api/containers/{cid}/github/start",
        json={"kind": "issue", "number": 5, "title": "x",
              "assignee_agent_id": human["agent_id"]},
    )
    assert r.status_code == 409
    # an unknown agent id 404s
    r = await client.post(
        f"/api/containers/{cid}/github/start",
        json={"kind": "issue", "number": 6, "title": "x",
              "assignee_agent_id": str(uuid.uuid4())},
    )
    assert r.status_code == 404


async def test_start_bad_kind_422(client, container):
    r = await client.post(f"/api/containers/{container['id']}/github/start",
                          json={"kind": "branch", "number": 1})
    assert r.status_code == 422


# ------------------------- grant enforcement (trusted proxy lane) -------------------------

OCTO = {"X-Auth-Request-User": "octocat"}
MALLORY = {"X-Auth-Request-User": "mallory"}


@pytest.fixture
def trust_proxy(monkeypatch):
    monkeypatch.setenv("ORCHA_TRUST_PROXY_USER", "1")


async def _bind_owner(client, container, make_agent):
    await make_agent("root", "operator", kind="human")
    r = await client.get(f"/api/me?cid={container['id']}", headers=OCTO)
    assert r.status_code == 200, r.text
    return r.json()["identity"]


async def test_start_trusted_non_member_403(client, container, make_agent, trust_proxy):
    """Start requires the same grant task creation does: under proxy trust a non-member
    is refused — exactly like POST .../tasks (trusted_actor)."""
    cid = container["id"]
    await _bind_owner(client, container, make_agent)  # now mapped to octocat
    r = await client.post(
        f"/api/containers/{cid}/github/start",
        json={"kind": "issue", "number": 1, "title": "x"},
        headers=MALLORY,
    )
    assert r.status_code == 403, r.text


async def test_start_trusted_member_ok(client, container, make_agent, trust_proxy):
    cid = container["id"]
    await _bind_owner(client, container, make_agent)
    r = await client.post(
        f"/api/containers/{cid}/github/start",
        json={"kind": "issue", "number": 2, "title": "x"},
        headers=OCTO,
    )
    assert r.status_code == 201, r.text


# ===================================================================================
# DETAIL endpoints — PR detail (.../pulls/{n}) and issue detail (.../issues/{n}).
# Same faked-network / real-route discipline as above; the only stub is hub._gh_get.
# ===================================================================================

# A full PR object as GitHub's /pulls/{n} returns it (the fields the route reads).
def _pr_object(number=12):
    return {
        "number": number, "title": "Add feature", "state": "open", "draft": False,
        "body": "## Why\nbecause",
        "user": {"login": "octocat"},
        "base": {"ref": "main"}, "head": {"ref": "feat/x", "sha": "deadbeef"},
        "updated_at": "2026-07-02T00:00:00Z", "created_at": "2026-07-01T00:00:00Z",
        "html_url": f"https://github.com/acme/site/pull/{number}",
        "mergeable_state": "clean",
        "assignees": [{"login": "octocat"}, {"login": "hubot"}],
        "requested_reviewers": [{"login": "reviewer1"}],
        "comments": 3, "review_comments": 5, "changed_files": 2,
    }


# ------------------------- PR detail: full shape + shared rollup (with runs) ----------

async def test_pull_detail_full_shape(client, container, token_env, monkeypatch):
    cid = container["id"]
    await _bind_repo(client, cid)

    def fake_get(path, token):
        assert token == "ghs_hubtoken"
        if path == "/repos/acme/site/pulls/12":
            return _pr_object()
        if path == "/repos/acme/site/commits/deadbeef/status":
            return {"statuses": [
                {"state": "success", "context": "travis", "target_url": "http://t"},
            ]}
        if path == "/repos/acme/site/commits/deadbeef/check-runs":
            return {"check_runs": [
                {"name": "build", "status": "completed", "conclusion": "success",
                 "html_url": "http://b"},
                {"name": "lint", "status": "in_progress", "conclusion": None,
                 "html_url": "http://l"},
            ]}
        if path == "/repos/acme/site/pulls/12/files?per_page=100":
            return [
                {"filename": "a.py", "additions": 10, "deletions": 2, "status": "modified",
                 "patch": "@@ -1 +1 @@ ..."},
                {"filename": "b.py", "additions": 3, "deletions": 0, "status": "added"},
            ]
        raise AssertionError(f"unexpected path {path}")

    monkeypatch.setattr(hub, "_gh_get", fake_get)
    r = await client.get(f"/api/containers/{cid}/github/pulls/12")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["available"] is True and body["repo"] == "acme/site"
    pull = body["pull"]
    # scalar contract fields
    assert pull["number"] == 12 and pull["title"] == "Add feature"
    assert pull["state"] == "open" and pull["draft"] is False
    assert pull["body_markdown"] == "## Why\nbecause"   # RAW markdown, not html-rendered
    assert pull["author_login"] == "octocat"
    assert pull["base"] == "main" and pull["head"] == "feat/x"
    assert pull["created_at"] == "2026-07-01T00:00:00Z"
    assert pull["updated_at"] == "2026-07-02T00:00:00Z"
    assert pull["html_url"] == "https://github.com/acme/site/pull/12"
    assert pull["mergeable_state"] == "clean"
    assert pull["assignees"] == ["octocat", "hubot"]
    assert pull["requested_reviewers"] == ["reviewer1"]
    assert pull["comments_count"] == 3 and pull["review_comments_count"] == 5
    # checks: shared rollup math (1 status pass + 1 run pass = 2 passed, 1 pending) …
    assert pull["checks"]["passed"] == 2
    assert pull["checks"]["pending"] == 1
    assert pull["checks"]["failing"] == 0
    assert pull["checks"]["total"] == 3
    # … PLUS the per-run list the detail page needs (status context normalized to a run)
    runs = pull["checks"]["runs"]
    assert {"name": "travis", "status": "completed", "conclusion": "success",
            "html_url": "http://t"} in runs
    assert {"name": "build", "status": "completed", "conclusion": "success",
            "html_url": "http://b"} in runs
    assert {"name": "lint", "status": "in_progress", "conclusion": None,
            "html_url": "http://l"} in runs
    # files: count from GitHub's changed_files, EACH file now carries its patch text
    assert pull["files"]["count"] == 2
    assert "truncated" not in pull["files"]  # count == items -> not truncated
    assert "patches_truncated" not in pull["files"]   # well under budget -> not set
    assert pull["files"]["items"] == [
        {"filename": "a.py", "additions": 10, "deletions": 2, "status": "modified",
         "patch": "@@ -1 +1 @@ ...", "patch_omitted": False},
        {"filename": "b.py", "additions": 3, "deletions": 0, "status": "added",
         "patch": None, "patch_omitted": True},
    ]


async def test_pull_detail_files_truncated_flag(client, container, token_env, monkeypatch):
    """When GitHub's changed_files total exceeds the page we fetched, files.truncated=True
    and count reports the HONEST total (not the truncated page length)."""
    cid = container["id"]
    await _bind_repo(client, cid)

    pr = _pr_object()
    pr["changed_files"] = 250  # more than the 100-item page

    def fake_get(path, token):
        if path == "/repos/acme/site/pulls/12":
            return pr
        if path.startswith("/repos/acme/site/commits/"):
            return {"statuses": [], "check_runs": []}
        if path == "/repos/acme/site/pulls/12/files?per_page=100":
            # a full page of 100 files
            return [{"filename": f"f{i}.py", "additions": 1, "deletions": 0,
                     "status": "modified"} for i in range(100)]
        raise AssertionError(f"unexpected path {path}")

    monkeypatch.setattr(hub, "_gh_get", fake_get)
    r = await client.get(f"/api/containers/{cid}/github/pulls/12")
    files = r.json()["pull"]["files"]
    assert files["count"] == 250           # honest total from changed_files
    assert len(files["items"]) == 100      # only the first page returned
    assert files["truncated"] is True
    # files.truncated (too many FILES) is orthogonal to patches_truncated (too much PATCH
    # TEXT) — none of this fixture's 100 files carry a patch, so every item is an honest
    # GitHub-side omission, not a budget cut.
    assert "patches_truncated" not in files
    assert all(f["patch"] is None and f["patch_omitted"] is True for f in files["items"])


# ------------------------- PR detail: per-file patch text (diff view) -----------------

async def test_pull_detail_files_include_patch_text(client, container, token_env, monkeypatch):
    """Each file in files.items now carries GitHub's raw unified-diff `patch` text (or
    null when GitHub omits it) — the Files-changed tab's diff renderer input."""
    cid = container["id"]
    await _bind_repo(client, cid)

    def fake_get(path, token):
        if path == "/repos/acme/site/pulls/12":
            return _pr_object()
        if path.startswith("/repos/acme/site/commits/"):
            return {"statuses": [], "check_runs": []}
        if path == "/repos/acme/site/pulls/12/files?per_page=100":
            return [
                {"filename": "a.py", "additions": 1, "deletions": 1, "status": "modified",
                 "patch": "@@ -1,1 +1,1 @@\n-old\n+new"},
            ]
        raise AssertionError(f"unexpected path {path}")

    monkeypatch.setattr(hub, "_gh_get", fake_get)
    r = await client.get(f"/api/containers/{cid}/github/pulls/12")
    item = r.json()["pull"]["files"]["items"][0]
    assert item["patch"] == "@@ -1,1 +1,1 @@\n-old\n+new"
    assert item["patch_omitted"] is False


async def test_pull_detail_files_binary_omits_patch(client, container, token_env, monkeypatch):
    """A binary (or GitHub-judged-too-large) file carries no `patch` key at all in GitHub's
    response — the route must render that as an HONEST patch:null/patch_omitted:true, not
    crash or silently fabricate an empty string."""
    cid = container["id"]
    await _bind_repo(client, cid)

    def fake_get(path, token):
        if path == "/repos/acme/site/pulls/12":
            return _pr_object()
        if path.startswith("/repos/acme/site/commits/"):
            return {"statuses": [], "check_runs": []}
        if path == "/repos/acme/site/pulls/12/files?per_page=100":
            # GitHub's real shape for a binary file: no "patch" key present at all.
            return [
                {"filename": "logo.png", "additions": 0, "deletions": 0, "status": "modified"},
            ]
        raise AssertionError(f"unexpected path {path}")

    monkeypatch.setattr(hub, "_gh_get", fake_get)
    r = await client.get(f"/api/containers/{cid}/github/pulls/12")
    files = r.json()["pull"]["files"]
    assert files["items"][0]["patch"] is None
    assert files["items"][0]["patch_omitted"] is True
    # a GitHub-side omission is NOT the same thing as a budget cut.
    assert "patches_truncated" not in files


async def test_pull_detail_files_patch_budget_truncates_in_order(
        client, container, token_env, monkeypatch):
    """When the summed patch text would exceed PATCH_BUDGET_BYTES, files are included IN
    ORDER until the budget is hit; the rest get patch:null/patch_omitted:true and the
    files object is marked patches_truncated:true (distinct from files.truncated, which is
    about the file COUNT/pagination, not patch text size)."""
    cid = container["id"]
    await _bind_repo(client, cid)

    small_budget = 100
    monkeypatch.setattr(hub, "PATCH_BUDGET_BYTES", small_budget)

    def fake_get(path, token):
        if path == "/repos/acme/site/pulls/12":
            return _pr_object()
        if path.startswith("/repos/acme/site/commits/"):
            return {"statuses": [], "check_runs": []}
        if path == "/repos/acme/site/pulls/12/files?per_page=100":
            return [
                {"filename": "a.py", "additions": 1, "deletions": 0, "status": "modified",
                 "patch": "x" * 60},
                {"filename": "b.py", "additions": 1, "deletions": 0, "status": "modified",
                 "patch": "y" * 60},   # 60+60 > 100 -> this one gets cut
                {"filename": "c.py", "additions": 1, "deletions": 0, "status": "modified",
                 "patch": "z" * 10},   # every file after the cut is ALSO omitted
            ]
        raise AssertionError(f"unexpected path {path}")

    monkeypatch.setattr(hub, "_gh_get", fake_get)
    r = await client.get(f"/api/containers/{cid}/github/pulls/12")
    files = r.json()["pull"]["files"]
    items = files["items"]
    assert items[0]["patch"] == "x" * 60 and items[0]["patch_omitted"] is False
    assert items[1]["patch"] is None and items[1]["patch_omitted"] is True
    assert items[2]["patch"] is None and items[2]["patch_omitted"] is True
    assert files["patches_truncated"] is True
    # file-count pagination truncation is untouched by the patch-text budget.
    assert "truncated" not in files


async def test_pull_detail_files_patch_budget_boundary_is_inclusive(
        client, container, token_env, monkeypatch):
    """Mutation-guard for the off-by-one at the budget boundary: a file whose patch fits
    EXACTLY within the remaining budget is included, not omitted (the check is
    `used + len(patch) > budget`, not `>=`)."""
    cid = container["id"]
    await _bind_repo(client, cid)
    monkeypatch.setattr(hub, "PATCH_BUDGET_BYTES", 10)

    def fake_get(path, token):
        if path == "/repos/acme/site/pulls/12":
            return _pr_object()
        if path.startswith("/repos/acme/site/commits/"):
            return {"statuses": [], "check_runs": []}
        if path == "/repos/acme/site/pulls/12/files?per_page=100":
            return [
                {"filename": "exact.py", "additions": 1, "deletions": 0,
                 "status": "modified", "patch": "x" * 10},   # == budget exactly
            ]
        raise AssertionError(f"unexpected path {path}")

    monkeypatch.setattr(hub, "_gh_get", fake_get)
    r = await client.get(f"/api/containers/{cid}/github/pulls/12")
    files = r.json()["pull"]["files"]
    assert files["items"][0]["patch"] == "x" * 10
    assert files["items"][0]["patch_omitted"] is False
    assert "patches_truncated" not in files


# ------------------------- rollup-helper sharing (mutation note) ----------------------

def test_checks_rollup_helper_is_shared_and_extends(monkeypatch):
    """The list endpoint and the PR-detail endpoint call the SAME _checks_rollup helper.

    Default (include_runs=False) => the four-count chip, NO 'runs' key (what the list
    endpoint reads). include_runs=True => the same counts PLUS a freshly-built 'runs'
    list. Each call builds a NEW dict, so the two callers never share mutable state — the
    detail route can safely add 'runs' without the list route ever seeing it. Guards
    against a future refactor that returns a shared/module-level dict."""
    def fake_get(path, token):
        if path.endswith("/status"):
            return {"statuses": [{"state": "success", "context": "ci",
                                  "target_url": "http://x"}]}
        if path.endswith("/check-runs"):
            return {"check_runs": [{"name": "test", "status": "completed",
                                    "conclusion": "failure", "html_url": "http://y"}]}
        raise AssertionError(path)

    monkeypatch.setattr(hub, "_gh_get", fake_get)
    counts_only = hub._checks_rollup("acme/site", "sha1", "tok")
    with_runs = hub._checks_rollup("acme/site", "sha1", "tok", include_runs=True)

    # same math on both surfaces
    assert counts_only == {"passed": 1, "failing": 1, "pending": 0, "total": 2}
    assert "runs" not in counts_only                 # list-endpoint shape unchanged
    assert with_runs["passed"] == 1 and with_runs["failing"] == 1
    assert len(with_runs["runs"]) == 2               # status context + check run
    # distinct objects: mutating one rollup must not bleed into the other (no shared dict)
    counts_only["passed"] = 999
    assert with_runs["passed"] == 1


# ------------------------- issue detail: shape + comments ordering --------------------

async def test_issue_detail_shape_and_comments_oldest_first(
        client, container, token_env, monkeypatch):
    cid = container["id"]
    await _bind_repo(client, cid)

    def fake_get(path, token):
        assert token == "ghs_hubtoken"
        if path == "/repos/acme/site/issues/7":
            return {
                "number": 7, "title": "Bug: crash", "state": "open",
                "body": "steps to repro",
                "user": {"login": "reporter"},
                "labels": [{"name": "bug", "color": "d73a4a"}, {"name": "p1", "color": "e99695"}],
                "assignee": {"login": "octocat"},
                "assignees": [{"login": "octocat"}, {"login": "hubot"}],
                "updated_at": "2026-07-03T00:00:00Z",
                "created_at": "2026-07-01T00:00:00Z",
                "html_url": "https://github.com/acme/site/issues/7",
                "comments": 2,
            }
        # We ask newest-first; the route re-orders to oldest-first for display.
        if path == ("/repos/acme/site/issues/7/comments"
                    "?per_page=20&sort=created&direction=desc"):
            return [
                {"user": {"login": "b"}, "body": "second (newer)",
                 "created_at": "2026-07-02T00:00:00Z"},
                {"user": {"login": "a"}, "body": "first (older)",
                 "created_at": "2026-07-01T00:00:00Z"},
            ]
        raise AssertionError(f"unexpected path {path}")

    monkeypatch.setattr(hub, "_gh_get", fake_get)
    r = await client.get(f"/api/containers/{cid}/github/issues/7")
    assert r.status_code == 200, r.text
    issue = r.json()["issue"]
    assert issue["number"] == 7 and issue["title"] == "Bug: crash"
    assert issue["state"] == "open"
    assert issue["body_markdown"] == "steps to repro"   # RAW markdown
    assert issue["author_login"] == "reporter"
    assert issue["labels"] == [{"name": "bug", "color": "d73a4a"}, {"name": "p1", "color": "e99695"}]
    assert issue["assignee"] == "octocat"
    assert issue["assignees"] == ["octocat", "hubot"]
    assert issue["created_at"] == "2026-07-01T00:00:00Z"
    assert issue["updated_at"] == "2026-07-03T00:00:00Z"
    assert issue["html_url"] == "https://github.com/acme/site/issues/7"
    assert issue["comments_count"] == 2
    # comments re-ordered oldest-first, each carrying RAW body_markdown
    assert issue["comments"] == [
        {"author_login": "a", "body_markdown": "first (older)",
         "created_at": "2026-07-01T00:00:00Z"},
        {"author_login": "b", "body_markdown": "second (newer)",
         "created_at": "2026-07-02T00:00:00Z"},
    ]


# ------------------------- not_found path (both detail endpoints) ---------------------

async def test_pull_detail_not_found(client, container, token_env, monkeypatch):
    """A GitHub 404 on the PR number -> {available:false, reason:'not_found'} (distinct
    from the list endpoint's repo-not-connected treatment of 404)."""
    cid = container["id"]
    await _bind_repo(client, cid)
    monkeypatch.setattr(hub, "_gh_get",
                        lambda p, t: (_ for _ in ()).throw(RuntimeError("github_status:404")))
    r = await client.get(f"/api/containers/{cid}/github/pulls/999")
    assert r.status_code == 200  # graceful, never a 5xx
    body = r.json()
    assert body["available"] is False and body["reason"] == "not_found"
    assert body["repo"] == "acme/site"


async def test_issue_detail_not_found(client, container, token_env, monkeypatch):
    cid = container["id"]
    await _bind_repo(client, cid)
    monkeypatch.setattr(hub, "_gh_get",
                        lambda p, t: (_ for _ in ()).throw(RuntimeError("github_status:404")))
    r = await client.get(f"/api/containers/{cid}/github/issues/999")
    assert r.json()["reason"] == "not_found"


async def test_detail_rate_limited_403(client, container, token_env, monkeypatch):
    """403 still maps to rate_limited on the detail routes (shared mapping)."""
    cid = container["id"]
    await _bind_repo(client, cid)
    monkeypatch.setattr(hub, "_gh_get",
                        lambda p, t: (_ for _ in ()).throw(RuntimeError("github_status:403")))
    r = await client.get(f"/api/containers/{cid}/github/pulls/1")
    assert r.json()["reason"] == "rate_limited"


# ------------------------- repo not connected (detail) --------------------------------

async def test_pull_detail_repo_not_connected(client, container):
    r = await client.get(f"/api/containers/{container['id']}/github/pulls/1")
    assert r.status_code == 200
    assert r.json()["reason"] == "repo_not_connected"


async def test_issue_detail_repo_not_connected(client, container):
    r = await client.get(f"/api/containers/{container['id']}/github/issues/1")
    assert r.json()["reason"] == "repo_not_connected"


async def test_detail_bad_cid_400_and_unknown_404(client):
    r = await client.get("/api/containers/not-a-uuid/github/pulls/1")
    assert r.status_code == 400
    r = await client.get(f"/api/containers/{uuid.uuid4()}/github/issues/1")
    assert r.status_code == 404


# ------------------------- cache TTL (detail keyed per number) ------------------------

async def test_pull_detail_cached_per_number(client, container, token_env, monkeypatch):
    """Detail cache is keyed per (cid,'pull',number): repeat reads of the SAME number are
    served from cache; a DIFFERENT number is a distinct key (its own GitHub fetch); past
    the 60s TTL GitHub is hit again."""
    cid = container["id"]
    await _bind_repo(client, cid)
    calls = {"n": 0}

    def fake_get(path, token):
        calls["n"] += 1
        num = int(path.rsplit("/", 1)[1]) if path.startswith("/repos/acme/site/pulls/") \
            and "commits" not in path and "files" not in path else 12
        pr = _pr_object(num)
        pr["head"] = {"ref": "x", "sha": None}  # no sha -> skip the checks fetches
        if "/files" in path:
            return []
        return pr

    monkeypatch.setattr(hub, "_gh_get", fake_get)

    await client.get(f"/api/containers/{cid}/github/pulls/12")
    n_after_first = calls["n"]
    await client.get(f"/api/containers/{cid}/github/pulls/12")
    assert calls["n"] == n_after_first  # second read of #12 served from cache

    # A different number is a separate cache key -> a fresh fetch happens.
    await client.get(f"/api/containers/{cid}/github/pulls/13")
    assert calls["n"] > n_after_first

    # Advance past the TTL -> #12 is fetched again.
    before_ttl = calls["n"]
    base = hub.time.monotonic()
    monkeypatch.setattr(hub.time, "monotonic", lambda: base + hub.CACHE_TTL_SECONDS + 1)
    await client.get(f"/api/containers/{cid}/github/pulls/12")
    assert calls["n"] > before_ttl


async def test_start_invalidates_detail_cache(client, container, token_env, monkeypatch):
    """POST /start drops EVERY cache entry for the container — including detail keys — so a
    freshly tracked item's next detail read reflects any state change."""
    cid = container["id"]
    await _bind_repo(client, cid)
    calls = {"n": 0}

    def fake_get(path, token):
        calls["n"] += 1
        pr = _pr_object(5)
        pr["head"] = {"ref": "x", "sha": None}
        if "/files" in path:
            return []
        return pr

    monkeypatch.setattr(hub, "_gh_get", fake_get)
    await client.get(f"/api/containers/{cid}/github/pulls/5")
    cached_calls = calls["n"]
    await client.get(f"/api/containers/{cid}/github/pulls/5")
    assert calls["n"] == cached_calls  # cached

    # Start a task -> cache invalidated -> next detail read re-fetches.
    r = await client.post(f"/api/containers/{cid}/github/start",
                          json={"kind": "pull", "number": 5, "title": "x"})
    assert r.status_code == 201, r.text
    await client.get(f"/api/containers/{cid}/github/pulls/5")
    assert calls["n"] > cached_calls


# ------------------------- grant enforcement (detail reads) ---------------------------

async def test_pull_detail_trusted_non_member_403(
        client, container, make_agent, trust_proxy):
    """The detail GETs use the same project-isolation read gate as the list GETs: under
    proxy trust, a non-member of a mapped container is refused (require_member_read)."""
    cid = container["id"]
    await _bind_owner(client, container, make_agent)  # container now mapped to octocat
    r = await client.get(f"/api/containers/{cid}/github/pulls/1", headers=MALLORY)
    assert r.status_code == 403, r.text


async def test_issue_detail_trusted_member_ok(
        client, container, make_agent, trust_proxy, token_env, monkeypatch):
    cid = container["id"]
    await _bind_owner(client, container, make_agent)
    await _bind_repo(client, cid)
    monkeypatch.setattr(hub, "_gh_get", lambda p, t: {
        "number": 1, "title": "x", "state": "open", "body": "", "user": {"login": "octocat"},
        "labels": [], "assignee": None, "assignees": [], "comments": 0,
    } if "/comments" not in p else [])
    r = await client.get(f"/api/containers/{cid}/github/issues/1", headers=OCTO)
    assert r.status_code == 200, r.text
    assert r.json()["available"] is True


# ===================================================================================
# PR "Fix" dispatch: context-aware DoD (founder decision) — _fix_description is a pure
# compose-from-already-fetched-shapes function; _pull_fix_context is the one PR + one
# checks-rollup fetch that feeds it. Unit tests below pin the pure compose function
# directly (fixture PRs: failing-checks-only / comments-only / conflicts / all-clean);
# the integration test at the bottom exercises the full POST /github/start route with
# _gh_get stubbed, proving the route actually wires the live re-fetch into the created
# task's definition_of_done.
# ===================================================================================

def _fix_ctx(**overrides):
    """A fully-specified, all-clean _fix_description kwargs dict — no failing/pending
    checks, no review comments, not draft, mergeable_state clean. Each test overrides
    only the field(s) it's pinning, so every fixture stays obviously scoped to the ONE
    clause it's proving/disproving."""
    base = dict(
        number=42, title="Fix retry backoff", head="fix/retry-backoff", draft=False,
        mergeable_state="clean",
        checks={"passed": 3, "failing": 0, "pending": 0, "total": 3, "runs": [
            {"name": "build", "status": "completed", "conclusion": "success"},
        ]},
        review_comments_count=0, comments_count=0,
    )
    base.update(overrides)
    return base


def test_fix_description_all_clean_uses_generic_fallback():
    """Nothing outstanding -> the generic fallback sentence, never an empty
    'Outstanding: .' line."""
    desc = hub._fix_description(**_fix_ctx())
    assert "Fix PR #42: Fix retry backoff." in desc
    assert "review the pr's feedback and ci state and address anything outstanding" in desc.lower()
    assert "Outstanding:" not in desc
    assert "Push fixes to its branch fix/retry-backoff" in desc
    assert "Never merge; stop for human review." in desc
    assert "draft" not in desc.lower()


def test_fix_description_failing_checks_only_lists_names():
    """Failing-checks-only fixture: names the failing runs, omits every other clause
    (no pending/review/conflict text leaking in)."""
    ctx = _fix_ctx(checks={
        "passed": 1, "failing": 2, "pending": 0, "total": 3,
        "runs": [
            {"name": "lint", "status": "completed", "conclusion": "failure"},
            {"name": "unit-tests", "status": "completed", "conclusion": "failure"},
            {"name": "build", "status": "completed", "conclusion": "success"},
        ],
    })
    desc = hub._fix_description(**ctx)
    assert "Outstanding: 2 failing checks: lint, unit-tests." in desc
    assert "pending" not in desc.lower()
    assert "review comment" not in desc.lower()
    assert "conflict" not in desc.lower()


def test_fix_description_failing_checks_caps_named_list_at_five():
    """A PR with many failing checks names only the first 5 and summarizes the rest as
    '+N more' rather than dumping an unbounded list into the DoD."""
    runs = [{"name": f"job-{i}", "status": "completed", "conclusion": "failure"}
            for i in range(8)]
    ctx = _fix_ctx(checks={"passed": 0, "failing": 8, "pending": 0, "total": 8, "runs": runs})
    desc = hub._fix_description(**ctx)
    assert "8 failing checks: job-0, job-1, job-2, job-3, job-4, +3 more." in desc


def test_fix_description_pending_checks_count_only_no_names():
    """Pending checks are mentioned by COUNT only — GitHub hasn't told us an outcome
    yet, so there's nothing more specific to name."""
    ctx = _fix_ctx(checks={
        "passed": 1, "failing": 0, "pending": 3, "total": 4,
        "runs": [{"name": "e2e", "status": "in_progress", "conclusion": None}],
    })
    desc = hub._fix_description(**ctx)
    assert "3 checks still pending" in desc
    assert "e2e" not in desc   # no per-check naming for pending, unlike failing


def test_fix_description_comments_only_uses_review_proxy():
    """Unresolved-review-feedback-only fixture: review_comments_count + comments_count
    sums into the 'review comments to address' clause; checks/conflict clauses absent."""
    ctx = _fix_ctx(review_comments_count=4, comments_count=2)
    desc = hub._fix_description(**ctx)
    assert "Outstanding: 6 review comments to address." in desc
    assert "failing" not in desc.lower()
    assert "conflict" not in desc.lower()


def test_fix_description_singular_wording_for_count_of_one():
    """Mutation-guard for the singular/plural branch: count==1 must not read '1 checks'
    or '1 review comments'."""
    desc_check = hub._fix_description(**_fix_ctx(checks={
        "passed": 0, "failing": 1, "pending": 0, "total": 1,
        "runs": [{"name": "lint", "status": "completed", "conclusion": "failure"}],
    }))
    assert "1 failing check:" in desc_check and "1 failing checks:" not in desc_check
    desc_review = hub._fix_description(**_fix_ctx(review_comments_count=1, comments_count=0))
    assert "1 review comment to address" in desc_review and "1 review comments" not in desc_review


def test_fix_description_conflicts_only_mentions_rebase():
    """mergeable_state:'dirty' -> the merge-conflicts clause fires, naming rebase/conflict
    resolution explicitly (per the founder's template shape)."""
    desc = hub._fix_description(**_fix_ctx(mergeable_state="dirty"))
    assert "merge conflicts with base" in desc.lower()
    assert "rebase" in desc.lower() or "resolve conflicts" in desc.lower()
    assert "failing" not in desc.lower()


def test_fix_description_non_dirty_mergeable_states_omit_conflict_clause():
    """Mutation-guard: only 'dirty' triggers the conflict clause — 'blocked'/'unstable'/
    'unknown'/None must NOT (those mean something else in GitHub's vocabulary, not
    'has conflicts with base')."""
    for state in ("blocked", "unstable", "unknown", None, "behind"):
        desc = hub._fix_description(**_fix_ctx(mergeable_state=state))
        assert "conflict" not in desc.lower(), f"mergeable_state={state!r} wrongly triggered the conflict clause"


def test_fix_description_draft_note_is_prefixed_not_folded_into_outstanding():
    """draft:true adds its own note distinct from the 'Outstanding:' clause list (a draft
    PR isn't 'outstanding work to fix' so much as 'not ready yet')."""
    desc = hub._fix_description(**_fix_ctx(draft=True))
    assert "This PR is a draft." in desc
    assert "Outstanding:" not in desc   # still all-clean otherwise -> generic fallback


def test_fix_description_combines_multiple_outstanding_clauses():
    """All four signals present at once: every clause shows up, semicolon-joined, in a
    single Outstanding: sentence — proves the clauses compose rather than only ever
    firing one at a time."""
    ctx = _fix_ctx(
        draft=False, mergeable_state="dirty",
        checks={"passed": 0, "failing": 1, "pending": 2, "total": 3,
                "runs": [{"name": "lint", "status": "completed", "conclusion": "failure"}]},
        review_comments_count=1, comments_count=0,
    )
    desc = hub._fix_description(**ctx)
    assert "1 failing check: lint" in desc
    assert "2 checks still pending" in desc
    assert "1 review comment to address" in desc
    assert "merge conflicts with base" in desc.lower()
    # semicolon-joined, single sentence
    assert desc.count("Outstanding:") == 1


def test_fix_description_always_names_the_head_branch_and_never_merge_footer():
    """The 'push to branch' + 'never merge, stop for human review' footer is unconditional
    — present regardless of what's outstanding (or not)."""
    for ctx in (_fix_ctx(), _fix_ctx(mergeable_state="dirty"), _fix_ctx(draft=True)):
        desc = hub._fix_description(**ctx)
        assert "Push fixes to its branch fix/retry-backoff." in desc
        assert "Never merge; stop for human review." in desc


# ------------------ PR "Fix" dispatch: Orcha's OWN comments are not feedback -----------
#
# Production defect, fixed here: every dispatch posts a "🤖 Orcha started task ..."
# comment back on the PR (task_start_core._post_start_comment), and GitHub counts it in
# the PR object's `comments`. _pull_fix_context read that count raw, so a SECOND Fix
# click on the same PR handed the agent "1 review comment to address" — Orcha's own
# note, read back as human feedback. The fix nets Orcha-authored comments out of the
# count; the status comment itself stays (humans watching the PR want it).

def _orcha_comment(task_id="8dca38b5", assignee="Atlas"):
    """A comment shaped exactly as task_start_core._compose_start_comment writes it —
    built through the real composer, so this fixture can never drift from production."""
    return {"body": core._compose_start_comment(task_id, assignee),
            "user": {"login": "orcha-cloud[bot]", "type": "Bot"}}


def test_orcha_authored_comment_recognises_the_real_composed_body():
    """The recogniser is pinned against the ACTUAL composer output (both the assigned
    and the unassigned wording), not a hand-copied string."""
    assert hub._orcha_authored_comment(_orcha_comment()) is True
    assert hub._orcha_authored_comment(
        {"body": core._compose_start_comment("abc12345", None)}) is True


def test_orcha_authored_comment_leaves_human_feedback_alone():
    """Human comments — including one that MENTIONS Orcha, and one that quotes the
    marker after a '>' quote marker — are feedback and must still count."""
    for body in ("please add a test for the 429 path",
                 "Orcha started task on this? looks stale",
                 "> 🤖 Orcha started task `abc12345`\n\nthis never finished, please redo",
                 ""):
        assert hub._orcha_authored_comment({"body": body}) is False
    assert hub._orcha_authored_comment({}) is False   # no body key at all


def test_orcha_comment_count_nets_only_orcha_notes(monkeypatch):
    """Two Orcha notes + one human comment on a 3-comment PR -> 2 netted out."""
    def fake_get(path, token):
        assert path == "/repos/acme/site/issues/5/comments?per_page=100&page=1"
        return [_orcha_comment("aaaaaaaa"), {"body": "nit: rename this"},
                _orcha_comment("bbbbbbbb")]

    monkeypatch.setattr(hub, "_gh_get", fake_get)
    assert hub._orcha_comment_count("acme/site", 5, "tok", 3) == 2


def test_orcha_comment_count_pages_and_stops_at_the_cap(monkeypatch):
    """A pathological thread is walked at 100/page and STOPS at _FIX_COMMENT_PAGE_CAP —
    one Fix click can never fan out into unbounded GitHub calls."""
    seen = []

    def fake_get(path, token):
        seen.append(path)
        return [_orcha_comment()] * 100   # always a full page -> keep asking

    monkeypatch.setattr(hub, "_gh_get", fake_get)
    counted = hub._orcha_comment_count("acme/site", 5, "tok", 10_000)
    assert len(seen) == hub._FIX_COMMENT_PAGE_CAP
    assert seen[-1].endswith(f"page={hub._FIX_COMMENT_PAGE_CAP}")
    assert counted == 100 * hub._FIX_COMMENT_PAGE_CAP


def test_orcha_comment_count_stops_early_on_a_short_page(monkeypatch):
    """A page shorter than 100 is the last one — no speculative page-2 call."""
    seen = []

    def fake_get(path, token):
        seen.append(path)
        return [_orcha_comment()]

    monkeypatch.setattr(hub, "_gh_get", fake_get)
    assert hub._orcha_comment_count("acme/site", 5, "tok", 400) == 1
    assert len(seen) == 1


def test_orcha_comment_count_degrades_to_zero_when_the_fetch_fails(monkeypatch):
    """A rate-limited/unreachable comment fetch must NOT fail the Fix dispatch — it
    under-counts (exactly the pre-fix behaviour), never raises."""
    def fake_get(path, token):
        raise RuntimeError("github_status:403")

    monkeypatch.setattr(hub, "_gh_get", fake_get)
    assert hub._orcha_comment_count("acme/site", 5, "tok", 3) == 0


def _fix_context_get(*, comments: int, review_comments: int, comment_bodies):
    """A _gh_get stub for _pull_fix_context on acme/site#77: an all-clean PR carrying
    the given comment counts, plus the conversation-comment page behind them."""
    def fake_get(path, token):
        if path == "/repos/acme/site/pulls/77":
            return {"number": 77, "title": "Add retry", "draft": False,
                    "mergeable_state": "clean", "head": {"ref": "feat/retry", "sha": "abc123"},
                    "review_comments": review_comments, "comments": comments}
        if path == "/repos/acme/site/commits/abc123/status":
            return {"statuses": []}
        if path == "/repos/acme/site/commits/abc123/check-runs":
            return {"check_runs": []}
        if path == "/repos/acme/site/issues/77/comments?per_page=100&page=1":
            return comment_bodies
        raise AssertionError(f"unexpected path {path}")
    return fake_get


def test_pull_fix_context_nets_orchas_own_comment_out_of_the_count(monkeypatch):
    """THE regression: a PR whose only conversation comment is Orcha's own start note
    reports comments_count 0 — so the second Fix click's DoD has no phantom feedback."""
    monkeypatch.setattr(hub, "_gh_get", _fix_context_get(
        comments=1, review_comments=0, comment_bodies=[_orcha_comment()]))
    ctx = hub._pull_fix_context("acme/site", 77, "tok")
    assert ctx["comments_count"] == 0
    assert "review comment" not in hub._fix_description(**ctx)


def test_pull_fix_context_keeps_real_feedback_when_orcha_also_commented(monkeypatch):
    """Mixed thread: Orcha's note is netted out, the two human comments survive — the
    fix must not swing the other way and swallow genuine feedback."""
    monkeypatch.setattr(hub, "_gh_get", _fix_context_get(
        comments=3, review_comments=1, comment_bodies=[
            {"body": "nit: rename this"}, _orcha_comment(), {"body": "needs a test"}]))
    ctx = hub._pull_fix_context("acme/site", 77, "tok")
    assert ctx["comments_count"] == 2
    # 2 surviving conversation comments + 1 inline review comment
    assert "3 review comments to address" in hub._fix_description(**ctx)


def test_pull_fix_context_skips_the_comment_fetch_when_the_pr_has_none(monkeypatch):
    """comments == 0 -> nothing to net out -> ZERO extra GitHub calls. Pins that the
    fix costs nothing on the common case (the vast majority of Fix clicks)."""
    def fake_get(path, token):
        if "/issues/77/comments" in path:
            raise AssertionError("must not fetch comments for a PR with comments:0")
        return _fix_context_get(comments=0, review_comments=0, comment_bodies=[])(path, token)

    monkeypatch.setattr(hub, "_gh_get", fake_get)
    assert hub._pull_fix_context("acme/site", 77, "tok")["comments_count"] == 0


def test_pull_fix_context_leaves_inline_review_comments_unfiltered(monkeypatch):
    """review_comments (inline code-review, /pulls/{n}/comments) is passed through
    untouched — Orcha only ever posts to the conversation endpoint, so netting there
    could only ever drop a real reviewer's comment."""
    monkeypatch.setattr(hub, "_gh_get", _fix_context_get(
        comments=1, review_comments=4, comment_bodies=[_orcha_comment()]))
    ctx = hub._pull_fix_context("acme/site", 77, "tok")
    assert ctx["review_comments_count"] == 4
    assert "4 review comments to address" in hub._fix_description(**ctx)


# ------------------------- PR "Fix" dispatch: full route integration ------------------

async def test_start_pull_uses_context_aware_dod_from_live_state(
        client, container, token_env, monkeypatch):
    """POST /github/start (kind=pull) re-fetches the PR's live state and composes the
    context-aware DoD — NOT the generic static template — when a repo is bound and the
    live re-fetch succeeds."""
    cid = container["id"]
    await _bind_repo(client, cid)

    def fake_get(path, token):
        if path == "/repos/acme/site/pulls/77":
            return {"number": 77, "title": "Add retry", "draft": False,
                    "mergeable_state": "dirty", "head": {"ref": "feat/retry", "sha": "abc123"},
                    "review_comments": 2, "comments": 1}
        if path == "/repos/acme/site/commits/abc123/status":
            return {"statuses": []}
        if path == "/repos/acme/site/commits/abc123/check-runs":
            return {"check_runs": [
                {"name": "lint", "status": "completed", "conclusion": "failure",
                 "html_url": "http://x"},
            ]}
        # The PR reports comments:1, so the dispatch nets Orcha's own round-trip
        # comments out of that count — here the one comment is a real human's, so
        # the netting is a no-op and all 3 still land in the DoD.
        if path == "/repos/acme/site/issues/77/comments?per_page=100&page=1":
            return [{"body": "please add a test for the 429 path",
                     "user": {"login": "kedar1607"}}]
        raise AssertionError(f"unexpected path {path}")

    monkeypatch.setattr(hub, "_gh_get", fake_get)
    r = await client.post(f"/api/containers/{cid}/github/start",
                          json={"kind": "pull", "number": 77, "title": "stale frontend title"})
    assert r.status_code == 201, r.text
    tid = r.json()["task_id"]
    listed = (await client.get(f"/api/containers/{cid}/tasks")).json()["tasks"]
    t = [x for x in listed if x["id"] == tid][0]
    dod = t["definition_of_done"]
    assert "1 failing check: lint" in dod
    assert "3 review comments to address" in dod   # review_comments(2) + comments(1)
    assert "merge conflicts with base" in dod.lower()
    assert "fix/retry-backoff" not in dod   # NOT the frontend-supplied stale field
    assert "feat/retry" in dod              # the LIVE re-fetched head branch
    assert "Resolve CI failures / review feedback on PR #77" not in dod   # not the generic template


async def test_start_pull_does_not_report_orchas_own_comment_as_feedback(
        client, container, token_env, monkeypatch):
    """End-to-end shape of the reported defect: the PR's only conversation comment is
    the "🤖 Orcha started task ..." note a PREVIOUS Fix dispatch posted. The DoD this
    dispatch writes must not contain a review-comment clause at all — the agent must
    not be sent to address Orcha's own status note."""
    cid = container["id"]
    await _bind_repo(client, cid)

    def fake_get(path, token):
        if path == "/repos/acme/site/pulls/103":
            return {"number": 103, "title": "Add retry", "draft": False,
                    "mergeable_state": "clean", "head": {"ref": "feat/retry", "sha": "abc123"},
                    "review_comments": 0, "comments": 1}
        if path == "/repos/acme/site/commits/abc123/status":
            return {"statuses": []}
        if path == "/repos/acme/site/commits/abc123/check-runs":
            return {"check_runs": []}
        if path == "/repos/acme/site/issues/103/comments?per_page=100&page=1":
            return [_orcha_comment()]
        raise AssertionError(f"unexpected path {path}")

    monkeypatch.setattr(hub, "_gh_get", fake_get)
    r = await client.post(f"/api/containers/{cid}/github/start",
                          json={"kind": "pull", "number": 103})
    assert r.status_code == 201, r.text
    tid = r.json()["task_id"]
    listed = (await client.get(f"/api/containers/{cid}/tasks")).json()["tasks"]
    dod = [x for x in listed if x["id"] == tid][0]["definition_of_done"]
    assert "review comment" not in dod
    assert "Outstanding:" not in dod   # nothing else was wrong with this PR either
    assert "Fix PR #103: Add retry." in dod


async def test_start_pull_survives_a_failing_comment_fetch(
        client, container, token_env, monkeypatch):
    """If the netting fetch itself fails (rate limit), the dispatch still succeeds and
    still gets its context-aware DoD — it just falls back to the raw, un-netted count
    rather than losing the whole enrichment over a nicety."""
    cid = container["id"]
    await _bind_repo(client, cid)

    def fake_get(path, token):
        if "/issues/103/comments" in path:
            raise RuntimeError("github_status:403")
        if path == "/repos/acme/site/pulls/103":
            return {"number": 103, "title": "Add retry", "draft": False,
                    "mergeable_state": "clean", "head": {"ref": "feat/retry", "sha": "abc123"},
                    "review_comments": 0, "comments": 2}
        if path == "/repos/acme/site/commits/abc123/status":
            return {"statuses": []}
        if path == "/repos/acme/site/commits/abc123/check-runs":
            return {"check_runs": []}
        raise AssertionError(f"unexpected path {path}")

    monkeypatch.setattr(hub, "_gh_get", fake_get)
    r = await client.post(f"/api/containers/{cid}/github/start",
                          json={"kind": "pull", "number": 103})
    assert r.status_code == 201, r.text
    tid = r.json()["task_id"]
    listed = (await client.get(f"/api/containers/{cid}/tasks")).json()["tasks"]
    dod = [x for x in listed if x["id"] == tid][0]["definition_of_done"]
    assert "2 review comments to address" in dod   # un-netted, but the dispatch lived
    assert "feat/retry" in dod


async def test_start_pull_idempotent_skips_live_refetch(
        client, container, token_env, monkeypatch):
    """The idempotency short-circuit (an already-open GH task for this number) must skip
    the live re-fetch entirely — a re-click on an already-tracked PR costs zero extra
    GitHub calls. A REAL token is configured for BOTH calls here (token_env, unlike a
    variant that stubs _resolve_repo_token to None) so a passing test can only mean the
    `not find_open_gh_task(...)` guard itself did the skipping — not a token-resolution
    short-circuit masking it. Mutation note: dropping that guard makes this test fail,
    since the second call's _gh_get stub raises on ANY invocation."""
    cid = container["id"]
    await _bind_repo(client, cid)
    calls = {"n": 0}

    def fake_get(path, token):
        calls["n"] += 1
        raise AssertionError(f"unexpected _gh_get call: {path}")

    monkeypatch.setattr(hub, "_gh_get", fake_get)

    # Seed an "already open" pull task for #88 directly via find_open_gh_task's own
    # idempotency key (title LIKE 'GH #88: %', a non-terminal status) using the plain
    # task-creation API — deliberately NOT routing a real pull start through first,
    # since that would exercise the untested code path (and cost a _gh_get call the
    # stub above would reject).
    seeded = await client.post(f"/api/containers/{cid}/tasks", json={
        "title": "GH #88: seed", "description": "", "definition_of_done": "x",
    })
    assert seeded.status_code == 201, seeded.text
    assert calls["n"] == 0

    # NOW the real assertion: a pull start for #88 with a WORKING token configured must
    # see existing:true and NEVER call _gh_get — the idempotency guard, not a disabled
    # token, is what prevents the live re-fetch.
    r2 = await client.post(f"/api/containers/{cid}/github/start",
                           json={"kind": "pull", "number": 88, "title": "x"})
    assert r2.status_code == 201, r2.text
    assert r2.json()["existing"] is True
    assert calls["n"] == 0


async def test_start_pull_degrades_to_generic_dod_when_live_refetch_fails(
        client, container, token_env, monkeypatch):
    """If the live re-fetch itself fails (rate limit / repo unreachable), the Start click
    still succeeds — falling back to the generic static DoD rather than failing the
    whole dispatch over a context-enrichment nicety."""
    cid = container["id"]
    await _bind_repo(client, cid)

    def fake_get(path, token):
        raise RuntimeError("github_status:403")

    monkeypatch.setattr(hub, "_gh_get", fake_get)
    r = await client.post(f"/api/containers/{cid}/github/start",
                          json={"kind": "pull", "number": 99, "title": "x"})
    assert r.status_code == 201, r.text
    tid = r.json()["task_id"]
    listed = (await client.get(f"/api/containers/{cid}/tasks")).json()["tasks"]
    t = [x for x in listed if x["id"] == tid][0]
    assert "Resolve CI failures / review feedback on PR #99" in t["definition_of_done"]


async def test_start_issue_dispatch_never_triggers_pr_context_refetch(
        client, container, token_env, monkeypatch):
    """Mutation-guard: the CONTEXT-AWARE re-fetch (_pull_fix_context — checks rollup,
    review-comment count, draft/mergeable_state, for the PR-specific DoD) is PR-only
    (kind=pull) — an issue dispatch must never hit the pulls/checks endpoints, since
    issues keep their original generic DoD template unchanged.

    NOTE: this does NOT mean issue dispatch makes no GitHub call at all — see
    test_start_issue_dispatch_authoritative_title_overrides_client_supplied_title
    below for the separate, BOTH-kinds authoritative-title fetch
    (github_hub_routes._fetch_gh_item) added after the production title-loss defect.
    This test only pins that the ISSUES endpoint (not pulls/checks) is what gets hit."""
    cid = container["id"]
    await _bind_repo(client, cid)

    def fake_get(path, token):
        if "/pulls/" in path or "/check-runs" in path or "/commits/" in path:
            raise AssertionError(f"issue dispatch must never touch PR/checks endpoints: {path}")
        return {"number": 100, "title": "Real issue title",
                "html_url": "https://github.com/acme/site/issues/100", "body": ""}

    monkeypatch.setattr(hub, "_gh_get", fake_get)
    r = await client.post(f"/api/containers/{cid}/github/start",
                          json={"kind": "issue", "number": 100, "title": "x"})
    assert r.status_code == 201, r.text


# ------------------------- POST /start: authoritative server-side title fetch -------------------------
#
# Production defect, fixed here: the hub frontend's OWN postStart() call (now
# frontend/src/cloud/github/GitHubPage.tsx; the vanilla static/pages/github-render.js
# at the time) never actually sends title/body_excerpt/html_url —
# despite GithubStartBody's docstring assuming it does — so EVERY hub-started task
# (issue or pull) was landing titled bare "GH #<N>:" with nothing after. The fix:
# both dispatch kinds now live-fetch the real title/body/url server-side
# (github_hub_routes._fetch_gh_item, the same function the Slack seam already used)
# BEFORE composing the task; the client-supplied body.title/body_excerpt/html_url
# fields are used ONLY as the fallback when that live fetch itself fails.

async def test_start_issue_dispatch_authoritative_title_overrides_client_supplied_title(
        client, container, token_env, monkeypatch):
    """The exact regression shape: the request carries NO title (or a blank one, as
    the real frontend's postStart() sends) — the server's own live fetch supplies the
    real title regardless."""
    cid = container["id"]
    await _bind_repo(client, cid)
    monkeypatch.setattr(hub, "_gh_get", _fake_issue_get(150, "Real title from GitHub"))

    # EXACTLY the body the real frontend sends (postStart in the React hub,
    # frontend/src/cloud/github/GitHubPage.tsx) — no title/body_excerpt/html_url at
    # all, only what GithubStartBody makes optional.
    r = await client.post(f"/api/containers/{cid}/github/start",
                          json={"kind": "issue", "number": 150, "assignee_agent_id": None})
    assert r.status_code == 201, r.text
    tid = r.json()["task_id"]
    listed = (await client.get(f"/api/containers/{cid}/tasks")).json()["tasks"]
    t = [x for x in listed if x["id"] == tid][0]
    assert t["title"] == "GH #150: Real title from GitHub"
    assert t["title"] != "GH #150:"  # the exact production bug shape


async def test_start_pull_dispatch_authoritative_title_overrides_client_supplied_title(
        client, container, token_env, monkeypatch):
    """SAME regression, PR-kind — the founder's actual production report (GH #220
    rendering as bare 'GH #220:')."""
    cid = container["id"]
    await _bind_repo(client, cid)

    def fake_get(path, token):
        if path == f"/repos/acme/site/pulls/220":
            return {"number": 220, "title": "Real PR title from GitHub",
                    "html_url": "https://github.com/acme/site/pulls/220", "body": "",
                    "head": {"ref": "fix-branch", "sha": "abc123"},
                    "draft": False, "mergeable_state": "clean",
                    "review_comments": 0, "comments": 0}
        if "/check-runs" in path or "/commits/" in path:
            return {"total_count": 0, "check_runs": []}
        raise AssertionError(f"unexpected _gh_get call: {path}")

    monkeypatch.setattr(hub, "_gh_get", fake_get)

    # EXACTLY the body the real frontend sends — no title/body_excerpt/html_url.
    r = await client.post(f"/api/containers/{cid}/github/start",
                          json={"kind": "pull", "number": 220, "assignee_agent_id": None})
    assert r.status_code == 201, r.text
    tid = r.json()["task_id"]
    listed = (await client.get(f"/api/containers/{cid}/tasks")).json()["tasks"]
    t = [x for x in listed if x["id"] == tid][0]
    assert t["title"] == "GH #220: Real PR title from GitHub"
    assert t["title"] != "GH #220:"  # the exact production bug shape


async def test_start_dispatch_falls_back_to_client_title_when_live_fetch_fails(
        client, container, token_env, monkeypatch):
    """The live fetch failing (rate-limited / 404 / network) must never break the
    Start click — it degrades to whatever title the CLIENT supplied (or the bare
    '#N' placeholder task_start_core itself falls back to when even that's blank),
    exactly like the Slack seam's own degraded-fallback contract."""
    cid = container["id"]
    await _bind_repo(client, cid)

    def boom(path, token):
        raise RuntimeError("github_status:403")

    monkeypatch.setattr(hub, "_gh_get", boom)
    r = await client.post(f"/api/containers/{cid}/github/start",
                          json={"kind": "issue", "number": 909, "title": "Client-supplied fallback title"})
    assert r.status_code == 201, r.text
    tid = r.json()["task_id"]
    listed = (await client.get(f"/api/containers/{cid}/tasks")).json()["tasks"]
    t = [x for x in listed if x["id"] == tid][0]
    assert t["title"] == "GH #909: Client-supplied fallback title"


async def test_start_issue_vs_slack_start_same_number_same_authoritative_title(
        client, container, make_agent, db, monkeypatch, token_env):
    """Cross-path title parity: the hub's OWN authoritative fetch and the Slack seam's
    (pre-existing) authoritative fetch must land on the IDENTICAL title for the same
    GitHub issue — both now go through the SAME github_hub_routes._fetch_gh_item,
    so they structurally cannot drift."""
    import hashlib
    import hmac
    import time
    import urllib.parse

    cid = container["id"]
    await _bind_repo(client, cid)
    real_title = "Parity-checked title"
    monkeypatch.setattr(hub, "_gh_get", _fake_issue_get(300, real_title))

    hub_r = await client.post(f"/api/containers/{cid}/github/start",
                              json={"kind": "issue", "number": 300})
    assert hub_r.status_code == 201, hub_r.text

    c2 = await client.post("/api/containers", json={"name": "slack-parity", "additional": True})
    assert c2.status_code == 201, c2.text
    cid2 = c2.json()["container_id"]
    await client.put(f"/api/containers/{cid2}/github", json={"repo": "acme/site"})
    agent = await make_agent("ops", kind="human", container_id=cid2)
    db.execute("UPDATE agents SET slack_user_id=%s WHERE id=%s", ("U-parity", agent["agent_id"]))

    signing_secret = "shhh-parity-secret"
    monkeypatch.setenv("SLACK_SIGNING_SECRET", signing_secret)
    monkeypatch.setenv("SLACK_BOT_TOKEN", "xoxb-parity")
    ts = str(int(time.time()))
    slack_body = urllib.parse.urlencode({"user_id": "U-parity", "text": "start issue 300"})
    base = f"v0:{ts}:{slack_body}".encode()
    digest = hmac.new(signing_secret.encode(), base, hashlib.sha256).hexdigest()
    slack_r = await client.post(
        "/api/slack/commands", content=slack_body,
        headers={"X-Slack-Request-Timestamp": ts, "X-Slack-Signature": "v0=" + digest,
                "Content-Type": "application/x-www-form-urlencoded"},
    )
    assert slack_r.status_code == 200, slack_r.text

    hub_listed = (await client.get(f"/api/containers/{cid}/tasks")).json()["tasks"]
    slack_listed = (await client.get(f"/api/containers/{cid2}/tasks")).json()["tasks"]
    hub_t = [x for x in hub_listed if x["title"].startswith("GH #300:")][0]
    slack_t = [x for x in slack_listed if x["title"].startswith("GH #300:")][0]
    assert hub_t["title"] == slack_t["title"] == f"GH #300: {real_title}"


# ===================================================================================
# PR-list filtering + pagination (monorepo-scale repos): author= / involvement= / q=
# / page=/per_page= on GET .../github/pulls. ANY of author/involvement/q present ->
# GitHub's search API (/search/issues); otherwise the existing single-call list path,
# now also accepting page/per_page passthrough+clamp.
# ===================================================================================

def _search_page(items, total_count=None, incomplete=False):
    return {"total_count": total_count if total_count is not None else len(items),
            "incomplete_results": incomplete, "items": items}


def _search_pr_item(number, title="A PR", **extra):
    """One /search/issues item shaped as GitHub actually returns it for a PR — no
    head/base/checks/requested_reviewers (those live only on /pulls, not /issues)."""
    base = {
        "number": number, "title": title,
        "html_url": f"https://github.com/acme/site/pull/{number}",
        "updated_at": "2026-08-01T00:00:00Z",
        "draft": False,
        "pull_request": {"url": f"https://api.github.com/repos/acme/site/pulls/{number}"},
    }
    base.update(extra)
    return base


# ------------------------- plain path unchanged (no filter params) --------------------

async def test_pulls_plain_path_unchanged_no_search(client, container, token_env, monkeypatch):
    """No author/involvement/q -> the existing single /pulls list call; the search API
    is never touched. page/per_page default to 1/30 and are echoed back."""
    cid = container["id"]
    await _bind_repo(client, cid)
    calls = []

    def fake_get(path, token):
        calls.append(path)
        assert "/search/issues" not in path
        return [{
            "number": 12, "title": "Add feature", "draft": False,
            "updated_at": "2026-07-02T00:00:00Z",
            "html_url": "https://github.com/acme/site/pull/12",
            "head": {"ref": "feat/x", "sha": "deadbeef"},
            "requested_reviewers": [], "mergeable_state": "clean",
        }]

    monkeypatch.setattr(hub, "_gh_get", fake_get)
    r = await client.get(f"/api/containers/{cid}/github/pulls")
    assert r.status_code == 200, r.text
    body = r.json()
    assert len(calls) == 1
    assert body["available"] is True
    assert body["source"] == "list"
    assert body["page"] == 1 and body["per_page"] == 30
    assert body["total_count"] is None       # null on the list path
    assert body["has_more"] is False
    assert len(body["pulls"]) == 1


# ------------------------- page/per_page passthrough + clamp (list path) --------------

async def test_pulls_list_path_page_per_page_passthrough(client, container, token_env, monkeypatch):
    cid = container["id"]
    await _bind_repo(client, cid)
    calls = []

    def fake_get(path, token):
        calls.append(path)
        return []

    monkeypatch.setattr(hub, "_gh_get", fake_get)
    r = await client.get(f"/api/containers/{cid}/github/pulls?page=2&per_page=10")
    assert r.status_code == 200, r.text
    assert any("page=2" in c and "per_page=10" in c for c in calls)
    body = r.json()
    assert body["page"] == 2 and body["per_page"] == 10


async def test_pulls_per_page_clamped_to_max_50(client, container, token_env, monkeypatch):
    cid = container["id"]
    await _bind_repo(client, cid)
    calls = []

    def fake_get(path, token):
        calls.append(path)
        return []

    monkeypatch.setattr(hub, "_gh_get", fake_get)
    r = await client.get(f"/api/containers/{cid}/github/pulls?per_page=500")
    assert r.status_code == 200, r.text
    assert any("per_page=50" in c for c in calls)
    assert r.json()["per_page"] == 50


async def test_pulls_page_below_1_rejected(client, container, token_env):
    cid = container["id"]
    await _bind_repo(client, cid)
    r = await client.get(f"/api/containers/{cid}/github/pulls?page=0")
    assert r.status_code == 422


async def test_pulls_per_page_below_1_rejected(client, container, token_env):
    cid = container["id"]
    await _bind_repo(client, cid)
    r = await client.get(f"/api/containers/{cid}/github/pulls?per_page=0")
    assert r.status_code == 422


# ------------------------- search-path query assembly: author= -----------------------

async def test_pulls_author_filter_uses_search_api(client, container, token_env, monkeypatch):
    cid = container["id"]
    await _bind_repo(client, cid)
    calls = []

    def fake_get(path, token):
        calls.append(path)
        assert path.startswith("/search/issues?")
        return _search_page([_search_pr_item(21, author="octocat")])

    monkeypatch.setattr(hub, "_gh_get", fake_get)
    r = await client.get(f"/api/containers/{cid}/github/pulls?author=octocat")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["source"] == "search"
    assert len(calls) == 1
    call = calls[0]
    # q= carries repo scope + is:pr is:open + author:<login>, url-encoded
    import urllib.parse as up
    qs = up.parse_qs(up.urlsplit(call).query)
    assert qs["q"][0] == "repo:acme/site is:pr is:open author:octocat"
    assert qs["page"][0] == "1"
    assert qs["per_page"][0] == "30"


async def test_pulls_author_match_is_case_insensitive_passthrough(client, container, token_env, monkeypatch):
    """author= is passed through to GitHub's own author: qualifier (GitHub's search is
    itself case-insensitive on logins) — the route does not lowercase/reshape it."""
    cid = container["id"]
    await _bind_repo(client, cid)
    seen = {}

    def fake_get(path, token):
        seen["path"] = path
        return _search_page([])

    monkeypatch.setattr(hub, "_gh_get", fake_get)
    r = await client.get(f"/api/containers/{cid}/github/pulls?author=OctoCAT")
    assert r.status_code == 200, r.text
    import urllib.parse as up
    qs = up.parse_qs(up.urlsplit(seen["path"]).query)
    assert "author:OctoCAT" in qs["q"][0]


# ------------------------- search-path query assembly: q= ----------------------------

async def test_pulls_q_filter_uses_search_api(client, container, token_env, monkeypatch):
    cid = container["id"]
    await _bind_repo(client, cid)

    def fake_get(path, token):
        assert path.startswith("/search/issues?")
        return _search_page([_search_pr_item(5, title="fix login bug")])

    monkeypatch.setattr(hub, "_gh_get", fake_get)
    r = await client.get(f"/api/containers/{cid}/github/pulls?q=login+bug")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["source"] == "search"
    assert len(body["pulls"]) == 1
    assert body["pulls"][0]["title"] == "fix login bug"


async def test_pulls_q_and_author_combine_in_one_search(client, container, token_env, monkeypatch):
    cid = container["id"]
    await _bind_repo(client, cid)
    seen = {}

    def fake_get(path, token):
        seen["path"] = path
        return _search_page([])

    monkeypatch.setattr(hub, "_gh_get", fake_get)
    await client.get(f"/api/containers/{cid}/github/pulls?author=octocat&q=oauth")
    import urllib.parse as up
    qs = up.parse_qs(up.urlsplit(seen["path"]).query)
    q = qs["q"][0]
    assert "repo:acme/site is:pr is:open" in q
    assert "author:octocat" in q
    assert "oauth" in q


# ------------------------- search-path query assembly: involvement= ------------------

async def test_pulls_involvement_assigned_resolves_server_side(
        client, container, make_agent, trust_proxy, token_env, monkeypatch):
    """involvement=assigned resolves against the acting identity's github_login
    (the /api/me identity seam) and maps to GitHub's assignee:@me-equivalent qualifier
    (assignee:<login> — search has no server-relative '@me' outside the authenticated
    user's own token, which this route doesn't hold; the resolved login is substituted
    directly)."""
    cid = container["id"]
    await _bind_owner(client, container, make_agent)  # binds octocat as owner
    await _bind_repo(client, cid)
    seen = {}

    def fake_get(path, token):
        seen["path"] = path
        return _search_page([])

    monkeypatch.setattr(hub, "_gh_get", fake_get)
    r = await client.get(f"/api/containers/{cid}/github/pulls?involvement=assigned",
                        headers=OCTO)
    assert r.status_code == 200, r.text
    import urllib.parse as up
    qs = up.parse_qs(up.urlsplit(seen["path"]).query)
    assert "assignee:octocat" in qs["q"][0]


async def test_pulls_involvement_review_requested_resolves_server_side(
        client, container, make_agent, trust_proxy, token_env, monkeypatch):
    cid = container["id"]
    await _bind_owner(client, container, make_agent)
    await _bind_repo(client, cid)
    seen = {}

    def fake_get(path, token):
        seen["path"] = path
        return _search_page([])

    monkeypatch.setattr(hub, "_gh_get", fake_get)
    r = await client.get(f"/api/containers/{cid}/github/pulls?involvement=review_requested",
                        headers=OCTO)
    assert r.status_code == 200, r.text
    import urllib.parse as up
    qs = up.parse_qs(up.urlsplit(seen["path"]).query)
    assert "review-requested:octocat" in qs["q"][0]


async def test_pulls_involvement_bad_value_422(client, container, token_env):
    cid = container["id"]
    await _bind_repo(client, cid)
    r = await client.get(f"/api/containers/{cid}/github/pulls?involvement=bogus")
    assert r.status_code == 422


# ------------------------- identity-less involvement: no github_login ----------------

async def test_pulls_involvement_no_identity_returns_friendly_empty(
        client, container, token_env):
    """No trusted proxy identity resolved (self-host / no header) -> the acting
    identity has no github_login -> a clean 200 with available:true, items:[], and a
    detail explaining the gap — never a 4xx/5xx, and no GitHub call at all."""
    cid = container["id"]
    await _bind_repo(client, cid)
    r = await client.get(f"/api/containers/{cid}/github/pulls?involvement=assigned")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["available"] is True
    assert body["items"] == []
    assert "Link a GitHub login" in body["detail"]


async def test_pulls_involvement_no_identity_makes_no_github_call(
        client, container, token_env, monkeypatch):
    cid = container["id"]
    await _bind_repo(client, cid)
    calls = []
    monkeypatch.setattr(hub, "_gh_get", lambda p, t: calls.append(p))
    await client.get(f"/api/containers/{cid}/github/pulls?involvement=review_requested")
    assert calls == []


# ------------------------- has_more calculation ---------------------------------------

async def test_pulls_search_has_more_true_when_more_pages_remain(
        client, container, token_env, monkeypatch):
    cid = container["id"]
    await _bind_repo(client, cid)

    def fake_get(path, token):
        items = [_search_pr_item(n) for n in range(1, 6)]  # 5 items, page 1 of per_page=5
        return _search_page(items, total_count=12)

    monkeypatch.setattr(hub, "_gh_get", fake_get)
    r = await client.get(f"/api/containers/{cid}/github/pulls?q=x&page=1&per_page=5")
    body = r.json()
    assert body["total_count"] == 12
    assert body["has_more"] is True


async def test_pulls_search_has_more_false_on_last_page(
        client, container, token_env, monkeypatch):
    cid = container["id"]
    await _bind_repo(client, cid)

    def fake_get(path, token):
        items = [_search_pr_item(n) for n in range(1, 3)]  # last 2 of 12, page 3 of 5
        return _search_page(items, total_count=12)

    monkeypatch.setattr(hub, "_gh_get", fake_get)
    r = await client.get(f"/api/containers/{cid}/github/pulls?q=x&page=3&per_page=5")
    body = r.json()
    assert body["has_more"] is False


async def test_pulls_list_path_has_more_true_when_full_page_returned(
        client, container, token_env, monkeypatch):
    """The plain list path has no honest total_count from GitHub's /pulls list, so
    has_more is inferred from whether a FULL page came back (a partial/empty page means
    there's nothing more to page to)."""
    cid = container["id"]
    await _bind_repo(client, cid)

    def fake_get(path, token):
        return [{
            "number": n, "title": f"pr {n}", "draft": False,
            "updated_at": "2026-07-02T00:00:00Z",
            "html_url": f"https://github.com/acme/site/pull/{n}",
            "head": {"ref": "x", "sha": "s"}, "requested_reviewers": [],
            "mergeable_state": "clean",
        } for n in range(1, 4)]  # exactly per_page=3 rows -> maybe more

    monkeypatch.setattr(hub, "_gh_get", fake_get)
    r = await client.get(f"/api/containers/{cid}/github/pulls?per_page=3")
    body = r.json()
    assert body["has_more"] is True


async def test_pulls_list_path_has_more_false_on_partial_page(
        client, container, token_env, monkeypatch):
    cid = container["id"]
    await _bind_repo(client, cid)

    def fake_get(path, token):
        return [{
            "number": 1, "title": "only one", "draft": False,
            "updated_at": "2026-07-02T00:00:00Z",
            "html_url": "https://github.com/acme/site/pull/1",
            "head": {"ref": "x", "sha": "s"}, "requested_reviewers": [],
            "mergeable_state": "clean",
        }]  # 1 row < per_page=30 -> definitely no more

    monkeypatch.setattr(hub, "_gh_get", fake_get)
    r = await client.get(f"/api/containers/{cid}/github/pulls")
    body = r.json()
    assert body["has_more"] is False


# ------------------------- tolerant row mapping (search-sourced rows) -----------------

async def test_pulls_search_row_mapping_omits_unknown_fields(
        client, container, token_env, monkeypatch):
    """Search-sourced items map to the existing row shape but lack
    head/base/checks/requested_reviewers — the route emits what's known and
    omits/null the rest rather than fabricating them."""
    cid = container["id"]
    await _bind_repo(client, cid)

    def fake_get(path, token):
        return _search_page([_search_pr_item(21, title="Add OAuth", draft=True)])

    monkeypatch.setattr(hub, "_gh_get", fake_get)
    r = await client.get(f"/api/containers/{cid}/github/pulls?q=oauth")
    assert r.status_code == 200, r.text
    row = r.json()["pulls"][0]
    assert row["number"] == 21
    assert row["title"] == "Add OAuth"
    assert row["draft"] is True
    assert row["html_url"] == "https://github.com/acme/site/pull/21"
    assert row["updated_at"] == "2026-08-01T00:00:00Z"
    # unknown on the search shape -> null/absent, never fabricated
    assert row["checks"] is None
    assert row["head"] is None
    assert row.get("requested_reviewers") in (None, [])
    assert row["mergeable_state"] is None


async def test_pulls_search_rows_carry_tracked_task_id(
        client, container, token_env, monkeypatch):
    """Search-sourced rows still get the tracked_task_id stamp — same batched lookup
    the plain list path uses, so 'already tracked' state isn't lost on the search path."""
    cid = container["id"]
    await _bind_repo(client, cid)

    def fake_get(path, token):
        if "/search/issues" in path:
            return _search_page([_search_pr_item(300, title="tracked one")])
        # the authoritative-title live fetch POST /start makes
        return {"number": 300, "title": "tracked one",
                "html_url": "https://github.com/acme/site/pull/300", "body": ""}

    monkeypatch.setattr(hub, "_gh_get", fake_get)
    start_r = await client.post(f"/api/containers/{cid}/github/start",
                                json={"kind": "pull", "number": 300, "title": "tracked one"})
    assert start_r.status_code == 201, start_r.text
    tid = start_r.json()["task_id"]

    r = await client.get(f"/api/containers/{cid}/github/pulls?q=tracked")
    assert r.status_code == 200, r.text
    assert r.json()["pulls"][0]["tracked_task_id"] == tid


# ------------------------- search path: repo-not-connected / local-source unaffected -

async def test_pulls_search_repo_not_connected(client, container):
    r = await client.get(f"/api/containers/{container['id']}/github/pulls?q=x")
    assert r.status_code == 200
    assert r.json()["reason"] == "repo_not_connected"


async def test_pulls_search_error_mapping_403(client, container, token_env, monkeypatch):
    cid = container["id"]
    await _bind_repo(client, cid)
    monkeypatch.setattr(hub, "_gh_get",
                        lambda p, t: (_ for _ in ()).throw(RuntimeError("github_status:403")))
    r = await client.get(f"/api/containers/{cid}/github/pulls?q=x")
    assert r.status_code == 200
    assert r.json()["reason"] == "rate_limited"


# ------------------------- author_login on rows (additive, feeds the datalist) --------

async def test_pulls_list_row_carries_author_login(client, container, token_env, monkeypatch):
    """The plain list path's rows carry author_login (additive field, off GitHub's
    user.login) — feeds the frontend filter bar's "authors seen" datalist."""
    cid = container["id"]
    await _bind_repo(client, cid)

    def fake_get(path, token):
        return [{
            "number": 1, "title": "x", "draft": False,
            "updated_at": "2026-07-02T00:00:00Z",
            "html_url": "https://github.com/acme/site/pull/1",
            "head": {"ref": "x", "sha": "s"}, "requested_reviewers": [],
            "mergeable_state": "clean", "user": {"login": "octocat"},
        }]

    monkeypatch.setattr(hub, "_gh_get", fake_get)
    r = await client.get(f"/api/containers/{cid}/github/pulls")
    assert r.json()["pulls"][0]["author_login"] == "octocat"


async def test_pulls_search_row_carries_author_login(client, container, token_env, monkeypatch):
    cid = container["id"]
    await _bind_repo(client, cid)

    def fake_get(path, token):
        return _search_page([_search_pr_item(1, title="x", user={"login": "hubot"})])

    monkeypatch.setattr(hub, "_gh_get", fake_get)
    r = await client.get(f"/api/containers/{cid}/github/pulls?q=x")
    assert r.json()["pulls"][0]["author_login"] == "hubot"
