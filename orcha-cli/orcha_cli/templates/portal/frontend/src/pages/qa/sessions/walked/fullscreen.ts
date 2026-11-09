import { useCallback, useEffect, useState, type RefObject } from "react";

/** Off, the browser's own full screen, or the in-page fallback that fills the window. */
export type FullscreenMode = "off" | "native" | "expanded";

/** The classes an expanded element takes: the whole window, above everything else. */
export const EXPANDED_CLASS = "fixed inset-0 z-50 m-0 h-dvh max-h-none w-screen max-w-none border-0 p-0 text-fg";

export function fullscreenLabel(mode: FullscreenMode): string {
  return mode === "off" ? "Full screen" : "Exit full screen";
}

/** Full screen for an element: the Fullscreen API when the document allows it, else the element
 * fills the window and Escape leaves. */
export function useFullscreen(ref: RefObject<HTMLElement>) {
  const [mode, setMode] = useState<FullscreenMode>("off");
  useEffect(() => {
    const onChange = () => setMode((cur) => (document.fullscreenElement === ref.current && ref.current ? "native" : cur === "native" ? "off" : cur));
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, [ref]);
  useEffect(() => {
    if (mode !== "expanded") return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !e.defaultPrevented) setMode("off");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [mode]);
  const toggle = useCallback(async () => {
    if (mode === "native") {
      await document.exitFullscreen?.().catch(() => {});
      return;
    }
    if (mode === "expanded") {
      setMode("off");
      return;
    }
    const el = ref.current;
    if (document.fullscreenEnabled && el?.requestFullscreen) {
      try {
        await el.requestFullscreen();
        return;
      } catch {
        /* refused: expand instead */
      }
    }
    setMode("expanded");
  }, [mode, ref]);
  return { mode, toggle, active: mode !== "off", expanded: mode === "expanded", label: fullscreenLabel(mode) };
}
