/** Parity round 2 (Tasks): the Runs tab opens the newest run's "Code changes"
 *  by default — one run only, never every historical diff. */
import { describe, expect, it } from "vitest";
import type { Run } from "../../types";
import { newestDiffRunKey } from "./TaskDetail";

const R = (id: string, started: string, diff: string | null): Run => ({ run_id: id, status: "completed", started_at: started, diff });

describe("newestDiffRunKey", () => {
  it("picks the most recent run with a non-empty diff", () => {
    const runs = [
      R("old", "2026-08-01T00:00:00Z", "diff --git a b"),
      R("new-nodiff", "2026-08-03T00:00:00Z", null),
      R("mid", "2026-08-02T00:00:00Z", "diff --git c d"),
      R("blank", "2026-08-04T00:00:00Z", "   "),
    ];
    expect(newestDiffRunKey(runs)).toBe("mid");
  });
  it("is null when no run carries a diff", () => {
    expect(newestDiffRunKey([R("a", "2026-08-01T00:00:00Z", null), R("b", "2026-08-02T00:00:00Z", "")])).toBeNull();
    expect(newestDiffRunKey([])).toBeNull();
  });
});
