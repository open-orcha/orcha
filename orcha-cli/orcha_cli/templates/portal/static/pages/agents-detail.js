/* Agents page controller: agent detail cards, gate callouts, persona, digest, and request summaries. */
function renderDetailMain(force) {
  const a = AgeO.agentByAlias(sel);
  if (!a) { AgeO.patch(Age$("detailMain"), '<div class="card pad"><div class="none">Agent not found.</div></div>', force); return; }
  const mine = agentTasks(a.alias).sort(AgeO.sortComparator("agent-tasks", taskSortAcc()));
  const current = mine.filter((t) => t.status === "in_progress" || t.status === "needs_verification");
  const selectedRuntime = modelRuntimeForAgent(a);
  const visibleModels = modelsForRuntime(selectedRuntime);
  const selectedEffort = a.reasoning_effort != null ? a.reasoning_effort : null;

  let html = "";

  /* header */
  html += `<div class="card pad" style="margin-bottom:18px">
    <div class="ahead">
      ${AgeO.avatar(a.alias, a.kind, "lg")}
      <div class="who grow">
        <h1>${AgeO.esc(a.alias)} ${AgeO.kindBadge(a.kind)}</h1>
        <div class="role">${AgeO.esc(a.role)}</div>
      </div>
      ${AgeO.pill(a.status, "lg")}
    </div>
    <div class="meta" style="margin-top:16px;padding-top:15px;border-top:1px solid var(--border)">
      ${a.model ? `<div><span class="k">Model</span><span class="v">${AgeO.esc(a.model)}</span></div>` : ""}
      <div><span class="k">Last active</span><span class="v">${a.last_active ? AgeO.relTime(a.last_active) : "—"}</span></div>
      <div><span class="k">Origin</span><span class="v">${a.kind === "human" ? "Human authority" : "Human-created"}</span></div>
      <div><span class="k">Agent ID</span><span class="v mono">${AgeO.esc(AgeO.shortId(a.id))}</span></div>
    </div>
  </div>`;

  /* gate callout — surfaced REGARDLESS of agent status (ISS-36), gated on plan_decision (ISS-41) */
  html += gateCallout(a, mine);

  /* conversation (S1) is mounted into #convWrap (a sibling of #detailMain) so the 3s
     Orcha.patch repaint here never wipes the composer — see render()/select(). */

  /* persona + controls */
  html += `<div class="g2" style="margin-bottom:18px">
    <div class="card">
      <div class="card-h"><h3>${a.kind === "human" ? "Role" : "Persona"}</h3></div>
      <div class="card-b" style="padding:14px 16px">
        <div class="persona-pre">${AgeO.esc(a.prompt_preview || a.role || "—")}${(a.prompt_preview && a.prompt_preview.length >= 160) ? "…" : ""}</div>
        ${a.kind !== "human" ? personaExpandBlock(a) : ""}
      </div>
    </div>
    <div class="card">
      <div class="card-h"><h3>Controls</h3><span class="grow"></span><span class="muted" style="font-size:11.5px">human-only</span></div>
      <div class="card-b" style="padding:13px 14px;display:flex;flex-direction:column;gap:10px">
        ${a.kind === "human" ? '<div class="none" style="padding:16px">This is you — the human authority. No wake controls.</div>' : `
        <div class="ctrl"><div class="grow"><div class="lbl">Provider</div><div class="desc">Claude Code or Codex</div></div>
          <div class="seg" id="modelRuntimeSeg" data-agent="${AgeO.esc(a.id)}" aria-label="Model provider">${MODEL_RUNTIMES.map((r)=>`<button type="button" class="${r.id===selectedRuntime?'on':''}" data-runtime="${AgeO.esc(r.id)}" aria-pressed="${r.id===selectedRuntime?'true':'false'}" ${AgeO.actingHuman() && modelsForRuntime(r.id).length ? "" : "disabled"}>${AgeO.esc(r.name)}</button>`).join("")}</div></div>
        <div class="ctrl model-ctrl"><div class="grow"><div class="lbl">Model</div><div class="desc">Which ${AgeO.esc(modelRuntimeName(selectedRuntime))} model this agent wakes as</div></div>
          <div class="seg" id="modelSeg" data-agent="${AgeO.esc(a.id)}" data-runtime="${AgeO.esc(selectedRuntime)}" aria-label="${AgeO.esc(modelRuntimeName(selectedRuntime))} model">${visibleModels.length ? visibleModels.map((m)=>`<button type="button" class="${m.id===a.model?'on':''}" data-model="${AgeO.esc(m.id)}" aria-pressed="${m.id===a.model?'true':'false'}" title="${AgeO.esc(m.name)}" ${AgeO.actingHuman()?"":"disabled"}>${AgeO.esc(m.name)}</button>`).join("") : '<span class="none" style="padding:4px 9px">No models</span>'}</div></div>
        <div class="ctrl"><div class="grow"><div class="lbl">Reasoning effort</div><div class="desc">Worker effort requested on the next wake</div></div>
          <div class="seg" id="effortSeg" data-agent="${AgeO.esc(a.id)}" aria-label="Reasoning effort">${REASONING_EFFORTS.map((e)=>`<button type="button" class="${e.id===selectedEffort?'on':''}" data-effort="${e.id == null ? "null" : AgeO.esc(e.id)}" aria-pressed="${e.id===selectedEffort?'true':'false'}" ${AgeO.actingHuman()?"":"disabled"}>${AgeO.esc(e.name)}</button>`).join("")}</div></div>
        <div class="ctrl"><div class="grow"><div class="lbl">Wake</div><div class="desc">Daemon may wake this agent on pending work</div></div>
          <span class="wakebadge ${a.wake_enabled?'on':'off'}"><span class="d"></span>${a.wake_enabled?"Enabled":"Disabled"}</span></div>
        <div class="ctrl"><div class="grow"><div class="lbl">Auto-wake</div><div class="desc">Clock-driven heartbeat — wake on a fixed cadence even with no pending work</div></div>
          <div class="seg" id="awakeSeg" data-agent="${AgeO.esc(a.id)}" aria-label="Auto-wake interval">${awakePresets(a.auto_wake_interval_secs).map((p)=>`<button type="button" class="${p.secs===(a.auto_wake_interval_secs!=null?a.auto_wake_interval_secs:null)?'on':''}" data-awake="${p.secs==null?'null':p.secs}" aria-pressed="${p.secs===(a.auto_wake_interval_secs!=null?a.auto_wake_interval_secs:null)?'true':'false'}" ${AgeO.actingHuman()?"":"disabled"}>${AgeO.esc(p.label)}</button>`).join("")}</div></div>
        <div class="ctrl"><div class="grow"><div class="lbl">Autonomy</div><div class="desc">${autOvrDesc(a)}</div></div>
          <div class="seg" id="autOvrSeg" data-agent="${AgeO.esc(a.id)}" aria-label="Per-agent autonomy override">${AUT_OVERRIDES.map((o)=>`<button type="button" class="${(a.autonomy_override||null)===o.id?'on':''}" data-ovr="${o.id==null?'null':AgeO.esc(o.id)}" aria-pressed="${(a.autonomy_override||null)===o.id?'true':'false'}" ${ovrChipEnabled(o) ? "" : "disabled"}>${AgeO.esc(o.name)}</button>`).join("")}</div></div>`}
      </div>
    </div>
  </div>`;

  /* current task + memory digest */
  html += `<div class="g2" style="margin-bottom:18px">
    <div class="card${isCollapsed("currentTask") ? " collapsed" : ""}">
      <div class="card-h"><h3>Current task</h3><span class="count">${current.length ? "· " + current.length : ""}</span><span class="grow"></span>${AgeO.sortControlHtml("agent-tasks")}${collapseBtn("currentTask")}</div>
      <div class="card-b" style="padding:12px 14px;display:flex;flex-direction:column;gap:10px">
        ${current.length ? current.map((t) => `<a class="lrow" style="border:1px solid var(--border)" href="/tasks?task=${encodeURIComponent(t.id)}">
          <div class="grow"><div class="t1">${t.is_root?'<span class="tag root" style="margin-right:6px">root</span>':''}${AgeO.esc(t.title)}</div>
            <div class="t2">${AgeO.esc(AgeO.trunc(t.definition_of_done, 64))}</div></div>${AgeO.pill(t.status)}</a>`).join("")
          : '<div class="none">No task in progress.</div>'}
        ${mine.length ? `<div class="tchips-wrap"><div class="tchips-lbl">All tasks · ${mine.length}</div>
          <div class="tchips">${mine.slice(0, tasksShown).map((t) => `<a class="tchip" href="/tasks?task=${encodeURIComponent(t.id)}" title="${AgeO.esc(t.title)}">${AgeO.glyph(AgeO.statusClass(t.status))}<span>${AgeO.esc(AgeO.trunc(t.title, 30))}</span></a>`).join("")}</div>
          ${moreBtn("tasks", Math.min(tasksShown, mine.length), mine.length)}</div>` : ""}
      </div>
    </div>
    <div class="card${isCollapsed("memoryDigest") ? " collapsed" : ""}">
      <div class="card-h"><h3>Memory digest</h3><span class="grow"></span><span class="muted" style="font-size:11.5px">where it left off</span>${collapseBtn("memoryDigest")}</div>
      <div class="card-b" style="padding:13px 14px">${digestBlock(a)}</div>
    </div>
  </div>`;

  /* requests in/out (ISS-38) */
  const ri = reqIn(a.alias).sort(AgeO.sortComparator("agent-req-in", reqSortAcc()));
  const ro = reqOut(a.alias).sort(AgeO.sortComparator("agent-req-out", reqSortAcc()));
  html += `<div class="g2" style="margin-bottom:18px">
    <div class="card${isCollapsed("incomingReq") ? " collapsed" : ""}"><div class="card-h"><h3>Incoming requests</h3><span class="count">(${ri.length})</span><span class="grow"></span>${AgeO.sortControlHtml("agent-req-in")}${collapseBtn("incomingReq")}</div>
      <div class="card-b" style="padding:12px 14px;display:flex;flex-direction:column;gap:9px">
        ${ri.length ? ri.slice(0, riShown).map((r)=>reqMini(r, "from", r.from)).join("") + moreBtn("ri", Math.min(riShown, ri.length), ri.length) : '<div class="none">No incoming requests.</div>'}</div></div>
    <div class="card${isCollapsed("outgoingReq") ? " collapsed" : ""}"><div class="card-h"><h3>Outgoing requests</h3><span class="count">(${ro.length})</span><span class="grow"></span>${AgeO.sortControlHtml("agent-req-out")}${collapseBtn("outgoingReq")}</div>
      <div class="card-b" style="padding:12px 14px;display:flex;flex-direction:column;gap:9px">
        ${ro.length ? ro.slice(0, roShown).map((r)=>reqMini(r, "to", r.to)).join("") + moreBtn("ro", Math.min(roShown, ro.length), ro.length) : '<div class="none">No outgoing requests.</div>'}</div></div>
  </div>`;

  AgeO.patch(Age$("detailMain"), html, force);

  // wire the model segmented control (delegated, human-only)
  const runtimeSeg = Age$("modelRuntimeSeg");
  if (runtimeSeg) runtimeSeg.addEventListener("click", onModelRuntimeClick);
  const seg = Age$("modelSeg");
  if (seg) seg.addEventListener("click", onModelClick);
  const effortSeg = Age$("effortSeg");
  if (effortSeg) effortSeg.addEventListener("click", onEffortClick);
  const awakeSeg = Age$("awakeSeg");
  if (awakeSeg) awakeSeg.addEventListener("click", onAwakeClick);
  const ovrSeg = Age$("autOvrSeg");
  if (ovrSeg) ovrSeg.addEventListener("click", onAutOvrClick);
  // wire persona Expand
  const px = Age$("personaExpandBtn");
  if (px) px.addEventListener("click", () => togglePersona(a));
}

/* ---------- gate callout (ISS-33/36 + ISS-41 plan_decision gating) ---------- */
function gateCallout(a, mine) {
  // verify gate: any owned task awaiting human verification (status-independent of the agent).
  const verify = mine.find((t) => t.status === "needs_verification");
  // plan gate: an in-progress task whose agent posted a plan...
  const planTask = mine.find((t) => t.status === "in_progress" && planMsgOf(t));
  if (planTask) {
    if (!planTask.plan_decision) {
      // undecided -> live approval lives on the Tasks gate (one authoritative surface).
      return calloutCard("attn", "shield", "Plan awaiting your approval",
        `${AgeO.esc(planTask.title)} — surfaced regardless of ${AgeO.esc(a.alias)}'s status.`,
        planTask.id, "Review plan");
    }
    // decided -> ISS-41: quiet decided-note, never a live re-approve; suppressed across reload.
    const pd = planTask.plan_decision;
    const verb = pd.decision === "approve" ? "approved" : "rejected";
    const when = pd.at ? AgeO.relTime(pd.at) : "";
    return `<div class="gatecard decided"><div class="row">
      <span style="color:var(--${pd.decision === "approve" ? "ok" : "danger"})">${AgeO.icon(pd.decision === "approve" ? "check" : "x", "")}</span>
      <div class="grow"><div class="ttl">Plan ${AgeO.esc(verb)}</div>
        <div class="dnote">"${AgeO.esc(AgeO.trunc(planTask.title, 80))}" — ${AgeO.esc(verb)}${pd.actor ? " by <b>" + AgeO.esc(pd.actor) + "</b>" : ""}${when ? " · " + AgeO.esc(when) : ""}.${pd.reason ? " " + AgeO.esc(AgeO.trunc(pd.reason, 120)) : ""}</div></div>
      <a class="btn sm ghost" href="/tasks?task=${encodeURIComponent(planTask.id)}">Open task ${AgeO.icon("arrow","")}</a>
    </div></div>`;
  }
  if (verify) {
    return calloutCard("attn", "check", "Task awaiting verification",
      `${AgeO.esc(verify.title)} — surfaced regardless of ${AgeO.esc(a.alias)}'s status.`,
      verify.id, "Verify");
  }
  return "";
}
function calloutCard(cls, ic, ttl, sub, taskId, cta) {
  return `<div class="gatecard ${cls}"><div class="row">
    <span style="color:var(--warn)">${AgeO.icon(ic, "")}</span>
    <div class="grow"><div class="ttl">${ttl}</div><div class="sub">${sub}</div></div>
    <a class="btn sm" href="/tasks?task=${encodeURIComponent(taskId)}">${cta} ${AgeO.icon("arrow","")}</a>
  </div></div>`;
}

/* ---------- persona expand (lazy /persona) ---------- */
function personaExpandBlock(a) {
  const open = !!personaOpen[a.id];
  let block = `<div class="persona-expand"><button class="btn sm ghost" id="personaExpandBtn">${open ? "Hide full prompt" : "Expand full prompt"}</button></div>`;
  if (open) {
    const full = personaFull[a.id];
    block += `<div class="persona-full">${full === undefined ? "Loading…" : AgeO.esc(full || "(no system prompt)")}</div>`;
  }
  return block;
}
function togglePersona(a) {
  personaOpen[a.id] = !personaOpen[a.id];
  if (personaOpen[a.id] && personaFull[a.id] === undefined) {
    fetch("/api/agents/" + encodeURIComponent(a.id) + "/persona")
      .then((r) => r.ok ? r.json() : Promise.reject(r.status))
      .then((d) => { personaFull[a.id] = d.system_prompt || ""; renderDetailMain(); })
      .catch(() => { personaFull[a.id] = ""; renderDetailMain(); });
  }
  renderDetailMain();
}

/* ---------- memory digest (lazy /digest) ---------- */
function digestBlock(a) {
  if (a.kind === "human") return '<div class="none">Humans don\'t rehydrate — no digest.</div>';
  const c = digestCache[a.id];
  if (c === undefined || c.loading) return '<div class="none">Loading digest…</div>';
  const d = c.digest;
  if (!d) return '<div class="none">No digest yet — this agent hasn\'t snapshotted.</div>';
  const norm = (items) => (items || []).map((x) => (x && typeof x === "object") ? (x.text || JSON.stringify(x)) : String(x)).filter(Boolean);
  // ISS-68 PR-3 render cap: keep the digest compact by default so the worker-run feed below
  // stays reachable. The cap is a budget over the FLATTENED decisions→learnings→threads list
  // (Current focus always shows); "Show more" (delegated [data-more=digest]) reveals the rest,
  // and select() resets digestShown on agent switch. Pairs with the card's collapse chevron.
  const groups = [
    { label: "Recent decisions", arr: norm(d.decisions), thr: false },
    { label: "Learnings", arr: norm(d.learnings), thr: false },
    { label: "Open threads", arr: norm(d.open_threads), thr: true },
  ];
  const total = groups.reduce((n, g) => n + g.arr.length, 0);
  let remaining = digestShown;
  const groupHtml = groups.map((g) => {
    if (!g.arr.length) return "";
    const take = g.arr.slice(0, Math.max(0, remaining));
    remaining -= g.arr.length;
    if (!take.length) return "";
    return `<div class="dgroup ${g.thr ? "thr" : ""}"><div class="lbl">${g.label}</div><ul>${take.map((s) => `<li>${AgeO.esc(s)}</li>`).join("")}</ul></div>`;
  }).join("");
  return `<div class="digest">
    ${d.current_focus ? `<div class="focus"><div class="lbl">${AgeO.icon("dot","")}Current focus</div>${AgeO.esc(d.current_focus)}</div>` : ""}
    ${groupHtml}
    ${moreBtn("digest", Math.min(digestShown, total), total)}
  </div>`;
}
function fetchDigest(a) {
  if (a.kind === "human" || digestCache[a.id] !== undefined) return;
  digestCache[a.id] = { loading: true };
  fetch("/api/agents/" + encodeURIComponent(a.id) + "/digest")
    .then((r) => r.ok ? r.json() : Promise.reject(r.status))
    .then((d) => { digestCache[a.id] = { digest: d.digest || null }; renderDetailMain(); })
    .catch(() => { digestCache[a.id] = { digest: null }; renderDetailMain(); });
}

/* ---------- requests mini-row (ISS-38 deeplink to served route) ---------- */
function reqMini(r, dir, who) {
  return `<a class="rqrow" href="/requests?req=${encodeURIComponent(r.id)}">
    <div class="body">
      <div class="top">${AgeO.pill(r.escalated ? "escalated" : r.status)}
        <span class="tag">${AgeO.esc(r.type)}</span>
        <span class="muted" style="font-size:11.5px">${dir} <b style="color:var(--text-2)">${AgeO.esc(who)}</b></span>
        ${r.chain_depth ? '<span class="tag" style="color:var(--info)">↳ chain '+AgeO.esc(r.chain_depth)+'</span>' : ''}
        <span class="muted" style="font-size:11px;margin-left:auto">${r.created_at ? AgeO.relTime(r.created_at) : ""}</span></div>
      <div class="pl">${AgeO.esc(AgeO.trunc(r.payload, 120))}</div>
      ${r.response ? `<div class="ans">${AgeO.esc(AgeO.trunc(r.response, 110))}</div>` : ""}
    </div></a>`;
}

/* ---------- auto-wake control (#300: PATCH /api/agents/{id}/auto-wake) ----------
   Clock-driven heartbeat cadence. Off (null) + a few presets; the backend floor is 60s
   and editing is HUMAN-AUTHORITY gated (only a registered human may change wake policy),
   so the control is disabled until an acting human is picked. If the agent already carries
   a non-preset value (set via API), it's surfaced as an extra honest chip so the live
   state is never hidden behind "none of these are on". */
const AWAKE_PRESETS = [
  { secs: null, label: "Off" },
  { secs: 300, label: "5m" },
  { secs: 900, label: "15m" },
  { secs: 3600, label: "1h" },
];

/* ---------- per-agent autonomy override (mig 034: PATCH /api/agents/{id}) ----------
   Inherit (null) = the container level governs; a level chip grants THIS agent a different
   engine level WITHOUT moving the container slider. HUMAN-AUTHORITY gated (same PATCH lane
   as role + persona edits). While the container ENFORCES its level (autonomy_enforced), every
   override is ignored server-side — the chips render disabled with an honest "enforced"
   note so the live state is never misread. The desc always names the EFFECTIVE level (the
   snapshot's server-computed effective_autonomy — the one shared rule the completion gate
   uses), so what the human reads here is exactly what the engine will do. */
const AUT_OVERRIDES = [
  { id: null, name: "Inherit" },
  { id: "plan", name: "Plan-only" },
  { id: "pr", name: "Build to PR" },
  { id: "full", name: "Full" },
];
function autLevelName(level) {
  return ((AUT_OVERRIDES.find((o) => o.id === level) || {}).name) || level || "Plan-only";
}
function containerEnforced() {
  const c = AgeD() && AgeD().container;
  return !!(c && c.autonomy_enforced);
}
// F3(b): while the container ENFORCES its level, every override is ignored server-side — so setting
// a NEW override is pointless (chips disabled). But the operator must still be able to CLEAR a stale
// override, else a "full" grant is stuck until enforcement lifts (and it silently resumes then).
// Keep the "Inherit" chip (o.id == null) clickable while enforced; disable the rest. When not
// enforced, all chips follow the usual acting-human gate.
function ovrChipEnabled(o) {
  if (!AgeO.actingHuman()) return false;
  if (containerEnforced()) return o.id == null;   // only Inherit (clear) stays live while enforced
  return true;
}
function effectiveAutonomyOf(a) {
  // Prefer the server-computed field (single shared rule); degrade to the same rule computed
  // client-side for a pre-034 snapshot that omits it.
  if (a.effective_autonomy) return a.effective_autonomy;
  const c = (AgeD() && AgeD().container) || {};
  const containerLevel = c.autonomy_level || "plan";
  return containerEnforced() ? containerLevel : (a.autonomy_override || containerLevel);
}
function autOvrDesc(a) {
  const eff = "Effective: " + autLevelName(effectiveAutonomyOf(a));
  if (containerEnforced()) {
    // F3(b): when a parked override exists under enforcement, tell the operator they can still
    // clear it (Inherit stays live) — so a stale "full" grant is never stuck until enforcement lifts.
    const parked = a.autonomy_override
      ? " — 🔒 container enforces its level for all agents (override '" + autLevelName(a.autonomy_override) + "' parked & ignored; Inherit to clear it)"
      : " — 🔒 container enforces its level for all agents (override ignored)";
    return eff + parked;
  }
  return eff + (a.autonomy_override ? " — per-agent override" : " — inherits the container level");
}
