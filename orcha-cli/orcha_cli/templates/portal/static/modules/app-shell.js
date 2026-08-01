/* Orcha shared portal module: sidebar, topbar, global search, and navigation chrome. */

/* ---- shell ----------------------------------------------------------- */
/* ---- collapsible sidebar (icon rail) --------------------------------- *
 * Browser-local, same contract as the theme/skin picks: persisted in
 * localStorage "orcha:sidebar" and applied pre-paint by each page's <head>
 * script as data-sidebar="collapsed" on <html>, so the rail never flashes
 * at the wrong width. CSS owns both layouts; the toggle just flips state
 * (no re-render needed — the same DOM serves both). */
function sidebarCollapsed() {
  try { return localStorage.getItem("orcha:sidebar") === "collapsed"; } catch (e) { return false; }
}
function toggleSidebar() {
  const collapsed = !sidebarCollapsed();
  try { localStorage.setItem("orcha:sidebar", collapsed ? "collapsed" : "expanded"); } catch (e) {}
  const d = document.documentElement;
  if (collapsed) d.setAttribute("data-sidebar", "collapsed");
  else d.removeAttribute("data-sidebar");
  const btn = document.getElementById("sbToggle");
  if (btn) {
    const t = collapsed ? "Expand sidebar" : "Collapse sidebar";
    btn.title = t;
    btn.setAttribute("aria-label", t);
    btn.setAttribute("aria-expanded", collapsed ? "false" : "true");
  }
}

function mountShell(page, opts) {
  opts = opts || {};
  const a = attnItems();
  // hrefs are the served FastAPI routes (extensionless), NOT the *.html filenames —
  // the portal serves /, /agents, /tasks, /requests (review P2: *.html would 404).
  const nv = [
    { key: "home", href: "/", ico: "home", label: "Dashboard" },
    { key: "agents", href: "/agents", ico: "agents", label: "Agents", count: agents().length },
    { key: "tasks", href: "/tasks", ico: "tasks", label: "Tasks",
      count: tasks().filter((t) => t.status === "needs_verification").length, attn: true },
    { key: "requests", href: "/requests", ico: "requests", label: "Requests",
      count: requests().filter((r) => r.status === "open").length },
    // SPEC-SETTINGS §5: 5th control-room entry — the Settings page (API key +,
    // later, per-use-case model selection). No count badge.
    { key: "settings", href: "/settings", ico: "sliders", label: "Settings" },
  ];

  const sidebar = document.getElementById("sidebar");
  if (sidebar) {
    const sbT0 = sidebarCollapsed() ? "Expand sidebar" : "Collapse sidebar";
    sidebar.innerHTML = `
      <div class="brand-row">
        <a class="brand" href="/" style="color:inherit">
          <span class="mark">${orcaSVG()}</span>
          <span class="word">Orcha<small>orchestration portal</small></span>
        </a>
        <button class="sb-toggle" id="sbToggle" type="button" title="${sbT0}" aria-label="${sbT0}"
          aria-expanded="${sidebarCollapsed() ? "false" : "true"}">${icon("chev", "ico")}</button>
      </div>
      <nav class="nav">
        <div class="lbl">Control room</div>
        ${nv.map((n) => `<a href="${n.href}" class="${n.key === page ? "active" : ""}" title="${n.label}${n.count != null ? " · " + n.count : ""}">
          ${icon(n.ico, "ico")}<span class="grow">${n.label}</span>
          ${n.count != null ? `<span class="ncount${n.attn && n.count ? " attn" : ""}">${n.count}</span>` : ""}
        </a>`).join("")}
        <div class="lbl">Live</div>
        <a href="/agents" class="" title="Run feed">
          ${icon("live", "ico")}<span class="grow">Run feed</span>
        </a>
      </nav>
      <div class="sb-spacer"></div>
      <div class="attn-card">
        <div class="h">${icon("bell", "")}<span>Needs you</span></div>
        <div class="big tnum">${a.count}</div>
        <div class="sub">${a.verifs.length} to verify · ${a.escs.length} escalation${a.escs.length === 1 ? "" : "s"}</div>
        <a class="go" href="/#needs">Open action queue ${icon("arrow", "")}</a>
      </div>
      <a class="attn-mini" href="/#needs" title="Needs you · ${a.count} — open action queue">
        ${icon("bell", "")}<span class="n tnum">${a.count}</span>
      </a>`;
    const sbT = document.getElementById("sbToggle");
    if (sbT) sbT.addEventListener("click", toggleSidebar);
  }

  const topbar = document.getElementById("topbar");
  if (topbar) {
    // Round-2 fix (finding #4): this is the real, fully-wired render — clear whatever
    // primeShell() marked not-yet-live. innerHTML replacement below rebuilds the CHILDREN,
    // not the element's own class/attributes, so these must be cleared explicitly. Feature-
    // detected (matches ensurePausebar's own guard) — a minimal/stub topbar (e.g. a test
    // harness's {innerHTML:''}) has neither method and must not crash shell mount.
    if (topbar.classList && typeof topbar.classList.remove === "function") topbar.classList.remove("priming");
    if (typeof topbar.removeAttribute === "function") topbar.removeAttribute("aria-busy");
    const who = actingHuman();
    const actingHTML = who
      ? `${avatar(who.alias, "human", "sm")}${esc(who.alias)}`
      : `<span class="muted">no human registered</span>`;
    // Two logical lines: identity/search/alerts, then the controls. They sit on one row when
    // the topbar is wide and collapse to two balanced rows when it's too narrow to fit (CSS).
    topbar.innerHTML = `
      <div class="tb-line tb-line-1">
        <div class="crumbs">
          <span class="page">${esc(opts.title || "")}</span>
          ${opts.ctx ? `<span class="ctx">${opts.ctx}</span>` : ""}
        </div>
        <div class="search">
          ${icon("search", "")}
          <input id="globalSearch" placeholder="Search agents, tasks, requests…" spellcheck="false" autocomplete="off">
          <span class="kbd">/</span>
        </div>
        <a class="attn-pill" id="attnPill" href="/#needs" title="Notifications — approvals, verifications & activity" aria-haspopup="true">
          ${icon("bell", "bell")}<span>Needs you</span><span class="n tnum">${a.count}</span>
        </a>
      </div>
      <div class="tb-line tb-line-2">
        <!-- GH #148: two orthogonal controls, not one fused slider. Notifier = the power
             switch (wakes_enabled); Autonomy = the gearbox (autonomy_level). A divider keeps
             them reading as two separate things; both keep the acting-human lock. -->
        <div class="ctl-wrap" id="ctlWrap">
          <div class="ctl-group" id="notifGroup">
            <span class="aut-lab">Notifier</span>
            <div class="aut notif" id="notifTop" role="group" aria-label="Event notifier — pause or resume all agent wakes"></div>
          </div>
          <span class="ctl-div" aria-hidden="true"></span>
          <div class="ctl-group" id="autGroup">
            <span class="aut-lab">Autonomy</span>
            <div class="aut" id="autTop" role="radiogroup" aria-label="Container autonomy level"></div>
          </div>
        </div>
        <div class="acting" title="You are the human authority on this container">
          <span class="lbl">acting as</span>
          <span class="who" id="actingWho">${actingHTML}</span>
        </div>
        <button class="btn sm subtle pair-top" id="pairPhoneBtn" type="button" title="Pair a phone on this Wi-Fi network">
          ${icon("phone", "")}Pair phone
        </button>
        <button class="iconbtn" id="themeBtn" title="Theme: ${currentTheme()} — click to cycle">
          ${icon("sun", "sun")}${icon("moon", "moon")}
        </button>
      </div>`;
    const tb = document.getElementById("themeBtn");
    if (tb) tb.addEventListener("click", cycleTheme);
    const pb = document.getElementById("pairPhoneBtn");
    if (pb) pb.addEventListener("click", openPairingModal);
    // SPEC-1: ensure the paused micro-banner element sits between topbar and content,
    // then render the autonomy switch from the current snapshot. Injected here (not in
    // each *.html) so the control is identical on every page.
    ensurePausebar(topbar);
    paintAutonomy();
    // SPEC-3: turn the "Needs you" pill into the notification-center dropdown trigger.
    wireNotifPill();
    const gs = document.getElementById("globalSearch");
    if (gs) document.addEventListener("keydown", (e) => {
      // the "/" shortcut focuses search — but NOT while the user is typing in a field
      // (composer, reason box, any input/textarea/select/contenteditable), or it would
      // steal the "/" keystroke + the focus mid-typing.
      if (e.key === "/" && !isEditableTarget(document.activeElement)) { e.preventDefault(); gs.focus(); }
      if (e.key === "Escape") gs.blur();
    });
  }
  // seamless-nav: persist this render so the NEXT page load can primeShell()
  // the chrome synchronously, before its first snapshot round trip returns.
  saveShellCache();
}

/* ---- seamless nav: perceived continuity (primed shell) ---------------- *
 * mountShell only runs once the FIRST /api snapshot returns, so on a remote
 * server every navigation showed a themed-but-chromeless page for a full
 * network round trip. Cache the last rendered sidebar/topbar markup per
 * (cid, page) in localStorage and restore it synchronously at script load —
 * the chrome paints together with the page; the live snapshot then re-renders
 * (and re-wires) it wholesale, exactly like every 3s poll tick already does.
 * Pre-data we wire only the two controls that are pure browser-local state
 * (sidebar collapse, theme cycle); everything data-bearing waits for the real
 * mount. The cached markup is this page's own previous render (same-origin
 * localStorage), so injecting it adds no surface beyond the render it copies. */
let _shellCacheSaved = "";
function shellCacheKey() {
  let cid = "", page = "home";
  try {
    const search = (typeof location !== "undefined" && location.search) || "";
    cid = new URLSearchParams(search).get("cid") || "";
  } catch (e) {}
  try {
    const p = ((typeof location !== "undefined" && location.pathname) || "/").replace(/^\/+/, "").split("/")[0];
    if (p) page = p;
  } catch (e) {}
  return "orcha:shellHtml:" + cid + ":" + page;
}
function saveShellCache() {
  const side = document.getElementById("sidebar"), top = document.getElementById("topbar");
  if (!side || !top) return;
  try {
    const payload = JSON.stringify({ side: side.innerHTML, top: top.innerHTML });
    if (payload === _shellCacheSaved) return;   // 3s re-renders: skip identical writes
    _shellCacheSaved = payload;
    localStorage.setItem(shellCacheKey(), payload);
  } catch (e) {}
}
// Round-2 fix (finding #4): the primed topbar used to inject its ENTIRE cached markup —
// including #notifTop/#autTop's last PAINTED state (autonomy is container-level but the
// cache key is per (cid,page), so each page could carry a different snapshot of the same
// global setting) plus #pairPhoneBtn/#attnPill/#globalSearch, none of which primeShell
// wires up. A stale reading on a control that silently swallows clicks is the wrong
// failure mode for the notifier — Orcha's safety kill-switch — worse than the chromeless
// gap this replaces, because the chromeless gap was at least honest about not being ready.
// #notifTop/#autTop are emptied outright (they're plain containers paintNotifier()/
// paintLevels() refill by innerHTML at the real mount, so there's nothing to preserve).
// #pairPhoneBtn/#attnPill/#globalSearch keep their painted markup (emptying a <button>'s
// or <input>'s content would just look broken) but sit inside `.priming`, which
// shell.css sets to pointer-events:none — so a click before the real mount is a visible
// no-op instead of a silent one. aria-busy="true" carries the same "not ready yet"
// signal to assistive tech. mountShell() clears `.priming` the moment it does the real,
// fully-wired render (it always rebuilds top.innerHTML wholesale, so the class goes with it).
function primeShell() {
  try {
    const side = document.getElementById("sidebar"), top = document.getElementById("topbar");
    if (!side || !top || side.firstChild || top.firstChild) return;   // no shell here / already mounted
    const raw = localStorage.getItem(shellCacheKey());
    if (!raw) return;
    const c = JSON.parse(raw);
    if (!c || typeof c.side !== "string" || typeof c.top !== "string") return;
    side.innerHTML = c.side;
    top.innerHTML = c.top;
    // The sidebar nav (plain <a href>) and the two browser-local controls below are safe to
    // leave fully live and painted as-is — they need no server data and ARE wired here.
    const sbT = document.getElementById("sbToggle");
    if (sbT) sbT.addEventListener("click", toggleSidebar);
    const tb = document.getElementById("themeBtn");
    if (tb) tb.addEventListener("click", cycleTheme);
    // Everything else data-bearing in the topbar: mark not-yet-live (CSS makes it
    // pointer-events:none) so a click is a visible no-op, not a silent one.
    top.classList.add("priming");
    top.setAttribute("aria-busy", "true");
    // #notifTop/#autTop specifically: don't leave their last PAINTED reading showing —
    // empty them outright rather than risk a live-looking but stale kill-switch state.
    ["notifTop", "autTop"].forEach((id) => {
      const el = document.getElementById(id);
      if (el) el.innerHTML = "";
    });
  } catch (e) {}
}
primeShell();

/* ---- GH #148: two orthogonal topbar controls ------------------------- */
// The topbar carries TWO independent controls, NOT one fused slider:
//   NOTIFIER  — the LIVE binary kill-switch, containers.wakes_enabled
//               (POST /api/containers/{cid}/wakes). Paused(red) vs Running(green).
//               "The power switch": do agents wake AT ALL?
//   AUTONOMY  — the engine LEVEL, containers.autonomy_level
//               (#298: POST /api/containers/{cid}/autonomy, level ∈ plan|pr|full).
//               "The gearbox": how far agents may go WHEN they act.
// They are orthogonal: pausing the notifier does NOT change the level, so the active
// level keeps rendering whether the notifier is Running or Paused (dimmed while paused,
// but still legible + editable so you can pre-set the level before resuming). The active
