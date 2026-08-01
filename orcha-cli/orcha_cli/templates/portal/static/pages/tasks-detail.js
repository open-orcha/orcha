/* Tasks page controller: task detail, gate surface, protocol, assignment, and message rows. */

/* open-orcha#209: tasks.result is JSONB, but /done (TaskDone.result) takes a
   required plain string — the server is the one that turns it into an object:
   task_done_routes.py wraps every completion in {"result": <text>, "by_agent_id":
   <uuid>} before writing tasks.result, and the list query hands that envelope
   back raw. These render sites string-interpolated it as-is — the verifying
   human saw literally "[object Object]" at the verification gate. Normalize
   every shape to text: strings pass through; the known {result, by_agent_id}
   envelope unwraps explicitly (even when result is blank, so a blank result
   still falls through to the caller's "—" instead of dumping the envelope);
   any other object with a conventional text field yields that field; anything
   else becomes readable pretty-printed JSON (escaped by the caller's
   linkify/esc as usual). */
function resultText(r) {
  if (r == null) return "";
  if (typeof r === "string") return r;
  if (typeof r === "object") {
    // the ONE shape /done actually produces: unwrap it explicitly, blank or not,
    // so a blank agent result renders as "—" (via the caller's fallback) instead
    // of leaking the envelope — including the agent's UUID — onto the gate.
    if (typeof r.result === "string" && "by_agent_id" in r) return r.result;
    for (const k of ["result", "summary", "text", "message"]) {
      if (typeof r[k] === "string" && r[k].trim()) return r[k];
    }
    try { return JSON.stringify(r, null, 2); } catch (e) { return String(r); }
  }
  return String(r);
}

function renderDetail(force) {
  const t = (TasD().tasks || []).find((x) => x.id === sel);
  if (!t) { TasO.patch(Tas$("detailMain"), '<div class="card pad"><div class="none">Task not found.</div></div>', force); return; }
  const who = t.assignee, a = TasO.agentByAlias(who);

  let html = `<div class="card pad thead" style="margin-bottom:18px">
    <div class="row" style="align-items:flex-start;gap:13px">
      <div class="grow">
        <h1>${t.is_root ? '<span class="tag root" style="margin-right:8px;vertical-align:middle">root</span>' : ""}${TasO.esc(t.title)}</h1>
        <div class="row" style="gap:10px;margin-top:10px;flex-wrap:wrap">
          ${TasO.pill(t.status, "lg")}
          <span class="prio ${t.priority<=20?'p-hi':t.priority<=40?'p-md':''}">Priority ${TasO.esc(t.priority)}</span>
          <span class="muted" style="font-size:12.5px">·</span>
          <span class="muted" style="font-size:12.5px">assignee</span> ${who ? TasO.agentLink(who) : "—"}
        </div>
      </div>
    </div>
    ${t.description ? `<div class="field" style="margin-top:16px;padding-top:15px;border-top:1px solid var(--border)"><div class="lbl">Description</div><div class="tx">${TasO.esc(t.description)}</div></div>` : ""}
    <div class="field" style="margin-top:14px"><div class="lbl">Definition of done</div><div class="dod">${TasO.esc(t.definition_of_done || "—")}</div></div>
    ${t.result ? `<div class="field" style="margin-top:14px"><div class="lbl">Result</div><div class="tx">${TasO.linkify(resultText(t.result))}</div></div>` : ""}
  </div>`;

  /* the human-authority gate — plan-approval (B10) OR verify (Epic B), never a dead-end */
  html += gateSurface(t);

  /* SPEC-4 — per-task hand-off protocol, directly under the gate / above Assignment:
     what's the decision (gate) -> what are the rules (protocol) -> who's on it (assignment) */
  html += protocolSurface(t);

  /* collaboration thread + reply — ISS-68: the snapshot only carries a message_summary now,
     so the FULL thread is lazy-fetched on select (threadCache) and rendered when it lands. */
  maybeLoadThread(t);
  const msgs = threadCache[t.id] || [];
  const summaryCount = (t.message_summary && t.message_summary.count) || 0;
  const loading = !!threadLoading[t.id] && !msgs.length;
  const errored = !!threadError[t.id] && !msgs.length;   // #74: failed/inconsistent fetch, no cache
  // #74: a REFRESH failed while cached messages are still shown (summary grew, refetch errored).
  // The latch suppresses auto-retries, so without an explicit control the thread would silently
  // stay stale until a full page refresh — surface a banner + retry alongside the cached messages.
  const staleError = !!threadError[t.id] && !!msgs.length;
  const retryBtn = `<button type="button" class="btn subtle sm" data-thread-retry="${TasO.esc(t.id)}">Retry</button>`;
  const count = msgs.length || summaryCount;
  html += `<div class="card" style="margin-bottom:18px">
    <div class="card-h"><h3>Thread</h3><span class="count">${count ? "(" + count + ")" : ""}</span>
      <span class="grow"></span><span class="muted" style="font-size:11.5px">append-only · agents + you</span></div>
    <div class="card-b" style="padding:16px 18px">
      ${msgs.length ? `${staleError ? `<div class="none thread-err" style="margin-bottom:12px">Couldn’t refresh — showing cached messages. ${retryBtn}</div>` : ""}<div class="thread">${msgs.map(msgRow).join("")}</div>`
        : (loading ? '<div class="none">Loading thread…</div>'
                   : (errored ? `<div class="none thread-err">Couldn’t load the thread. ${retryBtn}</div>`
                              : (summaryCount ? '<div class="none">Loading thread…</div>' : '<div class="none">No messages yet.</div>')))}
      <div id="replyWrap" class="reply-wrap" style="margin-top:16px;padding-top:14px;border-top:1px solid var(--border)">
        <div class="reply-row">
          ${humanAvatar()}
          <button type="button" class="attach-btn" id="attachBtn" title="Attach files (or drag-drop / paste)" aria-label="Attach files">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg>
          </button>
          <input id="attachInput" type="file" multiple accept=".png,.jpg,.jpeg,.gif,.webp,.pdf,.txt,.md,.csv,.log,.json" style="display:none">
          <input id="reply" class="reply-in" placeholder="Add a comment… (drag, paste or attach files)">
          <button class="btn subtle" id="replyBtn" data-task="${TasO.esc(t.id)}">Post</button>
        </div>
        <div id="attachTray" class="attach-tray"></div>
      </div>
    </div></div>`;

  /* O4 — human authority to (re)assign + wake an agent on this task (Forge B5) */
  html += assignSurface(t);

  /* B7 — human authority to force-close a non-root, non-terminal task */
  if (!t.is_root && t.status !== "completed" && t.status !== "cancelled") {
    html += `<div class="card" style="margin-bottom:18px"><div class="card-h"><h3>Close task</h3>
      <span class="grow"></span><span class="muted" style="font-size:11.5px">human authority</span></div>
      <div class="card-b" style="padding:14px 16px" id="cancelWrap" data-task="${TasO.esc(t.id)}">
        <p class="muted" style="font-size:12.5px;margin:0 0 11px">Force-close this task and unblock anything waiting on it. A reason is recorded and routed to ${TasO.esc(who || "the assignee")}.</p>
        <textarea id="cancelReason" class="reply-in" style="width:100%;min-height:60px;resize:vertical" placeholder="Reason (recommended)…"></textarea>
        <div style="margin-top:10px"><button class="btn danger" data-act="cancel">${TasO.icon("x","")}Close task…</button></div>
      </div></div>`;
  }

  // only (re)wire when patch actually replaced the DOM — a deferred/unchanged repaint
  // keeps the existing nodes + listeners, so re-wiring would stack duplicate handlers.
  if (TasO.patch(Tas$("detailMain"), html, force)) wire(t);
}

/* ---------- gate (plan-approval + verify), gated on plan_decision (ISS-41) ---------- */
function gateSurface(t) {
  // decided plan -> quiet decided-note, never a live re-approve, suppressed across reload
  if (t.status === "in_progress" && t.plan_decision) {
    const pd = t.plan_decision, ok = pd.decision === "approve";
    return `<div class="card pad" style="margin-bottom:18px;border-color:var(--border)">
      <div class="row" style="gap:11px"><span style="color:var(--${ok?'ok':'danger'})">${TasO.icon(ok?'check':'x','')}</span>
        <div class="grow"><div style="font-weight:680;font-size:14px">Plan ${ok ? "approved" : "rejected"}</div>
          <div class="muted" style="font-size:12.5px;margin-top:2px">${ok ? "" : ""}${pd.actor ? "by " + TasO.esc(pd.actor) : ""}${pd.at ? " · " + TasO.relTime(pd.at) : ""}${pd.reason ? " — " + TasO.esc(TasO.trunc(pd.reason, 140)) : ""}</div></div>
      </div></div>`;
  }
  if (acted.has(t.id)) return "";   // optimistic: just acted this session, snapshot catching up
  const isPlan = pendingPlan(t);
  const isVerify = t.status === "needs_verification";
  if (!isPlan && !isVerify) return "";
  const pm = isPlan ? planMsgOf(t) : null;
  const disabled = TasO.actingHuman() ? "" : "disabled";
  return `<div class="gate" id="gate-${TasO.esc(t.id)}" data-task="${TasO.esc(t.id)}" data-kind="${isPlan ? "plan" : "verify"}" data-author="${TasO.esc(isPlan && TasO.agentByAlias(pm.from) ? TasO.agentByAlias(pm.from).id : "")}" style="margin-bottom:18px">
    <div class="gh"><span class="badge">${TasO.icon(isPlan ? "shield" : "check", "")}${isPlan ? "Plan awaiting your approval" : "Awaiting verification"}</span>
      <span class="grow"></span>
      <span class="acting-note">${humanAvatar()}${actorName() ? "acting as " + TasO.esc(actorName()) + " · " : ""}logged to the audit trail</span></div>
    <div class="gb">
      <div class="field"><div class="lbl">${TasO.icon("dot", "")}${isPlan ? "Proposed plan — full text" : "Result claimed by " + TasO.esc(who(t))}</div>
        <div class="tx" style="white-space:pre-wrap;max-height:300px;overflow-y:auto">${TasO.linkify(isPlan ? (pm.body || "") : (resultText(t.result) || "—"))}</div></div>
      <div class="field" style="margin-top:14px"><div class="lbl">${TasO.icon("check", "")}Definition of done</div>
        <div class="dod">${TasO.esc(t.definition_of_done || "—")}</div></div>
      <div class="actions">
        <button class="btn approve" data-act="approve" ${disabled}>${TasO.icon("check", "")}${isPlan ? "Approve plan" : "Accept"}</button>
        <button class="btn ghost" data-act="reject" ${disabled}>${isPlan ? "Request changes…" : "Reject…"}</button>
        <span class="acting-note">${isPlan ? "Approving lets " + TasO.esc(who(t)) + " execute." : "Rejecting returns the task to " + TasO.esc(who(t)) + "."}</span>
      </div>
      <div class="reason" id="reason-${TasO.esc(t.id)}">
        <textarea id="rt-${TasO.esc(t.id)}" placeholder="Why are you ${isPlan ? "requesting changes" : "rejecting"}? Required — ${TasO.esc(who(t))} sees this verbatim on the next wake."></textarea>
        <div class="hint">${TasO.icon("flag", "")} A typed reason is required to ${isPlan ? "reject the plan" : "reject"}.</div>
        <div style="display:flex;gap:9px;margin-top:11px">
          <button class="btn danger" data-act="confirm-reject" id="cr-${TasO.esc(t.id)}" disabled>Submit ${isPlan ? "rejection" : "rejection"}</button>
          <button class="btn subtle" data-act="cancel-reject">Cancel</button>
        </div>
      </div>
    </div></div>`;
}
function who(t) { return t.assignee || "the assignee"; }

/* ---------- SPEC-4 protocol panel — collapsible hand-off rules on the task itself ----------
   Reads `t.protocol` (Ledger: tasks.protocol JSONB {review_chain,handoff_to,autonomy,notes},
   all optional free-text; null when unset). [Edit] is human-authority only -> PATCH
   /api/tasks/{tid}/protocol (partial merge, echoes the full merged protocol). */
function protoEmpty(p) { return !p || (!p.review_chain && !p.handoff_to && !p.autonomy && !p.notes); }
function protocolSurface(t) {
  const st = protoUI[t.id] || (protoUI[t.id] = { collapsed: false, editing: false, draft: null });
  const p = t.protocol || {};
  const canEdit = !!TasO.actingHuman();
  // EMPTY + not editing: container-defaults note; "Set protocol" only for the acting human.
  if (protoEmpty(t.protocol) && !st.editing) {
    return `<div class="proto" id="proto-${TasO.esc(t.id)}" data-task="${TasO.esc(t.id)}">
      <div class="ph"><span class="ttl">${TasO.icon("shield", "")}Protocol</span><span class="grow"></span>
        ${canEdit ? `<button class="btn ghost sm" data-pact="set">Set protocol</button>` : ""}</div>
      <div class="empty-proto">No protocol set — using container defaults.</div></div>`;
  }
  const d = st.editing ? (st.draft || {}) : p;
  const chips = (!st.editing && (p.handoff_to || p.autonomy)) ? `<div class="chips">
      ${p.handoff_to ? `<span class="pchip"><span class="lbl">hand-off</span>${TasO.esc(p.handoff_to)}</span>` : ""}
      ${p.autonomy ? `<span class="pchip aut">${TasO.esc(TasO.trunc(String(p.autonomy).split(" · ")[0], 28))}</span>` : ""}
    </div>` : "";
  const cls = "proto" + (st.collapsed && !st.editing ? " collapsed" : "") + (st.editing ? " editing" : "");
  const row = (label, key, isNotes) => {
    const display = key === "review_chain"
      ? `<span class="arrowchain">${TasO.esc(p.review_chain || "—")}</span>`
      : key === "handoff_to"
        ? `${TasO.esc(p.handoff_to || "—")}${p.handoff_to ? ` <span class="muted" style="font-weight:450">— return here first</span>` : ""}`
        : key === "notes"
          ? TasO.linkify(p.notes || "—")
          : TasO.esc(p[key] || "—");
    // #55: all four fields are drag-expandable <textarea>s (resize: vertical via the
    // .prow textarea CSS) — a multi-line review_chain/handoff_to/autonomy is common, not
    // just Notes. saveProtocol() reads .value off [data-pfield], so input vs textarea is moot.
    const input = `<textarea data-pfield="${key}">${TasO.esc(d[key] || "")}</textarea>`;
    return `<div class="prow"><span class="k">${label}</span>
      <span class="v${isNotes ? " notes" : ""}">${display}</span>
      <div class="edit">${input}</div></div>`;
  };
  return `<div class="${cls}" id="proto-${TasO.esc(t.id)}" data-task="${TasO.esc(t.id)}">
    <div class="ph">
      <span class="ttl">${TasO.icon("shield", "")}Protocol</span>
      ${chips}
      <span class="grow"></span>
      ${canEdit ? `<button class="btn ghost sm editbtn" data-pact="edit">Edit</button>` : ""}
      <span class="chev" data-pact="toggle">${TasO.icon("chev", "")}</span>
    </div>
    <div class="pb">
      ${row("Review chain", "review_chain", false)}
      ${row("Hand-off to", "handoff_to", false)}
      ${row("Autonomy", "autonomy", false)}
      ${row("Notes", "notes", true)}
    </div>
    <div class="pf"><button class="btn ghost sm" data-pact="cancel">Cancel</button><button class="btn sm approve" data-pact="save">Save protocol</button></div>
  </div>`;
}

/* O4 — assign-from-detail + wake (Forge B5: POST /api/tasks/{tid}/assign). Shown only when
   the task is assignable; B5 refuses root + finished tasks (409), so we hide it there. */
function assignSurface(t) {
  const TERMINAL = ["completed", "needs_verification", "cancelled"];
  if (t.is_root || TERMINAL.indexOf(t.status) >= 0) return "";
  const ais = (TasD().agents || []).filter((x) => x.kind === "ai");
  if (!ais.length) return "";
  const cur = t.assignee;
  const opts = ais.map((x) => `<option value="${TasO.esc(x.id)}"${x.alias === cur ? " selected" : ""}>${TasO.esc(x.alias)}${x.alias === cur ? " (current)" : ""}</option>`).join("");
  return `<div class="card" style="margin-bottom:18px" id="assignWrap" data-task="${TasO.esc(t.id)}">
    <div class="card-h"><h3>Assignment</h3><span class="grow"></span><span class="muted" style="font-size:11.5px">human authority · wakes the agent</span></div>
    <div class="card-b" style="padding:14px 16px">
      <p class="muted" style="font-size:12.5px;margin:0 0 11px">Assign this task to an agent and wake them to start.${cur ? " Reassigning releases " + TasO.esc(cur) + "." : ""}</p>
      <div class="row" style="gap:9px;align-items:center;flex-wrap:wrap">
        <select id="assignSel" class="reply-in" style="max-width:260px">${opts}</select>
        <button class="btn approve" data-act="assign">${TasO.icon("arrow", "")}Assign &amp; wake</button>
      </div>
    </div></div>`;
}

// #301: human-readable byte size for chips/file rows.
function fmtSize(n) {
  n = +n || 0;
  if (n < 1024) return n + " B";
  if (n < 1024 * 1024) return (n / 1024).toFixed(n < 10240 ? 1 : 0) + " KB";
  return (n / (1024 * 1024)).toFixed(1) + " MB";
}
const FILE_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/></svg>';
// #301: render a message's attachments (read view). Images → inline thumbnail (click = lightbox);
// everything else → a download chip. esc() the name; the url is a same-origin /api path.
function attRow(a) {
  const url = TasO.esc(a.url || "");
  const nm = TasO.esc(a.name || a.id || "file");
  if (a.kind === "image") {
    return `<img class="att-img" src="${url}" alt="${nm}" title="${nm}" loading="lazy" data-lightbox="${url}">`;
  }
  return `<a class="att-file" href="${url}" target="_blank" rel="noopener" download>${FILE_ICON}
    <span>${nm}</span><span class="sz">${fmtSize(a.size)}</span></a>`;
}

function msgRow(m) {
  const sys = !m.from || m.from === "system";
  const a = TasO.agentByAlias(m.from);
  const atts = (m.attachments || []).length
    ? `<div class="msg-atts">${m.attachments.map(attRow).join("")}</div>` : "";
  return `<div class="msg ${m.is_human ? "human" : sys ? "system" : ""}">
    ${sys ? '<span class="av sm" style="background:var(--surface-3);color:var(--muted)">›</span>' : TasO.avatar(m.from, a ? a.kind : "ai", "sm")}
    <div class="body">
      <div class="mh"><span class="nm">${sys ? "system" : TasO.esc(m.from)}</span>
        ${a && !sys ? TasO.kindBadge(a.kind) : ""}<span class="when">${m.at ? TasO.relTime(m.at) : ""}</span></div>
      <div class="bubble">${TasO.linkify(m.body)}</div>
      ${atts}
    </div></div>`;
}

/* ---------- acting human helpers ---------- */
