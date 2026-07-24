/* Orcha shared portal module: time helpers, live snapshot accessors, and acting-human state. */
const shortId = (s) => (s ? String(s).slice(0, 8) : "—");
// S3 §3b: an agent's single-embodiment lease ∈ idle | ephemeral | resident | live.
// Forge's #141 exposes it on the agent read payload as `embodiment` (CASE active-lease →
// lease_kind ELSE 'idle'); the data adapter passes it through. Read that (plus lease_kind/
// lease as belt-and-suspenders) and default to "idle" when absent/unknown, so the terminal
// stays openable + the conversation stays unlocked until the backend ships it (graceful).
// Drives the lock/guard UX.
const LEASES = ["idle", "ephemeral", "resident", "live"];
const leaseOf = (agent) => {
  const v = agent && (agent.embodiment || agent.lease_kind || agent.lease);
  return v && LEASES.indexOf(v) >= 0 ? v : "idle";
};

function relTime(iso) {
  if (!iso) return "—";
  const diff = (Date.now() - new Date(iso).getTime()) / 1000;
  if (diff < 5) return "just now";
  if (diff < 60) return Math.floor(diff) + "s ago";
  if (diff < 3600) return Math.floor(diff / 60) + "m ago";
  if (diff < 86400) return Math.floor(diff / 3600) + "h ago";
  return Math.floor(diff / 86400) + "d ago";
}
function clockTime(iso) {
  if (!iso) return "—";
  return new Date(iso).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}
// ISS-83 recency band: an item whose most-recent activity (created OR updated) is within
// RECENCY_WINDOW_MS floats ABOVE staler items regardless of priority, so fresh work surfaces.
// recencyTs() takes any number of ISO strings (created_at/started_at/last-post/responded_at…)
// and returns the newest in ms (0 if none parse). recencyBand() returns 0 (recent) | 1 (older)
// — use it as a sort key slotted between status and priority so existing tie-breaks still apply.
const RECENCY_WINDOW_MS = 12 * 60 * 60 * 1000;   // ~12h
function recencyTs() {
  let max = 0;
  for (let i = 0; i < arguments.length; i++) { const t = Date.parse(arguments[i] || ""); if (t > max) max = t; }
  return max;
}
function recencyBand() {
  const ts = recencyTs.apply(null, arguments);
  return ts && (Date.now() - ts) <= RECENCY_WINDOW_MS ? 0 : 1;
}

/* ---- real-snapshot accessors (read fresh — keep live across refresh) -- */
function agents() { return D.agents || []; }
function tasks() { return D.tasks || []; }
function requests() { return D.requests || []; }
function agentByAlias(alias) { return agents().find((a) => a.alias === alias) || null; }
function agentById(id) { return id == null ? null : agents().find((a) => String(a.id) === String(id)) || null; }
function aliasFor(id) { const a = agentById(id); return a ? a.alias : null; }
function taskById(id) { return tasks().find((t) => String(t.id) === String(id)) || null; }
function humans() { return agents().filter((a) => a.kind === "human"); }
// a request is "to the human" if its target resolves to a human agent, or it has
// no explicit target (the API routes those to the picked human). Robust to both the
// raw snapshot (target_id) and the D1 component shape (`to` = alias or "human").
// (D1 review: the mapped shape dropped target_id, so the id branch wrongly treated
// every open request as human-targeted; D1 now preserves target_id and we also handle
// the alias case — note a request sent to the human resolves `to` to the human's
// ALIAS, not the literal "human", so a plain `to === "human"` check is insufficient.)
function isToHuman(r) {
  if (r.target_id !== undefined) {            // raw or D1-preserved id (authoritative)
    if (!r.target_id) return true;            // null target -> the picked human
    const t = agentById(r.target_id);
    return !!t && t.kind === "human";
  }
  if (r.to === "human") return true;          // component-only: explicit "human"
  const a = agentByAlias(r.to);
  return !!(a && a.kind === "human");         // ...or an alias that is a human
}

/* ---- acting-as: the real human authority, persisted (NOT hardcoded) --- */
function actingKey() { const c = D.container && D.container.id; return "orcha:actingHuman:" + (c || "_"); }
function actingHuman() {
  const hs = humans();
  if (!hs.length) return null;
  let saved = null; try { saved = localStorage.getItem(actingKey()); } catch (e) {}
  if (saved) { const m = hs.find((h) => String(h.id) === String(saved)); if (m) return m; }
  return hs[0]; // sole/first human is the common case (1 human per container)
}
function setActingHuman(id) { try { localStorage.setItem(actingKey(), String(id)); } catch (e) {} }
