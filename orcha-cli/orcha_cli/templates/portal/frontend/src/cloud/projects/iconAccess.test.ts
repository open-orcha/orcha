/** D14 icon gate — mirrors PUT /api/containers/{cid}/icon (owner or manage_autonomy; trust off open). */
import { describe, expect, it } from "vitest";
import { ICON_REASON_GRANT, ICON_REASON_NON_MEMBER, ICON_REASON_VIEWER, iconAccess } from "./iconAccess";
import { projectStatusMeta } from "./projectStatus";

describe("iconAccess", () => {
  it("trust off / no envelope is open (the server is open there too)", () => {
    expect(iconAccess(null)).toEqual({ allowed: true, reason: null });
    expect(iconAccess({ identity: null, trusted: false }).allowed).toBe(true);
  });
  it("trusted: non-member, viewer and grant-less member are refused with a reason", () => {
    expect(iconAccess({ identity: null, trusted: true })).toEqual({ allowed: false, reason: ICON_REASON_NON_MEMBER });
    expect(iconAccess({ identity: { github_login: "t", member_role: "viewer" } as never, trusted: true }).reason).toBe(ICON_REASON_VIEWER);
    expect(iconAccess({ identity: { github_login: "a", member_role: "member", grants: ["manage_keys"] } as never, trusted: true }).reason).toBe(ICON_REASON_GRANT);
  });
  it("trusted: owner or a manage_autonomy holder may change it", () => {
    expect(iconAccess({ identity: { github_login: "o", member_role: "owner" } as never, trusted: true }).allowed).toBe(true);
    expect(iconAccess({ identity: { github_login: "a", member_role: "member", grants: ["manage_autonomy"] } as never, trusted: true }).allowed).toBe(true);
  });
});

describe("projectStatusMeta (SG-06: a project status is not a task status)", () => {
  it("paused reads 'Paused' (warn), active reads 'Active' (ok), unknowns are capitalised", () => {
    expect(projectStatusMeta("paused")).toEqual({ label: "Paused", tone: "warn" });
    expect(projectStatusMeta("active")).toEqual({ label: "Active", tone: "ok" });
    expect(projectStatusMeta(null)).toEqual({ label: "Active", tone: "ok" });
    expect(projectStatusMeta("completed").label).toBe("Completed");
    expect(projectStatusMeta("rebuilding_db")).toEqual({ label: "Rebuilding db", tone: "neutral" });
  });
});
