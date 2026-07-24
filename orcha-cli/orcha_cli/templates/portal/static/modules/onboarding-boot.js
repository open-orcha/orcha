/* Onboarding flow module: URL reconciliation, model loading, snapshot start, and helper export. */
/* ---- boot: resolve cid once, load models, then live-render on snapshot - */
function boot() {
  // "+ New agent" deep-link (?new=1 or ?step=create-agent): once an operator exists, jump
  // straight to the create form so adding ANOTHER agent doesn't replay welcome/fork.
  const q = new URLSearchParams(location.search);
  // Reconcile against server truth FIRST: if the persisted flow celebrates an agent the
  // live snapshot no longer has (workspace reset / retirement), drop the ghost (#140) so
  // the steps below resume from a real step, not a vanished agent.
  const rec = reconcileGhost(S, snapAgents().map((a) => a.alias));
  S.step = rec.step; S.lastAgentAlias = rec.lastAgentAlias;
  // DEV-ONLY: ?demo=1 makes the propose lane synthesize a roster client-side (no #292 backend).
  // Reconciled from the live URL every boot (never sticky): set while ?demo=1 is present,
  // cleared otherwise so a prior demo session can't hijack the real propose path. save() below
  // persists the cleared state.
  reconcileDemoFlag(S, q.get("demo") === "1");
  if ((q.get("new") === "1" || q.get("step") === "create-agent") && operator()) S.step = "create-agent";
  else S.step = resumeStep(S.step, !!operator());   // skip welcome if a human exists
  save();
  render();
}

// resolve cid + models once on boot (independent of the 3s snapshot cadence)
(async function init() {
  try { CID = await window.OrchaData.resolveCid(); } catch (e) {}
  fetch("/api/models").then((r) => r.ok ? r.json() : null).then((d) => {
    if (d && Array.isArray(d.models)) {
      MODELS = d.models; DEFAULT_MODEL = d.default || (d.models[0] && d.models[0].id) || null;
      if (S._agentDraft && S._agentDraft.model == null) S._agentDraft.model = DEFAULT_MODEL;
      // populate the model picker IN PLACE — a full render() here would rebuild the form
      // mid-entry + jump (bug 3). The #agModels click listener is delegated so it survives.
      const mc = document.getElementById("agModels");
      if (mc && S._agentDraft) mc.innerHTML = modelCards(S._agentDraft.model);
    }
  }).catch(() => {});
})();

// Boot ONCE on the first snapshot. We deliberately do NOT re-render on every 3s tick: the
// wizard is a form flow, so rebuilding it every 3s jumps the scroll + clobbers inputs
// (O-series bug). OrchaData keeps window.ORCHA fresh, so each step reads current data when
// it's navigated; user actions (go/buttons) drive the renders.
let booted = false;
window.OrchaData.start(() => { if (!booted) { booted = true; boot(); } }, 3000);

// expose the pure step-machine helpers for node tests
window.OrchaOnboarding = { railKeyFor, resumeStep, reconcileGhost, reconcileDemoFlag, CONCIERGE_TEMPLATE, RAIL,
  parseSSE, normalizeRoster, rosterToWalk, walkAgentToDraft };
