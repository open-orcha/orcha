/**
 * Tag text rules shared by every tag editor (scenarios, goldens).
 *
 * Tags are stored as typed (case kept) but compared case-insensitively on their trimmed text, so
 * "Smoke" and "smoke " are one tag.
 */

/** A tag as stored: trimmed, inner whitespace collapsed to one space, no commas (the separator). */
export function normalizeTag(text: string): string {
  return String(text ?? "")
    .replace(/,/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** The key two tags are "the same tag" by (the backend's `strip().lower()`). */
export function tagKey(text: string): string {
  return normalizeTag(text).toLowerCase();
}

/** "a, b,, c" or pasted lines -> ["a", "b", "c"]: split on commas and newlines, empties dropped. */
export function splitTags(text: string): string[] {
  return text.split(/[,\n\r]+/).map(normalizeTag).filter(Boolean);
}

/** `current` plus each of `incoming` not already there (case-insensitive), in order. */
export function addTags(current: readonly string[], incoming: readonly string[], max = Infinity): string[] {
  const out = [...current];
  const seen = new Set(current.map(tagKey));
  for (const raw of incoming) {
    const tag = normalizeTag(raw);
    const k = tag.toLowerCase();
    if (!tag || seen.has(k) || out.length >= max) continue;
    seen.add(k);
    out.push(tag);
  }
  return out;
}

/** `tags` plus what is still typed in a tag field (`text`): what a save sends, so a tag typed
 * but not yet entered is kept. */
export function withPendingTag(tags: readonly string[], text: string, max = Infinity): string[] {
  return addTags(tags, splitTags(text), max);
}

/** Every distinct tag across `items` (archived ones skipped), most used first, then by name. */
export function tagSuggestions(items: readonly { tags?: readonly string[] | null; archived_at?: string | null }[]): string[] {
  const counts = new Map<string, { name: string; count: number }>();
  for (const it of items) {
    if (it.archived_at) continue;
    for (const t of it.tags ?? []) {
      const name = normalizeTag(t);
      if (!name) continue;
      const k = name.toLowerCase();
      const e = counts.get(k) ?? { name, count: 0 };
      e.count++;
      counts.set(k, e);
    }
  }
  return [...counts.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)).map((e) => e.name);
}
