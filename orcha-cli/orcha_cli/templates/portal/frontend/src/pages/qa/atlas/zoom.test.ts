// @vitest-environment jsdom
/** The motion between a card and its screen (zoom.ts): what flies and what is hidden while it does,
 * that the panel closes at once (the page takes clicks, focus goes back to the card), that every
 * copy and hidden frame is tidied when it ends or is interrupted, fades only under reduced motion,
 * and the plain change where there is no Web Animations API. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { framesIn, moving, settle, springEasing, still, zoomClose, zoomOpen, zoomResize, zoomSwitch } from "./zoom";

type Rect = { left: number; top: number; width: number; height: number };
const rect = (r: Rect) => () => ({ ...r, x: r.left, y: r.top, right: r.left + r.width, bottom: r.top + r.height, toJSON: () => ({}) }) as DOMRect;

function frame(platform: string, id = "") {
  return `<div data-atlas-frame="shot" data-platform="${platform}"${id ? ` id="${id}"` : ""}><img src="/f/${platform}.jpg" alt="" /></div>`;
}

/** A card on screen and its open panel, every frame measured. */
function page() {
  document.body.innerHTML = `
    <button data-atlas-card="screen:cart">${frame("ios")}${frame("android")}</button>
    <dialog data-dialog-placement="side">
      <div class="head"><div><h2 id="t">Cart</h2></div><button data-dialog-close aria-label="Close">x</button></div>
      <div class="body"><div data-atlas-detail="screen:cart"><section id="atlas-why" aria-labelledby="t">${frame("ios", "f1")}${frame("android")}</section></div></div>
    </dialog>`;
  const card = document.querySelector<HTMLElement>("[data-atlas-card]")!;
  const dialog = document.querySelector("dialog")!;
  const panel = document.querySelector<HTMLElement>("[data-atlas-detail]")!;
  card.getBoundingClientRect = rect({ left: 20, top: 100, width: 240, height: 300 });
  dialog.getBoundingClientRect = rect({ left: 680, top: 0, width: 760, height: 900 });
  framesIn(card).forEach((el, p) => (el.getBoundingClientRect = rect({ left: p === "ios" ? 32 : 144, top: 150, width: 104, height: 216 })));
  framesIn(panel).forEach((el, p) => (el.getBoundingClientRect = rect({ left: p === "ios" ? 760 : 980, top: 120, width: 177, height: 367 })));
  return { card, dialog, panel };
}

/** A Web Animations API whose animations end only when told to. */
interface Fake {
  el: Element;
  frames: Keyframe[];
  options: KeyframeAnimationOptions;
  state: "running" | "finished" | "cancelled";
}
let anims: Fake[] = [];
function fakeAnimations() {
  anims = [];
  const proto = Element.prototype as unknown as { animate?: unknown };
  proto.animate = function (this: Element, frames: Keyframe[], options: KeyframeAnimationOptions) {
    let done = () => {};
    const finished = new Promise<void>((r) => (done = r));
    const a: Fake & { finished: Promise<void>; finish(): void; cancel(): void } = {
      el: this,
      frames,
      options,
      state: "running",
      finished,
      finish() {
        if (a.state === "running") a.state = "finished";
        done();
      },
      cancel() {
        a.state = "cancelled";
        done();
      },
    };
    anims.push(a);
    return a;
  };
}
async function endAll() {
  for (const a of anims as unknown as { finish(): void }[]) a.finish();
  await new Promise((r) => setTimeout(r, 0));
}

const layer = () => document.querySelector<HTMLElement>("[data-atlas-flight]");
const hidden = () => [...document.querySelectorAll<HTMLElement>("[data-atlas-frame]")].filter((e) => e.style.visibility === "hidden").length;

let reduced = false;
beforeEach(() => {
  reduced = false;
  vi.stubGlobal("matchMedia", (q: string) => ({ matches: reduced && q.includes("reduce"), addEventListener() {}, removeEventListener() {} }));
  if (!("CSS" in globalThis) || typeof CSS.escape !== "function") vi.stubGlobal("CSS", { escape: (s: string) => s.replace(/["\\]/g, "\\$&"), supports: () => true });
  const hp = HTMLElement.prototype as unknown as { showPopover?: unknown; hidePopover?: unknown };
  hp.showPopover = function (this: HTMLElement) {
    this.dataset.shown = "1";
  };
  hp.hidePopover = function (this: HTMLElement) {
    delete this.dataset.shown;
  };
});
afterEach(() => {
  settle();
  vi.unstubAllGlobals();
  delete (Element.prototype as unknown as { animate?: unknown }).animate;
  const hp = HTMLElement.prototype as unknown as { showPopover?: unknown; hidePopover?: unknown };
  delete hp.showPopover;
  delete hp.hidePopover;
  document.body.innerHTML = "";
});

describe("the spring", () => {
  it("starts at rest, never bounces visibly and has settled by the end", () => {
    const pts = springEasing()
      .slice("linear(".length, -1)
      .split(", ")
      .map(Number);
    expect(pts[0]).toBe(0);
    expect(pts.at(-1)).toBe(1);
    expect(Math.max(...pts)).toBeLessThan(1.003);
    expect(pts.at(-2)!).toBeGreaterThan(0.995);
    expect(pts[Math.round(pts.length * 0.2)]).toBeGreaterThan(0.4); // fast out of the gate
  });
});

describe("still copies", () => {
  it("are never taken for the real thing: no ids, no data-atlas, no ARIA", () => {
    const { panel } = page();
    const copy = still(panel, true);
    expect(copy.querySelector("[id]")).toBeNull();
    expect(copy.querySelector("[data-atlas-frame]")).toBeNull();
    expect(copy.hasAttribute("data-atlas-detail")).toBe(false);
    expect(copy.querySelector("[aria-labelledby]")).toBeNull();
    // Its frames hidden: they fly on their own.
    expect([...copy.querySelectorAll<HTMLElement>("[data-platform]")].every((f) => f.style.visibility === "hidden")).toBe(true);
  });
});

describe("opening from a card", () => {
  it("flies each frame from the card into the panel, the real ones hidden until they land", async () => {
    fakeAnimations();
    const { dialog } = page();
    const open = vi.fn(() => dialog.setAttribute("open", ""));
    zoomOpen("screen:cart", open);
    expect(open).toHaveBeenCalledOnce();
    // Two frames, each a copy from the card and one from the panel; the page's own four hidden.
    expect(layer()!.childElementCount).toBe(4);
    expect(layer()!.dataset.shown).toBe("1");
    expect(hidden()).toBe(4);
    expect(dialog.getAttribute("data-atlas-motion")).toBe("in");
    // The panel slides in from its edge; transform and opacity only.
    const slide = anims.find((a) => a.el === dialog)!;
    expect(slide.frames[0].transform).toBe("translateX(760px)");
    expect(anims.every((a) => Object.keys(a.frames[0]).every((k) => k === "transform" || k === "opacity" || k === "offset"))).toBe(true);
    expect(moving()).toBe(true);
    await endAll();
    expect(layer()!.childElementCount).toBe(0);
    expect(hidden()).toBe(0);
    expect(dialog.hasAttribute("data-atlas-motion")).toBe(false);
    expect(moving()).toBe(false);
  });

  it("opens plainly without the Web Animations API", () => {
    const { dialog } = page();
    const open = vi.fn(() => dialog.setAttribute("open", ""));
    zoomOpen("screen:cart", open);
    expect(open).toHaveBeenCalledOnce();
    expect(layer()).toBeNull();
    expect(hidden()).toBe(0);
  });

  it("only fades under reduced motion", () => {
    fakeAnimations();
    reduced = true;
    const { dialog } = page();
    zoomOpen("screen:cart", () => dialog.setAttribute("open", ""));
    expect(anims).toHaveLength(1);
    expect(anims[0].frames.map((f) => f.opacity)).toEqual([0, 1]);
    expect(hidden()).toBe(0);
  });
});

describe("closing", () => {
  it("closes the real panel at once, focuses the card and flies the frames back into it", async () => {
    fakeAnimations();
    const { card, dialog } = page();
    dialog.setAttribute("open", "");
    const close = vi.fn(() => dialog.removeAttribute("open"));
    zoomClose("screen:cart", close);
    expect(close).toHaveBeenCalledOnce();
    expect(document.activeElement).toBe(card);
    // The dim, a still copy of the panel, and two frames flying back (a copy each way).
    expect(layer()!.childElementCount).toBe(6);
    expect(layer()!.querySelector("[data-atlas-detail], [id]")).toBeNull();
    // The card's frames wait for theirs to land.
    expect([...framesIn(card).values()].every((f) => f.style.visibility === "hidden")).toBe(true);
    await endAll();
    expect(layer()!.childElementCount).toBe(0);
    expect(hidden()).toBe(0);
  });

  it("goes back to the card it was opened from when the shown screen's card is not on screen", () => {
    fakeAnimations();
    const { card, dialog, panel } = page();
    panel.setAttribute("data-atlas-detail", "screen:shipping");
    dialog.setAttribute("open", "");
    zoomClose("screen:shipping", () => dialog.removeAttribute("open"), "screen:cart");
    expect(document.activeElement).toBe(card);
    expect(layer()!.childElementCount).toBe(6);
  });

  it("a new motion ends the running one at its last frame, nothing left behind", () => {
    fakeAnimations();
    const { dialog } = page();
    zoomOpen("screen:cart", () => dialog.setAttribute("open", ""));
    expect(hidden()).toBe(4);
    zoomClose("screen:cart", () => dialog.removeAttribute("open"));
    // The open's copies are gone and its frames shown; only the close's are flying.
    expect(layer()!.childElementCount).toBe(6);
    expect(hidden()).toBe(2); // the card's, waiting for theirs to land
    settle();
    expect(layer()!.childElementCount).toBe(0);
    expect(hidden()).toBe(0);
  });

  it("closes plainly without the API, and still gives focus back", () => {
    const { card, dialog } = page();
    dialog.setAttribute("open", "");
    const close = vi.fn(() => dialog.removeAttribute("open"));
    zoomClose("screen:cart", close);
    expect(close).toHaveBeenCalledOnce();
    expect(document.activeElement).toBe(card);
  });
});

describe("full window and back, and another screen", () => {
  it("expanding flies the frames and the title, the panel's edge travels and its buttons hold still", async () => {
    fakeAnimations();
    const { dialog } = page();
    dialog.setAttribute("open", "");
    const update = vi.fn(() => {
      dialog.getBoundingClientRect = rect({ left: 0, top: 0, width: 1440, height: 900 });
    });
    zoomResize("screen:cart", update);
    expect(update).toHaveBeenCalledOnce();
    expect(dialog.getAttribute("data-atlas-motion")).toBe("grow");
    const slide = anims.find((a) => a.el === dialog)!;
    expect(slide.frames[0].transform).toBe("translateX(680px)");
    const buttons = anims.find((a) => a.el === dialog.querySelector("[data-dialog-close]")!.parentElement)!;
    expect(buttons.frames[0].transform).toBe("translateX(-680px)");
    await endAll();
    expect(layer()!.childElementCount).toBe(0);
    expect(dialog.hasAttribute("data-atlas-motion")).toBe(false);
  });

  it("another screen crossfades in the panel, which stays where it is, from the new one's top", () => {
    fakeAnimations();
    const { dialog } = page();
    dialog.setAttribute("open", "");
    const body = dialog.querySelector<HTMLElement>(".body")!;
    body.scrollTop = 300;
    const update = vi.fn();
    zoomSwitch("screen:cart", update);
    expect(update).toHaveBeenCalledOnce();
    expect(body.scrollTop).toBe(0);
    expect(anims).toHaveLength(1);
    expect(anims[0].frames.map((f) => f.opacity)).toEqual([1, 0]);
    expect(anims.some((a) => a.el === dialog)).toBe(false);
  });

  it("the old screen fades from where it was read to, not from its top", () => {
    fakeAnimations();
    const { dialog } = page();
    dialog.setAttribute("open", "");
    const body = dialog.querySelector<HTMLElement>(".body")!;
    body.scrollTop = 420;
    // The new screen replaces the old one's content, as React does.
    zoomSwitch("screen:cart", () => {
      body.innerHTML = `<div data-atlas-detail="screen:pay"><section>${frame("ios")}<p>Pay</p></section></div>`;
    });
    expect(body.scrollTop).toBe(0);
    const old = layer()!.firstElementChild!;
    expect(old.querySelector<HTMLElement>(".body")!.scrollTop).toBe(420);
  });

  it("full window and back keeps the old content where it was scrolled while it gives way", () => {
    fakeAnimations();
    const { dialog } = page();
    dialog.setAttribute("open", "");
    const body = dialog.querySelector<HTMLElement>(".body")!;
    body.scrollTop = 260;
    zoomResize("screen:cart", () => {
      dialog.getBoundingClientRect = rect({ left: 0, top: 0, width: 1440, height: 900 });
      body.scrollTop = 40; // the wider layout is shorter
    });
    const old = [...layer()!.children].find((c) => c.querySelector(".body"))!;
    expect(old.querySelector<HTMLElement>(".body")!.scrollTop).toBe(260);
  });
});
