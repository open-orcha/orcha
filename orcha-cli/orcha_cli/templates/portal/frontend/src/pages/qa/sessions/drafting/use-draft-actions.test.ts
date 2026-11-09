// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { QaAuthority } from "../../authority";
import { setScenarioStatus } from "../../qaApi";
import { createQaTask } from "../../runQa";
import { postFeedback } from "./api";
import type { Scenario } from "./lib/types";
import { DISCARD_REASON, useDraftActions } from "./use-draft-actions";
import { useDraftRevisions } from "./use-draft-revisions";

vi.mock("../../map/kit", async (own) => ({ ...(await own<object>()), useToast: () => ({ toast: vi.fn() }) }));
vi.mock("../../qaApi", async (own) => ({ ...(await own<object>()), setScenarioStatus: vi.fn(async () => ({})) }));
vi.mock("../../runQa", async (own) => ({ ...(await own<object>()), createQaTask: vi.fn(async () => ({ task_id: "t1" })) }));
vi.mock("./api", () => ({ postFeedback: vi.fn(async () => ({})) }));

const DRAFT = { id: "s1", name: "Create a routine", status: "draft", updated_at: "2026-01-01T00:00:00Z" } as Scenario;
const PERSON = { can: true, human: { id: "h1" }, reason: null } as unknown as QaAuthority;
const VIEWER = { can: false, human: null, reason: "View-only" } as QaAuthority;

function setup(auth: QaAuthority = PERSON) {
  const setError = vi.fn();
  const removeDraft = vi.fn();
  const setDrafts = vi.fn();
  const hook = renderHook(() => {
    const revisions = useDraftRevisions([DRAFT]);
    const actions = useDraftActions({ cid: "c1", platform: "ios", auth, agent: "forge", setDrafts, removeDraft, revisions, setError });
    return { revisions, actions };
  });
  act(() => hook.result.current.actions.setFeedback("s1", "Criterion 3 is wrong"));
  return { hook, setError, removeDraft, setDrafts };
}

beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.unstubAllGlobals());

describe("Revise with Embodent", () => {
  it("shows the draft as revising from the click on and sends one revision for a double click", async () => {
    let resolve!: (r: unknown) => void;
    vi.mocked(postFeedback).mockReturnValueOnce(new Promise((r) => (resolve = r)));
    const { hook } = setup();

    let first!: Promise<void>;
    act(() => {
      first = hook.result.current.actions.reviseOne(DRAFT);
      void hook.result.current.actions.reviseOne(DRAFT);
    });
    expect(postFeedback).toHaveBeenCalledTimes(1);
    expect(hook.result.current.revisions.pendingIds.has("s1")).toBe(true);

    await act(async () => {
      resolve({});
      await first;
    });
    // Still revising: now tracked by its task until the agent rewrites the draft.
    expect(createQaTask).toHaveBeenCalledTimes(1);
    const [cid, body] = vi.mocked(createQaTask).mock.calls[0];
    expect(cid).toBe("c1");
    expect(body.assignee_alias).toBe("forge");
    expect(body.description).toContain("s1");
    expect(body.description).toContain("Criterion 3 is wrong");
    expect(hook.result.current.revisions.pendingIds.has("s1")).toBe(true);
    expect(hook.result.current.actions.feedbackDrafts.get("s1")).toBeUndefined();
  });

  it("clears the revising state when it fails, and keeps the feedback", async () => {
    vi.mocked(createQaTask).mockRejectedValueOnce(new Error("nope"));
    const { hook } = setup();
    await act(async () => {
      await hook.result.current.actions.reviseOne(DRAFT);
    });
    expect(hook.result.current.revisions.errors.get("s1")).toContain("nope");
    expect(hook.result.current.revisions.pendingIds.has("s1")).toBe(false);
    expect(hook.result.current.actions.feedbackDrafts.get("s1")).toBe("Criterion 3 is wrong");
  });
});

describe("the human-only decisions", () => {
  it("accepts and discards through the status route, as the acting person", async () => {
    const { hook, removeDraft, setDrafts } = setup();
    await act(async () => {
      await hook.result.current.actions.acceptMany(["s1"]);
      await hook.result.current.actions.discardOne("s1");
    });
    expect(setScenarioStatus).toHaveBeenCalledWith("c1", "h1", ["s1"], "validated");
    expect(setScenarioStatus).toHaveBeenCalledWith("c1", "h1", ["s1"], "retired", DISCARD_REASON);
    expect(setDrafts).toHaveBeenCalled();
    expect(removeDraft).toHaveBeenCalledWith("s1");
  });

  it("does nothing for someone who cannot decide", async () => {
    const { hook } = setup(VIEWER);
    await act(async () => {
      await hook.result.current.actions.acceptMany(["s1"]);
      await hook.result.current.actions.discardOne("s1");
      await hook.result.current.actions.reviseOne(DRAFT);
    });
    expect(setScenarioStatus).not.toHaveBeenCalled();
    expect(postFeedback).not.toHaveBeenCalled();
  });

  it("says why a decision did not land", async () => {
    vi.mocked(setScenarioStatus).mockRejectedValueOnce(new Error("only a person can change a scenario's status"));
    const { hook, setError } = setup();
    await act(async () => {
      await hook.result.current.actions.acceptMany(["s1"]);
    });
    expect(setError).toHaveBeenLastCalledWith(expect.stringContaining("only a person"));
  });
});
