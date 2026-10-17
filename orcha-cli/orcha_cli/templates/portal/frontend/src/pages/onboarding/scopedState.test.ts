/** QA (arch §4): onboarding drafts are keyed by project (cid) and never resume in another project. */
import { beforeEach, describe, expect, it } from "vitest";
import { KEY, loadState, saveState, scopedKey } from "./logic";

beforeEach(() => localStorage.clear());

describe("onboarding state scope", () => {
  it("a draft saved for project A never loads in project B on a multi-project origin", () => {
    const s = loadState("A", true);
    s.step = "propose-roster";
    s.tasks = [{ title: "A's task", dod: "done" } as never];
    saveState(s, "A", true);
    expect(localStorage.getItem(scopedKey("A"))).toContain("A's task");
    expect(localStorage.getItem(KEY)).toBeNull(); // no unscoped copy on multi origins
    const b = loadState("B", true);
    expect(b.step).toBe("welcome");
    expect(b.tasks).toEqual([]);
  });
  it("the legacy unscoped key is ignored on multi-project origins (and never deleted)", () => {
    localStorage.setItem(KEY, JSON.stringify({ step: "create-tasks", tasks: [{ title: "legacy" }] }));
    expect(loadState("B", true).step).toBe("welcome");
    expect(localStorage.getItem(KEY)).not.toBeNull();
  });
  it("single-container stacks adopt the legacy key and mirror writes to it (rollback-safe)", () => {
    localStorage.setItem(KEY, JSON.stringify({ step: "create-tasks" }));
    const s = loadState("only", false);
    expect(s.step).toBe("create-tasks");
    s.step = "fork";
    saveState(s, "only", false);
    expect(JSON.parse(localStorage.getItem(KEY)!).step).toBe("fork");
    expect(JSON.parse(localStorage.getItem(scopedKey("only"))!).step).toBe("fork");
  });
  it("without a resolved cid nothing is loaded or persisted", () => {
    localStorage.setItem(KEY, JSON.stringify({ step: "create-tasks" }));
    expect(loadState(null).step).toBe("welcome");
    saveState(loadState(null), null);
    expect(Object.keys(localStorage).filter((k) => k.startsWith("orcha:v2:onboarding"))).toEqual([]);
  });
});
