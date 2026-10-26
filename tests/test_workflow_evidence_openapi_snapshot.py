"""Keep the saved-evidence read contract aligned with FastAPI's generated API.

Regenerate after changing workflow evidence responses with:

    ORCHA_WRITE_WORKFLOW_EVIDENCE_OPENAPI=1 pytest tests/test_workflow_evidence_openapi_snapshot.py
"""

import json
import os
import pathlib

import main


SNAPSHOT = (
    pathlib.Path(__file__).resolve().parents[1]
    / "docs/design/workflows/workflow-evidence-openapi.json"
)


def evidence_contract():
    spec = main.app.openapi()
    path = "/api/workflows/{wid}/tasks/{tid}/evidence"
    operation = spec["paths"][path]["get"]
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

    collect(operation)
    while True:
        seen = set(refs)
        for name in seen:
            collect(schemas[name])
        if refs == seen:
            break
    return {
        "openapi": spec["openapi"],
        "info": spec["info"],
        "paths": {path: {"get": operation}},
        "components": {"schemas": {name: schemas[name] for name in sorted(refs)}},
    }


def test_workflow_evidence_openapi_snapshot_matches_generated_spec():
    generated = json.dumps(evidence_contract(), indent=2) + "\n"
    if os.environ.get("ORCHA_WRITE_WORKFLOW_EVIDENCE_OPENAPI") == "1":
        SNAPSHOT.parent.mkdir(parents=True, exist_ok=True)
        SNAPSHOT.write_text(generated)
    assert SNAPSHOT.read_text() == generated, (
        "Workflow evidence contract snapshot is stale; regenerate it with "
        "ORCHA_WRITE_WORKFLOW_EVIDENCE_OPENAPI=1"
    )


def test_evidence_contract_records_immutable_supplier_identity():
    item = evidence_contract()["components"]["schemas"]["SavedEvidenceItem"]
    assert {"captured_by", "captured_by_alias", "captured_by_kind"} <= set(
        item["properties"]
    )
