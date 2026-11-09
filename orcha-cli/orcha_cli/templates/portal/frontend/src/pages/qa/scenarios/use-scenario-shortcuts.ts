
import { useEffect } from "react";

function isTypingTarget(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  if (el.isContentEditable) return true;
  // The custom Select's trigger (components/ui/select.tsx) stands in for a native <select>.
  if (el.getAttribute("role") === "combobox") return true;
  const tag = el.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}

function dialogOpen(): boolean {
  return document.querySelector("dialog[open]") != null;
}

export interface ScenarioShortcutHandlers {
  onNew: () => void;
  onFitView: () => void;
  onFocusSearch: () => void;
  /** True when Escape did something (closed the panel or asked first): the key is then
   * consumed, so the same keystroke cannot also cancel the prompt it opened (#189). */
  onEscape: () => boolean | void;
  onDelete: () => void;
  onSelectAll: () => void;
}

/**
 * Toolbar keyboard shortcuts (spec §3 rework): `n` new, `f` fit view, `/`
 * search, `Esc` clear/close, `Delete`/`Backspace` remove selection,
 * `Cmd/Ctrl+A` select all. Ignored while typing or with a dialog open
 * (except Esc, which the dialog itself already handles via `<dialog>`).
 */
export function useScenarioShortcuts(handlers: ScenarioShortcutHandlers) {
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.metaKey || e.ctrlKey) {
        if (e.key.toLowerCase() === "a") {
          if (isTypingTarget(e.target) || dialogOpen()) return;
          e.preventDefault();
          handlers.onSelectAll();
        }
        return;
      }
      if (e.key === "Escape") {
        // Let an open <dialog> handle its own ESC; only act when nothing is open.
        if (dialogOpen() || e.defaultPrevented) return;
        // Consumed: otherwise the browser's own Escape handling (its close watcher) runs after
        // this listener and cancels the "Save your changes?" dialog this keystroke just opened.
        if (handlers.onEscape() === true) e.preventDefault();
        return;
      }
      if (isTypingTarget(e.target) || e.altKey || dialogOpen() || e.repeat) return;
      switch (e.key) {
        case "n":
          e.preventDefault();
          handlers.onNew();
          break;
        case "f":
          e.preventDefault();
          handlers.onFitView();
          break;
        case "/":
          e.preventDefault();
          handlers.onFocusSearch();
          break;
        case "Delete":
        case "Backspace":
          handlers.onDelete();
          break;
        default:
          break;
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [handlers.onNew, handlers.onFitView, handlers.onFocusSearch, handlers.onEscape, handlers.onDelete, handlers.onSelectAll]);
}
