// @vitest-environment jsdom
import { act, cleanup, render } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BufferedImage } from "./buffered-image";

// jsdom never loads images: each preload's decode() waits here until the test settles it.
const pending = new Map<string, { resolve: () => void; reject: () => void }>();

class FakeImage {
  src = "";
  naturalWidth = 0;
  naturalHeight = 0;
  complete = false;
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  decode(): Promise<void> {
    return new Promise((resolve, reject) => {
      pending.set(this.src, {
        resolve: () => {
          this.naturalWidth = 400;
          this.naturalHeight = 800;
          this.complete = true;
          resolve();
        },
        // A broken image: loading is over (complete) with nothing decoded, as in a browser.
        reject: () => {
          this.complete = true;
          reject(new Error("broken"));
        },
      });
    });
  }
}

async function settle(url: string, ok = true) {
  await act(async () => {
    const p = pending.get(url);
    if (!p) throw new Error(`no preload for ${url}`);
    if (ok) p.resolve();
    else p.reject();
    await Promise.resolve();
  });
}

const imgs = (container: HTMLElement) => [...container.querySelectorAll("img")];
const front = (container: HTMLElement) => container.querySelector("img[data-frame]") as HTMLImageElement | null;

beforeEach(() => {
  pending.clear();
  vi.stubGlobal("Image", FakeImage);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function view(src: string | null, props: Record<string, unknown> = {}) {
  return createElement(BufferedImage, { src, alt: "frame", frontProps: { "data-frame": "" }, ...props });
}

describe("BufferedImage", () => {
  it("shows a frame only once it has decoded", async () => {
    const { container } = render(view("/f1.png"));
    expect(imgs(container)).toHaveLength(0);
    await settle("/f1.png");
    expect(front(container)?.getAttribute("src")).toBe("/f1.png");
  });

  it("keeps the previous frame on screen until the next one has decoded, then stacks it on top", async () => {
    const onFrame = vi.fn();
    const { container, rerender } = render(view("/f1.png", { onFrame }));
    await settle("/f1.png");
    const first = front(container);

    rerender(view("/f2.png", { onFrame }));
    // Not decoded yet: nothing changed, the first frame is still the one shown.
    expect(front(container)).toBe(first);
    expect(front(container)?.getAttribute("src")).toBe("/f1.png");

    await settle("/f2.png");
    const shown = front(container);
    expect(shown?.getAttribute("src")).toBe("/f2.png");
    // The old frame was never unmounted: it stays, opaque, underneath the new one.
    expect(first?.isConnected).toBe(true);
    expect(first?.getAttribute("src")).toBe("/f1.png");
    expect(first?.style.opacity).toBe("1");
    expect(Number(shown?.style.zIndex)).toBeGreaterThan(Number(first?.style.zIndex));
    expect(onFrame).toHaveBeenLastCalledWith({ url: "/f2.png", width: 400, height: 800 });

    // A third frame reuses the first layer's element rather than mounting a new one.
    rerender(view("/f3.png", { onFrame }));
    await settle("/f3.png");
    expect(imgs(container)).toHaveLength(2);
    expect(front(container)).toBe(first);
    expect(front(container)?.getAttribute("src")).toBe("/f3.png");
  });

  it("drops a frame that was overtaken before it decoded", async () => {
    const { container, rerender } = render(view("/f1.png"));
    rerender(view("/f2.png"));
    await settle("/f2.png");
    await settle("/f1.png");
    expect(front(container)?.getAttribute("src")).toBe("/f2.png");
  });

  it("leaves the last frame up when the next one fails, and reports it", async () => {
    const onError = vi.fn();
    const { container, rerender } = render(view("/f1.png", { onError }));
    await settle("/f1.png");
    rerender(view("/broken.png", { onError }));
    await settle("/broken.png", false);
    expect(front(container)?.getAttribute("src")).toBe("/f1.png");
    expect(onError).toHaveBeenCalledWith("/broken.png");
  });
});
