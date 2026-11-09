// DOM -> flat idb-shaped node list (same keys `idb ui describe-all --json` emits), so the
// Python side reuses `tree.parse_tree`. Evaluated as an expression via `page.evaluate`.
// Adapted from `sessions/web_extractor.js` (orcha_cli/qa/device/web.py loads it).
(() => {
  // Full-page mode (`WebSession.full_page_tree`): the whole page,
  // not just the viewport, with unclipped frames. Off by default: the agent's screen is the
  // viewport.
  const FULL = globalThis.__orchaFullPage === true;
  const MAX_NODES = FULL ? 2000 : 400;
  const MAX_TEXT = 120;
  const vw = window.innerWidth;
  const vh = window.innerHeight;

  const ROLE_TYPES = {
    button: "Button",
    link: "Link",
    textbox: "TextField",
    searchbox: "SearchField",
    checkbox: "Switch",
    switch: "Switch",
    radio: "Radio",
    tab: "Tab",
    menuitem: "MenuItem",
    heading: "Heading",
    img: "Image",
    row: "Cell",
    listitem: "Cell",
    combobox: "Picker",
    listbox: "Picker",
    dialog: "Dialog",
  };
  // Types the browser names from what they show (accname "name from content"): their text wins
  // over a `title` tooltip, which names them only when they show none (an icon-only button).
  // Rows and list items (`Cell`), fields, pickers, images and dialogs name from attributes,
  // `title` included, as Chromium does.
  const NAME_FROM_CONTENT = new Set(["Button", "Link", "Tab", "MenuItem", "Heading", "Radio", "Switch", "StaticText"]);
  const BUTTON_INPUTS = new Set(["button", "submit", "reset", "image"]);
  const NON_TEXT_INPUTS = new Set(["hidden", "checkbox", "radio", "file", "range", "color"]);
  const PHRASING_TAGS = /^(SPAN|B|STRONG|EM|I|SMALL|CODE|TIME|ABBR|MARK|S|U|SUB|SUP|KBD|DATA|Q|CITE|VAR|SAMP|BDI)$/;
  const TEXT_CONTAINERS = new Set(["LABEL", "P", "SPAN", "DIV", "TD", "TH", "LEGEND", "SUMMARY", "DT", "DD", "FIGCAPTION", "CAPTION", "STRONG", "EM", "B", "I", "SMALL"]);
  const INTERACTIVE_SELECTOR =
    "a[href],button,input,select,textarea,[contenteditable=true],[role=button],[role=link]," +
    "[role=textbox],[role=searchbox],[role=checkbox],[role=switch],[role=radio],[role=tab]," +
    "[role=menuitem],[role=combobox],[role=listbox],[tabindex]";

  const collapse = (s) => (s || "").replace(/\s+/g, " ").trim();
  const clip = (s) => (s.length > MAX_TEXT ? s.slice(0, MAX_TEXT) : s);

  function ownText(el) {
    let out = "";
    for (const n of el.childNodes) {
      if (n.nodeType === Node.TEXT_NODE) out += n.textContent + " ";
    }
    return clip(collapse(out));
  }

  // A text element's own text plus the text of its inline descendants (`Total: <span>$5.40</span>`,
  // `<strong>Order</strong> placed`): one sentence on screen is one StaticText. Block children
  // stop the walk; they become nodes of their own. A flex or grid container blockifies its
  // children, so in one with text of its own (the chip `Seen <span>2</span> times`) its in-flow
  // phrasing children still belong to its line (not an absolutely placed `sr-only` span); a
  // flex row of separate spans stays separate nodes.
  function phrasingText(el) {
    let out = "";
    const flexLine = /flex|grid/.test(getComputedStyle(el).display || "") && !!ownText(el);
    for (const n of el.childNodes) {
      if (n.nodeType === Node.TEXT_NODE) {
        out += n.textContent + " ";
      } else if (n instanceof Element && !isHidden(n) && !n.matches(INTERACTIVE_SELECTOR)) {
        const cs = getComputedStyle(n);
        const display = cs.display || "";
        const inFlow = cs.position !== "absolute" && cs.position !== "fixed";
        const inline = display.startsWith("inline") || (flexLine && inFlow && PHRASING_TAGS.test(n.tagName));
        if (inline && !/^(svg|img|input|select|textarea|button)$/i.test(n.tagName)) {
          out += phrasingText(n) + " ";
        }
      }
    }
    return clip(collapse(out));
  }

  function visibleText(el) {
    const t = el.innerText != null ? el.innerText : el.textContent;
    return clip(collapse(t));
  }

  // The text a control shows, as the browser names it from content: its rendered text without
  // what is hidden from assistive tech (an `aria-hidden` icon or initials avatar beside the name).
  function shownText(el) {
    if (!el.querySelector('[aria-hidden="true"]')) return visibleText(el);
    let out = "";
    const add = (node) => {
      for (const n of node.childNodes) {
        if (n.nodeType === Node.TEXT_NODE) {
          out += n.textContent;
        } else if (n instanceof Element && !isHidden(n)) {
          const block = !(getComputedStyle(n).display || "").startsWith("inline");
          if (block || n.tagName === "BR") out += " ";
          add(n);
          if (block) out += " ";
        }
      }
    };
    add(el);
    return clip(collapse(out));
  }

  // The part of `el` its scrolling and clipping ancestors let through (#249): a chip scrolled out
  // of an `overflow-x: auto` row, or a tab the strip scrolled away, is not on screen even when
  // its own box is inside the viewport. Each ancestor whose overflow is not `visible` clips to its
  // padding box, on the axes it clips; a fixed element escapes them all, an absolute one escapes
  // the static ancestors between it and its containing block. Full-page mode only applies the
  // clips nobody can scroll past (`hidden`, `clip`): content a scroller holds is still on the page.
  const clipCache = new Map();
  function clipStyle(a) {
    let c = clipCache.get(a);
    if (!c) {
      const cs = getComputedStyle(a);
      c = { position: cs.position, contains: cs.transform !== "none" || cs.filter !== "none" || /paint|layout|strict|content/.test(cs.contain || ""), ox: cs.overflowX, oy: cs.overflowY };
      clipCache.set(a, c);
    }
    return c;
  }
  const clips = (o) => (FULL ? o === "hidden" || o === "clip" : o !== "visible");
  function visibleRect(el) {
    const r = el.getBoundingClientRect();
    let left = r.left, top = r.top, right = r.right, bottom = r.bottom;
    let position = clipStyle(el).position;
    for (let a = el.parentElement; a && a !== document.body && a !== document.documentElement; a = a.parentElement) {
      const c = clipStyle(a);
      if (position === "fixed" && !c.contains) continue;
      if (position === "absolute" && c.position === "static" && !c.contains) continue;
      if (clips(c.ox) || clips(c.oy)) {
        if (!c.box) {
          const ar = a.getBoundingClientRect();
          const x = ar.left + a.clientLeft, y = ar.top + a.clientTop;
          c.box = { x, y, right: x + a.clientWidth, bottom: y + a.clientHeight };
        }
        if (clips(c.ox)) { left = Math.max(left, c.box.x); right = Math.min(right, c.box.right); }
        if (clips(c.oy)) { top = Math.max(top, c.box.y); bottom = Math.min(bottom, c.box.bottom); }
      }
      position = c.position;
    }
    return { left, top, right, bottom, width: right - left, height: bottom - top };
  }

  function isVisible(el) {
    if (typeof el.checkVisibility === "function") {
      if (!el.checkVisibility({ visibilityProperty: true, opacityProperty: true })) return false;
    } else {
      const cs = getComputedStyle(el);
      if (cs.display === "none" || cs.visibility === "hidden" || cs.opacity === "0") return false;
    }
    const own = el.getBoundingClientRect();
    if (own.width <= 0 || own.height <= 0) return false;
    // Less than a pixel left once its scrollers clip it: hidden (a chip scrolled out of its row).
    const r = visibleRect(el);
    if (r.width < 1 || r.height < 1) return false;
    if (FULL) return true;
    return r.right > 0 && r.bottom > 0 && r.left < vw && r.top < vh;
  }

  function isHidden(el) {
    // display:none / visibility:hidden / hidden attr / aria-hidden. Subtree is skipped.
    if (el.hidden || el.getAttribute("aria-hidden") === "true") return true;
    const tag = el.tagName;
    if (tag === "SCRIPT" || tag === "STYLE" || tag === "NOSCRIPT" || tag === "TEMPLATE" || tag === "HEAD") return true;
    if (tag === "INPUT" && el.type === "hidden") return true;
    const cs = getComputedStyle(el);
    if (cs.display === "none" || cs.visibility === "hidden") return true;
    return false;
  }

  function typeOf(el) {
    const role = (el.getAttribute("role") || "").toLowerCase();
    if (role && ROLE_TYPES[role]) return ROLE_TYPES[role];
    const tag = el.tagName;
    if (tag === "BUTTON") return "Button";
    if (tag === "INPUT") {
      const t = (el.type || "text").toLowerCase();
      if (BUTTON_INPUTS.has(t)) return "Button";
      if (t === "password") return "SecureTextField";
      if (t === "search") return "SearchField";
      if (t === "checkbox") return "Switch";
      if (t === "radio") return "Radio";
      if (NON_TEXT_INPUTS.has(t)) return null;
      return "TextField";
    }
    if (tag === "TEXTAREA") return "TextView";
    if (tag === "A") return el.hasAttribute("href") ? "Link" : null;
    if (tag === "SELECT") return "Picker";
    if (/^H[1-6]$/.test(tag)) return "Heading";
    if (tag === "IMG") return "Image";
    if (tag === "SVG" || tag === "svg") return el.hasAttribute("aria-label") ? "Image" : null;
    if (tag === "TR" || tag === "LI") return "Cell";
    if (tag === "SUMMARY") return "Button";
    if (el.isContentEditable && el.getAttribute("contenteditable") !== null) return "TextView";
    if (TEXT_CONTAINERS.has(tag)) {
      if (el.querySelector(INTERACTIVE_SELECTOR)) return null;
      // A <label for=...> already names its control; don't repeat it as StaticText.
      if (tag === "LABEL" && el.control) return null;
      return phrasingText(el) ? "StaticText" : null;
    }
    return null;
  }

  function labelledByText(el) {
    const ids = (el.getAttribute("aria-labelledby") || "").split(/\s+/).filter(Boolean);
    const parts = [];
    for (const id of ids) {
      const t = document.getElementById(id);
      if (t) parts.push(visibleText(t));
    }
    return collapse(parts.join(" "));
  }

  function formLabelText(el) {
    if (!(el instanceof HTMLInputElement || el instanceof HTMLSelectElement || el instanceof HTMLTextAreaElement)) return "";
    const labels = el.labels;
    if (labels && labels.length) {
      for (const l of labels) {
        // Text of the label minus the control's own text (wrapping labels).
        const t = collapse(l.innerText != null ? l.innerText : l.textContent);
        if (t) return clip(t);
      }
    }
    return "";
  }

  // The accessible name, in accname order: `aria-labelledby`, `aria-label`, the native label (a
  // form label, placeholder, `alt`, a button input's value), the shown text of a type named from
  // content, and `title` last. A tab `<button title="Issues a run raised">Needs review
  // <span>1</span></button>` is "Needs review 1", as Chromium names it, not its tooltip.
  function labelOf(el, type) {
    const by = labelledByText(el);
    if (by) return clip(by);
    const aria = collapse(el.getAttribute("aria-label"));
    if (aria) return clip(aria);
    const form = formLabelText(el);
    if (form) return form;
    const ph = collapse(el.getAttribute("placeholder"));
    if (ph) return clip(ph);
    const alt = collapse(el.getAttribute("alt"));
    if (alt) return clip(alt);
    const field = el.tagName === "INPUT" || el.tagName === "SELECT" || el.tagName === "TEXTAREA";
    if (field && BUTTON_INPUTS.has((el.type || "").toLowerCase())) {
      const value = clip(collapse(el.value));
      if (value) return value;
    }
    const fromContent = !field && NAME_FROM_CONTENT.has(type);
    if (fromContent) {
      const shown = type === "StaticText" ? phrasingText(el) : shownText(el);
      if (shown) return shown;
    }
    const title = collapse(el.getAttribute("title"));
    if (title) return clip(title);
    // A field shows no text of its own; a type named from attributes (a row, a dialog) falls
    // back to the text it holds.
    return field || fromContent ? "" : visibleText(el);
  }

  function valueOf(el, type) {
    const tag = el.tagName;
    if (tag === "INPUT") {
      const t = (el.type || "text").toLowerCase();
      if (t === "checkbox" || t === "radio") return el.checked ? "on" : "off";
      if (t === "password") return el.value ? "•".repeat(el.value.length) : "";
      if (BUTTON_INPUTS.has(t)) return "";
      return el.value == null ? "" : String(el.value);
    }
    if (tag === "TEXTAREA") return el.value == null ? "" : String(el.value);
    if (tag === "SELECT") {
      const o = el.selectedOptions && el.selectedOptions[0];
      return o ? collapse(o.textContent) : "";
    }
    if (el.isContentEditable && el.getAttribute("contenteditable") !== null) return clip(collapse(el.textContent));
    const role = (el.getAttribute("role") || "").toLowerCase();
    if (role === "checkbox" || role === "switch" || role === "radio") {
      return el.getAttribute("aria-checked") === "true" ? "on" : "off";
    }
    const now = el.getAttribute("aria-valuenow");
    if (now != null) return String(now);
    return "";
  }

  function isChecked(el) {
    if (el.tagName === "INPUT" && (el.type === "checkbox" || el.type === "radio")) return !!el.checked;
    return el.getAttribute("aria-checked") === "true";
  }

  function idOf(el) {
    return el.getAttribute("data-testid") || el.id || el.getAttribute("name") || "";
  }

  function frameOf(el) {
    // The visible part only: a tab half scrolled out of its strip is tapped on what shows.
    const r = visibleRect(el);
    if (FULL) {
      return { x: Math.round(r.left), y: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) };
    }
    const x1 = Math.max(0, Math.round(r.left));
    const y1 = Math.max(0, Math.round(r.top));
    const x2 = Math.min(vw, Math.round(r.right));
    const y2 = Math.min(vh, Math.round(r.bottom));
    return { x: x1, y: y1, width: Math.max(0, x2 - x1), height: Math.max(0, y2 - y1) };
  }

  // Bounds of `el`'s own text nodes (not its children's), clipped to the viewport; null when
  // none of it is on screen.
  function ownTextFrame(el) {
    let l = Infinity, t = Infinity, r = -Infinity, b = -Infinity;
    for (const n of el.childNodes) {
      if (n.nodeType !== Node.TEXT_NODE || !collapse(n.textContent)) continue;
      const range = document.createRange();
      range.selectNodeContents(n);
      const box = range.getBoundingClientRect();
      if (box.width <= 0 || box.height <= 0) continue;
      l = Math.min(l, box.left); t = Math.min(t, box.top); r = Math.max(r, box.right); b = Math.max(b, box.bottom);
    }
    if (r <= l || b <= t) return null;
    // Clipped like the element holding it: text scrolled out of its row is not on screen.
    const box = visibleRect(el);
    l = Math.max(l, box.left); t = Math.max(t, box.top); r = Math.min(r, box.right); b = Math.min(b, box.bottom);
    if (r - l < 1 || b - t < 1) return null;
    if (FULL) return { x: Math.round(l), y: Math.round(t), width: Math.round(r - l), height: Math.round(b - t) };
    if (r <= 0 || b <= 0 || l >= vw || t >= vh) return null;
    const x1 = Math.max(0, Math.round(l));
    const y1 = Math.max(0, Math.round(t));
    return { x: x1, y: y1, width: Math.min(vw, Math.round(r)) - x1, height: Math.min(vh, Math.round(b)) - y1 };
  }

  const modal = document.querySelector("dialog[open], [aria-modal=true]");

  function enabledOf(el) {
    if (el.disabled === true) return false;
    if (el.getAttribute("aria-disabled") === "true") return false;
    if (el.closest("fieldset:disabled")) return false;
    if (modal && !modal.contains(el)) return false;
    return true;
  }

  function traitsOf(el) {
    const t = [];
    if (el.getAttribute("aria-selected") === "true" || el.hasAttribute("aria-current") || isChecked(el)) {
      t.push("Selected");
    }
    if (document.activeElement === el) t.push("Focused");
    // A field that takes a secret even when it does not read as `type=password` (a password
    // shown by a reveal toggle, a one-time code): the recorder masks what is typed into it.
    const ac = (el.getAttribute("autocomplete") || "").toLowerCase();
    if (/(^|\s)(current-password|new-password|one-time-code)(\s|$)/.test(ac)) t.push("Secure");
    return t;
  }

  const nodes = [
    {
      type: "Application",
      AXLabel: document.title || "",
      AXValue: "",
      AXUniqueId: "",
      frame: { x: 0, y: 0, width: vw, height: vh },
      enabled: true,
      traits: [],
      pid: null,
    },
  ];

  function walk(el) {
    if (nodes.length >= MAX_NODES) return;
    if (!(el instanceof Element)) return;
    if (isHidden(el)) return;
    const type = typeOf(el);
    if (type && isVisible(el)) {
      nodes.push({
        type,
        AXLabel: labelOf(el, type),
        AXValue: valueOf(el, type),
        AXUniqueId: idOf(el),
        frame: frameOf(el),
        enabled: enabledOf(el),
        traits: traitsOf(el),
        pid: null,
      });
    } else if (!type && el.tagName !== "LABEL") {
      // Text sitting beside a control in the same container (`<div><b>Blue mug</b> · $12
      // <a>View</a></div>`): the container is not a StaticText, because it holds a control,
      // and its own text nodes belong to no child, so without this the price is simply not on
      // the screen the agent reads. Separators alone ("·", "|") are skipped.
      const own = ownText(el);
      const frame = /[\p{L}\p{N}]/u.test(own) ? ownTextFrame(el) : null;
      if (frame) {
        nodes.push({ type: "StaticText", AXLabel: own, AXValue: "", AXUniqueId: "", frame, enabled: true, traits: [], pid: null });
      }
    }
    // Leaf-ish controls: don't descend (their text is already the label).
    const tag = el.tagName;
    if (tag === "SELECT" || tag === "INPUT" || tag === "TEXTAREA" || tag === "BUTTON" || tag === "SVG" || tag === "svg") return;
    if (type === "StaticText" || type === "Heading") return;
    for (const child of el.children) {
      if (nodes.length >= MAX_NODES) return;
      walk(child);
    }
  }

  if (document.body) walk(document.body);
  return nodes;
})()
