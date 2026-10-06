import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { CircleCheck, CircleDashed, CircleDot, CirclePause, CircleSlash, Folder, LayoutGrid, Loader2, MoreHorizontal, Plus, Star } from 'lucide-react'
import type { Stack } from '../../../shared/types'
import { bandOf, stackBand, type ProjectBand, type ProjectRow } from '../host/projectModel'
import { Button } from '../ui/Button'
import { ProjectIcon } from '../ui/ProjectIcon'
import { IconPicker } from '../icons/IconPicker'
import { iconEditability, projectIconKey, type ProjectIcon as ProjectIconValue } from '../host/projectIcons'
import { cn } from '../ui/cn'
import MigrateOffDockerCard from './MigrateOffDockerCard'
import HelperMissingBanner from '../components/HelperMissingBanner'
import ConfirmResetModal from '../components/ConfirmResetModal'
import ErrorNotice from '../components/ErrorNotice'
import { readableError, stackErrorPrefix, type StackActionError } from '../util/errorText'

export type ProjectsFilter = 'all' | 'running' | 'starting' | 'paused' | 'stopped' | 'favorites'

export { bandOf, type ProjectBand } from '../host/projectModel'

export interface ProjectsHomeProps {
  /** The SAME rows the host sidebar renders (one data source: useHostState), so the two
   *  surfaces can never disagree about what exists, its state, or its Needs-you count. */
  rows: ProjectRow[]
  loaded: boolean
  dockerDown: boolean
  /** Docker's CLI timed out rather than refused: "isn't responding", not "isn't running". */
  dockerUnresponsive?: boolean
  /** GH #258: Docker is down but native projects are listed; Docker ones are hidden. */
  dockerHidden?: boolean
  busy: Record<string, boolean>
  errors: Record<string, StackActionError | null | undefined>
  onCreate(): void
  onOpen(row: ProjectRow): void
  onNavigate(row: ProjectRow, path: string): void
  onStart(row: ProjectRow): void
  onStop(row: ProjectRow): void
  onTogglePin(row: ProjectRow): void
  onDismissError(project: string): void
  /** "Remove project…" — opens the host's confirmation dialog. */
  onRemove?(row: ProjectRow): void
  /** Re-read the host state (after a delete, or "Retry" when Docker is down). */
  onRefresh(): Promise<void> | void
  /** D14: user project icons (same store as the host sidebar), recents, and the setter. */
  icons?: Record<string, ProjectIconValue>
  emojiRecents?: string[]
  onSetIcon?(row: ProjectRow, icon: ProjectIconValue | null): void
  /** The icon picked on this Mac before the shared store, offered when pushing it was refused. */
  iconOffer?(row: ProjectRow): ProjectIconValue | null
  /** A failed icon write (or why it can't be written), shown under that row. */
  iconError?: { key: string; message: string } | null
  onDismissIconError?(): void
}

/** Every project a stack holds (a compose stack can carry several since mig 037). */
export function projectsInStack(rows: ProjectRow[], project: string): string[] {
  return rows.filter((r) => r.stack.project === project && r.container).map((r) => r.name)
}

/** Linear "Initiatives"-style health chip: small icon + colored text, never a slab. */
function Health({ row, busy }: { row: ProjectRow; busy: boolean }) {
  let icon: ReactNode
  let text: string
  let tone: string
  if (busy) {
    icon = <Loader2 className="h-3.5 w-3.5 animate-spin" />
    text = row.stack.running ? 'Stopping…' : 'Starting…'
    tone = 'text-text-2'
  } else if (row.state === 'stopped') {
    icon = <CircleSlash className="h-3.5 w-3.5" />
    text = 'Stopped'
    tone = 'text-text-3'
  } else if (row.state === 'starting') {
    icon = <CircleDashed className="h-3.5 w-3.5" />
    text = 'Starting…'
    tone = 'text-warning'
  } else if (row.containerStatus) {
    icon = <CirclePause className="h-3.5 w-3.5" />
    text = row.containerStatus.charAt(0).toUpperCase() + row.containerStatus.slice(1)
    tone = 'text-text-3'
  } else if (row.attention === null) {
    icon = <CircleDashed className="h-3.5 w-3.5" />
    text = row.unavailableReason?.startsWith('unavailable') ? 'Unavailable' : 'Checking…'
    tone = 'text-text-3'
  } else if (row.attention > 0) {
    icon = <CircleDot className="h-3.5 w-3.5" />
    text = `Needs you · ${row.attention}${row.partial ? '+' : ''}`
    tone = 'text-warning'
  } else {
    icon = <CircleCheck className="h-3.5 w-3.5" />
    text = 'All clear'
    tone = 'text-ok'
  }
  return (
    <span className={cn('inline-flex items-center gap-1.5 whitespace-nowrap text-[13px] tabular-nums', tone)}>
      {icon}
      {text}
    </span>
  )
}

function RowMenu({
  row,
  busy,
  onClose,
  items
}: {
  row: ProjectRow
  busy: boolean
  onClose(): void
  items: Array<{ label: string; onSelect(): void; disabled?: boolean; danger?: boolean; hint?: string | null } | 'sep'>
}) {
  const ref = useRef<HTMLDivElement>(null)
  const closeRef = useRef(onClose)
  closeRef.current = onClose
  useEffect(() => {
    ref.current?.querySelector<HTMLElement>('[role="menuitem"]:not([disabled])')?.focus()
    const onDown = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) closeRef.current()
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [])
  return (
    <div
      ref={ref}
      role="menu"
      aria-label={`Actions for ${row.name}`}
      aria-busy={busy}
      onKeyDown={(e) => {
        const els = Array.from(ref.current?.querySelectorAll<HTMLElement>('[role="menuitem"]:not([disabled])') ?? [])
        const i = els.indexOf(document.activeElement as HTMLElement)
        if (e.key === 'Escape') {
          e.preventDefault()
          closeRef.current()
        } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          e.preventDefault()
          els[e.key === 'ArrowDown' ? (i + 1) % els.length : (i - 1 + els.length) % els.length]?.focus()
        }
      }}
      className="absolute right-2 top-full z-30 mt-1 w-52 rounded-[10px] border border-border-strong bg-raised p-1 shadow-[var(--shadow-pop)]"
    >
      {items.map((it, i) =>
        it === 'sep' ? (
          <div key={`sep-${i}`} role="separator" className="my-1 h-px bg-border" />
        ) : it.hint ? (
          // Disabled WITH a visible reason (D14: the project can't store an icon right now).
          <div
            key={it.label}
            role="menuitem"
            aria-disabled="true"
            tabIndex={-1}
            className="flex w-full flex-col rounded-md px-2 py-1 text-left outline-none focus-visible:bg-hover"
          >
            <span className="text-[13px] text-text opacity-40">{it.label}</span>
            <span className="text-[12px] leading-4 text-text-3">{it.hint}</span>
          </div>
        ) : (
          <button
            key={it.label}
            type="button"
            role="menuitem"
            disabled={it.disabled}
            onClick={() => {
              closeRef.current()
              it.onSelect()
            }}
            className={cn(
              'flex h-7 w-full items-center rounded-md px-2 text-left text-[13px] hover:bg-hover focus-visible:bg-hover disabled:opacity-40',
              it.danger ? 'text-danger' : 'text-text'
            )}
          >
            {it.label}
          </button>
        )
      )}
    </div>
  )
}

// Container-query driven (the panel's width, not the window's): the repository column only
// appears when the panel is wide enough that names never get squeezed (audit: 1024 px).
const GRID =
  'grid grid-cols-[minmax(0,1fr)_132px_52px_52px_84px] items-center gap-3 @4xl:grid-cols-[minmax(0,1fr)_minmax(0,220px)_140px_60px_60px_84px]'

/** The desktop Projects manager, inside the inset raised panel (D5) — a Linear-style table:
 *  a compact panel header (icon + title, one primary "New project"), filter pills, then
 *  grouped rows (Favorites / Running / Stopped band headers) with a circular avatar, name +
 *  description, repo, health chip, real agent/task counts, and a ⋯ menu. Rows open on
 *  click. Stopped stacks are honest single rows (no containers to list while stopped). */
export default function ProjectsHome(props: ProjectsHomeProps) {
  const { rows, loaded, dockerDown, busy, errors } = props
  const [filter, setFilter] = useState<ProjectsFilter>('all')
  const [menuFor, setMenuFor] = useState<string | null>(null)
  const [deleting, setDeleting] = useState<Stack | null>(null)
  const [deleteBusy, setDeleteBusy] = useState(false)
  const [deleteError, setDeleteError] = useState<unknown>(null)

  const counts = useMemo(
    () => ({
      all: rows.length,
      running: rows.filter((r) => bandOf(r) === 'running').length,
      starting: rows.filter((r) => bandOf(r) === 'starting').length,
      paused: rows.filter((r) => bandOf(r) === 'paused').length,
      stopped: rows.filter((r) => bandOf(r) === 'stopped').length,
      favorites: rows.filter((r) => r.pinned).length
    }),
    [rows]
  )

  // D14: the same user icons the host sidebar shows; the picker opens from the row ⋯ menu.
  const [pickerFor, setPickerFor] = useState<string | null>(null)
  const menuTriggers = useRef(new Map<string, HTMLButtonElement | null>())
  const iconOf = (row: ProjectRow): ProjectIconValue | null => props.icons?.[projectIconKey(row)] ?? null
  const changeIconItem = (row: ProjectRow): { label: string; onSelect(): void; hint: string | null } => {
    const edit = iconEditability(row)
    return { label: 'Change icon…', onSelect: () => setPickerFor(row.key), hint: edit.ok ? null : edit.reason }
  }
  const closePicker = (key: string): void => {
    setPickerFor(null)
    menuTriggers.current.get(key)?.focus()
  }

  // A filter whose pill disappeared (its count fell to 0) falls back to All.
  const activeFilter: ProjectsFilter = filter !== 'all' && counts[filter] === 0 ? 'all' : filter
  const visible = rows.filter((r) =>
    activeFilter === 'all' ? true : activeFilter === 'favorites' ? r.pinned : bandOf(r) === activeFilter
  )
  // The paused band (and its pill) is named by the containers' own word ("Paused",
  // "Archived"); mixed → "Inactive" — the same stackBand() rule the tray uses.
  const pausedWord = stackBand(rows.filter((r) => bandOf(r) === 'paused')).word
  const pausedLabel = pausedWord.charAt(0).toUpperCase() + pausedWord.slice(1)
  // Rows arrive favorites-first (buildProjectRows), so within each band starred rows lead.
  const bands: Array<{ key: ProjectBand; label: string; icon: ReactNode }> = [
    { key: 'running', label: 'Running', icon: <span className="mx-[3px] h-2 w-2 rounded-full bg-ok" /> },
    { key: 'starting', label: 'Starting', icon: <CircleDashed className="h-3.5 w-3.5 text-warning" /> },
    { key: 'paused', label: 'Paused', icon: <CirclePause className="h-3.5 w-3.5 text-text-3" /> },
    { key: 'stopped', label: 'Stopped', icon: <CircleSlash className="h-3.5 w-3.5 text-text-3" /> }
  ]
  const groups = bands
    .map((b) => ({ ...b, rows: visible.filter((r) => bandOf(r) === b.key) }))
    .filter((g) => g.rows.length > 0)
    .map((g) => (g.key === 'paused' ? { ...g, label: pausedLabel } : g))

  // Stacks holding more than one project: their rows say which stack they live in, so
  // "Delete stack" / "Stop stack" scope is visible before anyone opens a menu.
  const shared = new Set<string>()
  const seen = new Set<string>()
  for (const r of rows) {
    if (!r.container) continue
    if (seen.has(r.stack.project)) shared.add(r.stack.project)
    seen.add(r.stack.project)
  }

  // One error per stack, under its first visible row.
  const errorRow = new Map<string, string>()
  for (const r of visible) if (!errorRow.has(r.stack.project)) errorRow.set(r.stack.project, r.key)

  async function confirmDelete(): Promise<void> {
    if (!deleting) return
    setDeleteBusy(true)
    setDeleteError(null)
    try {
      await window.orchaDesktop.resetStack(deleting.project)
      setDeleting(null)
      await props.onRefresh()
    } catch (err) {
      setDeleteError(err)
    } finally {
      setDeleteBusy(false)
    }
  }

  // Running and Stopped always show; Starting / Paused / Favorites only when non-empty, so
  // every band the list can show has a pill whose count matches it (desktop r3 review).
  const pills: Array<{ key: ProjectsFilter; label: string; n: number }> = [
    { key: 'all', label: 'All', n: counts.all },
    { key: 'running', label: 'Running', n: counts.running },
    ...(counts.starting > 0 ? [{ key: 'starting' as const, label: 'Starting', n: counts.starting }] : []),
    ...(counts.paused > 0 ? [{ key: 'paused' as const, label: pausedLabel, n: counts.paused }] : []),
    { key: 'stopped', label: 'Stopped', n: counts.stopped },
    ...(counts.favorites > 0 ? [{ key: 'favorites' as const, label: 'Favorites', n: counts.favorites }] : [])
  ]

  return (
    <main className="flex h-full min-h-0 flex-col" aria-label="Projects">
      <header className="flex h-11 shrink-0 items-center gap-2 border-b border-border px-4">
        <LayoutGrid className="h-4 w-4 text-text-3" aria-hidden="true" />
        <h1 className="text-[13px] font-medium text-text">Projects</h1>
        {loaded && !dockerDown && <span className="text-[13px] tabular-nums text-text-3">{rows.length}</span>}
        <Button className="ml-auto" onClick={props.onCreate}>
          <Plus />
          New project
        </Button>
      </header>

      {loaded && !dockerDown && rows.length > 0 && (
        <div className="flex h-11 shrink-0 items-center gap-1.5 px-4" role="tablist" aria-label="Filter projects">
          {pills.map((p) => (
            <button
              key={p.key}
              type="button"
              role="tab"
              aria-selected={activeFilter === p.key}
              onClick={() => setFilter(p.key)}
              className={cn(
                'inline-flex h-7 items-center gap-1.5 rounded-full border px-3 text-[13px] transition-colors',
                activeFilter === p.key
                  ? 'border-border-strong bg-selected text-text'
                  : 'border-border text-text-2 hover:bg-hover hover:text-text'
              )}
            >
              {p.label}
              <span className="tabular-nums text-text-3">{p.n}</span>
            </button>
          ))}
        </div>
      )}

      <div className="flex shrink-0 flex-col gap-2 px-4 empty:hidden [&:not(:empty)]:pb-3">
        {/* Issue 258 D4: the blocking Docker banner is gone — projects run without Docker. This
            quiet line only shows on an older app API with no native discovery. */}
        {dockerDown && (
          <p role="status" className="pt-3 text-[12px] text-text-3">
            {props.dockerUnresponsive ? 'Docker isn’t responding.' : 'Docker isn’t running.'}
          </p>
        )}
        {!dockerDown && loaded && props.dockerHidden && (
          <p className="pt-3 text-[12px] text-text-3" data-testid="docker-hidden-note">
            Docker isn’t running, so any Docker projects are hidden.
          </p>
        )}
        {!dockerDown && loaded && <HelperMissingBanner />}
        {!dockerDown && loaded && (
          <MigrateOffDockerCard
            stacks={rows.filter((r, i, a) => a.findIndex((o) => o.stack.project === r.stack.project) === i).map((r) => r.stack)}
            onDone={props.onRefresh}
          />
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto pb-6">
        {!loaded && (
          <div className="flex flex-col gap-px px-2 pt-2" aria-busy="true" aria-label="Loading projects">
            {[0, 1, 2].map((i) => (
              <div key={i} className="flex h-11 items-center gap-3 px-3">
                <span className="h-6 w-6 animate-pulse rounded-full bg-hover" />
                <span className="h-3 w-40 animate-pulse rounded bg-hover" />
              </div>
            ))}
          </div>
        )}

        {loaded && !dockerDown && rows.length === 0 && (
          <div className="flex flex-col items-center gap-3 px-6 py-20 text-center">
            <LayoutGrid className="h-6 w-6 text-text-3" aria-hidden="true" />
            <div className="text-[15px] font-semibold text-text">No projects yet</div>
            <p className="max-w-sm text-[13px] text-text-3">
              Point Embodent at a folder or a GitHub repo and it sets up a local stack for your agents.
            </p>
          </div>
        )}

        {loaded && !dockerDown && rows.length > 0 && (
          <div role="table" aria-label="Projects on this Mac" className="@container flex flex-col">
            <div role="row" className={cn(GRID, 'h-8 border-b border-border px-6 text-xs text-text-3')}>
              <span role="columnheader">Name</span>
              <span role="columnheader" className="hidden @4xl:block">
                Repository
              </span>
              <span role="columnheader">Health</span>
              <span role="columnheader" className="text-right">
                Agents
              </span>
              <span role="columnheader" className="text-right">
                Tasks
              </span>
              <span role="columnheader" className="sr-only">
                Actions
              </span>
            </div>
            {groups.length === 0 && <p className="px-6 py-6 text-[13px] text-text-3">Nothing matches this filter.</p>}
            {groups.map((g) => (
              <section key={g.key} role="rowgroup" aria-label={g.label}>
                <div className="mx-2 mt-2 flex h-8 items-center gap-2 rounded-md bg-hover/40 px-4 text-[13px]">
                  {g.icon}
                  <span className="font-medium text-text">{g.label}</span>
                  <span className="tabular-nums text-text-3">{g.rows.length}</span>
                </div>
                {g.rows.map((row) => {
                  const isBusy = busy[row.stack.project] === true
                  const openable = row.stack.running && row.stack.apiPort !== null && row.container !== null
                  const error = errorRow.get(row.stack.project) === row.key ? errors[row.stack.project] : null
                  const c = row.container
                  const local = c?.github_repo === 'local'
                  const repo = c ? (local ? 'Local folder' : c.github_repo) : (row.stack.folder ?? null)
                  const menuOpen = menuFor === row.key
                  return (
                    <div key={row.key} data-testid="project-row" data-key={row.key} className="relative">
                      <div
                        role="row"
                        className={cn(
                          GRID,
                          'group relative mx-2 h-11 rounded-md px-4 hover:bg-hover',
                          menuOpen && 'bg-hover'
                        )}
                      >
                        <div role="cell" className="flex min-w-0 items-center gap-2.5">
                          <ProjectIcon
                            icon={iconOf(row)}
                            size={20}
                            status={row.state === 'stopped' ? 'stopped' : row.state === 'starting' ? 'starting' : row.containerStatus ? 'paused' : null}
                            ring="var(--color-card)"
                            dim={row.state === 'stopped'}
                          />
                          {/* Stretched primary action: the whole row opens the project. */}
                          <button
                            type="button"
                            disabled={!openable}
                            onClick={() => props.onOpen(row)}
                            aria-label={openable ? `Open ${row.name}` : `${row.name} (${row.state === 'stopped' ? 'stack stopped' : 'not ready'})`}
                            className="min-w-0 max-w-[65%] shrink-0 truncate text-left text-[13px] font-medium text-text before:absolute before:inset-0 before:rounded-md before:content-[''] disabled:cursor-default disabled:text-text-2"
                            title={row.name}
                          >
                            {row.name}
                          </button>
                          {shared.has(row.stack.project) && row.stack.projectShort !== row.name && (
                            <span className="hidden min-w-0 truncate text-xs text-text-3 @2xl:inline" title={`Lives in the ${row.stack.projectShort} stack`}>
                              in {row.stack.projectShort}
                            </span>
                          )}
                          {c?.description && (
                            <span className="hidden min-w-0 flex-1 truncate text-[13px] text-text-3 @5xl:inline">{c.description}</span>
                          )}
                        </div>
                        <div role="cell" className="hidden min-w-0 items-center gap-1.5 text-xs text-text-3 @4xl:flex">
                          {repo && (
                            <>
                              <Folder className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                              <span className={cn('truncate', !local && 'font-mono text-[11.5px]')} title={repo}>
                                {repo}
                              </span>
                            </>
                          )}
                        </div>
                        <div role="cell">
                          <Health row={row} busy={isBusy} />
                        </div>
                        <div role="cell" className="text-right text-[13px] tabular-nums text-text-2">
                          {c ? c.agents : '—'}
                        </div>
                        <div role="cell" className="text-right text-[13px] tabular-nums text-text-2">
                          {c ? c.tasks : '—'}
                        </div>
                        <div role="cell" className="relative z-10 flex items-center justify-end gap-0.5">
                          {row.state === 'stopped' ? (
                            <Button size="sm" variant="secondary" disabled={isBusy} onClick={() => props.onStart(row)}>
                              {isBusy ? 'Starting…' : 'Start'}
                            </Button>
                          ) : (
                            c && (
                              <button
                                type="button"
                                aria-label={row.pinned ? `Unfavorite ${row.name}` : `Favorite ${row.name}`}
                                aria-pressed={row.pinned}
                                onClick={() => props.onTogglePin(row)}
                                className={cn(
                                  'flex h-6 w-6 items-center justify-center rounded-md text-text-3 hover:bg-border hover:text-text focus-visible:opacity-100',
                                  row.pinned ? 'text-accent' : 'opacity-0 group-hover:opacity-100'
                                )}
                              >
                                <Star className="h-3.5 w-3.5" fill={row.pinned ? 'currentColor' : 'none'} />
                              </button>
                            )
                          )}
                          <button
                            type="button"
                            ref={(el) => {
                              menuTriggers.current.set(row.key, el)
                            }}
                            aria-label={`More actions for ${row.name}`}
                            aria-haspopup="menu"
                            aria-expanded={menuOpen}
                            onClick={() => setMenuFor((k) => (k === row.key ? null : row.key))}
                            className="flex h-6 w-6 items-center justify-center rounded-md text-text-3 hover:bg-border hover:text-text"
                          >
                            <MoreHorizontal className="h-4 w-4" />
                          </button>
                        </div>
                      </div>
                      {menuOpen && (
                        <RowMenu
                          row={row}
                          busy={isBusy}
                          onClose={() => setMenuFor(null)}
                          items={[
                            ...(c
                              ? [
                                  { label: 'Open', onSelect: () => props.onOpen(row), disabled: !openable },
                                  ...(props.onSetIcon ? [changeIconItem(row)] : []),
                                  { label: 'Pair phone', onSelect: () => props.onNavigate(row, '/settings#tab=pairing'), disabled: !openable },
                                  { label: 'Project settings', onSelect: () => props.onNavigate(row, '/settings'), disabled: !openable },
                                  { label: row.pinned ? 'Remove from favorites' : 'Add to favorites', onSelect: () => props.onTogglePin(row) },
                                  'sep' as const
                                ]
                              : props.onSetIcon
                                ? [changeIconItem(row), 'sep' as const]
                                : []),
                            row.stack.running
                              ? { label: isBusy ? 'Stopping…' : 'Stop stack…', onSelect: () => props.onStop(row), disabled: isBusy }
                              : { label: isBusy ? 'Starting…' : 'Start stack', onSelect: () => props.onStart(row), disabled: isBusy },
                            ...(props.onRemove
                              ? [{ label: 'Remove project…', danger: true, disabled: isBusy, onSelect: () => props.onRemove?.(row) }]
                              : []),
                            {
                              label: 'Delete stack…',
                              danger: true,
                              disabled: isBusy,
                              onSelect: () => {
                                setDeleteError(null)
                                setDeleting(row.stack)
                              }
                            }
                          ]}
                        />
                      )}
                      {pickerFor === row.key && props.onSetIcon && (
                        <IconPicker
                          label={`Change icon for ${row.name}`}
                          value={iconOf(row)}
                          suggestion={props.iconOffer?.(row) ?? null}
                          recents={props.emojiRecents ?? []}
                          onPick={(icon, done) => {
                            props.onSetIcon?.(row, icon)
                            if (done) closePicker(row.key)
                          }}
                          onReset={() => {
                            props.onSetIcon?.(row, null)
                            closePicker(row.key)
                          }}
                          onClose={() => closePicker(row.key)}
                          className="absolute left-6 top-full z-30 mt-1 w-[312px]"
                        />
                      )}
                      {props.iconError?.key === row.key && (
                        <ErrorNotice
                          className="mx-2 px-4 pb-2 pl-[52px]"
                          error={{ message: props.iconError.message }}
                          onDismiss={() => props.onDismissIconError?.()}
                        />
                      )}
                      {error != null && (
                        <ErrorNotice
                          className="mx-2 px-4 pb-2 pl-[52px]"
                          error={error.error}
                          prefix={stackErrorPrefix(error, row.stack.projectShort)}
                          onDismiss={() => props.onDismissError(row.stack.project)}
                        />
                      )}
                    </div>
                  )
                })}
              </section>
            ))}
          </div>
        )}
      </div>

      {deleting && (
        <ConfirmResetModal
          project={deleting.project}
          stackName={deleting.projectShort}
          projects={projectsInStack(rows, deleting.project)}
          busy={deleteBusy}
          error={deleteError === null ? null : readableError(deleteError).summary}
          onCancel={() => setDeleting(null)}
          onConfirm={() => void confirmDelete()}
        />
      )}
    </main>
  )
}
