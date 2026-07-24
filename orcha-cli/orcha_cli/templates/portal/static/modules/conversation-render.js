/* Conversation panel module: draft persistence, bubbles, attachment rows, presence, and polling. */
/* ---------- ISS-64: persist the composer draft across navigation ----------
   Switching agent tabs remounts this panel, and navigating to another portal page reloads it
   entirely — both wipe the textarea. Persist the per-agent draft in sessionStorage (survives
   page navigation within the tab) and rehydrate on mount; cleared once the turn is sent. */
const draftKey = (aid) => "orcha:convdraft:" + aid;
function saveDraft(v) {
  if (!agentId) return;
  try { v ? sessionStorage.setItem(draftKey(agentId), v) : sessionStorage.removeItem(draftKey(agentId)); } catch (e) {}
}
function loadDraft(aid) { try { return sessionStorage.getItem(draftKey(aid)) || ""; } catch (e) { return ""; } }

/* ---------- render the message list (repaints on poll; composer untouched) ---------- */
function renderList() {
  const list = document.getElementById("convList"); if (!list) return;
  if (!turns.length) { list.innerHTML = '<div class="none" style="padding:18px">No messages yet — say hello to start the conversation.</div>'; return; }
  const atBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 40;
  // ISS-68 PR-3: render only the most-recent `shown` turns; "Load earlier" reveals the rest.
  const startIdx = Math.max(0, turns.length - shown);
  const visible = turns.slice(startIdx);
  const earlier = startIdx > 0
    ? `<button class="btn sm ghost" style="display:block;margin:0 auto 12px" data-loadearlier>Load earlier · ${visible.length} of ${turns.length}</button>` : "";
  list.innerHTML = earlier + visible.map(bubble).join("") + (awaitingReply() ? indicatorBubble() : "");
  const le = list.querySelector("[data-loadearlier]");
  if (le) le.addEventListener("click", () => { shown += CONV_PAGE; renderList(); });
  // wire each work-log <details> to stream its run on first expand
  list.querySelectorAll("details[data-run]").forEach((d) => {
    d.addEventListener("toggle", () => {
      if (!d.open) return;
      const rid = d.dataset.run;
      if (streamed[rid]) return;
      const logEl = d.querySelector(".log"); if (!logEl) return;
      streamed[rid] = O().startRunStream(logEl, agentId, rid) || (() => {});
    });
  });
  if (atBottom) list.scrollTop = list.scrollHeight;
}
// The pending-reply indicator's SHAPE follows presence (S5): a resident actively
// working the human's turn → animated thinking dots; an agent busy on another (task)
// lease → an honest "queued" notice (never fake "thinking…"). idle right after send is
// the optimistic gap before presence resolves → show dots for instant feedback.
function indicatorBubble() {
  const p = presenceOf();
  if (p.k === "busy") return queuedBubble(p);
  if (p.k === "working" || p.k === "waking") return thinkingBubble();
  if (awaiting && p.k === "idle") return thinkingBubble();
  return queuedBubble(p);   // pending turn while the agent looks idle/replied/offline
}
// a transient agent-side "thinking…" indicator shown after the human sends, until the
// agent's reply turn lands (S1 polish — gives immediate feedback that the agent is working).
function thinkingBubble() {
  const a = O().agentById(agentId);
  return `<div class="turn agent">${O().avatar(a ? a.alias : "?", "ai", "sm")}
    <div class="tb"><div class="tmeta">${O().esc(a ? a.alias : "agent")}<span class="tt">thinking…</span></div>
      <div class="conv-thinking"><span></span><span></span><span></span></div></div></div>`;
}
// honest "your message is queued" notice when the agent is busy on another task lease.
// presence_reason is opaque human-readable text from the backend (don't parse) — fall
// back to a generic line when it's absent.
function queuedBubble(p) {
  const a = O().agentById(agentId);
  const name = a ? a.alias : "agent";
  const msg = (p && p.reason) ? p.reason
    : name + " is busy with another task — your message is queued and will be answered when it's free.";
  return `<div class="turn agent">${O().avatar(name, "ai", "sm")}
    <div class="tb"><div class="tmeta">${O().esc(name)}<span class="tt">queued</span></div>
      <div class="conv-queued">${O().icon("clock", "")}<span>${O().esc(msg)}</span></div></div></div>`;
}
// #337: render a turn's attachments (read view), parity with the task thread. Images → inline
// thumbnail (click = lightbox); everything else → a download chip. esc() the name; the url is a
// same-origin /api/conversations/{cid}/attachments path the backend built.
function attRow(a) {
  const url = O().esc(a.url || "");
  const nm = O().esc(a.name || a.id || "file");
  if (a.kind === "image") {
    return `<img class="att-img" src="${url}" alt="${nm}" title="${nm}" loading="lazy" data-lightbox="${url}">`;
  }
  return `<a class="att-file" href="${url}" target="_blank" rel="noopener" download>${FILE_ICON}
    <span>${nm}</span><span class="sz">${fmtSize(a.size)}</span></a>`;
}
function bubble(t) {
  const human = t.role === "human";
  const a = O().agentById(t.author_agent_id);
  const meta = t.meta || {};
  // S2 forward-compat: an agent turn flagged as a permission/ask card (lights up with E4)
  const card = !human && (meta.type === "permission_request" || meta.type === "ask_human");
  const work = (!human && t.run_id) ? `<details data-run="${O().esc(t.run_id)}">
    <summary class="work-sum">${O().icon("play", "")}work log · ${O().esc(t.run_id.slice ? t.run_id.slice(0, 8) : t.run_id)}</summary>
    <div class="log" id="convlog-${O().esc(t.run_id)}"></div></details>` : "";
  const atts = (t.attachments || []).length
    ? `<div class="msg-atts">${t.attachments.map(attRow).join("")}</div>` : "";
  return `<div class="turn ${human ? "human" : "agent"}">
    ${human ? "" : O().avatar(a ? a.alias : "?", "ai", "sm")}
    <div class="tb">
      <div class="tmeta">${O().esc(human ? "you" : (a ? a.alias : "agent"))}<span class="tt">${t.created_at ? O().relTime(t.created_at) : ""}</span></div>
      ${card ? cardHtml(meta) : `<div class="tx md">${O().mdText(t.content || "")}</div>`}
      ${atts}
      ${work}
    </div></div>`;
}
function cardHtml(meta) {
  // PR2/E4 will make these interactive; here we render the affordance forward-compatibly.
  if (meta.type === "permission_request") {
    return `<div class="gcard perm"><div class="gh">${O().icon("shield", "")}Permission requested${meta.tool_name ? " · " + O().esc(meta.tool_name) : ""}</div>
      ${meta.tool_input ? `<pre class="gpre">${O().esc(typeof meta.tool_input === "string" ? meta.tool_input : JSON.stringify(meta.tool_input, null, 2))}</pre>` : ""}
      <div class="gnote">Allow / deny lands with E4.</div></div>`;
  }
  return `<div class="gcard ask"><div class="gh">${O().icon("spark", "")}${O().esc(meta.question || "Needs an answer")}</div>
    <div class="gnote">Reply lands with E4.</div></div>`;
}

function renderPresence() {
  const el = document.getElementById("convPresence"); if (!el) return;
  const p = presenceOf();
  el.className = "presence p-" + p.k;
  el.innerHTML = `<span class="d"></span>${O().esc(p.l)}`;
  applyLock();
}
// S3 §3b vice-versa lock: while the agent holds a `live` lease (a human owns the embodiment
// in a terminal), the conversation is READ-ONLY — typing here would race the live session.
// The daemon drains queued turns on close. Lease comes from the agent read payload (leaseOf);
// absent until Forge ships the field → never locks (graceful).
function applyLock() {
  const lock = document.getElementById("convLock");
  const inp = document.getElementById("convInput");
  const send = document.getElementById("convSend");
  if (!lock) return;
  const a = O().agentById(agentId);
  // locked while a `live` lease is held — our OWN connected pair session, or another
  // embodiment (from the read payload). NOT while the panel is merely connecting/errored,
  // so a bridge-down panel doesn't wrongly freeze the composer.
  const locked = (paired && termConnected) || (a && O().leaseOf(a) === "live");
  lock.hidden = !locked;
  if (locked) { const s = lock.querySelector("span"); if (s) s.textContent = (a ? a.alias : "Agent") + " is in a live terminal — conversation paused."; }
  if (inp) { inp.disabled = !!locked; }
  if (send) { send.disabled = !!locked; }
  const att = document.getElementById("convAttach"); if (att) att.disabled = !!locked;   // #337
}

/* ---------- load + poll ---------- */
// snapshot the live conversation state into the per-agent cache (ISS-68 no-reload-on-switch).
function cacheConv() {
  if (!agentId) return;
  convCache[agentId] = { convId: convId, turns: turns.slice(), lastSeq: lastSeq,
                         presence: presence, presenceReason: presenceReason, at: Date.now() };
}
function load() {
  const tok = mountTok;
  getJSON("/api/agents/" + encodeURIComponent(agentId) + "/conversation?limit=50")
    .then((d) => {
      if (tok !== mountTok) return;        // panel re-mounted on another conversation mid-flight
      convId = d.conversation ? d.conversation.id : null;
      window.__convMeta = d.conversation || null;
      presence = d.presence || null; presenceReason = d.presence_reason || null;   // top-level (Vault)
      turns = d.turns || [];
      lastSeq = turns.length ? turns[turns.length - 1].seq : 0;
      cacheConv();
      renderList(); renderPresence();
    })
    .catch(() => { const l = document.getElementById("convList"); if (l) l.innerHTML = '<div class="none" style="padding:18px">Conversation unavailable.</div>'; });
}
function poll() {
  if (!convId) { renderPresence(); load(); return; }
  refreshPresence();
  const tok = mountTok;
  getJSON("/api/conversations/" + encodeURIComponent(convId) + "/turns?after_seq=" + lastSeq + "&limit=50")
    .then((d) => {
      if (tok !== mountTok) return;        // stale: a different conversation is mounted now
      const fresh = d.turns || [];
      if (!fresh.length) return;
      if (fresh.some((t) => t.role === "agent")) awaiting = false;   // reply landed -> stop "thinking"
      turns = turns.concat(fresh);
      lastSeq = turns[turns.length - 1].seq;
      cacheConv();
      renderList();
    })
    .catch(() => {});
}
// presence + presence_reason ride on GET /api/conversations/{id} (NOT the /turns delta),
// so refresh them on the same tick. If the endpoint/field isn't live yet this no-ops and
// presenceOf falls back to agent.status. A presence change repaints the pending indicator.
function refreshPresence() {
  const tok = mountTok, cid = convId;
  getJSON("/api/conversations/" + encodeURIComponent(cid))
    .then((d) => {
      if (tok !== mountTok) return;        // a stale poll must NOT paint another agent's presence
      const np = d.presence || null, nr = d.presence_reason || null;
      const changed = np !== presence || nr !== presenceReason;
      presence = np; presenceReason = nr;
      renderPresence();
      if (changed) renderList();
    })
    .catch(() => { if (tok === mountTok) renderPresence(); });   // not live yet -> keep status-derived
}
