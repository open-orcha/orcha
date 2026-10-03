/**
 * Round-2 contracts (primitives-a): D13 one palette per project roster (every
 * surface agrees, no collisions), failure-rate health thresholds, and the
 * dialog-popover stacking fix (New task Priority/Assignee menus).
 */
import { cleanup, render } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const roster = { agents: [{ alias: "lead" }, { alias: "backend-dev" }, { alias: "docs-writer" }, { alias: "reviewer" }, { alias: "infra" }, { alias: "hussein" }] };
let snap: typeof roster | null = roster;
vi.mock("../../state/SnapshotProvider", () => ({ useSnapshot: () => ({ snap }) }));

import { Avatar, AvatarStack, assignPalette, actorKey, paletteColor, rosterPaletteSlots, healthFromFailures, HEALTH_RULE } from "./index";
import { Avatar as LegacyAvatar } from "../ui";

afterEach(() => { cleanup(); snap = roster; });

const bg = (el: Element) => (el as HTMLElement).style.background;

describe("D13 roster palette parity", () => {
  it("the same agent has one colour on every surface, whatever local slots a page passes", () => {
    const { container } = render(
      <>
        {/* sidebar: live agents only, no palette */}
        <Avatar alias="docs-writer" kind="ai" size={16} decorative />
        {/* board: its own list order → a different local slot */}
        <Avatar alias="docs-writer" kind="ai" size={20} decorative palette={assignPalette(["docs-writer"]).get("docs-writer")} />
        {/* legacy ui.tsx wrapper (popovers, inbox) */}
        <LegacyAvatar alias="@docs-writer" kind="ai" size="sm" decorative />
      </>,
    );
    const avs = [...container.querySelectorAll(".v2-av")];
    expect(avs).toHaveLength(3);
    const want = paletteColor(rosterPaletteSlots(roster.agents)!.get("docs-writer")!).background;
    // jsdom normalises hsl() → rgb(); compare against a rendered reference
    const ref = render(<span style={{ background: want }} />).container.firstElementChild!;
    for (const a of avs) expect(bg(a)).toBe(bg(ref));
  });

  it("every roster member gets a distinct colour (subset lists stay collision-free)", () => {
    const { container } = render(
      <>{roster.agents.map((a) => <Avatar key={a.alias} alias={a.alias} kind="ai" decorative />)}</>,
    );
    const colours = [...container.querySelectorAll(".v2-av")].map(bg);
    expect(new Set(colours).size).toBe(roster.agents.length);
  });

  it("stacks follow the roster too", () => {
    const { container } = render(
      <>
        <AvatarStack actors={[{ alias: "infra" }, { alias: "reviewer" }]} />
        <Avatar alias="reviewer" decorative />
      </>,
    );
    const avs = [...container.querySelectorAll(".v2-av")];
    expect(bg(avs[1])).toBe(bg(avs[2]));
  });

  it("aliases outside the roster keep the page's slot, then the hash", () => {
    snap = null;
    const { container } = render(<><Avatar alias="ghost" palette={3} decorative /><Avatar alias="ghost" palette={3} decorative /></>);
    const [a, b] = [...container.querySelectorAll(".v2-av")];
    expect(bg(a)).toBe(bg(b));
    const ref = render(<span style={{ background: paletteColor(3).background }} />).container.firstElementChild!;
    expect(bg(a)).toBe(bg(ref));
  });

  it("the roster map is memoised per snapshot agents array and matches assignPalette", () => {
    const a = rosterPaletteSlots(roster.agents);
    expect(rosterPaletteSlots(roster.agents)).toBe(a);
    expect([...a!.entries()]).toEqual([...assignPalette(roster.agents.map((x) => actorKey(x.alias))).entries()]);
    expect(rosterPaletteSlots([])).toBeNull();
  });
});

describe("health from failure rate", () => {
  it("one failure in 71 runs is on track; thresholds 5% / 20%", () => {
    expect(healthFromFailures(1, 71)).toBe("on_track");
    expect(healthFromFailures(0, 10)).toBe("on_track");
    expect(healthFromFailures(1, 20)).toBe("at_risk");
    expect(healthFromFailures(3, 20)).toBe("at_risk");
    expect(healthFromFailures(4, 20)).toBe("off_track");
    expect(healthFromFailures(5, 5)).toBe("off_track");
  });
  it("no runs → no data (never a default On track)", () => {
    expect(healthFromFailures(0, 0)).toBe("no_data");
    expect(healthFromFailures(null, undefined)).toBe("no_data");
  });
  it("the rule text names the thresholds", () => {
    expect(HEALTH_RULE).toMatch(/5%/);
    expect(HEALTH_RULE).toMatch(/20%/);
  });
});

describe("popover stacking over dialogs", () => {
  const css = readFileSync(resolve(__dirname, "../../../../static/styles/v2-primitives.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  it("a popover opened after a dialog overlay sits above it", () => {
    expect(css).toMatch(/\.v2-overlay\s*~\s*\.v2-popover\s*\{[^}]*z-index:\s*calc\(var\(--v2-z-dialog\)\s*\+\s*1\)/);
    expect(css).toMatch(/\.overlay\.show\s*~\s*\.v2-popover\s*\{[^}]*z-index:\s*81/);
  });
  it("project avatars are circles regardless of page stylesheets", () => {
    expect(css).toMatch(/\.proj-av\.proj-av[^{]*\{[^}]*border-radius:\s*50%/);
  });
});
