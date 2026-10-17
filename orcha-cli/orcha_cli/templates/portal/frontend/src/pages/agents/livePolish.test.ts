/**
 * Live chat polish — layout-independent guards:
 *  - the durable turn that replaces the live block gets NO enter animation (the swap is
 *    invisible: already-visible text never dims); new items still animate in;
 *  - the caret has zero layout width (an empty inline + absolutely positioned bar), so it
 *    never wraps onto its own line;
 *  - the live block has the durable turn's geometry (label 2px above the text, same body
 *    line-height, no flex gap for a collapsed rail to leave behind).
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { enterMotion } from "./Conversation";

const css = readFileSync(resolve(__dirname, "agents.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
const rule = (sel: string) => {
  const esc = sel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = css.match(new RegExp("(?:^|[}\\s])" + esc + "\\s*\\{([^}]*)\\}", "m"));
  return m ? m[1] : null;
};

function thread(...cls: string[]): HTMLElement[] {
  const list = document.createElement("div");
  return cls.map((c) => {
    const el = document.createElement("div");
    el.className = c;
    list.appendChild(el);
    return el;
  });
}

describe("enter motion", () => {
  it("the turn that replaces the live block does not animate (no opacity dip)", () => {
    const [, turn] = thread("conv-live is-owned", "v2-msg v2-msg-agent turn agent");
    expect(enterMotion(turn)).toBeNull();
  });
  it("other new items still enter, from invisible to fully visible", () => {
    const [, agent, user] = thread("v2-msg v2-msg-user turn human", "v2-msg v2-msg-agent turn agent", "v2-msg v2-msg-user turn human");
    for (const el of [agent, user]) {
      const m = enterMotion(el)!;
      expect(m).toBeTruthy();
      expect(m.frames[0].opacity).toBe(0);
      expect(m.frames[m.frames.length - 1].opacity).toBe(1);
    }
  });
});

describe("caret + live geometry CSS", () => {
  it("the caret takes no layout width: an empty inline, the bar is an absolute ::after", () => {
    const c = rule(".lt-caret")!;
    expect(c).toBeTruthy();
    expect(c).not.toMatch(/display\s*:\s*inline-block/);
    expect(c).not.toMatch(/(^|[;\s])width\s*:/);
    expect(c).not.toMatch(/margin/);
    expect(rule(".lt-caret::after")!).toMatch(/position\s*:\s*absolute/);
  });
  it("the live block matches the durable turn: no gap, label 2px above the text, same line-height", () => {
    const live = rule(".conv-live")!;
    expect(live).toMatch(/gap\s*:\s*0/);
    expect(live).toMatch(/line-height\s*:\s*1\.55/);
    expect(rule(".conv-live > .v2-worked")!).toMatch(/margin-bottom\s*:\s*2px/);
    expect(rule(".turn .worklog")!).toMatch(/margin\s*:\s*0 0 2px/);
    // a collapsed rail leaves no margin behind
    expect(rule(".lt-railwrap.is-gone")!).toMatch(/margin\s*:\s*0/);
  });
});
