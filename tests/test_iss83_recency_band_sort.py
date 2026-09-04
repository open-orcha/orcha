"""ISS-83 / GH #228 — recency-band sort, RECONCILED for ISS-331 (GH #331).

ORIGINAL ISS-83 behavior: a task/request touched within ~12h floated to the TOP of its status
group regardless of priority (a recency band slotted BELOW status, ABOVE priority).

ISS-331 SUPERSEDES that within-group float with an explicit, user-controlled sort control
(sortComparator: status bucket OUTER, then the user-chosen time|priority key + direction).
A recency float that jumped a recent-but-low item above the user's chosen order would defeat
the control, so the band is deliberately NO LONGER a comparator key. The band HELPER
(recencyBand / recencyTs) is RETAINED for reuse (e.g. group-header "recent" copy).

What MUST survive ISS-331: the status grouping stays the OUTER key (open / needs-attention rows
keep floating to the top of the list) — that is the half of ISS-83 that triage depends on.

MIGRATED (portal React migration Phase 7): the vanilla app.js node harnesses moved to
Vitest — frontend/src/lib/sort.iss83.test.ts (band helper behavior + comparator
bucket-outer/supersession, with the same mutation teeth). The tasks/requests greps are
repointed at the React SOURCE (TasksPage.tsx / RequestsPage.tsx / lib/{format,sort}).
"""
import pathlib

REPO = pathlib.Path(__file__).resolve().parent.parent
SRC = REPO / "orcha-cli" / "orcha_cli" / "templates" / "portal" / "frontend" / "src"


# ---------- the band HELPER — retained for reuse (behavior in Vitest) ----------

def test_recency_band_helper_retained():
    """Behavior (newest-of, 12h window, recent-sorts-first) covered in Vitest
    (frontend/src/lib/sort.iss83.test.ts); here we pin that the helper survives
    the ISS-331 supersession in the shared lib."""
    fmt = (SRC / "lib" / "format.ts").read_text()
    assert "export function recencyTs" in fmt, "recencyTs helper deleted; ISS-331 retains it for reuse"
    assert "export function recencyBand" in fmt, "recencyBand helper deleted; ISS-331 retains it for reuse"
    assert "12 * 60 * 60 * 1000" in fmt, "the ~12h recency window changed silently"


# ---------- tasks: shared control owns within-group order; band float retired ----------

def test_tasks_sort_uses_shared_control_status_bucket_outer():
    tasks = (SRC / "pages" / "tasks" / "TasksPage.tsx").read_text()
    # ISS-331: within-group ordering routes through the shared control...
    assert "sortComparator(SORT_NAME, { bucket: taskBucket" in tasks, \
        "tasks sort no longer routes through the shared control with the status bucket outer"
    # ...with the status grouping as the OUTER key (open/needs-attention float survives).
    assert "const ORDER" in tasks and "ORDER[t.status]" in tasks, \
        "status bucket accessor dropped — status is no longer outer"
    # SUPERSESSION: the recency-band float is NO LONGER a comparator key.
    assert "recencyBand" not in tasks, \
        "recency-band float wired into the tasks comparator — ISS-331 supersedes it"


# ---------- requests: shared control, open-first preserved; band float retired ----------

def test_requests_sort_uses_shared_control_open_first():
    reqs = (SRC / "pages" / "requests" / "RequestsPage.tsx").read_text()
    # the request list runs through the shared control with the open-first bucket outer
    assert 'sortComparator("requests", { bucket: reqRank' in reqs, \
        "requests sort no longer routes through the shared control / open-first bucket"
    assert "REQ_STATUS_RANK" in reqs and "open: 0" in reqs, "open-first status ranking dropped"
    # SUPERSESSION: recency-band float removed from the request comparator.
    assert "recencyBand" not in reqs, \
        "recency-band float wired into the requests comparator — ISS-331 supersedes it"


def test_shared_comparator_bucket_outer_contract():
    """The comparator itself (bucket outer in both modes, chosen key within, tiebreaks)
    is exercised in Vitest; pin the source shape so a refactor can't drop the outer key."""
    sort = (SRC / "lib" / "sort.tsx").read_text()
    assert "export function sortComparator" in sort, "shared comparator gone"
    assert "acc.bucket(a) - acc.bucket(b)" in sort, "status bucket no longer the OUTER comparator key"
