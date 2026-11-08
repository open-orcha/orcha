import { describe, expect, it } from "vitest";
import { cn } from "./cn";

describe("cn", () => {
  it("joins what is truthy", () => {
    expect(cn("a", false, null, undefined, ["b", ["c"]], { d: true, e: false })).toBe("a b c d");
  });
  it("lets a later class override an earlier one that sets the same thing", () => {
    expect(cn("w-full px-2", "w-auto")).toBe("px-2 w-auto");
    expect(cn("hidden", "flex")).toBe("flex");
    expect(cn("text-sm text-muted", "text-fg")).toBe("text-sm text-fg");
    expect(cn("border border-border", "border-danger")).toBe("border border-danger");
  });
  it("keeps variants apart", () => {
    expect(cn("hidden md:flex", "md:block")).toBe("hidden md:block");
    expect(cn("h-4 hover:h-5")).toBe("h-4 hover:h-5");
  });
  it("does not confuse classes that only look alike", () => {
    expect(cn("text-sm text-center text-fg")).toBe("text-sm text-center text-fg");
    expect(cn("flex flex-col flex-wrap")).toBe("flex flex-col flex-wrap");
    expect(cn("border-t border-b")).toBe("border-t border-b");
    expect(cn("v-rise qa-chip styles_x")).toBe("v-rise qa-chip styles_x");
  });
  it("reads an arbitrary value with a colon inside", () => {
    expect(cn("[&_svg]:size-3", "[&_svg]:size-4")).toBe("[&_svg]:size-3 [&_svg]:size-4");
  });
});
