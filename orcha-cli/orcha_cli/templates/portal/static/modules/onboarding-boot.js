/* Onboarding flow module: URL reconciliation, model loading, snapshot start, and helper export. */
/* ---- boot: resolve cid once, load models, then live-render on snapshot - */
// Round-2 fix (finding #3): boot() is NOT read-only — it can advance S.step to
// "create-agent" and flip the dev-only demo flag, then persist both via save(). A
// speculation-rules prerender of /onboarding?new=1 used to run this at HOVER time (the
// speculation-rules exclusion above is the primary fix), well before the user ever
// clicks. Belt-and-suspenders: even if some future rule/engine prerenders this page
// anyway, don't let a prerendered document mutate state a LIVE document later reads —
// localStorage is shared across every document of the origin. `document.prerendering`
// is undefined on browsers without the Prerendering API, so the guard degrades to "never
// skip" there (unchanged behavior).
function boot() {
  if (typeof document !== "undefined" && document.prerendering) return;
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
// `booted` only latches once boot() actually RUNS (not once it's merely called) — boot()
// itself no-ops while document.prerendering is true, and a prerendered document CAN still
// activate into the visible tab later (Chrome swaps it in on click), at which point boot()
// must still be free to run for real on the next snapshot tick.
let booted = false;
window.OrchaData.start(() => { if (!booted) { if (typeof document !== "undefined" && document.prerendering) return; booted = true; boot(); } }, 3000);

// expose the pure step-machine helpers for node tests
window.OrchaOnboarding = { railKeyFor, resumeStep, reconcileGhost, reconcileDemoFlag, CONCIERGE_TEMPLATE, RAIL,
  parseSSE, normalizeRoster, rosterToWalk, walkAgentToDraft };
