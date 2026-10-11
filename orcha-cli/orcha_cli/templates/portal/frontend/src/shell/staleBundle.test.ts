import { afterEach, describe, expect, it, vi } from "vitest";
import { RELOAD_GUARD_MS, installStaleBundleReload } from "./staleBundle";

function fakeWindow() {
  const target = new EventTarget();
  const reload = vi.fn();
  const win = Object.assign(target, { location: { reload } }) as unknown as Window;
  return { win, reload, fire: () => win.dispatchEvent(new Event("vite:preloadError", { cancelable: true })) };
}

afterEach(() => sessionStorage.clear());

describe("installStaleBundleReload (#297)", () => {
  it("reloads once when an updated portal no longer has a lazy chunk", () => {
    const { win, reload, fire } = fakeWindow();
    let t = 1_000_000;
    installStaleBundleReload(win, () => t);
    fire();
    expect(reload).toHaveBeenCalledTimes(1);
    t += 1000;
    fire(); // still missing right after the reload: no loop
    expect(reload).toHaveBeenCalledTimes(1);
    t += RELOAD_GUARD_MS;
    fire();
    expect(reload).toHaveBeenCalledTimes(2);
  });
});
