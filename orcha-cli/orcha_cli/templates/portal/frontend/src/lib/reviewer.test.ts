/**
 * Collab v1 reviewer helpers — the owner-gating (permissive-when-absent),
 * graceful-absence detection, and the home verify-card de-emphasis rule
 * (ports of app-data.js actingOwner / home-state.js renderQueue).
 */
import { describe, expect, it } from "vitest";
import type { Agent } from "../types";
import { isActingOwner, reviewFor, reviewerLabel, reviewerRef, reviewerSupported } from "./reviewer";

const human = (over: Partial<Agent> = {}): Agent =>
  ({ id: "h1", alias: "kedar", kind: "human", role: "—", model: null, status: "idle",
     embodiment: null, wake_enabled: null, auto_wake_interval_secs: null,
     prompt_preview: null, last_active: null, current_task: null, active_run: null,
     ...over }) as Agent;

describe("reviewerRef / reviewerLabel", () => {
  it("null/undefined reviewer -> null ref, empty label", () => {
    expect(reviewerRef({ reviewer: null })).toBeNull();
    expect(reviewerRef({ reviewer: undefined })).toBeNull();
    expect(reviewerLabel(null)).toBe("");
  });
  it("object passes through; label prefers github_login over alias (vanilla)", () => {
    expect(reviewerLabel({ alias: "kedar", github_login: "kedar-gh" })).toBe("kedar-gh");
    expect(reviewerLabel({ alias: "kedar", github_login: null })).toBe("kedar");
  });
  it("a bare string (raw id) renders as-is via alias", () => {
    expect(reviewerRef({ reviewer: "raw-id-123" })).toEqual({ alias: "raw-id-123" });
    expect(reviewerLabel(reviewerRef({ reviewer: "raw-id-123" }))).toBe("raw-id-123");
  });
});

describe("isActingOwner (permissive-when-absent, app-data.js trust-off branch)", () => {
  it("owner member_role -> owner", () => {
    expect(isActingOwner(human({ member_role: "owner" }))).toBe(true);
  });
  it("absent member_role (open backend / old snapshot) -> PERMISSIVE owner", () => {
    expect(isActingOwner(human({ member_role: null }))).toBe(true);
    expect(isActingOwner(human({}))).toBe(true);
  });
  it("member/viewer -> not owner; no acting human -> not owner", () => {
    expect(isActingOwner(human({ member_role: "member" }))).toBe(false);
    expect(isActingOwner(human({ member_role: "viewer" }))).toBe(false);
    expect(isActingOwner(null)).toBe(false);
  });
});

describe("reviewerSupported (graceful absence on open backends)", () => {
  it("false with no member_role anywhere and no reviewer fields on any task", () => {
    expect(reviewerSupported(null)).toBe(false);
    expect(
      reviewerSupported({
        agents: [human({}), human({ id: "a1", alias: "forge", kind: "ai" })],
        tasks: [{ reviewer: null, reviewer_agent_id: null }] as never,
      }),
    ).toBe(false);
  });
  it("true when any agent carries member_role (collab-aware cloud snapshot)", () => {
    expect(
      reviewerSupported({ agents: [human({ member_role: "member" })], tasks: [] as never }),
    ).toBe(true);
  });
  it("true when any task carries a reviewer even without roles", () => {
    expect(
      reviewerSupported({
        agents: [human({})],
        tasks: [{ reviewer: { alias: "kedar" }, reviewer_agent_id: "h1" }] as never,
      }),
    ).toBe(true);
  });
});

describe("reviewFor (home-state.js verify-card de-emphasis rule)", () => {
  const t = { reviewer: { alias: "sam", github_login: "sam-gh" }, reviewer_agent_id: "h2" };

  it("someone else's review + non-owner actor -> the 'review: <login>' label", () => {
    expect(reviewFor(t, human({ member_role: "member" }))).toBe("sam-gh");
  });
  it("falls back to alias when the reviewer has no github_login", () => {
    expect(reviewFor({ reviewer: { alias: "sam" }, reviewer_agent_id: "h2" }, human({ member_role: "member" }))).toBe("sam");
  });
  it("YOUR review -> null (render normally)", () => {
    expect(reviewFor(t, human({ id: "h2", member_role: "member" }))).toBe(null);
  });
  it("owner actor -> null (owners see every card normally)", () => {
    expect(reviewFor(t, human({ member_role: "owner" }))).toBe(null);
  });
  it("absent member_role (open backend) -> permissive owner -> null", () => {
    expect(reviewFor(t, human({}))).toBe(null);
  });
  it("no reviewer, no actor, or no reviewer id -> null", () => {
    expect(reviewFor({ reviewer: null, reviewer_agent_id: null }, human({ member_role: "member" }))).toBe(null);
    expect(reviewFor(t, null)).toBe(null);
    expect(reviewFor({ reviewer: { alias: "sam" }, reviewer_agent_id: null }, human({ member_role: "member" }))).toBe(null);
  });
});
