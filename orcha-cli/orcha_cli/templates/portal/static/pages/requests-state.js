/* Requests page controller: request filtering, chain traversal, and list rendering. */
const ReqO = window.Orcha;
const Req$ = (id) => document.getElementById(id);
const ReqD = () => window.ORCHA;

const _dlReq = new URLSearchParams(location.search).get("req");
let sel = _dlReq || null;
// ISS-38: a deeplink (?req=) / explicit select must scroll the list to the picked row,
// else (303+ requests) you land on the detail with the selection invisibly off-screen.
// One-shot — cleared after the next list paint so the 3s poll never yanks scroll.
let pendingScroll = !!_dlReq;
let filter = "all";
let answering = false;   // inline answer box open (ISS-53: its repaint is deferred while typing)
// ISS-68 PR-3: render-cap the (priority-ordered) list to the top-N + "Load more"; a client-side
// reveal over the unbounded snapshot (deeplinked detail still resolves). Resets on filter switch.
let reqsShown = 15;
const REQS_PAGE = 15;

const FILTERS = [
  { k: "all", label: "All" }, { k: "open", label: "Open" }, { k: "answered", label: "Answered" },
  { k: "escalated", label: "Escalations" }, { k: "task", label: "Task reqs" },
];
function reqs() { return ReqD().requests || []; }
function matches(r) {
  if (filter === "all") return true;
  if (filter === "escalated") return r.to === "human" || isToHuman(r);
  if (filter === "task") return r.type === "task";
  if (filter === "answered") return r.status === "answered";
  if (filter === "open") return r.status === "open";
  return true;
}
// Use the SHARED detector: it resolves target_id -> kind==="human" (any human, not just
// the first by creation order) + handles a null/picked-human target (review P2).
function isToHuman(r) { return ReqO.isToHuman(r); }
const childrenOf = (id) => reqs().filter((r) => r.in_service_of === id);
function partyLabel(name) { return name === "human" ? "you" : name; }
function firstSel() { const rs = reqs(); return (rs.find((r) => r.status === "open") || rs[0] || {}).id || null; }

// ISS-83: requests carry no frontend sort — they arrive in backend order (status open→answered→
// other, then priority, then created_at DESC). Re-sort here to inject a recency band: a request
// created OR answered within ~12h floats to the top of its status group regardless of priority,
// then falls back to the same priority/newest-first order. Slotted BELOW status to keep open-first.
const REQ_STATUS_RANK = { open: 0, answered: 1 };   // mirror backend ORDER BY (else -> 2)
function reqRank(r) { return REQ_STATUS_RANK[r.status] ?? 2; }
// ISS-331: status rank (open→answered→other) stays the OUTER key; the shared sort control picks
// the within-status key (time|priority) + direction, superseding the ISS-83 recency-band float.
const SORT_NAME = "requests";
function reqAcc() { return { bucket: reqRank, time: (r) => Date.parse(r.created_at || "") || 0, prio: (r) => r.priority }; }
function reqSorted(list) {
  return list.slice().sort(ReqO.sortComparator(SORT_NAME, reqAcc()));
}

/* ---------- list ---------- */
function renderList() {
  const open = reqs().filter((r) => r.status === "open").length;
  let html = `<div class="rh">${ReqO.icon("requests", "")}Requests · ${open} open<span class="grow" style="flex:1"></span>${ReqO.sortControlHtml(SORT_NAME)}</div>
    <div class="filters">${FILTERS.map((f) => `<button class="${f.k === filter ? "on" : ""}" data-f="${f.k}">${f.label}</button>`).join("")}</div>`;
  const list = reqSorted(reqs().filter(matches));
  const head = list.slice(0, reqsShown);
  // ISS-38: the render cap is a UI window, not a filter — a deeplinked (?req=) / selected
  // request beyond the window must still appear so it's reachable AND scroll-anchorable in the
  // list (else you'd have to "Load more" your way to item #250). Append it past the window.
  const shown = (sel && list.some((r) => r.id === sel) && !head.some((r) => r.id === sel))
    ? head.concat(list.find((r) => r.id === sel)) : head;
  html += shown.length ? shown.map((r) => {
    const escd = isToHuman(r) && r.status === "open";
    const fa = ReqO.agentByAlias(r.from), ta = ReqO.agentByAlias(r.to);
    return `<button class="qrow ${r.id === sel ? "sel" : ""}" data-id="${ReqO.esc(r.id)}">
      <span class="flow">${ReqO.avatar(r.from, fa ? fa.kind : "ai", "sm")}<span>${ReqO.esc(r.from)}</span>
        <span class="faint">${ReqO.icon("arrow", "")}</span>
        ${ReqO.avatar(r.to, r.to === "human" ? "human" : (ta ? ta.kind : "ai"), "sm")}<span>${ReqO.esc(partyLabel(r.to))}</span></span>
      <span class="pv">${ReqO.esc(ReqO.trunc(r.payload, 84))}</span>
      <span class="bot">${ReqO.pill(escd ? "escalated" : r.status)}<span class="tag">${ReqO.esc(r.type)}</span>
        ${r.chain_depth ? '<span class="tag" style="color:var(--info)">↳ chain</span>' : ""}
        <span class="prio ${r.priority<=20?'p-hi':r.priority<=40?'p-md':''}" style="margin-left:auto">P${ReqO.esc(r.priority)}</span></span>
    </button>`;
  }).join("") : '<div class="none" style="margin:6px">No requests match this filter.</div>';
  if (list.length > head.length) {   // count the window (head), not the appended deeplink row
    html += `<button class="btn subtle" style="width:calc(100% - 12px);margin:8px 6px 4px" data-loadmore>Load more · ${head.length} of ${list.length}</button>`;
  }
  ReqO.patch(Req$("rlist"), html);
  if (pendingScroll) {   // ISS-38: anchor the deeplinked/selected row (one-shot)
    pendingScroll = false;
    const row = Req$("rlist").querySelector(".qrow.sel");
    if (row && row.scrollIntoView) row.scrollIntoView({ block: "nearest" });
  }
}

/* ---------- request chain ---------- */
function chainView(r) {
  const seq = [];
  let cur = r;
  while (cur && cur.in_service_of) { const p = reqs().find((x) => x.id === cur.in_service_of); if (!p) break; seq.unshift(p); cur = p; }
  seq.push(r);
  childrenOf(r.id).forEach((c) => seq.push(c));
  if (seq.length < 2) return "";
  let html = `<div class="field" style="margin-bottom:18px"><div class="lbl">${ReqO.icon("link", "")}Request chain · in service of</div><div class="chain">`;
  seq.forEach((x, i) => {
    html += `<button class="clink ${x.id === r.id ? "cur" : ""}" data-id="${ReqO.esc(x.id)}">
      ${ReqO.pill(isToHuman(x) && x.status === "open" ? "escalated" : x.status)}
      <span class="cf"><span class="ttl">${ReqO.esc(x.from)} → ${ReqO.esc(partyLabel(x.to))}</span>
        <span class="sub">${ReqO.esc(ReqO.trunc(x.payload, 70))}</span></span>
      ${x.chain_depth ? `<span class="tag" style="color:var(--info)">depth ${ReqO.esc(x.chain_depth)}</span>` : '<span class="tag">root</span>'}</button>`;
    if (i < seq.length - 1) html += '<div class="rail"></div>';
  });
  return html + "</div></div>";
}

/* ---------- actions: conditional on the acting human's ROLE (real endpoint gating) ---------- */
function actionsFor(r) {
  if (r.status === "closed" || r.status === "converted_to_task") {
    const tl = r.task_link && r.task_link.task_id;
    return `<div class="none" style="text-align:left;padding:14px">This request is ${ReqO.esc(r.status.replace(/_/g, " "))}.
      ${tl ? "Spawned " + ReqO.taskLink(tl) : "No further action."}</div>`;
  }
  const h = ReqO.actingHuman();
  if (!h) return `<div class="none" style="text-align:left;padding:14px">Pick an acting human (top-right) to arbitrate this request.</div>`;
  const isTarget = String(r.target_id) === String(h.id) || (r.to === "human");
  const isRequester = String(r.requester_id) === String(h.id);
  const btns = [];
  if (isTarget && r.status === "open") btns.push(`<button class="btn approve" data-act="answer">${ReqO.icon("check", "")}Answer</button>`);
  if (isRequester && r.status === "answered") btns.push(`<button class="btn subtle" data-act="convert">${ReqO.icon("convert", "")}Convert to task</button>`);
  if (isRequester && (r.status === "open" || r.status === "answered")) btns.push(`<button class="btn subtle" data-act="escalate">${ReqO.icon("flag", "")}Escalate to human</button>`);
  // #60: a standalone nudge — wakes whoever owns the next action (open → the target who
  // still owes an answer; answered → the requester who must act on it). Never changes state.
  if (r.status === "open" || r.status === "answered") btns.push(`<button class="btn subtle" data-act="nudge">${ReqO.icon("bell", "")}Nudge</button>`);
  btns.push(`<button class="btn ghost" data-act="close">Close</button>`);
  let html = `<div class="wrap-g" id="reqacts" data-req="${ReqO.esc(r.id)}">${btns.join("")}</div>
    <div class="acting-note" style="margin-top:10px;color:var(--muted);font-size:11.5px">${ReqO.avatar(h.alias, "human", "sm")}&nbsp;Arbitrating as ${ReqO.esc(h.alias)} — answer (if it's yours), convert, escalate, or close. Every action is logged.</div>`;
  if (answering && isTarget && r.status === "open") {
    html += `<div style="margin-top:14px">
      <textarea id="ansIn" class="ans-in" placeholder="Type your answer — ${ReqO.esc(r.from)} sees it verbatim on the next wake."></textarea>
      <div style="display:flex;gap:9px;margin-top:10px">
        <button class="btn approve" data-act="send-answer">${ReqO.icon("check", "")}Send answer</button>
        <button class="btn subtle" data-act="cancel-answer">Cancel</button>
      </div></div>`;
  }
  return html;
}

/* ---------- detail ---------- */
