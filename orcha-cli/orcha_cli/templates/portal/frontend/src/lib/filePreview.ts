/**
 * File-preview type detection (pure — no React, no network). One answer to
 * "how should the portal show this file?" for the code viewer, every diff view
 * and deliverables: by extension, then MIME, then a byte sniff, so an unknown
 * binary is never dumped as text.
 *
 *   image  png jpg gif webp avif bmp ico   → <img> (checkerboard, fit/actual)
 *   svg    svg                             → <img> on a blob URL + source toggle
 *   pdf                                    → the browser's built-in viewer
 *   video  mp4 webm mov · audio mp3 wav ogg m4a flac → native players
 *   font   ttf otf woff woff2              → a FontFace specimen
 *   text   everything textual              → the existing code view
 *   binary everything else                 → "Preview not supported" card
 */

export type PreviewKind = "image" | "svg" | "pdf" | "video" | "audio" | "font" | "text" | "binary";

const EXT_KIND: Record<string, PreviewKind> = {
  png: "image", jpg: "image", jpeg: "image", gif: "image", webp: "image", avif: "image", bmp: "image", ico: "image",
  svg: "svg",
  pdf: "pdf",
  mp4: "video", m4v: "video", webm: "video", mov: "video",
  mp3: "audio", wav: "audio", ogg: "audio", oga: "audio", m4a: "audio", flac: "audio", aac: "audio",
  ttf: "font", otf: "font", woff: "font", woff2: "font",
  // known binaries with no browser preview — named so they never reach a text view
  zip: "binary", gz: "binary", tgz: "binary", bz2: "binary", xz: "binary", "7z": "binary", rar: "binary", tar: "binary",
  jar: "binary", war: "binary", apk: "binary", ipa: "binary", aab: "binary",
  exe: "binary", dll: "binary", so: "binary", dylib: "binary", a: "binary", o: "binary", obj: "binary", class: "binary",
  wasm: "binary", bin: "binary", dat: "binary", db: "binary", sqlite: "binary", sqlite3: "binary", realm: "binary",
  psd: "binary", ai: "binary", sketch: "binary", fig: "binary", xcf: "binary", heic: "binary", heif: "binary", tif: "binary", tiff: "binary",
  doc: "binary", docx: "binary", xls: "binary", xlsx: "binary", ppt: "binary", pptx: "binary", key: "binary", numbers: "binary", pages: "binary",
  eot: "binary", dmg: "binary", iso: "binary", pkg: "binary", deb: "binary", rpm: "binary", msi: "binary",
  pyc: "binary", mlmodel: "binary", onnx: "binary", pt: "binary", pb: "binary", npy: "binary", parquet: "binary",
  avi: "binary", mkv: "binary", wmv: "binary", flv: "binary",
};

const MIME_KIND: Array<[RegExp, PreviewKind]> = [
  [/^image\/svg\+xml\b/, "svg"],
  [/^image\/(png|jpeg|gif|webp|avif|bmp|x-icon|vnd\.microsoft\.icon)\b/, "image"],
  [/^application\/pdf\b/, "pdf"],
  [/^video\/(mp4|webm|quicktime)\b/, "video"],
  [/^audio\//, "audio"],
  [/^font\//, "font"],
  [/^(text\/|application\/(json|xml|javascript|x-yaml|yaml|toml))/, "text"],
  [/^application\/(octet-stream|zip|x-|gzip|vnd\.)/, "binary"],
];

/** Lower-cased extension of a path's basename ("" when none). */
export function extOf(path: string): string {
  const name = (path || "").split("/").pop() || "";
  const i = name.lastIndexOf(".");
  return i > 0 ? name.slice(i + 1).toLowerCase() : ""; // ".gitignore" has no extension
}

export function kindFromExt(path: string): PreviewKind | null {
  return EXT_KIND[extOf(path)] ?? null;
}

export function kindFromMime(mime: string | null | undefined): PreviewKind | null {
  const m = (mime || "").toLowerCase().trim();
  if (!m) return null;
  for (const [re, k] of MIME_KIND) if (re.test(m)) return k;
  return null;
}

/** Kinds the portal renders natively (as opposed to code text or a card). */
export function isRichKind(k: PreviewKind | null | undefined): boolean {
  return k === "image" || k === "svg" || k === "pdf" || k === "video" || k === "audio" || k === "font";
}

/** The format a file's leading bytes prove (magic numbers), or null. */
export function sniffBytes(b: Uint8Array): PreviewKind | null {
  const at = (i: number, ...xs: number[]) => xs.every((x, j) => b[i + j] === x);
  const ascii = (i: number, s: string) => at(i, ...Array.from(s, (c) => c.charCodeAt(0)));
  if (b.length < 4) return null;
  if (at(0, 0x89, 0x50, 0x4e, 0x47)) return "image";
  if (at(0, 0xff, 0xd8, 0xff)) return "image";
  if (ascii(0, "GIF8")) return "image";
  if (ascii(0, "RIFF") && ascii(8, "WEBP")) return "image";
  if (ascii(0, "RIFF") && ascii(8, "WAVE")) return "audio";
  if (at(0, 0x00, 0x00, 0x01, 0x00)) return "image";
  if (ascii(0, "%PDF-")) return "pdf";
  if (ascii(4, "ftyp")) {
    const brand = String.fromCharCode(b[8], b[9], b[10], b[11]);
    if (brand === "avif" || brand === "avis") return "image";
    if (brand === "M4A " || brand === "M4B ") return "audio";
    return "video";
  }
  if (at(0, 0x1a, 0x45, 0xdf, 0xa3)) return "video";
  if (ascii(0, "OggS") || ascii(0, "fLaC") || ascii(0, "ID3")) return "audio";
  if (ascii(0, "wOFF") || ascii(0, "wOF2") || ascii(0, "OTTO") || at(0, 0x00, 0x01, 0x00, 0x00)) return "font";
  if (at(0, 0x50, 0x4b, 0x03, 0x04) || at(0, 0x1f, 0x8b) || ascii(0, "SQLite format")) return "binary"; // zip / gzip / sqlite
  if (/^\s*(<\?xml[^>]*>\s*)?<svg[\s>]/i.test(new TextDecoder().decode(b.slice(0, 256)))) return "svg";
  if (b.subarray(0, 8000).includes(0)) return "binary";
  return null;
}

/** Text that is really binary (a NUL, or mostly control characters) — never
 *  rendered as code. */
export function looksBinaryText(s: string | null | undefined): boolean {
  if (!s) return false;
  const probe = s.slice(0, 8000);
  if (probe.includes("\u0000")) return true;
  let ctrl = 0;
  for (let i = 0; i < probe.length; i++) {
    const c = probe.charCodeAt(i);
    if ((c < 9 || (c > 13 && c < 32)) || c === 0xfffd) ctrl++;
  }
  return probe.length > 32 && ctrl / probe.length > 0.1;
}

/** One answer from every signal we have. Extension wins for the rich kinds;
 *  MIME and the byte sniff decide the rest. */
export function detectKind(o: { path: string; mime?: string | null; bytes?: Uint8Array | null; text?: string | null }): PreviewKind {
  const byExt = kindFromExt(o.path);
  const sniffed = o.bytes ? sniffBytes(o.bytes) : null;
  // a ".png" whose bytes are something else is not trusted as that format
  if (byExt && byExt !== "binary" && byExt !== "svg" && sniffed && sniffed !== byExt && sniffed !== "svg") return sniffed;
  if (byExt) return byExt;
  const byMime = kindFromMime(o.mime);
  if (byMime && byMime !== "text" && byMime !== "binary") return byMime;
  if (sniffed) return sniffed;
  if (byMime) return byMime;
  if (looksBinaryText(o.text)) return "binary";
  return "text";
}

/* ---- diffs ---------------------------------------------------------------- */

const BINARY_DIFF_RE = /^(GIT binary patch|Binary files .* differ)$/;

/** A diff section for a binary file: git's "GIT binary patch" (base85 payload)
 *  or its "Binary files a/x and b/x differ" summary. */
export function isBinaryDiff(lines: string[]): boolean {
  return lines.some((l) => BINARY_DIFF_RE.test(l));
}

/** The new side's byte size when the patch states it (`literal N`). */
export function binaryPatchNewSize(lines: string[]): number | null {
  const i = lines.findIndex((l) => l === "GIT binary patch");
  if (i < 0) return null;
  const m = /^literal (\d+)$/.exec(lines[i + 1] || "");
  return m ? Number(m[1]) : null;
}

/** The (old, new) blob ids from `index <old>..<new>` (all-zero → null). */
export function indexIds(lines: string[]): { oldId: string | null; newId: string | null } {
  for (const l of lines) {
    const m = /^index ([0-9a-f]{4,64})\.\.([0-9a-f]{4,64})/.exec(l);
    if (m) return { oldId: /^0+$/.test(m[1]) ? null : m[1], newId: /^0+$/.test(m[2]) ? null : m[2] };
  }
  return { oldId: null, newId: null };
}

/** Diff text with every binary-patch payload replaced by one placeholder line —
 *  base85 never reaches the screen, even in the flat fallback renderer. */
export function stripBinaryPayload(lines: string[]): string[] {
  const out: string[] = [];
  let inPatch = false;
  for (const l of lines) {
    if (l === "GIT binary patch") {
      inPatch = true;
      out.push("Binary file (contents not shown)");
      continue;
    }
    if (inPatch) {
      if (l.startsWith("diff --git ") || l.startsWith("--- ") || l.startsWith("@@")) inPatch = false;
      else continue;
    }
    out.push(l);
  }
  return out;
}

/* ---- sizes ---------------------------------------------------------------- */

export function formatBytes(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "";
  if (n < 1024) return n + " B";
  if (n < 1024 * 1024) return (n / 1024).toFixed(n < 10 * 1024 ? 1 : 0) + " KB";
  return (n / (1024 * 1024)).toFixed(1) + " MB";
}

/** Preview caps: past these the viewer shows a size notice + Download instead. */
export const PREVIEW_CAP_BYTES: Record<PreviewKind, number> = {
  image: 20 * 1024 * 1024,
  svg: 5 * 1024 * 1024,
  pdf: 50 * 1024 * 1024,
  font: 10 * 1024 * 1024,
  video: Infinity, // streamed by the native player, never buffered here
  audio: Infinity,
  text: 0,
  binary: 0,
};

export function withDownload(url: string): string {
  return url + (url.includes("?") ? "&" : "?") + "download=1";
}
