import { describe, expect, it } from "vitest";
import type { Scenario } from "./adapt";
import { scenarioToMarkdown } from "./scenario-markdown";

describe("a scenario as markdown", () => {
  it("writes metadata, criteria and checks, and names dependencies", () => {
    const s = { name: "Pay", target_kind: "ios", category: "Checkout", persona: null, status: "validated", tags: ["smoke"], needs: [], depends_on: ["a"], data: { plan: "pro" }, description: "Pay by card.", criteria: ["Total shows", "Receipt shows"], checks: { criteria: { "1": ['text "Paid"'] }, scenario: ["Screen Cart"] } } as unknown as Scenario;
    expect(scenarioToMarkdown(s, new Map([["a", { name: "Sign in" }]]))).toBe(
      ["# Pay", "", "- Platform: iOS", "- Category: Checkout", "- Status: Validated", "- Tags: smoke", "- Depends on: Sign in", "- Data: plan=pro", "", "Pay by card.", "", "Check: Screen Cart", "1. Total shows", "2. Receipt shows", '   Check: text "Paid"', ""].join("\n"),
    );
  });
});
