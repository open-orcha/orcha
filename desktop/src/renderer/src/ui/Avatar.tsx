import { cn } from './cn'
import { assignPalette, AVATAR_HUES, paletteColor, paletteIndex, projectAvatarKey, actorKey, type AvatarColors } from '../../../shared/palette'

/** The V2 portal's hue hash (lib/format.ts `hue`). Kept for callers that still need a raw
 *  hue; avatar colours now come from the fixed palette below. */
export function hue(s: string): number {
  let h = 0
  for (const c of s) h = (h * 31 + c.charCodeAt(0)) % 360
  return h
}

/* D13 palette: the values and slot rules live in shared/palette.ts (also used by the main-
 * process poller) and match the portal's primitives/Avatar.tsx exactly. */
export { assignPalette, AVATAR_HUES, paletteColor, paletteIndex, projectAvatarKey, actorKey, type AvatarColors }

/** An agent's/human's identity colour: its palette slot (or the hashed one). */
export function avatarColor(alias: string, index?: number): AvatarColors {
  return paletteColor(index ?? paletteIndex(actorKey(alias)))
}

/** Up to two initials ("billing-service" → "BS", "acme-admin" → "AA", "orcha" → "OR") —
 *  mirrors the portal's projectInitials so rail avatars don't collide on a shared prefix. */
export function projectInitials(name: string): string {
  const words = name.trim().split(/[^\p{L}\p{N}]+/u).filter(Boolean)
  if (words.length === 0) return '?'
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase()
  return (words[0][0] + words[1][0]).toUpperCase()
}

/** `error`: the last start/stop failed — the status dot itself turns red (one glyph per
 *  avatar, anchored to it) instead of a second detached dot beside it (desktop r2 review). */
export type AvatarStatus = 'running' | 'starting' | 'stopped' | 'paused' | 'unknown' | 'error' | null

const SIZES = {
  16: 'h-4 w-4 text-[7px]',
  20: 'h-5 w-5 text-[8px]',
  24: 'h-6 w-6 text-[9px]',
  32: 'h-8 w-8 text-[11px]'
} as const

/** Circular project avatar (design directive D7) with an optional status dot at the bottom
 *  right, ringed in the surface color. Running is the quiet default and shows no dot. */
export function ProjectAvatar({
  name,
  seed,
  size = 20,
  status = null,
  palette,
  ring = 'var(--color-bg)',
  dim = false,
  className
}: {
  name: string
  /** Extra hash input (e.g. the container id). */
  seed?: string
  /** Palette slot from assignPalette() so a list never repeats a colour; else hashed. */
  palette?: number
  size?: keyof typeof SIZES
  status?: AvatarStatus
  /** Color of the ring around the status dot (the surface the avatar sits on). */
  ring?: string
  dim?: boolean
  className?: string
}) {
  const colors = paletteColor(palette ?? paletteIndex(projectAvatarKey(name, seed)))
  const dot =
    status === 'error'
      ? 'bg-danger'
      : status === 'starting'
      ? 'bg-warning'
      : status === 'stopped'
        ? 'bg-text-3'
        : status === 'paused'
          ? 'bg-text-3'
          : status === 'unknown'
            ? 'bg-border-strong'
            : null
  return (
    <span
      aria-hidden="true"
      className={cn(
        'relative inline-flex shrink-0 select-none items-center justify-center rounded-full font-semibold tracking-tight',
        SIZES[size],
        dim && 'opacity-55',
        className
      )}
      style={colors}
    >
      {projectInitials(name)}
      {dot && (
        <span
          data-status-dot={status}
          data-testid={status === 'error' ? 'avatar-error-dot' : undefined}
          className={cn('absolute -bottom-px -right-px rounded-full', status === 'error' ? 'h-2 w-2' : 'h-[7px] w-[7px]', dot)}
          style={{ boxShadow: `0 0 0 2px ${ring}` }}
        />
      )}
    </span>
  )
}

export type AgentDot = 'working' | 'needs_review' | 'blocked' | null

const AGENT_DOT: Record<Exclude<AgentDot, null>, string> = {
  working: 'bg-ok',
  needs_review: 'bg-warning',
  blocked: 'bg-danger'
}

/** Circular agent avatar (D7): one initial on the agent's palette colour, with a small live
 *  status dot at the bottom right ringed in the surface colour. */
export function AgentAvatar({
  alias,
  size = 16,
  palette,
  status = null,
  ring = 'var(--color-bg)',
  className
}: {
  alias: string
  size?: keyof typeof SIZES
  palette?: number
  status?: AgentDot
  ring?: string
  className?: string
}) {
  const initial = (alias.trim().replace(/^@/, '').charAt(0) || '?').toUpperCase()
  return (
    <span
      aria-hidden="true"
      data-testid="agent-avatar"
      className={cn(
        'relative inline-flex shrink-0 select-none items-center justify-center rounded-full font-semibold',
        SIZES[size],
        className
      )}
      style={avatarColor(alias, palette)}
    >
      {initial}
      {status && (
        <span
          data-status-dot={status}
          className={cn('absolute -bottom-px -right-px h-[6px] w-[6px] rounded-full', AGENT_DOT[status])}
          style={{ boxShadow: `0 0 0 1.5px ${ring}` }}
        />
      )}
    </span>
  )
}
