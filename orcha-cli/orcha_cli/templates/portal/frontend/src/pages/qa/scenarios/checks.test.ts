import { describe, expect, it } from "vitest";
import { contradictions, parseCheck, parseScenarioChecks, validateChecks } from "./checks";

// The same examples as tests/unit/recording/test_checks.py: the site and the harness must agree.
const EXAMPLES: [string, string][] = [
  ['text "Order placed"', 'text "Order placed"'],
  ['text ~"order placed"', 'text ~"order placed"'],
  ["text /Order #\\d+ placed/", "text /Order #\\d+ placed/"],
  ['Button "Place order" enabled', 'Button "Place order" enabled'],
  ['Button "Pay" disabled within 10s', 'Button "Pay" disabled within 10s'],
  ['StaticText "Payment failed" absent', 'StaticText "Payment failed" absent'],
  ['Switch "Dark mode" checked', 'Switch "Dark mode" checked'],
  ['TextField "Email" value "{{email}}"', 'TextField "Email" value "{{email}}"'],
  ['id=checkout.total contains "$"', 'id=checkout.total contains "$"'],
  ["count Cell >= 3", "count Cell >= 3"],
  ['url contains "/orders/" [warning]', 'url contains "/orders/" [warning]'],
  ["screen changed", "screen changed"],
];

describe("parseCheck", () => {
  it.each(EXAMPLES)("normalises %s", (line, normal) => {
    const r = parseCheck(`Check: ${line}`);
    expect(r).toEqual({ ok: true, normalised: normal });
  });

  it.each([
    ['Bogus "x"', "unknown subject"],
    ["count Cell", "count needs"],
    ['Button "x" >= 2', "only applies to count"],
    ["url visible", "url needs"],
    ["screen enabled", "screen needs"],
  ])("rejects %s", (line, needle) => {
    const r = parseCheck(line);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain(needle);
  });

  it("collapses a visible matcher and caps within", () => {
    expect(parseCheck('text "a" visible')).toEqual({ ok: true, normalised: 'text "a"' });
    expect(parseCheck('text "a" within 600s')).toEqual({ ok: true, normalised: 'text "a" within 60s' });
  });
});

describe("validateChecks", () => {
  it("normalises and drops empty lines", () => {
    const r = validateChecks({ criteria: { "0": ['text  "a"', ""] }, scenario: [] });
    expect(r).toEqual({ ok: true, checks: { criteria: { "0": ['text "a"'] }, scenario: [] } });
  });
  it("names the criterion of a bad line", () => {
    const r = validateChecks({ criteria: { "2": ["Bogus"] } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/^criterion 3:/);
  });
});

// Lately "Add a routine and see it on Home", criterion 5, rewritten on 2026-10-17.
describe("contradictory checks", () => {
  const LATELY = { criteria: { "4": ['text "Nothing tracked yet." absent', 'StaticText "Nothing tracked yet."'] }, scenario: [] };

  it("refuses a label checked both shown and absent on save, naming both lines", () => {
    const r = validateChecks(LATELY);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('criterion 5: StaticText "Nothing tracked yet." and text "Nothing tracked yet." absent can never both hold; keep one');
  });

  it("keeps them when reading a stored row, so the editor can show what to fix", () => {
    expect(parseScenarioChecks(LATELY).criteria["4"]).toHaveLength(2);
  });

  it("a state that appears and then goes is not a contradiction", () => {
    expect(contradictions(['text "Saving…" appears', 'text "Saving…" absent'])).toEqual([]);
    expect(contradictions(['Button "Save"', 'Link "Save" absent'])).toEqual([]);
  });
});
