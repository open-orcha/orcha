"""tasks.result render bug: the portal showed "[object Object]" for a completed task's
result. Root cause: /done stores JSONB {"result": <text>, "by_agent_id": <uuid>}
(main.py, both autonomy branches), the snapshot returns that object verbatim, and
data.js's mapSnapshot passed it through untouched — so tasks.html string-coerced an
object. The adapter's job is exactly this normalization, so the unwrap lives there.
"""
import json
import pathlib
import shutil
import subprocess

import pytest

STATIC = (pathlib.Path(__file__).resolve().parent.parent
          / "orcha-cli" / "orcha_cli" / "templates" / "portal" / "static")

HARNESS = r"""
global.window = {};
__DATAJS__
const snap = {
  container: {id: "c1", name: "x", status: "active"},
  agents: [],
  tasks: [
    {id: "t1", title: "a", status: "needs_verification", priority: 1,
     result: {result: "Typed errors implemented.", by_agent_id: "a-1"}},
    {id: "t2", title: "b", status: "completed", priority: 1,
     result: "legacy plain-string result"},
    {id: "t3", title: "c", status: "ready", priority: 1, result: null},
  ],
  requests: [],
};
const m = window.OrchaData.mapSnapshot(snap);
const byId = Object.fromEntries(m.tasks.map((t) => [t.id, t.result]));
console.log(JSON.stringify(byId));
"""


@pytest.mark.skipif(shutil.which("node") is None, reason="node not available to exercise client JS")
def test_mapsnapshot_unwraps_result_object_to_text():
    data_js = (STATIC / "data.js").read_text()
    out = subprocess.run(["node", "-e", HARNESS.replace("__DATAJS__", data_js)],
                         capture_output=True, text=True)
    assert out.returncode == 0, out.stderr
    got = json.loads(out.stdout.strip())
    assert got["t1"] == "Typed errors implemented."   # the /done JSONB shape → its text
    assert got["t2"] == "legacy plain-string result"  # legacy rows pass through
    assert got["t3"] is None
