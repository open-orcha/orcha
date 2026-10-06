/**
 * VD-41: the bespoke inline controls get a 44 px tap area on touch (coarse
 * pointer) through the same invisible centred ::after as the primitives —
 * and the Properties disclosure row is 44 px tall.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { taskDetailCss as detailCss } from "../pages/tasks/detailCss";

const prim = readFileSync(resolve(__dirname, "../../../static/styles/v2-primitives.css"), "utf8");

function coarseBlocks(css: string): string {
  const out: string[] = [];
  let i = css.indexOf("@media (pointer: coarse)");
  while (i >= 0) {
    let depth = 0;
    let j = css.indexOf("{", i);
    const start = j;
    for (; j < css.length; j++) {
      if (css[j] === "{") depth++;
      else if (css[j] === "}" && --depth === 0) break;
    }
    out.push(css.slice(start, j));
    i = css.indexOf("@media (pointer: coarse)", j);
  }
  return out.join("\n");
}

describe("VD-41 touch targets", () => {
  const coarse = coarseBlocks(prim);
  for (const sel of [".v2-header .v2-crumbs li > a::after", ".gc-edit::after", ".nd-who::after", ".dlink::after", "button.v2-t-id::after", ".conv-skills::after", ".ab-col-name::after"]) {
    it(sel + " has a 44 px ::after under a coarse pointer", () => {
      expect(coarse).toContain(sel);
    });
  }
  it("the ::after is the shared 44 px centred box and its hosts are positioned", () => {
    expect(coarse).toMatch(/\.ab-col-name::after \{\s*content: ""; position: absolute; left: 50%; top: 50%;\s*width: max\(100%, 44px\); height: max\(100%, 44px\)/);
    expect(coarse).toMatch(/\.gc-edit, \.nd-who, \.dlink, button\.v2-t-id, a\.v2-t-id, \.conv-skills, \.ab-col-name \{ position: relative; \}/);
    expect(coarse).toContain(".v2-header > .v2-header-crumbs { align-self: stretch; }");
  });
  it("the task detail Properties toggle is a 44 px row on touch", () => {
    expect(coarseBlocks(detailCss)).toContain(".td-rail-toggle { height: 44px; }");
  });
});
