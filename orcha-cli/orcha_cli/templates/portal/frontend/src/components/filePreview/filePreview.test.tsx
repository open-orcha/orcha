import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FilesChanged } from "../FilesChanged";
import { BinaryDiffView } from "./BinaryDiff";
import { FilePreview } from "./FilePreview";
import { runBlobSource, worktreeBlobSource } from "./sources";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const PNG_PATCH = `diff --git a/assets/logo.png b/assets/logo.png
new file mode 100644
index 0000000000000000000000000000000000000000..c06048b6cce1fb6afa5790fbb791bfbe43a926eb
GIT binary patch
literal 72
zcmeAS@N?(olHy\`uWMXDvWn<^y<l^Sx<>MC+6cQE@6%&_\`l#-T_m6KOcR8m$^Ra4i{
b)Y8_\`)zddHG%_|ZH8Z!cw6eCbwX+8RA9e|f

literal 0
HcmV?d00001
`;
const MOD_PATCH = `diff --git a/shot.jpg b/shot.jpg
index 1111111..2222222 100644
Binary files a/shot.jpg and b/shot.jpg differ
diff --git a/gone.png b/gone.png
deleted file mode 100644
index 3333333..0000000
Binary files a/gone.png and /dev/null differ
diff --git a/src/a.ts b/src/a.ts
--- a/src/a.ts
+++ b/src/a.ts
@@ -1 +1 @@
-a
+b
`;
const BASE85 = /zcmeAS|HcmV\?d00001|b\)Y8_/;

type Reply = { status?: number; body?: Uint8Array | string; headers?: Record<string, string> };
let routes: Array<[RegExp, Reply]> = [];
let calls: string[] = [];
let made: Array<{ type: string }> = [];

function reply(r: Reply): Response {
  const body = r.body ?? new Uint8Array();
  const size = typeof body === "string" ? new TextEncoder().encode(body).length : body.length;
  return new Response(r.status && r.status >= 400 ? JSON.stringify({ detail: "nope" }) : (body as BodyInit), {
    status: r.status ?? 200,
    headers: { "x-orcha-size": String(size), ...(r.headers || {}) },
  });
}

beforeEach(() => {
  routes = [];
  calls = [];
  made = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      calls.push(url);
      const hit = routes.find(([re]) => re.test(url));
      return reply(hit ? hit[1] : { status: 404 });
    }),
  );
  let n = 0;
  URL.createObjectURL = vi.fn((b: Blob) => {
    made.push({ type: b.type });
    return "blob:test/" + ++n;
  }) as typeof URL.createObjectURL;
  URL.revokeObjectURL = vi.fn();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const noBase85 = (el: HTMLElement) => expect(el.textContent || "").not.toMatch(BASE85);

describe("FilesChanged × binary files", () => {
  it("without a blob source: a 'Binary file' card, never the base85 payload", () => {
    const { container } = render(<FilesChanged diff={PNG_PATCH} />);
    expect(screen.getByTestId("fp-unsupported")).toHaveAttribute("data-reason", "no_source");
    expect(screen.getByText("Binary file")).toBeInTheDocument();
    expect(screen.getByText("· 72 B")).toBeInTheDocument();
    noBase85(container);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("an added image previews only its 'after' side from the run's raw route", async () => {
    routes.push([/side=new/, { body: PNG, headers: { "content-type": "image/png" } }]);
    const src = runBlobSource({ agent_id: "a1", run_id: "r1" });
    const { container } = render(<FilesChanged diff={PNG_PATCH} blobSource={src} />);
    const img = await screen.findByAltText("Added: assets/logo.png");
    expect(img).toHaveAttribute("src", "blob:test/1");
    expect(calls).toEqual(["/api/agents/a1/runs/r1/changes/raw?path=assets%2Flogo.png&side=new"]);
    expect(container.querySelector(".fp-checker")).not.toBeNull();
    noBase85(container);
  });

  it("a modified image compares before/after: 2-up, swipe and onion skin", async () => {
    routes.push([/side=old/, { body: PNG }], [/side=new/, { body: PNG }]);
    render(<FilesChanged diff={MOD_PATCH} blobSource={runBlobSource({ agent_id: "a1", run_id: "r1" })} />);
    expect(await screen.findByAltText("Before: shot.jpg")).toBeInTheDocument();
    expect(await screen.findByAltText("After: shot.jpg")).toBeInTheDocument();
    const cmp = screen.getByTestId("fp-compare");
    expect(cmp).toHaveAttribute("data-mode", "2up");

    fireEvent.click(within(cmp).getByRole("radio", { name: "Swipe" }));
    const swipe = await screen.findByTestId("fp-swipe");
    const slider = screen.getByRole("slider", { name: "Swipe position" });
    fireEvent.change(slider, { target: { value: "30" } });
    expect((within(swipe).getByAltText("After: shot.jpg") as HTMLImageElement).style.clipPath).toBe("inset(0 0 0 30%)");

    fireEvent.click(within(cmp).getByRole("radio", { name: "Onion skin" }));
    const onion = await screen.findByTestId("fp-onion");
    fireEvent.change(screen.getByRole("slider", { name: "After image opacity" }), { target: { value: "25" } });
    expect((within(onion).getByAltText("After: shot.jpg") as HTMLImageElement).style.opacity).toBe("0.25");
  });

  it("a deleted image shows only 'before'; text files keep their text diff", async () => {
    routes.push([/side=old/, { body: PNG }]);
    render(<FilesChanged diff={MOD_PATCH} blobSource={runBlobSource({ agent_id: "a1", run_id: "r1" })} />);
    fireEvent.click(screen.getByText("gone.png"));
    expect(await screen.findByAltText("Deleted: gone.png")).toBeInTheDocument();
    expect(calls.some((u) => u.includes("gone.png") && u.includes("side=new"))).toBe(false);
    fireEvent.click(screen.getByText("a.ts"));
    expect(screen.getByText("+b")).toBeInTheDocument();
  });

  it("the flat fallback (no file headers) strips the payload too", () => {
    const { container } = render(<FilesChanged diff={"GIT binary patch\nliteral 72\nzcmeAS@N?(olHy\n\nliteral 0\nHcmV?d00001\n"} />);
    expect(screen.getByText("Binary file (contents not shown)")).toBeInTheDocument();
    noBase85(container);
  });

  it("worktree source maps old→HEAD and new→working tree", () => {
    const s = worktreeBlobSource("c1");
    expect(s({ path: "a.png", status: "M" }, "old")).toBe("/api/containers/c1/code/worktree/raw?path=a.png&side=head");
    expect(s({ path: "a.png", status: "M" }, "new")).toBe("/api/containers/c1/code/worktree/raw?path=a.png&side=working");
    expect(runBlobSource({ run_id: "r1" })).toBeNull();
  });
});

describe("FilePreview renderers", () => {
  it("image: checkerboard, Fit / Actual size, dimensions + size", async () => {
    routes.push([/raw/, { body: PNG }]);
    const { container } = render(<FilePreview url="/raw?p=a.png" path="a.png" />);
    const img = (await screen.findByAltText("a.png")) as HTMLImageElement;
    Object.defineProperty(img, "naturalWidth", { value: 640 });
    Object.defineProperty(img, "naturalHeight", { value: 480 });
    fireEvent.load(img);
    expect(screen.getByTestId("fp-meta").textContent).toBe("640 × 480 · 12 B");
    const stage = container.querySelector(".fp-stage")!;
    expect(stage.className).toContain("fp-checker");
    expect(stage.className).not.toContain("is-actual");
    fireEvent.click(screen.getByRole("radio", { name: "Actual size" }));
    expect(stage.className).toContain("is-actual");
    expect(screen.getByRole("link", { name: "Download" })).toHaveAttribute("href", "/raw?p=a.png&download=1");
  });

  it("svg: rendered as an <img> on an image/svg+xml blob (never inline markup), with a Source toggle", async () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script><circle r="4"/></svg>';
    routes.push([/raw/, { body: svg, headers: { "content-type": "image/svg+xml" } }]);
    const { container } = render(<FilePreview url="/raw?p=i.svg" path="icons/i.svg" />);
    expect(await screen.findByAltText("i.svg")).toHaveAttribute("src", "blob:test/1");
    expect(made[0].type).toBe("image/svg+xml");
    expect(container.querySelector("circle, script")).toBeNull();
    fireEvent.click(screen.getByRole("radio", { name: "Source" }));
    expect(screen.getByTestId("fp-svg-source").textContent).toContain("<circle r=\"4\"/>");
    expect(container.querySelector("circle, script")).toBeNull();
  });

  it("pdf: the built-in viewer in an iframe, or an Open / Download card where there is none", () => {
    const { unmount } = render(<FilePreview url="/raw?p=r.pdf" path="r.pdf" />);
    expect(screen.getByTitle("r.pdf").tagName).toBe("IFRAME");
    expect(screen.getByTitle("r.pdf")).toHaveAttribute("src", "/raw?p=r.pdf");
    unmount();
    Object.defineProperty(navigator, "pdfViewerEnabled", { value: false, configurable: true });
    render(<FilePreview url="/raw?p=r.pdf" path="r.pdf" />);
    expect(screen.getByTestId("fp-pdf-card")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open" })).toHaveAttribute("href", "/raw?p=r.pdf");
    expect(screen.getByRole("link", { name: "Download" })).toHaveAttribute("href", "/raw?p=r.pdf&download=1");
    delete (navigator as { pdfViewerEnabled?: boolean }).pdfViewerEnabled;
  });

  it("video and audio: native players streaming the raw URL", () => {
    const { container } = render(
      <>
        <FilePreview url="/raw?p=c.mp4" path="c.mp4" />
        <FilePreview url="/raw?p=s.mp3" path="s.mp3" />
      </>,
    );
    expect(container.querySelector("video")).toHaveAttribute("src", "/raw?p=c.mp4");
    expect(container.querySelector("video")).toHaveAttribute("controls");
    expect(container.querySelector("audio")).toHaveAttribute("src", "/raw?p=s.mp3");
    expect(fetch).not.toHaveBeenCalled(); // streamed, never buffered
  });

  it("unsupported: 'Preview not supported for .zip files · size · Download' and no bytes as text", async () => {
    routes.push([/raw/, { body: new Uint8Array([0x50, 0x4b, 3, 4, 0, 0, 0, 0]), headers: { "x-orcha-size": "4096" } }]);
    const { container } = render(<FilePreview url="/raw?p=b.zip" path="b.zip" />);
    expect(await screen.findByText("Preview not supported for .zip files")).toBeInTheDocument();
    expect(screen.getByText("· 4.0 KB")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Download" })).toHaveAttribute("href", "/raw?p=b.zip&download=1");
    expect(container.textContent).not.toContain("PK");
  });

  it("unknown extension: the byte sniff picks the renderer", async () => {
    routes.push([/raw/, { body: PNG, headers: { "content-type": "application/octet-stream" } }]);
    render(<FilePreview url="/raw?p=thumb" path="cache/thumb" />);
    expect(await screen.findByAltText("thumb")).toBeInTheDocument();
  });

  it("over the image cap: a size notice, the body is never read", async () => {
    routes.push([/raw/, { body: PNG, headers: { "x-orcha-size": String(25 * 1024 * 1024) } }]);
    render(<FilePreview url="/raw?p=big.png" path="big.png" />);
    const card = await screen.findByTestId("fp-unsupported");
    expect(card).toHaveAttribute("data-reason", "too_large");
    expect(card.textContent).toContain("Too large to preview");
    expect(card.textContent).toContain("25.0 MB");
    expect(made).toHaveLength(0);
  });

  it("a missing side says so", async () => {
    render(<BinaryDiffView file={{ path: "x.png", status: "M" }} source={(_f, side) => "/raw?side=" + side} />);
    const cards = await screen.findAllByText("This version isn't available");
    expect(cards).toHaveLength(2);
  });
});
