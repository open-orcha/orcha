import { describe, expect, it } from "vitest";
import { qaReviseTaskBody, qaTaskBody } from "../../runQa";

const base = { kind: "draft" as const, platform: "ios" as const, focus: "", agentAlias: "forge", humanId: "h1" };

describe("what a drafting task tells its agent to read", () => {
  it("states each source: the skill's flag and a plain line", () => {
    const code = qaTaskBody({ ...base, sources: "code" }).description;
    expect(code).toContain("/orcha-qa-draft for this task on ios --sources code");
    expect(code).toContain("Read the code only");
    expect(code).not.toContain("--minutes");
    const past = qaTaskBody({ ...base, sources: "past" }).description;
    expect(past).toContain("--sources both");
    expect(past).toContain("newest three completed explorations");
  });

  it("gives a new exploration its minutes", () => {
    const fresh = qaTaskBody({ ...base, sources: "new", minutes: 15 }).description;
    expect(fresh).toContain("--sources code --explore --minutes 15");
    expect(fresh).toContain("explore the app first in this same task");
  });

  it("leaves the other kinds and a drafting with no choice as they were", () => {
    expect(qaTaskBody({ ...base }).description.split("\n")[0]).toBe("Run /orcha-qa-draft for this task on ios");
    expect(qaTaskBody({ ...base, kind: "check", sources: "code" }).description).not.toContain("--sources");
  });
});

describe("the task Revise with Embodent creates", () => {
  it("names the draft and quotes the person's feedback, for its agent", () => {
    const b = qaReviseTaskBody({ scenarioId: "s1", name: "Create a routine", feedback: 'It says "Create routine"', platform: "web", agentAlias: "forge", humanId: "h1" });
    expect(b.title).toBe("Revise the draft: Create a routine");
    expect(b.assignee_alias).toBe("forge");
    expect(b.created_by_agent_id).toBe("h1");
    expect(b.description).toContain("Scenario: s1 (Create a routine)");
    expect(b.description).toContain("It says 'Create routine'");
    expect(b.description).toContain("revise_scenario");
  });
});
