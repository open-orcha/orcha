// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it } from "vitest";
import type { QaAuthority } from "../../authority";
import type { Scenario } from "./lib/types";
import { DraftList } from "./draft-list";

function draft(id: string, name: string, target_kind: Scenario["target_kind"]): Scenario {
  return {
    id,
    name,
    target_kind,
    status: "draft",
    category: null,
    criteria: ["a", "b"],
    depends_on: [],
    tags: [],
    data: {},
    created_at: "2026-10-05T10:00:00Z",
  } as unknown as Scenario;
}

afterEach(cleanup);

function renderList(drafts: Scenario[]) {
  return render(createElement(DraftList, { drafts, pendingIds: new Set<string>(), onJump: () => {}, auth: { can: true, human: null, reason: null } as QaAuthority }));
}

describe("DraftList platform scope", () => {
  it("says each draft's platform as a chip and drops the (iOS) name suffix", () => {
    const { container } = renderList([draft("i", "Navigate the main tabs (iOS)", "ios"), draft("s", "Sign in", null)]);
    const rows = container.querySelectorAll("[data-draft-row]");
    expect(rows[0].textContent).toContain("Navigate the main tabs");
    expect(rows[0].textContent).not.toContain("(iOS)");
    expect(rows[0].querySelector("[data-platform-scope='ios']")?.textContent).toBe("iOS only");
    expect(rows[1].querySelector("[data-platform-scope='all']")?.textContent).toBe("All platforms");
  });

  it("shows no scope chips when no draft is pinned (a one-platform project)", () => {
    const { container } = renderList([draft("s", "Sign in", null)]);
    expect(container.querySelector("[data-platform-scope]")).toBeNull();
  });
});
