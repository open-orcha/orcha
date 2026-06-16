"""ISS-83 / GH #228 — recency-band sort, RECONCILED for ISS-331 (GH #331).

ORIGINAL ISS-83 behavior: a task/request touched within ~12h floated to the TOP of its status
group regardless of priority (a recency band slotted BELOW status, ABOVE priority).

ISS-331 SUPERSEDES that within-group float with an explicit, user-controlled sort control
(O.sortComparator: status bucket OUTER, then the user-chosen time|priority key + direction).
A recency float that jumped a recent-but-low item above the user's chosen order would defeat
the control, so the band is deliberately NO LONGER a comparator key. The band HELPER
(O.recencyBand / O.recencyTs in app.js, recencyBandOf() in tasks.html) is RETAINED for reuse
(e.g. group-header "recent" copy) and is still exercised below.

What MUST survive ISS-331: the status grouping stays the OUTER key (open / needs-attention rows
keep floating to the top of the list) — that is the half of ISS-83 that triage depends on.

NOTE (reversible product call): retiring the within-group recency float is the shipped v1
decision (status-bucket-outer + explicit sort wins). If Kedar wants the float preserved as a
within-group fallback, re-integrate recencyBandOf into sortAcc/reqAcc and restore the
band-between-status-and-priority teeth — these tests are written to flip cleanly either way.
"""
import json
import pathlib
import shutil
import subprocess

import pytest

REPO = pathlib.Path(__file__).resolve().parent.parent
STATIC = REPO / "orcha-cli" / "orcha_cli" / "templates" / "portal" / "static"

# Shared node harness preamble: stubs the browser globals app.js touches at load + a real
# localStorage (so sortState can be driven per surface) and exposes window.Orcha as O.
_HARNESS_HEAD = r"""
global.localStorage = { _v:{}, getItem(k){return this._v[k]||null;}, setItem(k,v){this._v[k]=v;}, removeItem(k){delete this._v[k];} };
global.document = { documentElement:{setAttribute(){}}, addEventListener(){}, getElementById:()=>null,
  createElement:()=>({classList:{add(){},remove(){}},addEventListener(){},style:{},appendChild(){}}), body:{appendChild(){}},
  activeElement: null };
global.window = { getSelection: () => ({ rangeCount: 0, isCollapsed: true }) };
__APPJS__
const O = window.Orcha;
"""


def _run_node(snippet):
    app_js = (STATIC / "app.js").read_text()
    src = _HARNESS_HEAD.replace("__APPJS__", app_js) + snippet
    out = subprocess.run(["node", "-e", src], capture_output=True, text=True)
    assert out.returncode == 0, out.stderr
    return json.loads(out.stdout.strip().splitlines()[-1])


# ---------- the band HELPER itself (real JS execution) — retained for reuse ----------

@pytest.mark.skipif(shutil.which("node") is None, reason="node not available to exercise client JS")
def test_recency_band_and_ts_logic():
    """recencyTs picks the NEWEST of any supplied ISO timestamps (0 if none parse);
    recencyBand returns 0 for an item touched within the ~12h window, else 1 — so as a sort
    key it sorts recent (0) ABOVE stale (1). The helper survives the ISS-331 supersession."""
    res = _run_node(r"""
const now = Date.now();
const iso = (msAgo) => new Date(now - msAgo).toISOString();
const H = 3600 * 1000;
console.log(JSON.stringify({
  tsPicksNewest: O.recencyTs(iso(10 * H), iso(2 * H), iso(30 * H)) === Date.parse(iso(2 * H)),
  tsNoneIsZero: O.recencyTs(null, "", undefined) === 0,
  recentIsZero: O.recencyBand(iso(1 * H)) === 0,
  edgeJustInside: O.recencyBand(iso(11.5 * H)) === 0,
  staleIsOne: O.recencyBand(iso(24 * H)) === 1,
  edgeJustOutside: O.recencyBand(iso(13 * H)) === 1,
  updatedRecentWins: O.recencyBand(iso(48 * H), iso(1 * H)) === 0,
  noTimestampIsOne: O.recencyBand(null, "") === 1,
  recentSortsFirst: (O.recencyBand(iso(1 * H)) - O.recencyBand(iso(48 * H))) < 0,
}));
""")
    for k, v in res.items():
        assert v, f"{k} failed: {res}"


# ---------- ISS-331 comparator BEHAVIOR: status bucket outer + supersedes recency float ----------

@pytest.mark.skipif(shutil.which("node") is None, reason="node not available to exercise client JS")
def test_sort_comparator_status_bucket_outer_and_supersedes_recency():
    """The shared O.sortComparator keeps the status bucket as the OUTER key in BOTH modes, and
    within a bucket the user-chosen key wins — so a RECENT low-priority row no longer floats
    above an OLDER high-priority row (the ISS-83 band would have floated it; ISS-331 supersedes).

    MUTATION TEETH:
      - drop the bucket key  -> 'a' (newest overall, stale bucket) floats to top -> bucketOuter* RED
      - re-insert a recency float above priority -> recent 'c' jumps old high-prio 'd' -> prioBeatsRecency RED
    """
    res = _run_node(r"""
function setMode(name, key, dir){ localStorage.setItem("orcha:sort:"+name, JSON.stringify({key,dir})); }
const acc = { bucket: t=>t.bucket, time: t=>t.time, prio: t=>t.prio };
// two status buckets (0=top, 1=lower); within bucket-0 vary time & priority
const items = [
  {id:"a", bucket:1, time:1000, prio:10},  // lower bucket, newest overall, high prio
  {id:"b", bucket:0, time:1,    prio:50},  // top bucket, oldest, low prio
  {id:"c", bucket:0, time:999,  prio:50},  // top bucket, recent, low prio
  {id:"d", bucket:0, time:5,    prio:10},  // top bucket, old, HIGH prio
];
setMode("t","priority","asc");
const byPrio = items.slice().sort(O.sortComparator("t", acc)).map(x=>x.id);
setMode("t","time","desc");
const byTimeDesc = items.slice().sort(O.sortComparator("t", acc)).map(x=>x.id);
console.log(JSON.stringify({
  // status bucket OUTER: 'a' (the only bucket-1 row) is LAST in both modes, even though it is
  // the newest overall — a global sort ignoring buckets would surface it first under time-desc.
  bucketOuterPrio: byPrio[byPrio.length-1] === "a",
  bucketOuterTime: byTimeDesc[byTimeDesc.length-1] === "a",
  // SUPERSESSION: priority mode -> old HIGH-prio 'd' beats recent LOW-prio 'c' within bucket-0
  // (an ISS-83 recency band above priority would float 'c' over 'd').
  prioBeatsRecency: byPrio.indexOf("d") < byPrio.indexOf("c"),
  // time-desc within bucket-0: newest first -> c(999) < d(5) < b(1)
  timeDescNewestFirst: byTimeDesc.indexOf("c") < byTimeDesc.indexOf("d")
                       && byTimeDesc.indexOf("d") < byTimeDesc.indexOf("b"),
}));
""")
    for k, v in res.items():
        assert v, f"{k} failed: {res}"


# ---------- tasks.html: shared control owns within-group order; band float retired ----------

def test_tasks_sort_uses_shared_control_status_bucket_outer():
    html = (STATIC / "tasks.html").read_text()
    body = html[html.index("function sorted()"):]
    body = body[: body.index("}", body.index("return"))]
    # ISS-331: within-group ordering routes through the shared control...
    assert "O.sortComparator(" in body, "tasks sort no longer routes through the shared control"
    # ...with the status grouping as the OUTER key (open/needs-attention float survives).
    acc_body = html[html.index("function sortAcc"):]
    acc_body = acc_body[: acc_body.index("}", acc_body.index("return"))]
    assert "ORDER[" in acc_body, "status bucket accessor dropped from sortAcc — status is no longer outer"
    # SUPERSESSION: the recency-band float is NO LONGER a comparator key...
    assert "recencyBandOf(a)" not in body, \
        "recency-band float still wired into the comparator — ISS-331 supersedes it"
    # ...but the helper is RETAINED for reuse (group-header copy etc.).
    assert "function recencyBandOf" in html, "recency-band helper deleted; ISS-331 retains it for reuse"


# ---------- requests.html: shared control, open-first preserved; band float retired ----------

def test_requests_sort_uses_shared_control_open_first():
    html = (STATIC / "requests.html").read_text()
    assert "function reqSorted" in html, "requests lost their frontend sort"
    assert "reqSorted(reqs().filter(matches))" in html, "the request list isn't run through reqSorted"
    body = html[html.index("function reqSorted"):]
    body = body[: body.index("}", body.index("return"))]
    assert "O.sortComparator(" in body, "requests sort no longer routes through the shared control"
    # SUPERSESSION: recency-band float removed from the request comparator.
    assert "recencyBand(" not in body, \
        "recency-band float still wired into reqSorted — ISS-331 supersedes it"
    # open-first status ranking preserved (status bucket stays the OUTER key).
    acc_body = html[html.index("function reqAcc"):]
    acc_body = acc_body[: acc_body.index("}", acc_body.index("return"))]
    assert "reqRank" in acc_body, "status bucket accessor dropped from reqAcc — open-first lost"
    assert "REQ_STATUS_RANK" in html and '"open"' in html.replace("'open'", '"open"'), \
        "open-first status ranking dropped"
