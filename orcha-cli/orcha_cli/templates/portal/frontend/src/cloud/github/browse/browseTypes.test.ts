import { describe, expect, it } from "vitest";
import { baseName, depthOf, extOf, joinPath, parentOf } from "./browseTypes";

describe("path helpers", () => {
  it("parentOf returns the root ('') for a top-level path", () => {
    expect(parentOf("README.md")).toBe("");
  });
  it("parentOf strips the last segment for a nested path", () => {
    expect(parentOf("src/cloud/github/GitHubPage.tsx")).toBe("src/cloud/github");
  });
  it("baseName returns the last path segment", () => {
    expect(baseName("src/cloud/github/GitHubPage.tsx")).toBe("GitHubPage.tsx");
    expect(baseName("README.md")).toBe("README.md");
  });
  it("extOf lowercases and strips the leading dot", () => {
    expect(extOf("src/App.TSX")).toBe("tsx");
    expect(extOf("a/b/c.PY")).toBe("py");
  });
  it("extOf returns '' for dotfiles and extension-less paths", () => {
    expect(extOf(".gitignore")).toBe("");
    expect(extOf("Makefile")).toBe("");
    expect(extOf("src/Makefile")).toBe("");
  });
  it("joinPath joins a dir and a name, root-safe", () => {
    expect(joinPath("", "src")).toBe("src");
    expect(joinPath("src", "cloud")).toBe("src/cloud");
  });
  it("depthOf counts path segments, root is depth 0", () => {
    expect(depthOf("")).toBe(0);
    expect(depthOf("a")).toBe(1);
    expect(depthOf("a/b/c")).toBe(3);
  });
});
