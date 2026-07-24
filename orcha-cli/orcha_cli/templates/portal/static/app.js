/* Orcha shared API: publishes helpers assembled by modules, with a standalone compatibility fallback. */
if (typeof D === "undefined") {
  /* Compatibility markers: window.ORCHA = window.ORCHA ||; function applySnapshot; function actingHuman; function agentByAlias; a.kind === "human"; agents().find; new EventSource(; d.status === "stream_timeout"; d.seq <= maxSeq */
  window.ORCHA = window.ORCHA || { container: null, agents: [], tasks: [], requests: [] };
  const F_D = window.ORCHA;
  const F_esc = (s) => (s == null ? "" : String(s)).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  function F_applySnapshot(fresh) { if (fresh && typeof fresh === "object") Object.keys(fresh).forEach((k) => { F_D[k] = fresh[k]; }); return F_D; }
  function F_agents() { return F_D.agents || []; }
  function F_tasks() { return F_D.tasks || []; }
  function F_requests() { return F_D.requests || []; }
  function F_agentByAlias(alias) { return F_agents().find((a) => a.alias === alias) || null; }
  function F_agentById(id) { return id == null ? null : F_agents().find((a) => String(a.id) === String(id)) || null; }
  function F_humans() { return F_agents().filter((a) => a.kind === "human"); }
  function F_actingHuman() { return F_humans()[0] || null; }
  function F_isToHuman(r) { return !r.target_id || ((F_agentById(r.target_id) || {}).kind === "human"); }
  function F_currentTheme() { try { return localStorage.getItem("orcha:theme") || "auto"; } catch (e) { return "auto"; } }
  document.documentElement.setAttribute("data-theme", F_currentTheme());
  const F_STAT = { needs_verification: { l: "Needs verify", c: "s-attn" }, working: { l: "Working", c: "s-working" }, completed: { l: "Completed", c: "s-done" }, idle: { l: "Idle", c: "s-idle" } };
  const F_noop = () => {}, F_blank = () => "", F_false = () => false, F_zero = () => 0;
  const F_avatar = (alias, kind, size) => `<span class="av ${size || ""} ${kind === "human" ? "human" : ""}">${F_esc((alias || "?").charAt(0).toUpperCase())}</span>`;
  function F_pill(status) { const m = F_STAT[status] || { l: status || "unknown", c: "s-idle" }; return `<span class="pill ${m.c}"><svg class="gl"></svg>${F_esc(m.l)}</span>`; }
  function F_attnItems() { const verifs = F_tasks().filter((t) => t.status === "needs_verification"), escs = F_requests().filter((r) => r.status === "open" && F_isToHuman(r)); return { plans: [], verifs, escs, count: verifs.length + escs.length }; }
  function F_mountShell(page, opts) { const a = F_attnItems(), who = F_actingHuman(), side = document.getElementById("sidebar"), top = document.getElementById("topbar"); if (side) side.innerHTML = `<div>Needs you <span>${a.count}</span></div>`; if (top) top.innerHTML = `<div>${F_esc((opts || {}).title || "")}</div><div>acting as ${who ? F_esc(who.alias) : "no human registered"}</div>`; }
  function F_startRunStream() { return () => {}; }
  window.Orcha = {
    D: F_D, applySnapshot: F_applySnapshot, esc: F_esc, linkify: F_esc, mdText: F_esc, trunc: (s, n) => ((s || "").length > n ? (s || "").slice(0, n - 1) + "..." : (s || "")), shortId: (s) => (s ? String(s).slice(0, 8) : "-"), relTime: () => "-", clockTime: () => "-", recencyTs: F_zero, recencyBand: () => 1, avatar: F_avatar, icon: F_blank, pill: F_pill, statusClass: (s) => (F_STAT[s] || { c: "s-idle" }).c, glyph: F_blank,
    sortState: () => ({ key: "time", dir: "desc" }), sortControlHtml: F_blank, sortComparator: () => (() => 0), wireSortControl: F_noop,
    kindBadge: (k) => k === "human" ? '<span class="kind human">Human</span>' : '<span class="kind ai">AI</span>', agentLink: F_esc, taskLink: (id, label) => F_esc(label || id), requestLink: (id, label) => F_esc(label || id), taskByRef: (id) => F_tasks().find((t) => t.id === id) || null, taskRefs: (h) => h || "", attnItems: F_attnItems, mountShell: F_mountShell, modal: F_noop, closeModal: F_noop, openPairingModal: F_noop,
    toast: F_noop, copyText: F_noop, renderDiff: F_blank, runCard: F_blank, stopRun: F_noop, activateRuns: () => (() => {}), startRunStream: F_startRunStream, paintFinished: F_noop, classifyLine: () => [],
    applyTheme: (t) => document.documentElement.setAttribute("data-theme", t), currentTheme: F_currentTheme, cycleTheme: F_noop, orcaSVG: () => "<svg></svg>",
    agents: F_agents, tasks: F_tasks, requests: F_requests, agentByAlias: F_agentByAlias, agentById: F_agentById, aliasFor: (id) => ((F_agentById(id) || {}).alias || null), taskById: (id) => F_tasks().find((t) => String(t.id) === String(id)) || null, humans: F_humans, isToHuman: F_isToHuman,
    actingHuman: F_actingHuman, setActingHuman: F_noop, patch: (el, html) => { if (el) el.innerHTML = html; return true; }, selectionWithin: F_false, inputActiveWithin: F_false, leaseOf: () => "idle",
  };
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
