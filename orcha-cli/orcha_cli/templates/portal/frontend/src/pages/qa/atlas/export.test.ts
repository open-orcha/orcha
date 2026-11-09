/** The atlas to share: one self-contained page and a PDF around its pages' JPEGs. */
import { describe, expect, it } from "vitest";
import { compareLine, exportHtml, fileName, filterWords, pdfBytes, placeholder, titleOf } from "./export";
import juniper from "./juniper.fixture.json";
import { NO_FILTERS } from "./model";
import { parseAtlas } from "./types";

const ATLAS = parseAtlas(juniper);
const read = async () => "data:image/jpeg;base64,AAAA";

describe("Export", () => {
  it("writes one page with its screenshots inside, as filtered", async () => {
    const html = await exportHtml(ATLAS, NO_FILTERS, read);
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).toContain(`<title>${titleOf(ATLAS, NO_FILTERS).replace(/&/g, "&amp;")}</title>`);
    expect(html).toContain("data:image/jpeg;base64,AAAA");
    expect(html).toContain("made with Embodent on");
    expect(html.match(/<article class="card">/g)?.length).toBe(ATLAS.screens.length);
    const area = ATLAS.areas[0];
    const one = await exportHtml(ATLAS, { ...NO_FILTERS, area: area.key }, read);
    expect(one.match(/<article class="card">/g)?.length).toBe(area.screens.length);
    expect(titleOf(ATLAS, { area: area.key })).toContain(area.name);
  });

  it("escapes what the app says", async () => {
    const atlas = { ...ATLAS, screens: ATLAS.screens.map((s) => ({ ...s, name: `<b>${s.name}</b>` })) };
    const html = await exportHtml(atlas, NO_FILTERS, read);
    expect(html).not.toContain("<b>");
    expect(html).toContain("&lt;b&gt;");
  });

  it("says why a frame has no picture", () => {
    const s = ATLAS.screens[0];
    const p = s.platforms[0];
    expect(placeholder({ ...s, variants: { ...s.variants, [p]: { ...s.variants[p]!, blank: "flag_secure" } } }, p)).toContain("hides this screen from screenshots");
    expect(placeholder({ ...s, variants: { ...s.variants, [p]: { ...s.variants[p]!, blank: "uniform" } } }, p)).toBe("Its screenshot came back blank");
  });

  it("says the filters and the comparison in words", () => {
    expect(filterWords({ ...NO_FILTERS, platforms: ["ios", "android"], differs: true })).toBe("iOS and Android, differs across platforms");
    expect(compareLine({ ...ATLAS.counts, same: 2, minor: 1, different: 0, missing: 1, unchecked: 0, unmatched: 3 })).toBe("2 the same where seen, 1 differs where seen, 1 not on every platform, 3 not compared yet");
    expect(fileName({ name: "Juniper & Co" }, "pdf")).toBe("juniper-co-screen-atlas.pdf");
  });

  it("writes a PDF a reader can open: a page per image, its table of offsets exact", () => {
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
    const text = new TextDecoder("latin1").decode(pdfBytes([jpeg, jpeg], { w: 300, h: 150 }));
    expect(text.startsWith("%PDF-1.4")).toBe(true);
    expect(text).toContain("/Count 2");
    expect(text).toContain("/MediaBox [0 0 144 72]");
    expect(text.match(/\/Filter \/DCTDecode/g)?.length).toBe(2);
    const at = Number(/startxref\n(\d+)\n/.exec(text)![1]);
    expect(text.slice(at, at + 4)).toBe("xref");
    const first = /0000000000 65535 f \n(\d{10}) 00000 n/.exec(text)![1];
    expect(text.slice(Number(first), Number(first) + 7)).toBe("1 0 obj");
  });
});
