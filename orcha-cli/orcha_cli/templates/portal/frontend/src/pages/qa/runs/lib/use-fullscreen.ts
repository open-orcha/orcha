import { useCallback, useEffect, useState, type RefObject } from "react";
import {
  dropFromTopLayer,
  enterFullscreen,
  escapeLeavesExpanded,
  exitNativeFullscreen,
  fullscreenLabel,
  liftToTopLayer,
  modeAfterChange,
  type FullscreenMode,
} from "./fullscreen";

export interface Fullscreen {
  mode: FullscreenMode;
  /** In either full screen: the browser's own or the expanded fallback. */
  active: boolean;
  /** In the expanded fallback: the element should take `EXPANDED_CLASS`. */
  expanded: boolean;
  /** "Full screen" or "Exit full screen". */
  label: string;
  toggle: () => void;
  exit: () => void;
}

/**
 * One "Full screen" button's state for the element in `ref` (see `fullscreen.ts`): the
 * Fullscreen API when the document allows it, otherwise the element expands to fill the window
 * and Escape leaves. The mode follows `fullscreenchange`, so leaving the browser's full screen
 * by its own means (Escape, the green button) puts the label back.
 */
export function useFullscreen<T extends HTMLElement>(ref: RefObject<T | null>): Fullscreen {
  const [mode, setMode] = useState<FullscreenMode>("off");

  useEffect(() => {
    const onChange = () => setMode((m) => modeAfterChange(m, ref.current, document));
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, [ref]);

  useEffect(() => {
    const el = ref.current;
    if (mode !== "expanded" || !el) return;
    const lifted = liftToTopLayer(el);
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      // Decide once every listener has seen the press, so the component's own Escape wins.
      queueMicrotask(() => {
        if (escapeLeavesExpanded(e)) setMode("off");
      });
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      if (lifted) dropFromTopLayer(el);
    };
  }, [mode, ref]);

  const exit = useCallback(() => {
    if (document.fullscreenElement) void exitNativeFullscreen(document);
    setMode((m) => (m === "expanded" ? "off" : m));
  }, []);

  const toggle = useCallback(() => {
    if (mode !== "off") {
      exit();
      return;
    }
    const el = ref.current;
    if (!el) return;
    void enterFullscreen(el, document).then((next) => setMode(next));
  }, [mode, exit, ref]);

  return { mode, active: mode !== "off", expanded: mode === "expanded", label: fullscreenLabel(mode), toggle, exit };
}
