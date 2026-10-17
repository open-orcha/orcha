import { SquareTerminal } from 'lucide-react'
import type { TermKind } from '../../../shared/terminal'
import { agentDef, type AgentId } from '../../../shared/agents'
import { cn } from '../ui/cn'
import { ClaudeMark, hasVendoredMark, OpenAIMark, VendoredMarkSvg } from './brandMarks'

/** An agent's real mark (brandMarks.tsx), or — for a CLI no licensed icon set carries — a
 *  neutral glyph with its initial (never a hand-drawn lookalike). */
export function AgentMark({ id, className }: { id: AgentId; className?: string }) {
  if (id === 'claude') return <ClaudeMark className={cn('shrink-0', className)} />
  if (id === 'codex') return <OpenAIMark className={cn('shrink-0 text-text', className)} />
  if (hasVendoredMark(id)) return <VendoredMarkSvg id={id} className={cn('shrink-0 text-text', className)} />
  const initial = agentDef(id).label.charAt(0).toUpperCase()
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" data-mark="initial" className={cn('shrink-0 text-text-3', className)}>
      <rect x="1.5" y="1.5" width="21" height="21" rx="5" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <text x="12" y="16.6" textAnchor="middle" fontSize="13" fontWeight="600" fill="currentColor" fontFamily="inherit">
        {initial}
      </text>
    </svg>
  )
}

/** Launcher glyphs: a terminal square for shells, the agent's real mark otherwise. */
export function KindIcon({ kind, className }: { kind: TermKind; className?: string }) {
  if (kind === 'shell') return <SquareTerminal aria-hidden="true" className={cn('text-text-3', className)} />
  return <AgentMark id={kind} className={className} />
}
