/* Orcha shared portal module: persisted time/priority sorting for list surfaces. */
document.addEventListener("click", onRunStopClick);

/* ---------- ISS-331: reusable sort control (Time/Priority + asc/desc) ----------
   ONE implementation shared by all five list surfaces (Tasks list, Requests list, and the
   agent-detail current-tasks / incoming / outgoing lists) — never forked. Each surface
   instantiates it with a stable `name` (its own persisted choice) and passes field accessors
   {bucket,time,prio}; the control owns the UI, the localStorage state, and the comparator.
   Semantics MIRROR the server _sort_clause: the status `bucket` stays the OUTER key (open /
   needs-attention first), the chosen key sorts WITHIN it, the unchosen key is the tiebreaker.
   The explicit choice supersedes the ISS-83 recency-band heuristic within a group. */
const SORT_DEFAULT = { key: "time", dir: "desc" };   // "Time-sort is the higher-priority key"
function sortState(name) {
  try {
    const raw = JSON.parse(localStorage.getItem("orcha:sort:" + name) || "null");
    if (raw && (raw.key === "time" || raw.key === "priority") && (raw.dir === "asc" || raw.dir === "desc")) return raw;
  } catch (e) {}
  return { key: SORT_DEFAULT.key, dir: SORT_DEFAULT.dir };
}
function setSortState(name, st) {
  try { localStorage.setItem("orcha:sort:" + name, JSON.stringify(st)); } catch (e) {}
}
function sortControlHtml(name) {
  const st = sortState(name);
  const arrow = st.dir === "asc" ? "↑" : "↓";
  const dirLabel = st.key === "time"
    ? (st.dir === "asc" ? "oldest first" : "newest first")
    : (st.dir === "asc" ? "highest priority first" : "lowest priority first");
  return `<span class="sortctl" data-sort="${esc(name)}" role="group" aria-label="Sort order">`
    + `<button type="button" data-sort-key="time" class="${st.key === "time" ? "on" : ""}" aria-pressed="${st.key === "time"}">Time</button>`
    + `<button type="button" data-sort-key="priority" class="${st.key === "priority" ? "on" : ""}" aria-pressed="${st.key === "priority"}">Priority</button>`
    + `<button type="button" class="sortdir" data-sort-dir aria-label="Toggle direction — ${dirLabel}" title="${dirLabel}">${arrow}</button>`
    + `</span>`;
}
// comparator mirroring server _sort_clause; acc = {bucket(item)->int, time(item)->ms, prio(item)->number}
function sortComparator(name, acc) {
  const st = sortState(name);
  const sign = st.dir === "asc" ? 1 : -1;
  const bucket = acc.bucket || (() => 0);
  return (a, b) => {
    const bk = bucket(a) - bucket(b);
    if (bk) return bk;
    if (st.key === "priority") {
      const d = acc.prio(a) - acc.prio(b);     // lower number = higher priority
      if (d) return sign * d;
      return acc.time(b) - acc.time(a);        // tiebreak: newest first
    }
    const d = acc.time(a) - acc.time(b);
    if (d) return sign * d;                    // asc = oldest first, desc = newest first
    return acc.prio(a) - acc.prio(b);          // tiebreak: highest priority first
  };
}
// Delegate clicks for ANY .sortctl under `root` (one binding handles multiple controls, e.g.
// the three agent-detail lists). Idempotent: re-calls on a re-rendered surface are no-ops since
// `root` (a stable container node, not the replaced control markup) keeps the listener.
function wireSortControl(root, onChange) {
  if (!root || root._sortWired) return;
  root._sortWired = true;
  root.addEventListener("click", (ev) => {
    const ctl = ev.target.closest(".sortctl[data-sort]");
    if (!ctl) return;
    const keyBtn = ev.target.closest("[data-sort-key]");
    const dirBtn = ev.target.closest("[data-sort-dir]");
    if (!keyBtn && !dirBtn) return;
    const name = ctl.getAttribute("data-sort");
    const st = sortState(name);
    if (keyBtn) {
      const k = keyBtn.getAttribute("data-sort-key");
      if (k === st.key) return;                 // no-op click on the already-active key
      st.key = k; st.dir = k === "time" ? "desc" : "asc";   // reset to the key's natural default
    } else {
      st.dir = st.dir === "asc" ? "desc" : "asc";
    }
    setSortState(name, st);
    if (onChange) onChange(name, st);
  });
}
