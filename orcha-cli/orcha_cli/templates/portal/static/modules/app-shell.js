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
}

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
