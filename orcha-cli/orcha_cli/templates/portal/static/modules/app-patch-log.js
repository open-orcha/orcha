/* Orcha shared portal module: scroll-safe DOM patching and base run-log rows. */

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
