import { describe, expect, it } from "vitest";
import { areaOf } from "./coverage";

describe("areaOf", () => {
  it("names the root route's screen Home, never the folder it lives in", () => {
    expect(areaOf({ route: "/", files: ["src/App.tsx"], name: "Home" })).toBe("home");
  });
  it("reads a route's first segment, then the file's folder", () => {
    expect(areaOf({ route: "/books/*", files: [], name: "Books detail" })).toBe("books");
    expect(areaOf({ files: ["app/Cart/CartView.swift"], name: "Cart" })).toBe("Cart");
    expect(areaOf({ files: [], name: "Lost" })).toBe("other");
  });
});
