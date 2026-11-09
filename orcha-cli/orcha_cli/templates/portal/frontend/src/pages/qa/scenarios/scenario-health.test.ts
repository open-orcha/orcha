import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isInstruction, isSuspicious, suspiciousReasons } from "./scenario-health";

interface Case {
  name: string;
  description: string | null;
  criteria: string[];
  expect: string[];
}

const CASES = (JSON.parse(readFileSync(join(__dirname, "health/cases.json"), "utf8")) as { suspicious: Case[] }).suspicious;

describe("suspiciousReasons (shared with Python via db/scenario-health-cases.json)", () => {
  it.each(CASES.map((c) => [c.name, c] as const))("%s", (_name, c) => {
    expect(suspiciousReasons(c.name, c.description, c.criteria).map((r) => r.code)).toEqual(c.expect);
  });

  it("names what it matched", () => {
    const [task, work] = suspiciousReasons("Embodent 64cc305f · Questions board: fix QA issues and open a PR (do not merge)");
    expect(task.matched).toEqual(["Embodent 64cc305f"]);
    expect(work.matched).toEqual(expect.arrayContaining(["open a pr", "do not merge", "qa issues", "fix"]));
  });

  it("tells instructions from user actions", () => {
    expect(isInstruction("Write unit tests for the board")).toBe(true);
    expect(isInstruction("Open Settings from the profile menu")).toBe(false);
  });

  it("reads criteria stored as JSON text", () => {
    expect(isSuspicious({ name: "Questions board", criteria: JSON.stringify(["Open a PR against main"]) })).toBe(true);
    expect(isSuspicious({ name: "Sign in", criteria: "not json" })).toBe(false);
  });
});
