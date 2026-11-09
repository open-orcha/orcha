// @vitest-environment jsdom
/**
 * The way back from a run to its exploration: the run page's header link (live and finished,
 * explorer and drafter).
 */
import { cleanup, render } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const nav = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock("../map/kit/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: unknown }) => createElement("a", { href, ...rest }, children as never),
  Link: ({ href, children, ...rest }: { href: string; children: unknown }) => createElement("a", { href, ...rest }, children as never),
}));
vi.mock("../map/kit/root", () => ({ useRouter: () => ({ push: nav.push, replace: vi.fn(), refresh: vi.fn() }) }));

import { ExplorationBackLink, ExplorationChip } from "./exploration-way-back";
import type { RunExploration } from "./exploration-link";

const exploring: RunExploration = {
  id: "e1",
  name: "Deep dive · Properties",
  status: "exploring",
  recipe: "explore",
  minutes: 6,
  started_at: "2026-10-21T10:06:00.000Z",
  study_done_at: "2026-10-21T10:08:12.000Z",
  finished_at: null,
  role: "explorer",
};

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-21T10:10:00.000Z"));
  nav.push.mockReset();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("ExplorationBackLink (the run page's header)", () => {
  it("a map run says mapping, never exploring", () => {
    const { container } = render(createElement(ExplorationBackLink, { exploration: { ...exploring, recipe: "map" } }));
    const link = container.querySelector("[data-exploration-back]") as HTMLAnchorElement;
    expect(link.textContent).toContain("Back to mapping");
    expect(link.querySelector("[data-exploration-phase]")?.textContent).toContain("Mapping");
  });

  it("goes back to a live exploration, saying its phase and time left, with a pulse", () => {
    const { container } = render(createElement(ExplorationBackLink, { exploration: exploring }));
    const link = container.querySelector("[data-exploration-back]") as HTMLAnchorElement;
    expect(link.getAttribute("href")).toBe("/qa?view=sessions&session=e1");
    expect(link.textContent).toContain("Back to exploration");
    expect(link.querySelector("[data-exploration-phase]")?.textContent).toBe("Exploring · 4:12 left");
    expect(link.querySelector("[data-exploration-live]")).not.toBeNull();
    expect(link.getAttribute("aria-label")).toBe("Back to exploration Deep dive · Properties, Exploring · 4:12 left");
  });

  it("goes back to a finished exploration's debrief, without a pulse", () => {
    const { container } = render(createElement(ExplorationBackLink, { exploration: { ...exploring, status: "done", finished_at: "2026-10-21T10:09:00.000Z" } }));
    const link = container.querySelector("[data-exploration-back]") as HTMLAnchorElement;
    expect(link.getAttribute("href")).toBe("/qa?view=sessions&session=e1");
    expect(link.querySelector("[data-exploration-phase]")?.textContent).toBe("Done");
    expect(link.querySelector("[data-exploration-live]")).toBeNull();
  });

  it("says the drafter of a paired exploration drafts for it", () => {
    const { container } = render(createElement(ExplorationBackLink, { exploration: { ...exploring, role: "drafter" } }));
    const link = container.querySelector("[data-exploration-back]") as HTMLAnchorElement;
    expect(link.getAttribute("href")).toBe("/qa?view=sessions&session=e1");
    expect(link.getAttribute("title")).toMatch(/^This run drafts scenarios for Deep dive · Properties/);
  });
});

describe("ExplorationChip (the theater's live band, the live wall)", () => {
  it("links the exploration by name and pulses while it is live", () => {
    const { container } = render(createElement(ExplorationChip, { exploration: exploring }));
    const chip = container.querySelector("[data-exploration-chip]") as HTMLAnchorElement;
    expect(chip.getAttribute("href")).toBe("/qa?view=sessions&session=e1");
    expect(chip.textContent).toBe("Deep dive · Properties");
    expect(chip.querySelector("[data-exploration-live]")).not.toBeNull();
  });
});
