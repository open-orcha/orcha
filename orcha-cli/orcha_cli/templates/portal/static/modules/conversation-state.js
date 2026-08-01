/* Conversation panel module: cache, presence derivation, API shims, and static panel skeleton. */
const O = () => window.Orcha;
let host = null, agentId = null, convId = null;
let turns = [], lastSeq = 0, pollTimer = null;
// ISS-68 PR-3: show the most-recent N turns first; "Load earlier" reveals older ones from the
// already-fetched set (a client-side reveal — /conversations/{id}/turns has no before-cursor, so
// we can't page older from the server without a backend change). Reset to 10 on each mount.
let shown = 10;
const CONV_PAGE = 20;
const streamed = {};        // run_id -> stop fn (work-log streams started on expand)
// ISS-68: per-agent conversation cache so switching agent tabs and back does NOT reload the
// thread from scratch (visible flicker + lost scroll). On return we paint cached turns instantly
// and only DELTA-refresh in the background (after_seq); a full reload happens only when there's
// no cache or it's older than the TTL. Keyed by agent id (one panel mounted at a time).
const convCache = {};
const CONV_CACHE_TTL_MS = 60000;
let slashOpen = false, slashItems = [], slashIdx = 0;
let awaiting = false;        // optimistic: true from "human turn sent" until the reply lands
// Send-UX state (dup-send fix): ONE turn per user action. `sending` gates the single send
// path (click + Enter + key-repeat all funnel into it); `pendingLocal` is the optimistic
// bubble — {content, atts, keepStaged, authorId, at, status:'sending'|'failed', err} —
// which lives until the SERVER's copy of the turn owns the thread (POST response or poll).
let sending = false;
let pendingLocal = null;
// Round-2 fix (blocker #1): a `failed` pendingLocal must never be silently overwritten by the
// next send — if the user types something new while a failed bubble+Retry is still showing,
// send() moves it here instead of letting submitTurn() clobber it. Each entry is a full
// pendingLocal-shaped object (content/atts/keepStaged/authorId/at/status:'failed'/err); rendered
// as its own bubble+Retry above the live pendingLocal so the failed copy is never lost.
let failedSends = [];
let pollBusy = false;        // a slow/restarting portal must not stack same-cursor /turns fetches
// how long a polled human turn with identical author+content still reconciles the
// optimistic bubble (covers "POST landed but its response was lost" during a restart).
// Round-2 fix (blocker #2): this window only ever gates an already-FAILED bubble now — while
// pendingLocal.status === 'sending' the POST is still in flight, so any human turn arriving
// after our cursor with matching author+content is necessarily ours, no matter how old.
const PENDING_MATCH_MS = 20000;
let presence = null, presenceReason = null;   // Vault presence contract (req 6de81ae3), null until live
let mountTok = 0;            // bumped on every (re)mount/teardown; stale in-flight responses no-op
let paired = false;          // S3: a terminal panel is docked here
let termConnected = false;   // S3: the docked terminal actually reached a live session
let maxed = null;            // ISS-65: which panel is maximized — "conv" | "term" | null

// ISS-69(a): name the lease HOLDER in human terms instead of leaking the wire `lease_kind`.
// The holder kind reaches us on the 4409 lease_denied frame (holder=lease_kind) and on the
// agent read payload's `embodiment`. resident = a warm conversation; live = a human terminal;
// ephemeral = a background task. Used by both the busy copy and the preempt confirm modal.
const HOLDER_DOING = { resident: "in a live conversation", live: "in a live terminal", ephemeral: "running a task" };
function holderDoing(kind) { return HOLDER_DOING[kind] || "in another live session"; }

// the /-palette mirrors the CLI work skills (presentational; sends as turn content)
const SKILLS = [
  "/orcha-status", "/orcha-next", "/orcha-task-new", "/orcha-post", "/orcha-done",
  "/orcha-ask", "/orcha-inbox", "/orcha-outbox", "/orcha-respond", "/orcha-close",
  "/orcha-escalate", "/orcha-convert", "/orcha-accept-task", "/orcha-reject-task",
];

/* ---------- #337: conversation file attachments (parity with #330 task-thread) ----------
   Mirror of the task-thread composer (tasks.html #301/#330): files stage + upload immediately
   on pick/drop/paste to the conversation-scoped store, then the stored ids ride on the turn POST
   body. The one conversation-specific wrinkle: a conversation is get-or-create, so an upload
   ensures the conversation exists FIRST (the upload route is conv-scoped). Reset per mount. */
const ACCEPT_EXT = ["png", "jpg", "jpeg", "gif", "webp", "pdf", "txt", "md", "csv", "log", "json"];
const IMG_EXT = ["png", "jpg", "jpeg", "gif", "webp"];
const extOf = (n) => (String(n || "").split(".").pop() || "").toLowerCase();
const CLIP_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg>';
const FILE_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/></svg>';
function fmtSize(n) {
  n = +n || 0;
  if (n < 1024) return n + " B";
  if (n < 1024 * 1024) return (n / 1024).toFixed(n < 10240 ? 1 : 0) + " KB";
  return (n / (1024 * 1024)).toFixed(1) + " MB";
}
let staged = [];          // [{key, name, size, kind, status:'uploading'|'done'|'failed', ref?}]
let stagedSeq = 0;

/* ---------- presence (S5): Vault contract, fall back to agent.status ---------- */
// The conversation read payload carries a backend-derived `presence`
// (idle|waking|working|busy|replied|stopped) + opaque `presence_reason` (req 6de81ae3).
// It draws the distinction agent.status CAN'T: "working on MY turn" (→ thinking dots)
// vs "busy on a task lease, your message is QUEUED" (→ busy pill + queued notice).
// Until that field is live we degrade gracefully to deriving from agent.status.
const PRES_LABEL = { idle: "idle", waking: "waking", working: "working", busy: "busy", replied: "replied", stopped: "offline" };
function presenceOf() {
  if (presence != null) {                       // backend is talking — trust it
    const known = Object.prototype.hasOwnProperty.call(PRES_LABEL, presence);
    const l = known ? PRES_LABEL[presence] : "idle";   // forward-compat: unknown -> idle
    const k = (known && presence === "stopped") ? "offline" : (known ? presence : "idle");
    return { k, l, reason: presenceReason || null };
  }
  const a = O().agentById(agentId) || {};
  const cs = (window.__convMeta && window.__convMeta.status) || null;
  if (cs === "ended") return { k: "offline", l: "offline" };
  switch (a.status) {
    case "working": case "in_progress": return { k: "working", l: "working" };
    case "awaiting_human": case "awaiting_request": return { k: "waking", l: "waiting" };
    case "needs_verification": return { k: "replied", l: "replied" };
    case "terminated": return { k: "offline", l: "offline" };
    default: return { k: "idle", l: "idle" };
  }
}
// A reply is pending when the human's latest turn has no agent turn after it. Deriving
// this from the DURABLE turns (req 1ccab87e) makes the indicator survive an agent-switch
// + reload — the optimistic `awaiting` flag only covers the gap before the first poll.
function awaitingReply() {
  if (awaiting) return true;
  const last = turns[turns.length - 1];
  return !!(last && last.role === "human");
}

/* ---------- API ---------- */
function getJSON(url) { return fetch(url).then((r) => r.ok ? r.json() : Promise.reject(r.status)); }
function postJSON(url, body) {
  return fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
}

/* ---------- skeleton (rendered ONCE; composer never repaints) ---------- */
function skeleton(a) {
  return `<div class="conv-wrap" id="convPairWrap">
    <div class="conv">
      <div class="conv-h">
        <div class="conv-who">${O().avatar(a.alias, "ai", "")}<div><div class="cn">${O().esc(a.alias)}</div>
          <div class="cr">${O().esc(a.role || "")}</div></div></div>
        <span class="presence" id="convPresence"></span>
        <button class="btn sm ghost" id="convPair" title="Pair in a live terminal as ${O().esc(a.alias)}">${O().icon("play", "")}<span>Pair in terminal</span></button>
        <button class="btn sm ghost conv-max" id="convMax" title="Maximize conversation" aria-label="Maximize conversation">${O().icon("maximize", "")}</button>
      </div>
      <div class="conv-list" id="convList"><div class="none" style="padding:18px">Loading conversation…</div></div>
      <div class="conv-lock" id="convLock" hidden>${O().icon("shield", "")}<span></span></div>
      <div class="conv-composer">
        <div class="slash" id="convSlash" hidden></div>
        <button type="button" class="conv-attach" id="convAttach" title="Attach files (or drag-drop / paste)" aria-label="Attach files">${CLIP_ICON}</button>
        <input id="convAttachInput" type="file" multiple accept=".png,.jpg,.jpeg,.gif,.webp,.pdf,.txt,.md,.csv,.log,.json" style="display:none">
        <textarea id="convInput" class="conv-in" rows="1" placeholder="Message ${O().esc(a.alias)} — type / for skills…"></textarea>
        <button class="btn approve" id="convSend">${O().icon("arrow", "")}Send</button>
      </div>
      <div class="conv-tray" id="convTray"></div>
      <div class="conv-note">Turn-based: ${O().esc(a.alias)} wakes, works, and replies. Live token streaming + Stop + permission cards arrive with E4.</div>
    </div>
    <div class="term-slot" id="convTermSlot"></div>
  </div>`;
}
