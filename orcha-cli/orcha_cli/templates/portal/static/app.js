/* ============================================================================
   Orcha portal — shared shell, helpers, status system, live-feed engine.
   Vanilla. No build step. Each page calls Orcha.mountShell(...) then renders
   its own content from window.ORCHA (the FastAPI container snapshot).

   D0 (design-system foundation): consumes the REAL backend snapshot, not mock
   data. Three adaptations:
     1. window.ORCHA is a live object MUTATED IN PLACE — pages call
        Orcha.applySnapshot(fresh) each 3s refresh, so the captured `D` reference
        stays valid and helpers read current data.
     2. helpers read the real shape fresh on every call (agentByAlias over the
        agents list; requests via requester_id/target_id) — no stale derived cache.
     3. "acting as" is DATA-DRIVEN: the real kind='human' agent (persisted pick),
        never a hardcoded name.
   ========================================================================== */
window.Orcha = (function () {
  // Ensure a live object exists BEFORE we capture D, so pages can mutate it in
  // place (Object.assign) without invalidating this reference.
  window.ORCHA = window.ORCHA || { container: null, agents: [], tasks: [], requests: [] };
  const D = window.ORCHA;

  // In-place snapshot update: keep the SAME object so `D` (and every captured
  // reference in the pages) stays valid across the 3s poll. Returns D.
  function applySnapshot(fresh) {
    if (!fresh || typeof fresh !== "object") return D;
    // replace known collections wholesale; copy scalars/other keys too
    Object.keys(fresh).forEach((k) => { D[k] = fresh[k]; });
    // SPEC-1: reconcile the topbar autonomy switch with the fresh snapshot (the topbar is
    // built once by mountShell; the 5s poll updates D.container but not the topbar markup).
    try { paintAutonomy(); } catch (e) {}
    // #103: keep the notifier-health chip fresh on every poll so a daemon that dies mid-session
    // ages into stale/offline in the topbar without a page reload.
    try { paintNotifierHealth(); } catch (e) {}
    // SPEC-3: keep the notification badge (NEEDS-YOU count) fresh, and repaint the open
    // panel's live action-queue zone, on every poll/event-stream refresh.
    try { paintNotifications(); } catch (e) {}
    return D;
  }

  /* ---- theme ----------------------------------------------------------- */
  function applyTheme(t) {
    document.documentElement.setAttribute("data-theme", t);
    try { localStorage.setItem("orcha:theme", t); } catch (e) {}
  }
  function currentTheme() {
    try { return localStorage.getItem("orcha:theme") || "auto"; } catch (e) { return "auto"; }
  }
  // What the page ACTUALLY renders right now. "auto" has no palette of its own — the
  // default vars are dark, and [data-theme="auto"] only flips to light under
  // @media (prefers-color-scheme: light) (styles.css). So on a dark-preference OS
  // "auto" is visually identical to "dark". cycleTheme advances from this RESOLVED
  // value so a single click always produces a visible change — the old 3-state
  // auto→dark→light cycle made the first auto→dark step invisible on a dark OS, which
  // is the "requires double-click" bug (GH #239). "auto" remains the pre-click default
  // (set at load, L873); once the user clicks they get an explicit dark/light toggle.
  function resolvedTheme() {
    const t = currentTheme();
    if (t === "dark" || t === "light") return t;
    try {
      return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
    } catch (e) { return "dark"; }
  }
  function cycleTheme() {
    const next = resolvedTheme() === "dark" ? "light" : "dark";
    applyTheme(next);
    toast("Theme · " + next, "ok");
    syncThemeLabel();
    const tb = document.getElementById("themeBtn");
    if (tb) tb.setAttribute("title", "Theme: " + next + " — click to cycle");
  }
  function syncThemeLabel() {
    const el = document.getElementById("themeLabel");
    if (el) el.textContent = currentTheme();
  }

  /* ---- tiny utils ------------------------------------------------------ */
  const esc = (s) => (s == null ? "" : String(s)).replace(/[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const trunc = (s, n) => { s = s || ""; return s.length > n ? s.slice(0, n - 1) + "…" : s; };
  // ISS-82 (GH #223): agents cite tasks in free text by raw id — usually the 8-char SHORT
  // prefix (e.g. `e4b77f3f`), sometimes the full UUID. Resolve such a token to the live task.
  // Exact full-id wins; else a UNIQUE 8+ hex prefix. Ambiguous or absent → null (never guess),
  // so request ids / message ids / commit shas simply don't resolve and are left untouched.
  function taskByRef(token) {
    if (!token) return null;
    const tok = String(token).toLowerCase();
    const ts = tasks();
    const exact = ts.find((t) => String(t.id).toLowerCase() === tok);
    if (exact) return exact;
    if (tok.length >= 8 && tok.length < 36) {
      let hit = null, n = 0;
      for (const t of ts) { if (String(t.id).toLowerCase().startsWith(tok)) { hit = t; if (++n > 1) return null; } }
      if (n === 1) return hit;
    }
    return null;
  }
  // ISS-82: rewrite bare task-id tokens in ALREADY-ESCAPED/rendered HTML into linkified
  // [task name] chips. Tag-aware (never edits the contents of a < > tag) AND anchor-aware
  // (never rewrites the visible text of an existing <a>, so a task-id that happens to sit
  // inside a URL stays intact). Only tokens that resolve to a real task are touched; every
  // other id passes through verbatim. Callers run esc()/mdText first, so the input is trusted.
  const TASK_REF_RE = /\b[0-9a-f]{8}(?:-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})?\b/gi;
  function taskRefs(html) {
    if (html == null) return "";
    let inAnchor = false;
    return String(html).split(/(<[^>]*>)/).map((seg) => {
      if (seg.charAt(0) === "<") {                 // a real tag (text has its < escaped to &lt;)
        const lt = seg.toLowerCase();
        if (lt.indexOf("<a") === 0) inAnchor = true;
        else if (lt.indexOf("</a") === 0) inAnchor = false;
        return seg;
      }
      if (inAnchor) return seg;                     // visible text inside an existing link — leave it
      return seg.replace(TASK_REF_RE, (tok) => {
        const t = taskByRef(tok);
        if (!t) return tok;
        return `<a class="tref" href="/tasks?task=${encodeURIComponent(t.id)}" title="task ${esc(tok)}">[${esc(t.title)}]</a>`;
      });
    }).join("");
  }
  // ISS-44: make URLs in authored text clickable. SAFETY: esc() FIRST (so the text can never
  // inject HTML), THEN linkify the escaped string — only http(s):// URLs, emitting an anchor
  // with target=_blank + rel=noopener noreferrer. Returns trusted HTML (already escaped).
  // Trailing sentence punctuation / a closing bracket is left OUTSIDE the link, never swallowed.
  // ISS-82: after URL-linkify, run taskRefs so bare task-id mentions become [task name] chips
  // too (anchor-aware, so a task-id inside a linked URL is left alone).
  const linkify = (s) => taskRefs(esc(s == null ? "" : String(s)).replace(/https?:\/\/[^\s<]+/g, (m) => {
    let tail = "";
    const t = m.match(/[)\].,;:!?]+$/);   // (text is escaped, so quotes/apostrophes are entities)
    if (t) { tail = m.slice(m.length - t[0].length); m = m.slice(0, m.length - t[0].length); }
    return `<a class="lnk" href="${m}" target="_blank" rel="noopener noreferrer">${m}</a>${tail}`;
  }));
  // Render a SAFE inline-markdown subset for chat messages (agents emit lots of **bold**,
  // `code`, fenced ```blocks```, lists). SECURITY: esc() FIRST so the text can never inject
  // HTML, THEN format the escaped string. Code spans/fences are stashed before emphasis so
  // their literal *_` survive; a NUL sentinel (impossible in input) marks the stash slots.
  // Newlines are preserved by .tx { white-space: pre-wrap }.
  const mdText = (src) => {
    let s = esc(src == null ? "" : String(src));
    const stash = [];
    const Z = String.fromCharCode(0);   // NUL sentinel — impossible in esc()'d input, so it never collides with real text
    const keep = (html) => { stash.push(html); return Z + (stash.length - 1) + Z; };
    // fenced code block  ```lang\n…```
    s = s.replace(/```[^\n`]*\n?([\s\S]*?)```/g, (m, code) => keep(`<pre class="md-pre"><code>${code.replace(/\n+$/, "")}</code></pre>`));
    // inline code  `…`
    s = s.replace(/`([^`\n]+)`/g, (m, code) => keep(`<code class="md-code">${code}</code>`));
    // GFM tables: a header row, a |---|:--:| delimiter row, then data rows. Rendered in place
    // (one line, no inner newlines) BEFORE the inline passes so cell text still gets bold/links;
    // runs after code stashing, so a `pipe|in|code` cell can't be mistaken for columns.
    {
      const splitRow = (line) => line.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
      const isDelim = (line) => line != null && /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)+\|?\s*$/.test(line);
      const cell = (c, tag, al) => `<${tag}${al ? ` style="text-align:${al}"` : ""}>${c}</${tag}>`;
      const lines = s.split("\n"), out = [];
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].indexOf("|") >= 0 && isDelim(lines[i + 1])) {
          const head = splitRow(lines[i]);
          const aligns = splitRow(lines[i + 1]).map((c) => {
            const L = c.startsWith(":"), R = c.endsWith(":");
            return L && R ? "center" : R ? "right" : L ? "left" : "";
          });
          const rows = []; let j = i + 2;
          for (; j < lines.length && lines[j].indexOf("|") >= 0 && lines[j].trim() !== ""; j++) rows.push(splitRow(lines[j]));
          const thead = "<tr>" + head.map((c, k) => cell(c, "th", aligns[k])).join("") + "</tr>";
          const tbody = rows.map((r) => "<tr>" + head.map((_, k) => cell(r[k] == null ? "" : r[k], "td", aligns[k])).join("") + "</tr>").join("");
          out.push(`<table class="md-table"><thead>${thead}</thead><tbody>${tbody}</tbody></table>`);
          i = j - 1;
        } else { out.push(lines[i]); }
      }
      s = out.join("\n");
    }
    // links (http/https) — same trailing-punctuation handling as linkify
    s = s.replace(/https?:\/\/[^\s<]+/g, (m) => {
      let tail = ""; const t = m.match(/[)\].,;:!?]+$/);
      if (t) { tail = m.slice(m.length - t[0].length); m = m.slice(0, m.length - t[0].length); }
      return keep(`<a class="lnk" href="${m}" target="_blank" rel="noopener noreferrer">${m}</a>`) + tail;
    });
    // bold (before italic, so ** isn't eaten by the single-* rule)
    s = s.replace(/\*\*(?!\s)([^\n]+?)\*\*/g, "<strong>$1</strong>");
    s = s.replace(/__(?!\s)([^\n_]+?)__/g, "<strong>$1</strong>");
    // italic — non-space inner edges + word-boundary for _ so snake_case is left alone
    s = s.replace(/(^|[^*])\*(?!\s)([^*\n]+?)\*(?!\*)/g, "$1<em>$2</em>");
    s = s.replace(/(^|[^_\w])_(?!\s)([^_\n]+?)_(?![\w_])/g, "$1<em>$2</em>");
    // headings (#/##/###) and bullet lines (- / *) -> their own styled lines
    s = s.replace(/^\s{0,3}#{1,3}\s+(.+)$/gm, '<span class="md-h">$1</span>');
    s = s.replace(/^\s*[-*]\s+(.+)$/gm, '<span class="md-li">$1</span>');
    // ISS-82: linkify bare task-id refs last — code spans/fences and URLs are already stashed,
    // so they're protected; emphasis/heading tags are skipped by taskRefs' tag-aware split.
    s = taskRefs(s);
    return s.replace(new RegExp(Z + "(\\d+)" + Z, "g"), (m, i) => stash[+i]);
  };
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

  /* ---- deterministic avatar gradient ----------------------------------- */
  function hue(s) { let h = 0; for (const c of (s || "")) h = (h * 31 + c.charCodeAt(0)) % 360; return h; }
  function avatar(alias, kind, size) {
    const h = hue(alias);
    const grad = `linear-gradient(140deg, hsl(${h} 70% 62%), hsl(${(h + 38) % 360} 72% 54%))`;
    const cls = "av" + (size ? " " + size : "") + (kind === "human" ? " human" : "");
    const init = (alias || "?").trim().charAt(0).toUpperCase();
    return `<span class="${cls}" style="background:${grad}">${esc(init)}</span>`;
  }

  /* ---- icons ----------------------------------------------------------- */
  const I = {
    home: '<path d="M3 9.5 10 4l7 5.5V17a1 1 0 0 1-1 1h-3v-5H7v5H4a1 1 0 0 1-1-1z"/>',
    agents: '<circle cx="7" cy="7.5" r="2.6"/><circle cx="13.5" cy="8" r="2.1"/><path d="M2.6 16c.4-2.4 2.2-3.8 4.4-3.8s4 1.4 4.4 3.8M12 12.5c2 .1 3.4 1.4 3.8 3.5"/>',
    tasks: '<rect x="3.2" y="3.2" width="13.6" height="13.6" rx="3"/><path d="M6.6 10l2.2 2.2 4.6-4.8"/>',
    requests: '<path d="M5 7h9l-2.4-2.4M15 13H6l2.4 2.4"/>',
    live: '<path d="M2.5 10h3l2-5 3 10 2-7 1.5 2h3.5"/>',
    search: '<circle cx="8.5" cy="8.5" r="5"/><path d="m13 13 3.5 3.5"/>',
    bell: '<path d="M6 9a4 4 0 0 1 8 0c0 3 1.2 4 1.8 4.6.3.3.1.9-.4.9H4.6c-.5 0-.7-.6-.4-.9C4.8 13 6 12 6 9z"/><path d="M8.4 17a1.8 1.8 0 0 0 3.2 0"/>',
    sun: '<circle cx="10" cy="10" r="3.6"/><path d="M10 2.4v2M10 15.6v2M2.4 10h2M15.6 10h2M4.6 4.6l1.4 1.4M14 14l1.4 1.4M15.4 4.6 14 6M6 14l-1.4 1.4"/>',
    moon: '<path d="M15.5 11.5A6 6 0 0 1 8.5 4.5a6 6 0 1 0 7 7z"/>',
    chev: '<path d="M5 7.5 10 12l5-4.5"/>',
    copy: '<rect x="6.5" y="6.5" width="9" height="9" rx="2"/><path d="M4.5 12.5h-1a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1h7a1 1 0 0 1 1 1v1"/>',
    check: '<path d="M4 10.5 8 14l8-8.5"/>',
    x: '<path d="M5 5l10 10M15 5 5 15"/>',
    arrow: '<path d="M4 10h11M11 6l4 4-4 4"/>',
    ext: '<path d="M8 5H5.5A1.5 1.5 0 0 0 4 6.5v8A1.5 1.5 0 0 0 5.5 16h8a1.5 1.5 0 0 0 1.5-1.5V12M11 4h5v5M16 4l-7 7"/>',
    person: '<circle cx="10" cy="7" r="3"/><path d="M4.5 16c.6-3 2.8-4.5 5.5-4.5s4.9 1.5 5.5 4.5"/>',
    spark: '<path d="M10 2.6 11.7 8 17 9.7 11.7 11.4 10 16.8 8.3 11.4 3 9.7 8.3 8z"/>',
    clock: '<circle cx="10" cy="10" r="7"/><path d="M10 6v4.2l2.8 1.8"/>',
    plus: '<path d="M10 4v12M4 10h12"/>',
    shield: '<path d="M10 2.6 16 5v4.5c0 4-2.6 6.6-6 7.9-3.4-1.3-6-3.9-6-7.9V5z"/>',
    link: '<path d="M8.5 11.5 11.5 8.5M7.5 12.5 6 14a2.5 2.5 0 0 1-3.5-3.5L4 9M12.5 7.5 14 6a2.5 2.5 0 0 0-3.5-3.5L9 4"/>',
    play: '<path d="M6 4.5 15 10l-9 5.5z"/>',
    flag: '<path d="M5 17V3M5 4h9l-2 3 2 3H5"/>',
    convert: '<path d="M4 7h8l-2-2M16 13H8l2 2"/><rect x="3" y="3" width="14" height="14" rx="3" opacity="0"/>',
    dot: '<circle cx="10" cy="10" r="3.5"/>',
    maximize: '<path d="M7 4H4v3M13 4h3v3M7 16H4v-3M13 16h3v-3"/>',
    minimize: '<path d="M4 7h3V4M16 7h-3V4M4 13h3v3M16 13h-3v3"/>',
    pencil: '<path d="M13.5 4.5l2 2M4 16l1-3.2 7.6-7.6 2 2L7 14.8z"/>',
    refresh: '<path d="M15.5 6.5A6 6 0 1 0 16 10M16 4v3h-3"/>',
    stop: '<rect x="5.5" y="5.5" width="9" height="9" rx="1.6"/>',
    // SPEC-SETTINGS §5: two slider tracks with knobs — reads as "per-use-case
    // settings," distinct from the gear cliché, consistent with the thin-stroke set.
    sliders: '<path d="M4 6h7M14 6h2M4 14h2M9 14h7"/><circle cx="12.5" cy="6" r="1.8"/><circle cx="7.5" cy="14" r="1.8"/>',
  };
  const icon = (name, cls) => `<svg class="${cls || "ico"}" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${I[name] || ""}</svg>`;

  /* ---- status system --------------------------------------------------- */
  const STAT = {
    working:            { l: "Working",      c: "s-working" },
    in_progress:        { l: "In progress",  c: "s-working" },
    idle:               { l: "Idle",         c: "s-idle" },
    pending:            { l: "Pending",      c: "s-idle" },
    ready:              { l: "Ready",        c: "s-ready" },
    blocked:            { l: "Blocked",      c: "s-bad" },
    awaiting_request:   { l: "Waiting",      c: "s-warn" },
    awaiting_human:     { l: "Needs human",  c: "s-warn" },
    needs_verification: { l: "Needs verify", c: "s-attn" },
    completed:          { l: "Completed",    c: "s-done" },
    cancelled:          { l: "Cancelled",    c: "s-idle" },
    failed:             { l: "Failed",       c: "s-bad" },
    terminated:         { l: "Terminated",   c: "s-bad" },
    open:               { l: "Open",         c: "s-warn" },
    accepted:           { l: "Accepted",     c: "s-ready" },
    rejected:           { l: "Rejected",     c: "s-bad" },
    answered:           { l: "Answered",     c: "s-ok" },
    converted_to_task:  { l: "Converted",    c: "s-acc" },
    closed:             { l: "Closed",       c: "s-idle" },
    escalated:          { l: "Escalated",    c: "s-bad" },
  };
  function glyph(cls) {
    const v = (b) => `<svg class="gl" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${b}</svg>`;
    switch (cls) {
      case "s-working": return '<svg class="gl" viewBox="0 0 12 12"><circle cx="6" cy="6" r="4.6" fill="none" stroke="currentColor" stroke-opacity=".4" stroke-width="1.3"/><circle class="core" cx="6" cy="6" r="2.3" fill="currentColor"/></svg>';
      case "s-ok": case "s-done": return v('<path d="M2.6 6.4 5 8.7 9.4 3.6"/>');
      case "s-ready": return '<svg class="gl" viewBox="0 0 12 12" fill="currentColor"><path d="M3.6 2.6 9.6 6l-6 3.4z"/></svg>';
      case "s-attn": case "s-warn": return '<svg class="gl" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round" stroke-linecap="round"><path d="M6 2 11 10.6H1z"/><path d="M6 5v2.2"/><circle cx="6" cy="9" r=".55" fill="currentColor" stroke="none"/></svg>';
      case "s-bad": return v('<path d="M3.3 3.3 8.7 8.7M8.7 3.3 3.3 8.7"/>');
      case "s-acc": return v('<path d="M2.6 6h6.8M6.4 3 9.4 6 6.4 9"/>');
      default: return '<svg class="gl" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.4"><circle cx="6" cy="6" r="3.6" stroke-opacity=".55"/><path d="M4.3 6h3.4" stroke-linecap="round"/></svg>';
    }
  }
  function pill(status, size) {
    const m = STAT[status] || { l: status || "unknown", c: "s-idle" };
    return `<span class="pill ${m.c}${size ? " " + size : ""}">${glyph(m.c)}${esc(m.l)}</span>`;
  }
  function statusClass(status) { return (STAT[status] || { c: "s-idle" }).c; }

  function kindBadge(kind) {
    if (kind === "human") return `<span class="kind human">${icon("person", "")}Human</span>`;
    return `<span class="kind ai">${icon("spark", "")}AI</span>`;
  }

  /* ---- deeplinks (read live agents/tasks; never a dead-end) ------------- */
  function agentLink(alias, opts) {
    const a = agentByAlias(alias);
    if (!a) return esc(alias || "—");
    if (opts && opts.plain) return `<a class="dlink" href="/agents?agent=${encodeURIComponent(alias)}"><span>${esc(alias)}</span></a>`;
    return `<a class="dlink" href="/agents?agent=${encodeURIComponent(alias)}">${avatar(alias, a.kind, "")}<span>${esc(alias)}</span></a>`;
  }
  function taskLink(id, label) {
    const t = taskById(id);
    return `<a class="dlink" href="/tasks?task=${encodeURIComponent(id)}">${esc(label || (t ? t.title : id))}</a>`;
  }
  function requestLink(id, label) {
    return `<a class="dlink" href="/requests?req=${encodeURIComponent(id)}">${esc(label || id)}</a>`;
  }

  /* ---- action queue: what needs the human right now -------------------- */
  // a task needs PLAN approval when it's in progress, its agent has posted a plan
  // (an opening non-human thread message), and no plan_approval decision exists yet.
  function planMessageOf(t) {
    // ISS-68: the snapshot ships `plan_message` (latest agent note) instead of the full thread,
    // so the plan gate no longer needs the thread embedded. Fall back to the thread for any
    // legacy/expanded payload that still carries it.
    if (t && t.plan_message) return { body: t.plan_message.body, from: t.plan_message.author_alias || null, at: t.plan_message.at, is_human: false };
    const m = (t.thread || []).filter((x) => !x.is_human);
    return m.length ? m[0] : null;
  }
  function pendingPlan(t) {
    return t.status === "in_progress" && !t.plan_decision && !!planMessageOf(t);
  }
  // #367: which human-gate cards are shown is driven by the engine autonomy LEVEL
  // (containers.autonomy_level, read via autLevel()), NOT by task state alone:
  //   • plan   — Plan-only: agents stop at the plan gate, so a pending-plan handoff
  //              renders a Plan card. After approve→PR→completion the verify gate is live.
  //   • pr     — Build-to-PR: agents go straight to a PR, so there is NO plan card; a
  //              completed-PR handoff lands at needs_verification → Verify card only.
  //   • full   — agents carry approved work to its terminal state, so NEITHER a plan card
  //              NOR a verify card is shown (under Full /done auto-completes; this also
  //              defensively suppresses any task that still reaches needs_verification).
  // This is the single fix for the two #367 bugs — Full no longer shows an approval card,
  // and a completed-PR handoff at pr/full can never be mislabeled as a "Proposed plan".
  // Escalations are an explicit agent→human blocker (orthogonal to autonomy) and are
  // never suppressed — stranding a genuinely-blocked agent at Full would be worse, not safer.
  function attnItems() {
    const lvl = autLevel();
    const plans = lvl === "plan" ? tasks().filter(pendingPlan) : [];
    const verifs = lvl === "full" ? [] : tasks().filter((t) => t.status === "needs_verification");
    const escs = requests().filter((r) => r.status === "open" && isToHuman(r));
    return { plans, verifs, escs, count: plans.length + verifs.length + escs.length };
  }

  /* ---- the Orcha mark (orca) ------------------------------------------- */
  function orcaSVG() {
    return `<svg viewBox="0 0 100 100" fill="none" aria-label="Orcha">
      <path d="M27,83 C28,55 33,32 45.5,22.5 C51.5,18 57.5,19.5 60,27 C64.5,46 70.5,67 73,83 Z" fill="#f3fbfb"/>
      <g stroke="#06171c" stroke-width="2.4" stroke-linecap="round">
        <line x1="49" y1="38" x2="40" y2="62"/><line x1="49" y1="38" x2="56" y2="62"/><line x1="49" y1="38" x2="50" y2="74"/></g>
      <g fill="#06171c"><circle cx="39" cy="64" r="4"/><circle cx="57" cy="64" r="4"/><circle cx="50" cy="76" r="4"/></g>
      <circle cx="49" cy="35" r="6" fill="#1fc7cd"/>
      <path d="M13,86 C28,82 38,82 50,82.5 C62,82 72,82 87,86" stroke="#1fc7cd" stroke-width="5" stroke-linecap="round" fill="none"/>
    </svg>`;
  }

  /* ---- shell ----------------------------------------------------------- */
  function mountShell(page, opts) {
    opts = opts || {};
    const a = attnItems();
    // hrefs are the served FastAPI routes (extensionless), NOT the *.html filenames —
    // the portal serves /, /agents, /tasks, /requests (review P2: *.html would 404).
    const nv = [
      { key: "home", href: "/", ico: "home", label: "Dashboard" },
      { key: "agents", href: "/agents", ico: "agents", label: "Agents", count: agents().length },
      { key: "tasks", href: "/tasks", ico: "tasks", label: "Tasks",
        count: tasks().filter((t) => t.status === "needs_verification").length, attn: true },
      { key: "requests", href: "/requests", ico: "requests", label: "Requests",
        count: requests().filter((r) => r.status === "open").length },
      // SPEC-SETTINGS §5: 5th control-room entry — the Settings page (API key +,
      // later, per-use-case model selection). No count badge.
      { key: "settings", href: "/settings", ico: "sliders", label: "Settings" },
    ];

    const sidebar = document.getElementById("sidebar");
    if (sidebar) {
      sidebar.innerHTML = `
        <a class="brand" href="/" style="color:inherit">
          <span class="mark">${orcaSVG()}</span>
          <span class="word">Orcha<small>orchestration portal</small></span>
        </a>
        <nav class="nav">
          <div class="lbl">Control room</div>
          ${nv.map((n) => `<a href="${n.href}" class="${n.key === page ? "active" : ""}">
            ${icon(n.ico, "ico")}<span class="grow">${n.label}</span>
            ${n.count != null ? `<span class="ncount${n.attn && n.count ? " attn" : ""}">${n.count}</span>` : ""}
          </a>`).join("")}
          <div class="lbl">Live</div>
          <a href="/agents" class="">
            ${icon("live", "ico")}<span class="grow">Run feed</span>
          </a>
        </nav>
        <div class="sb-spacer"></div>
        <div class="attn-card">
          <div class="h">${icon("bell", "")}<span>Needs you</span></div>
          <div class="big tnum">${a.count}</div>
          <div class="sub">${a.verifs.length} to verify · ${a.escs.length} escalation${a.escs.length === 1 ? "" : "s"}</div>
          <a class="go" href="/#needs">Open action queue ${icon("arrow", "")}</a>
        </div>`;
    }

    const topbar = document.getElementById("topbar");
    if (topbar) {
      const who = actingHuman();
      const actingHTML = who
        ? `${avatar(who.alias, "human", "sm")}${esc(who.alias)}`
        : `<span class="muted">no human registered</span>`;
      // Two logical lines: identity/search/alerts, then the controls. They sit on one row when
      // the topbar is wide and collapse to two balanced rows when it's too narrow to fit (CSS).
      topbar.innerHTML = `
        <div class="tb-line tb-line-1">
          <div class="crumbs">
            <span class="page">${esc(opts.title || "")}</span>
            ${opts.ctx ? `<span class="ctx">${opts.ctx}</span>` : ""}
          </div>
          <div class="search">
            ${icon("search", "")}
            <input id="globalSearch" placeholder="Search agents, tasks, requests…" spellcheck="false" autocomplete="off">
            <span class="kbd">/</span>
          </div>
          <a class="attn-pill" id="attnPill" href="/#needs" title="Notifications — approvals, verifications & activity" aria-haspopup="true">
            ${icon("bell", "bell")}<span>Needs you</span><span class="n tnum">${a.count}</span>
          </a>
        </div>
        <div class="tb-line tb-line-2">
          <div class="aut-wrap" id="autWrap">
            <span class="aut-lab">autonomy</span>
            <div class="aut" id="autTop" role="radiogroup" aria-label="Container autonomy"></div>
          </div>
          <div class="notif-health" id="notifHealth" role="button" tabindex="0" title="Notifier status"></div>
          <div class="acting" title="You are the human authority on this container">
            <span class="lbl">acting as</span>
            <span class="who" id="actingWho">${actingHTML}</span>
          </div>
          <button class="iconbtn" id="themeBtn" title="Theme: ${currentTheme()} — click to cycle">
            ${icon("sun", "sun")}${icon("moon", "moon")}
          </button>
        </div>`;
      const tb = document.getElementById("themeBtn");
      if (tb) tb.addEventListener("click", cycleTheme);
      // SPEC-1: ensure the paused micro-banner element sits between topbar and content,
      // then render the autonomy switch from the current snapshot. Injected here (not in
      // each *.html) so the control is identical on every page.
      ensurePausebar(topbar);
      paintAutonomy();
      // #103: render the notifier-health chip from the current snapshot (like paintAutonomy).
      paintNotifierHealth();
      // SPEC-3: turn the "Needs you" pill into the notification-center dropdown trigger.
      wireNotifPill();
      const gs = document.getElementById("globalSearch");
      if (gs) document.addEventListener("keydown", (e) => {
        // the "/" shortcut focuses search — but NOT while the user is typing in a field
        // (composer, reason box, any input/textarea/select/contenteditable), or it would
        // steal the "/" keystroke + the focus mid-typing.
        if (e.key === "/" && !isEditableTarget(document.activeElement)) { e.preventDefault(); gs.focus(); }
        if (e.key === "Escape") gs.blur();
      });
    }
  }

  /* ---- SPEC-1: global autonomy switch ---------------------------------- */
  // Four rungs in ONE slider, lowest→highest authority, but TWO orthogonal backends:
  //   Rung 0  — the LIVE binary kill-switch, containers.wakes_enabled
  //             (POST /api/containers/{cid}/wakes). Paused(red) vs Running(green).
  //   Rungs 1-3 — the engine autonomy LEVEL, containers.autonomy_level
  //             (#298: POST /api/containers/{cid}/autonomy, level ∈ plan|pr|full).
  // The two are independent: pausing wakes does NOT change the level, so the active
  // level keeps rendering whether wakes are on or off. The active level lights in its
  // spec tone (plan=warn / pr=info / full=accent); rung 0 always shows the binary on top.
  // `level` is the wire enum the backend stores+returns; `label` is the operator-facing rung.
  const AUT_RUNGS = [
    { r: 0, label: "Paused" },
    { r: 1, level: "plan", tone: "warn", label: "Plan-only",
      meaning: "Agents wake & propose, but every plan stops at the approval gate — you approve before any execution.",
      impact: "Agents resume and propose plans, but you approve every plan before any execution." },
    { r: 2, level: "pr", tone: "info", label: "Build to PR",
      meaning: "Agents execute approved plans up to an open PR; you still merge.",
      impact: "Agents execute approved plans up to an open PR. You still merge." },
    { r: 3, level: "full", tone: "accent", label: "Full",
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
    bar.innerHTML = `<span>⏸ Autonomy paused — no agent wakes. Humans & live terminals still work.</span>
      <span class="resume" id="resumeBtn" role="button" tabindex="0">Resume ↩</span>`;
    topbar.insertAdjacentElement("afterend", bar);
  }

  // Render the switch + paused reinforcement from the current snapshot. Idempotent and
  // safe to call before mount (no #autTop → no-op), so the 5s poll can reconcile it.
  function paintAutonomy() {
    const host = document.getElementById("autTop");
    if (!host) return;
    const paused = wakesPaused();
    const level = autLevel();
    const canAct = !!actingHuman();
    host.classList.toggle("locked", !canAct);
    host.innerHTML = AUT_RUNGS.map((rg) => {
      if (rg.r === 0) {
        // the live binary: Paused (red) vs Running (neutral green), always lit
        const cls = paused ? "seg paused on" : "seg run on";
        const lab = paused ? "Paused" : "Running";
        const tip = canAct
          ? (paused ? "Wakes are OFF — click to resume" : "Wakes are ON — click to pause all agent wakes")
          : "Pick an acting human to change autonomy";
        return `<span class="${cls}" data-rung="0" role="radio" aria-checked="true"
          title="${esc(tip)}"><span class="d"></span>${esc(lab)}</span>`;
      }
      // rungs 1-3: the engine autonomy level (plan|pr|full). The active level lights in its
      // spec tone; the rest stay selectable. Orthogonal to rung 0 — the level renders the same
      // whether wakes are paused or running.
      const active = rg.level === level;
      const cls = "seg lvl " + rg.tone + (active ? " on" : "");
      const tip = canAct
        ? (active ? "Current autonomy: " + rg.label : "Set autonomy to " + rg.label + " — " + rg.meaning)
        : "Pick an acting human to change autonomy";
      return `<span class="${cls}" data-rung="${rg.r}" role="radio" aria-checked="${active}"
        title="${esc(tip)}"><span class="d"></span>${esc(rg.label)}</span>`;
    }).join("");
    host.querySelectorAll(".seg").forEach((seg) => {
      seg.onclick = () => onAutClick(+seg.dataset.rung);
    });
    // topbar red border + persistent micro-banner when paused
    const topbar = document.getElementById("topbar");
    if (topbar) topbar.classList.toggle("paused", paused);
    const bar = document.getElementById("pausebar");
    if (bar) {
      bar.classList.toggle("show", paused);
      const rb = document.getElementById("resumeBtn");
      if (rb) { rb.onclick = () => setWakes(true); rb.onkeydown = (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setWakes(true); } }; }
    }
  }

  /* ---- #103: notifier-health chip + manual recovery ------------------- */
  // The host-side `orcha notifier` daemon's liveness, from the 5s snapshot
  // (D.container.notifier, set by GET /api/containers/{cid}). Absent on a pre-#103 backend →
  // null, and we hide the chip rather than show a false "offline".
  function notifierHealth() {
    return (D.container && D.container.notifier) || null;
  }
  const NOTIF_TONE = { healthy: "ok", stale: "warn", offline: "bad" };
  const NOTIF_LABEL = { healthy: "Notifier · healthy", stale: "Notifier · stale", offline: "Notifier · offline" };
  function fmtSecs(s) {
    if (s == null) return "never";
    if (s < 60) return Math.round(s) + "s";
    if (s < 3600) return Math.round(s / 60) + "m";
    return Math.round(s / 3600) + "h";
  }
  // Render the chip from the snapshot. Idempotent + null-safe (no #notifHealth → no-op), so the
  // 5s poll can reconcile it. Healthy = a quiet green read; stale/offline = amber/red + clickable
  // for the manual recovery steps.
  function paintNotifierHealth() {
    const el = document.getElementById("notifHealth");
    if (!el) return;
    const h = notifierHealth();
    if (!h || !h.status) { el.style.display = "none"; return; }   // pre-#103 backend: no chip
    el.style.display = "";
    const tone = NOTIF_TONE[h.status] || "warn";
    const actionable = h.status !== "healthy";
    el.className = "notif-health " + tone + (actionable ? " actionable" : "");
    const bits = [];
    if (h.version) bits.push("v" + h.version);
    bits.push(h.last_seen_secs != null ? "last beat " + fmtSecs(h.last_seen_secs) + " ago" : "never seen");
    if (h.last_error) bits.push("error: " + h.last_error);
    const tip = (NOTIF_LABEL[h.status] || h.status) + " — " + bits.join(" · ")
      + (actionable ? " · click for recovery steps" : "");
    el.innerHTML = icon("refresh", "") + `<span>${esc(NOTIF_LABEL[h.status] || h.status)}</span>`;
    el.title = tip;
    el.setAttribute("aria-label", tip);
    // only expose it as an interactive control when there's a recovery action to take
    if (actionable) { el.setAttribute("role", "button"); el.setAttribute("tabindex", "0"); }
    else { el.removeAttribute("role"); el.setAttribute("tabindex", "-1"); }
    el.onclick = actionable ? () => notifierRecoveryModal(h) : null;
    el.onkeydown = actionable
      ? (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); notifierRecoveryModal(h); } }
      : null;
  }
  // A copyable command row for the recovery modal.
  function cmdRow(cmd) {
    return `<div class="cmd-row"><code>${esc(cmd)}</code>`
      + `<button class="btn subtle sm" data-cmd="${esc(cmd)}">${icon("copy", "")}Copy</button></div>`;
  }
  // Phase-A fallback: the portal (in a container) can't run host processes, so when the notifier is
  // stale/offline we explain the state plainly and show the exact terminal commands the human can
  // run. (Phase B will add a host helper that runs these from the button directly.)
  function notifierRecoveryModal(h) {
    const seen = h.last_seen_secs != null ? "last beat " + fmtSecs(h.last_seen_secs) + " ago" : "never seen";
    const errLine = h.last_error ? `<p class="muted" style="margin-top:8px">Last error: ${esc(h.last_error)}</p>` : "";
    const desc = h.status === "offline"
      ? "The notifier daemon isn't reporting in. Wakes may be enabled, but no host process is polling — so assigned agents won't start until it's running again."
      : "The notifier daemon's last heartbeat is old — it may be stuck or shutting down. Agents may wake slowly or not at all until it's healthy.";
    modal({
      title: "Notifier " + h.status,
      desc: desc,
      body: `<div class="notif-recover">
          <p class="muted">${esc(seen)}${h.version ? " · v" + esc(h.version) : ""}</p>
          ${errLine}
          <p style="margin:12px 0 6px">Run one of these on the machine hosting Orcha:</p>
          <p class="lbl" style="margin:10px 0 2px">Restart the notifier</p>
          ${cmdRow("orcha notifier --restart")}
          <p class="lbl" style="margin:12px 0 2px">Update &amp; restart the runtime</p>
          ${cmdRow("orcha up")}
        </div>`,
      primary: "Done",
      cancel: "Close",
      onOpen: (ov) => {
        ov.querySelectorAll("[data-cmd]").forEach((b) => {
          b.addEventListener("click", () => copyText(b.getAttribute("data-cmd")));
        });
      },
      onPrimary: () => closeModal(),
    });
  }

  function onAutClick(rung) {
    if (!actingHuman()) { toast("Pick an acting human to change autonomy", "warn"); return; }
    if (rung === 0) {
      const paused = wakesPaused();
      if (paused) {
        // resume → Running. #103: if the notifier isn't healthy, warn — enabling wakes won't wake
        // anything while no host process is polling, and show the manual restart command inline.
        const h = notifierHealth();
        const unhealthy = h && h.status && h.status !== "healthy";
        modal({
          title: "Resume autonomy?",
          desc: "Agents resume waking at the current autonomy level. Restores the global wake switch to ON (Running).",
          body: unhealthy
            ? `<div class="notif-warn">
                 <p><strong>Heads up:</strong> the notifier is <strong>${esc(h.status)}</strong>. Turning wakes back on
                 won't wake agents until the host-side notifier is running again. Restart it with:</p>
                 ${cmdRow("orcha notifier --restart")}
               </div>`
            : "",
          primary: "Resume",
          onPrimary: () => { closeModal(); setWakes(true); },
          onOpen: (ov) => {
            ov.querySelectorAll("[data-cmd]").forEach((b) => {
              b.addEventListener("click", () => copyText(b.getAttribute("data-cmd")));
            });
          },
        });
      } else {
        // pause → kill-switch
        modal({
          title: "Pause autonomy?",
          desc: "All agents stop waking immediately. In-flight work finishes; nothing new starts. Humans & live terminals still work.",
          primary: "Pause all wakes",
          danger: true,
          onPrimary: () => { closeModal(); setWakes(false); },
        });
      }
      return;
    }
    // rungs 1-3 → set the engine autonomy LEVEL (containers.autonomy_level). Confirm first
    // (this can switch off the human verification gate at 'full'); no-op if already there.
    const rg = AUT_RUNGS[rung];
    if (!rg || !rg.level) return;
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
    if (!actingHuman()) { toast("Pick an acting human to change autonomy", "warn"); return; }
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
        toast(res.wakes_enabled ? "Autonomy · Running" : "Autonomy · Paused", res.wakes_enabled ? "ok" : "bad");
      })
      .catch((e) => {
        D.container.wakes_enabled = prev;   // revert
        paintAutonomy();
        toast("Could not change autonomy: " + e.message, "danger");
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
        const rg = AUT_RUNGS.find((x) => x.level === res.autonomy_level);
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
  // The badge stays the NEEDS-YOU count ONLY — informational noise never inflates it.
  const NC_PAGE = 20;   // EARLIER page size
  let _ncOpen = false;
  // rows: cached EARLIER feed page(s); beforeTs/beforeId: keyset cursor for "Load earlier".
  let _ncFeed = { rows: [], readThrough: 0, beforeTs: null, beforeId: null,
                  more: false, loaded: false, loading: false };

  // type -> {icon, col} for the EARLIER zone. Unknown/future types DEGRADE GRACEFULLY to a
  // neutral dot + humanised label (forward-compat, mirrors presenceOf()) — a new registry
  // type never breaks the panel.
  const NC_VIS = {
    task_verified:    { icon: "check",    col: "violet" },
    request_answered: { icon: "arrow",    col: "info" },
    plan_decided:     { icon: "shield",   col: "violet" },
    task_assigned:    { icon: "tasks",    col: "info" },
    task_ready:       { icon: "tasks",    col: "info" },
    task_message:     { icon: "requests", col: "info" },
    task_unassigned:  { icon: "x",        col: "idle" },
    request_closed:   { icon: "check",    col: "idle" },
  };
  const NC_LABEL = {
    task_verified: "Task verified", request_answered: "Request answered",
    plan_decided: "Decision made", task_assigned: "Task assigned",
    task_ready: "Task ready", task_message: "Task update",
    task_unassigned: "Task unassigned", request_closed: "Request closed",
  };
  function ncHumanize(s) {
    return String(s || "notification").replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());
  }
  function ncDeeplinkHref(d) {
    if (!d || !d.id) return null;
    if (d.kind === "task") return "/tasks?task=" + encodeURIComponent(d.id);
    if (d.kind === "request") return "/requests?req=" + encodeURIComponent(d.id);
    return null;   // 'decision' / unknown kinds have no standalone page — row stays non-clickable
  }
  function ncIcon(name, col) {
    const cls = "ic c-" + col;
    // name === null → neutral dot (graceful degrade for an unknown type)
    if (!name) return `<span class="${cls}"><span class="ncdot"></span></span>`;
    return `<span class="${cls}">${icon(name, "")}</span>`;
  }

  // NEEDS YOU rows from the live action queue (attnItems) — authoritative + snapshot-fresh.
  function ncNeedsRows() {
    const a = attnItems();
    const rows = [];
    a.plans.forEach((t) => {
      const pm = planMessageOf(t);
      rows.push({ icon: "shield", col: "warn",
        ti: "Plan approval · " + (t.title || t.id), me: t.assignee || "—",
        when: (pm && pm.at) || t.started_at, href: "/tasks?task=" + encodeURIComponent(t.id) });
    });
    a.verifs.forEach((t) => {
      rows.push({ icon: "check", col: "warn",
        ti: "Verify task · " + (t.title || t.id), me: t.assignee || "—",
        when: t.started_at, href: "/tasks?task=" + encodeURIComponent(t.id) });
    });
    a.escs.forEach((r) => {
      rows.push({ icon: "flag", col: "danger",
        ti: "Escalation · " + trunc(r.payload || "", 52), me: (r.from || "—") + " → you",
        when: r.created_at, href: "/requests?req=" + encodeURIComponent(r.id) });
    });
    return rows;
  }

  // EARLIER rows from the cached registry feed. ts is epoch SECONDS — convert to ms for relTime.
  function ncEarlierRows() {
    return _ncFeed.rows.map((n) => {
      const vis = NC_VIS[n.type] || { icon: null, col: "idle" };
      const label = NC_LABEL[n.type] || ncHumanize(n.type);
      const ti = n.preview ? label + " · " + trunc(n.preview, 52) : label;
      return { icon: vis.icon, col: vis.col, unread: !n.read, ti: ti,
        me: n.actor_alias || "", when: n.ts != null ? n.ts * 1000 : null,
        href: ncDeeplinkHref(n.deeplink) };
    });
  }

  function ncRowHTML(r) {
    const when = r.when != null ? relTime(r.when) : "";
    const go = r.href ? `<span class="go">${icon("chev", "")}</span>` : "";
    const tag = r.href ? "a" : "div";
    const hattr = r.href ? ` href="${r.href}"` : "";
    return `<${tag} class="nrow${r.unread ? " unread" : ""}"${hattr}>
      ${ncIcon(r.icon, r.col)}
      <div class="b"><div class="ti">${esc(r.ti)}</div>
        <div class="me">${r.me ? esc(r.me) + "<span>·</span>" : ""}<span class="when">${esc(when)}</span></div></div>
      ${go}</${tag}>`;
  }

  function ncRenderPanel() {
    const float = document.getElementById("ncFloat");
    if (!float) return;
    const needs = ncNeedsRows();
    const earlier = ncEarlierRows();
    const needsHTML = needs.length
      ? needs.map(ncRowHTML).join("")
      : '<div class="nc-empty">✓ You\'re all caught up.</div>';
    let earlierHTML;
    if (!actingHuman()) {
      earlierHTML = '<div class="nc-empty">Pick an acting human to see your activity feed.</div>';
    } else if (!_ncFeed.loaded && _ncFeed.loading) {
      earlierHTML = '<div class="nc-empty">Loading…</div>';
    } else if (!earlier.length) {
      earlierHTML = '<div class="nc-empty">Nothing earlier.</div>';
    } else {
      earlierHTML = earlier.map(ncRowHTML).join("");
    }
    const foot = _ncFeed.more ? '<div class="nc-foot" id="ncMore">… Load earlier</div>' : "";
    float.innerHTML = `
      <div class="nc-h"><h3>Notifications</h3><span class="mark" id="ncMark">Mark all read</span></div>
      <div class="nc-zlbl needs">● Needs you <span class="ct">(${needs.length})</span></div>
      <div class="nc-list">${needsHTML}</div>
      <div class="nc-zlbl">Earlier</div>
      <div class="nc-list">${earlierHTML}</div>
      ${foot}`;
    const mark = document.getElementById("ncMark");
    if (mark) mark.addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); ncMarkAllRead(); });
    const more = document.getElementById("ncMore");
    if (more) more.addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); ncLoadFeed(false); });
  }

  // Fetch the EARLIER feed. reset=true → first page (panel open / refresh); else paginate
  // backward from the stored keyset cursor ("Load earlier").
  function ncLoadFeed(reset) {
    const who = actingHuman();
    if (!who) { ncRenderPanel(); return; }
    if (_ncFeed.loading) return;
    if (reset) { _ncFeed.beforeTs = null; _ncFeed.beforeId = null; }
    _ncFeed.loading = true;
    if (reset) ncRenderPanel();   // surface "Loading…" on first open
    let url = "/api/agents/" + encodeURIComponent(who.id) + "/notifications?zone=earlier&limit=" + NC_PAGE;
    if (!reset && _ncFeed.beforeTs != null) {
      url += "&before_ts=" + encodeURIComponent(_ncFeed.beforeTs);
      if (_ncFeed.beforeId != null) url += "&before_id=" + encodeURIComponent(_ncFeed.beforeId);
    }
    fetch(url)
      .then((r) => { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); })
      .then((res) => {
        const rows = res.notifications || [];
        _ncFeed.rows = reset ? rows : _ncFeed.rows.concat(rows);
        _ncFeed.readThrough = res.read_through_ts || 0;
        _ncFeed.beforeTs = res.next_before_ts;
        _ncFeed.beforeId = res.next_before_id;
        _ncFeed.more = res.next_before_ts != null;
        _ncFeed.loaded = true;
        _ncFeed.loading = false;
        ncRenderPanel();
      })
      .catch((e) => {
        _ncFeed.loading = false;
        _ncFeed.loaded = true;
        ncRenderPanel();
        toast("Could not load notifications: " + e.message, "danger");
      });
  }

  function ncMarkAllRead() {
    const who = actingHuman();
    if (!who) return;
    _ncFeed.rows.forEach((n) => { n.read = true; });   // optimistic — NEEDS YOU rows never clear here
    ncRenderPanel();
    fetch("/api/agents/" + encodeURIComponent(who.id) + "/notifications/read", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
    })
      .then((r) => { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); })
      .then((res) => { _ncFeed.readThrough = res.read_through_ts || _ncFeed.readThrough; })
      .catch((e) => { toast("Could not mark read: " + e.message, "danger"); });
  }

  // Inject the floating panel once + wire outside-click / Escape to close.
  function ensureNcFloat() {
    if (document.getElementById("ncFloat")) return;
    const float = document.createElement("div");
    float.id = "ncFloat";
    float.className = "ncenter float";
    document.body.appendChild(float);
    // Outside-click closes (mirrors the modal dismiss). Guard on the pill so the toggle
    // click that opened it doesn't immediately re-close it.
    document.addEventListener("click", (e) => {
      if (!_ncOpen) return;
      const pill = document.getElementById("attnPill");
      if (float.contains(e.target) || (pill && pill.contains(e.target))) return;
      ncClose();
    });
    document.addEventListener("keydown", (e) => { if (e.key === "Escape") ncClose(); });
  }
  function ncOpen() {
    ensureNcFloat();
    _ncOpen = true;
    const float = document.getElementById("ncFloat");
    if (float) float.classList.add("show");
    ncRenderPanel();
    ncLoadFeed(true);   // (re)fetch the EARLIER feed fresh each open
  }
  function ncClose() {
    _ncOpen = false;
    const float = document.getElementById("ncFloat");
    if (float) float.classList.remove("show");
  }
  function ncToggle() { _ncOpen ? ncClose() : ncOpen(); }

  // Wire the topbar pill (called from mountShell after the topbar is rebuilt each page).
  function wireNotifPill() {
    ensureNcFloat();
    const pill = document.getElementById("attnPill");
    if (!pill) return;
    pill.addEventListener("click", (e) => { e.preventDefault(); ncToggle(); });
  }

  // Reconcile on every snapshot: keep the badge (NEEDS-YOU count) fresh and, if the panel
  // is open, repaint instantly from the snapshot. (The topbar markup is built once by
  // mountShell; before SPEC-3 only autonomy was reconciled, so the pill count went stale.)
  function paintNotifications() {
    const pill = document.getElementById("attnPill");
    if (pill) {
      const n = pill.querySelector(".n");
      if (n) n.textContent = String(attnItems().count);
    }
    if (_ncOpen) ncRenderPanel();
  }

  /* ---- modal ----------------------------------------------------------- */
  function modal(cfg) {
    let ov = document.getElementById("__ov");
    if (!ov) {
      ov = document.createElement("div");
      ov.id = "__ov"; ov.className = "overlay";
      document.body.appendChild(ov);
      ov.addEventListener("click", (e) => { if (e.target === ov) closeModal(); });
      document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeModal(); });
    }
    ov.innerHTML = `<div class="modal" role="dialog" aria-modal="true">
      <div class="mh"><h3>${esc(cfg.title)}</h3>${cfg.desc ? `<p>${esc(cfg.desc)}</p>` : ""}</div>
      <div class="mb">${cfg.body || ""}</div>
      <div class="mf">
        <button class="btn ghost" id="__mc">${esc(cfg.cancel || "Cancel")}</button>
        <button class="btn ${cfg.danger ? "danger" : cfg.approve ? "approve" : ""}" id="__mp">${esc(cfg.primary || "Confirm")}</button>
      </div></div>`;
    ov.classList.add("show");
    document.getElementById("__mc").addEventListener("click", closeModal);
    document.getElementById("__mp").addEventListener("click", () => { if (cfg.onPrimary) cfg.onPrimary(ov); else closeModal(); });
    if (cfg.onOpen) cfg.onOpen(ov);
  }
  function closeModal() { const ov = document.getElementById("__ov"); if (ov) ov.classList.remove("show"); }

  /* ---- toast ----------------------------------------------------------- */
  let toastT;
  function toast(msg, kind) {
    let t = document.getElementById("__toast");
    if (!t) { t = document.createElement("div"); t.id = "__toast"; t.className = "toast"; document.body.appendChild(t); }
    t.className = "toast " + (kind || "");
    t.textContent = msg;
    requestAnimationFrame(() => t.classList.add("show"));
    clearTimeout(toastT);
    toastT = setTimeout(() => t.classList.remove("show"), 2600);
  }

  function copyText(s) { try { navigator.clipboard.writeText(s); toast("Copied", "ok"); } catch (e) {} }

  /* ---- diff renderer --------------------------------------------------- */
  function renderDiff(diff) {
    if (!diff || !diff.trim()) return '<div class="muted" style="padding:10px;font-size:13px">No net change (empty diff).</div>';
    let add = 0, del = 0;
    const rows = diff.split("\n").map((l) => {
      let cls = "";
      if (l.startsWith("+++") || l.startsWith("---") || l.startsWith("diff ") || l.startsWith("index ") || l.startsWith("new file")) cls = "meta";
      else if (l.startsWith("@@")) cls = "hunk";
      else if (l.startsWith("+")) { cls = "add"; add++; }
      else if (l.startsWith("-")) { cls = "del"; del++; }
      return `<div class="dl ${cls}">${esc(l || " ")}</div>`;
    }).join("");
    return `<div class="diff"><div class="dstat"><span class="a">+${add}</span><span class="d">−${del}</span><span class="muted">unified diff</span></div>${rows}</div>`;
  }

  /* ---- scroll/selection-preserving render (ISS-46) --------------------- */
  // The 3s live re-render must NOT (a) reset scrollTop inside a widget, nor (b)
  // clobber an in-progress text selection. patch() is the shared write path the
  // D-pages use instead of `el.innerHTML = html`:
  //   • unchanged html  -> no DOM write at all (scroll + selection untouched);
  //   • selection active inside el -> defer this render (the next tick repaints
  //     once the user is done selecting) so dragging to select never jumps;
  //   • real change -> snapshot scrollTop of el + every keyed scroll container,
  //     swap, then restore — so reading position holds across the poll.
  function selectionWithin(el) {
    if (typeof window === "undefined" || !window.getSelection || !el || !el.contains) return false;
    const s = window.getSelection();
    if (!s || s.rangeCount === 0 || s.isCollapsed) return false;
    // Check BOTH endpoints — a drag that starts outside and ends inside (or vice versa)
    // still has a live selection touching el (P3: anchor-only missed drag-INTO el).
    const inEl = (node) => { const e = node && (node.nodeType === 1 ? node : node.parentNode); return !!(e && el.contains(e)); };
    if (inEl(s.anchorNode) || inEl(s.focusNode)) return true;
    // ...or a selection that fully spans el (both endpoints outside) — range catches it.
    try { return s.getRangeAt(0).intersectsNode(el); } catch (e) { return false; }
  }
  // true when `el` is a text-entry target (so global keyboard shortcuts shouldn't fire).
  function isEditableTarget(el) {
    if (!el) return false;
    if (el.isContentEditable) return true;
    return /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName || "");
  }
  function inputActiveWithin(el) {
    // ISS-53 (same root as ISS-46): a 3s patch repaint must not wipe text the human is
    // typing into a card — a reject REASON or an answer to an agent's QUESTION. Defer the
    // patch while, inside el, a form control is FOCUSED, or a text input/textarea is DIRTY
    // (its current value differs from the value it was rendered with — i.e. the human typed
    // into it, then the mouse moved off before submit).
    //
    // GH #74: the old test was "value is non-empty". That misfires on PRE-FILLED but
    // UNTOUCHED fields — notably the SPEC-4 protocol editor (review_chain/handoff_to/
    // autonomy/notes), which renders the task's saved protocol straight into textareas. A
    // populated-but-unedited panel made this return true forever, so EVERY non-forced repaint
    // of that detail pane (the lazy thread load + the 3s poll) was deferred and the thread
    // stayed stuck on "Loading thread…". Comparing against `defaultValue` (the rendered
    // value) flips a field to "active" only once the human actually edits it, which preserves
    // the anti-clobber intent without freezing panes that merely show saved data.
    if (typeof document === "undefined" || !el || !el.querySelectorAll) return false;
    const ae = document.activeElement;
    if (ae && el.contains && el.contains(ae) && /^(INPUT|TEXTAREA|SELECT)$/.test(ae.tagName || "")) return true;
    const textish = /^(text|search|url|email|tel|number|password|)$/i;  // skip checkbox/radio/button/range
    const ctrls = el.querySelectorAll("input, textarea");
    for (let i = 0; i < ctrls.length; i++) {
      const c = ctrls[i];
      const isText = c.tagName === "TEXTAREA" || (c.tagName === "INPUT" && textish.test(c.type || ""));
      // dirty = edited away from what it was rendered with. `defaultValue` reflects the
      // markup-supplied value for both <input> and <textarea>, so an untouched field (incl.
      // a pre-filled one) is value===defaultValue and never blocks the repaint. In a real DOM
      // defaultValue is always a string (the empty field's is ""); fall back to "" if a field
      // exposes a non-string (a never-rendered/synthetic node) so an empty box isn't read as
      // dirty against `undefined`.
      const rendered = typeof c.defaultValue === "string" ? c.defaultValue : "";
      if (isText && typeof c.value === "string" && c.value !== rendered) return true;
    }
    return false;
  }
  function snapScroll(el) {
    const m = {};
    const cap = (n, k) => { if (k != null && n.scrollHeight > n.clientHeight + 1) m[k] = n.scrollTop; };
    cap(el, "__self");
    el.querySelectorAll("[id],[data-scrollkey]").forEach((n) => cap(n, n.id || n.getAttribute("data-scrollkey")));
    return m;
  }
  function restoreScroll(el, m) {
    if (m.__self != null) el.scrollTop = m.__self;
    el.querySelectorAll("[id],[data-scrollkey]").forEach((n) => {
      const k = n.id || n.getAttribute("data-scrollkey");
      if (k != null && m[k] != null) n.scrollTop = m[k];
    });
  }
  function patch(el, html, force) {
    if (!el) return false;
    if (el.__patchHtml === html) return false;   // unchanged -> no write, no jump, selection safe
    // ISS-57: the selection/input guards exist to protect a BACKGROUND 3s repaint from
    // clobbering an in-progress selection or typed text. An explicit user navigation
    // (force) is NOT a background repaint — clicking a new task/request/agent must apply
    // even mid-selection, else the detail panel strands on the previously-selected row.
    if (!force) {
      if (selectionWithin(el)) return false;     // mid text-selection -> defer (don't clobber it)
      if (inputActiveWithin(el)) return false;   // ISS-53: mid-typing in a card input -> defer
    }
    const scroll = snapScroll(el);
    el.innerHTML = html;
    el.__patchHtml = html;
    restoreScroll(el, scroll);
    return true;
  }

  /* ---- live-feed engine ------------------------------------------------ */
  // group toggle: clicking a .sec hides/shows lines until the next .sec
  function wireSections(logEl) {
    logEl.addEventListener("click", (e) => {
      const sec = e.target.closest(".sec");
      if (!sec || !logEl.contains(sec)) return;
      sec.classList.toggle("collapsed");
      const hide = sec.classList.contains("collapsed");
      let n = sec.nextElementSibling;
      while (n && !n.classList.contains("sec")) { n.classList.toggle("hidden", hide); n = n.nextElementSibling; }
    });
  }
  function logRow(e, isNew) {
    const t = e.type || "narrate";
    const det = e.detail ? `<span class="det">${esc(e.detail)}</span>` : "";
    return `<div class="ln t-${t}${isNew ? " new" : ""}"><span class="gut">›</span><span class="ty">${esc(e.label || t)}</span><span class="tx">${esc(e.text)}${det}</span></div>`;
  }
  function appendLine(logEl, e) {
    const atBottom = logEl.scrollHeight - logEl.clientHeight - logEl.scrollTop < 36;
    if (e.sec != null) {
      logEl.insertAdjacentHTML("beforeend", `<div class="sec"><span class="chev">${icon("chev", "")}</span><span>${esc(e.sec)}</span></div>`);
    } else {
      logEl.insertAdjacentHTML("beforeend", logRow(e, true));
      const last = logEl.lastElementChild;
      setTimeout(() => last && last.classList.remove("new"), 360);
    }
    // cap length so a long live stream can't grow unbounded
    while (logEl.children.length > 400) logEl.removeChild(logEl.firstElementChild);
    if (atBottom) logEl.scrollTop = logEl.scrollHeight;
  }

  // ---- classify one raw stream-json worker line into the feed's row shape.
  // Maps the 9 Orcha event types onto the design system's type tokens
  // (boot/narrate/think/tool/result/subagent/decision/error/done).
  function selfAction(name, input) {
    const s = (typeof input === "string" ? input : JSON.stringify(input || "")).toLowerCase();
    if (/orcha-[a-z]/.test(s)) return true;
    return /\/api\/(decisions|agent-suggestions\/[^ "\/]+\/decide|containers\/[^ "\/]+\/(requests|tasks)|tasks\/[^ "\/]+\/(done|messages|next|verify|cancel|close|respond)|requests\/[^ "\/]+\/[a-z-]+|agents\/[^ "\/]+\/(next|digest|reachability|wake-ack|wake-claim))/.test(s);
  }
  function jsonDetail(v) {
    if (v == null || v === "") return "";
    if (typeof v === "string") return v;
    try { return JSON.stringify(v); } catch (e) { return String(v); }
  }
  function visibleText(v) {
    if (v == null) return "";
    if (typeof v === "string") return v;
    if (typeof v === "number" || typeof v === "boolean") return String(v);
    if (Array.isArray(v)) return v.map(visibleText).filter(Boolean).join("\n");
    if (typeof v === "object") {
      if (typeof v.text === "string") return v.text;
      if (typeof v.output_text === "string") return v.output_text;
      if (typeof v.summary_text === "string") return v.summary_text;
      if (typeof v.message === "string") return v.message;
      if (typeof v.content === "string") return v.content;
      if (typeof v.output === "string") return v.output;
      if (Array.isArray(v.content)) return visibleText(v.content);
      if (Array.isArray(v.output)) return visibleText(v.output);
    }
    return "";
  }
  function summaryText(v) {
    if (v == null) return "";
    if (typeof v === "string") return v;
    if (Array.isArray(v)) return v.map(summaryText).filter(Boolean).join("\n");
    if (typeof v === "object") {
      if (typeof v.text === "string") return v.text;
      if (typeof v.summary_text === "string") return v.summary_text;
      if (typeof v.content === "string" && /summary/.test(String(v.type || "").toLowerCase())) return v.content;
      if (Array.isArray(v.content)) return summaryText(v.content);
    }
    return "";
  }
  function classifyCodex(o) {
    const rows = [];
    const p = o && typeof o.msg === "object" ? o.msg
      : (o && typeof o.event === "object" ? o.event : o);
    const item = p && typeof p.item === "object" ? p.item
      : (p && typeof p.delta === "object" ? p.delta : p);
    const ptype = String((p && p.type) || (o && o.type) || "").toLowerCase();
    const itype = String((item && item.type) || "").toLowerCase();
    const kind = (ptype + " " + itype).trim();

    if (/reasoning/.test(kind)) {
      const isSummary = /reasoning.*summary|summary.*reasoning/.test(kind);
      const txt = summaryText(item && (item.summary || item.reasoning_summary || item.summary_text))
        || summaryText(p && (p.summary || p.reasoning_summary || p.summary_text))
        || (isSummary ? visibleText(p && (p.delta || p.text || p.content)) : "");
      rows.push(txt
        ? { type: "think", label: "reasoning", text: txt }
        : { type: "think", label: "reasoning", text: "reasoning summary unavailable", detail: "provider did not expose raw reasoning" });
      return rows;
    }

    if (/function_call_output|tool_result|exec_command_output|command_output|exec_command_end|command_completed|tool_call_result/.test(kind)) {
      let detail = visibleText(item && (item.output || item.content || item.result || item.chunk))
        || visibleText(p && (p.output || p.content || p.result || p.chunk));
      if (!detail && item && item.exit_code != null) detail = "exit " + item.exit_code;
      if (!detail && p && p.exit_code != null) detail = "exit " + p.exit_code;
      const dec = /decision_made|"decision_id"/.test(detail || "");
      rows.push({ type: dec ? "decision" : "result", label: dec ? "decision" : "tool result",
        text: dec ? "decision received {decision,reason}" : "tool result", detail: detail || jsonDetail(item || p) });
      return rows;
    }

    if (/function_call|tool_call|tool_use|exec_command_begin|exec_command_started|command_started|mcp_tool_call/.test(kind)) {
      const fn = (item && item.function) || (p && p.function) || {};
      const name = (item && (item.name || item.tool_name)) || (p && (p.name || p.tool_name)) || fn.name
        || ((item && item.command) || (p && p.command) ? "exec" : "tool");
      const input = (item && (item.arguments || item.input || item.args || item.params || item.command))
        || (p && (p.arguments || p.input || p.args || p.params || p.command)) || {};
      const self = selfAction(name, input);
      rows.push({ type: self ? "decision" : "tool", label: self ? "orcha-action" : "tool",
        text: name, detail: jsonDetail(input) });
      return rows;
    }

    if (/output_text|message_delta|agent_message_delta|assistant_message_delta/.test(kind)) {
      const txt = visibleText(item && (item.content || item.message || item.text || item.delta))
        || visibleText(p && (p.content || p.message || p.text || p.delta));
      if (txt && txt.trim()) rows.push({ type: "narrate", label: "narration", text: txt });
      return rows;
    }

    if (/agent_message|assistant_message|message/.test(kind) || (item && item.role === "assistant")) {
      const txt = visibleText(item && (item.content || item.message || item.text || item.delta))
        || visibleText(p && (p.content || p.message || p.text || p.delta));
      if (txt && txt.trim()) rows.push({ type: "narrate", label: "narration", text: txt });
      return rows;
    }

    if (/error|failed/.test(kind)) {
      rows.push({ type: "error", label: "error",
        text: trunc(visibleText(p && (p.message || p.error || p.reason)) || ptype || "error", 200),
        detail: jsonDetail(p && (p.error || p.detail || p)) });
      return rows;
    }
    if (/session.*(configured|created|started)|thread.*started/.test(ptype)) {
      rows.push({ type: "boot", label: "wake", text: "codex " + ptype });
      return rows;
    }
    if (/(turn|task|response).*(started|created|queued|in_progress|delta)/.test(ptype)) {
      rows.push({ type: "narrate", label: "progress", text: "codex " + ptype });
      return rows;
    }
    if (/(turn|task|response).*(completed|done|succeeded)/.test(ptype)) {
      rows.push({ type: "done", label: "run-complete", text: "codex " + ptype });
      return rows;
    }
    return rows;
  }
  function classifyLine(line) {
    const out = [];
    let o; try { o = JSON.parse(line); } catch (e) { if ((line || "").trim()) out.push({ type: "narrate", label: "log", text: trunc(line, 240) }); return out; }
    const t = o.type, st = o.subtype, cont = o.message && o.message.content;
    if (t === "assistant" && Array.isArray(cont)) {
      cont.forEach((c) => {
        if (c.type === "text" && c.text && c.text.trim()) out.push({ type: "narrate", label: "narration", text: c.text });
        else if (c.type === "thinking") out.push({ type: "think", label: "thinking", text: "(thinking)", detail: c.thinking || "" });
        else if (c.type === "tool_use") { const self = selfAction(c.name, c.input);
          out.push({ type: self ? "decision" : "tool", label: self ? "orcha-action" : "tool", text: c.name, detail: JSON.stringify(c.input || {}) }); }
      });
    } else if (t === "user" && Array.isArray(cont)) {
      cont.forEach((c) => {
        if (c.type === "tool_result") { const r = typeof c.content === "string" ? c.content : JSON.stringify(c.content);
          const dec = /decision_made|"decision_id"/.test(r);
          out.push({ type: dec ? "decision" : "result", label: dec ? "decision" : "tool result", text: dec ? "decision received {decision,reason}" : "tool result", detail: r }); }
        else if (c.type === "text") out.push({ type: "boot", label: "injected prompt", text: trunc(c.text || "", 200) });
      });
    } else if (t === "system") {
      if (st === "init") out.push({ type: "boot", label: "wake", text: "wake start · cwd " + (o.cwd || "") });
      else if (st && st.indexOf("hook") === 0) out.push({ type: "think", label: "hook", text: "hook " + (o.hook_name || ""), detail: o.output || "" });
      else if (st === "thinking_tokens") { /* token noise: skip */ }
      else out.push({ type: "boot", label: "lifecycle", text: "system " + (st || "") });
    } else if (t === "result") {
      out.push({ type: "done", label: "run-complete", text: trunc(JSON.stringify(o.result || o.subtype || "done"), 200) });
    } else {
      const codex = classifyCodex(o);
      if (codex.length) codex.forEach((e) => out.push(e));
      else out.push({ type: "narrate", label: t || "event", text: "" });
    }
    return out;
  }

  // ---- REAL live stream: one EventSource per running run (folds in the SSE
  // client). {seq,line} → classify + append; terminal {done,status} closes;
  // stream_timeout reopens (30-min server cap); monotonic seq drops replay.
  function startRunStream(logEl, agentId, runId) {
    if (typeof EventSource === "undefined") return () => {};
    let es = null, maxSeq = 0, stopped = false;
    function open() {
      if (stopped) return;
      try { es = new EventSource("/api/agents/" + encodeURIComponent(agentId) + "/runs/" + encodeURIComponent(runId) + "/stream"); }
      catch (e) { return; }
      es.onmessage = (ev) => {
        let d; try { d = JSON.parse(ev.data); } catch (e) { return; }
        if (d && d.done) {
          if (es) { try { es.close(); } catch (e) {} es = null; }
          if (d.status === "stream_timeout" && !stopped) { open(); return; }  // reconnectable
          appendLine(logEl, { type: "done", label: "run-complete", text: String(d.status || "ended") });
          return;
        }
        if (d && typeof d.seq === "number" && typeof d.line === "string") {
          if (d.seq <= maxSeq) return;            // monotonic — drops reconnect replay
          maxSeq = d.seq;
          classifyLine(d.line).forEach((e) => appendLine(logEl, e));
        }
      };
    }
    open();
    return () => { stopped = true; if (es) { try { es.close(); } catch (e) {} es = null; } };
  }

  // synthesize a classified log for a FINISHED run from its captured output.
  function paintFinished(logEl, run) {
    const output = run.output || "";
    if (!output.trim()) { appendLine(logEl, { type: "narrate", label: "log", text: "(no captured output)" }); }
    else output.split("\n").forEach((line) => { if (line.trim()) classifyLine(line).forEach((e) => appendLine(logEl, e)); });
    appendLine(logEl, { type: "done", label: "run-complete",
      text: (run.status || "ended") + (run.exit_code != null ? " · exit " + run.exit_code : "") });
  }

  // render a run card (header + chips + diff + log). live runs stream.
  const TYPE_SW = { boot: "var(--ok)", narrate: "var(--text)", think: "var(--idle)", tool: "var(--info)",
    result: "var(--muted)", subagent: "var(--violet)", decision: "var(--amber)", error: "var(--danger)", done: "var(--ok)" };
  const TYPE_LABEL = { boot: "lifecycle", narrate: "narration", think: "thinking", tool: "tool call",
    result: "tool result", subagent: "sub-agent", decision: "decision", error: "error", done: "complete" };
  /* ---- SPEC-2 T2: graceful Stop of a single worker run ----------------- */
  // run_ids a human has requested a stop for THIS session. Keeps the 'Stop requested'
  // relabel sticky: the /runs poll early-returns on unchanged status, and even a forced
  // repaint re-renders the button from this set — so it never reverts to active 'Stop run'
  // until the run's status actually flips (then `live` is false and the button is gone).
  const stopRequestedRuns = new Set();
  function killCause(kr) { try { return (JSON.parse(kr) || {}).cause || ""; } catch (e) { return ""; } }
  function stopRun(rid) {
    if (!rid) return;
    const h = actingHuman();
    if (!h) { toast("Pick an acting human first.", "danger"); return; }   // human-gated (POST /stop 403s non-humans)
    if (stopRequestedRuns.has(rid)) { toast("Stop already requested for this run.", "warn"); return; }
    modal({
      title: "Stop run " + shortId(rid) + "?",
      // Honesty (graceful stop): the API only RECORDS the intent; the host daemon reaps the
      // worker on its next wake-renew tick — it is NOT an instant kill.
      desc: "Requests a graceful stop — the worker halts at its next checkpoint (the daemon "
        + "reaps it on the next wake-tick, not instantly). The task stays in_progress for you "
        + "to reassign or rewake.",
      danger: true, primary: "Stop run",
      onPrimary: () => {
        closeModal();
        fetch("/api/runs/" + encodeURIComponent(rid) + "/stop", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ actor_agent_id: h.id }),
        })
          .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
          .then((d) => {
            // Three 200 shapes from POST /api/runs/{id}/stop (main.py:3259 on overnight_612):
            //   already_finished → nothing live to signal; just report the terminal state.
            //   already_requested → a prior stop is already pending (still mark + relabel).
            //   fresh stop → stop_requested recorded.
            if (d && d.already_finished) { toast("Run already " + (d.status || "finished") + ".", "warn"); return; }
            markStopRequested(rid);
            toast(d && d.already_requested ? "Stop already requested." : "Stop requested — the worker halts on the next tick.", "ok");
          })
          .catch((e) => toast("Stop failed (" + e + ").", "danger"));
      },
    });
  }
  function markStopRequested(rid) {
    stopRequestedRuns.add(rid);
    // Instant feedback: relabel the live button now (the next /runs poll early-returns on
    // unchanged status, so it would otherwise stay 'Stop run' until the status flips).
    try {
      const sel = '[data-run-stop="' + (typeof CSS !== "undefined" && CSS.escape ? CSS.escape(rid) : rid) + '"]';
      const btns = document.querySelectorAll(sel) || [];
      btns.forEach((b) => {
        b.disabled = true;
        b.title = "Stop requested — the worker halts at its next checkpoint";
        b.innerHTML = '<span class="sq"></span>Stop requested';
      });
    } catch (e) {}
  }
  function onRunStopClick(ev) {
    const t = ev && ev.target;
    const b = t && t.closest && t.closest("[data-run-stop]");
    if (!b || b.disabled) return;
    stopRun(b.getAttribute("data-run-stop"));
  }
  function runCard(run) {
    const rid = run.run_id || run.id;
    const live = run.status === "running";
    const statusTxt = live ? "running" : run.status;
    const started = run.started_at || run.started;
    const ended = run.ended_at || run.ended;
    const killed = run.status === "killed";
    // #299 honesty: a human-stopped run ALSO reaps as status='killed' (kill_reason.cause=
    // 'human_stop'); only a watchdog stall/cap kill should read 'watchdog-killed'.
    const killTag = killed ? (killCause(run.kill_reason) === "human_stop" ? " ■ stopped" : " ⚠ watchdog-killed") : "";
    const stopReq = stopRequestedRuns.has(rid);
    const stopBtn = live
      ? `<button class="btn sm stop" type="button" data-run-stop="${esc(rid)}"${stopReq ? " disabled" : ""} title="${stopReq ? "Stop requested — the worker halts at its next checkpoint" : "Stop this worker run"}"><span class="sq"></span>${stopReq ? "Stop requested" : "Stop run"}</button>`
      : "";
    return `<div class="run">
      <div class="run-h">
        <span class="rstat ${esc(statusTxt)}">${esc(statusTxt)}${run.exit_code != null && !live ? " · exit " + run.exit_code : ""}${killTag}</span>
        <span class="tag mono">${esc(run.wake_kind === "tmux" ? "live tab" : (run.wake_kind || ""))}</span>
        ${live ? '<span class="live accent"><span class="d"></span>live</span>' : ""}
        ${stopBtn}
        <span class="when">${esc(clockTime(started))}${ended ? " → " + esc(clockTime(ended)) : " …"}${started ? ' · ' + esc(relTime(ended || started)) : ""}</span>
      </div>
      ${run.diff != null ? `<details><summary style="cursor:pointer;color:var(--info);font-size:12.5px;padding:0 15px 10px;font-weight:600">code diff</summary><div style="padding:0 15px 14px">${renderDiff(run.diff)}</div></details>` : ""}
      <details open>
        <summary style="cursor:pointer;color:var(--muted);font-size:12.5px;padding:8px 15px;font-weight:600;border-top:1px solid var(--border)">log${live ? " · streaming" : ""}</summary>
        <div class="log" id="run-${esc(rid)}"></div>
      </details>
    </div>`;
  }
  // call AFTER runCards are in the DOM to start streams / paint static logs.
  function activateRuns(runs) {
    const stops = [];
    (runs || []).forEach((run) => {
      const rid = run.run_id || run.id;
      const logEl = document.getElementById("run-" + rid);
      if (!logEl) return;
      wireSections(logEl);
      if (run.status === "running" && (run.agent_id || run.agent)) {
        stops.push(startRunStream(logEl, run.agent_id || run.agent, rid));
      } else {
        paintFinished(logEl, run);
      }
    });
    return () => stops.forEach((s) => s());
  }

  /* ---- apply the persisted/default theme + sync label on load ---------- */
  // P2: set <html data-theme> immediately at load so a saved 'light' (or 'auto' on a
  // light OS) doesn't flash the dark :root default until the user clicks the toggle.
  // setAttribute (not applyTheme) so a default 'auto' stays implicit — not persisted.
  document.documentElement.setAttribute("data-theme", currentTheme());
  document.addEventListener("DOMContentLoaded", syncThemeLabel);
  // SPEC-2 T2: one delegated listener covers every runCard on every page — the run feed is
  // repainted each poll, but `document` persists, so a single handler outlives the repaints.
  document.addEventListener("click", onRunStopClick);

  /* ---------- ISS-331: reusable sort control (Time/Priority + asc/desc) ----------
     ONE implementation shared by all five list surfaces (Tasks list, Requests list, and the
     agent-detail current-tasks / incoming / outgoing lists) — never forked. Each surface
     instantiates it with a stable `name` (its own persisted choice) and passes field accessors
     {bucket,time,prio}; the control owns the UI, the localStorage state, and the comparator.
     Semantics MIRROR the server _sort_clause: the status `bucket` stays the OUTER key (open /
     needs-attention first), the chosen key sorts WITHIN it, the unchosen key is the tiebreaker.
     The explicit choice supersedes the ISS-83 recency-band heuristic within a group. */
  const SORT_DEFAULT = { key: "time", dir: "desc" };   // "Time-sort is the higher-priority key"
  function sortState(name) {
    try {
      const raw = JSON.parse(localStorage.getItem("orcha:sort:" + name) || "null");
      if (raw && (raw.key === "time" || raw.key === "priority") && (raw.dir === "asc" || raw.dir === "desc")) return raw;
    } catch (e) {}
    return { key: SORT_DEFAULT.key, dir: SORT_DEFAULT.dir };
  }
  function setSortState(name, st) {
    try { localStorage.setItem("orcha:sort:" + name, JSON.stringify(st)); } catch (e) {}
  }
  function sortControlHtml(name) {
    const st = sortState(name);
    const arrow = st.dir === "asc" ? "↑" : "↓";
    const dirLabel = st.key === "time"
      ? (st.dir === "asc" ? "oldest first" : "newest first")
      : (st.dir === "asc" ? "highest priority first" : "lowest priority first");
    return `<span class="sortctl" data-sort="${esc(name)}" role="group" aria-label="Sort order">`
      + `<button type="button" data-sort-key="time" class="${st.key === "time" ? "on" : ""}" aria-pressed="${st.key === "time"}">Time</button>`
      + `<button type="button" data-sort-key="priority" class="${st.key === "priority" ? "on" : ""}" aria-pressed="${st.key === "priority"}">Priority</button>`
      + `<button type="button" class="sortdir" data-sort-dir aria-label="Toggle direction — ${dirLabel}" title="${dirLabel}">${arrow}</button>`
      + `</span>`;
  }
  // comparator mirroring server _sort_clause; acc = {bucket(item)->int, time(item)->ms, prio(item)->number}
  function sortComparator(name, acc) {
    const st = sortState(name);
    const sign = st.dir === "asc" ? 1 : -1;
    const bucket = acc.bucket || (() => 0);
    return (a, b) => {
      const bk = bucket(a) - bucket(b);
      if (bk) return bk;
      if (st.key === "priority") {
        const d = acc.prio(a) - acc.prio(b);     // lower number = higher priority
        if (d) return sign * d;
        return acc.time(b) - acc.time(a);        // tiebreak: newest first
      }
      const d = acc.time(a) - acc.time(b);
      if (d) return sign * d;                    // asc = oldest first, desc = newest first
      return acc.prio(a) - acc.prio(b);          // tiebreak: highest priority first
    };
  }
  // Delegate clicks for ANY .sortctl under `root` (one binding handles multiple controls, e.g.
  // the three agent-detail lists). Idempotent: re-calls on a re-rendered surface are no-ops since
  // `root` (a stable container node, not the replaced control markup) keeps the listener.
  function wireSortControl(root, onChange) {
    if (!root || root._sortWired) return;
    root._sortWired = true;
    root.addEventListener("click", (ev) => {
      const ctl = ev.target.closest(".sortctl[data-sort]");
      if (!ctl) return;
      const keyBtn = ev.target.closest("[data-sort-key]");
      const dirBtn = ev.target.closest("[data-sort-dir]");
      if (!keyBtn && !dirBtn) return;
      const name = ctl.getAttribute("data-sort");
      const st = sortState(name);
      if (keyBtn) {
        const k = keyBtn.getAttribute("data-sort-key");
        if (k === st.key) return;                 // no-op click on the already-active key
        st.key = k; st.dir = k === "time" ? "desc" : "asc";   // reset to the key's natural default
      } else {
        st.dir = st.dir === "asc" ? "desc" : "asc";
      }
      setSortState(name, st);
      if (onChange) onChange(name, st);
    });
  }

  return {
    D, applySnapshot, esc, linkify, mdText, trunc, shortId, relTime, clockTime, recencyTs, recencyBand, avatar, icon, pill, statusClass, glyph,
    sortState, sortControlHtml, sortComparator, wireSortControl,
    kindBadge, agentLink, taskLink, requestLink, taskByRef, taskRefs, attnItems, mountShell, modal, closeModal,
    toast, copyText, renderDiff, runCard, stopRun, activateRuns, startRunStream, paintFinished, classifyLine,
    applyTheme, currentTheme, cycleTheme, orcaSVG,
    agents, tasks, requests, agentByAlias, agentById, aliasFor, taskById, humans, isToHuman,
    actingHuman, setActingHuman, patch, selectionWithin, inputActiveWithin, leaseOf,
  };
})();
