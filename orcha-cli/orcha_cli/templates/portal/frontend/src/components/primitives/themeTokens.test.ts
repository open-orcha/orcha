/**
 * Light + dark token guard (Appearance):
 *  1. COLOUR RULE — the main V2 stylesheets never hard-code a colour outside a
 *     custom-property definition (a token). New colours go in v2-tokens.css,
 *     in BOTH theme blocks, so light mode never grows a dark island.
 *  2. PARITY — every colour token of the dark base block is re-declared in the
 *     [data-theme="light"] block (bar the few that are deliberately shared).
 *  3. CONTRAST — the light text/semantic tokens are WCAG AA on every light
 *     surface they sit on.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = resolve(__dirname, "../..");
const STYLES = resolve(SRC, "../../static/styles");
const read = (p: string) => readFileSync(p, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

const COLOUR = /#[0-9a-fA-F]{3,8}\b|\b(?:rgba?|hsla?)\(/;

/** Declarations that may still carry a literal: token definitions, var()
 *  fallbacks (the token wins), and mask images (alpha only, never painted). */
function offending(css: string): string[] {
  const out: string[] = [];
  for (const raw of css.split(/[;{}]/)) {
    const decl = raw.trim();
    if (!decl || !decl.includes(":")) continue;
    if (decl.startsWith("--")) continue;
    if (/^(-webkit-)?mask(-image)?\s*:/.test(decl)) continue;
    let v = decl;
    // strip var(--x, fallback) — fallbacks may nest one level of parens
    for (let i = 0; i < 4; i++) v = v.replace(/var\(--[\w-]+\s*,[^()]*(?:\([^()]*\)[^()]*)*\)/g, "var()");
    if (COLOUR.test(v)) out.push(decl.replace(/\s+/g, " ").slice(0, 140));
  }
  return out;
}

const GUARDED: [string, string][] = [
  ["v2-tokens.css", resolve(STYLES, "v2-tokens.css")],
  ["v2-primitives.css", resolve(STYLES, "v2-primitives.css")],
  ["v2-shell.css", resolve(STYLES, "v2-shell.css")],
  ["agents.css", resolve(SRC, "pages/agents/agents.css")],
  ["agentsBoard.css", resolve(SRC, "pages/agents/agentsBoard.css")],
  ["liveChanges.css", resolve(SRC, "pages/agents/liveChanges.css")],
  ["overview.css", resolve(SRC, "pages/home/overview.css")],
  ["org.css", resolve(SRC, "pages/org/org.css")],
  ["settings-v2.css", resolve(SRC, "pages/settings/settings-v2.css")],
  ["settings-cards.css", resolve(SRC, "cloud/settings/settings-cards.css")],
  ["metrics.css", resolve(SRC, "cloud/metrics/metrics.css")],
  ["codespace.css", resolve(SRC, "cloud/codespace/codespace.css")],
];

describe("colour rule: no hard-coded colours in the V2 stylesheets", () => {
  for (const [name, path] of GUARDED) {
    it(name, () => {
      expect(offending(read(path))).toEqual([]);
    });
  }
  it("the guard itself catches a literal (and allows tokens, fallbacks, masks)", () => {
    expect(offending(".a { color: #fff; }")).toHaveLength(1);
    expect(offending(".a { box-shadow: 0 1px 0 rgba(0,0,0,.2); }")).toHaveLength(1);
    expect(offending(":root { --x: #fff; }")).toEqual([]);
    expect(offending(".a { color: var(--v2-text, #EEEFF2); }")).toEqual([]);
    expect(offending(".a { box-shadow: var(--s, 0 8px 24px rgba(0, 0, 0, .45)); }")).toEqual([]);
    expect(offending(".a { mask-image: linear-gradient(#000, transparent); }")).toEqual([]);
  });
});

/* ---- token blocks ---------------------------------------------------------- */
const tokens = read(resolve(STYLES, "v2-tokens.css"));
function block(startMarker: string): string {
  const i = tokens.indexOf(startMarker);
  expect(i).toBeGreaterThanOrEqual(0);
  const open = tokens.indexOf("{", i);
  return tokens.slice(open + 1, tokens.indexOf("\n}", open));
}
function decls(b: string): Map<string, string> {
  const m = new Map<string, string>();
  for (const d of b.split(";")) {
    const mm = d.trim().match(/^(--[\w-]+)\s*:\s*([\s\S]+)$/);
    if (mm) m.set(mm[1], mm[2].trim());
  }
  return m;
}
const dark = decls(block(":root,\n:root[data-theme],"));
const light = decls(block(':root[data-theme="light"],'));
/** colour tokens shared by both themes on purpose */
const SHARED = new Set(["--v2-lightbox-bg", "--diff-hunk", "--v2-pr-color"]);

describe("light/dark parity", () => {
  it("the light block exists with color-scheme: light", () => {
    expect(block(':root[data-theme="light"],')).toMatch(/color-scheme:\s*light;/);
    expect(light.size).toBeGreaterThan(80);
  });
  it("every literal colour token of the dark block is re-declared for light", () => {
    const missing = [...dark.entries()]
      .filter(([k, v]) => COLOUR.test(v) && !SHARED.has(k) && !light.has(k))
      .map(([k]) => k);
    expect(missing).toEqual([]);
  });
  it("the light block only re-declares tokens the dark block defines (or v2-primitives' status set)", () => {
    const extra = [...light.keys()].filter((k) => !dark.has(k) && !k.startsWith("--v2-st-"));
    expect(extra).toEqual([]);
  });
});

/* ---- light contrast ---------------------------------------------------------- */
type RGB = [number, number, number];
const hex = (h: string): RGB => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16)) as RGB;
const lum = ([r, g, b]: RGB) => {
  const f = (c: number) => { const s = c / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
};
const contrast = (a: RGB, b: RGB) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
const L = (name: string) => hex(light.get(name)!);
/** a translucent rgba() over an opaque surface */
function over(rgba: string, base: RGB): RGB {
  const m = rgba.match(/rgba\((\d+),\s*(\d+),\s*(\d+),\s*([\d.]+)\)/)!;
  const a = Number(m[4]);
  return [1, 2, 3].map((i, j) => Math.round(Number(m[i]) * a + base[j] * (1 - a))) as RGB;
}

describe("light contrast (WCAG AA)", () => {
  const surfaces = ["--v2-window", "--v2-panel", "--v2-surface", "--v2-raised", "--v2-band", "--v2-hover-solid", "--v2-selected-solid"];
  const text = ["--v2-text", "--v2-text-2", "--v2-text-3", "--v2-accent", "--v2-ok", "--v2-warn", "--v2-danger", "--v2-info", "--diff-add", "--diff-del"];
  for (const t of text) {
    it(`${t} >= 4.5:1 on every light surface`, () => {
      for (const s of surfaces) expect(contrast(L(t), L(s)), `${t} on ${s}`).toBeGreaterThanOrEqual(4.5);
    });
  }
  it("each semantic colour stays AA on its own -soft tint over the panel", () => {
    for (const k of ["accent", "ok", "warn", "danger", "info"]) {
      const tint = over(light.get(`--v2-${k}-soft`)!, L("--v2-panel"));
      expect(contrast(L(`--v2-${k}`), tint), k).toBeGreaterThanOrEqual(4.5);
    }
  });
  it("white on the primary button fill (rest + hover)", () => {
    expect(contrast(L("--v2-primary-text"), L("--v2-primary-bg"))).toBeGreaterThanOrEqual(4.5);
    expect(contrast(L("--v2-primary-text"), L("--v2-primary-bg-hover"))).toBeGreaterThanOrEqual(4.5);
  });
  it("status glyphs are >= 3:1 on the panel (non-text UI)", () => {
    for (const k of ["progress", "review", "verify", "done", "blocked", "failed", "todo"]) {
      expect(contrast(L(`--v2-status-${k}`), L("--v2-panel")), k).toBeGreaterThanOrEqual(3);
    }
  });
});
