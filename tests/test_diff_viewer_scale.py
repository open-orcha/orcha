"""Approval–diff binding, scale handling: a 50-file diff must render as a per-file
manifest (collapsed sections with +/− stats), not one endless scroll. Small diffs —
the common case for a scoped task — keep the zero-friction expanded render. The
digest binding is presentation-independent either way.
"""
import json
import pathlib
import shutil
import subprocess

import pytest

STATIC = (pathlib.Path(__file__).resolve().parent.parent
          / "orcha-cli" / "orcha_cli" / "templates" / "portal" / "static")

THREE_FILE_DIFF = r"""diff --git a/api/payments.py b/api/payments.py
index 1111111..2222222 100644
--- a/api/payments.py
+++ b/api/payments.py
@@ -1,3 +1,4 @@
 import os
+import audit
-OLD = 1
+NEW = 2
diff --git a/api/errors.py b/api/errors.py
new file mode 100644
--- /dev/null
+++ b/api/errors.py
@@ -0,0 +2 @@
+class InvalidAmountError(Exception):
+    pass
diff --git a/tests/test_payments.py b/tests/test_payments.py
index 3333333..4444444 100644
--- a/tests/test_payments.py
+++ b/tests/test_payments.py
@@ -5,1 +5,2 @@
 def test_x():
+    assert True
"""

HARNESS = r"""
global.localStorage = { getItem: () => null, setItem: () => {} };
global.document = { documentElement:{setAttribute(){}}, addEventListener(){}, getElementById:()=>null,
  createElement:()=>({classList:{add(){},remove(){}},addEventListener(){},style:{},appendChild(){}}), body:{appendChild(){}},
  activeElement: null };
global.window = { getSelection: () => ({ rangeCount: 0, isCollapsed: true }) };
__APPJS__
const O = window.Orcha;
const files = O.parseDiffFiles(__DIFF__);
const bare = O.parseDiffFiles("@@ -1,2 +1,3 @@\n context\n+added");
console.log(JSON.stringify({
  n: files.length,
  paths: files.map(f => f.path),
  adds: files.map(f => f.adds),
  dels: files.map(f => f.dels),
  textsContainOwnHeader: files.every(f => f.text.includes(f.path)),
  bareN: bare.length, bareAdds: bare[0].adds,
}));
"""


@pytest.mark.skipif(shutil.which("node") is None, reason="node not available to exercise client JS")
def test_parse_diff_files_splits_multi_file_unified_diff():
    app_js = (STATIC / "app.js").read_text()
    harness = HARNESS.replace("__APPJS__", app_js).replace("__DIFF__", json.dumps(THREE_FILE_DIFF))
    out = subprocess.run(["node", "-e", harness], capture_output=True, text=True)
    assert out.returncode == 0, out.stderr
    got = json.loads(out.stdout.strip().splitlines()[-1])
    assert got["n"] == 3
    assert got["paths"] == ["api/payments.py", "api/errors.py", "tests/test_payments.py"]
    assert got["adds"] == [2, 2, 1]     # +import audit, +NEW / two class lines / one assert
    assert got["dels"] == [1, 0, 0]     # -OLD
    assert got["textsContainOwnHeader"] is True
    # tolerant of bare hunks with no `diff --git` header (single synthetic file)
    assert got["bareN"] == 1 and got["bareAdds"] == 1


VIEWER_HARNESS = r"""
global.localStorage = { getItem: () => null, setItem: () => {} };
global.document = { documentElement:{setAttribute(){}}, addEventListener(){}, getElementById:()=>null,
  createElement:()=>({classList:{add(){},remove(){}},addEventListener(){},style:{},appendChild(){}}), body:{appendChild(){}},
  activeElement: null };
global.window = { getSelection: () => ({ rangeCount: 0, isCollapsed: true }) };
__APPJS__
const O = window.Orcha;
const files = O.parseDiffFiles(__DIFF__);
const html = O.diffViewerHTML(files, {title: "Migrate errors", digest: "sha256:abcdef1234567890", adds: 5, dels: 1});
console.log(JSON.stringify({
  sidebarEntries: (html.match(/class="dv-file"/g) || []).length,
  sections: (html.match(/id="dvf-\d+"/g) || []).length,
  hasDigest: html.includes("sha256:abcdef123"),
  hasTitle: html.includes("Migrate errors"),
  hasClose: html.includes('data-act="dv-close"'),
  hasAccept: html.includes('data-act="dv-accept"'),
}));
"""


@pytest.mark.skipif(shutil.which("node") is None, reason="node not available to exercise client JS")
def test_diff_viewer_html_builds_sidebar_and_sections():
    """The full-screen reviewer (GitHub-files-view style): one sidebar entry and one
    anchored section per file, digest + title in the header, close/accept controls."""
    app_js = (STATIC / "app.js").read_text()
    harness = VIEWER_HARNESS.replace("__APPJS__", app_js).replace("__DIFF__", json.dumps(THREE_FILE_DIFF))
    out = subprocess.run(["node", "-e", harness], capture_output=True, text=True)
    assert out.returncode == 0, out.stderr
    got = json.loads(out.stdout.strip().splitlines()[-1])
    assert got["sidebarEntries"] == 3 and got["sections"] == 3
    assert got["hasDigest"] and got["hasTitle"] and got["hasClose"] and got["hasAccept"]


def test_full_screen_viewer_wired_into_gate():
    html = (STATIC / "tasks.html").read_text()
    assert 'data-act="open-diff-viewer"' in html, "gate must offer the full-screen reviewer"
    assert "openDiffViewer(" in html
    assert "Escape" in html, "overlay must close on Esc"
    css = (STATIC / "styles.css").read_text()
    assert ".dv-overlay" in css and ".dv-side" in css and ".dv-main" in css


def test_gate_renders_manifest_mode_above_threshold():
    """tasks.html must ship the manifest branch: per-file collapsed sections driven by
    parseDiffFiles, with explicit thresholds — not one flat render for every size."""
    html = (STATIC / "tasks.html").read_text()
    assert "parseDiffFiles(" in html
    assert "GATE_DIFF_MANIFEST_FILES" in html and "GATE_DIFF_MANIFEST_LINES" in html
    app_js = (STATIC / "app.js").read_text()
    assert "parseDiffFiles" in app_js.split("window.Orcha")[-1] or "parseDiffFiles," in app_js, \
        "parseDiffFiles must be exported on the Orcha namespace"
