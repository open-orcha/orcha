// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorkPhaseBar } from "./phase-bar";
import { CountRing, WorkOutputs, WorkSummary } from "./work-done";
import { WorkCalm, WorkFact, WorkFacts, WorkLive, WorkLog } from "./work-live";
import { WorkTitle } from "./work-title";

beforeEach(() => {
  vi.stubGlobal("matchMedia", () => ({ matches: true, addEventListener: () => {}, removeEventListener: () => {} }));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("WorkTitle", () => {
  it("keeps the actions in one order: Stop or Run again, the brief, the run, More", () => {
    render(
      createElement(WorkTitle, {
        name: "Draft the gaps",
        status: "running",
        doing: "Drafting",
        startedAt: new Date(Date.now() - 266_000).toISOString(),
        cost: "$4.12",
        more: createElement("button", { "data-k": "more" }, "More"),
        openRun: createElement("a", { "data-k": "run" }, "Open the run"),
        brief: createElement("button", { "data-k": "brief" }, "What Embodent was told"),
        primary: createElement("button", { "data-k": "stop" }, "Stop"),
      }),
    );
    const order = [...document.querySelectorAll("[data-work-actions] [data-k]")].map((el) => el.getAttribute("data-k"));
    expect(order).toEqual(["stop", "brief", "run", "more"]);
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Draft the gaps");
    expect(document.querySelector("[data-work-status]")?.textContent).toBe("Drafting");
    expect(document.querySelector("[data-work-elapsed]")?.textContent).toMatch(/^4:2\d$/);
    expect(document.querySelector("[data-work-cost]")?.textContent).toBe("$4.12");
  });

  it("says a subscription job's cost at API prices, with 'Not charged' in its tooltip", () => {
    const title = "Not charged: this runs on your Claude Code subscription. At API prices it would be $0.88.";
    render(createElement(WorkTitle, { name: "Deep dive · Login", status: "done", durationS: 444, cost: "≈$0.88 at API prices", costTitle: title }));
    const cost = document.querySelector("[data-work-cost]");
    expect(cost?.textContent).toBe("≈$0.88 at API prices");
    expect(cost?.getAttribute("title")).toBe(title);
  });

  it("says how long a finished job took", () => {
    render(createElement(WorkTitle, { name: "Map the app", status: "done", durationS: 524 }));
    expect(document.querySelector("[data-work-status]")?.textContent).toBe("Done");
    expect(document.querySelector("[data-work-elapsed]")?.textContent).toBe("Took 8m 44s");
  });
});

describe("WorkPhaseBar", () => {
  it("shows only the job's phases, the current one marked for assistive tech", () => {
    render(createElement(WorkPhaseBar, { phases: ["read", "explore", "review"], current: "explore", caption: "4:26 / 8:00" }));
    const items = [...document.querySelectorAll("[data-phase]")];
    expect(items.map((li) => li.getAttribute("data-phase"))).toEqual(["read", "explore", "review"]);
    expect(items.map((li) => li.getAttribute("data-phase-state"))).toEqual(["done", "active", "todo"]);
    expect(items[1].getAttribute("aria-current")).toBe("step");
    expect(document.querySelector("[data-phase-clock]")?.textContent).toBe("4:26 / 8:00");
  });
});

describe("the live view", () => {
  it("lays out what Embodent sees and what it produces", () => {
    render(createElement(WorkLive, { sees: createElement("p", null, "device"), produces: createElement("p", null, "drafts") }));
    expect(screen.getByRole("region", { name: "What Embodent sees" }).textContent).toBe("device");
    expect(screen.getByRole("region", { name: "What Embodent is producing" }).textContent).toBe("drafts");
  });

  it("logs the newest lines with counters that move, never the window size", () => {
    const lines = Array.from({ length: 12 }, (_, i) => `Reading file-${i}.ts`);
    render(createElement(WorkLog, { lines, counters: "84 files read · 66 searches", live: true }));
    expect(document.querySelector("[data-work-log-counters]")?.textContent).toBe("84 files read · 66 searches");
    const shown = [...document.querySelectorAll("[data-work-log-line]")];
    expect(shown).toHaveLength(8);
    expect(shown.at(-1)?.textContent).toBe("Reading file-11.ts");
    expect(document.querySelector("[data-work-log]")?.textContent).not.toMatch(/\b12\b/);
  });

  it("says what is normal and which file is being read", () => {
    render(createElement(WorkCalm, { line: "Reading 84 files: the first drafts usually land within a few minutes.", file: "snuglog-ios/SnugLog/Views/Today/QuickNotesSheet.swift" }));
    expect(document.querySelector("[data-work-calm]")?.textContent).toContain("Reading 84 files");
    expect(document.querySelector("[data-work-newest-file]")?.textContent).toContain("QuickNotesSheet.swift");
  });

  it("lists the facts in one shape", () => {
    render(createElement(WorkFacts, null, createElement(WorkFact, { label: "Reading" }, "Code + past explorations")));
    expect(screen.getByText("Reading").tagName).toBe("DT");
    expect(screen.getByText("Code + past explorations").tagName).toBe("DD");
  });
});

describe("the done view", () => {
  it("shows the ring, the verdict and the tiles", () => {
    render(
      createElement(WorkSummary, {
        ring: createElement(CountRing, { value: 4, of: 16, label: "accepted" }),
        verdict: "16 drafted for the gaps",
        tiles: [
          { label: "Drafted", value: "16" },
          { label: "Files read", value: "44" },
        ],
      }),
    );
    expect(screen.getByRole("img", { name: "4 of 16 accepted" })).toBeTruthy();
    expect(document.querySelector("[data-verdict]")?.textContent).toBe("16 drafted for the gaps");
    expect([...document.querySelectorAll("[data-work-tile]")].map((t) => t.getAttribute("data-work-tile"))).toEqual(["Drafted", "Files read"]);
  });

  it("gives every output its next step", () => {
    render(
      createElement(WorkOutputs, {
        items: [{ key: "drafts", icon: null, title: "16 drafts to review", action: createElement("a", { href: "#deck" }, "Review drafts") }],
      }),
    );
    expect(screen.getByRole("link", { name: "Review drafts" })).toBeTruthy();
  });
});
