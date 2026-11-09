import { describe, expect, it } from "vitest";
import { draftedTitles, evenIndices, readFiles, readPath, stageTiles, tileWidth } from "./drafting-stage";

describe("drafting stage helpers", () => {
  const recent = [
    "Loading the project's existing scenarios and memory",
    "Reading src/app/page.tsx",
    "Searching for useForm in src",
    "Reading src/app/page.tsx",
    "Reading lib/auth.ts",
    "Drafting: Sign in with valid credentials",
    "Drafting: Sign in with valid credentials",
    "Drafting: Reset a forgotten password",
  ];

  it("reads file paths out of Reading notes only", () => {
    expect(readPath("Reading src/a.ts")).toBe("src/a.ts");
    expect(readPath("Reading the project")).toBeNull();
    expect(readPath("Searching for x")).toBeNull();
  });

  it("lists drafted titles and read files once each, in order", () => {
    expect(draftedTitles(recent)).toEqual(["Sign in with valid credentials", "Reset a forgotten password"]);
    expect(readFiles(recent)).toEqual(["src/app/page.tsx", "lib/auth.ts"]);
  });

  it("prefers exploration frames over file tiles", () => {
    const frames = [{ path: "r/frames/0001.jpg", kind: "ios" as const, run_id: "r" }];
    expect(stageTiles(frames, recent)).toEqual([{ key: "frame:r/frames/0001.jpg", type: "frame", kind: "ios", path: "r/frames/0001.jpg" }]);
    const files = stageTiles([], recent);
    expect(files.map((t) => t.name)).toEqual(["page.tsx", "auth.ts"]);
    expect(files[0].dir).toBe("src/app");
  });

  it("spreads sample indices evenly and never past the end", () => {
    expect(evenIndices(3, 5)).toEqual([0, 1, 2]);
    expect(evenIndices(100, 4)).toEqual([0, 25, 50, 75]);
    expect(evenIndices(0, 4)).toEqual([]);
  });

  it("sizes tiles by platform", () => {
    expect(tileWidth("web", 100)).toBe(150);
    expect(tileWidth("ios", 210)).toBe(100);
  });
});
