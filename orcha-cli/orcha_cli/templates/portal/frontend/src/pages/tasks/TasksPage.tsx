/**
 * Tasks page (V2, owner D) — dense grouped list + inspector that expands to a
 * full view, over the UNCHANGED backend: every fetch below copies the existing
 * endpoint/method/body exactly.
 *
 * Layout (docs/orcha-v2-architecture.md §2.1, brief §5 "Tasks"):
 *  - toolbar: search (`q`), status/assignee filters, sort, grouping, list|board
 *    view — all persisted in the URL with history-replace (taskQuery.ts);
 *  - list: grouped by status (GRP order + an "Other" catch-all so nothing is
 *    dropped), bounded render with "Load more · N of M", ↑/↓ j/k Enter
 *    keyboard navigation (List primitive), truncation disclosure when the
 *    snapshot holds fewer tasks than the server total;
 *  - board: the read-only "tasks by status" view (status is backend-managed —
 *    cards are never draggable);
 *  - detail: header, the PRIMARY GATE (plan approval / verification) above the
 *    fold, then Overview / Activity / Runs tabs (`tab=`). Opening as a full
 *    view (`full=1`, or any selection below 900 px) pushes history, so Back
 *    returns to the list with its filters and scroll.
 *
 * Preserved behaviour (parity T-01…T-21): ISS-68 lazy thread + "Load earlier",
 * GH #74 thread error latch + Retry, ISS-46/53 drafts in React state (the 3 s
 * poll never clobbers typing; inactive tabs stay mounted so drafts survive tab
 * switches), plan decisions (B10/ISS-59), verify/reject with a REQUIRED reason,
 * protocol panel (SPEC-4), assignment + reassign 409 (O4), cancel (B7),
 * reviewer chip (collab v1), runs + live SSE + diffs + graceful Stop.
 * The live terminal pairing lives on the Agents page; the thread offers the
 * honest deep link (or a disabled button with a reason).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { Shell } from "../../shell/Shell";
import { threadOf } from "../../api/client";
import { shortId } from "../../lib/format";
import { reviewerSupported } from "../../lib/reviewer";
import { useToast } from "../../components/ui";
import { Button, EmptyState, Skeleton, SplitPane, isEditingTarget } from "../../components/primitives";
import { actingHuman, autLevel, pendingPlan, useActingAuthority, useSnapshot } from "../../state/SnapshotProvider";
import type { Snapshot, Task, ThreadMsg } from "../../types";
import { tasksPageCss } from "./pageCss";
import { TaskBoard, TaskGroups, TaskRow, TasksToolbar, useDensity, usePhone } from "./TaskListView";
import { MakeRecurringDialog, makeRecurringItem, useMakeRecurringGate } from "../routines/MakeRecurring";
import { tasksListCss } from "./tasksListCss";
import { mainScrollTop, scrollMainTo } from "../../shell/PageChrome";
import { workCss } from "./workCss";
import { SnapshotPending } from "../../components/SnapshotPending";
import { NewTaskModal, TaskDetailPane, useNoHumanReason, type DetailPager, type ThreadCache } from "./TaskDetail";
import { taskDetailCss } from "./detailCss";
import {
  GROUP_ORDER,
  activeFilterCount,
  filterTasks,
  groupTasks,
  keyFromSort,
  parseTaskQuery,
  patchSearch,
  sortFromKey,
  taskComparator,
  type SortKey,
  type TaskQuery,
} from "./taskQuery";

/* The detail (inspector / full view / gate / dialogs) lives in ./TaskDetail —
   re-exported here for the pages that import them from the Tasks page. */
export { NO_HUMAN, detailText, GateSurface, useTaskRuns, type RunsState } from "./TaskDetail";

/* ---- ordering / grouping (ISS-37 / ISS-331) ------------------------------- */
// Group order lives in taskQuery.ts GROUP_ORDER (needs_verification first,
// pending + failed have their own buckets, "Other" catch-all).
const GRP = GROUP_ORDER;
const TASKS_PAGE = 50; // ISS-68 PR-3 bounded render (dense V2 rows)
const SORT_NAME = "tasks"; // shared lib/sort persisted key orcha:sort:tasks

/* ============================================================================
   Toolbar — search, filters, sort, group, view (all URL state).
   ========================================================================== */
function useNarrow(): boolean {
  const q = "(max-width: 900px)";
  const get = () => (typeof window !== "undefined" && typeof window.matchMedia === "function" ? window.matchMedia(q).matches : false);
  const [narrow, setNarrow] = useState(get);
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const m = window.matchMedia(q);
    const on = () => setNarrow(m.matches);
    m.addEventListener?.("change", on);
    return () => m.removeEventListener?.("change", on);
  }, []);
  return narrow;
}

/* ============================================================================
   The page.
   ========================================================================== */
/** Per-history-entry list scroll (keyed by location.key): Back to a Tasks
 *  entry — from another page, or from a pushed narrow / board detail —
 *  returns to the list's scroll position (brief: "back returns to the prior
 *  list, filters and scroll"). */
const LIST_SCROLL_PREFIX = "orcha:v2:tasks:scroll:";
/** Overlays that own Escape while open — the page must not also close the detail. */
const DETAIL_OVERLAYS = ".v2-overlay, .overlay.show, .v2-popover, .att-lightbox, .dfv-full";
/** The element that scrolls the task list: the split list pane when it
 *  scrolls itself, else the main panel / window. */
function listScroller(): HTMLElement | null {
  const el = typeof document !== "undefined" ? document.querySelector<HTMLElement>(".tl-page .v2-split-list") : null;
  if (!el || el.scrollHeight <= el.clientHeight) return null;
  try {
    return getComputedStyle(el).overflowY === "visible" ? null : el;
  } catch {
    return el;
  }
}
export function readListScroll(): number {
  const el = listScroller();
  return el ? el.scrollTop : mainScrollTop();
}
function writeListScroll(y: number): void {
  const el = listScroller();
  if (el) el.scrollTop = y;
  else scrollMainTo(y);
}
function saveListScroll(key: string, y: number): void {
  try {
    sessionStorage.setItem(LIST_SCROLL_PREFIX + key, String(Math.round(y)));
  } catch {
    /* private mode */
  }
}
function loadListScroll(key: string): number | null {
  try {
    const v = sessionStorage.getItem(LIST_SCROLL_PREFIX + key);
    if (v == null) return null;
    const y = Number(v);
    return Number.isFinite(y) ? y : null;
  } catch {
    return null;
  }
}
/** Applied snapshot refreshes to wait for a just-created task before "not found". */
export const JUST_CREATED_BUMPS = 3;

export function TasksPage() {
  const { snap, bump, refresh, errorKind } = useSnapshot();
  const location = useLocation();
  const navigate = useNavigate();
  const narrow = useNarrow();
  const params = useMemo(() => new URLSearchParams(location.search), [location.search]);
  const urlTask = params.get("task");
  const query: TaskQuery = useMemo(() => parseTaskQuery(location.search), [location.search]);
  const [sel, setSel] = useState<string | null>(urlTask);
  const [closed, setClosed] = useState(false);
  const [tasksShown, setTasksShown] = useState(TASKS_PAGE);
  // optimistic one-shot: tasks acted on THIS session — suppress the gate
  // immediately so the 3s repaint can't double-submit (mirrors D2/ISS-41).
  const [acted, setActed] = useState<Set<string>>(() => new Set());
  const [newTaskOpen, setNewTaskOpen] = useState(() => params.get("new") === "1");
  const createdRef = useRef(false);
  // A task created here is selected before the snapshot carries it: until the
  // next few applied refreshes (bump) land, show a loading skeleton in the
  // inspector instead of a false "Task not found".
  const [justCreated, setJustCreated] = useState<{ id: string; bump: number } | null>(null);
  const [qDraft, setQDraft] = useState(query.q);
  // ISS-68: per-task FULL-thread cache (the snapshot ships only a
  // message_summary); refetched when the summary count outgrows the cache.
  const threadsRef = useRef<Record<string, ThreadMsg[]>>({});
  const threadLoadingRef = useRef<Record<string, boolean>>({});
  // GH #74: per-task thread-fetch error LATCH. Set when a fetch fails (network/non-200) OR
  // comes back empty while the snapshot says count>0 (a data inconsistency). While latched,
  // the poll-driven effect below stops auto-retrying — an explicit Retry click clears it.
  const threadErrorRef = useRef<Record<string, boolean>>({});
  const [, setThreadTick] = useState(0);
  const toast = useToast();

  // deep link (`/tasks?task=…`) — external URL changes select the task.
  useEffect(() => {
    if (urlTask) {
      setSel(urlTask);
      setClosed(false);
    } else {
      // Back / the in-app ← dropped ?task= (a pushed narrow or board full
      // view): clear the selection so the list — and its scroll — return.
      setSel(null);
    }
  }, [urlTask]);
  // palette "New task" (`/tasks?new=1`) — also when already on /tasks
  useEffect(() => {
    if (params.get("new") === "1") setNewTaskOpen(true);
  }, [params]);
  // external q changes (Back/forward) resync the search box
  useEffect(() => {
    setQDraft(query.q);
  }, [query.q]);

  const replaceSearch = useCallback(
    (patch: Record<string, string | null | undefined>) => {
      navigate({ pathname: location.pathname, search: patchSearch(location.search, patch) }, { replace: true, state: location.state });
    },
    [navigate, location.pathname, location.search, location.state],
  );

  // debounce search → URL (replace; Back returns to the previous page, not every keystroke)
  useEffect(() => {
    if (qDraft === query.q) return;
    const h = setTimeout(() => {
      replaceSearch({ q: qDraft.trim() ? qDraft : null });
      setTasksShown(TASKS_PAGE);
    }, 200);
    return () => clearTimeout(h);
  }, [qDraft, query.q, replaceSearch]);

  const tasks = useMemo(() => snap?.tasks ?? [], [snap]);
  const filtered = useMemo(() => filterTasks(tasks, query), [tasks, query]);
  const selValid = sel != null && tasks.some((x) => x.id === sel);
  const sortSt = sortFromKey(query.sort);
  const sortKey: SortKey = keyFromSort(sortSt);
  const sorted = useMemo(
    () => filtered.slice().sort(taskComparator(sortSt, query.group === "status")),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [filtered, sortKey, query.group],
  );
  const splitMode = !narrow && !query.full && query.view !== "board";
  // TSK-004 (parity with the old default selection): with no explicit choice
  // (no ?task=, no row picked, inspector not closed) the split list opens the
  // first task that waits on a human decision — needs_verification first, then
  // a pending plan — in the list's own order, so its Accept / Reject gate is
  // one glance away on load. Derived, never written to the URL. Unlike the old
  // UI there is no "first row" fallback: with nothing to decide the list keeps
  // its full width (Linear "My issues", review M4), and a filtered-out task is
  // never picked (it comes from the filtered + sorted rows).
  const defaultTask =
    snap && splitMode && !urlTask && sel == null && !closed
      ? sorted.find((x) => x.status === "needs_verification") || sorted.find((x) => pendingPlan(x)) || null
      : null;
  const selTask = selValid && !closed ? tasks.find((x) => x.id === sel) || null : defaultTask;
  const awaitingNew = !!(justCreated && urlTask === justCreated.id && !selValid && bump - justCreated.bump < JUST_CREATED_BUMPS);
  const missing = !!(snap && urlTask && sel === urlTask && !selValid);
  // In the split list, a selected task the current search/filters hide closes
  // the inspector (the list would otherwise say "No tasks match" beside it);
  // a note above the list names it and offers Clear filters. Full view /
  // narrow detail replace the list, so filters don't apply there.
  const hiddenSel = selTask && splitMode && !filtered.some((x) => x.id === selTask.id) ? selTask : null;
  const t = hiddenSel ? null : selTask;
  const effSel = t ? t.id : null;
  const detailOpen = !!t || missing;

  // GH #74: fetch the selected task's full thread, latching a failure so the 3s poll can't
  // hammer a persistently-failing endpoint. `manual` (from the Retry click) clears the latch
  // and forces a refetch even when nothing new is expected; auto (poll-driven) calls stay
  // suppressed while already loading, already current, OR while the latch is set.
  const loadThread = (tid: string, agents: Snapshot["agents"], manual?: boolean) => {
    const task = tasks.find((x) => x.id === tid);
    const want = task?.message_summary?.count || 0;
    const have = (threadsRef.current[tid] || []).length;
    if (threadLoadingRef.current[tid]) return;
    if (manual) {
      threadErrorRef.current[tid] = false;
    } else if (have >= want || threadErrorRef.current[tid]) {
      return; // current, or failed-awaiting-explicit-retry
    }
    threadLoadingRef.current[tid] = true;
    setThreadTick((n) => n + 1); // repaint into the loading state
    threadOf(tid, agents)
      .then((th) => {
        threadLoadingRef.current[tid] = false;
        // Inconsistency: the snapshot claims messages exist but the fetch came back empty —
        // treat it as a failure so the user gets a retry rather than a perpetual spinner/empty.
        if (!th.length && want > 0) {
          threadErrorRef.current[tid] = true;
        } else {
          threadsRef.current[tid] = th;
          threadErrorRef.current[tid] = false;
        }
        setThreadTick((n) => n + 1);
      })
      .catch(() => {
        threadLoadingRef.current[tid] = false;
        threadErrorRef.current[tid] = true;
        setThreadTick((n) => n + 1);
      });
  };

  // ISS-68: lazy-fetch the selected task's full thread when the summary count
  // outgrows the cache (auto; GH #74 latch applies).
  useEffect(() => {
    if (!t || !snap) return;
    loadThread(t.id, snap.agents);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [t?.id, t?.message_summary?.count, bump]);

  const select = (id: string) => {
    setClosed(false);
    if (id === effSel && !narrow && query.view !== "board") return;
    setSel(id);
    // board: a card opens the task as a full view (the board keeps its full
    // width instead of being squeezed to 2.5 columns by an inspector).
    const board = query.view === "board";
    const search = patchSearch(location.search, { task: id, tab: null, full: board ? "1" : null, new: null });
    if (narrow || board) {
      // narrow: the detail replaces the list — push, so Back returns to the list
      saveListScroll(location.key || "default", readListScroll());
      navigate({ pathname: "/tasks", search }, { state: { wkFromList: true } });
      scrollMainTo(0);
    } else {
      navigate({ pathname: "/tasks", search }, { replace: true });
    }
  };

  const fromList = !!(location.state as { wkFromList?: boolean } | null)?.wkFromList;
  const closeDetail = () => {
    if (fromList) {
      navigate(-1);
      return;
    }
    setClosed(true);
    setSel(null);
    navigate({ pathname: "/tasks", search: patchSearch(location.search, { task: null, tab: null, full: null }) }, { replace: true });
  };
  const openFull = () => {
    if (!t) return;
    navigate({ pathname: "/tasks", search: patchSearch(location.search, { task: t.id, full: "1" }) }, { state: { wkFromList: true } });
  };

  // List scroll per history entry: remembered while the list is visible,
  // restored once when Back lands on this entry (from another page, or from a
  // pushed narrow / board detail). Nothing is restored until the snapshot's
  // rows have rendered.
  const listVisible = !(narrow && detailOpen) && !(detailOpen && (query.full || query.view === "board"));
  const locKey = location.key || "default";
  const locKeyRef = useRef(locKey);
  locKeyRef.current = locKey;
  const restoredKeyRef = useRef<string | null>(null);
  const hasSnap = !!snap;
  useEffect(() => {
    if (!listVisible) {
      restoredKeyRef.current = null; // the list is hidden — restore again when it returns
      return;
    }
    if (!hasSnap || restoredKeyRef.current === locKey) return;
    restoredKeyRef.current = locKey;
    const y = loadListScroll(locKey);
    if (y == null) {
      // a fresh entry (e.g. a row pick replaced the URL): carry the current position
      saveListScroll(locKey, readListScroll());
      return;
    }
    if (y > 0) requestAnimationFrame(() => writeListScroll(y));
  }, [listVisible, hasSnap, locKey]);
  useEffect(() => {
    if (!listVisible) return;
    let raf = 0;
    const onScroll = (e: Event) => {
      const tg = e.target as Element | Document | null;
      const isList = tg instanceof Element && tg.classList.contains("v2-split-list") && !!tg.closest(".tl-page");
      const isMain = tg === document || (tg instanceof Element && tg.id === "main");
      if (!isList && !isMain) return;
      if (restoredKeyRef.current !== locKeyRef.current) return; // not restored yet — keep the saved value
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => saveListScroll(locKeyRef.current, readListScroll()));
    };
    document.addEventListener("scroll", onScroll, true);
    return () => {
      cancelAnimationFrame(raf);
      document.removeEventListener("scroll", onScroll, true);
    };
  }, [listVisible]);

  // Escape closes the detail (never while typing, in an editor/terminal, or under a dialog).
  // An overlay that closes ITSELF on the same Escape (the diff full view,
  // FilesChanged .dfv-full) may already be gone from the DOM by the time this
  // bubble listener runs — so the overlay check is taken in the CAPTURE phase,
  // before any handler reacts to the key (TSK-129).
  const overlayAtKeyRef = useRef(false);
  useEffect(() => {
    if (!detailOpen) return;
    const onCapture = (e: KeyboardEvent) => {
      if (e.key === "Escape") overlayAtKeyRef.current = !!document.querySelector(DETAIL_OVERLAYS);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      const hadOverlay = overlayAtKeyRef.current;
      overlayAtKeyRef.current = false;
      if (hadOverlay) return;
      if (isEditingTarget(document.activeElement)) return;
      if (document.querySelector(DETAIL_OVERLAYS)) return;
      closeDetail();
    };
    document.addEventListener("keydown", onCapture, true);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onCapture, true);
      document.removeEventListener("keydown", onKey);
    };
  });

  // Linear list keys from anywhere on the page (focus not in a field, the
  // detail or a dialog): j/k (and ↑/↓ when nothing is focused) move through the
  // visible rows. With the inspector open the move SELECTS (the preview
  // follows); otherwise it only moves focus, Enter opens.
  useEffect(() => {
    if (query.view === "board" || query.full || (narrow && detailOpen)) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
      const vim = e.key === "j" || e.key === "k";
      const arrow = e.key === "ArrowDown" || e.key === "ArrowUp";
      if (!vim && !arrow) return;
      const ae = document.activeElement as HTMLElement | null;
      if (isEditingTarget(ae)) return;
      if (ae?.hasAttribute("data-v2-row")) return; // the list's own handler runs
      if (arrow && ae && ae !== document.body) return; // arrows keep their native meaning elsewhere
      if (ae?.closest("#detailMain") && !vim) return;
      if (document.querySelector(DETAIL_OVERLAYS)) return;
      const list = document.querySelector<HTMLElement>("#tlist .tl-list");
      if (!list) return;
      const rows = Array.from(list.querySelectorAll<HTMLElement>("[data-v2-row]"));
      if (!rows.length) return;
      const cur = effSel ? rows.findIndex((r) => r.getAttribute("data-id") === effSel) : -1;
      const down = e.key === "j" || e.key === "ArrowDown";
      const j = cur < 0 ? 0 : Math.max(0, Math.min(rows.length - 1, cur + (down ? 1 : -1)));
      e.preventDefault();
      const row = rows[j];
      row.focus();
      row.scrollIntoView?.({ block: "nearest" });
      const id = row.getAttribute("data-id");
      if (detailOpen && !narrow && id) select(id);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  });

  // prune: a task stays suppressed only while it is still at the gate it was
  // acted on (plan pending / needs_verification). Once the snapshot shows it
  // left that state, drop it so a re-raised gate renders again (QA).
  useEffect(() => {
    setActed((prev) => {
      if (!prev.size) return prev;
      const atGate = new Set(
        (snap?.tasks ?? []).filter((t) => t.status === "needs_verification" || pendingPlan(t)).map((t) => String(t.id)),
      );
      const next = new Set([...prev].filter((id) => atGate.has(String(id))));
      return next.size === prev.size ? prev : next;
    });
  }, [snap]);

  const markActed = (id: string) =>
    setActed((prev) => {
      const next = new Set(prev);
      next.add(id);
      return next;
    });

  const authority = useActingAuthority();
  // a read-only viewer / offline session never gets an enabled "New task"
  const canCreate = !!actingHuman(snap) && !authority.readOnly;
  const noHuman = useNoHumanReason();
  // ISS-68 PR-3: cap to the top-N, then group THAT subset so the groups stay
  // consistent with what's shown; "Load more" reveals the next page. A
  // selected task beyond the window is appended so it stays reachable.
  const head = sorted.slice(0, tasksShown);
  const selBeyond = t && !head.some((x) => x.id === t.id) && sorted.some((x) => x.id === t.id) ? t : null;
  const capped = selBeyond ? head.concat(selBeyond) : head;
  const groups = groupTasks(capped, query.group);
  const statusCounts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const x of tasks) {
      const k = GRP.some((g) => g.k === x.status) ? x.status : "other";
      c[k] = (c[k] || 0) + 1;
    }
    return c;
  }, [tasks]);
  const level = autLevel(snap);
  const assignees = useMemo(() => (snap?.agents ?? []).map((a) => a.alias).sort((a, b) => a.localeCompare(b)), [snap]);
  const reviewOn = reviewerSupported(snap);
  const truncated = snap?.task_total != null && snap.task_total > tasks.length;
  const nFilters = activeFilterCount(query);

  const setSort = (k: SortKey) => {
    // URL is the source of truth; the local key keeps the choice as the default next time
    try {
      const [key, dir] = k.split("-");
      localStorage.setItem("orcha:sort:" + SORT_NAME, JSON.stringify({ key, dir }));
    } catch {
      /* private mode */
    }
    replaceSearch({ sort: k });
  };

  // row ⋯ → "Make recurring…" (a routine pre-filled as a COPY of the task)
  const recurGate = useMakeRecurringGate();
  const [recurTask, setRecurTask] = useState<Task | null>(null);
  const rowMenu = (x: Task) => {
    const item = makeRecurringItem(recurGate, () => setRecurTask(x), x);
    return item ? [item] : null;
  };

  const [density, setDensity] = useDensity();
  const phone = usePhone();
  const compact = density === "compact";
  const clearFilters = () => {
    setQDraft("");
    replaceSearch({ q: null, status: null, assignee: null });
  };
  const setStatus = (v: string[]) => {
    replaceSearch({ status: v.length ? v.join(",") : null });
    setTasksShown(TASKS_PAGE);
  };
  const setAssignee = (v: string | null) => {
    replaceSearch({ assignee: v || null });
    setTasksShown(TASKS_PAGE);
  };

  const trow = (x: Task) => (
    <TaskRow
      menu={rowMenu(x)}
      key={x.id}
      t={x}
      snap={snap}
      selected={x.id === effSel}
      onSelect={select}
      compact={compact}
      groupedBy={query.group}
      reviewOn={reviewOn}
      level={level}
      phone={phone}
    />
  );

  const listPane = (
    <>
      {hiddenSel ? (
        <div className="wk-note tl-hiddensel" role="note" data-hidden-selection="true">
          <span className="tl-hiddensel-txt">
            <span className="tl-hiddensel-title" title={hiddenSel.title}>{hiddenSel.title}</span>
            <span className="tl-hiddensel-why">is hidden by the current filters</span>
          </span>
          <Button variant="link" size="sm" onClick={clearFilters}>Clear filters</Button>
          <Button variant="link" size="sm" onClick={closeDetail}>Close</Button>
        </div>
      ) : null}
      {truncated ? (
        <div className="wk-note" role="note">
          Showing the first <b>{tasks.length}</b> of <b>{snap?.task_total}</b> tasks (snapshot limit) — search and filters apply to the loaded tasks only.
        </div>
      ) : null}
      {!snap && (errorKind === "forbidden" || errorKind === "not_found") ? (
        // Orcha answered 403 / 404: not an outage — say what it is (Retry can't
        // help; the shell's banner carries the way out to All projects)
        <EmptyState
          icon="alert"
          title={errorKind === "forbidden" ? "You're not a member of this project" : "Project not found"}
          body={
            errorKind === "forbidden"
              ? "Ask a project owner for an invite to see its tasks."
              : "The link points at a project that doesn't exist or was removed."
          }
        />
      ) : !snap ? (
        <SnapshotPending lines={6} label="Loading tasks" what="tasks" />
      ) : query.view === "board" ? (
        <TaskBoard tasks={sorted} selected={effSel} onSelect={select} snap={snap} reviewOn={reviewOn} level={level} statusFilter={query.status} onAdd={canCreate ? () => setNewTaskOpen(true) : undefined} />
      ) : groups.length ? (
        <>
          <TaskGroups
            groups={groups}
            groupBy={query.group}
            snap={snap}
            renderRow={trow}
            onMove={detailOpen && !narrow ? select : undefined}
            onAdd={canCreate ? () => setNewTaskOpen(true) : undefined}
            addLabel="New task"
          />
          {sorted.length > head.length ? (
            <Button variant="ghost" className="wk-more" data-loadmore="true" onClick={() => setTasksShown((n) => n + TASKS_PAGE)}>
              Load more · {head.length} of {sorted.length}
            </Button>
          ) : null}
        </>
      ) : tasks.length ? (
        <EmptyState
          title="No tasks match these filters"
          body={nFilters ? `${tasks.length} task${tasks.length === 1 ? " is" : "s are"} hidden by the current search or filters.` : undefined}
          action={
            <Button variant="secondary" icon="x" onClick={clearFilters}>
              Clear filters
            </Button>
          }
        />
      ) : (
        <EmptyState
          title="No tasks yet"
          body="Give it a clear definition of done and assign it to an agent."
          action={
            <Button variant="primary" icon="plus" data-newtask-empty="true" disabled={!canCreate} title={canCreate ? undefined : noHuman} onClick={() => setNewTaskOpen(true)}>
              New task
            </Button>
          }
        />
      )}
    </>
  );

  const threadCache: ThreadCache | null = t
    ? {
        msgs: threadsRef.current[t.id] || [],
        loading: !!threadLoadingRef.current[t.id],
        errored: !!threadErrorRef.current[t.id],
        retry: () => snap && loadThread(t.id, snap.agents, true),
      }
    : null;

  // board selections and ?full=1 render the task as a full view (list hidden)
  const fullView = detailOpen && (query.full || query.view === "board");
  // "1 / N ↑ ↓" over the current filtered + sorted list (Linear detail pager)
  const pos = t ? sorted.findIndex((x) => x.id === t.id) : -1;
  const goTo = (id: string) => {
    setSel(id);
    setClosed(false);
    navigate({ pathname: "/tasks", search: patchSearch(location.search, { task: id, tab: null, new: null }) }, { replace: true, state: location.state });
    scrollMainTo(0);
  };
  const pager: DetailPager | null =
    t && pos >= 0
      ? {
          index: pos,
          total: sorted.length,
          onPrev: pos > 0 ? () => goTo(sorted[pos - 1].id) : undefined,
          onNext: pos < sorted.length - 1 ? () => goTo(sorted[pos + 1].id) : undefined,
        }
      : null;
  const backLabel = fullView && query.view === "board" ? "Back to board" : "Back to tasks";
  const inspector = detailOpen ? (
    <div id="detailMain">
      <TaskDetailPane
        t={t}
        mode={fullView ? "full" : narrow ? "narrow" : "inspector"}
        onClose={fullView || narrow ? undefined : closeDetail}
        onExpand={t && !fullView && !narrow ? openFull : undefined}
        onBack={fullView || narrow ? closeDetail : undefined}
        backLabel={backLabel}
        pager={pager}
        tab={query.tab}
        onTab={(k) => replaceSearch({ tab: k })}
        acted={t ? acted.has(t.id) : false}
        onActed={markActed}
        thread={threadCache}
      >
        {missing && awaitingNew ? (
          <div className="tl-newpending" data-new-task-pending="true">
            <Skeleton lines={4} label="Loading the new task" />
          </div>
        ) : missing ? (
          <EmptyState
            title="Task not found"
            body={
              truncated
                ? `Task ${shortId(urlTask)} isn't among the ${tasks.length} tasks loaded (the project has ${snap?.task_total}). It may be beyond the snapshot limit, or it no longer exists.`
                : `Task ${shortId(urlTask)} isn't in this project — it may have been removed, or the link points at a different project.`
            }
            action={<Button variant="secondary" icon="arrow-left" onClick={closeDetail}>{backLabel}</Button>}
          />
        ) : null}
      </TaskDetailPane>
    </div>
  ) : null;

  const newTaskBtn = (
    <Button
      variant="primary"
      icon="plus"
      data-newtask="true"
      aria-keyshortcuts="c"
      disabled={!canCreate}
      title={canCreate ? "Create a new task (C)" : noHuman}
      onClick={() => {
        if (!canCreate) {
          toast(noHuman, "danger");
          return;
        }
        setNewTaskOpen(true);
      }}
    >
      New task
    </Button>
  );

  const showToolbar = !fullView && !(narrow && detailOpen);
  const toolbar = showToolbar ? (
    <TasksToolbar
      query={query}
      qDraft={qDraft}
      setQDraft={setQDraft}
      statusCounts={statusCounts}
      loaded={!!snap}
      assignees={assignees}
      setStatus={setStatus}
      setAssignee={setAssignee}
      setView={(v) => replaceSearch({ view: v })}
      setGroup={(g) => replaceSearch({ group: g })}
      sortKey={sortKey}
      setSort={setSort}
      density={density}
      setDensity={setDensity}
      nFilters={nFilters}
      shown={filtered.length}
      total={tasks.length}
      clearFilters={clearFilters}
    />
  ) : undefined;

  return (
    <Shell page="tasks" title="Tasks" primaryAction={newTaskBtn} toolbar={toolbar} flush>
      <style>{tasksPageCss}</style>
      <style>{workCss}</style>
      <style>{tasksListCss}</style>
      <style>{taskDetailCss}</style>
      {fullView ? (
        // full view: the detail pane fills the panel (its own header row holds the way back)
        <div className="wk-full">{inspector}</div>
      ) : (
        <div className={"wk-page tl-page" + (query.view === "board" ? " is-board" : "")}>
          {/* narrow: the detail replaces the list; its header row carries the way back */}
          {query.view === "board" ? (
            <div className="wk-boardwrap tl-boardwrap" id="tlist">{listPane}</div>
          ) : (
            <SplitPane list={<div id="tlist">{listPane}</div>} inspector={inspector} storageKey="orcha:v2:tasksInspector" defaultSize={520} min={380} max={900} label="Resize task detail" />
          )}
        </div>
      )}
      {recurTask ? <MakeRecurringDialog task={recurTask} onClose={() => setRecurTask(null)} /> : null}
      {newTaskOpen && (
        <NewTaskModal
          initialAssignee={params.get("for")}
          onClose={() => {
            setNewTaskOpen(false);
            const created = createdRef.current;
            createdRef.current = false;
            if (created) return; // onCreated already rewrote the URL to the new task
            const sp = new URLSearchParams(location.search);
            if (!(sp.get("new") || sp.get("for"))) return;
            // Cancelled a composer that was PUSHED here (sidebar compose, an
            // Overview "New task", the palette): go back to where the user was
            // instead of stranding them on Tasks. A cold deep link has no
            // history entry to return to, so it just drops the param.
            if (location.key && location.key !== "default") navigate(-1);
            else replaceSearch({ new: null, for: null });
          }}
          onCreated={(taskId) => {
            createdRef.current = true;
            if (!taskId) {
              const sp = new URLSearchParams(location.search);
              if (sp.get("new") || sp.get("for")) replaceSearch({ new: null, for: null });
            }
            // the new task may not be in the local snapshot yet — set the
            // selection; the poll's snapshot pick-up preserves it once real.
            if (taskId) {
              setJustCreated({ id: taskId, bump });
              void refresh();
              setSel(taskId);
              setClosed(false);
              navigate({ pathname: "/tasks", search: patchSearch(location.search, { task: taskId, new: null, for: null }) }, { replace: true });
            }
          }}
        />
      )}
    </Shell>
  );
}
