import { describe, it, expect } from "vitest";
import { mapSnapshot } from "./client";
import { liveStatusText } from "../pages/org/orgModel";

const human = { id: "h1", alias: "maya", kind: "human", role: "dev", status: "idle", member_role: "member", github_login: "maya" };

describe("mapSnapshot (FQ r2 integration)", () => {
  it("PS-33: carries last_heartbeat_at only when the backend sends it", () => {
    const sent = mapSnapshot({ agents: [{ ...human, last_heartbeat_at: null }] }).agents[0];
    expect("last_heartbeat_at" in sent).toBe(true);
    expect(sent.last_heartbeat_at).toBe(null);
    expect(liveStatusText(sent)).toBe("Invited · not signed in");
    const omitted = mapSnapshot({ agents: [human] }).agents[0];
    expect("last_heartbeat_at" in omitted).toBe(false);
  });

  it("L13b: running_run keeps its worktree/base_cwd checkout fields", () => {
    const a = mapSnapshot({
      agents: [{ ...human, kind: "ai", running_run: { run_id: "r1", worktree: "/w/x", base_cwd: null } }],
    }).agents[0];
    expect(a.running_run?.worktree).toBe("/w/x");
    expect(a.running_run?.base_cwd).toBe(null);
  });
});
