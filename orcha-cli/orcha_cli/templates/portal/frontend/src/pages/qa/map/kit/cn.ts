/**
 * Join class names; of two that set the same thing the later one wins, so a component's base
 * classes can be overridden by the `className` it is given whatever order the stylesheet has.
 */
export type ClassValue = string | number | boolean | null | undefined | ClassValue[] | Record<string, unknown>;

const DISPLAY = /^(block|inline-block|inline|flex|inline-flex|grid|inline-grid|contents|table|hidden|flow-root)$/;
const POSITION = /^(static|fixed|absolute|relative|sticky)$/;
const TEXT_SIZE = /^text-(2xs|xs|sm|base|lg|xl|2xl|\[\d)/;
const TEXT_ALIGN = /^text-(left|center|right|justify|start|end)$/;
const TEXT_WRAP = /^text-(wrap|nowrap|balance|pretty|ellipsis|clip)$/;
const BORDER_WIDTH = /^border(-[trblxyse])?(-\d+)?$/;
const BORDER_STYLE = /^border-(solid|dashed|dotted|double|hidden|none)$/;
const WEIGHT = /^font-(thin|light|normal|medium|semibold|bold|black)$/;
const FAMILY = /^font-(sans|mono|serif)$/;
const FLEX_DIR = /^flex-(row|col)(-reverse)?$/;
const FLEX_WRAP = /^flex-(wrap|nowrap|wrap-reverse)$/;
const PREFIXED = /^(min-w|max-w|min-h|max-h|size|w|h|px|py|pt|pr|pb|pl|ps|pe|p|mx|my|mt|mr|mb|ml|ms|me|m|gap-x|gap-y|gap|inset-x|inset-y|inset|top|right|bottom|left|bg|rounded|opacity|shadow|z|leading|tracking|overflow-x|overflow-y|overflow|items|justify|self|shrink|grow|basis|cursor|whitespace|translate-x|translate-y|rotate|scale)(-|$)/;

/** What a class sets, or null when two of them may stand side by side. */
function group(utility: string): string | null {
  const u = utility.replace(/^!|^-/, "");
  if (DISPLAY.test(u)) return "display";
  if (POSITION.test(u)) return "position";
  if (u === "truncate") return null;
  if (u.startsWith("text-")) return TEXT_SIZE.test(u) ? "text-size" : TEXT_ALIGN.test(u) ? "text-align" : TEXT_WRAP.test(u) ? "text-wrap" : "text-color";
  if (u.startsWith("border")) {
    if (BORDER_WIDTH.test(u)) return "border-w" + (u.match(/^border(-[trblxyse])/)?.[1] ?? "");
    if (BORDER_STYLE.test(u)) return "border-style";
    return /^border-[trblxyse]-/.test(u) ? null : "border-color";
  }
  if (WEIGHT.test(u)) return "font-weight";
  if (FAMILY.test(u)) return "font-family";
  if (FLEX_DIR.test(u)) return "flex-direction";
  if (FLEX_WRAP.test(u)) return "flex-wrap";
  if (/^bg-(gradient|linear|radial|conic|\[)/.test(u)) return null;
  return PREFIXED.exec(u)?.[1] ?? null;
}

/** Keep the last class of each group, per variant (`md:`, `hover:`…); the rest pass through. */
function merge(classes: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (let i = classes.length - 1; i >= 0; i--) {
    const c = classes[i];
    const at = c.lastIndexOf(":");
    const bracket = c.indexOf("[");
    const split = bracket >= 0 && bracket < at ? -1 : at;
    const g = group(c.slice(split + 1));
    if (g) {
      const key = c.slice(0, split + 1) + g;
      if (seen.has(key)) continue;
      seen.add(key);
    }
    out.push(c);
  }
  return out.reverse();
}

function flat(inputs: ClassValue[], out: string[]): void {
  for (const v of inputs) {
    if (!v) continue;
    if (typeof v === "string" || typeof v === "number") out.push(...String(v).split(/\s+/).filter(Boolean));
    else if (Array.isArray(v)) flat(v, out);
    else if (typeof v === "object") for (const [k, on] of Object.entries(v)) if (on) out.push(...k.split(/\s+/).filter(Boolean));
  }
}

export function cn(...inputs: ClassValue[]): string {
  const out: string[] = [];
  flat(inputs, out);
  return merge(out).join(" ");
}
