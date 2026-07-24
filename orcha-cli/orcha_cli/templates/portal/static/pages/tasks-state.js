/* Tasks page controller: task selection, thread loading, sorting, and list rendering. */
const TasO = window.Orcha;
const Tas$ = (id) => document.getElementById(id);
const TasD = () => window.ORCHA;

let sel = new URLSearchParams(location.search).get("task") || null;
// ISS-68: per-task FULL-thread cache (the snapshot ships only a message_summary now). Keyed by
// task id so it survives the 3s repaint (mapSnapshot rebuilds task objects each poll). Refetched
// when the summary count outgrows the cached thread (a new message landed).
const threadCache = {};
const threadLoading = {};
// #74: per-task thread-fetch error latch. Set when a fetch fails (network/non-200) OR comes back
// empty while the snapshot says count>0 (a data inconsistency). While latched we STOP auto-retrying
// (the render shows a "Failed to load — tap to retry" affordance) so a persistent failure can't hammer
// the endpoint every 3s repaint. Cleared on an explicit retry or once a fetch succeeds with content.
const threadError = {};
// #301: attachment staging for the composer. Files upload immediately on pick/drop/paste; each
// staged entry holds its real server ref once done. Reset when the selected task changes. Survives
// no-op 3s repaints (TasO.patch only re-runs wire() on actual DOM change) and is re-rendered from this
// array inside wire() when the detail DOM IS rebuilt.
let staged = [];          // [{key, name, size, kind, status:'uploading'|'done'|'failed', ref?}]
let stagedTask = null;
let stagedSeq = 0;
// #74: lazy-load a task's full thread. `manual` is an explicit user retry — it clears the error
// latch and refetches even when nothing new is expected. Auto-calls (every repaint) are suppressed
// while loading, while already current, or while the error latch is set (so a failing fetch isn't
// retried on every 3s tick — the user retries via the affordance instead).
function maybeLoadThread(t, manual) {
  const want = (t.message_summary && t.message_summary.count) || 0;
  const have = (threadCache[t.id] || []).length;
  if (threadLoading[t.id]) return;
  if (manual) { threadError[t.id] = false; }
  else if (have >= want || threadError[t.id]) return;   // current / failed-awaiting-retry
  threadLoading[t.id] = true;
  window.OrchaData.threadOf(t.id)
    .then((thread) => {
      threadLoading[t.id] = false;
      // Inconsistency: snapshot claims messages exist but the fetch came back empty — treat as a
      // failure so the user gets a retry rather than a perpetual "Loading thread…".
      if ((!thread || !thread.length) && want > 0) { threadError[t.id] = true; }
      else { threadCache[t.id] = thread; threadError[t.id] = false; }
      if (sel === t.id) renderDetail();
    })
    .catch(() => { threadLoading[t.id] = false; threadError[t.id] = true; if (sel === t.id) renderDetail(); });
}
// optimistic one-shot: tasks acted on THIS session (plan decided / verified). Suppress the
// gate immediately so the 3s repaint can't double-submit before the snapshot reflects it.
// Pruned once the task leaves the actionable set (mirrors D2/ISS-41); plan_decision is the
// DURABLE gate so a decided plan stays a decided-note across reload.
const acted = new Set();
// SPEC-4 protocol panel: per-task UI state (collapse/edit/draft) keyed by task id. detailMain is
// patched as one unit on the 3s tick, so collapse/edit can't live only in CSS classes — they must
// be persisted here and baked into the rendered string each tick. `draft` holds the in-progress
// edit field values (captured on input) so a blurred mid-edit repaint doesn't lose typed text.
const protoUI = {};   // tid -> { collapsed:bool, editing:bool, draft:{review_chain,handoff_to,autonomy,notes}|null }
// ISS-68 PR-3: the list shows the top-N priority-ordered tasks + a "Load more" that reveals the
// next page. A client-side render cap over the (unbounded) snapshot — not a windowed fetch — so a
// deeplinked/selected task beyond the cap still renders in the detail pane (there's no single-task
// GET to back a windowed list). Sticky for the page lifetime; a fresh nav reloads at 10 (Kedar: ok).
let tasksShown = 10;
const TASKS_PAGE = 10;
let stopRuns = null, runsTask = null, runsSig = "", runsToken = 0;

const ORDER = { needs_verification: 0, in_progress: 1, ready: 2, blocked: 3, pending: 4, completed: 5, cancelled: 6, failed: 3 };
const GRP = [
  { k: "needs_verification", label: "Needs verification" },
  { k: "in_progress", label: "In progress" },
  { k: "ready", label: "Ready" },
  { k: "pending", label: "Pending (blocked on deps)" },
  { k: "blocked", label: "Blocked" },
  { k: "failed", label: "Failed" },
  { k: "completed", label: "Done" },
  { k: "cancelled", label: "Cancelled" },
];

function planMsgOf(t) {  // ISS-68: prefer the snapshot's plan_message (thread-free); fall back to an expanded thread
  if (t && t.plan_message) return { body: t.plan_message.body, from: t.plan_message.author_alias || null, at: t.plan_message.at, is_human: false };
  const m = (t.thread || []).filter((x) => !x.is_human); return m.length ? m[0] : null;
}
function pendingPlan(t) { return t.status === "in_progress" && !t.plan_decision && !!planMsgOf(t); }
function firstSel() {
  const ts = TasD().tasks || [];
  return (ts.find((t) => t.status === "needs_verification") || ts.find((t) => pendingPlan(t)) || ts[0] || {}).id || null;
}
// ISS-37: deterministic order — status, then priority, then time. Without the time
// tiebreaker, same-status/same-priority tasks fell back to the snapshot's arbitrary
// array order (re-shuffled every 3s repaint → "order is random"). created_at is the one
// timestamp every task carries; newest-first so fresh work surfaces within a group.
function timeKey(t) { return Date.parse(t.created_at || "") || 0; }
// ISS-83: a task touched within ~12h (created, started, completed, or last-posted) floats to
// the TOP of its status group regardless of priority, then falls back to the priority/time sort.
// Slotted BELOW status so the status grouping stays intact (no task jumps groups).
function recencyBandOf(t) {
  const last = t.message_summary && t.message_summary.last;
  return TasO.recencyBand(t.created_at, t.started_at, t.completed_at, last && last.created_at);
}
// ISS-331: status grouping (ORDER) stays the OUTER key; the shared sort control (TasO.sortComparator)
// picks the within-group key (time|priority) + direction. The explicit choice supersedes the
// ISS-83 recency-band float (recencyBandOf retained for potential group-header copy).
const SORT_NAME = "tasks";
function sortAcc() { return { bucket: (t) => (ORDER[t.status] ?? 9), time: timeKey, prio: (t) => t.priority }; }
function sorted() {
  return (TasD().tasks || []).slice().sort(TasO.sortComparator(SORT_NAME, sortAcc()));
}

/* ---------- task list ---------- */
function trowHtml(t) {
  const who = t.assignee, a = TasO.agentByAlias(who);
  return `<button class="trow ${t.id === sel ? "sel" : ""}" data-id="${TasO.esc(t.id)}">
    ${TasO.pill(t.status)}
    <span class="grow">
      <span class="tt">${t.is_root ? '<span class="tag root" style="margin-right:5px">root</span>' : ""}${TasO.esc(t.title)}</span>
      <span class="tm">${who ? TasO.avatar(who, a ? a.kind : "ai", "sm") : ""}<span class="t2">${TasO.esc(who || "unassigned")}</span>
        <span class="prio ${t.priority<=20?'p-hi':t.priority<=40?'p-md':''}" style="margin-left:auto">P${TasO.esc(t.priority)}</span></span>
    </span></button>`;
}
function renderList() {
  const all = sorted();
  // ISS-68 PR-3: cap to the top-N (priority order), then group THAT subset so the groups stay
  // consistent with what's shown; "Load more" reveals the next page.
  const ts = all.slice(0, tasksShown);
  const grouped = new Set();
  // New-Task affordance — human authority only (POST .../tasks resolves the acting human as
  // created_by). Disabled (not hidden) with a hint when no human is the acting authority.
  const canCreate = !!TasO.actingHuman();
  let html = `<div class="rh"><span class="row" style="gap:7px;align-items:center">${TasO.icon("tasks", "")}Tasks · grouped by status</span><span class="grow" style="flex:1"></span>`
    + `${TasO.sortControlHtml(SORT_NAME)}`
    + `<button class="btn approve sm" data-newtask ${canCreate ? "" : "disabled"} title="${canCreate ? "Create a new task" : "Pick an acting human (top-right) to create tasks"}" style="letter-spacing:0;text-transform:none;margin-left:7px">${TasO.icon("plus", "")}New</button></div>`;
  GRP.forEach((g) => {
    const items = ts.filter((t) => t.status === g.k);
    if (!items.length) return;
    items.forEach((t) => grouped.add(t.id));
    html += `<div class="tgrp"><span>${g.label}</span><span class="ln"></span><span>${items.length}</span></div>`;
    html += items.map(trowHtml).join("");
  });
  // catch-all: any status not in GRP still shows (never silently drop a task)
  const other = ts.filter((t) => !grouped.has(t.id));
  if (other.length) {
    html += `<div class="tgrp"><span>Other</span><span class="ln"></span><span>${other.length}</span></div>`;
    html += other.map(trowHtml).join("");
  }
  if (all.length > ts.length) {
    html += `<button class="btn subtle" style="width:calc(100% - 12px);margin:10px 6px 4px" data-loadmore>Load more · ${ts.length} of ${all.length}</button>`;
  }
  TasO.patch(Tas$("tlist"), html);
}

/* ---------- detail (snapshot sections, re-rendered every tick) ---------- */
