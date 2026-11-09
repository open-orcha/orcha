import { describe, expect, it } from "vitest";
import { buildChecks, editOf, reconcileSavedDraft } from "./scenario-panel";

const draft = { session: null, target_kind: "ios" as const, name: "A", category: null, persona: null, description: null, criteria: ["x", "y"], status: "draft" as const, depends_on: [], tags: [] };
const none = { criteria: {}, scenario: [] };

describe("the scenario panel", () => {
  it("keeps a field edited while the save was in flight", () => {
    expect(reconcileSavedDraft({ name: "typed on", persona: "p " }, { name: "typed", persona: "p " }, { name: "typed", persona: "p" })).toEqual({ name: "typed on", persona: "p" });
  });

  it("sends only what changed", () => {
    expect(editOf(draft, { ...draft, name: "B" }, { saved: { a: 1 }, next: { a: "1" } }, { saved: [], next: [] }, { saved: none, next: none })).toEqual({ name: "B" });
    expect(editOf(draft, draft, { saved: {}, next: { a: "b" } }, { saved: ["reset"], next: [] }, { saved: none, next: { criteria: { "1": ["Button A"] }, scenario: ["Screen B"] } })).toEqual({
      data: { a: "b" },
      needs: [],
      checks: [{ criterion_index: null, line: "Screen B" }, { criterion_index: 1, line: "Button A" }],
    });
  });

  it("builds checks per criterion and keeps the scenario's own", () => {
    expect(buildChecks(["", '  text "Hi"  \n\n'], ["Screen B"])).toEqual({ criteria: { "1": ['text "Hi"'] }, scenario: ["Screen B"] });
  });
});
