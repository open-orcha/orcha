import { describe, expect, it } from "vitest";
import { MAX_SEEDS, seedLineError, seedsError, seedsFromText, seedsToText, validateSeeds } from "./seeds";

describe("seed lines", () => {
  it("accepts every seed kind", () => {
    for (const line of [
      'POST /api/orders {"item": "Blue mug"}',
      "delete /api/orders/7",
      "GET https://api.shop.test/health",
      "fixture orders",
      'storage {"orders": [{"id": 1001}]}',
      'cookies {"sid": "abc"}',
      'POST /api/orders {"qty": {{qty}}, "name": "mug {{tag}}"}',
    ]) {
      expect(seedLineError(line), line).toBeNull();
    }
  });

  it("explains a bad line", () => {
    expect(seedLineError("SEND /x")).toMatch(/must start with GET/);
    expect(seedLineError("POST api/orders")).toMatch(/path starting with \//);
    expect(seedLineError("POST /api {oops")).toMatch(/not valid JSON/);
    expect(seedLineError("fixture ../x")).toMatch(/fixture name/);
    expect(seedLineError("storage []")).toMatch(/non-empty JSON object/);
    expect(seedLineError("cookies")).toMatch(/needs a JSON object/);
  });

  it("round-trips the textarea and caps the list", () => {
    expect(seedsFromText("fixture a\n\n  fixture b ")).toEqual(["fixture a", "fixture b"]);
    expect(seedsToText(["fixture a", "fixture b"])).toBe("fixture a\nfixture b");
    expect(seedsToText(null)).toBe("");
    expect(seedsError(Array(MAX_SEEDS + 1).fill("fixture a").join("\n"))).toMatch(/At most/);
    expect(seedsError("fixture a\nnope")).toMatch(/must start with/);
  });

  it("validates a PATCH body", () => {
    expect(validateSeeds(null)).toEqual({ ok: true, seed: null });
    expect(validateSeeds([])).toEqual({ ok: true, seed: null });
    expect(validateSeeds(["fixture a", " "])).toEqual({ ok: true, seed: ["fixture a"] });
    expect(validateSeeds("fixture a\nfixture b")).toEqual({ ok: true, seed: ["fixture a", "fixture b"] });
    expect(validateSeeds([1])).toEqual({ ok: false, error: "seed must be a list of lines." });
    const bad = validateSeeds(["nope"]);
    expect(bad.ok).toBe(false);
  });
});
