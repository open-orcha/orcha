/* Onboarding flow module: shared shell render and navigation. */
/* ====================================================================== */
/*  HTTP                                                                    */
/* ====================================================================== */
async function postJSON(url, body) {
  const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  let j = null; try { j = await r.json(); } catch (e) {}
  return { ok: r.ok, status: r.status, body: j };
}

/* ====================================================================== */
/*  SHELL                                                                  */
/* ====================================================================== */
function renderShell() {
  // Reuse the canonical D0 shell so the sidebar/topbar match every other page.
  O.mountShell("home", { title: "Set up your workspace", ctx: "First-run onboarding" });
}

function guideRail() {
  const curKey = railKeyFor(S.step);
  const idx = RAIL.findIndex((r) => r.key === curKey);
  return `<div class="guide-rail">
    <div class="steps">
      ${RAIL.map((r, i) => `${i ? '<span class="sep"></span>' : ""}
        <span class="st ${i < idx ? "done" : i === idx ? "cur" : ""}">
          <span class="n">${i < idx ? OnbIcon("check", "") : r.n}</span>${OnbEsc(r.label)}</span>`).join("")}
    </div>
    <a class="skip" href="/">Skip to dashboard ${OnbIcon("arrow", "")}</a>
  </div>`;
}

/* ====================================================================== */
/*  RENDER                                                                 */
/* ====================================================================== */
function render() {
  renderShell();
  const c = document.getElementById("content");
  if (!c) return;
  const showRail = S.step !== "welcome";
  c.innerHTML = (showRail ? guideRail() : "") + `<div id="obMain"></div>`;
  const main = document.getElementById("obMain");
  ({
    "welcome": stepWelcome, "fork": stepFork, "create-agent": stepCreateAgent,
    "agent-created": stepAgentCreated, "create-tasks": stepCreateTasks,
    "propose-goal": stepProposeGoal, "propose-stream": stepProposeStream,
    "propose-roster": stepProposeRoster,
  }[S.step] || stepWelcome)(main);
}
// scroll-to-top belongs to an explicit STEP CHANGE, not to render() itself — so a
// refresh/re-render of the current step never jumps the page (covers all screens; bug 3).
// Any live propose SSE stream is aborted on navigation so it never leaks past its step.
function go(step) { if (_proposeAbort) { try { _proposeAbort(); } catch (e) {} _proposeAbort = null; } S.step = step; save(); render(); window.scrollTo({ top: 0 }); }
// After a WRITE, pull a fresh snapshot BEFORE rendering the next snapshot-derived step —
// we no longer rebuild every 3s, so a just-created human/agent/task must be refreshed in
// explicitly or it won't appear until the user navigates away/back (review P2).
async function refreshAnd(step) {
  try { await window.OrchaData.refresh(); } catch (e) {}
  go(step);
}
