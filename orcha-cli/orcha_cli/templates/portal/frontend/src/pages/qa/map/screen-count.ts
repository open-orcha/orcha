/**
 * One screen count across Home, the App map and the atlas (#467). Coverage and the App map count
 * each platform's own screen (an iOS screen and its Android twin are two); the atlas counts a
 * screen once across its platforms. Where a figure counts per platform it says so, in these words.
 */

const WORD: Record<string, string> = { ios: "iOS", android: "Android", web: "Web" };
const ORDER = ["ios", "android", "web"];

/** The platforms a per-platform count splits into, in order, when there are two or more. */
export function platformParts(platforms: Readonly<Record<string, number>> | null | undefined): { platform: string; word: string; n: number }[] | null {
  const parts = ORDER.filter((p) => (platforms?.[p] ?? 0) > 0).map((p) => ({ platform: p, word: WORD[p], n: platforms![p] }));
  return parts.length > 1 ? parts : null;
}

/** "one per platform: iOS 46, Android 26" beside a per-platform count; null for one platform. */
export function perPlatformWords(platforms: Readonly<Record<string, number>> | null | undefined): string | null {
  const parts = platformParts(platforms);
  return parts ? `one per platform: ${parts.map((p) => `${p.word} ${p.n}`).join(", ")}` : null;
}

/** What a per-platform figure says on hover: how it is counted and how the atlas counts. */
export function perPlatformTitle(platforms: Readonly<Record<string, number>> | null | undefined): string | null {
  const parts = platformParts(platforms);
  if (!parts) return null;
  return `Each platform's own screen counts apart (${parts.map((p) => `${p.word} ${p.n}`).join(", ")}). The Screen atlas counts a screen once across platforms.`;
}
