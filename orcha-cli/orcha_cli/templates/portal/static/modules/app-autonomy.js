/* Orcha shared portal module: notifier pause/resume and autonomy level switching. */
// level lights in its spec tone (plan=warn / pr=info / full=accent).
// `level` is the wire enum the backend stores+returns; `label` is operator-facing.
const AUT_LEVELS = [
  { level: "plan", tone: "warn", label: "Plan-only",
    meaning: "Agents wake & propose, but every plan stops at the approval gate — you approve before any execution.",
    impact: "Agents resume and propose plans, but you approve every plan before any execution." },
  { level: "pr", tone: "info", label: "Build to PR",
    meaning: "Agents execute approved plans up to an open PR; you still merge.",
    impact: "Agents execute approved plans up to an open PR. You still merge." },
  { level: "full", tone: "accent", label: "Full",
    meaning: "Agents may carry approved work to its configured terminal state without further gates.",
    impact: "Agents may carry approved work to completion without further gates." },
];

// The live binary state from the 5s snapshot. wakes_enabled is absent on pre-SPEC-1
// backends (snapshot SELECT didn't ship it) — treat unknown as Running (the default
// container state) so the control degrades to a sane read rather than a false "Paused".
function wakesPaused() {
  return !!(D.container && D.container.wakes_enabled === false);
}

// The container's current engine autonomy level (containers.autonomy_level), surfaced in the
// snapshot SELECT. NOT NULL DEFAULT 'plan' on the backend, but a pre-#298 snapshot omits the
// field — treat unknown as 'plan' (the migration default) so the slider degrades to a sane
// read rather than highlighting nothing.
function autLevel() {
  return (D.container && D.container.autonomy_level) || "plan";
}

// Inject the paused micro-banner once, immediately after the topbar (shared across pages).
function ensurePausebar(topbar) {
  if (!topbar || document.getElementById("pausebar")) return;
  // A minimal/missing topbar (e.g. the D0 test harness stubs it as {innerHTML:''})
  // has no insertAdjacentElement — feature-detect and no-op rather than crash shell mount.
  if (typeof topbar.insertAdjacentElement !== "function") return;
  const bar = document.createElement("div");
  bar.className = "pausebar";
  bar.id = "pausebar";
  bar.innerHTML = `<span>⏸ Notifier paused — no agent wakes. Humans & live terminals still work.</span>
    <span class="resume" id="resumeBtn" role="button" tabindex="0">Resume ↩</span>`;
  topbar.insertAdjacentElement("afterend", bar);
}

// Render BOTH controls + the paused reinforcement from the current snapshot. Idempotent
// and safe to call before mount (missing hosts → no-op), so the 5s poll can reconcile it.
// Kept as the single public entry (called from applySnapshot + mountShell); it fans out to
// the two hosts so the fused-slider call sites don't need to know about the split.
function paintAutonomy() {
  paintNotifier();
  paintLevels();
  paintPausedReinforcement();
}

// NOTIFIER host (#notifTop): the live binary kill-switch. Paused (red) vs Running (green),
// always lit; clicking flips the wake switch (confirm first). Orthogonal to the level.
function paintNotifier() {
  const host = document.getElementById("notifTop");
  if (!host) return;
  const paused = wakesPaused();
  const canAct = !!actingHuman();
  host.classList.toggle("locked", !canAct);
  const cls = paused ? "seg paused on" : "seg run on";
  const lab = paused ? "Paused" : "Running";
  const tip = canAct
    ? (paused ? "Notifier is OFF — click to resume all agent wakes" : "Notifier is ON — click to pause all agent wakes")
    : "Pick an acting human to change the notifier";
  host.innerHTML = `<span class="${cls}" data-notif="1" role="switch" aria-checked="${!paused}" tabindex="0"
    title="${esc(tip)}"><span class="d"></span>${esc(lab)}</span>`;
  const seg = host.querySelector(".seg");
  if (seg) {
    seg.onclick = onNotifClick;
    seg.onkeydown = (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onNotifClick(); } };
  }
}

// AUTONOMY host (#autTop): the 3-level segmented selector (plan|pr|full). The active level
// lights in its spec tone; the rest stay selectable. Orthogonal to the notifier — the level
// renders the same whether the notifier is paused or running, but is de-emphasized (dimmed,
// hint "applies when running") while paused so you can still pre-set it before resuming.
function paintLevels() {
  const host = document.getElementById("autTop");
  if (!host) return;
  const paused = wakesPaused();
  const level = autLevel();
  const canAct = !!actingHuman();
  host.classList.toggle("locked", !canAct);
  host.classList.toggle("dimmed", paused);
  host.innerHTML = AUT_LEVELS.map((rg) => {
    const active = rg.level === level;
    const cls = "seg lvl " + rg.tone + (active ? " on" : "");
    const tip = canAct
      ? (active
          ? "Current autonomy: " + rg.label + (paused ? " — applies when running" : "")
          : "Set autonomy to " + rg.label + " — " + rg.meaning)
      : "Pick an acting human to change autonomy";
    return `<span class="${cls}" data-level="${rg.level}" role="radio" aria-checked="${active}" tabindex="0"
      title="${esc(tip)}"><span class="d"></span>${esc(rg.label)}</span>`;
  }).join("");
  host.querySelectorAll(".seg").forEach((seg) => {
    seg.onclick = () => onLevelClick(seg.dataset.level);
    seg.onkeydown = (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onLevelClick(seg.dataset.level); } };
  });
}

// The paused reinforcement (red topbar border + persistent #pausebar micro-banner) is now
// driven ONLY by the notifier, never the level.
function paintPausedReinforcement() {
  const paused = wakesPaused();
  const topbar = document.getElementById("topbar");
  // A stubbed/minimal topbar (e.g. the D0 shell-mount harness passes {innerHTML:''})
  // has no classList — feature-detect so mountShell doesn't crash on the reinforcement pass.
  if (topbar && topbar.classList) topbar.classList.toggle("paused", paused);
  const bar = document.getElementById("pausebar");
  if (bar) {
    bar.classList.toggle("show", paused);
    const rb = document.getElementById("resumeBtn");
    if (rb) { rb.onclick = () => setWakes(true); rb.onkeydown = (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setWakes(true); } }; }
  }
}

// NOTIFIER click → flip the wake switch. Running→Paused is destructive (halts all wakes):
// danger confirm. Paused→Running is safe: light confirm.
function onNotifClick() {
  if (!actingHuman()) { toast("Pick an acting human to change the notifier", "warn"); return; }
  if (wakesPaused()) {
    modal({
      title: "Resume agent wakes?",
      desc: "Agents resume waking at the current autonomy level.",
      primary: "Resume",
      onPrimary: () => { closeModal(); setWakes(true); },
    });
  } else {
    modal({
      title: "Pause all agent wakes?",
      desc: "Agents stop waking immediately. In-flight work finishes; nothing new starts. Humans & live terminals still work.",
      primary: "Pause all wakes",
      danger: true,
      onPrimary: () => { closeModal(); setWakes(false); },
    });
  }
}

// AUTONOMY click → set the engine LEVEL (containers.autonomy_level). Confirm first (Full
// removes the human completion gate → danger-flagged); no-op if already at that level.
function onLevelClick(level) {
  if (!actingHuman()) { toast("Pick an acting human to change autonomy", "warn"); return; }
  const rg = AUT_LEVELS.find((x) => x.level === level);
  if (!rg) return;
  if (rg.level === autLevel()) return;   // already at this level — no modal, no POST
  modal({
    title: "Set autonomy to " + rg.label + "?",
    desc: rg.impact,
    primary: "Set " + rg.label,
    danger: rg.level === "full",   // Full removes the human completion gate — flag it red
    onPrimary: () => { closeModal(); setAutonomy(rg.level); },
  });
}

// POST the kill-switch, optimistic-paint, then reconcile from the response (and the next
// 5s snapshot). On failure we revert the optimistic state and surface the error.
function setWakes(enabled) {
  // Single choke point for the global wake switch: gate on an acting human here so EVERY
  // caller (slider + pausebar Resume banner) is covered, never just the controls we hide.
  if (!actingHuman()) { toast("Pick an acting human to change the notifier", "warn"); return; }
  const cid = D.container && D.container.id;
  if (!cid) { toast("No container", "danger"); return; }
  const prev = D.container.wakes_enabled;
  D.container.wakes_enabled = enabled;   // optimistic
  paintAutonomy();
  const who = actingHuman();
  fetch("/api/containers/" + encodeURIComponent(cid) + "/wakes", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ enabled: enabled, actor_agent_id: who ? who.id : null }),
  })
    .then((r) => { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); })
    .then((res) => {
      D.container.wakes_enabled = res.wakes_enabled;
      paintAutonomy();
      toast(res.wakes_enabled ? "Notifier · Running" : "Notifier · Paused", res.wakes_enabled ? "ok" : "bad");
    })
    .catch((e) => {
      D.container.wakes_enabled = prev;   // revert
      paintAutonomy();
      toast("Could not change the notifier: " + e.message, "danger");
    });
}

// #298: POST the engine autonomy LEVEL, optimistic-paint, then reconcile from the response
// (and the next snapshot). Mirrors setWakes — same acting-human choke point, same
// optimistic/reconcile/revert shape — but writes containers.autonomy_level via
// POST /api/containers/{cid}/autonomy. The backend is human-only (_require_kind('human')) and
// 400s an out-of-enum level; the catch reverts the thumb either way.
function setAutonomy(level) {
  if (!actingHuman()) { toast("Pick an acting human to change autonomy", "warn"); return; }
  const cid = D.container && D.container.id;
  if (!cid) { toast("No container", "danger"); return; }
  const prev = D.container.autonomy_level;
  D.container.autonomy_level = level;   // optimistic
  paintAutonomy();
  const who = actingHuman();
  fetch("/api/containers/" + encodeURIComponent(cid) + "/autonomy", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ level: level, actor_agent_id: who ? who.id : null }),
  })
    .then((r) => { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); })
    .then((res) => {
      D.container.autonomy_level = res.autonomy_level;
      paintAutonomy();
      const rg = AUT_LEVELS.find((x) => x.level === res.autonomy_level);
      toast("Autonomy · " + (rg ? rg.label : res.autonomy_level), "ok");
    })
    .catch((e) => {
      D.container.autonomy_level = prev;   // revert
      paintAutonomy();
      toast("Could not change autonomy: " + e.message, "danger");
    });
}

/* ---- SPEC-3: notification center (topbar dropdown) ------------------- */
// The "Needs you" pill EXPANDS into a typed, enumerable feed instead of jumping to
// /#needs. Two zones:
//   NEEDS YOU  — actionable, computed client-side from attnItems() (the same action
//                queue the home hero uses): authoritative + always snapshot-fresh.
//   EARLIER    — informational, the acting human's typed feed from the #247 registry
//                (GET /api/agents/{aid}/notifications?zone=earlier). Read-state lives
//                server-side; "Mark all read" advances the read cursor.
