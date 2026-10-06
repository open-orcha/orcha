/**
 * Which fields get dictation, and how dictated text goes into them.
 *
 * Eligibility is decided from the DOM, not per call site, so every text field
 * the portal renders — today's and tomorrow's — gets the mic without wiring:
 * textareas, text-like inputs and rich contenteditable fields. Excluded:
 * password / number / url / email / tel / date-ish inputs, anything that looks
 * like a credential (API key, token, secret, PAT), read-only or disabled
 * fields, code editors and terminals, and any field marked
 * `data-dictation="off"`. `data-dictation="on"` forces it on.
 *
 * Insertion goes through `document.execCommand("insertText")` where the
 * browser supports it: that fires the same `input` event typing does (so
 * React's onChange runs) AND lands on the browser's native undo stack, so
 * ⌘Z restores the previous text exactly like undoing typing. Where it isn't
 * supported (jsdom, some old engines) a value-setter fallback fires the input
 * event and we keep our own one-step undo record.
 */
export type DictationTarget = HTMLTextAreaElement | HTMLInputElement | HTMLElement;

const TEXT_INPUT_TYPES = new Set(["", "text", "search"]);
const CREDENTIAL_RE = /(api[\s_-]?key|\btoken\b|secret|passw|passphrase|\bpat\b|private[\s_-]?key|client[\s_-]?id|webhook|\bcron\b|\burl\b|\bhttps?:)/i;

function attr(el: Element, name: string): string {
  return el.getAttribute(name) || "";
}

/** Pure DOM verdict: should this element get a mic? */
export function isDictationTarget(el: Element | null | undefined): el is DictationTarget {
  if (!el || !(el as HTMLElement).tagName) return false;
  const h = el as HTMLElement;
  const flag = attr(h, "data-dictation").toLowerCase();
  if (flag === "off") return false;
  if (h.closest && h.closest('[data-dictation="off"], .cm-editor, .xterm')) return false;
  const tag = h.tagName;
  if (tag === "TEXTAREA") {
    const t = h as HTMLTextAreaElement;
    if (t.disabled || t.readOnly) return false;
  } else if (tag === "INPUT") {
    const i = h as HTMLInputElement;
    if (i.disabled || i.readOnly) return false;
    const type = (attr(i, "type") || "text").toLowerCase();
    if (!TEXT_INPUT_TYPES.has(type)) return false;
    if (/password|one-time-code|cc-|username|email|url|tel/i.test(attr(i, "autocomplete"))) return false;
    if (i.inputMode && /numeric|decimal|tel|email|url/.test(i.inputMode)) return false;
  } else if (h.isContentEditable || attr(h, "contenteditable") === "true" || (h.hasAttribute("contenteditable") && attr(h, "contenteditable") === "")) {
    // rich text field (contenteditable) — eligible
  } else {
    return false;
  }
  if (flag === "on") return true;
  const hints = [attr(h, "name"), h.id, attr(h, "aria-label"), attr(h, "placeholder"), attr(h, "autocomplete")].join(" ");
  if (CREDENTIAL_RE.test(hints)) return false;
  return true;
}

/** Single-line field (an <input>): dictated newlines collapse to spaces. */
export function isSingleLine(el: DictationTarget): boolean {
  return el.tagName === "INPUT";
}

/** A friendly name for the field (HUD "Dictating into Title"). */
export function targetLabel(el: DictationTarget): string {
  const aria = attr(el, "aria-label");
  if (aria) return aria;
  const id = el.id;
  if (id) {
    try {
      const lab = el.ownerDocument.querySelector(`label[for="${CSS.escape(id)}"]`);
      const t = lab?.textContent?.trim();
      if (t) return t;
    } catch {
      /* CSS.escape missing */
    }
  }
  const wrap = el.closest("label");
  const wt = wrap?.textContent?.trim();
  if (wt) return wt.slice(0, 40);
  return attr(el, "placeholder") || "this field";
}

export interface Selection {
  start: number;
  end: number;
}

function isFormField(el: DictationTarget): el is HTMLInputElement | HTMLTextAreaElement {
  return el.tagName === "INPUT" || el.tagName === "TEXTAREA";
}

export function readSelection(el: DictationTarget): Selection {
  if (isFormField(el)) {
    const len = el.value.length;
    const s = el.selectionStart ?? len;
    const e = el.selectionEnd ?? s;
    return { start: s, end: e };
  }
  return { start: -1, end: -1 };
}

export function fieldValue(el: DictationTarget): string {
  return isFormField(el) ? el.value : el.textContent || "";
}

/**
 * Pure: the text to insert so it reads naturally next to what's around the
 * cursor — a space before when gluing onto a word, none before punctuation,
 * capitalised at the start of the field or after a sentence end, newlines
 * collapsed in single-line fields.
 */
export function shapeInsertion(before: string, after: string, text: string, singleLine: boolean): string {
  let t = singleLine ? text.replace(/\s*\n+\s*/g, " ") : text;
  t = t.trim();
  if (!t) return "";
  const prev = before.slice(-1);
  const startsWithPunct = /^[,.;:!?)\]}'’"]/.test(t);
  if (before.length === 0 || /[.!?]\s*$/.test(before) || /\n\s*$/.test(before)) {
    t = t.charAt(0).toUpperCase() + t.slice(1);
  }
  if (before.length > 0 && prev && !/\s/.test(prev) && !startsWithPunct && !/[([{"'“‘]/.test(prev)) t = " " + t;
  const next = after.charAt(0);
  if (next && !/\s/.test(next) && !/^[,.;:!?)\]}]/.test(next)) t = t + " ";
  return t;
}

export interface InsertRecord {
  el: DictationTarget;
  /** the whole field before the dictation landed */
  previous: string;
  /** where the inserted text sits now */
  start: number;
  end: number;
  inserted: string;
  /** whether the browser's native undo stack holds the insertion */
  native: boolean;
}

function setNativeValue(el: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
  if (setter) setter.call(el, value);
  else el.value = value;
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

function tryExecInsert(el: DictationTarget, text: string): boolean {
  try {
    const doc = el.ownerDocument;
    if (typeof doc.execCommand !== "function") return false;
    const before = fieldValue(el);
    const ok = doc.execCommand("insertText", false, text);
    return !!ok && fieldValue(el) !== before;
  } catch {
    return false;
  }
}

/**
 * Insert `text` into `el` at `sel` (the selection captured when dictation
 * started — focus may have moved to the HUD since). Returns what changed so
 * the caller can undo or replace it (clean-up pass).
 */
export function insertAt(el: DictationTarget, raw: string, sel?: Selection): InsertRecord | null {
  const previous = fieldValue(el);
  if (!isFormField(el)) {
    // contenteditable: insert at the live caret.
    el.focus();
    const t = raw.trim();
    if (!t) return null;
    const native = tryExecInsert(el, t);
    if (!native) el.textContent = (el.textContent || "") + t;
    return { el, previous, start: -1, end: -1, inserted: t, native };
  }
  const len = previous.length;
  const s = Math.max(0, Math.min(sel?.start ?? el.selectionStart ?? len, len));
  const e = Math.max(s, Math.min(sel?.end ?? el.selectionEnd ?? s, len));
  const text = shapeInsertion(previous.slice(0, s), previous.slice(e), raw, isSingleLine(el));
  if (!text) return null;
  el.focus();
  try {
    el.setSelectionRange(s, e);
  } catch {
    /* type=search in some engines */
  }
  let native = tryExecInsert(el, text);
  if (!native) {
    setNativeValue(el, previous.slice(0, s) + text + previous.slice(e));
    native = false;
  }
  const caret = s + text.length;
  try {
    el.setSelectionRange(caret, caret);
  } catch {
    /* ignore */
  }
  return { el, previous, start: s, end: caret, inserted: text, native };
}

/** Swap the inserted span for `next` (the cleaned-up text). Native undo then
 *  steps back to the raw words, a second undo to the original field. */
export function replaceInserted(rec: InsertRecord, next: string): InsertRecord | null {
  const el = rec.el;
  if (!isFormField(el)) return null;
  const cur = el.value;
  if (cur.slice(rec.start, rec.end) !== rec.inserted) return null; // the user edited it: leave it alone
  const lead = rec.inserted.match(/^\s*/)?.[0] ?? "";
  const trail = rec.inserted.match(/\s*$/)?.[0] ?? "";
  const body = isSingleLine(el) ? next.replace(/\s*\n+\s*/g, " ").trim() : next.trim();
  const text = lead + body + trail;
  el.focus();
  try {
    el.setSelectionRange(rec.start, rec.end);
  } catch {
    /* ignore */
  }
  let native = tryExecInsert(el, text);
  if (!native) setNativeValue(el, cur.slice(0, rec.start) + text + cur.slice(rec.end));
  const caret = rec.start + text.length;
  try {
    el.setSelectionRange(caret, caret);
  } catch {
    /* ignore */
  }
  native = native && rec.native;
  return { ...rec, start: rec.start, end: caret, inserted: text, native };
}

/** Restore the field to exactly what it held before the dictation. */
export function undoInsert(rec: InsertRecord): void {
  const el = rec.el;
  if (!isFormField(el)) {
    el.textContent = rec.previous;
    return;
  }
  el.focus();
  try {
    el.setSelectionRange(0, el.value.length);
  } catch {
    /* ignore */
  }
  if (!tryExecInsert(el, rec.previous) || el.value !== rec.previous) {
    if (el.value !== rec.previous) setNativeValue(el, rec.previous);
  }
  const caret = Math.min(rec.start, rec.previous.length);
  try {
    el.setSelectionRange(caret, caret);
  } catch {
    /* ignore */
  }
}
