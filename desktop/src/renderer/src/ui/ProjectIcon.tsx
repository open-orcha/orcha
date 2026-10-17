import {
  BookOpen,
  Bot,
  Box,
  Briefcase,
  Camera,
  ChartColumn,
  Cloud,
  Code,
  Cpu,
  Database,
  FlaskConical,
  Folder,
  Gamepad2,
  Globe,
  Heart,
  Leaf,
  Mail,
  Music,
  Palette,
  Rocket,
  Server,
  Shield,
  ShoppingCart,
  Smartphone,
  Star,
  Terminal,
  Wrench,
  Zap,
  type LucideIcon
} from 'lucide-react'
import { cn } from './cn'
import { AVATAR_HUES, type AvatarStatus } from './Avatar'
import type { GlyphName, ProjectIcon as ProjectIconValue } from '../host/projectIcons'

export const GLYPHS: Record<GlyphName, LucideIcon> = {
  box: Box,
  folder: Folder,
  code: Code,
  terminal: Terminal,
  rocket: Rocket,
  globe: Globe,
  smartphone: Smartphone,
  server: Server,
  database: Database,
  cloud: Cloud,
  cpu: Cpu,
  bot: Bot,
  zap: Zap,
  flask: FlaskConical,
  shield: Shield,
  book: BookOpen,
  briefcase: Briefcase,
  cart: ShoppingCart,
  gamepad: Gamepad2,
  music: Music,
  camera: Camera,
  palette: Palette,
  heart: Heart,
  star: Star,
  leaf: Leaf,
  wrench: Wrench,
  chart: ChartColumn,
  mail: Mail
}

/** A glyph colour from the shared avatar palette (same hues as the avatars, D13), tuned
 *  per theme for a stroke on the canvas (styles.css --glyph-sl). */
export function glyphColor(slot: number | null): string | undefined {
  if (slot === null) return undefined
  const h = AVATAR_HUES[((slot % AVATAR_HUES.length) + AVATAR_HUES.length) % AVATAR_HUES.length]
  return `hsl(${h} var(--glyph-sl, 70% 70%))`
}

const BOX = { 16: 'h-4 w-4', 20: 'h-5 w-5', 24: 'h-6 w-6' } as const
const GLYPH = { 16: 'h-3.5 w-3.5', 20: 'h-4 w-4', 24: 'h-[18px] w-[18px]' } as const
const EMOJI = { 16: 'text-[13px]', 20: 'text-[15px]', 24: 'text-[18px]' } as const

/** D14: a project's icon — the user's emoji or glyph (+ colour), else a neutral cube glyph
 *  (never initials). Keeps the project status dot (stopped / starting / paused / error) at
 *  the bottom right, ringed in the surface colour. */
export function ProjectIcon({
  icon,
  size = 20,
  status = null,
  ring = 'var(--color-bg)',
  dim = false,
  className
}: {
  icon: ProjectIconValue | null | undefined
  size?: keyof typeof BOX
  status?: AvatarStatus
  ring?: string
  dim?: boolean
  className?: string
}) {
  const dot =
    status === 'error'
      ? 'bg-danger'
      : status === 'starting'
        ? 'bg-warning'
        : status === 'stopped' || status === 'paused'
          ? 'bg-text-3'
          : status === 'unknown'
            ? 'bg-border-strong'
            : null
  const Glyph = icon?.kind === 'glyph' ? GLYPHS[icon.value] : Box
  return (
    <span
      aria-hidden="true"
      data-testid="project-icon"
      data-icon={icon ? `${icon.kind}:${icon.value}` : 'default'}
      className={cn('relative inline-flex shrink-0 select-none items-center justify-center', BOX[size], dim && 'opacity-55', className)}
    >
      {icon?.kind === 'emoji' ? (
        <span className={cn('leading-none', EMOJI[size])}>{icon.value}</span>
      ) : (
        <Glyph
          className={cn(GLYPH[size], !(icon?.kind === 'glyph' && icon.color !== null) && 'text-text-2')}
          style={icon?.kind === 'glyph' ? { color: glyphColor(icon.color) } : undefined}
          strokeWidth={1.75}
        />
      )}
      {dot && (
        <span
          data-status-dot={status}
          data-testid={status === 'error' ? 'avatar-error-dot' : undefined}
          className={cn('absolute -bottom-0.5 -right-0.5 rounded-full', status === 'error' ? 'h-2 w-2' : 'h-[7px] w-[7px]', dot)}
          style={{ boxShadow: `0 0 0 2px ${ring}` }}
        />
      )}
    </span>
  )
}
