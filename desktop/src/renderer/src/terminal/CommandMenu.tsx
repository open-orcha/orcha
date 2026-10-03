import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react'
import { Search } from 'lucide-react'
import { cn } from '../ui/cn'
import { filterCommands, flatSelectable, moveSelection, SECTION_LABEL, type CommandItem } from './commandModel'

export interface CommandAction extends CommandItem {
  /** Rendered glyph (16px). */
  glyph?: ReactNode
  run(): void
}

/** ⌘K command menu (Orca/Linear style): one search field over Actions, Open tabs and
 *  Projects. ARIA combobox + listbox: focus stays in the field, arrows move the active
 *  option (aria-activedescendant), Enter runs it, Escape closes. The menu never handles keys
 *  outside itself — the host only opens it on ⌘K. */
export default function CommandMenu({
  items,
  left,
  width,
  onClose
}: {
  items: CommandAction[]
  /** Horizontal centre band (CSS px) — the content panel right of the sidebar. */
  left: number
  width: number
  onClose(): void
}) {
  const [query, setQuery] = useState('')
  const groups = useMemo(() => filterCommands(items, query), [items, query])
  const selectable = useMemo(() => flatSelectable(groups), [groups])
  const ids = useMemo(() => selectable.map((i) => i.id), [selectable])
  const [activeId, setActiveId] = useState<string | null>(ids[0] ?? null)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLUListElement>(null)
  const baseId = useId()
  const optionId = (id: string): string => `${baseId}-opt-${id}`

  // A new query re-selects the best match (the first option).
  useEffect(() => {
    setActiveId(ids[0] ?? null)
  }, [query]) // eslint-disable-line react-hooks/exhaustive-deps
  // Items can change underneath (a tab closed); keep the selection valid.
  useEffect(() => {
    setActiveId((cur) => (cur !== null && ids.includes(cur) ? cur : (ids[0] ?? null)))
  }, [ids])

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  useEffect(() => {
    if (!activeId) return
    document.getElementById(optionId(activeId))?.scrollIntoView?.({ block: 'nearest' })
  }, [activeId]) // eslint-disable-line react-hooks/exhaustive-deps

  const run = (id: string | null): void => {
    const item = items.find((i) => i.id === id)
    if (!item || item.disabled) return
    item.run()
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || ((e.key === 'Home' || e.key === 'End') && e.ctrlKey)) {
      e.preventDefault()
      setActiveId((cur) => moveSelection(ids, cur, e.key as 'ArrowDown' | 'ArrowUp' | 'Home' | 'End'))
    } else if (e.key === 'n' && e.ctrlKey) {
      e.preventDefault()
      setActiveId((cur) => moveSelection(ids, cur, 'ArrowDown'))
    } else if (e.key === 'p' && e.ctrlKey) {
      e.preventDefault()
      setActiveId((cur) => moveSelection(ids, cur, 'ArrowUp'))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      run(activeId)
    } else if (e.key === 'Escape') {
      e.preventDefault()
      onClose()
    } else if (e.key === 'Tab') {
      e.preventDefault() // focus stays in the field (the list is navigated with arrows)
    }
  }

  const listboxId = `${baseId}-list`
  const menuWidth = Math.min(560, Math.max(320, width - 48))

  return (
    <div className="fixed inset-0 z-50" data-testid="command-menu-layer" onMouseDown={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Command menu"
        data-testid="command-menu"
        onMouseDown={(e) => {
          e.stopPropagation()
          // Keep focus in the search field (combobox pattern): clicking an option or a
          // header must not blur it, or Escape/arrows would stop working.
          if (e.target !== inputRef.current) e.preventDefault()
        }}
        className="absolute top-14 flex max-h-[min(460px,calc(100vh-120px))] flex-col overflow-hidden rounded-xl border border-border-strong bg-raised shadow-[var(--shadow-menu)] animate-fade-in"
        style={{ left: left + Math.max(0, (width - menuWidth) / 2), width: menuWidth }}
      >
        <div className="flex h-11 shrink-0 items-center gap-2.5 border-b border-border px-3.5">
          <Search aria-hidden="true" className="h-4 w-4 shrink-0 text-text-3" />
          <input
            ref={inputRef}
            role="combobox"
            aria-expanded="true"
            aria-controls={listboxId}
            aria-autocomplete="list"
            aria-activedescendant={activeId ? optionId(activeId) : undefined}
            aria-label="Search commands, tabs and projects"
            placeholder="Search tabs, projects, agents…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            spellCheck={false}
            autoComplete="off"
            className="h-full min-w-0 flex-1 bg-transparent text-[14px] text-text outline-none placeholder:text-text-3 cmdk-input"
          />
          <kbd className="shrink-0 rounded border border-border-strong px-1.5 text-[10.5px] leading-4 text-text-3">esc</kbd>
        </div>
        <ul ref={listRef} id={listboxId} role="listbox" aria-label="Results" className="min-h-0 flex-1 overflow-y-auto p-1.5">
          {groups.length === 0 && (
            <li role="presentation" className="px-3 py-6 text-center text-[13px] text-text-3">
              No results for “{query.trim()}”
            </li>
          )}
          {groups.map((g, gi) => (
            <li role="presentation" key={g.section} className={cn(gi > 0 && 'mt-1 border-t border-border pt-1')}>
              <div role="presentation" className="px-2.5 pb-1 pt-1.5 text-[11.5px] font-medium text-text-3">
                {SECTION_LABEL[g.section]}
              </div>
              <ul role="group" aria-label={SECTION_LABEL[g.section]}>
                {g.items.map((item) => {
                  const action = items.find((i) => i.id === item.id) as CommandAction
                  const selected = item.id === activeId
                  return (
                    <li
                      key={item.id}
                      id={optionId(item.id)}
                      role="option"
                      aria-selected={selected}
                      aria-disabled={item.disabled || undefined}
                      data-testid={`cmd-${item.id}`}
                      onMouseMove={() => !item.disabled && item.id !== activeId && setActiveId(item.id)}
                      onClick={() => run(item.id)}
                      className={cn(
                        'flex h-9 cursor-default items-center gap-2.5 rounded-md px-2.5 text-[13px]',
                        selected ? 'bg-hover text-text' : 'text-text-2',
                        item.disabled && 'opacity-45'
                      )}
                    >
                      <span className="flex h-4 w-4 shrink-0 items-center justify-center">{action.glyph}</span>
                      <span className={cn('truncate', item.danger ? 'text-danger' : selected && 'text-text')}>{item.label}</span>
                      {item.hint && <span className="min-w-0 truncate text-[12px] text-text-3">{item.hint}</span>}
                      {item.shortcut && (
                        <span className="ml-auto flex shrink-0 items-center gap-0.5 pl-3" aria-hidden="true">
                          {item.shortcut.map((k, i) => (
                            <kbd
                              key={i}
                              className="min-w-[18px] rounded border border-border-strong bg-card px-1 text-center font-sans text-[11px] leading-[18px] text-text-3"
                            >
                              {k}
                            </kbd>
                          ))}
                        </span>
                      )}
                    </li>
                  )
                })}
              </ul>
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}
