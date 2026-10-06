/**
 * unavailableError (parity G-08): the hub/browse routes' HTTP-200
 * {available:false, reason} bodies map onto the GhError ladder so no
 * off-state renders as an empty success.
 */
import { describe, expect, it } from "vitest";
import { unavailableError } from "./ghlib";

describe("unavailableError", () => {
  it("is null for available payloads and non-objects", () => {
    expect(unavailableError({ available: true })).toBeNull();
    expect(unavailableError({})).toBeNull();
    expect(unavailableError(null)).toBeNull();
  });
  it("maps every backend reason", () => {
    expect(unavailableError({ available: false, reason: "rate_limited", detail: "d" })).toMatchObject({ kind: "rate_limited", detail: "d" });
    expect(unavailableError({ available: false, reason: "repo_not_connected" })).toMatchObject({ kind: "not_connected" });
    expect(unavailableError({ available: false, reason: "local_source", origin_detected: "a/b" })).toMatchObject({ kind: "local_source", originDetected: "a/b" });
    expect(unavailableError({ available: false, reason: "unreachable", detail: "could not reach GitHub" })).toMatchObject({ kind: "error", detail: "could not reach GitHub" });
    // D4: a bare reason code is never shown raw
    expect(unavailableError({ available: false, reason: "github_error" })).toMatchObject({ kind: "error", detail: "GitHub returned an error. Try again in a moment." });
    expect(unavailableError({ available: false, reason: "unreachable" })).toMatchObject({ kind: "error", detail: "GitHub didn't respond. Check the connection and try again." });
  });
  it("not_found is item-scoped only", () => {
    expect(unavailableError({ available: false, reason: "not_found" }, 200, "item")).toMatchObject({ kind: "not_found" });
    expect(unavailableError({ available: false, reason: "not_found" }, 200, "repo")).toMatchObject({ kind: "error" });
  });
  it("never carries the HTTP 200 of a body-level error as a status (no 'Couldn't load (200)')", () => {
    expect(unavailableError({ available: false, reason: "unreachable" }, 200)!.status).toBeUndefined();
    expect(unavailableError({ available: false, reason: "unreachable" }, 503)!.status).toBe(503);
  });
});
