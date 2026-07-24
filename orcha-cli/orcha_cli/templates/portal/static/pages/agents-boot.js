/* Agents page controller: conversation mounting, selection, refresh loop, and boot wiring. */

/* S3 §3b terminal moved INTO the conversation panel ("Pair in terminal") — see
   conversation.js (togglePair/termShell/onTermState). agents.html just hosts the
   conversation; OrchaTerm (terminal.js) is the shared engine. */

/* ---------- selection ---------- */
function select(alias) {
  if (alias === sel) return;
  sel = alias; pendingScroll = true;   // ISS-38: keep the picked roster row anchored in view
  tasksShown = TASKS_CAP; riShown = REQ_CAP; roShown = REQ_CAP; digestShown = DIGEST_CAP;   // ISS-68 PR-3: reset section caps
  const u = new URL(location.href); u.searchParams.set("agent", alias); history.replaceState(null, "", u);
  if (stopRuns) { stopRuns(); stopRuns = null; }
  runsAgent = null; runsSig = "";
  renderRoster(); renderDetailMain(true);   // ISS-57: force the detail swap past the selection/input guard
  const a = AgeO.agentByAlias(sel); if (a) { fetchDigest(a); mountConv(a); }
  renderRuns(true);
  window.scrollTo({ top: 0 });
}

// roster clicks are delegated once (the roster element persists across patches).
Age$("roster").addEventListener("click", (ev) => {
  const b = ev.target.closest("[data-alias]"); if (b) select(b.dataset.alias);
});
// ISS-63: collapse-toggle clicks delegated once on the stable #detailMain (its innerHTML is
// patched every tick, but the element itself persists, so one listener survives the repaints).
Age$("detailMain").addEventListener("click", (ev) => {
  if (ev.target.closest(".sortctl")) return;   // ISS-331: handled by wireSortControl below
  const b = ev.target.closest("[data-collapse]"); if (b) toggleCollapse(b.dataset.collapse);
});
// ISS-331: re-sort the three agent-detail lists on any sort-control change (one delegated
// binding on the persistent #detailMain handles all three controls; force past the repaint guard)
AgeO.wireSortControl(Age$("detailMain"), () => renderDetailMain(true));

// ISS-68 PR-3: per-section "Load more" — delegated once on the persistent #detailMain (its inner
// HTML is re-patched each tick, so a stable parent listener survives the repaint).
Age$("detailMain").addEventListener("click", (ev) => {
  const b = ev.target.closest("[data-more]"); if (!b) return;
  const k = b.dataset.more;
  if (k === "tasks") tasksShown += TASKS_CAP;
  else if (k === "ri") riShown += REQ_CAP;
  else if (k === "ro") roShown += REQ_CAP;
  else if (k === "digest") digestShown += DIGEST_CAP;
  renderDetailMain();
});

/* ---------- boot ---------- */
function render() {
  if (!AgeD() || !AgeD().container) return;
  if (!sel || !AgeO.agentByAlias(sel)) sel = firstAlias();
  AgeO.mountShell("agents", { title: "Agents", ctx: AgeO.agents().length + " agents · " + AgeD().container.name });
  renderRoster();
  renderDetailMain();
  const a = AgeO.agentByAlias(sel);
  if (a) { fetchDigest(a); renderRuns(false); mountConv(a); }
}
window.OrchaData.start(render, 3000);
