/**
 * QA a11y regressions for the V2 token / primitive stylesheets (findings 22,
 * 25, 27, 28, 29, 30). jsdom does not cascade @media rules, so these assert
 * the rule text directly plus WCAG contrast math for the colour findings.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const STYLES = resolve(__dirname, "../../../../static/styles");
const read = (p: string) => readFileSync(p, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
const tokens = read(resolve(STYLES, "v2-tokens.css"));
const shell = read(resolve(STYLES, "v2-shell.css"));
const prims = read(resolve(STYLES, "v2-primitives.css"));
const agentsCss = read(resolve(__dirname, "../../pages/agents/agents.css"));
const avatarSrc = readFileSync(resolve(__dirname, "./Avatar.tsx"), "utf8"); // D7: ui.tsx Avatar delegates here
const avatarsSrc = readFileSync(resolve(__dirname, "../../cloud/projects/avatars.tsx"), "utf8");

/** Bodies of every `@media <query> { ... }` block (brace-matched). */
function mediaBlocks(css: string, query: RegExp): string[] {
  const out: string[] = [];
  const re = new RegExp(`@media\\s*${query.source}\\s*\\{`, "g");
  while (re.exec(css)) {
    let depth = 1;
    let i = re.lastIndex;
    for (; i < css.length && depth; i++) {
      if (css[i] === "{") depth++;
      else if (css[i] === "}") depth--;
    }
    out.push(css.slice(re.lastIndex, i - 1));
  }
  return out;
}
const selectorsOf = (rulePrefix: string) => rulePrefix.split(",").map((s) => s.trim()).filter(Boolean);

// ---- WCAG contrast helpers -------------------------------------------------
type RGB = [number, number, number];
const hex = (h: string): RGB => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16)) as RGB;
const lin = (c: number) => { const s = c / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
const lum = ([r, g, b]: RGB) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
const contrast = (a: RGB, b: RGB) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
function hsl(h: number, s: number, l: number): RGB {
  s /= 100; l /= 100;
  const k = (n: number) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return [f(0), f(8), f(4)].map((v) => Math.round(v * 255)) as RGB;
}
const over = (fg: RGB, alpha: number, bg: RGB): RGB => fg.map((c, i) => Math.round(c * alpha + bg[i] * (1 - alpha))) as RGB;
const token = (name: string) => {
  const m = tokens.match(new RegExp(`--${name}:\\s*(#[0-9A-Fa-f]{6})`));
  if (!m) throw new Error(`token ${name} missing`);
  return hex(m[1]);
};

describe("finding 22: coarse-pointer touch sizes actually apply", () => {
  it("the coarse block uses the same (0,2,0+) selectors as the base token block", () => {
    const blocks = mediaBlocks(tokens, /\(pointer:\s*coarse\)/);
    const withVars = blocks.find((b) => b.includes("--v2-control-h"));
    expect(withVars).toBeTruthy();
    const sel = selectorsOf(withVars!.slice(0, withVars!.indexOf("{")));
    for (const s of [":root", ":root[data-theme]", ":root[data-skin]", ":root[data-theme][data-skin]"]) expect(sel).toContain(s);
  });
  it("every control height is >= 44px on touch (including -sm)", () => {
    const b = mediaBlocks(tokens, /\(pointer:\s*coarse\)/).join("\n");
    expect(b).toMatch(/--v2-control-h:\s*44px/);
    expect(b).toMatch(/--v2-control-h-sm:\s*44px/);
    expect(b).toMatch(/--v2-row-h:\s*var\(--v2-row-h-touch\)/);
    const touch = tokens.match(/--v2-row-h-touch:\s*(\d+)px/);
    expect(Number(touch?.[1])).toBeGreaterThanOrEqual(44);
  });
});

describe("finding 25: .v2-conn gets a 44px target on coarse pointers", () => {
  it("has a 44px box or a 44px ::after hit area in a coarse block", () => {
    const b = mediaBlocks(shell, /\(pointer:\s*coarse\)/).join("\n");
    // Either a 44 px box, or (D2: no visual bloat) a >= 44 px ::after hit area.
    const box = b.split("}").find((r) => /(^|[\s,])\.v2-conn\s*(,|\{)/.test(r) && /min-height:\s*44px/.test(r));
    const hit = b.split("}").find((r) => /\.v2-conn::after/.test(r));
    expect(box || hit).toBeTruthy();
    if (box) expect(box).toMatch(/min-width:\s*44px/);
    else expect(hit).toMatch(/max\(100%,\s*44px\)/);
  });
});

describe("finding 27: letter avatars are AA against the avatar text for every hue", () => {
  it("cloud/projects/avatars.tsx uses the shared palette (no private hue formula)", () => {
    expect(avatarsSrc).toMatch(/paletteColor|avatarColors/);
    expect(avatarsSrc).not.toMatch(/hsl\(\$\{h\}/);
  });
  it("primitives/Avatar.tsx: fill + initial come from the theme tone tokens", () => {
    expect(avatarSrc).toMatch(/hsl\(\$\{h\} var\(--v2-av-fill-s, 34%\) var\(--v2-av-fill-l, 28%\)\)/);
    expect(avatarSrc).toMatch(/hsl\(\$\{h\} var\(--v2-av-ink-s, 72%\) var\(--v2-av-ink-l, 86%\)\)/);
  });
  // every hue, both themes: the initial is AA on its own fill
  const lightBlock = tokens.slice(tokens.indexOf(':root[data-theme="light"]'));
  const pct = (css: string, name: string) => Number(css.match(new RegExp(`--${name}:\\s*(\\d+)%`))![1]);
  for (const [theme, css] of [["dark", tokens], ["light", lightBlock]] as const) {
    it(`initials are >= 4.5:1 on their fill for every hue (${theme})`, () => {
      const [fs, fl, is, il] = ["v2-av-fill-s", "v2-av-fill-l", "v2-av-ink-s", "v2-av-ink-l"].map((n) => pct(css, n));
      let worst = Infinity;
      for (let h = 0; h < 360; h++) worst = Math.min(worst, contrast(hsl(h, fs, fl), hsl(h, is, il)));
      expect(worst).toBeGreaterThanOrEqual(4.5);
    });
  }
});

describe("finding 28: 'in convo' resident chip text is AA on the selected row", () => {
  it("uses accent-hover text and clears 4.5:1 over accent-soft on --v2-selected", () => {
    const rule = agentsCss.split("}").find((r) => r.includes(".rlive.resident"));
    expect(rule).toMatch(/color:\s*var\(--v2-accent-hover\)/);
    const soft = tokens.match(/--v2-accent-soft:\s*rgba\((\d+),\s*(\d+),\s*(\d+),\s*([\d.]+)\)/)!;
    // --v2-selected is a translucent overlay (Linear retune); its opaque
    // equivalent over the panel is --v2-selected-solid.
    const bg = over([+soft[1], +soft[2], +soft[3]], +soft[4], token("v2-selected-solid"));
    expect(contrast(token("v2-accent-hover"), bg)).toBeGreaterThanOrEqual(4.5);
  });
});

describe("finding 29: focusable tabpanel keeps a visible focus indicator", () => {
  it("does not null the ring; uses an inset focus ring", () => {
    const rules = prims.split("}").filter((r) => r.includes(".v2-tabpanel:focus-visible"));
    expect(rules.length).toBeGreaterThan(0);
    for (const r of rules) {
      expect(r).not.toMatch(/box-shadow:\s*none/);
      expect(r).not.toMatch(/outline:\s*none\s*;?\s*$/);
    }
    expect(rules.join("}")).toMatch(/box-shadow:\s*var\(--v2-focus-ring-inset\)/);
  });
  it("the inset ring token insets EVERY layer (round-2: `inset var(--v2-focus-ring)` left the accent layer outset)", () => {
    const m = tokens.match(/--v2-focus-ring-inset:\s*([^;]+);/);
    expect(m).toBeTruthy();
    const layers = m![1].split(/,(?![^(]*\))/).map((l) => l.trim());
    expect(layers.length).toBeGreaterThanOrEqual(2);
    for (const l of layers) expect(l.startsWith("inset")).toBe(true);
    expect(layers[0]).toMatch(/var\(--v2-accent\)/);
  });
});

describe("D2: Linear-style buttons", () => {
  it("buttons are 28 px (md) / 24 px (sm) visual and NOT raised on touch", () => {
    expect(tokens).toMatch(/--v2-btn-h:\s*28px/);
    expect(tokens).toMatch(/--v2-btn-h-sm:\s*24px/);
    const coarse = mediaBlocks(tokens, /\(pointer:\s*coarse\)/).join("\n");
    expect(coarse).not.toMatch(/--v2-btn-h/);
    const btn = prims.split("}").find((r) => /^\s*\.v2-btn\s*\{/.test(r));
    expect(btn).toMatch(/height:\s*var\(--v2-btn-h\)/);
    expect(btn).toMatch(/border-radius:\s*var\(--v2-radius-control\)/);
    expect(btn).toMatch(/font-size:\s*var\(--v2-fs-btn\)/);
  });
  it("coarse pointers get a >= 44 px hit area via ::after (buttons, icon buttons, legacy .btn)", () => {
    const b = mediaBlocks(prims, /\(pointer:\s*coarse\)/).join("\n");
    const rule = b.split("}").find((r) => r.includes(".v2-btn::after"));
    expect(rule).toBeTruthy();
    for (const sel of [".v2-iconbtn::after", ".btn::after"]) expect(rule).toContain(sel);
    expect(rule).toMatch(/max\(100%,\s*44px\)/);
    // no visual bloat for legacy .btn on touch
    expect(b).not.toMatch(/\.btn[^{]*\{[^}]*min-height:\s*44px/);
  });
  it("danger is subtle (red text, no solid red fill) and there is no solid green approve slab", () => {
    const danger = prims.split("}").find((r) => /^\s*\.v2-btn-danger\s*\{/.test(r))!;
    expect(danger).toMatch(/color:\s*var\(--v2-danger\)/);
    expect(danger).not.toMatch(/background:\s*var\(--v2-danger\)/);
    expect(prims).not.toMatch(/\.v2-btn-approve\s*\{/);
    const legacyApprove = prims.split("}").find((r) => /^\s*\.btn\.approve\s*\{/.test(r))!;
    expect(legacyApprove).toMatch(/background:\s*var\(--v2-primary-bg\)/);
    const legacyDanger = prims.split("}").find((r) => /^\s*\.btn\.danger,\s*\.btn\.stop\s*\{/.test(r))!;
    expect(legacyDanger).toMatch(/color:\s*var\(--v2-danger\)/);
  });
});

describe("D3: no coloured left stripes on rows", () => {
  it("selected rows use a background only", () => {
    expect(prims).not.toMatch(/\.v2-row\.is-selected::before/);
    expect(prims).not.toMatch(/border-left:\s*\d+px\s+solid\s+var\(--v2-(accent|warn|danger|ok|info)\)/);
  });
});

describe("human identity is neutral (no amber ring / amber HUMAN badge)", () => {
  it("re-skins .av.human and .kind.human without --v2-warn", () => {
    const av = prims.split("}").find((r) => /\.av\.human/.test(r))!;
    expect(av).not.toMatch(/--v2-warn/);
    const kind = prims.split("}").find((r) => /\.kind\.human/.test(r))!;
    expect(kind).not.toMatch(/--v2-warn|--amber/);
    expect(kind).toMatch(/color:\s*var\(--v2-text-2\)/);
  });
});

describe("finding 30: reduced motion also disables smooth scrolling", () => {
  it("the universal reduced-motion rule sets scroll-behavior:auto !important", () => {
    const b = mediaBlocks(tokens, /\(prefers-reduced-motion:\s*reduce\)/).join("\n");
    const rule = b.split("}").find((r) => /\*\s*,\s*\*::before/.test(r));
    expect(rule).toMatch(/scroll-behavior:\s*auto\s*!important/);
  });
});
