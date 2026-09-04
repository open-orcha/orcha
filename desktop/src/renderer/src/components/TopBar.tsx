import { ArrowLeft } from 'lucide-react'
import type { Stack } from '../../../shared/types'
import { cn } from '../ui/cn'

/** Slim bar shown above the embedded portal view once a project is open — replaces the old
 *  left icon rail's "which stack is active" role. "← Projects" returns home (portalHide);
 *  the current project's name + a running/stopped dot sit alongside it. Height matches
 *  shared/types' TOPBAR_HEIGHT so main's view-bounds math lines up exactly with this bar's
 *  bottom edge (see main/viewBounds.ts). */
export default function TopBar({ stack, onBack }: { stack: Stack; onBack: () => void }) {
  return (
    <div
      data-testid="topbar"
      className="flex h-10 shrink-0 items-center gap-3 border-b border-border bg-card/60 px-3"
    >
      <button
        type="button"
        onClick={onBack}
        className="flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium text-text/60 transition-colors hover:bg-card hover:text-text"
      >
        <ArrowLeft className="h-3.5 w-3.5" />
        Projects
      </button>
      <span className="h-3 w-px bg-border" aria-hidden="true" />
      <span
        className={cn('h-1.5 w-1.5 shrink-0 rounded-full', stack.running ? 'bg-ok' : 'bg-text/25')}
        aria-hidden="true"
      />
      <span className="truncate text-xs font-medium text-text/80">{stack.projectShort}</span>
    </div>
  )
}
