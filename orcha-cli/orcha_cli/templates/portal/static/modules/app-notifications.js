/* Orcha shared portal module: needs-you rows, activity feed, and read state. */
// The badge stays the NEEDS-YOU count ONLY — informational noise never inflates it.
const NC_PAGE = 20;   // EARLIER page size
let _ncOpen = false;
// rows: cached EARLIER feed page(s); beforeTs/beforeId: keyset cursor for "Load earlier".
let _ncFeed = { rows: [], readThrough: 0, beforeTs: null, beforeId: null,
                more: false, loaded: false, loading: false };

// type -> {icon, col} for the EARLIER zone. Unknown/future types DEGRADE GRACEFULLY to a
// neutral dot + humanised label (forward-compat, mirrors presenceOf()) — a new registry
// type never breaks the panel.
const NC_VIS = {
  task_verified:    { icon: "check",    col: "violet" },
  request_answered: { icon: "arrow",    col: "info" },
  plan_decided:     { icon: "shield",   col: "violet" },
  task_assigned:    { icon: "tasks",    col: "info" },
  task_ready:       { icon: "tasks",    col: "info" },
  task_message:     { icon: "requests", col: "info" },
  task_unassigned:  { icon: "x",        col: "idle" },
  request_closed:   { icon: "check",    col: "idle" },
};
const NC_LABEL = {
  task_verified: "Task verified", request_answered: "Request answered",
  plan_decided: "Decision made", task_assigned: "Task assigned",
  task_ready: "Task ready", task_message: "Task update",
  task_unassigned: "Task unassigned", request_closed: "Request closed",
};
function ncHumanize(s) {
  return String(s || "notification").replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());
}
function ncDeeplinkHref(d) {
  if (!d || !d.id) return null;
  if (d.kind === "task") return "/tasks?task=" + encodeURIComponent(d.id);
  if (d.kind === "request") return "/requests?req=" + encodeURIComponent(d.id);
  return null;   // 'decision' / unknown kinds have no standalone page — row stays non-clickable
}
function ncIcon(name, col) {
  const cls = "ic c-" + col;
  // name === null → neutral dot (graceful degrade for an unknown type)
  if (!name) return `<span class="${cls}"><span class="ncdot"></span></span>`;
  return `<span class="${cls}">${icon(name, "")}</span>`;
}

// NEEDS YOU rows from the live action queue (attnItems) — authoritative + snapshot-fresh.
function ncNeedsRows() {
  const a = attnItems();
  const rows = [];
  a.plans.forEach((t) => {
    const pm = planMessageOf(t);
    rows.push({ icon: "shield", col: "warn",
      ti: "Plan approval · " + (t.title || t.id), me: t.assignee || "—",
      when: (pm && pm.at) || t.started_at, href: "/tasks?task=" + encodeURIComponent(t.id) });
  });
  a.verifs.forEach((t) => {
    rows.push({ icon: "check", col: "warn",
      ti: "Verify task · " + (t.title || t.id), me: t.assignee || "—",
      when: t.started_at, href: "/tasks?task=" + encodeURIComponent(t.id) });
  });
  a.escs.forEach((r) => {
    rows.push({ icon: "flag", col: "danger",
      ti: "Escalation · " + trunc(r.payload || "", 52), me: (r.from || "—") + " → you",
      when: r.created_at, href: "/requests?req=" + encodeURIComponent(r.id) });
  });
  return rows;
}

// EARLIER rows from the cached registry feed. ts is epoch SECONDS — convert to ms for relTime.
function ncEarlierRows() {
  return _ncFeed.rows.map((n) => {
    const vis = NC_VIS[n.type] || { icon: null, col: "idle" };
    const label = NC_LABEL[n.type] || ncHumanize(n.type);
    const ti = n.preview ? label + " · " + trunc(n.preview, 52) : label;
    return { icon: vis.icon, col: vis.col, unread: !n.read, ti: ti,
      me: n.actor_alias || "", when: n.ts != null ? n.ts * 1000 : null,
      href: ncDeeplinkHref(n.deeplink) };
  });
}

function ncRowHTML(r) {
  const when = r.when != null ? relTime(r.when) : "";
  const go = r.href ? `<span class="go">${icon("chev", "")}</span>` : "";
  const tag = r.href ? "a" : "div";
  const hattr = r.href ? ` href="${r.href}"` : "";
  return `<${tag} class="nrow${r.unread ? " unread" : ""}"${hattr}>
    ${ncIcon(r.icon, r.col)}
    <div class="b"><div class="ti">${esc(r.ti)}</div>
      <div class="me">${r.me ? esc(r.me) + "<span>·</span>" : ""}<span class="when">${esc(when)}</span></div></div>
    ${go}</${tag}>`;
}

function ncRenderPanel() {
  const float = document.getElementById("ncFloat");
  if (!float) return;
  const needs = ncNeedsRows();
  const earlier = ncEarlierRows();
  const needsHTML = needs.length
    ? needs.map(ncRowHTML).join("")
    : '<div class="nc-empty">✓ You\'re all caught up.</div>';
  let earlierHTML;
  if (!actingHuman()) {
    earlierHTML = '<div class="nc-empty">Pick an acting human to see your activity feed.</div>';
  } else if (!_ncFeed.loaded && _ncFeed.loading) {
    earlierHTML = '<div class="nc-empty">Loading…</div>';
  } else if (!earlier.length) {
    earlierHTML = '<div class="nc-empty">Nothing earlier.</div>';
  } else {
    earlierHTML = earlier.map(ncRowHTML).join("");
  }
  const foot = _ncFeed.more ? '<div class="nc-foot" id="ncMore">… Load earlier</div>' : "";
  float.innerHTML = `
    <div class="nc-h"><h3>Notifications</h3><span class="mark" id="ncMark">Mark all read</span></div>
    <div class="nc-zlbl needs">● Needs you <span class="ct">(${needs.length})</span></div>
    <div class="nc-list">${needsHTML}</div>
    <div class="nc-zlbl">Earlier</div>
    <div class="nc-list">${earlierHTML}</div>
    ${foot}`;
  const mark = document.getElementById("ncMark");
  if (mark) mark.addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); ncMarkAllRead(); });
  const more = document.getElementById("ncMore");
  if (more) more.addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); ncLoadFeed(false); });
}

// Fetch the EARLIER feed. reset=true → first page (panel open / refresh); else paginate
// backward from the stored keyset cursor ("Load earlier").
function ncLoadFeed(reset) {
  const who = actingHuman();
  if (!who) { ncRenderPanel(); return; }
  if (_ncFeed.loading) return;
  if (reset) { _ncFeed.beforeTs = null; _ncFeed.beforeId = null; }
  _ncFeed.loading = true;
  if (reset) ncRenderPanel();   // surface "Loading…" on first open
  let url = "/api/agents/" + encodeURIComponent(who.id) + "/notifications?zone=earlier&limit=" + NC_PAGE;
  if (!reset && _ncFeed.beforeTs != null) {
    url += "&before_ts=" + encodeURIComponent(_ncFeed.beforeTs);
    if (_ncFeed.beforeId != null) url += "&before_id=" + encodeURIComponent(_ncFeed.beforeId);
  }
  fetch(url)
    .then((r) => { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); })
    .then((res) => {
      const rows = res.notifications || [];
      _ncFeed.rows = reset ? rows : _ncFeed.rows.concat(rows);
      _ncFeed.readThrough = res.read_through_ts || 0;
      _ncFeed.beforeTs = res.next_before_ts;
      _ncFeed.beforeId = res.next_before_id;
      _ncFeed.more = res.next_before_ts != null;
      _ncFeed.loaded = true;
      _ncFeed.loading = false;
      ncRenderPanel();
    })
    .catch((e) => {
      _ncFeed.loading = false;
      _ncFeed.loaded = true;
      ncRenderPanel();
      toast("Could not load notifications: " + e.message, "danger");
    });
}

function ncMarkAllRead() {
  const who = actingHuman();
  if (!who) return;
  _ncFeed.rows.forEach((n) => { n.read = true; });   // optimistic — NEEDS YOU rows never clear here
  ncRenderPanel();
  fetch("/api/agents/" + encodeURIComponent(who.id) + "/notifications/read", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
  })
    .then((r) => { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); })
    .then((res) => { _ncFeed.readThrough = res.read_through_ts || _ncFeed.readThrough; })
    .catch((e) => { toast("Could not mark read: " + e.message, "danger"); });
}

// Inject the floating panel once + wire outside-click / Escape to close.
function ensureNcFloat() {
  if (document.getElementById("ncFloat")) return;
  const float = document.createElement("div");
  float.id = "ncFloat";
  float.className = "ncenter float";
  document.body.appendChild(float);
  // Outside-click closes (mirrors the modal dismiss). Guard on the pill so the toggle
  // click that opened it doesn't immediately re-close it.
  document.addEventListener("click", (e) => {
    if (!_ncOpen) return;
    const pill = document.getElementById("attnPill");
    if (float.contains(e.target) || (pill && pill.contains(e.target))) return;
    ncClose();
  });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") ncClose(); });
}
function ncOpen() {
  ensureNcFloat();
  _ncOpen = true;
  const float = document.getElementById("ncFloat");
  if (float) float.classList.add("show");
  ncRenderPanel();
  ncLoadFeed(true);   // (re)fetch the EARLIER feed fresh each open
}
function ncClose() {
  _ncOpen = false;
  const float = document.getElementById("ncFloat");
  if (float) float.classList.remove("show");
}
function ncToggle() { _ncOpen ? ncClose() : ncOpen(); }

// Wire the topbar pill (called from mountShell after the topbar is rebuilt each page).
function wireNotifPill() {
  ensureNcFloat();
  const pill = document.getElementById("attnPill");
  if (!pill) return;
  pill.addEventListener("click", (e) => { e.preventDefault(); ncToggle(); });
}

// Reconcile on every snapshot: keep the badge (NEEDS-YOU count) fresh and, if the panel
// is open, repaint instantly from the snapshot. (The topbar markup is built once by
// mountShell; before SPEC-3 only autonomy was reconciled, so the pill count went stale.)
function paintNotifications() {
  const pill = document.getElementById("attnPill");
  if (pill) {
    const n = pill.querySelector(".n");
    if (n) n.textContent = String(attnItems().count);
  }
  if (_ncOpen) ncRenderPanel();
}
