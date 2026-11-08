import { describe, expect, it } from "vitest";
import { parseCheck, validateChecks } from "./checks";
import { looksLikeSaved, parseSavedCheck, readbackHint, writesData } from "./saved-checks";

// The same lines as tests/unit/verdicts/test_readback.py: the TS grammar normalises them the way the
// Python one renders them, so a line saved from the scenario panel reads back the same.
describe("Saved: read-back lines (#266)", () => {
  it("normalises the issue's sketches", () => {
    expect(parseSavedCheck('Saved: POST /api/events → {"type": "feeding", "side": "left", "amount_oz": null}')).toEqual({
      ok: true,
      normalised: 'saved POST /api/events -> type is "feeding", side is "left", amount_oz empty',
    });
    expect(parseSavedCheck('Saved: record "feeding" has amount empty and duration empty')).toEqual({
      ok: true,
      normalised: 'saved record "feeding" -> amount empty, duration empty',
    });
    expect(parseSavedCheck('saved record "Feeding" after relaunch -> Feeding Type is "Left Breast", Amount empty')).toEqual({
      ok: true,
      normalised: 'saved record "Feeding" after relaunch -> Feeding Type is "Left Breast", Amount empty',
    });
  });

  it("keeps SQL whole and reads values", () => {
    const r = parseSavedCheck(
      'saved storage select amountOz from events where a = 1 or b = 2 or record "Feeding" -> amountOz empty, weight is 4.5 [warning]',
    );
    expect(r).toEqual({
      ok: true,
      normalised: 'saved storage select amountOz from events where a = 1 or b = 2 or record "Feeding" -> amountOz empty, weight is 4.5 [warning]',
    });
    expect(parseSavedCheck('saved query select 1 -> note is ""')).toEqual({ ok: true, normalised: "saved query select 1 -> note empty" });
    expect(parseSavedCheck('saved GET /x -> notes contains "park", ok is true')).toEqual({
      ok: true,
      normalised: 'saved GET /x -> notes contains "park", ok is true',
    });
  });

  it("explains a line it cannot read", () => {
    for (const [line, why] of [
      ["saved DELETE /x -> a empty", "not a read-back source"],
      ["saved record Feeding -> a empty", "quoted title"],
      ["saved GET /x", "write the source, then ->"],
      ["saved query update x set a = 1 -> a empty", "read-only select"],
      ["saved GET /x after relaunch -> a empty", "after relaunch applies"],
    ] as const) {
      const r = parseSavedCheck(line);
      expect(r.ok, line).toBe(false);
      if (!r.ok) expect(r.error).toContain(why);
    }
  });

  it("is a check line the scenario panel accepts", () => {
    expect(looksLikeSaved('Saved: GET /a -> b is 1')).toBe(true);
    expect(looksLikeSaved('text "Saved"')).toBe(false);
    expect(parseCheck("Saved: GET /a -> b is 1")).toEqual({ ok: true, normalised: "saved GET /a -> b is 1" });
    const v = validateChecks({ criteria: { "0": ['text "Recent Activity"', 'Saved: record "Feeding" -> Amount empty'] } });
    expect(v).toEqual({ ok: true, checks: { criteria: { "0": ['text "Recent Activity"', 'saved record "Feeding" -> Amount empty'] }, scenario: [] } });
    expect(validateChecks({ criteria: { "0": ["saved record Feeding -> a empty"] } }).ok).toBe(false);
  });
});

describe("no-readback hint (#285)", () => {
  it("flags criteria that save, add, log or edit data", () => {
    expect(writesData("Saving a Left feeding lists it on Today")).toBe(true);
    expect(writesData("The parent logs a nap of 1h 30m")).toBe(true);
    expect(writesData("Renaming the baby updates the header")).toBe(true);
  });
  it("leaves out sign-ins, UI copy, control names, negations and passive descriptions", () => {
    expect(writesData("The parent logs in with email")).toBe(false);
    expect(writesData('The toast says "Blue mug added to cart"')).toBe(false);
    expect(writesData("Tapping the Save settings button opens the sheet")).toBe(false);
    expect(writesData("Nothing is saved while the form is invalid")).toBe(false);
    expect(writesData("The card shows the time it was logged")).toBe(false);
  });
  it("is silent once a Saved: line reads the record back", () => {
    const c = "Saving a Left feeding lists it on Today";
    expect(readbackHint(c, 'text "Recent Activity"')).toMatch(/no read-back/);
    expect(readbackHint(c, 'Saved: record "Feeding" after relaunch -> Amount empty')).toBeNull();
    expect(readbackHint("Opening Insights shows the charts", "")).toBeNull();
  });
});
