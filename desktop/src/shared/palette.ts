/** D13 identity palette, shared by the main process (the host poller assigns agent slots) and
 *  the renderer (avatars, project-icon glyph colours).
 *
 *  PARITY: byte-for-byte the same values and rules as the portal's
 *  frontend/src/components/primitives/Avatar.tsx (AVATAR_HUES, paletteColor, paletteIndex,
 *  assignPalette, actorKey, projectAvatarKey) — checked against portal commit 5f79b97b.
 *  Agent slots follow the portal's canonical assignment: ONE collision-free assignment over
 *  the project's full roster (snapshot `agents`, snapshot order) — see rosterPaletteSlots. */

/** Fixed, well-separated identity palette (desktop r3 review: hashing over the full 360°
 *  put different names a few degrees apart — visually the same colour). Ten hues ≥ 20° apart
 *  (most ≥ 30°), one lightness, so every slot is distinguishable at 16px. */
export const AVATAR_HUES = [4, 30, 50, 95, 145, 178, 208, 238, 272, 318] as const

export interface AvatarColors {
  background: string
  color: string
}

/** Palette slot → flat fill + tinted initial (≥ 4.5:1 for every slot, both themes). Saturation
 *  + lightness come from the renderer's theme tokens (styles.css --avatar-bg-sl /
 *  --avatar-fg-sl: dark fill + pale initial on dark, pale fill + deep initial on light); the
 *  fallbacks are the dark values, byte-identical to the portal's. */
export function paletteColor(index: number): AvatarColors {
  const h = AVATAR_HUES[((index % AVATAR_HUES.length) + AVATAR_HUES.length) % AVATAR_HUES.length]
  return { background: `hsl(${h} var(--avatar-bg-sl, 34% 28%))`, color: `hsl(${h} var(--avatar-fg-sl, 72% 86%))` }
}

/** Stable palette slot for a key (FNV-1a — spreads short, similar names better than ×31). The
 *  offset basis is chosen so Orcha's default roster (lead, backend-dev, frontend-dev, qa-bot,
 *  docs, reviewer, …) lands on distinct slots even outside a list; lists use assignPalette. */
export function paletteIndex(key: string): number {
  let h = 0x1f54177e
  for (const c of key) {
    h ^= c.codePointAt(0) ?? 0
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h % AVATAR_HUES.length
}

/** Collision-free slots for everything shown together: each key takes its hashed slot, or the
 *  next free one if a neighbour already took it (wrapping only once the palette is exhausted).
 *  Deterministic for a given key order. */
export function assignPalette(keys: string[]): Map<string, number> {
  const out = new Map<string, number>()
  const used = new Set<number>()
  for (const key of keys) {
    if (out.has(key)) continue
    let slot = paletteIndex(key)
    if (used.size < AVATAR_HUES.length) {
      while (used.has(slot)) slot = (slot + 1) % AVATAR_HUES.length
    }
    used.add(slot)
    out.set(key, slot)
  }
  return out
}

/** Palette key for an actor (alias without a leading "@"). */
export function actorKey(alias: string | null | undefined): string {
  return (alias || '').trim().replace(/^@/, '')
}

/** Key a project avatar's colour hashes on (name + container id). */
export function projectAvatarKey(name: string, seed?: string | null): string {
  return `${name}\u0000${seed ?? ''}`
}

/** The portal's canonical agent colours (D13 r2): ONE assignment over the project's full
 *  roster — every agent row of the snapshot, humans and terminated included, in snapshot
 *  order — so an agent has the same slot in the portal and in the desktop sidebar. */
export function rosterPaletteSlots(agents: ReadonlyArray<{ alias?: unknown }>): Map<string, number> {
  return assignPalette(agents.map((a) => actorKey(typeof a.alias === 'string' ? a.alias : '')))
}
