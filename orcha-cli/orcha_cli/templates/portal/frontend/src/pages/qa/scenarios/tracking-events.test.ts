import { describe, expect, it } from "vitest";
import { MAX_EVENT_LINES, eventLineError, eventTerms, eventsFromText, shellSplit, validateEvents } from "./tracking-events";

describe("eventsFromText", () => {
  it("splits lines and drops blank ones", () => {
    expect(eventsFromText("network: POST /v1/track\n\n  console: purchase  \n")).toEqual([
      "network: POST /v1/track",
      "console: purchase",
    ]);
  });
});

describe("eventLineError", () => {
  it("accepts every source, case-insensitively, with an optional [warning]", () => {
    expect(eventLineError('network: POST /v1/track "checkout_started"')).toBeNull();
    expect(eventLineError('Console: "[analytics]" purchase')).toBeNull();
    expect(eventLineError("device: track order_placed [warning]")).toBeNull();
    expect(eventLineError("ANY: order_placed")).toBeNull();
    expect(eventLineError("Any Order")).toBeNull();
  });

  it("rejects an unknown source or a line with no terms", () => {
    expect(eventLineError("log: purchase")).toMatch(/must start with/);
    expect(eventLineError("purchase happened")).toMatch(/must start with/);
    expect(eventLineError("network:   ")).toMatch(/no terms/);
    expect(eventLineError("network: [warning]")).toMatch(/no terms/);
  });

  it("strips the [warning] suffix case-insensitively, like the Python side", () => {
    expect(eventLineError("device: order_placed [WARNING]")).toBeNull();
    expect(eventLineError("device: order_placed [Warning]")).toBeNull();
    expect(eventLineError("network: [Warning]")).toMatch(/no terms/);
    expect(eventLineError("network: [WARNING]")).toMatch(/no terms/);
  });

  it("rejects terms that are empty once quotes are stripped", () => {
    expect(eventLineError('network: ""')).toMatch(/no terms/);
    expect(eventLineError("network: ''")).toMatch(/no terms/);
    expect(eventLineError('console: "" \'\' [warning]')).toMatch(/no terms/);
    expect(eventLineError('network: "" purchase')).toBeNull();
    expect(eventLineError("device: /track\\(order_(placed|confirmed)\\)/")).toBeNull();
    // An unbalanced quote falls back to a whitespace split, where `"` itself is a term.
    expect(eventLineError('network: "checkout')).toBeNull();
  });
});

describe("eventTerms / shellSplit", () => {
  it("splits like shlex and pulls /regex/ terms first", () => {
    expect(eventTerms('POST /v1/track "checkout started"')).toEqual(["POST", "/v1/track", "checkout started"]);
    expect(eventTerms('/a b/ "x"')).toEqual(["a b", "x"]);
    expect(shellSplit('a "b c" \'d\'')).toEqual(["a", "b c", "d"]);
    expect(shellSplit('"open')).toBeNull();
  });
});

describe("validateEvents", () => {
  it("trims, drops blanks and normalises `any order`", () => {
    expect(validateEvents(["ANY ORDER", " network: track ", ""])).toEqual({
      ok: true,
      events: ["any order", "network: track"],
    });
  });

  it("caps the number of lines", () => {
    const lines = Array.from({ length: MAX_EVENT_LINES + 1 }, (_, i) => `network: e${i}`);
    expect(validateEvents(lines)).toMatchObject({ ok: false });
    expect(validateEvents(lines.slice(1))).toMatchObject({ ok: true });
  });

  it("rejects a non-list or a bad line", () => {
    expect(validateEvents("network: x")).toMatchObject({ ok: false });
    expect(validateEvents([1])).toMatchObject({ ok: false });
    expect(validateEvents(["network: ok", "nope"])).toMatchObject({ ok: false });
  });
});
