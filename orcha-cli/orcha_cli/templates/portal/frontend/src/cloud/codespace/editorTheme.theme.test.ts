/** Code Space editor + portal terminal follow the app theme live. */
import { afterEach, describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { buildEditorTheme, editorPalette } from "./editorTheme";
import { applyTheme } from "../../shell/theme";
import { termTheme } from "../../components/terminal/orchaTerm";

afterEach(() => applyTheme("dark"));

describe("editor theme", () => {
  it("every colour is a live token reference (re-tones with <html data-theme>)", () => {
    const p = editorPalette();
    for (const [k, v] of Object.entries(p)) if (k !== "fontMono") expect(v, k).toMatch(/^var\(--/);
    expect(p.selection).toMatch(/--v2-selection/);
  });
  it("CM's dark flag flips when the app theme changes", () => {
    applyTheme("dark");
    const view = new EditorView({ state: EditorState.create({ doc: "x", extensions: [buildEditorTheme()] }), parent: document.body });
    expect(view.state.facet(EditorView.darkTheme)).toBe(true);
    applyTheme("light");
    expect(view.state.facet(EditorView.darkTheme)).toBe(false);
    applyTheme("dark");
    expect(view.state.facet(EditorView.darkTheme)).toBe(true);
    view.destroy();
  });
});

describe("terminal theme", () => {
  const L = (h: string) => { const c = [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)); return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; };
  const cr = (a: string, b: string) => { const [x, y] = [L(a), L(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
  it("light terminal: white pane, every ANSI colour >= 4.5:1 on it", () => {
    const t = termTheme("light");
    expect(t.background).toBe("#FFFFFF");
    for (const k of ["foreground", "black", "red", "green", "yellow", "blue", "magenta", "cyan", "white", "brightBlack", "brightRed", "brightGreen", "brightYellow", "brightBlue", "brightMagenta", "brightCyan", "brightWhite"] as const) {
      expect(cr(t[k]!, t.background!), k).toBeGreaterThanOrEqual(4.5);
    }
  });
  it("dark terminal keeps the V2 dark pane", () => {
    expect(termTheme("dark")).toMatchObject({ background: "#101113", foreground: "#EEEFF2" });
  });
});
