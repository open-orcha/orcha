/** Emoji dataset for the project-icon picker (D14): `unicode-emoji-json` (MIT, zero deps,
 *  JSON generated from unicode.org's emoji-test data — names + CLDR groups, ~420 KB). It is
 *  loaded LAZILY (a separate chunk) the first time a picker opens, so it never weighs on
 *  startup. Emoji newer than 15.1 are dropped: older macOS emoji fonts render them as tofu. */

export interface EmojiEntry {
  emoji: string
  name: string
}

export interface EmojiGroup {
  slug: string
  label: string
  emojis: EmojiEntry[]
}

const LABELS: Record<string, string> = {
  smileys_emotion: 'Smileys',
  people_body: 'People',
  animals_nature: 'Nature',
  food_drink: 'Food',
  travel_places: 'Travel',
  activities: 'Activities',
  objects: 'Objects',
  symbols: 'Symbols',
  flags: 'Flags'
}

const MAX_VERSION = 15.1

type RawGroups = Array<{ slug: string; name: string; emojis: Array<{ emoji: string; name: string; emoji_version: string }> }>

/** Pure: raw dataset → picker groups (known groups only, version-capped). */
export function toGroups(raw: RawGroups): EmojiGroup[] {
  return raw
    .filter((g) => g.slug in LABELS)
    .map((g) => ({
      slug: g.slug,
      label: LABELS[g.slug],
      emojis: g.emojis.filter((e) => Number(e.emoji_version) <= MAX_VERSION).map((e) => ({ emoji: e.emoji, name: e.name }))
    }))
    .filter((g) => g.emojis.length > 0)
}

let cache: Promise<EmojiGroup[]> | null = null

export function loadEmojiGroups(): Promise<EmojiGroup[]> {
  cache ??= import('unicode-emoji-json/data-by-group.json').then((m) => toGroups(m.default))
  return cache
}

/** Every query word must prefix a word of the emoji's name (or its group): "red hea" → ❤️. */
export function searchEmoji(groups: EmojiGroup[], query: string, limit = 160): EmojiEntry[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  if (words.length === 0) return []
  const out: EmojiEntry[] = []
  for (const g of groups) {
    for (const e of g.emojis) {
      const hay = `${e.name} ${g.label}`.toLowerCase().split(/[\s:,_-]+/)
      if (words.every((w) => hay.some((h) => h.startsWith(w)))) {
        out.push(e)
        if (out.length >= limit) return out
      }
    }
  }
  return out
}
