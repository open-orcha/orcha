"""The committed Workflows contract snapshot must match the generated /openapi.json.

The portal binds to docs/design/workflows/workflows-openapi.json. It is the
Workflows slice of FastAPI's generated spec: every route registered by the
workflow and task-autonomy route modules plus the schemas those routes reach.
Regenerate after a route or schema change with:

    ORCHA_WRITE_WORKFLOWS_OPENAPI=1 pytest tests/test_workflows_openapi_snapshot.py
"""

import json
import os
import pathlib

import main

SNAPSHOT = (
    pathlib.Path(__file__).resolve().parents[1]
    / "docs/design/workflows/workflows-openapi.json"
)


def workflows_contract():
    spec = main.app.openapi()
    methods = {}
    for route in main.app.routes:
        endpoint = getattr(route, "endpoint", None)
        if getattr(endpoint, "__module__", "") in {
            "portal_backend.workflow_routes",
            "portal_backend.task_autonomy_routes",
        }:
            methods.setdefault(route.path_format, set()).update(
                m.lower() for m in route.methods
            )
    paths = {
        path: {m: op for m, op in spec["paths"][path].items() if m in wanted}
        for path, wanted in sorted(methods.items())
    }
    schemas = spec["components"]["schemas"]
    refs = set()

    def collect(node):
        if isinstance(node, dict):
            if "$ref" in node:
                refs.add(node["$ref"].split("/")[-1])
            for value in node.values():
                collect(value)
        elif isinstance(node, list):
            for value in node:
                collect(value)

    collect(paths)
    while True:
        seen = set(refs)
        for name in seen:
            collect(schemas[name])
        if refs == seen:
            break
    return {
        "openapi": spec["openapi"],
        "info": spec["info"],
        "paths": paths,
        "components": {"schemas": {name: schemas[name] for name in sorted(refs)}},
    }


def test_workflows_openapi_snapshot_matches_generated_spec():
    generated = json.dumps(workflows_contract(), indent=2) + "\n"
    if os.environ.get("ORCHA_WRITE_WORKFLOWS_OPENAPI") == "1":
        SNAPSHOT.parent.mkdir(parents=True, exist_ok=True)
        SNAPSHOT.write_text(generated)
    assert SNAPSHOT.read_text() == generated, (
        "Workflows contract snapshot is stale; regenerate it with "
        "ORCHA_WRITE_WORKFLOWS_OPENAPI=1"
    )


def test_snapshot_covers_task_level_recovery_routes():
    paths = workflows_contract()["paths"]
    for path in ("stop", "retry", "reissue-stop", "release-lost-worker"):
        assert "post" in paths["/api/tasks/{tid}/" + path]
    assert "put" in paths["/api/tasks/{tid}/dependencies"]
    assert "put" in paths["/api/tasks/{tid}/autonomy"]
    assert "get" in paths["/api/tasks/{tid}/approvals"]


def test_every_offered_action_names_its_route():
    """available_actions bind to routes by x-workflow-operation, mechanically.

    accept/reject go through the legacy verify adapters; submit_outside_result is
    the external_result operation.
    """
    operations = {
        op.get("x-workflow-operation")
        for ops in workflows_contract()["paths"].values()
        for op in ops.values()
    }
    offered = {
        "start", "pause", "resume", "cancel", "finish", "add_tasks", "import",
        "patch", "accept_goal", "review_round", "transfer_owner", "move",
        "accept_objective", "edit_objective", "prepare", "hold", "release",
        "retry", "stop", "release_lost_worker", "reissue_stop",
        "withdraw_evidence", "add_evidence", "dependencies", "withdraw",
        "resolve_loop",
    }  # fmt: skip
    assert offered - operations == set()
    assert "external_result" in operations
