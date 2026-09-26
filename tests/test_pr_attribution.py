"""PR attribution (docs/agent-prs.md) — attribute agent-opened PRs to the triggering human.

The chain under test:
  042 migration (agents.git_email) → register-human captures github_login/git_email →
  GET /agents/{aid}/protocol resolves the task's requesting human (creator when human,
  earliest live owner as the never-silent fallback) → the wake's "Your task" section
  renders a "Requested by" line → REPO_WORKFLOW_GUIDANCE carries the exact PR-body
  blockquote + Co-authored-by formats the agent must emit.
"""
import pathlib
import re
import sys

REPO = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO / "orcha-cli"))

from orcha_cli.notifier_persona import REPO_WORKFLOW_GUIDANCE  # noqa: E402
from orcha_cli.notifier_protocol import _render_task_body  # noqa: E402


# ---------- migration 042 ----------

def test_migration_042_exists_and_is_next_sequential():
    mig_dir = REPO / "orcha-cli" / "orcha_cli" / "templates" / "migrations"
    f = mig_dir / "042_human_git_identity.sql"
    assert f.is_file()
    assert "git_email" in f.read_text()
    numbers = sorted(int(m.group(1)) for p in mig_dir.glob("*.sql")
                     if (m := re.match(r"^(\d+)_", p.name)))
    # cloud #64 (per-agent autonomy overrides) added 043_agent_autonomy_override.sql; the GitHub
    # hub + Slack seam then added 044_slack_integration.sql as the next sequential migration, so 044
    # is now the latest. 042 (git_email) still exists (asserted above).
    # 045 added by Code Space (docs/orcha-code-space-design.md); 046 added by the GitHub PAT
    # storage seam (Orcha Cloud local run gap #1, docs/orcha-cloud-local-run.md §1); 048 added by
    # the host-side roster analysis storage seam (docs/orcha-cloud-local-run.md). Keep this pin
    # moving with the chain tip so gaps/dupes still fail loudly.
    assert numbers[-1] == 48, f"048 must be the latest migration, saw {numbers[-1]:03d}"


def test_agents_git_email_column_applied(db):
    rows = db.execute(
        "SELECT column_name FROM information_schema.columns "
        "WHERE table_name='agents' AND column_name IN ('git_email','github_login')"
    )
    assert {r["column_name"] for r in rows} == {"git_email", "github_login"}


# ---------- register-human captures the handle ----------

async def test_register_human_persists_github_identity(client, container, db):
    cid = container["id"]
    r = await client.post(
        f"/api/containers/{cid}/agents",
        json={"alias": "Hussein", "role": "owner", "kind": "human",
              "github_login": "hussein-quant", "git_email": "hussein@example.com"},
    )
    assert r.status_code == 201, r.text
    row = db.execute("SELECT github_login, git_email FROM agents WHERE id=%s",
                     (r.json()["agent_id"],))[0]
    assert row["github_login"] == "hussein-quant"
    assert row["git_email"] == "hussein@example.com"


async def test_register_human_identity_fields_optional(client, container, db):
    cid = container["id"]
    r = await client.post(
        f"/api/containers/{cid}/agents",
        json={"alias": "Priya", "role": "human", "kind": "human"},
    )
    assert r.status_code == 201, r.text
    row = db.execute("SELECT github_login, git_email FROM agents WHERE id=%s",
                     (r.json()["agent_id"],))[0]
    assert row["github_login"] is None and row["git_email"] is None


async def test_register_rejects_malformed_github_login(client, container):
    r = await client.post(
        f"/api/containers/{container['id']}/agents",
        json={"alias": "Evil", "role": "human", "kind": "human",
              "github_login": "-leading-hyphen"},
    )
    assert r.status_code == 422


async def test_register_ai_never_stores_github_identity(client, container, db):
    """An AI row carrying a handle would masquerade as a person in the attribution chain."""
    r = await client.post(
        f"/api/containers/{container['id']}/agents",
        json={"alias": "Bot", "role": "worker", "kind": "ai",
              "prompt": "You are a test agent.",
              "github_login": "hussein-quant", "git_email": "h@example.com"},
    )
    assert r.status_code == 201, r.text
    row = db.execute("SELECT github_login, git_email FROM agents WHERE id=%s",
                     (r.json()["agent_id"],))[0]
    assert row["github_login"] is None and row["git_email"] is None


# ---------- the requester rides the protocol endpoint ----------

async def _human(client, cid, alias="Hussein", login="hussein-quant",
                 email="hussein@example.com"):
    body = {"alias": alias, "role": "owner", "kind": "human"}
    if login:
        body["github_login"] = login
    if email:
        body["git_email"] = email
    r = await client.post(f"/api/containers/{cid}/agents", json=body)
    assert r.status_code == 201, r.text
    return r.json()["agent_id"]


async def test_protocol_returns_human_creator_as_requester(
        client, container, make_agent, make_task):
    cid = container["id"]
    human = await _human(client, cid)
    ai = await make_agent("atlas", "worker")
    task = await make_task("Fix the flaky auth test", "test passes 5x",
                           assignee_alias="atlas", created_by=human)
    r = await client.get(f"/api/agents/{ai['agent_id']}/protocol",
                         params={"task_id": task["id"]})
    assert r.status_code == 200, r.text
    req = r.json()["requested_by"]
    assert req == {"alias": "Hussein", "github_login": "hussein-quant",
                   "git_email": "hussein@example.com"}


async def test_protocol_falls_back_to_owner_for_agent_created_task(
        client, container, make_agent, make_task):
    """Attribution degrades to the earliest live owner — never silently vanishes."""
    cid = container["id"]
    await _human(client, cid)  # first human => owner
    ai = await make_agent("atlas", "worker")
    task = await make_task("Subtask spawned by an agent", "done when done",
                           assignee_alias="atlas", created_by=ai["agent_id"])
    r = await client.get(f"/api/agents/{ai['agent_id']}/protocol",
                         params={"task_id": task["id"]})
    assert r.status_code == 200, r.text
    assert r.json()["requested_by"]["github_login"] == "hussein-quant"


async def test_protocol_requester_null_when_no_humans(
        client, container, make_agent, make_task):
    ai = await make_agent("atlas", "worker")
    task = await make_task("Loner task", "done", assignee_alias="atlas",
                           created_by=ai["agent_id"])
    r = await client.get(f"/api/agents/{ai['agent_id']}/protocol",
                         params={"task_id": task["id"]})
    assert r.status_code == 200, r.text
    assert r.json()["requested_by"] is None


# ---------- wake rendering + standing guidance ----------

def test_task_body_renders_requested_by_line():
    out = _render_task_body({
        "task_id": "t-1", "title": "Fix it", "description": "desc",
        "definition_of_done": "done",
        "requested_by": {"alias": "Hussein", "github_login": "hussein-quant",
                         "git_email": "hussein@example.com"},
    })
    assert "Requested by: Hussein (@hussein-quant) <hussein@example.com>" in out


def test_task_body_requested_by_falls_back_to_alias():
    out = _render_task_body({
        "task_id": "t-1", "title": "Fix it", "description": "desc",
        "definition_of_done": "done",
        "requested_by": {"alias": "Hussein", "github_login": None, "git_email": None},
    })
    assert "Requested by: Hussein —" in out
    assert "@" not in out.split("Requested by:")[1].split("\n")[0]


def test_task_body_omits_line_when_no_requester():
    out = _render_task_body({
        "task_id": "t-1", "title": "Fix it", "description": "desc",
        "definition_of_done": "done", "requested_by": None,
    })
    assert "Requested by" not in out


def test_repo_guidance_carries_exact_attribution_formats():
    assert "> 🧑 Triggered by @<github-login> via Orcha task <task-id>" in REPO_WORKFLOW_GUIDANCE
    assert "> 🧑 Triggered by <name> via Orcha task <task-id>" in REPO_WORKFLOW_GUIDANCE
    assert "Co-authored-by: <name> <email>" in REPO_WORKFLOW_GUIDANCE
    assert "@users.noreply.github.com" in REPO_WORKFLOW_GUIDANCE
