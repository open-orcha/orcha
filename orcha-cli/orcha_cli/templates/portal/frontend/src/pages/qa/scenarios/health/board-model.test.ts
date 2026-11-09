import { describe, expect, it } from "vitest";
import { groupAudit, rowKey, scenariosNeedingALook, selectedRows, suggestedName } from "./board-model";
import type { HealthAudit } from "./types";

const audit: HealthAudit = {
  project_id: "p",
  computed_at: "2026-10-16T12:00:00Z",
  total: 40,
  counts: { suspicious: 2, duplicate: 1 },
  scenarios: [
    {
      id: "b",
      name: "Embodent 64cc305f · Questions board: fix QA issues and open a PR (do not merge)",
      status: "validated",
      target_kind: null,
      flags: [
        { scenario_id: "b", kind: "suspicious", reason: "r", action: "drafts" },
        { scenario_id: "b", kind: "env_failing", reason: "r", action: "fix_env", dismissed_at: "2026-10-16T12:00:00Z" },
      ],
    },
    { id: "a", name: "Embodent 3c96e42c · Build the Questions board (website only, local branch)", status: "validated", target_kind: null, flags: [{ scenario_id: "a", kind: "suspicious", reason: "r", action: "drafts" }] },
    { id: "c", name: "Sign in (web)", status: "validated", target_kind: "web", flags: [{ scenario_id: "c", kind: "duplicate", reason: "r", action: "merge" }] },
  ],
};

describe("groupAudit", () => {
  it("groups open flags by kind in order, sorted by name, and sets dismissed ones apart", () => {
    const { groups, kept, open } = groupAudit(audit);
    expect(groups.map((g) => g.kind)).toEqual(["suspicious", "duplicate"]);
    expect(groups[0].rows.map((r) => r.scenario.id)).toEqual(["a", "b"]);
    expect(kept.map((r) => r.key)).toEqual(["b:env_failing"]);
    expect(open).toBe(3);
  });

  it("is empty for no audit", () => {
    expect(groupAudit(null)).toEqual({ groups: [], kept: [], open: 0 });
  });

  it("counts scenarios, not flags, that need a look and resolves a selection", () => {
    expect(scenariosNeedingALook(audit)).toBe(3);
    const { groups } = groupAudit(audit);
    expect(selectedRows(groups, new Set([rowKey("c", "duplicate")])).map((r) => r.scenario.name)).toEqual(["Sign in (web)"]);
  });
});

describe("suggestedName", () => {
  it("turns agent tasks into the feature they are about", () => {
    expect(suggestedName("Embodent 3c96e42c · Build the Questions board (website only, local branch)")).toBe("Questions board");
    expect(suggestedName("Embodent 64cc305f · Questions board: fix QA issues and open a PR (do not merge)")).toBe("Questions board");
    expect(suggestedName("Fix the login redirect")).toBe("Login redirect");
  });

  it("keeps a name with nothing better left", () => {
    expect(suggestedName("Open a PR")).toBe("Open a PR");
  });
});
