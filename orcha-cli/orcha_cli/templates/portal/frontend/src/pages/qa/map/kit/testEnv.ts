/**
 * Tests only. What jsdom lacks and the xyflow canvases need: `installFlowEnv()` in a `beforeEach`,
 * `vi.unstubAllGlobals()` (or `removeFlowEnv()`) in the `afterEach`. Reduced motion is on, so no
 * camera flight or particle is waited for, and the canvas has no 2D context, so fog is not painted.
 */
import { vi } from "vitest";

class NoResize {
  observe() {}
  unobserve() {}
  disconnect() {}
}

class NoMatrix {
  m22 = 1;
}

export function installFlowEnv(): void {
  vi.stubGlobal("ResizeObserver", NoResize);
  vi.stubGlobal("DOMMatrixReadOnly", NoMatrix);
  vi.stubGlobal("matchMedia", (q: string) => ({ matches: true, media: q, addEventListener() {}, removeEventListener() {} }));
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
}

export function removeFlowEnv(): void {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
}
