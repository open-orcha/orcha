/**
 * The Screen atlas to share: the atlas, or one area of it, as a page anyone can open (one HTML
 * file, its screenshots inside it) or as a PDF for a design review. Both read the atlas the page
 * holds with the page's filters, so what is shared is what was on screen.
 *
 * Made here in the browser, with no model and no server renderer: each frame is read and scaled on
 * a canvas; the PDF is drawn on canvases too, a page per area, and written around their JPEGs.
 */
import { BADGE_WORD, filterAtlas, PLATFORM_WORD, shownPlatforms, type AreaRow, type AtlasFilters } from "./model";
import type { Atlas, AtlasCounts, AtlasScreen, Badge, Platform } from "./types";

const CSS = `
:root{--bg:#f7f7f8;--panel:#fff;--fg:#111827;--muted:#6b7280;--line:#e5e7eb;--same:#15803d;--minor:#b45309;--diff:#b91c1c;--miss:#6d28d9;--none:#6b7280}
@media (prefers-color-scheme: dark){:root{--bg:#0b0d12;--panel:#151821;--fg:#f3f4f6;--muted:#9ca3af;--line:#262a35;--same:#4ade80;--minor:#fbbf24;--diff:#f87171;--miss:#c4b5fd;--none:#9ca3af}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif}
header{padding:28px 24px 8px}h1{margin:0;font-size:24px}header p{margin:4px 0 0;color:var(--muted)}
section{padding:16px 24px}h2{font-size:18px;margin:0 0 2px}section>p{margin:0 0 12px;color:var(--muted)}
.row{display:grid;grid-template-columns:repeat(auto-fill,minmax(var(--card),1fr));gap:14px}
.card{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:12px;break-inside:avoid}
.card h3{margin:0;font-size:15px}.route{color:var(--muted);font-size:12px;font-family:ui-monospace,monospace}
.frames{display:flex;gap:8px;margin:10px 0;align-items:flex-start}.frame{flex:1;min-width:0;text-align:center;font-size:11px;color:var(--muted)}
.frame img{width:100%;border-radius:10px;border:1px solid var(--line);display:block;margin-bottom:4px}
.ph{aspect-ratio:9/19;border:1.5px dashed var(--line);border-radius:10px;display:flex;align-items:center;justify-content:center;padding:6px;margin-bottom:4px}
.ph.web{aspect-ratio:16/10}.badge{display:inline-block;font-size:12px;font-weight:600;padding:2px 8px;border-radius:999px;border:1px solid currentColor}
.same{color:var(--same)}.minor{color:var(--minor)}.different{color:var(--diff)}.missing{color:var(--miss)}.unchecked,.unmatched{color:var(--none)}
ul{margin:6px 0 0;padding-left:18px;color:var(--muted);font-size:13px}footer{padding:24px;color:var(--muted);font-size:12px}
@media print{body{background:#fff}.card{border-color:#ddd}}
`;

const esc = (t: string): string => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** What the filters narrow it to, in words for the page's header. */
export function filterWords(f: AtlasFilters): string {
  const bits: string[] = [];
  if (f.platforms.length) bits.push(f.platforms.map((p) => PLATFORM_WORD[p]).join(" and "));
  if (f.devices?.length) bits.push("on " + f.devices.map((d) => `${d}s`).join(" and "));
  if (f.appearances?.length) bits.push("in " + f.appearances.join(" and "));
  if (f.differs) bits.push("differs across platforms");
  if (f.changed) bits.push("changed recently");
  if (f.neverSeen) bits.push("never seen live");
  if (f.q) bits.push(`matching “${f.q}”`);
  return bits.join(", ");
}

/** What a frame with no screenshot says, in the person's words: why a screen seen live has none
 * (its capture was blank), else what is known of it. */
export function placeholder(s: AtlasScreen, p: Platform): string {
  const blank = s.variants[p]?.blank;
  if (blank === "flag_secure") return `The ${PLATFORM_WORD[p]} app hides this screen from screenshots`;
  if (blank) return "Its screenshot came back blank";
  const word = PLATFORM_WORD[p];
  return { unseen: "Not seen yet", absent: `Not in the ${word} code`, unknown: `No ${word} match found`, seen: "Not seen yet" }[s.presence[p] ?? "unseen"];
}

/** How the platforms compare, as the page's header says it. */
export function compareLine(c: AtlasCounts): string {
  const differ = c.minor + c.different;
  const bits = [`${c.same} the same where seen`, `${differ} ${differ === 1 ? "differs" : "differ"} where seen`];
  if (c.missing) bits.push(`${c.missing} not on every platform`);
  const waiting = c.unchecked + c.unmatched;
  if (waiting) bits.push(`${waiting} not compared yet`);
  return bits.join(", ");
}

export function titleOf(atlas: Pick<Atlas, "name" | "areas">, f: Pick<AtlasFilters, "area">): string {
  const area = f.area ? atlas.areas.find((a) => a.key === f.area)?.name : null;
  return area ? `${atlas.name || "App"} · ${area}` : `${atlas.name || "App"} · Screen atlas`;
}

/** The screens the export keeps, in the storyboard's order, and the platforms it shows. */
function selection(atlas: Atlas, f: AtlasFilters): { rows: AreaRow[]; plats: Platform[] } {
  return { rows: filterAtlas(atlas, f), plats: shownPlatforms(atlas, f) };
}

/** A frame at `width` px as a JPEG data URL, to keep a shared page light; null when it cannot be read. */
export type FrameRead = (url: string, width: number) => Promise<string | null>;

/** One self-contained page: the selection's areas as rows of cards, each with its platforms'
 * screenshots side by side, its badge and why. Light and dark follow the reader's system. */
export async function exportHtml(atlas: Atlas, f: AtlasFilters, read: FrameRead = readFrame): Promise<string> {
  const { rows, plats } = selection(atlas, f);
  const width = plats.length === 1 ? 220 : 140;
  const card = plats.length === 1 ? 260 : 150 * plats.length + 40;
  const words = filterWords(f);
  const title = esc(titleOf(atlas, f));
  const parts = [
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">`,
    `<title>${title}</title><style>${CSS}</style></head><body style="--card:${card}px">`,
    `<header><h1>${title}</h1><p>${atlas.counts.screens} screens on ${esc(atlas.platforms.map((p) => PLATFORM_WORD[p]).join(", ") || "no platform yet")}`
      + (words ? ` · ${esc(words)}` : "") + ` · made with Embodent on ${esc(String(atlas.generated_at ?? "").slice(0, 10))}</p></header>`,
  ];
  for (const { area, screens } of rows) {
    parts.push(`<section><h2>${esc(area.name)}</h2><p>${esc(area.summary ?? "")}</p><div class="row">`);
    for (const s of screens) {
      parts.push(`<article class="card"><h3>${esc(s.name)}</h3>`);
      if (s.route) parts.push(`<div class="route">${esc(s.route)}</div>`);
      parts.push(`<div class="frames">`);
      for (const p of plats) {
        const url = s.variants[p]?.frame_url;
        const img = url ? await read(url, width) : null;
        if (img) parts.push(`<div class="frame"><img alt="${esc(s.name)} on ${PLATFORM_WORD[p]}" src="${img}">${PLATFORM_WORD[p]}</div>`);
        else parts.push(`<div class="frame"><div class="ph${p === "web" ? " web" : ""}">${esc(placeholder(s, p))}</div>${PLATFORM_WORD[p]}</div>`);
      }
      parts.push(`</div>`);
      const sim = s.similarity;
      if (sim) {
        parts.push(`<span class="badge ${sim.badge}">${esc(BADGE_WORD[sim.badge])}</span>`);
        parts.push(`<ul>${sim.reasons.map((r) => `<li>${esc(r)}</li>`).join("")}</ul>`);
      }
      if (s.change) {
        const lines = s.change.platforms.map((c) => `${PLATFORM_WORD[c.platform]}: ${c.what.join("; ")}`);
        parts.push(`<ul><li>Changed since ${esc(atlas.since.label)}: ${lines.map(esc).join("</li><li>")}</li></ul>`);
      }
      parts.push(`</article>`);
    }
    parts.push(`</div></section>`);
  }
  parts.push(`<footer>Screenshots from Embodent runs. A dashed frame is a screen known from the code that no run has reached yet.</footer></body></html>`);
  return parts.join("");
}

// ---------- reading a frame ----------

async function bitmapOf(url: string): Promise<ImageBitmap | null> {
  try {
    const res = await fetch(url, { credentials: "same-origin" });
    return res.ok ? await createImageBitmap(await res.blob()) : null;
  } catch {
    return null;
  }
}

export const readFrame: FrameRead = async (url, width) => {
  const img = await bitmapOf(url);
  if (!img) return null;
  const c = document.createElement("canvas");
  c.width = width;
  c.height = Math.max(1, Math.round((img.height * width) / img.width));
  c.getContext("2d")?.drawImage(img, 0, 0, c.width, c.height);
  img.close();
  return c.toDataURL("image/jpeg", 0.82);
};

// ---------- the PDF ----------

const PAGE = { w: 1754, h: 1240 }; // A4 landscape at 150 dpi
const INK: Record<Badge, string> = { same: "#15803d", minor: "#b45309", different: "#b91c1c", missing: "#6d28d9", unchecked: "#6b7280", unmatched: "#6b7280" };
const FONT = (size: number) => `${size}px system-ui, -apple-system, "Segoe UI", sans-serif`;

function wrap(d: CanvasRenderingContext2D, text: string, width: number): string[] {
  const lines: string[] = [];
  let cur = "";
  for (const w of text.split(/\s+/)) {
    const next = `${cur} ${w}`.trim();
    if (d.measureText(next).width <= width || !cur) cur = next;
    else {
      lines.push(cur);
      cur = w;
    }
  }
  if (cur) lines.push(cur);
  return lines;
}

const say = (d: CanvasRenderingContext2D, text: string, x: number, y: number, fill: string, size: number) => {
  d.fillStyle = fill;
  d.font = FONT(size);
  d.textBaseline = "top";
  d.fillText(text, x, y);
};

/** One PDF page per JPEG: pages at `PAGE`'s size, each a full-bleed image. */
export function pdfBytes(jpegs: readonly Uint8Array[], size: { w: number; h: number } = PAGE): Uint8Array {
  const enc = new TextEncoder();
  const chunks: Uint8Array[] = [];
  const offsets: number[] = [];
  let at = 0;
  const put = (b: Uint8Array | string) => {
    const bytes = typeof b === "string" ? enc.encode(b) : b;
    chunks.push(bytes);
    at += bytes.length;
  };
  const object = (n: number, body: string, stream?: Uint8Array) => {
    offsets[n] = at;
    put(`${n} 0 obj\n${body}\n`);
    if (stream) {
      put("stream\n");
      put(stream);
      put("\nendstream\n");
    }
    put("endobj\n");
  };
  const wPt = (size.w * 72) / 150;
  const hPt = (size.h * 72) / 150;
  put("%PDF-1.4\n%âãÏÓ\n");
  const page = (i: number) => 3 + i * 3;
  object(1, "<< /Type /Catalog /Pages 2 0 R >>");
  object(2, `<< /Type /Pages /Count ${jpegs.length} /Kids [${jpegs.map((_, i) => `${page(i)} 0 R`).join(" ")}] >>`);
  jpegs.forEach((jpeg, i) => {
    const n = page(i);
    object(n, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${wPt} ${hPt}] /Resources << /XObject << /Im0 ${n + 1} 0 R >> >> /Contents ${n + 2} 0 R >>`);
    object(n + 1, `<< /Type /XObject /Subtype /Image /Width ${size.w} /Height ${size.h} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>`, jpeg);
    const draw = enc.encode(`q ${wPt} 0 0 ${hPt} 0 0 cm /Im0 Do Q`);
    object(n + 2, `<< /Length ${draw.length} >>`, draw);
  });
  const objects = 3 + jpegs.length * 3;
  const xref = at;
  put(`xref\n0 ${objects}\n0000000000 65535 f \n`);
  for (let i = 1; i < objects; i += 1) put(`${String(offsets[i]).padStart(10, "0")} 00000 n \n`);
  put(`trailer\n<< /Size ${objects} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  const out = new Uint8Array(at);
  let to = 0;
  for (const c of chunks) {
    out.set(c, to);
    to += c.length;
  }
  return out;
}

/** The selection as a PDF: a cover with the counts, then each area on its own pages, its screens
 * in a grid, each with its platforms' screenshots side by side, its badge and why. */
export async function exportPdf(atlas: Atlas, f: AtlasFilters): Promise<Blob> {
  const { rows, plats } = selection(atlas, f);
  const margin = 70;
  const gap = 28;
  const cols = plats.length === 1 ? 6 : plats.length === 2 ? 4 : 3;
  const cellW = Math.floor((PAGE.w - 2 * margin - gap * (cols - 1)) / cols);
  const thumbW = Math.floor((cellW - 16 - 12 * (plats.length - 1)) / Math.max(1, plats.length));
  const thumbH = Math.min(thumbW * 2, 320);
  const cellH = 70 + thumbH + 28 + 26 + 2 * 22;
  const pages: HTMLCanvasElement[] = [];
  const newPage = (title: string, sub?: string | null) => {
    const c = document.createElement("canvas");
    c.width = PAGE.w;
    c.height = PAGE.h;
    const d = c.getContext("2d")!;
    d.fillStyle = "#fff";
    d.fillRect(0, 0, PAGE.w, PAGE.h);
    say(d, title, margin, 50, "#111827", 40);
    if (sub) say(d, sub, margin, 102, "#6b7280", 22);
    say(d, `${atlas.name ?? ""} · Screen atlas · Embodent`, margin, PAGE.h - 50, "#9ca3af", 18);
    pages.push(c);
    return d;
  };
  const cover = newPage(titleOf(atlas, f), filterWords(f) || null);
  const c = atlas.counts;
  [`${c.screens} screens in ${c.areas} areas`, `${c.seen} seen live, ${c.never_seen} known from the code only`, compareLine(c), `${c.changed} changed since ${atlas.since.label}`]
    .forEach((line, i) => say(cover, line, margin, 220 + i * 52, "#374151", 30));
  for (const { area, screens } of rows) {
    let d = newPage(area.name, area.summary);
    let y = 150;
    let col = 0;
    for (const s of screens) {
      if (y + cellH > PAGE.h - 80) {
        d = newPage(`${area.name} (continued)`);
        y = 150;
        col = 0;
      }
      const x = margin + col * (cellW + gap);
      d.strokeStyle = "#e5e7eb";
      d.lineWidth = 2;
      d.beginPath();
      d.roundRect(x, y, cellW, cellH, 16);
      d.stroke();
      say(d, s.name.slice(0, 40), x + 14, y + 12, "#111827", 24);
      if (s.route) say(d, s.route.slice(0, 48), x + 14, y + 42, "#6b7280", 16);
      const ty = y + 70;
      for (const [i, p] of plats.entries()) {
        const tx = x + 8 + i * (thumbW + 12);
        const url = s.variants[p]?.frame_url;
        const img = url ? await bitmapOf(url) : null;
        if (img) {
          const scale = Math.min(thumbW / img.width, thumbH / img.height, 1);
          const w = img.width * scale;
          d.drawImage(img, tx + (thumbW - w) / 2, ty, w, img.height * scale);
          img.close();
        } else {
          const phH = p === "web" ? Math.round(thumbW * 0.62) : thumbH;
          d.strokeStyle = "#d1d5db";
          d.beginPath();
          d.roundRect(tx, ty, thumbW, phH, 12);
          d.stroke();
          d.font = FONT(16);
          wrap(d, placeholder(s, p), thumbW - 16).forEach((part, j) => say(d, part, tx + 8, ty + phH / 2 - 10 + j * 20, "#6b7280", 16));
        }
        say(d, PLATFORM_WORD[p], tx, ty + thumbH + 4, "#6b7280", 16);
      }
      let ry = ty + thumbH + 28;
      const sim = s.similarity;
      if (sim) {
        say(d, BADGE_WORD[sim.badge], x + 14, ry, INK[sim.badge], 19);
        ry += 26;
        d.font = FONT(16);
        const said = sim.reasons.slice(0, 2).flatMap((r) => wrap(d, r, cellW - 28));
        for (const part of said.slice(0, 2)) {
          say(d, part, x + 14, ry, "#4b5563", 16);
          ry += 22;
        }
      }
      col += 1;
      if (col === cols) {
        col = 0;
        y += cellH + gap;
      }
    }
  }
  const jpegs = await Promise.all(pages.map((p) => new Promise<Uint8Array>((done, fail) => {
    p.toBlob((b) => (b ? b.arrayBuffer().then((a) => done(new Uint8Array(a)), fail) : fail(new Error("A page could not be drawn."))), "image/jpeg", 0.9);
  })));
  return new Blob([pdfBytes(jpegs) as BlobPart], { type: "application/pdf" });
}

/** The file's name: `shop-screen-atlas.pdf`. */
export function fileName(atlas: Pick<Atlas, "name">, ext: "html" | "pdf"): string {
  const slug = (atlas.name ?? "app").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "app";
  return `${slug}-screen-atlas.${ext}`;
}

/** Hands the file to the browser as a download. */
export function saveFile(body: Blob | string, name: string, type = "text/html"): void {
  const url = URL.createObjectURL(typeof body === "string" ? new Blob([body], { type }) : body);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

