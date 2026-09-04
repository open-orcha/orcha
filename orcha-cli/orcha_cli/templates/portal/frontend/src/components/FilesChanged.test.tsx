import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { FilesChanged, parseDiffFiles } from "./FilesChanged";

afterEach(cleanup);

const MULTI = [
  "diff --git a/src/lib/one.ts b/src/lib/one.ts",
  "index 1111111..2222222 100644",
  "--- a/src/lib/one.ts",
  "+++ b/src/lib/one.ts",
  "@@ -1,2 +1,3 @@",
  " keep",
  "+added line",
  "diff --git a/src/lib/two.ts b/src/lib/two.ts",
  "new file mode 100644",
  "--- /dev/null",
  "+++ b/src/lib/two.ts",
  "@@ -0,0 +1,2 @@",
  "+alpha",
  "+beta",
  "diff --git a/docs/deep/nested/three.md b/docs/deep/nested/three.md",
  "deleted file mode 100644",
  "--- a/docs/deep/nested/three.md",
  "+++ /dev/null",
  "@@ -1,1 +0,0 @@",
  "-gone",
].join("\n");

describe("parseDiffFiles", () => {
  it("parses per-file entries with M/A/D status and +/- counts", () => {
    const files = parseDiffFiles(MULTI);
    expect(files.map((f) => f.path)).toEqual(["src/lib/one.ts", "src/lib/two.ts", "docs/deep/nested/three.md"]);
    expect(files.map((f) => f.status)).toEqual(["M", "A", "D"]);
    expect(files[0].add).toBe(1);
    expect(files[1].add).toBe(2);
    expect(files[2].del).toBe(1);
  });
});

describe("FilesChanged (.dfv widget)", () => {
  it("renders the tree with status badges and chain-compressed directories", () => {
    const { container } = render(<FilesChanged diff={MULTI} />);
    // the two-pane widget mounts with the vanilla class names
    expect(container.querySelector(".dfv")).toBeTruthy();
    expect(container.querySelector(".dfv-top")!.textContent).toContain("3 files changed");
    // chain compression: docs/deep/nested (single-child empty dirs) is ONE row
    const dirLabels = Array.from(container.querySelectorAll(".dfv-dir .dfv-nm")).map((n) => n.textContent);
    expect(dirLabels).toContain("docs/deep/nested");
    expect(dirLabels).toContain("src/lib");
    expect(dirLabels).not.toContain("deep"); // folded, never its own row
    // M/A/D badges on the file rows
    const badges = Array.from(container.querySelectorAll(".dfv-b")).map((b) => b.textContent);
    expect(badges.sort()).toEqual(["A", "D", "M"]);
    expect(container.querySelector(".dfv-b.A")).toBeTruthy();
    expect(container.querySelector(".dfv-b.D")).toBeTruthy();
  });

  it("swaps the diff pane when a file row is selected", () => {
    const { container } = render(<FilesChanged diff={MULTI} />);
    // first file selected by default
    expect(container.querySelector(".dfv-path")!.textContent).toBe("src/lib/one.ts");
    expect(container.querySelector(".dfv-f.on [class=dfv-nm], .dfv-f.on .dfv-nm")!.textContent).toBe("one.ts");
    // click another file row
    const row = container.querySelector('[data-dfv-file="src/lib/two.ts"]')!;
    fireEvent.click(row);
    expect(container.querySelector(".dfv-path")!.textContent).toBe("src/lib/two.ts");
    expect(container.querySelector(".dfv-f.on .dfv-nm")!.textContent).toBe("two.ts");
    // the pane shows the selected file's lines
    expect(container.querySelector(".dfv-code")!.textContent).toContain("+alpha");
  });

  it("filters the tree without losing the selection pane", () => {
    const { container } = render(<FilesChanged diff={MULTI} />);
    const input = container.querySelector<HTMLInputElement>(".dfv-filter")!;
    fireEvent.change(input, { target: { value: "three" } });
    const fileRows = container.querySelectorAll(".dfv-f");
    expect(fileRows.length).toBe(1);
    expect(fileRows[0].getAttribute("data-dfv-file")).toBe("docs/deep/nested/three.md");
  });

  it("falls back to the flat renderer for a non-git diff", () => {
    const { container } = render(<FilesChanged diff={"@@ -1 +1 @@\n-old\n+new"} />);
    expect(container.querySelector(".dfv")).toBeNull();
    expect(container.querySelector(".diff")).toBeTruthy();
    expect(container.querySelector(".dstat")!.textContent).toContain("+1");
    expect(container.querySelector(".dstat")!.textContent).toContain("−1");
  });

  it("renders the empty-diff placeholder", () => {
    const { container } = render(<FilesChanged diff={"   "} />);
    expect(container.textContent).toContain("No net change (empty diff).");
  });

  it("skips the sidebar for a single-file diff", () => {
    const single = MULTI.split("\n").slice(0, 7).join("\n");
    const { container } = render(<FilesChanged diff={single} />);
    expect(container.querySelector(".dfv")).toBeTruthy();
    expect(container.querySelector(".dfv-side")).toBeNull();
    expect(container.querySelector(".dfv-path")!.textContent).toBe("src/lib/one.ts");
  });
});

describe("FilesChanged full view", () => {
  afterEach(cleanup);

  it("expand button toggles the fixed full view and back", () => {
    const { container } = render(<FilesChanged diff={MULTI} />);
    const btn = container.querySelector<HTMLButtonElement>(".dfv-max")!;
    expect(btn).not.toBeNull();
    expect(btn.getAttribute("aria-label")).toMatch(/expand/i);
    expect(container.querySelector(".dfv-full")).toBeNull();

    fireEvent.click(btn);
    expect(container.querySelector(".dfv-full")).not.toBeNull();
    expect(btn.getAttribute("aria-label")).toMatch(/collapse/i);

    fireEvent.click(btn);
    expect(container.querySelector(".dfv-full")).toBeNull();
  });

  it("Escape collapses the full view", () => {
    const { container } = render(<FilesChanged diff={MULTI} />);
    fireEvent.click(container.querySelector(".dfv-max")!);
    expect(container.querySelector(".dfv-full")).not.toBeNull();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(container.querySelector(".dfv-full")).toBeNull();
  });

  it("full view restores body scrolling on collapse", () => {
    const { container } = render(<FilesChanged diff={MULTI} />);
    fireEvent.click(container.querySelector(".dfv-max")!);
    expect(document.body.style.overflow).toBe("hidden");
    fireEvent.keyDown(document, { key: "Escape" });
    expect(document.body.style.overflow).toBe("");
  });
});
