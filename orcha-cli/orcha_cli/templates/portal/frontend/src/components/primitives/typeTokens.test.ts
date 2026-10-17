/**
 * "type-tokens" polish (Linear pop r1): D6 font bundle + pre-paint, the single
 * focus ring, the Linear primary fill, page-level overflow and the shared
 * horizontal-strip utility. jsdom does not load stylesheets, so these assert
 * rule text + WCAG math directly.
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const PORTAL = resolve(__dirname, "../../../..");
const STATIC = resolve(PORTAL, "static");
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "");
const tokens = strip(readFileSync(resolve(STATIC, "styles/v2-tokens.css"), "utf8"));
const entry = strip(readFileSync(resolve(STATIC, "styles.css"), "utf8"));
const prims = strip(readFileSync(resolve(STATIC, "styles/v2-primitives.css"), "utf8"));
const indexHtml = readFileSync(resolve(PORTAL, "frontend/index.html"), "utf8");

type RGB = [number, number, number];
const hex = (h: string): RGB => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16)) as RGB;
const lin = (c: number) => { const s = c / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
const lum = ([r, g, b]: RGB) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
const contrast = (a: RGB, b: RGB) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
const tok = (name: string) => {
  const m = tokens.match(new RegExp(`--${name}:\\s*(#[0-9A-Fa-f]{6})`));
  if (!m) throw new Error(`token ${name} missing`);
  return hex(m[1]);
};
const rule = (css: string, sel: RegExp) => css.split("}").find((r) => sel.test(r)) ?? "";

describe("D6: Inter Variable (opsz) is bundled, registered and preloaded", () => {
  it("ships the opsz woff2 files and the OFL license", () => {
    for (const f of ["inter-var-opsz-latin.woff2", "inter-var-opsz-latin-ext.woff2", "inter-var-opsz-latin-italic.woff2", "OFL-inter.txt"]) {
      expect(existsSync(resolve(STATIC, "fonts", f))).toBe(true);
    }
    expect(readFileSync(resolve(STATIC, "fonts/OFL-inter.txt"), "utf8")).toMatch(/SIL OPEN FONT LICENSE/i);
  });
  it("registers every face as \"Inter Variable\" with swap + the full wght range", () => {
    const faces = tokens.match(/@font-face\s*\{[^}]*\}/g) ?? [];
    expect(faces.length).toBe(3);
    for (const f of faces) {
      expect(f).toMatch(/font-family:\s*"Inter Variable"/);
      expect(f).toMatch(/font-display:\s*swap/);
      expect(f).toMatch(/font-weight:\s*100 900/);
      expect(f).toMatch(/\/assets\/fonts\/inter-var-opsz-/);
    }
  });
  it("body uses the Linear feature set + optical sizing + antialiasing", () => {
    const body = rule(tokens, /(^|\n)\s*body\s*\{/);
    expect(body).toMatch(/font-family:\s*var\(--v2-font-sans\)/);
    expect(body).toMatch(/font-feature-settings:\s*var\(--v2-font-features\)/);
    expect(body).toMatch(/font-optical-sizing:\s*auto/);
    expect(body).toMatch(/-webkit-font-smoothing:\s*antialiased/);
    expect(tokens).toMatch(/--v2-font-features:\s*"cv01",\s*"ss03"/);
    expect(tokens).toMatch(/--v2-font-sans:\s*"Inter Variable"/);
  });
  it("the latin opsz file is preloaded (crossorigin) at the @font-face URL; index.html paints the window tone pre-CSS", () => {
    // injected post-transform by vite.config.ts so dev never rebases the URL (13.4: double download)
    const viteCfg = readFileSync(resolve(__dirname, "../../../vite.config.ts"), "utf8");
    expect(viteCfg).toMatch(/<link rel="preload" href="\/assets\/fonts\/inter-var-opsz-latin\.woff2" as="font" type="font\/woff2" crossorigin/);
    expect(viteCfg).toMatch(/order: "post"/);
    expect(indexHtml).not.toMatch(/rel="preload"/);
    expect(tokens).toContain('url("/assets/fonts/inter-var-opsz-latin.woff2")');
    expect(indexHtml).toMatch(/background:\s*#0E0F10/);
    expect(indexHtml).toMatch(/"cv01",\s*"ss03"/); // pre-paint text already uses the Linear features
    expect(tokens).toMatch(/--v2-window:\s*#0E0F10/);
  });
});

describe("r1 focus ring: one 2px ring, no two-tone halo", () => {
  it("--v2-focus-ring is a single outset layer, not re-declared per surface", () => {
    const decls = tokens.match(/--v2-focus-ring:\s*[^;]+;/g) ?? [];
    expect(decls).toHaveLength(1);
    const layers = decls[0]!.replace(/^--v2-focus-ring:\s*/, "").replace(/;$/, "").split(/,(?![^(]*\))/);
    expect(layers).toHaveLength(1);
    expect(layers[0]).toMatch(/^0 0 0 2px var\(--v2-focus-color\)$/);
  });
  it("the ring colour clears 3:1 against the window and the panel", () => {
    expect(tokens).toMatch(/--v2-focus-color:\s*var\(--v2-accent\)/);
    for (const bg of ["v2-window", "v2-panel", "v2-raised"]) expect(contrast(tok("v2-accent"), tok(bg))).toBeGreaterThanOrEqual(3);
  });
});

describe("r1 primary button: Linear indigo fill, white label", () => {
  it("white label is AA on the fill and the hover fill", () => {
    const white = tok("v2-primary-text");
    expect(contrast(white, tok("v2-primary-bg"))).toBeGreaterThanOrEqual(4.5);
    expect(contrast(white, tok("v2-primary-bg-hover"))).toBeGreaterThanOrEqual(4.5);
  });
  it("v2-primitives.css paints .v2-btn-primary / legacy .btn / .btn.approve with the primary tokens (no pastel accent fill)", () => {
    for (const sel of [/^\s*\.v2-btn-primary\s*\{/, /^\s*\.btn\s*\{/, /^\s*\.btn\.approve\s*\{/]) {
      const r = rule(prims, sel);
      expect(r).toMatch(/background:\s*var\(--v2-primary-bg\)/);
      expect(r).toMatch(/color:\s*var\(--v2-primary-text\)/);
    }
    // no later override repaints the primary (the temporary styles.css block is gone)
    expect(entry).not.toMatch(/\.v2-btn-primary[^{]*\{[^}]*background/);
    expect(prims.match(/(^|\})\s*\.v2-btn-primary\s*\{/g)?.length).toBe(1);
    // secondary / danger legacy variants stay secondary
    expect(rule(prims, /^\s*\.btn\.ghost,\s*\.btn\.subtle\s*\{/)).toMatch(/var\(--v2-btn-secondary-bg\)/);
  });
});

describe("r1 page overflow + strips + code ligatures", () => {
  it("the page never scrolls sideways (html overflow-x: clip)", () => {
    expect(rule(tokens, /(^|\n)\s*html\s*\{/)).toMatch(/overflow-x:\s*clip/);
  });
  it(".v2-fade-x is a nowrap scroller with start/end/both edge masks", () => {
    const base = rule(tokens, /(^|\n)\s*\.v2-fade-x\s*\{/);
    expect(base).toMatch(/overflow-x:\s*auto/);
    expect(base).toMatch(/flex-wrap:\s*nowrap/);
    for (const edge of ["start", "end", "both"]) {
      expect(rule(tokens, new RegExp(`\\.v2-fade-x\\[data-fade="${edge}"\\]`))).toMatch(/mask-image:\s*linear-gradient/);
    }
  });
  it("code surfaces (incl. CodeMirror) render without programming ligatures", () => {
    const r = rule(tokens, /\.cm-editor/);
    expect(r).toMatch(/font-variant-ligatures:\s*none/);
    expect(r).toMatch(/(^|,)\s*code\s*,/);
  });
});

describe("r2 tokens: palette parity + dialog popover layer", () => {
  it("drops the stale --v2-avatar-bg-* tokens (identity colours come from AVATAR_HUES, D13)", () => {
    expect(tokens).not.toMatch(/--v2-avatar-bg-\d/);
  });
  it("--v2-z-dialog-popover stacks above the dialog and below toasts", () => {
    const z = (n: string) => Number(tokens.match(new RegExp(`--v2-z-${n}:\\s*(\\d+)`))?.[1]);
    expect(z("dialog-popover")).toBeGreaterThan(z("dialog"));
    expect(z("dialog-popover")).toBeLessThan(z("toast"));
  });
});
