/** Integration r2: ONE shared HelpTip replaces the per-page "?" shims. */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { HelpTip } from "./HelpTip";

describe("HelpTip", () => {
  it("is a focusable button named by the tip (or an explicit label)", () => {
    render(<><HelpTip tip="Why this matters" /><HelpTip tip={<b>rich</b>} label="About keys" /></>);
    expect(screen.getByRole("button", { name: "Why this matters" }).className).toContain("v2-help");
    expect(screen.getByRole("button", { name: "About keys" })).toBeInTheDocument();
  });
  it("no page re-implements the help glyph (old shim classes are gone)", () => {
    const src = resolve(__dirname, "../..");
    const files: string[] = [];
    const walk = (d: string) => { for (const f of readdirSync(d)) { const p = join(d, f); if (statSync(p).isDirectory()) walk(p); else if (/\.(tsx?|css)$/.test(f) && !/\.test\./.test(f)) files.push(p); } };
    walk(src);
    const hits = files.filter((f) => /className="(ov|ob|cs)-help"/.test(readFileSync(f, "utf8")));
    expect(hits).toEqual([]);
  });
});
