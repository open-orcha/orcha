/**
 * The motion between a card and its screen's details (atlas-board.tsx, screen-detail.tsx;
 * docs/screen-atlas.md "Opening a screen"). Transform and opacity only, with the Web Animations
 * API, so it stays on the compositor (60fps in Chromium and WebKit) and never blocks a click:
 *
 * - **Open**: the card's frames lift off and fly into the panel's stage (the card's own frame
 *   crossfading into the panel's larger, crisp one on the way) while the panel slides in from the
 *   window's edge on a spring and the page dims.
 * - **Close** (Escape, the close button, a click outside): the real panel closes at once, so the
 *   page is usable again and focus is back on its card, while a still copy of it slides out and
 *   its frames fly back down into the card they came from.
 * - **Full window and back**: the frames fly from their old place and size to the new ones, the
 *   panel's edge travels (widening: the panel slides out to the left; narrowing: the surface it
 *   leaves shrinks back to the panel's edge), the title travels with it and the rest crossfades.
 * - **Another screen while open**: the old content crossfades into the new; the panel stays.
 *
 * Everything that flies is a still copy (no ids, no `data-atlas-*`, inert) in one layer above the
 * dialog: a manual popover, so it is in the top layer, `pointer-events: none`. The real frames
 * are hidden while their copies fly and shown in the same frame the copies go. A new motion first
 * ends the running one at its last frame (`settle`), so a quick second click starts from where
 * things are. Reduced motion: fades only. Without the Web Animations API it changes at once;
 * without popovers, the panel still slides and fades but nothing flies.
 */
import type { Platform } from "./types";

/** Durations (ms): calm and fast. */
export const OPEN_MS = 480;
export const CLOSE_MS = 340;
export const RESIZE_MS = 460;
export const SWITCH_MS = 240;
export const FADE_MS = 160;
/** Narrowing to the side: how long the old content takes to give way before the surface moves. */
const GIVE_WAY_MS = 110;
/** Of a flight, the share in which the card's own frame hands over to the panel's. */
const HANDOVER = 0.32;

/** `--ease-rise`, where a spring cannot be written. */
const EASE_RISE = "cubic-bezier(0.2, 0.7, 0.2, 1)";
/** Leaving: starts gently and accelerates out, then eases as it goes. */
const EASE_LEAVE = "cubic-bezier(0.4, 0, 0.2, 1)";

/**
 * A spring released from rest, as a CSS `linear()` easing: `1 - e^(-zwt)(cos(w't) + zw/w' sin(w't))`
 * over the animation's duration. Damping 0.9 settles without a visible bounce (under 0.2%), and
 * the stiffness is chosen so it has settled by the end (no last-frame step).
 */
export function springEasing(damping = 0.9, stiffness = 7.8, steps = 40): string {
  const wd = stiffness * Math.sqrt(1 - damping * damping);
  const zw = damping * stiffness;
  const out: string[] = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const y = i === steps ? 1 : 1 - Math.exp(-zw * t) * (Math.cos(wd * t) + (zw / wd) * Math.sin(wd * t));
    out.push(String(Math.round(y * 10000) / 10000));
  }
  return `linear(${out.join(", ")})`;
}

let springCache: string | null = null;
function spring(): string {
  if (springCache === null) {
    const ok = typeof CSS !== "undefined" && typeof CSS.supports === "function" && CSS.supports("animation-timing-function", "linear(0, 1)");
    springCache = ok ? springEasing() : EASE_RISE;
  }
  return springCache;
}

function reduced(): boolean {
  return typeof window !== "undefined" && (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false);
}

function canAnimate(): boolean {
  return typeof document !== "undefined" && typeof Element !== "undefined" && typeof Element.prototype.animate === "function";
}

/** Each platform's frame inside `root` (a card, or the detail panel). */
export function framesIn(root: ParentNode | null | undefined): Map<Platform, HTMLElement> {
  const out = new Map<Platform, HTMLElement>();
  for (const el of root?.querySelectorAll<HTMLElement>("[data-atlas-frame][data-platform]") ?? []) {
    const p = el.getAttribute("data-platform") as Platform;
    if (!out.has(p)) out.set(p, el);
  }
  return out;
}

/** A card at least partly in the window: flying back to one scrolled away would leave the screen. */
export function onScreen(el: Element | null): el is HTMLElement {
  if (!el) return false;
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.bottom > 0 && r.right > 0 && r.top < window.innerHeight && r.left < window.innerWidth;
}

const cardOf = (id: string | null | undefined) => (id ? document.querySelector<HTMLElement>(`[data-atlas-card="${CSS.escape(id)}"]`) : null);
const panelOf = (id: string | null | undefined) => (id ? document.querySelector<HTMLElement>(`[data-atlas-detail="${CSS.escape(id)}"]`) : null);

// ---------- the running motion ----------

interface Motion {
  anims: Animation[];
  done: (() => void)[];
  ended: boolean;
}

let current: Motion | null = null;

/** Ends the running motion at its last frame and tidies up, so the next one starts from rest. */
export function settle(): void {
  const m = current;
  if (!m) return;
  current = null;
  for (const a of m.anims) {
    try {
      a.finish();
    } catch {
      a.cancel();
    }
  }
  end(m);
}

/** Whether a motion is running (for tests and for the board's own effects). */
export function moving(): boolean {
  return current !== null;
}

function begin(): Motion {
  settle();
  const m: Motion = { anims: [], done: [], ended: false };
  current = m;
  return m;
}

function end(m: Motion): void {
  if (m.ended) return;
  m.ended = true;
  for (const f of m.done.splice(0)) {
    try {
      f();
    } catch {
      // a node removed meanwhile: nothing to tidy
    }
  }
  if (current === m) current = null;
  quietLayer();
}

/** Ends `m` once every animation has run (or been cancelled). */
function finish(m: Motion): void {
  void Promise.all(m.anims.map((a) => a.finished.catch(() => undefined))).then(() => end(m));
}

/** An animation on a copy in the flight layer (removed with it). */
function play(m: Motion, el: Element, frames: Keyframe[], options: KeyframeAnimationOptions): Animation {
  const a = el.animate(frames, { fill: "both", ...options });
  m.anims.push(a);
  return a;
}

/** An animation on a real element of the page: its effect goes when the motion ends, where the
 * element's own style already matches the last keyframe. */
function real(m: Motion, el: Element, frames: Keyframe[], options: KeyframeAnimationOptions): Animation {
  const a = play(m, el, frames, options);
  m.done.push(() => a.cancel());
  return a;
}

/** Hides a real element while its copy flies; shown again in the frame the copy goes. */
function hide(m: Motion, el: HTMLElement): void {
  const was = el.style.visibility;
  el.style.visibility = "hidden";
  m.done.push(() => {
    el.style.visibility = was;
  });
}

// ---------- the flight layer ----------

const LAYER = "data-atlas-flight";

function supportsPopover(): boolean {
  return typeof HTMLElement !== "undefined" && typeof HTMLElement.prototype.showPopover === "function";
}

function isShown(el: HTMLElement): boolean {
  try {
    return el.matches(":popover-open");
  } catch {
    return false;
  }
}

/**
 * The layer the copies fly in: one inert, click-through manual popover, shown again for each motion
 * so it is the topmost of the top layer (above a modal dialog opened since). It takes the atlas's
 * own colours (`--atlas-*`, set on the board, not the body: a device's bezel, its rim) from `from`,
 * so a copy looks exactly like what it copies. Null without popovers.
 */
function layer(from?: Element | null): HTMLElement | null {
  if (!supportsPopover()) return null;
  let el = document.querySelector<HTMLElement>(`[${LAYER}]`);
  if (!el) {
    el = document.createElement("div");
    el.setAttribute(LAYER, "");
    el.className = "qa-port";
    el.setAttribute("aria-hidden", "true");
    el.inert = true;
    el.popover = "manual";
    Object.assign(el.style, {
      position: "fixed",
      inset: "0",
      width: "100vw",
      height: "100dvh",
      maxWidth: "none",
      maxHeight: "none",
      margin: "0",
      padding: "0",
      border: "0",
      background: "transparent",
      overflow: "visible",
      pointerEvents: "none",
      color: "inherit",
    });
    document.body.append(el);
  }
  if (from) {
    const cs = getComputedStyle(from);
    for (let i = 0; i < cs.length; i++) {
      const name = cs[i];
      if (name.startsWith("--atlas")) el.style.setProperty(name, cs.getPropertyValue(name));
    }
  }
  try {
    if (isShown(el)) el.hidePopover();
    el.showPopover();
  } catch {
    return null;
  }
  return el;
}

function quietLayer(): void {
  const el = typeof document === "undefined" ? null : document.querySelector<HTMLElement>(`[${LAYER}]`);
  if (!el || el.childElementCount) return;
  try {
    if (isShown(el)) el.hidePopover();
  } catch {
    // already gone
  }
}

/** Puts a copy at `r`, the window's coordinates, its transforms measured from its top left. */
function place(el: HTMLElement, r: DOMRect): HTMLElement {
  Object.assign(el.style, {
    position: "fixed",
    left: `${r.left}px`,
    top: `${r.top}px`,
    width: `${r.width}px`,
    height: `${r.height}px`,
    margin: "0",
    maxWidth: "none",
    maxHeight: "none",
    boxSizing: "border-box",
    transformOrigin: "0 0",
    transform: "none",
    visibility: "visible",
  });
  return el;
}

/**
 * A still copy of `el` to fly: no ids, no `data-atlas-*` (nothing finds it as the real thing), no
 * ARIA, its images loaded at once. With `noFrames`, its device frames are hidden (they fly apart).
 */
export function still(el: Element, noFrames = false): HTMLElement {
  const copy = el.cloneNode(true) as HTMLElement;
  if (noFrames) for (const f of copy.querySelectorAll<HTMLElement>("[data-atlas-frame]")) f.style.visibility = "hidden";
  for (const n of [copy, ...copy.querySelectorAll<HTMLElement>("*")]) {
    for (const a of [...n.attributes]) {
      if (a.name === "id" || a.name === "tabindex" || a.name === "for" || a.name.startsWith("aria-") || a.name.startsWith("data-atlas") || a.name.startsWith("data-dialog")) n.removeAttribute(a.name);
    }
    // Already in the page, so loaded; decoded off the main thread (a frame the copy needs at a new
    // size fades in over the first third of its flight anyway).
    if (n instanceof HTMLImageElement) n.loading = "eager";
  }
  return copy;
}

/** A copy of the dialog's panel as it looks now, scrolled where it is; with `noHead`, its title
 * block hidden (the title flies on its own). */
function sheetCopy(dialog: HTMLElement, box: DOMRect, noFrames: boolean, noHead = false): HTMLElement {
  const cs = getComputedStyle(dialog);
  const sheet = document.createElement("div");
  sheet.className = dialog.className;
  place(sheet, box);
  Object.assign(sheet.style, {
    display: "block",
    overflow: "hidden",
    background: cs.backgroundColor,
    color: cs.color,
    borderLeft: `${cs.borderLeftWidth} ${cs.borderLeftStyle} ${cs.borderLeftColor}`,
    borderTop: "0",
    borderRight: "0",
    borderBottom: "0",
    borderRadius: cs.borderRadius,
    boxShadow: cs.boxShadow,
  });
  for (const child of dialog.children) sheet.append(still(child, noFrames));
  const head = noHead ? sheet.querySelector<HTMLElement>("h2")?.parentElement : null;
  if (head) head.style.visibility = "hidden";
  return sheet;
}

/** Where `root`'s subtree is scrolled: each scrolled element by its place in it. Measured when a
 * copy is made, so a change that follows (another screen, the full window) cannot move it. */
type Scrolls = [index: number, top: number, left: number][];
function scrollsOf(root: Element): Scrolls {
  const out: Scrolls = [];
  root.querySelectorAll("*").forEach((el, i) => {
    if (el.scrollTop || el.scrollLeft) out.push([i, el.scrollTop, el.scrollLeft]);
  });
  return out;
}

/** Scrolls a copy (in the page now, so it can scroll) where its original was. */
function scrollLike(copy: Element, scrolls: Scrolls): void {
  if (!scrolls.length) return;
  const all = copy.querySelectorAll("*");
  for (const [i, top, left] of scrolls) {
    const el = all[i];
    if (!el) continue;
    el.scrollTop = top;
    el.scrollLeft = left;
  }
}

/** The page's dimming behind the panel, as a plain layer (the real one goes with the dialog). */
function backdropCopy(dialog: HTMLElement): HTMLElement {
  let colour = "";
  try {
    colour = getComputedStyle(dialog, "::backdrop").backgroundColor;
  } catch {
    colour = "";
  }
  const dim = document.createElement("div");
  Object.assign(dim.style, { position: "fixed", inset: "0", background: colour || "rgb(24 25 28 / 0.32)" });
  return dim;
}

/** The transform that puts a box measured at `to` over `from` (top left origin). */
function over(from: DOMRect, to: DOMRect): string {
  const sx = from.width / Math.max(1, to.width);
  const sy = from.height / Math.max(1, to.height);
  return `translate(${from.left - to.left}px, ${from.top - to.top}px) scale(${sx}, ${sy})`;
}

interface Frame {
  el: HTMLElement;
  r: DOMRect;
}

function measure(root: ParentNode | null | undefined): Map<Platform, Frame> {
  const out = new Map<Platform, Frame>();
  for (const [p, el] of framesIn(root)) {
    const r = el.getBoundingClientRect();
    if (r.width > 0 && r.height > 0) out.set(p, { el, r });
  }
  return out;
}

/**
 * One frame's flight from `src` (a copy made while it was there) to the real frame `dst`: the
 * source copy grows toward the destination while fading out over the first third, the
 * destination's own copy (drawn at its full size, so it stays crisp) grows from the source's
 * place while fading in. The real frames are hidden meanwhile.
 */
function fly(m: Motion, lay: HTMLElement, src: { copy: HTMLElement; r: DOMRect; el?: HTMLElement }, dst: Frame, duration: number, easing: string): void {
  const big = place(still(dst.el), dst.r);
  const small = place(src.copy, src.r);
  lay.append(small, big);
  play(m, big, [{ transform: over(src.r, dst.r) }, { transform: "none" }], { duration, easing });
  play(m, big, [{ opacity: 0 }, { opacity: 1 }], { duration: duration * HANDOVER, easing: "linear" });
  play(m, small, [{ transform: "none" }, { transform: over(dst.r, src.r) }], { duration, easing });
  play(m, small, [{ opacity: 1 }, { opacity: 0 }], { duration: duration * HANDOVER, easing: "linear" });
  m.done.push(() => {
    big.remove();
    small.remove();
  });
  hide(m, dst.el);
  if (src.el) hide(m, src.el);
}

// ---------- the motions ----------

/** The panel's dialog and its scrolling body. */
function partsOf(panel: HTMLElement | null) {
  const dialog = panel?.closest("dialog") ?? null;
  const body = panel?.parentElement ?? null;
  return { dialog, body };
}

/**
 * The panel arriving: it slides in from the window's edge on a spring while the page dims, and
 * the frames in `from` (a card's, measured before it opened) fly into its stage. Used by
 * `zoomOpen`, and alone when a screen opens from a link (no card to fly from).
 */
export function enter(id: string, from: Map<Platform, { copy: HTMLElement; r: DOMRect; el: HTMLElement }> = new Map()): void {
  const panel = panelOf(id);
  const { dialog } = partsOf(panel);
  if (!panel || !dialog || !canAnimate()) return;
  // Measured before anything moves: where the frames land.
  const to = measure(panel);
  const m = begin();
  dialog.setAttribute("data-atlas-motion", "in");
  m.done.push(() => dialog.removeAttribute("data-atlas-motion"));
  if (reduced()) {
    real(m, dialog, [{ opacity: 0 }, { opacity: 1 }], { duration: FADE_MS, easing: "ease-out" });
    return finish(m);
  }
  const width = dialog.getBoundingClientRect().width;
  real(m, dialog, [{ transform: `translateX(${width}px)` }, { transform: "none" }], { duration: OPEN_MS, easing: spring() });
  const lay = from.size ? layer(panel) : null;
  if (lay) {
    for (const [p, dst] of to) {
      const src = from.get(p);
      if (src) fly(m, lay, src, dst, OPEN_MS, spring());
    }
  }
  finish(m);
}

/**
 * Opens screen `id`'s details from its card. `open` must flush the React update synchronously
 * (`flushSync`), so the panel is in the page when it returns.
 */
export function zoomOpen(id: string, open: () => void): void {
  settle();
  const card = cardOf(id);
  const from = new Map<Platform, { copy: HTMLElement; r: DOMRect; el: HTMLElement }>();
  if (canAnimate() && onScreen(card)) for (const [p, f] of measure(card)) from.set(p, { copy: still(f.el), r: f.r, el: f.el });
  open();
  enter(id, from);
}

/**
 * Closes screen `id`'s details. The real panel closes at once (the page takes clicks again, and
 * focus goes back to the card); a still copy of it slides out over a fading dim while its frames
 * fly back into the card: the card of the screen shown, else the one it was opened from, when on
 * screen. `close` must flush synchronously.
 */
export function zoomClose(id: string | null, close: () => void, opener: string | null = null): void {
  settle();
  const panel = panelOf(id);
  const { dialog } = partsOf(panel);
  const target = [id, opener].map(cardOf).find((c) => onScreen(c)) ?? null;
  const focusCard = target ?? cardOf(opener) ?? cardOf(id);
  const back = () => focusCard?.focus({ preventScroll: true });
  const lay = panel && dialog && canAnimate() ? layer(panel) : null;
  if (!lay || !dialog || !panel) {
    close();
    back();
    return;
  }
  const m = begin();
  const quiet = reduced();
  const box = dialog.getBoundingClientRect();
  const from = quiet ? new Map<Platform, Frame>() : measure(panel);
  const to = target && !quiet ? measure(target) : new Map<Platform, Frame>();
  const flying = [...from.keys()].filter((p) => to.has(p));
  const dim = backdropCopy(dialog);
  const sheet = sheetCopy(dialog, box, flying.length > 0);
  const scrolls = scrollsOf(dialog);
  // Copies of the panel's frames, made while they are still there.
  const copies = new Map(flying.map((p) => [p, { copy: still(from.get(p)!.el), r: from.get(p)!.r }]));
  lay.append(dim, sheet);
  scrollLike(sheet, scrolls);
  m.done.push(() => {
    dim.remove();
    sheet.remove();
  });
  close();
  back();
  if (quiet) {
    play(m, sheet, [{ opacity: 1 }, { opacity: 0 }], { duration: FADE_MS, easing: "ease-out" });
    play(m, dim, [{ opacity: 1 }, { opacity: 0 }], { duration: FADE_MS, easing: "ease-out" });
    return finish(m);
  }
  play(m, sheet, [{ transform: "none" }, { transform: `translateX(${box.width}px)` }], { duration: CLOSE_MS, easing: EASE_LEAVE });
  play(m, dim, [{ opacity: 1 }, { opacity: 0 }], { duration: CLOSE_MS, easing: "ease-out" });
  for (const p of flying) fly(m, lay, copies.get(p)!, to.get(p)!, CLOSE_MS + 40, spring());
  finish(m);
}

/**
 * Expands or collapses screen `id`'s open details (side panel to full window and back). `update`
 * must flush synchronously and leave the panel at its final size (its stage measured, so nothing
 * re-scales after). The frames and the title fly from where they were to where they are; widening,
 * the panel's edge slides out to the left (its buttons hold still) while the old content gives way
 * to the new; narrowing, the old content first gives way where it stands, then the surface it
 * leaves shrinks back to the panel's edge (so old content never shows over the page as the edge
 * passes).
 */
export function zoomResize(id: string | null, update: () => void): void {
  settle();
  const panel = panelOf(id);
  const { dialog } = partsOf(panel);
  const lay = panel && dialog && canAnimate() ? layer(panel) : null;
  if (!lay || !dialog || !panel) return update();
  const quiet = reduced();
  const box0 = dialog.getBoundingClientRect();
  const head0 = headOf(dialog)?.getBoundingClientRect() ?? null;
  const from = quiet ? new Map<Platform, Frame>() : measure(panel);
  const copies = new Map([...from].map(([p, f]) => [p, { copy: still(f.el), r: f.r }]));
  const old = sheetCopy(dialog, box0, from.size > 0, !quiet && head0 !== null);
  const scrolls = scrollsOf(dialog);
  const m = begin();
  update();
  const panel1 = panelOf(id);
  const { body } = partsOf(panel1);
  const box1 = dialog.getBoundingClientRect();
  const to = quiet ? new Map<Platform, Frame>() : measure(panel1);
  lay.append(old);
  scrollLike(old, scrolls);
  m.done.push(() => old.remove());
  if (quiet) {
    play(m, old, [{ opacity: 1 }, { opacity: 0 }], { duration: FADE_MS, easing: "ease-out" });
    return finish(m);
  }
  const ease = spring();
  const dx = box0.left - box1.left;
  const grow = dx > 0;
  // The title flies on its own, above the old content, from its old place to its new one.
  const head1 = headOf(dialog);
  const r1 = head1?.getBoundingClientRect();
  if (head1 && head0 && r1) {
    const title = place(still(head1), r1);
    lay.append(title);
    m.done.push(() => title.remove());
    play(m, title, [{ transform: `translate(${head0.left - r1.left}px, ${head0.top - r1.top}px)` }, { transform: "none" }], { duration: RESIZE_MS, easing: ease });
    hide(m, head1);
  }
  dialog.setAttribute("data-atlas-motion", grow ? "grow" : "shrink");
  m.done.push(() => dialog.removeAttribute("data-atlas-motion"));
  if (grow) {
    // Its left edge travels out from where it was; its buttons stay where they were.
    real(m, dialog, [{ transform: `translateX(${dx}px)` }, { transform: "none" }], { duration: RESIZE_MS, easing: ease });
    const actions = actionsOf(dialog);
    if (actions) real(m, actions, [{ transform: `translateX(${-dx}px)` }, { transform: "none" }], { duration: RESIZE_MS, easing: ease });
  } else if (dx < 0) {
    // Once the old content has given way, the surface it leaves shrinks back to the new edge, the
    // edge's line travelling with it.
    const cs = getComputedStyle(dialog);
    const ghost = document.createElement("div");
    Object.assign(ghost.style, { position: "fixed", left: `${box0.left}px`, top: `${box0.top}px`, width: `${-dx}px`, height: `${box0.height}px`, background: cs.backgroundColor, transformOrigin: "100% 50%" });
    const edge = document.createElement("div");
    Object.assign(edge.style, { position: "fixed", left: `${box0.left}px`, top: `${box0.top}px`, width: cs.borderLeftWidth || "1px", height: `${box0.height}px`, background: cs.borderLeftColor, boxShadow: cs.boxShadow });
    lay.insertBefore(edge, old);
    lay.insertBefore(ghost, edge);
    m.done.push(() => {
      ghost.remove();
      edge.remove();
    });
    const shrink = { duration: RESIZE_MS - GIVE_WAY_MS, delay: GIVE_WAY_MS, easing: ease };
    play(m, ghost, [{ transform: "none" }, { transform: "scaleX(0)" }], shrink);
    play(m, edge, [{ transform: "none" }, { transform: `translateX(${-dx}px)` }], shrink);
  }
  // The old content gives way to the new, which is laid out where it ends.
  play(m, old, [{ opacity: 1 }, { opacity: 0 }], { duration: grow ? RESIZE_MS * 0.42 : GIVE_WAY_MS, easing: "ease-out" });
  if (body) real(m, body, [{ opacity: 0 }, { opacity: 1 }], { duration: RESIZE_MS * 0.6, delay: RESIZE_MS * 0.14, easing: "ease-out" });
  for (const [p, dst] of to) {
    const src = copies.get(p);
    if (src) fly(m, lay, src, dst, RESIZE_MS, ease);
  }
  finish(m);
}

/**
 * Shows another screen in the open panel: the old content crossfades into the new, the panel holds
 * still, and the new one starts at its top. `update` must flush synchronously.
 */
export function zoomSwitch(id: string | null, update: () => void): void {
  settle();
  const panel = panelOf(id);
  const { dialog, body } = partsOf(panel);
  const lay = panel && dialog && canAnimate() ? layer(panel) : null;
  if (!lay || !dialog) {
    update();
    if (body) body.scrollTop = 0;
    return;
  }
  const box = dialog.getBoundingClientRect();
  const old = sheetCopy(dialog, box, false);
  // Where the old screen was read to: it fades from there, not from its top.
  const scrolls = scrollsOf(dialog);
  const m = begin();
  update();
  if (body) body.scrollTop = 0;
  lay.append(old);
  scrollLike(old, scrolls);
  m.done.push(() => old.remove());
  play(m, old, [{ opacity: 1 }, { opacity: 0 }], { duration: reduced() ? FADE_MS : SWITCH_MS, easing: "ease-out" });
  finish(m);
}

/** The dialog's title block (its heading and the line under it). */
function headOf(dialog: HTMLElement): HTMLElement | null {
  return dialog.querySelector<HTMLElement>("h2")?.parentElement ?? null;
}

/** The dialog's buttons, top right (Expand, Close). */
function actionsOf(dialog: HTMLElement): HTMLElement | null {
  return dialog.querySelector<HTMLElement>("[data-dialog-close]")?.parentElement ?? null;
}
