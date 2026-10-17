/**
 * BrandLogo — the REAL brand marks for the model providers and agent runtimes
 * the portal supports, vendored path-for-path from licensed icon packages
 * (fetched with `npm pack` into a scratch dir; NOT runtime dependencies).
 * Do not redraw, simplify or approximate these paths — BrandLogo.test.tsx
 * pins them to the upstream bytes.
 *
 * Provenance + license, per icon:
 *  - anthropic — simple-icons 16.33.0, `icons/anthropic.svg` (CC0-1.0).
 *                Upstream hex #191919 is near-black and invisible on the dark
 *                canvas, so the mark renders in currentColor (monochrome).
 *  - claude    — simple-icons 16.33.0, `icons/claude.svg` (CC0-1.0), brand hex
 *                #D97757 from simple-icons `data/simple-icons.json`. Same bytes
 *                as desktop/src/renderer/src/terminal/brandMarks.tsx.
 *  - openai    — simple-icons 15.22.0, `icons/openai.svg` (CC0-1.0) — the last
 *                simple-icons release that ships it (removed in 16.0.0).
 *                Monochrome (currentColor), as OpenAI's own guidelines use it.
 *  - xai       — @lobehub/icons-static-svg 1.95.1, `icons/xai.svg` (MIT,
 *                © LobeHub). Monochrome (the upstream file is fill=currentColor).
 *  - gemini    — simple-icons 16.33.0, `icons/googlegemini.svg` (CC0-1.0),
 *                brand hex #8E75B2 from simple-icons `data/simple-icons.json`.
 *
 * Any brand without a licensed mark gets a neutral glyph with its initial —
 * never a hand-drawn lookalike.
 *
 * Licence notice for the MIT-licensed mark above (xai — @lobehub/icons-static-svg
 * 1.95.1; the package ships no LICENSE file, text from github.com/lobehub/lobe-icons):
 *   MIT License
 *   Copyright (c) 2023 LobeHub
 *
 *   Permission is hereby granted, free of charge, to any person obtaining a copy of this
 *   software and associated documentation files (the "Software"), to deal in the Software
 *   without restriction, including without limitation the rights to use, copy, modify, merge,
 *   publish, distribute, sublicense, and/or sell copies of the Software, and to permit
 *   persons to whom the Software is furnished to do so, subject to the following conditions:
 *
 *   The above copyright notice and this permission notice shall be included in all copies or
 *   substantial portions of the Software.
 *
 *   THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED,
 *   INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR
 *   PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE
 *   FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
 *   OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER
 *   DEALINGS IN THE SOFTWARE.
 */
import type { CSSProperties } from "react";

export type BrandId = "anthropic" | "claude" | "openai" | "xai" | "gemini";

interface Mark {
  path: string;
  /** official brand colour, or null = currentColor (monochrome mark) */
  hex: string | null;
  /** evenodd fill (lobehub marks declare fill-rule="evenodd") */
  evenOdd?: boolean;
}

export const BRAND_MARKS: Record<BrandId, Mark> = {
  anthropic: {
    hex: null,
    path: "M17.3041 3.541h-3.6718l6.696 16.918H24Zm-10.6082 0L0 20.459h3.7442l1.3693-3.5527h7.0052l1.3693 3.5528h3.7442L10.5363 3.5409Zm-.3712 10.2232 2.2914-5.9456 2.2914 5.9456Z",
  },
  claude: {
    hex: "#D97757",
    path: "m4.7144 15.9555 4.7174-2.6471.079-.2307-.079-.1275h-.2307l-.7893-.0486-2.6956-.0729-2.3375-.0971-2.2646-.1214-.5707-.1215-.5343-.7042.0546-.3522.4797-.3218.686.0608 1.5179.1032 2.2767.1578 1.6514.0972 2.4468.255h.3886l.0546-.1579-.1336-.0971-.1032-.0972L6.973 9.8356l-2.55-1.6879-1.3356-.9714-.7225-.4918-.3643-.4614-.1578-1.0078.6557-.7225.8803.0607.2246.0607.8925.686 1.9064 1.4754 2.4893 1.8336.3643.3035.1457-.1032.0182-.0728-.164-.2733-1.3539-2.4467-1.445-2.4893-.6435-1.032-.17-.6194c-.0607-.255-.1032-.4674-.1032-.7285L6.287.1335 6.6997 0l.9957.1336.419.3642.6192 1.4147 1.0018 2.2282 1.5543 3.0296.4553.8985.2429.8318.091.255h.1579v-.1457l.1275-1.706.2368-2.0947.2307-2.6957.0789-.7589.3764-.9107.7468-.4918.5828.2793.4797.686-.0668.4433-.2853 1.8517-.5586 2.9021-.3643 1.9429h.2125l.2429-.2429.9835-1.3053 1.6514-2.0643.7286-.8196.85-.9046.5464-.4311h1.0321l.759 1.1293-.34 1.1657-1.0625 1.3478-.8804 1.1414-1.2628 1.7-.7893 1.36.0729.1093.1882-.0183 2.8535-.607 1.5421-.2794 1.8396-.3157.8318.3886.091.3946-.3278.8075-1.967.4857-2.3072.4614-3.4364.8136-.0425.0304.0486.0607 1.5482.1457.6618.0364h1.621l3.0175.2247.7892.522.4736.6376-.079.4857-1.2142.6193-1.6393-.3886-3.825-.9107-1.3113-.3279h-.1822v.1093l1.0929 1.0686 2.0035 1.8092 2.5075 2.3314.1275.5768-.3218.4554-.34-.0486-2.2039-1.6575-.85-.7468-1.9246-1.621h-.1275v.17l.4432.6496 2.3436 3.5214.1214 1.0807-.17.3521-.6071.2125-.6679-.1214-1.3721-1.9246L14.38 17.959l-1.1414-1.9428-.1397.079-.674 7.2552-.3156.3703-.7286.2793-.6071-.4614-.3218-.7468.3218-1.4753.3886-1.9246.3157-1.53.2853-1.9004.17-.6314-.0121-.0425-.1397.0182-1.4328 1.9672-2.1796 2.9446-1.7243 1.8456-.4128.164-.7164-.3704.0667-.6618.4008-.5889 2.386-3.0357 1.4389-1.882.929-1.0868-.0062-.1579h-.0546l-6.3385 4.1164-1.1293.1457-.4857-.4554.0608-.7467.2307-.2429 1.9064-1.3114Z",
  },
  openai: {
    hex: null,
    path: "M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z",
  },
  xai: {
    hex: null,
    evenOdd: true,
    path: "M6.469 8.776L16.512 23h-4.464L2.005 8.776H6.47zm-.004 7.9l2.233 3.164L6.467 23H2l4.465-6.324zM22 2.582V23h-3.659V7.764L22 2.582zM22 1l-9.952 14.095-2.233-3.163L17.533 1H22z",
  },
  gemini: {
    hex: "#8E75B2",
    path: "M11.04 19.32Q12 21.51 12 24q0-2.49.93-4.68.96-2.19 2.58-3.81t3.81-2.55Q21.51 12 24 12q-2.49 0-4.68-.93a12.3 12.3 0 0 1-3.81-2.58 12.3 12.3 0 0 1-2.58-3.81Q12 2.49 12 0q0 2.49-.96 4.68-.93 2.19-2.55 3.81a12.3 12.3 0 0 1-3.81 2.58Q2.49 12 0 12q2.49 0 4.68.96 2.19.93 3.81 2.55t2.55 3.81",
  },
};

/** Map a provider / runtime id the backend uses onto a vendored mark (null = none licensed). */
export function brandFor(id: string | null | undefined): BrandId | null {
  const s = String(id || "").toLowerCase();
  if (s === "anthropic") return "anthropic";
  if (s === "claude" || s === "claude-code") return "claude";
  if (s === "openai" || s === "codex") return "openai";
  if (s === "xai" || s === "grok") return "xai";
  if (s === "gemini" || s === "google" || s === "googlegemini") return "gemini";
  return null;
}

export interface BrandLogoProps {
  /** a provider / runtime id ("anthropic", "claude", "codex", "xai", …) */
  brand: string;
  /** used for the neutral initial fallback */
  name?: string;
  size?: number;
  className?: string;
  /** accessible name; omitted = decorative (the row names the brand in text) */
  title?: string;
}

export function BrandLogo({ brand, name, size = 16, className, title }: BrandLogoProps) {
  const id = brandFor(brand);
  const a11y = title ? { role: "img" as const, "aria-label": title } : { "aria-hidden": true as const };
  if (!id) {
    const initial = (name || brand || "?").trim().charAt(0).toUpperCase() || "?";
    const style: CSSProperties = {
      display: "inline-flex", alignItems: "center", justifyContent: "center", flex: "none",
      width: size, height: size, borderRadius: 4, fontSize: Math.round(size * 0.62), lineHeight: 1, fontWeight: 600,
      background: "var(--v2-raised)", color: "var(--v2-text-2)",
    };
    return (
      <span className={"v2-brand-initial" + (className ? " " + className : "")} data-brand="none" style={style} {...a11y}>
        {initial}
      </span>
    );
  }
  const m = BRAND_MARKS[id];
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      focusable="false"
      className={className}
      data-brand={id}
      style={m.hex ? { color: m.hex } : undefined}
      {...a11y}
    >
      <path d={m.path} fill="currentColor" fillRule={m.evenOdd ? "evenodd" : undefined} />
    </svg>
  );
}
