import { useState } from 'react'
import { Folder, MoreHorizontal, Phone, Star, Trash2 } from 'lucide-react'
import type { ProjectContainer } from '../../../shared/types'
import { Card } from '../ui/Card'
import { Button } from '../ui/Button'
import { cn } from '../ui/cn'

/** One project card — mirrors the cloud hub's ProjectsPage anatomy (status dot + name +
 *  star, description, repo/folder chip, agent/task counts, Open + quiet Pair-phone) rendered
 *  with the desktop's own gold-minimal tokens. Gold is reserved for the star-when-favorited
 *  and the Open action; everything else stays quiet. The overflow menu (quiet, bottom-right)
 *  carries Delete project — same destructive weight and placement pattern as StoppedStackRow's
 *  Remove, so a running project and a stopped stack delete through visually consistent UI. */
export default function ProjectCard({
  container,
  favorited,
  onToggleFavorite,
  onOpen,
  onPair,
  onDelete
}: {
  container: ProjectContainer
  favorited: boolean
  onToggleFavorite: () => void
  onOpen: () => void
  onPair: () => void
  /** Opens the shared type-to-confirm delete dialog for this project's stack. */
  onDelete: () => void
}) {
  const local = container.github_repo === 'local'
  const repoLabel = local ? container.name : container.github_repo
  const [menuOpen, setMenuOpen] = useState(false)

  return (
    <Card className="flex flex-col gap-2.5" data-testid="project-card" data-cid={container.id}>
      <div className="flex min-w-0 items-center gap-2">
        <span
          className={cn('h-1.5 w-1.5 shrink-0 rounded-full', container.status === 'active' ? 'bg-ok' : 'bg-text/25')}
          aria-hidden="true"
        />
        <span className="min-w-0 flex-1 truncate text-[15px] font-medium tracking-tight text-text">
          {container.name}
        </span>
        <button
          type="button"
          aria-label={favorited ? `Unfavorite ${container.name}` : `Favorite ${container.name}`}
          aria-pressed={favorited}
          onClick={onToggleFavorite}
          className={cn(
            'flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-text/30 transition-colors hover:bg-card hover:text-text/60',
            favorited && 'text-accent hover:text-accent'
          )}
        >
          <Star className="h-3.5 w-3.5" fill={favorited ? 'currentColor' : 'none'} />
        </button>
        {container.needs_you > 0 && (
          <span className="shrink-0 rounded-full border border-warning/30 bg-warning/10 px-2 py-0.5 text-[11px] font-semibold text-warning">
            Needs you · {container.needs_you}
          </span>
        )}
      </div>

      <p className="line-clamp-2 min-h-[2.6em] text-xs leading-relaxed text-text/50">
        {container.description || 'No description yet.'}
      </p>

      {repoLabel && (
        <span className="inline-flex w-fit max-w-full items-center gap-1.5 truncate rounded-full border border-border px-2.5 py-0.5 font-mono text-[11px] text-text/60">
          <Folder className="h-3 w-3 shrink-0" aria-hidden="true" />
          <span className="truncate">{repoLabel}</span>
          {local && (
            <span className="shrink-0 rounded-full bg-text/10 px-1.5 py-px text-[9px] font-semibold uppercase tracking-wide text-text/50">
              Local
            </span>
          )}
        </span>
      )}

      <div className="flex items-center gap-3 text-xs text-text/50">
        <span>
          <b className="font-semibold text-text">{container.agents}</b> agent{container.agents === 1 ? '' : 's'}
        </span>
        <span>
          <b className="font-semibold text-text">{container.tasks}</b> task{container.tasks === 1 ? '' : 's'}
        </span>
      </div>

      <div className="mt-auto flex items-center gap-2 pt-1">
        <Button size="sm" onClick={onOpen}>
          Open
        </Button>
        <Button size="sm" variant="ghost" className="text-text/50" onClick={onPair}>
          <Phone className="h-3.5 w-3.5" />
          Pair phone
        </Button>
        <div className="relative ml-auto shrink-0">
          <Button
            size="sm"
            variant="ghost"
            className="text-text/40"
            aria-label={`More actions for ${container.name}`}
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen((v) => !v)}
          >
            <MoreHorizontal className="h-4 w-4" />
          </Button>
          {menuOpen && (
            <div
              role="menu"
              className="absolute right-0 top-full z-10 mt-1 w-44 rounded-lg border border-border bg-card p-1 shadow-lg"
            >
              <button
                type="button"
                role="menuitem"
                className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs text-danger hover:bg-danger/10"
                onClick={() => {
                  setMenuOpen(false)
                  onDelete()
                }}
              >
                <Trash2 className="h-3.5 w-3.5" />
                Delete project…
              </button>
            </div>
          )}
        </div>
      </div>
    </Card>
  )
}
