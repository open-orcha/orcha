/**
 * The atlas header's visual summary, pure (tested alone): how the screens split by what is known
 * about their platforms (the parts of one bar that add up to every screen), what each platform
 * holds, and the honest words for how screens are counted. The atlas counts a screen once across
 * its platforms; the App map and Coverage count each platform's own screen (a map node) apart, so
 * the same app reads 169 here and 199 there. Both numbers come from the atlas itself: `screens`
 * and the map nodes each screen joins.
 */
import { PLATFORM_WORD } from "./model";
import { presenceOf, type Atlas, type Platform } from "./types";

export type PartKey = "same" | "differs" | "missing" | "unchecked" | "seen" | "unseen";

export interface SummaryPart {
  key: PartKey;
  n: number;
  /** The words beside its number, as the header's counts say them. */
  label: string;
  /** What it counts, said on hover and keyboard focus. */
  means: string;
}

export interface PlatformSummary {
  platform: Platform;
  /** Screens on this platform: seen live there, or in its code. */
  on: number;
  /** Of those, seen live there. */
  seen: number;
  /** Nothing is matched on this platform yet (every screen's presence is unknown). */
  unknown: boolean;
}

export interface AtlasSummary {
  screens: number;
  /** The map's screens these join: one per platform's own screen, as the App map and Coverage count. */
  nodes: number;
  /** Screens on more than one platform, each counted once here. */
  shared: number;
  seen: number;
  /** The parts of the bar, in the order they read; they add up to `screens`. */
  parts: SummaryPart[];
  platforms: PlatformSummary[];
}

/** "iOS", "iOS and Web", "iOS, Android and Web". */
export function listWords(words: readonly string[]): string {
  if (words.length <= 1) return words.join("");
  return `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}`;
}

export function summarize(atlas: Atlas): AtlasSummary {
  const c = atlas.counts;
  const plats = atlas.platforms;
  const nodes = atlas.screens.reduce((n, s) => n + Math.max(1, s.nodes.length), 0);
  const platforms = plats.map((p) => {
    let on = 0;
    let seen = 0;
    let known = false;
    for (const s of atlas.screens) {
      const pr = presenceOf(s, p);
      if (pr !== "unknown") known = true;
      if (pr === "seen" || pr === "unseen") on += 1;
      if (pr === "seen") seen += 1;
    }
    return { platform: p, on, seen, unknown: !known && on === 0 };
  });
  const shared = atlas.screens.filter((s) => plats.filter((p) => ["seen", "unseen"].includes(presenceOf(s, p))).length > 1).length;
  const differs = c.minor + c.different;
  const parts: SummaryPart[] =
    plats.length > 1
      ? [
          { key: "same", n: c.same, label: "the same", means: "Seen live on more than one platform, and they read and look alike." },
          { key: "differs", n: differs, label: differs === 1 ? "differs" : "differ", means: "Seen live on more than one platform, and they read or look different." },
          { key: "missing", n: c.missing, label: "not on every platform", means: "In one platform's code, and nothing like it in the code Embodent has mapped for another." },
          {
            key: "unchecked",
            n: c.unchecked + c.unmatched,
            label: "not compared yet",
            means: `${c.unmatched} found on one platform so far and not matched on the others yet, ${c.unchecked} on more than one platform and not compared yet.`,
          },
        ]
      : [
          { key: "seen", n: c.seen, label: "seen live", means: "A mapping run, exploration or check has taken a screenshot of it." },
          { key: "unseen", n: c.never_seen, label: "not seen yet", means: "Known from the code or the tests; no run has reached it yet." },
        ];
  return { screens: c.screens, nodes, shared, seen: c.seen, parts, platforms };
}

/**
 * How the atlas counts, in words: the line under the number, and the note that squares it with
 * the App map and Coverage (only when they count more: a screen on two platforms is two there).
 */
export function countedWords(atlas: Atlas, sum: AtlasSummary = summarize(atlas)): { line: string | null; note: string | null } {
  const words = atlas.platforms.map((p) => PLATFORM_WORD[p]);
  const line = words.length > 1 ? `Each counted once across ${listWords(words)}` : null;
  if (sum.nodes <= sum.screens) return { line, note: null };
  const on = sum.platforms.filter((p) => p.on > 0).map((p) => PLATFORM_WORD[p.platform]);
  const both = on.length === 2 ? `both ${listWords(on)}` : "more than one platform";
  return {
    line,
    note: `${sum.shared} ${sum.shared === 1 ? "screen is" : "screens are"} on ${both} and ${sum.shared === 1 ? "counts" : "count"} once here. The App map and Coverage count each platform's own screen apart: ${sum.nodes} in all.`,
  };
}

/** A share as a whole percent, never 0% for something that is there, never 100% for one short. */
export function share(n: number, of: number): number {
  if (!of || n <= 0) return 0;
  const p = Math.round((n / of) * 100);
  return n < of ? Math.min(99, Math.max(1, p)) : 100;
}
