import { describe, expect, it } from "vitest";
import { parseDiffFiles } from "../components/FilesChanged";
import {
  binaryPatchNewSize,
  detectKind,
  extOf,
  formatBytes,
  indexIds,
  isBinaryDiff,
  kindFromExt,
  kindFromMime,
  looksBinaryText,
  sniffBytes,
  stripBinaryPayload,
} from "./filePreview";

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

const bytes = (...xs: (number | string)[]) =>
  new Uint8Array(xs.flatMap((x) => (typeof x === "string" ? Array.from(x, (c) => c.charCodeAt(0)) : [x])));

describe("type detection", () => {
  it("extension → kind for every family, dotfiles have none", () => {
    expect(extOf("a/b/Photo.JPG")).toBe("jpg");
    expect(extOf(".gitignore")).toBe("");
    for (const [p, k] of [
      ["x.png", "image"], ["x.jpeg", "image"], ["x.gif", "image"], ["x.webp", "image"], ["x.avif", "image"], ["x.bmp", "image"], ["x.ico", "image"],
      ["x.svg", "svg"], ["x.pdf", "pdf"], ["x.mp4", "video"], ["x.webm", "video"], ["x.mov", "video"],
      ["x.mp3", "audio"], ["x.wav", "audio"], ["x.ogg", "audio"], ["x.m4a", "audio"], ["x.woff2", "font"],
      ["x.zip", "binary"], ["x.exe", "binary"], ["x.sqlite", "binary"],
    ] as const)
      expect(kindFromExt(p)).toBe(k);
    expect(kindFromExt("x.ts")).toBeNull();
  });

  it("MIME → kind", () => {
    expect(kindFromMime("image/png")).toBe("image");
    expect(kindFromMime("image/svg+xml; charset=utf-8")).toBe("svg");
    expect(kindFromMime("application/pdf")).toBe("pdf");
    expect(kindFromMime("video/mp4")).toBe("video");
    expect(kindFromMime("audio/mpeg")).toBe("audio");
    expect(kindFromMime("text/plain; charset=utf-8")).toBe("text");
    expect(kindFromMime("application/octet-stream")).toBe("binary");
    expect(kindFromMime("")).toBeNull();
  });

  it("magic-byte sniff", () => {
    expect(sniffBytes(bytes(0x89, "PNG\r\n", 0x1a, "\n"))).toBe("image");
    expect(sniffBytes(bytes(0xff, 0xd8, 0xff, 0xe0))).toBe("image");
    expect(sniffBytes(bytes("GIF89a"))).toBe("image");
    expect(sniffBytes(bytes("RIFF", 0, 0, 0, 0, "WEBP"))).toBe("image");
    expect(sniffBytes(bytes("%PDF-1.7"))).toBe("pdf");
    expect(sniffBytes(bytes(0, 0, 0, 0x18, "ftypisom"))).toBe("video");
    expect(sniffBytes(bytes(0x1a, 0x45, 0xdf, 0xa3))).toBe("video");
    expect(sniffBytes(bytes("ID3", 4, 0))).toBe("audio");
    expect(sniffBytes(bytes("PK", 3, 4, 20, 0))).toBe("binary");
    expect(sniffBytes(bytes('<svg xmlns="http://www.w3.org/2000/svg">'))).toBe("svg");
    expect(sniffBytes(bytes("abc", 0, "def"))).toBe("binary");
    expect(sniffBytes(bytes("hello world"))).toBeNull();
  });

  it("combines extension, MIME and sniff — unknown binaries never fall to text", () => {
    expect(detectKind({ path: "a.png" })).toBe("image");
    expect(detectKind({ path: "a.png", bytes: bytes("%PDF-1.4") })).toBe("pdf"); // bytes beat a lying extension
    expect(detectKind({ path: "blob", bytes: bytes(0x89, "PNG\r\n", 0x1a, "\n") })).toBe("image");
    expect(detectKind({ path: "blob", mime: "video/webm" })).toBe("video");
    expect(detectKind({ path: "blob", mime: "application/octet-stream" })).toBe("binary");
    expect(detectKind({ path: "notes", text: "plain words" })).toBe("text");
    expect(detectKind({ path: "notes", text: "a\u0000b" })).toBe("binary");
    expect(looksBinaryText("\u0001\u0002\u0003\u0004".repeat(20))).toBe(true);
  });
});

describe("binary diffs", () => {
  const lines = PNG_PATCH.split("\n");
  it("recognises GIT binary patch and 'Binary files … differ'", () => {
    expect(isBinaryDiff(lines)).toBe(true);
    expect(isBinaryDiff(["Binary files a/x.png and b/x.png differ"])).toBe(true);
    expect(isBinaryDiff(["@@ -1 +1 @@", "-a", "+b"])).toBe(false);
    expect(binaryPatchNewSize(lines)).toBe(72);
    expect(indexIds(lines)).toEqual({ oldId: null, newId: "c06048b6cce1fb6afa5790fbb791bfbe43a926eb" });
  });

  it("strips the base85 payload", () => {
    const out = stripBinaryPayload(lines).join("\n");
    expect(out).toContain("Binary file (contents not shown)");
    expect(out).not.toContain("zcmeAS");
    expect(out).not.toContain("HcmV?d00001");
    expect(out).not.toMatch(/^literal /m);
  });

  it("parseDiffFiles flags the file binary, keeps its status/size and counts no +/- lines", () => {
    const [f] = parseDiffFiles(PNG_PATCH + "diff --git a/x.ts b/x.ts\n--- a/x.ts\n+++ b/x.ts\n@@ -1 +1 @@\n-a\n+b\n");
    expect(f).toMatchObject({ path: "assets/logo.png", status: "A", binary: true, size: 72, add: 0, del: 0 });
    const files = parseDiffFiles("diff --git a/n.bin b/n.bin\nindex 1..2\nBinary files /dev/null and b/n.bin differ\n");
    expect(files[0]).toMatchObject({ binary: true, status: "A" });
    expect(formatBytes(22299)).toBe("22 KB");
  });
});
