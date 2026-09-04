/**
 * draftPropose.ts — pure state machine transitions, no DOM/fetch (editorSave
 * .test.ts's precedent for this house style).
 */
import { describe, expect, it } from "vitest";
import {
  initialProposeState,
  onReset,
  onSend,
  onSendResult,
  onSendThrew,
} from "./draftPropose";
import type { ProposeChangesResult } from "./githubEditApi";

describe("initialProposeState", () => {
  it("starts idle with no PR/drift/error data", () => {
    const s = initialProposeState();
    expect(s.status).toBe("idle");
    expect(s.prNumber).toBeNull();
    expect(s.stalePaths).toEqual([]);
    expect(s.errorDetail).toBeNull();
  });
});

describe("onSend", () => {
  it("moves idle -> sending", () => {
    const s = onSend(initialProposeState());
    expect(s.status).toBe("sending");
  });

  it("moves drift -> sending, clearing prior drift data", () => {
    const drifted = onSendResult(onSend(initialProposeState()), {
      ok: false, reason: "drift", paths: ["a.ts"],
    });
    const s = onSend(drifted);
    expect(s.status).toBe("sending");
    expect(s.stalePaths).toEqual([]);
  });

  it("moves error -> sending, clearing the prior error", () => {
    const errored = onSendResult(onSend(initialProposeState()), {
      ok: false, reason: "github_error", detail: "boom",
    });
    const s = onSend(errored);
    expect(s.status).toBe("sending");
    expect(s.errorDetail).toBeNull();
  });

  it("is a no-op while already sending", () => {
    const sending = onSend(initialProposeState());
    expect(onSend(sending)).toBe(sending);
  });
});

describe("onSendResult", () => {
  it("ignores a result when not in sending state", () => {
    const idle = initialProposeState();
    const ok: ProposeChangesResult = { ok: true, pr_number: 1, pr_url: "https://x", branch: "b", commit_sha: "s" };
    expect(onSendResult(idle, ok)).toBe(idle);
  });

  it("sending -> ok carries pr_number/pr_url/branch", () => {
    const sending = onSend(initialProposeState());
    const result: ProposeChangesResult = {
      ok: true, pr_number: 42, pr_url: "https://github.com/o/r/pull/42", branch: "orcha/edits", commit_sha: "abc123",
    };
    const s = onSendResult(sending, result);
    expect(s.status).toBe("ok");
    expect(s.prNumber).toBe(42);
    expect(s.prUrl).toBe("https://github.com/o/r/pull/42");
    expect(s.branch).toBe("orcha/edits");
  });

  it("sending -> drift on reason:drift, carrying stale paths", () => {
    const sending = onSend(initialProposeState());
    const result: ProposeChangesResult = { ok: false, reason: "drift", paths: ["a.ts", "b.ts"] };
    const s = onSendResult(sending, result);
    expect(s.status).toBe("drift");
    expect(s.staleReason).toBe("drift");
    expect(s.stalePaths).toEqual(["a.ts", "b.ts"]);
  });

  it("sending -> drift on reason:exists too (same per-file recovery)", () => {
    const sending = onSend(initialProposeState());
    const result: ProposeChangesResult = { ok: false, reason: "exists", paths: ["new.ts"] };
    const s = onSendResult(sending, result);
    expect(s.status).toBe("drift");
    expect(s.staleReason).toBe("exists");
    expect(s.stalePaths).toEqual(["new.ts"]);
  });

  it("defaults paths to [] if the server omits it", () => {
    const sending = onSend(initialProposeState());
    const result = { ok: false, reason: "drift" } as unknown as ProposeChangesResult;
    const s = onSendResult(sending, result);
    expect(s.stalePaths).toEqual([]);
  });

  it("sending -> error on reason:github_error, carrying detail", () => {
    const sending = onSend(initialProposeState());
    const result: ProposeChangesResult = { ok: false, reason: "github_error", detail: "rate limited" };
    const s = onSendResult(sending, result);
    expect(s.status).toBe("error");
    expect(s.errorDetail).toBe("rate limited");
  });

  it("falls back to a generic message when github_error has no detail", () => {
    const sending = onSend(initialProposeState());
    const result: ProposeChangesResult = { ok: false, reason: "github_error" };
    const s = onSendResult(sending, result);
    expect(s.errorDetail).toBe("Something went wrong proposing these changes.");
  });
});

describe("onSendThrew", () => {
  it("sending -> error with the given detail", () => {
    const sending = onSend(initialProposeState());
    const s = onSendThrew(sending, "network down");
    expect(s.status).toBe("error");
    expect(s.errorDetail).toBe("network down");
  });

  it("ignores a throw when not in sending state", () => {
    const idle = initialProposeState();
    expect(onSendThrew(idle, "x")).toBe(idle);
  });
});

describe("onReset", () => {
  it("returns to idle from any state", () => {
    const sending = onSend(initialProposeState());
    const errored = onSendThrew(sending, "x");
    const s = onReset(errored);
    expect(s.status).toBe("idle");
    expect(s.errorDetail).toBeNull();
  });
});
