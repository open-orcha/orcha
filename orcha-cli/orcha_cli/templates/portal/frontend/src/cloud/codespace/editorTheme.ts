/**
 * Minimal CM6 theme sourced from the SAME CSS custom properties the rest of
 * codespace.css uses (tokens.css — light/dark + skins all define these), so
 * the editor never hardcodes a color and re-themes for free whenever the
 * shell's theme/skin changes. Reads computed values off `document` at
 * construction time — cheap, done once per EditorPane mount — rather than
 * hand-duplicating hex values here that would silently drift from tokens.css.
 *
 * Font stack matches the existing read-only code viewer (codespace.css's
 * `.rb-code`) — "JetBrains Mono", monospace — so switching Edit on/off never
 * visibly reflows the pane.
 */
import type { Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";

function cssVar(name: string, fallback: string): string {
  if (typeof window === "undefined" || typeof getComputedStyle !== "function") return fallback;
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

export function buildEditorTheme(): Extension {
  const text = cssVar("--text", "#0e1722");
  const surface = cssVar("--surface", "#ffffff");
  const surface2 = cssVar("--surface-2", "#f5f8fc");
  const border = cssVar("--border", "#e4eaf2");
  const faint = cssVar("--faint", "#8794a6");
  const accent = cssVar("--accent", "#0c9aa0");
  const accentSoft = cssVar("--accent-soft", "rgba(12, 154, 160, .10)");
  const accentGlow = cssVar("--accent-glow", "rgba(12, 154, 160, .18)");

  return EditorView.theme({
    "&": {
      color: text,
      backgroundColor: surface,
      fontSize: "12.5px",
      height: "100%",
    },
    ".cm-content": {
      fontFamily: '"JetBrains Mono", monospace',
      caretColor: accent,
    },
    ".cm-cursor, .cm-dropCursor": { borderLeftColor: accent },
    "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection": {
      backgroundColor: accentGlow + " !important",
    },
    ".cm-gutters": {
      backgroundColor: surface2,
      color: faint,
      border: "none",
      borderRight: "1px solid " + border,
    },
    ".cm-activeLine": { backgroundColor: accentSoft },
    ".cm-activeLineGutter": { backgroundColor: accentSoft },
    ".cm-line": { lineHeight: "1.6" },
    "&.cm-focused": { outline: "none" },
    ".cm-searchMatch": { backgroundColor: accentSoft, outline: "1px solid " + accent },
    ".cm-searchMatch-selected": { backgroundColor: accentGlow },
  }, { dark: false });
}
