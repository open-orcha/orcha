/** unicode-emoji-json ships JSON only (its package.json names an index.d.ts it doesn't
 *  publish) — the one shape the picker reads. */
declare module 'unicode-emoji-json/data-by-group.json' {
  const groups: Array<{
    name: string
    slug: string
    emojis: Array<{ emoji: string; name: string; slug: string; skin_tone_support: boolean; emoji_version: string }>
  }>
  export default groups
}
