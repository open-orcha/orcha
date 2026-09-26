/**
 * Identity seam (extensions.identity → acting-human resolution). Port of the
 * cloud app-data.js:100-164 rules:
 *  - identity whose agent_id resolves to a kind='human' agent IS the actor
 *    (the persisted localStorage pick is ignored);
 *  - identity present but agent_id null/unresolvable (trusted non-member)
 *    → NULL actor — never another human;
 *  - no identity registered (open default) → legacy actingHuman behavior.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mapSnapshot } from "../api/client";
import { _setActingIdentity, actingHuman, actingIdentityHuman } from "./SnapshotProvider";

const snap = mapSnapshot({
  container: { id: "c1", name: "Orcha" },
  agents: [
    { id: "h1", alias: "kedar", kind: "human", status: "idle" },
    { id: "h2", alias: "sam", kind: "human", status: "idle" },
    { id: "a1", alias: "Frame", kind: "ai", status: "working" },
  ],
  tasks: [],
  requests: [],
});

beforeEach(() => localStorage.clear());
afterEach(() => _setActingIdentity(null)); // never leak identity across tests

describe("actingIdentityHuman", () => {
  it("resolves the viewer's own human agent from identity.agent_id", () => {
    const who = actingIdentityHuman(snap, { agent_id: "h2", github_login: "sam-gh" });
    expect(who?.id).toBe("h2");
    expect(who?.alias).toBe("sam");
  });

  it("ignores the persisted localStorage pick when an identity is present", () => {
    localStorage.setItem("orcha:actingHuman:c1", "h1"); // saved pick says kedar
    const who = actingIdentityHuman(snap, { agent_id: "h2" });
    expect(who?.id).toBe("h2"); // identity wins
  });

  it("non-member (agent_id null) → NULL actor, never the first human", () => {
    expect(actingIdentityHuman(snap, { agent_id: null, github_login: "viewer" })).toBeNull();
    expect(actingIdentityHuman(snap, { github_login: "viewer" })).toBeNull(); // agent_id absent
  });

  it("unresolvable or non-human agent_id → NULL actor", () => {
    expect(actingIdentityHuman(snap, { agent_id: "ghost" })).toBeNull();
    expect(actingIdentityHuman(snap, { agent_id: "a1" })).toBeNull(); // resolves to an AI row
  });

  it("no identity → exactly the legacy behavior (first human / saved pick)", () => {
    expect(actingIdentityHuman(snap, null)?.alias).toBe("kedar");
    localStorage.setItem("orcha:actingHuman:c1", "h2");
    expect(actingIdentityHuman(snap, null)?.alias).toBe("sam");
  });
});

describe("actingHuman consults the module-level identity slot", () => {
  it("no provider registered (open default) → legacy resolution", () => {
    expect(actingHuman(snap)?.alias).toBe("kedar");
    localStorage.setItem("orcha:actingHuman:c1", "h2");
    expect(actingHuman(snap)?.alias).toBe("sam");
  });

  it("published member identity flows through to every legacy caller", () => {
    localStorage.setItem("orcha:actingHuman:c1", "h1");
    _setActingIdentity({ agent_id: "h2" });
    expect(actingHuman(snap)?.id).toBe("h2");
  });

  it("published non-member identity → NULL for every legacy caller", () => {
    _setActingIdentity({ agent_id: null, member_role: "viewer" });
    expect(actingHuman(snap)).toBeNull();
  });

  it("clearing the slot restores legacy behavior", () => {
    _setActingIdentity({ agent_id: "h2" });
    _setActingIdentity(null);
    expect(actingHuman(snap)?.alias).toBe("kedar");
  });
});
