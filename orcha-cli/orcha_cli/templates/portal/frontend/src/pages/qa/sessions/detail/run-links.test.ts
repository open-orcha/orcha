// @vitest-environment jsdom
/** The exploration page's way to its explorer run(s): "Watch the live run" / "Open the run". */
import { cleanup, render } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../map/kit/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: unknown }) => createElement("a", { href, ...rest }, children as never),
  Link: ({ href, children, ...rest }: { href: string; children: unknown }) => createElement("a", { href, ...rest }, children as never),
}));

import { ExplorationRunLinks, currentRunLinks, runLinkLabel , type ExplorationRunLink } from "./run-links";

afterEach(cleanup);

const own: ExplorationRunLink = { explorationId: "e1", requestId: "q1", runId: "run-1", kind: "web", live: true };
const ios: ExplorationRunLink = { explorationId: "e2", requestId: "q2", runId: "run-2", kind: "ios", live: false };

describe("currentRunLinks", () => {
  it("follows the live row: its own run turns finished when the face stops running", () => {
    expect(currentRunLinks([own, ios], { explorationId: "e1", runId: "run-1", kind: "web", running: false })).toEqual([{ ...own, live: false }, ios]);
  });

  it("adds its own run once the row names it, when the page loaded before the run started", () => {
    expect(currentRunLinks([], { explorationId: "e1", runId: "run-9", kind: "android", running: true })).toEqual([
      { explorationId: "e1", requestId: null, runId: "run-9", kind: "android", live: true },
    ]);
    expect(currentRunLinks([], { explorationId: "e1", runId: null, kind: "web", running: true })).toEqual([]);
  });
});

describe("runLinkLabel", () => {
  it("says Watch the live run or Open the run for one run, and names the platform for several", () => {
    expect(runLinkLabel(own, false)).toBe("Watch the live run");
    expect(runLinkLabel({ ...own, live: false }, false)).toBe("Open the run");
    expect(runLinkLabel(own, true)).toBe("Web · Watch live");
    expect(runLinkLabel(ios, true)).toBe("iOS · Open run");
  });
});

describe("ExplorationRunLinks", () => {
  it("links the one run, live with a pulse", () => {
    const { container } = render(createElement(ExplorationRunLinks, { links: [own] }));
    const a = container.querySelectorAll("[data-exploration-run-link]");
    expect(a).toHaveLength(1);
    expect(a[0].getAttribute("href")).toBe("/qa?view=sessions&session=run-1&sub=run");
    expect(a[0].textContent).toBe("Watch the live run");
    expect(a[0].hasAttribute("data-run-live")).toBe(true);
  });

  it("links each platform's run when several explored together", () => {
    const { container } = render(createElement(ExplorationRunLinks, { links: [own, ios] }));
    const a = [...container.querySelectorAll("[data-exploration-run-link]")];
    expect(a.map((x) => [x.getAttribute("href"), x.textContent])).toEqual([
      ["/qa?view=sessions&session=run-1&sub=run", "Web · Watch live"],
      ["/qa?view=sessions&session=run-2&sub=run", "iOS · Open run"],
    ]);
  });

  it("says nothing before there is a run", () => {
    const { container } = render(createElement(ExplorationRunLinks, { links: [] }));
    expect(container.innerHTML).toBe("");
  });
});
