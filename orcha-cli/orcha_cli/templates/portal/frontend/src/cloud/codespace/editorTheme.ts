/**
 * CM6 theme for the Code Space editors (EditorPane + DraftEditorPane), built
 * from the V2 design tokens (docs/orcha-v2-design-system.md §1 —
 * static/styles/v2-tokens.css), for BOTH themes.
 *
 * Every colour is a live `var(--v2-*)` reference, so the editor re-tones with
 * the rest of the page the instant <html data-theme> flips. The only thing CM
 * needs to be told is light vs dark (its `dark` flag picks the defaults for
 * anything not overridden — search panel, tooltips, autocomplete): that part
 * lives in a Compartment that is reconfigured on THEME_CHANGED_EVENT.
 *
 * Syntax colours reuse the read-only viewer's token mapping
 * (browse.css `.rb-tok-*`: comment → tertiary text, string → diff-add green,
 * number → accent, keyword → info blue) so toggling Edit on/off never recolours
 * the code. Font stack matches `.rb-code` (JetBrains Mono) so the pane never
 * reflows either.
 */
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { Compartment, type Extension } from "@codemirror/state";
import { EditorView, ViewPlugin } from "@codemirror/view";
import { currentTheme, THEME_CHANGED_EVENT, type ResolvedTheme } from "../../shell/theme";
import { tags as t } from "@lezer/highlight";
import { THREAD_LINE_CLASS } from "./editorThreadMarks";

/** Disables ligatures/contextual alternates — shared with the read view (codespace.css .rb-code). */
export const MONO_FEATURES = '"liga" 0, "calt" 0';

const v = (name: string, fallback: string) => `var(${name}, ${fallback})`;

/** The V2 palette the editor uses (live CSS variable references) — exported for tests. */
export function editorPalette() {
  return {
    text: v("--v2-text", "#EEEFF2"),
    text2: v("--v2-text-2", "#AAADB7"),
    text3: v("--v2-text-3", "#959AA4"),
    surface: v("--v2-surface", "#191A1D"),
    panel: v("--v2-panel", "#151618"),
    canvas: v("--v2-canvas", "#101113"),
    raised: v("--v2-raised", "#202126"),
    hover: v("--v2-hover", "#25262B"),
    border: v("--v2-border", "#2B2D33"),
    accent: v("--v2-accent", "#8D93F7"),
    accentSoft: v("--v2-accent-soft", "rgba(141, 147, 247, 0.14)"),
    selection: v("--v2-selection", "rgba(141, 147, 247, 0.32)"), // same as ::selection
    info: v("--v2-info", "#4EA7FC"),
    warn: v("--v2-warn", "#E2A336"),
    danger: v("--v2-danger", "#EE7070"),
    diffAdd: v("--diff-add", "#8FD9AE"),
    fontMono: v("--v2-font-mono", '"JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace'),
  };
}

/** Light/dark flag for CM's own defaults, swapped live on a theme change. */
const themeKind = new Compartment();

/** The CM extensions for one theme kind (colours are theme-agnostic var()s). */
export function editorThemeFor(resolved: ResolvedTheme): Extension {
  const dark = resolved === "dark";
  return [baseTheme(dark), syntaxHighlighting(highlightStyle(dark))];
}

/** Reconfigures the compartment whenever the app theme changes. */
const followAppTheme = ViewPlugin.define((view) => {
  const on = (e: Event) => {
    const d = (e as CustomEvent).detail;
    const r: ResolvedTheme = d === "light" || d === "dark" ? d : currentTheme();
    view.dispatch({ effects: themeKind.reconfigure(editorThemeFor(r)) });
  };
  window.addEventListener(THEME_CHANGED_EVENT, on);
  return { destroy: () => window.removeEventListener(THEME_CHANGED_EVENT, on) };
});

export function buildEditorTheme(): Extension {
  return [themeKind.of(editorThemeFor(currentTheme())), followAppTheme];
}

function baseTheme(dark: boolean): Extension {
  const p = editorPalette();
  return EditorView.theme({
    "&": {
      color: p.text,
      backgroundColor: p.panel,
      fontSize: "12.5px",
      height: "100%",
    },
    // Same glyphs as the read view (.rb-code): no programming ligatures
    // (=> ≠ ⇒, === ≠ ≡) and none of the UI font's cv01/ss03 alternates.
    ".cm-scroller": { fontFamily: p.fontMono, fontVariantLigatures: "none", fontFeatureSettings: MONO_FEATURES, lineHeight: "20px" },
    ".cm-content": {
      fontFamily: p.fontMono,
      fontVariantLigatures: "none",
      fontFeatureSettings: MONO_FEATURES,
      caretColor: p.accent,
      padding: "8px 0 32px",
    },
    ".cm-cursor, .cm-dropCursor": { borderLeftColor: p.accent, borderLeftWidth: "2px" },
    "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection": {
      backgroundColor: p.selection + " !important",
    },
    // Same gutter as the read-only viewer (codespace.css .cs-gutter): panel
    // tone, no rule, right-aligned tabular numbers — toggling Edit never
    // shifts or recolours the code.
    ".cm-gutters": {
      backgroundColor: p.panel,
      color: p.text3,
      border: "none",
    },
    // identical box to the viewer's .cs-gutter (border-box, 4ch + 30px)
    ".cm-lineNumbers .cm-gutterElement": { boxSizing: "border-box", padding: "0 14px 0 16px", minWidth: "calc(4ch + 30px)", fontVariantNumeric: "tabular-nums" },
    // thread markers (editorThreadMarks.ts) = the viewer's .cs-gutter-dot
    [".cm-gutterElement." + THREAD_LINE_CLASS]: { position: "relative" },
    [".cm-gutterElement." + THREAD_LINE_CLASS + "::before"]: {
      content: '""', position: "absolute", left: "8px", top: "7px", width: "6px", height: "6px", borderRadius: "50%", backgroundColor: p.accent,
    },
    ".cm-activeLine": { backgroundColor: p.hover },
    ".cm-activeLineGutter": { backgroundColor: p.hover, color: p.text2 },
    ".cm-line": { lineHeight: "20px", padding: "0 24px 0 4px" }, // = .cs-line-text
    // Focus is shown by the pane's own ring (codespace.css), never a CM outline.
    "&.cm-focused": { outline: "none" },
    ".cm-searchMatch": { backgroundColor: p.accentSoft, outline: "1px solid " + p.accent },
    ".cm-searchMatch-selected": { backgroundColor: p.selection },
    ".cm-panels": { backgroundColor: p.raised, color: p.text },
    ".cm-panels-top": { borderBottom: "1px solid " + p.border },
    ".cm-panels-bottom": { borderTop: "1px solid " + p.border },
    ".cm-panel input, .cm-panel button": { fontFamily: "inherit" },
    ".cm-textfield": {
      backgroundColor: p.canvas,
      color: p.text,
      border: "1px solid " + p.border,
      borderRadius: "6px",
    },
    ".cm-button": {
      backgroundImage: "none",
      backgroundColor: p.raised,
      color: p.text,
      border: "1px solid " + p.border,
      borderRadius: "6px",
    },
    ".cm-tooltip": { backgroundColor: p.raised, color: p.text, border: "1px solid " + p.border },
    ".cm-matchingBracket, &.cm-focused .cm-matchingBracket": { backgroundColor: p.accentSoft, outline: "none" },
  }, { dark });
}

function highlightStyle(dark: boolean): HighlightStyle {
  const p = editorPalette();
  return HighlightStyle.define([
    { tag: [t.comment, t.lineComment, t.blockComment, t.docComment], color: p.text3, fontStyle: "italic" },
    { tag: [t.string, t.special(t.string), t.regexp, t.character], color: p.diffAdd },
    { tag: [t.number, t.bool, t.null, t.atom], color: p.accent },
    { tag: [t.keyword, t.controlKeyword, t.operatorKeyword, t.definitionKeyword, t.moduleKeyword, t.modifier], color: p.info, fontWeight: "500" },
    { tag: [t.typeName, t.className, t.namespace], color: p.warn },
    { tag: [t.function(t.variableName), t.function(t.propertyName)], color: p.text },
    { tag: [t.propertyName, t.attributeName], color: p.text2 },
    { tag: [t.heading], color: p.text, fontWeight: "600" },
    { tag: [t.link, t.url], color: p.accent, textDecoration: "underline" },
    { tag: [t.invalid], color: p.danger },
    { tag: [t.meta, t.processingInstruction], color: p.text3 },
  ], { themeType: dark ? "dark" : "light" });
}
