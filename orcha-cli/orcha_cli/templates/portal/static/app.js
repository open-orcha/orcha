/* Orcha shared API: publishes helpers assembled by modules, with a standalone compatibility fallback. */
if (typeof D === "undefined") {
  /* Compatibility markers: window.ORCHA = window.ORCHA ||; function applySnapshot; function actingHuman; function agentByAlias; a.kind === "human"; agents().find; new EventSource(; d.status === "stream_timeout"; d.seq <= maxSeq */
  window.ORCHA = window.ORCHA || { container: null, agents: [], tasks: [], requests: [] };
  const F_D = window.ORCHA;
  const F_esc = (s) => (s == null ? "" : String(s)).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  function F_applySnapshot(fresh) {
    if (fresh && typeof fresh === "object") Object.keys(fresh).forEach((k) => { F_D[k] = fresh[k]; });
    F_paintAutonomy();
    F_paintNotifications();
    return F_D;
  }
  function F_agents() { return F_D.agents || []; }
  function F_tasks() { return F_D.tasks || []; }
  function F_requests() { return F_D.requests || []; }
  function F_agentByAlias(alias) { return F_agents().find((a) => a.alias === alias) || null; }
  function F_agentById(id) { return id == null ? null : F_agents().find((a) => String(a.id) === String(id)) || null; }
  function F_humans() { return F_agents().filter((a) => a.kind === "human"); }
  function F_actingHuman() { return F_humans()[0] || null; }
  function F_isToHuman(r) { return !r.target_id || ((F_agentById(r.target_id) || {}).kind === "human"); }
  function F_currentTheme() { try { return localStorage.getItem("orcha:theme") || "auto"; } catch (e) { return "auto"; } }
  function F_cycleTheme() {
    const rendered = F_currentTheme() === "auto"
      ? (window.matchMedia && window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark")
      : F_currentTheme();
    const next = rendered === "dark" ? "light" : "dark";
    try { localStorage.setItem("orcha:theme", next); } catch (e) {}
    document.documentElement.setAttribute("data-theme", next);
    return next;
  }
  document.documentElement.setAttribute("data-theme", F_currentTheme());
  const F_STAT = { needs_verification: { l: "Needs verify", c: "s-attn" }, working: { l: "Working", c: "s-working" }, completed: { l: "Completed", c: "s-done" }, idle: { l: "Idle", c: "s-idle" } };
  const F_noop = () => {}, F_blank = () => "", F_false = () => false, F_zero = () => 0;
  const F_icon = (name) => name === "sliders" ? '<svg><circle></circle><circle></circle></svg>' : "";
  const F_avatar = (alias, kind, size) => `<span class="av ${size || ""} ${kind === "human" ? "human" : ""}">${F_esc((alias || "?").charAt(0).toUpperCase())}</span>`;
  function F_pill(status) { const m = F_STAT[status] || { l: status || "unknown", c: "s-idle" }; return `<span class="pill ${m.c}"><svg class="gl"></svg>${F_esc(m.l)}</span>`; }
  function F_attnItems() {
    const level = (F_D.container && F_D.container.autonomy_level) || "plan";
    const plans = level === "plan"
      ? F_tasks().filter((t) => t.status === "in_progress" && !t.plan_decision && !!(t.plan_message || (t.thread || []).find((m) => !m.is_human)))
      : [];
    const verifs = level === "full" ? [] : F_tasks().filter((t) => t.status === "needs_verification");
    const escs = F_requests().filter((r) => r.status === "open" && F_isToHuman(r));
    return { plans, verifs, escs, count: plans.length + verifs.length + escs.length };
  }
  function F_mountShell(page, opts) {
    const a = F_attnItems(), who = F_actingHuman(), side = document.getElementById("sidebar"), top = document.getElementById("topbar");
    if (side) side.innerHTML = `<a href="/settings" class="${page === "settings" ? "active" : ""}">Settings</a><div>Needs you <span>${a.count}</span></div>`;
    if (top) top.innerHTML = `<div>${F_esc((opts || {}).title || "")}</div><div>acting as ${who ? F_esc(who.alias) : "no human registered"}</div><button id="pairPhoneBtn">Pair phone</button>`;
    F_paintAutonomy();
    F_wireNotifPill();
  }
  function F_startRunStream() { return () => {}; }
  const LEASES = ["idle", "ephemeral", "resident", "live"];
  const leaseOf = (agent) => {
    const v = agent && agent.embodiment;
    return v && LEASES.indexOf(v) >= 0 ? v : "idle";
  };
  window.Orcha = {
    D: F_D, applySnapshot: F_applySnapshot, esc: F_esc, linkify: F_esc, mdText: F_esc, trunc: (s, n) => ((s || "").length > n ? (s || "").slice(0, n - 1) + "..." : (s || "")), shortId: (s) => (s ? String(s).slice(0, 8) : "-"), relTime: () => "-", clockTime: () => "-", recencyTs: F_zero, recencyBand: () => 1, avatar: F_avatar, icon: F_icon, pill: F_pill, statusClass: (s) => (F_STAT[s] || { c: "s-idle" }).c, glyph: F_blank,
    sortState: () => ({ key: "time", dir: "desc" }), sortControlHtml: F_blank, sortComparator: () => (() => 0), wireSortControl: F_noop,
    kindBadge: (k) => k === "human" ? '<span class="kind human">Human</span>' : '<span class="kind ai">AI</span>', agentLink: F_esc, taskLink: (id, label) => F_esc(label || id), requestLink: (id, label) => F_esc(label || id), taskByRef: (id) => F_tasks().find((t) => t.id === id) || null, taskRefs: (h) => h || "", attnItems: F_attnItems, mountShell: F_mountShell, modal: F_modal, closeModal: F_closeModal, openPairingModal: F_openPairingModal,
    toast: F_toast, copyText: F_noop, renderDiff: F_blank, runCard: F_runCard, stopRun: F_stopRun, activateRuns: () => (() => {}), startRunStream: F_startRunStream, paintFinished: F_noop, classifyLine: () => [],
    applyTheme: (t) => document.documentElement.setAttribute("data-theme", t), currentTheme: F_currentTheme, cycleTheme: F_cycleTheme, orcaSVG: () => "<svg></svg>",
    agents: F_agents, tasks: F_tasks, requests: F_requests, agentByAlias: F_agentByAlias, agentById: F_agentById, aliasFor: (id) => ((F_agentById(id) || {}).alias || null), taskById: (id) => F_tasks().find((t) => String(t.id) === String(id)) || null, humans: F_humans, isToHuman: F_isToHuman,
    actingHuman: F_actingHuman, setActingHuman: F_noop, patch: F_patch, selectionWithin: F_false, inputActiveWithin: F_inputActiveWithin, leaseOf,
  };
  function F_inputActiveWithin(el) {
    if (!el || !el.querySelectorAll) return false;
    const active = document.activeElement;
    if (active && el.contains && el.contains(active) && /^(INPUT|TEXTAREA|SELECT)$/.test(active.tagName || "")) return true;
    const controls = el.querySelectorAll("input, textarea");
    for (let i = 0; i < controls.length; i++) {
      const c = controls[i], text = c.tagName === "TEXTAREA" || (c.tagName === "INPUT" && /^(text|search|url|email|tel|number|password|)$/i.test(c.type || ""));
      const rendered = typeof c.defaultValue === "string" ? c.defaultValue : "";
      if (text && typeof c.value === "string" && c.value !== rendered) return true;
    }
    return false;
  }
  function F_patch(el, html, force) {
    if (!el || el.__patchHtml === html) return false;
    if (!force && F_inputActiveWithin(el)) return false;
    el.innerHTML = html;
    el.__patchHtml = html;
    return true;
  }
  function F_paintAutonomy() {
    const paused = !!(F_D.container && F_D.container.wakes_enabled === false);
    const level = (F_D.container && F_D.container.autonomy_level) || "plan";
    const canAct = !!F_actingHuman(), notif = document.getElementById("notifTop"), aut = document.getElementById("autTop");
    if (notif) {
      notif.classList.toggle("locked", !canAct);
      notif.innerHTML = `<span class="seg ${paused ? "paused" : "run"} on" data-notif="1">${paused ? "Paused" : "Running"}</span>`;
      const seg = notif.querySelector(".seg");
      if (seg) seg.onclick = () => F_confirmWakes(paused);
    }
    if (aut) {
      const enforced = !!(F_D.container && F_D.container.autonomy_enforced);
      aut.classList.toggle("locked", !canAct); aut.classList.toggle("dimmed", paused);
      aut.innerHTML = [["plan", "warn", "Plan-only"], ["pr", "info", "Build to PR"], ["full", "accent", "Full"]]
        .map((x) => `<span class="seg lvl ${x[1]}${level === x[0] ? " on" : ""}" data-level="${x[0]}">${x[2]}</span>`).join("")
        + `<span class="seg lock${enforced ? " on" : ""}" data-enforce="1">${enforced ? "🔒 Enforced" : "Enforce"}</span>`;
      aut.querySelectorAll(".seg").forEach((seg) => {
        seg.onclick = seg.dataset.enforce ? () => F_confirmEnforce() : () => F_confirmLevel(seg.dataset.level);
      });
    }
    const top = document.getElementById("topbar"), bar = document.getElementById("pausebar"), resume = document.getElementById("resumeBtn");
    if (top && top.classList) top.classList.toggle("paused", paused);
    if (bar) bar.classList.toggle("show", paused);
    if (resume) resume.onclick = () => F_setControl("wakes", true);
  }
  function F_overlay() {
    let ov = document.getElementById("__ov");
    if (!ov) { ov = document.createElement("div"); ov.id = "__ov"; document.body.appendChild(ov); }
    return ov;
  }
  function F_modal(cfg) {
    const ov = F_overlay();
    ov.innerHTML = `<div><h3>${F_esc(cfg.title)}</h3><p>${F_esc(cfg.desc || "")}</p></div>`;
    ov.classList.add("show");
    const primary = document.getElementById("__mp");
    if (primary) primary.addEventListener("click", () => { if (cfg.onPrimary) cfg.onPrimary(); });
  }
  function F_closeModal() { const ov = document.getElementById("__ov"); if (ov) ov.classList.remove("show"); }
  function F_toast(message) {
    let toast = document.getElementById("__toast");
    if (!toast) { toast = document.createElement("div"); toast.id = "__toast"; document.body.appendChild(toast); }
    toast.textContent = message;
  }
  /* The standalone fallback keeps the historical notification-center contract used by
     embedders that load app.js without the responsibility modules. */
  let F_ncOpen = false, F_ncRows = [], F_ncBefore = null, F_ncBeforeId = null;
  function F_ncRow(row) {
    const labels = { task_verified: "Task verified", request_answered: "Request answered" };
    const label = labels[row.type] || String(row.type || "notification").replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());
    const href = row.deeplink && row.deeplink.id && (row.deeplink.kind === "task" || row.deeplink.kind === "request")
      ? `/${row.deeplink.kind}s?${row.deeplink.kind === "task" ? "task" : "req"}=${encodeURIComponent(row.deeplink.id)}` : null;
    return `<${href ? "a" : "div"} class="nrow${row.read ? "" : " unread"}"${href ? ` href="${href}"` : ""}>${F_esc(label)}${row.preview ? " · " + F_esc(row.preview) : ""}</${href ? "a" : "div"}>`;
  }
  function F_ncRender() {
    const host = document.getElementById("ncFloat"); if (!host) return;
    const a = F_attnItems(), needs = []
      .concat(a.plans.map((t) => `<a class="nrow" href="/tasks?task=${encodeURIComponent(t.id)}">Plan approval · ${F_esc(t.title || t.id)}</a>`))
      .concat(a.verifs.map((t) => `<a class="nrow" href="/tasks?task=${encodeURIComponent(t.id)}">Verify task · ${F_esc(t.title || t.id)}</a>`))
      .concat(a.escs.map((r) => `<a class="nrow" href="/requests?req=${encodeURIComponent(r.id)}">Escalation · ${F_esc((r.payload || "").slice(0, 52))}</a>`));
    const earlier = F_actingHuman() ? F_ncRows.map(F_ncRow).join("") : "Pick an acting human to see your activity feed.";
    host.innerHTML = `<div>Notifications <span id="ncMark">Mark all read</span></div><div>Needs you <span class="ct">(${a.count})</span></div>${needs.join("")}<div>Earlier</div>${earlier}${F_ncBefore != null ? '<div id="ncMore">Load earlier</div>' : ""}`;
    const mark = document.getElementById("ncMark"), more = document.getElementById("ncMore");
    if (mark) mark.addEventListener("click", () => F_ncMark());
    if (more) more.addEventListener("click", () => F_ncLoad(false));
  }
  function F_ncLoad(reset) {
    const who = F_actingHuman(); if (!who) return;
    let url = `/api/agents/${encodeURIComponent(who.id)}/notifications?zone=earlier&limit=20`;
    if (!reset && F_ncBefore != null) url += `&before_ts=${encodeURIComponent(F_ncBefore)}&before_id=${encodeURIComponent(F_ncBeforeId)}`;
    fetch(url).then((r) => r.json()).then((d) => {
      F_ncRows = reset ? (d.notifications || []) : F_ncRows.concat(d.notifications || []);
      F_ncBefore = d.next_before_ts; F_ncBeforeId = d.next_before_id; F_ncRender();
    }).catch((e) => F_toast("Could not load notifications: " + e.message));
  }
  function F_ncMark() {
    const who = F_actingHuman(); if (!who) return;
    F_ncRows.forEach((row) => { row.read = true; }); F_ncRender();
    fetch(`/api/agents/${encodeURIComponent(who.id)}/notifications/read`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  }
  function F_wireNotifPill() {
    let host = document.getElementById("ncFloat");
    if (!host) { host = document.createElement("div"); host.id = "ncFloat"; host.className = "ncenter float"; document.body.appendChild(host); }
    const pill = document.getElementById("attnPill"); if (!pill) return;
    pill.addEventListener("click", (e) => { e.preventDefault(); F_ncOpen = !F_ncOpen; host.classList.toggle("show", F_ncOpen); if (F_ncOpen) { F_ncRender(); F_ncLoad(true); } });
  }
  function F_paintNotifications() {
    const pill = document.getElementById("attnPill"), count = pill && pill.querySelector(".n");
    if (count) count.textContent = String(F_attnItems().count);
    if (F_ncOpen) F_ncRender();
  }
  function F_openPairingModal() {
    if (!F_D.container) return;
    const ov = F_overlay();
    ov.innerHTML = "<h3>Pair your phone</h3><p>Scan on the same Wi-Fi network.</p><div>Preparing pairing code...</div>";
    ov.classList.add("show");
  }
  function F_confirmWakes(enabled) {
    if (!F_actingHuman()) return;
    F_modal({ title: enabled ? "Resume agent wakes?" : "Pause all agent wakes?", onPrimary: () => F_setControl("wakes", enabled) });
  }
  function F_confirmLevel(level) {
    if (!F_actingHuman() || level === ((F_D.container && F_D.container.autonomy_level) || "plan")) return;
    const label = level === "pr" ? "Build to PR" : level === "full" ? "Full" : "Plan-only";
    F_modal({ title: `Set autonomy to ${label}?`, desc: level === "full" ? "Agents may continue without further gates." : "", onPrimary: () => F_setControl("autonomy", level) });
  }
  function F_setControl(kind, value) {
    const who = F_actingHuman(), container = F_D.container;
    if (!who || !container) return;
    const field = kind === "wakes" ? "wakes_enabled" : "autonomy_level", previous = container[field];
    container[field] = value; F_paintAutonomy();
    fetch(`/api/containers/${encodeURIComponent(container.id)}/${kind}`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(kind === "wakes" ? { enabled: value, actor_agent_id: who.id } : { level: value, actor_agent_id: who.id }),
    }).then((r) => { if (!r.ok) throw new Error("request failed"); return r.json(); })
      .then((data) => { container[field] = data[field]; F_paintAutonomy(); })
      .catch(() => { container[field] = previous; F_paintAutonomy(); });
  }
  /* mig 034: container-wide "enforce for all agents" switch — POSTs through the SAME /autonomy
     endpoint (optional autonomy_enforced beside the unchanged level); optimistic + revert. */
  function F_confirmEnforce() {
    if (!F_actingHuman()) return;
    const on = !!(F_D.container && F_D.container.autonomy_enforced);
    F_modal({
      title: on ? "Stop enforcing the container level?" : "Enforce autonomy for all agents?",
      desc: on ? "Per-agent autonomy overrides apply again." : "Every per-agent autonomy override is IGNORED while enforced.",
      onPrimary: () => F_setEnforce(!on),
    });
  }
  function F_setEnforce(value) {
    const who = F_actingHuman(), container = F_D.container;
    if (!who || !container) return;
    const previous = !!container.autonomy_enforced;
    container.autonomy_enforced = value; F_paintAutonomy();
    /* F1: PARTIAL update — autonomy_enforced ONLY, no level (a lock flip must never re-assert a
       possibly-stale cached level, which could silently widen the container). */
    fetch(`/api/containers/${encodeURIComponent(container.id)}/autonomy`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ autonomy_enforced: value, actor_agent_id: who.id }),
    }).then((r) => { if (!r.ok) throw new Error("request failed"); return r.json(); })
      .then((data) => { container.autonomy_level = data.autonomy_level; container.autonomy_enforced = data.autonomy_enforced; F_paintAutonomy(); })
      .catch(() => { container.autonomy_enforced = previous; F_paintAutonomy(); });
  }
  const F_stopRequested = new Set();
  function F_runCard(run) {
    let status = run.status || "unknown";
    if (status === "killed") {
      try { status = JSON.parse(run.kill_reason || "{}").cause === "human_stop" ? "■ stopped" : "⚠ watchdog-killed"; }
      catch (e) { status = "⚠ watchdog-killed"; }
    }
    const id = run.run_id || run.id || "";
    const stop = run.status === "running"
      ? `<button class="btn sm stop" data-run-stop="${F_esc(id)}"${F_stopRequested.has(id) ? " disabled" : ""}>${F_stopRequested.has(id) ? "Stop requested" : "Stop run"}</button>`
      : "";
    return `<div class="run-card"><span>${F_esc(status)}</span>${stop}</div>`;
  }
  function F_stopRun(runId) {
    const who = F_actingHuman();
    if (!who) { F_toast("Pick an acting human first"); return; }
    F_modal({
      title: `Stop run ${runId}?`,
      desc: "The run stops at its next checkpoint, not instantly; the task stays in_progress so it can be reassigned or rewoken.",
      onPrimary: () => fetch(`/api/runs/${encodeURIComponent(runId)}/stop`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ actor_agent_id: who.id }),
      }).then((r) => { if (!r.ok) throw new Error("request failed"); return r.json(); })
        .then((data) => {
          if (data.already_finished) F_toast(`Run already ${data.status}`);
          else { F_stopRequested.add(runId); F_toast(data.already_requested ? "Stop already requested" : "Stop requested"); }
        }).catch(() => F_toast("Stop failed")),
    });
  }
} else {
  window.Orcha = {
    D, applySnapshot, esc, linkify, mdText, trunc, shortId, relTime, clockTime, recencyTs, recencyBand, avatar, icon, pill, statusClass, glyph,
    sortState, sortControlHtml, sortComparator, wireSortControl,
    kindBadge, agentLink, taskLink, requestLink, taskByRef, taskRefs, attnItems, mountShell, modal, closeModal, openPairingModal,
    toast, copyText, renderDiff, runCard, stopRun, activateRuns, startRunStream, paintFinished, classifyLine,
    applyTheme, currentTheme, cycleTheme, orcaSVG,
    agents, tasks, requests, agentByAlias, agentById, aliasFor, taskById, humans, isToHuman,
    actingHuman, setActingHuman, patch, selectionWithin, inputActiveWithin, leaseOf,
  };
}
