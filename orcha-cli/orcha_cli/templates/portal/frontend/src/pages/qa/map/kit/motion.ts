import { useSyncExternalStore } from "react";

const REDUCED_MOTION = "(prefers-reduced-motion: reduce)";

function subscribeReducedMotion(onChange: () => void) {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return () => {};
  const mq = window.matchMedia(REDUCED_MOTION);
  mq.addEventListener("change", onChange);
  return () => mq.removeEventListener("change", onChange);
}

/** Whether the viewer asked for reduced motion. */
export function usePrefersReducedMotion(): boolean {
  return useSyncExternalStore(subscribeReducedMotion, () => typeof window.matchMedia === "function" && window.matchMedia(REDUCED_MOTION).matches, () => true);
}

function subscribeTheme(on: () => void) {
  const mo = new MutationObserver(on);
  mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  return () => mo.disconnect();
}

/** Whether the portal shows its dark theme (`<html data-theme>`). */
export function useDarkTheme(): boolean {
  return useSyncExternalStore(subscribeTheme, () => document.documentElement.getAttribute("data-theme") !== "light", () => true);
}
