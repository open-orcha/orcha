import { useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { Search } from 'lucide-react'
import { cn } from '../ui/cn'
import { GLYPHS, glyphColor, ProjectIcon as ProjectIconView } from '../ui/ProjectIcon'
import { AVATAR_HUES } from '../ui/Avatar'
import { GLYPH_NAMES, type GlyphName, type ProjectIcon } from '../host/projectIcons'
import { loadEmojiGroups, searchEmoji, type EmojiEntry, type EmojiGroup } from './emojiData'

/** Extra search words per glyph (the name itself always matches). */
const GLYPH_WORDS: Partial<Record<GlyphName, string>> = {
  box: 'cube package default',
  code: 'dev brackets',
  terminal: 'cli shell',
  globe: 'web world site',
  smartphone: 'mobile phone app ios android',
  server: 'backend api',
  database: 'db data sql',
  cpu: 'chip hardware',
  bot: 'ai robot agent',
  zap: 'fast lightning',
  flask: 'lab science experiment',
  shield: 'security',
  book: 'docs documentation',
  briefcase: 'work business',
  cart: 'shop store commerce',
  gamepad: 'game',
  chart: 'analytics metrics',
  mail: 'email'
}

type Tab = 'emoji' | 'glyph'

const CELL = 28

/** D14 project-icon picker: an Emoji tab (search + recents + the Unicode groups) and an Icons
 *  tab (the app's glyph set + an optional palette colour), plus "Reset to default". Keyboard:
 *  the search field is focused on open, ↓ enters the grid, arrows move by cell/row, Enter
 *  picks, Escape closes (the caller restores focus to its trigger). */
export function IconPicker({
  label,
  value,
  suggestion = null,
  recents,
  onPick,
  onReset,
  onClose,
  className,
  style
}: {
  /** Accessible name, e.g. "Change icon for orcha-web". */
  label: string
  value: ProjectIcon | null
  /** D14 migration: the icon picked on this Mac before icons were shared, offered as one
   *  click when pushing it automatically was refused. */
  suggestion?: ProjectIcon | null
  recents: string[]
  /** `done`: a cell was picked (close); false for a live colour change (stay open). */
  onPick(icon: ProjectIcon, done: boolean): void
  onReset(): void
  onClose(): void
  className?: string
  style?: CSSProperties
}) {
  const ref = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const [tab, setTab] = useState<Tab>(value?.kind === 'glyph' ? 'glyph' : 'emoji')
  const [query, setQuery] = useState('')
  const [groups, setGroups] = useState<EmojiGroup[] | null>(null)
  const [failed, setFailed] = useState(false)
  const [color, setColor] = useState<number | null>(value?.kind === 'glyph' ? value.color : null)
  const closeRef = useRef(onClose)
  closeRef.current = onClose

  useEffect(() => {
    let live = true
    loadEmojiGroups()
      .then((g) => live && setGroups(g))
      .catch(() => live && setFailed(true))
    searchRef.current?.focus()
    const onDown = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) closeRef.current()
    }
    document.addEventListener('mousedown', onDown)
    return () => {
      live = false
      document.removeEventListener('mousedown', onDown)
    }
  }, [])

  const q = query.trim()
  const emojiHits = useMemo(() => (groups && q ? searchEmoji(groups, q) : []), [groups, q])
  const glyphs = useMemo(
    () =>
      GLYPH_NAMES.filter((n) => {
        if (!q) return true
        const hay = `${n} ${GLYPH_WORDS[n] ?? ''}`.toLowerCase()
        return q
          .toLowerCase()
          .split(/\s+/)
          .every((w) => hay.includes(w))
      }),
    [q]
  )

  const cells = (): HTMLElement[] => Array.from(ref.current?.querySelectorAll<HTMLElement>('[data-cell]') ?? [])

  const onKeyDown = (e: ReactKeyboardEvent): void => {
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      onClose()
      return
    }
    const target = e.target as HTMLElement
    if (target === searchRef.current) {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        cells()[0]?.focus()
      } else if (e.key === 'Enter') {
        e.preventDefault()
        cells()[0]?.click()
      }
      return
    }
    if (!target.hasAttribute('data-cell') || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) return
    e.preventDefault()
    const all = cells()
    const i = all.indexOf(target)
    // Row step = how many cells share this cell's grid row (grids reflow with the width).
    const cols = Math.max(1, Math.floor((target.parentElement?.clientWidth || CELL * 8) / CELL))
    const next =
      e.key === 'ArrowLeft' ? i - 1 : e.key === 'ArrowRight' ? i + 1 : e.key === 'ArrowUp' ? i - cols : i + cols
    if (next < 0 && (e.key === 'ArrowUp' || e.key === 'ArrowLeft')) searchRef.current?.focus()
    else all[Math.min(all.length - 1, Math.max(0, next))]?.focus()
  }

  const pickEmoji = (emoji: string): void => onPick({ kind: 'emoji', value: emoji }, true)

  const emojiCell = (e: EmojiEntry, key: string) => (
    <button
      key={key}
      type="button"
      data-cell
      title={e.name}
      aria-label={e.name}
      aria-pressed={value?.kind === 'emoji' && value.value === e.emoji}
      onClick={() => pickEmoji(e.emoji)}
      className={cn(
        'flex h-7 w-7 items-center justify-center rounded-md text-[17px] leading-none outline-none hover:bg-hover focus-visible:bg-hover focus-visible:ring-1 focus-visible:ring-accent',
        value?.kind === 'emoji' && value.value === e.emoji && 'bg-selected'
      )}
    >
      {e.emoji}
    </button>
  )

  const grid = 'grid grid-cols-[repeat(auto-fill,28px)] justify-between gap-y-0.5'
  const sectionLabel = 'px-1 pb-1 pt-2 text-[11px] font-medium text-text-3'

  return (
    <div
      ref={ref}
      role="dialog"
      aria-label={label}
      onKeyDown={onKeyDown}
      style={style}
      className={cn(
        'flex flex-col rounded-[10px] border border-border-strong bg-raised p-2 shadow-[var(--shadow-pop)]',
        className
      )}
    >
      {suggestion && (
        <div className="mb-2 flex items-center gap-2 rounded-md border border-border bg-card px-2 py-1.5" data-testid="icon-suggestion">
          <ProjectIconView icon={suggestion} size={20} />
          <span className="min-w-0 flex-1 text-[12px] leading-4 text-text-2">Your icon from this Mac</span>
          <button
            type="button"
            onClick={() => onPick(suggestion, true)}
            className="h-6 shrink-0 rounded-md px-2 text-[12px] font-medium text-text hover:bg-hover"
          >
            Use it
          </button>
        </div>
      )}
      <div className="flex items-center gap-1" role="tablist" aria-label="Icon type">
        {(
          [
            ['emoji', 'Emoji'],
            ['glyph', 'Icons']
          ] as const
        ).map(([k, text]) => (
          <button
            key={k}
            type="button"
            role="tab"
            aria-selected={tab === k}
            onClick={() => {
              setTab(k)
              searchRef.current?.focus()
            }}
            className={cn(
              'h-6 rounded-full px-2.5 text-[12px] font-medium',
              tab === k ? 'bg-selected text-text' : 'text-text-3 hover:bg-hover hover:text-text'
            )}
          >
            {text}
          </button>
        ))}
        {value && (
          <button
            type="button"
            onClick={onReset}
            className="ml-auto h-6 rounded-md px-2 text-[12px] text-text-3 hover:bg-hover hover:text-text"
          >
            Reset
          </button>
        )}
      </div>

      <label className="mt-2 flex h-7 items-center gap-1.5 rounded-md border border-border bg-card px-2 focus-within:border-accent">
        <Search className="h-3.5 w-3.5 shrink-0 text-text-3" aria-hidden="true" />
        <input
          ref={searchRef}
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={tab === 'emoji' ? 'Search emoji' : 'Search icons'}
          aria-label={tab === 'emoji' ? 'Search emoji' : 'Search icons'}
          // The field's border carries focus (focus-within above); no second global ring.
          style={{ boxShadow: 'none' }}
          className="min-w-0 flex-1 bg-transparent text-[13px] text-text outline-none placeholder:text-text-3"
        />
      </label>

      <div className="mt-1 max-h-[232px] min-h-[120px] overflow-y-auto px-0.5" data-testid="icon-picker-body">
        {tab === 'emoji' ? (
          failed ? (
            <p className="px-1 py-3 text-[12px] text-text-3">Couldn’t load emoji.</p>
          ) : !groups ? (
            <p className="px-1 py-3 text-[12px] text-text-3">Loading emoji…</p>
          ) : q ? (
            emojiHits.length === 0 ? (
              <p className="px-1 py-3 text-[12px] text-text-3">No emoji match “{q}”.</p>
            ) : (
              <div className={cn(grid, 'pt-1')} role="group" aria-label="Results">
                {emojiHits.map((e) => emojiCell(e, e.emoji))}
              </div>
            )
          ) : (
            <>
              {recents.length > 0 && (
                <section aria-label="Recent">
                  <div className={sectionLabel}>Recent</div>
                  <div className={grid}>
                    {recents.map((emoji) => emojiCell({ emoji, name: `Recent: ${emoji}` }, `r-${emoji}`))}
                  </div>
                </section>
              )}
              {groups.map((g) => (
                <section key={g.slug} aria-label={g.label}>
                  <div className={sectionLabel}>{g.label}</div>
                  <div className={grid}>{g.emojis.map((e) => emojiCell(e, e.emoji))}</div>
                </section>
              ))}
            </>
          )
        ) : (
          <>
            {glyphs.length === 0 ? (
              <p className="px-1 py-3 text-[12px] text-text-3">No icon matches “{q}”.</p>
            ) : (
              <div className={cn(grid, 'pt-1')} role="group" aria-label="Icons">
                {glyphs.map((name) => {
                  const G = GLYPHS[name]
                  const on = value?.kind === 'glyph' && value.value === name
                  return (
                    <button
                      key={name}
                      type="button"
                      data-cell
                      title={name}
                      aria-label={name}
                      aria-pressed={on}
                      onClick={() => onPick({ kind: 'glyph', value: name, color }, true)}
                      className={cn(
                        'flex h-7 w-7 items-center justify-center rounded-md outline-none hover:bg-hover focus-visible:bg-hover focus-visible:ring-1 focus-visible:ring-accent',
                        on && 'bg-selected'
                      )}
                    >
                      <G className={cn('h-4 w-4', color === null && 'text-text-2')} style={{ color: glyphColor(color) }} strokeWidth={1.75} />
                    </button>
                  )
                })}
              </div>
            )}
          </>
        )}
      </div>

      {tab === 'glyph' && (
        <div className="mt-2 border-t border-border pt-2" role="radiogroup" aria-label="Icon colour">
          <div className="flex items-center justify-between">
            {[null, ...AVATAR_HUES.map((_, i) => i)].map((slot) => (
              <button
                key={slot ?? 'none'}
                type="button"
                role="radio"
                aria-checked={color === slot}
                aria-label={slot === null ? 'No colour' : `Colour ${slot + 1}`}
                onClick={() => {
                  setColor(slot)
                  if (value?.kind === 'glyph') onPick({ kind: 'glyph', value: value.value, color: slot }, false)
                }}
                className={cn(
                  'flex h-[18px] w-[18px] items-center justify-center rounded-full outline-none',
                  color === slot && 'ring-1 ring-text'
                )}
              >
                <span
                  className={cn('h-3 w-3 rounded-full', slot === null && 'border border-text-3')}
                  style={slot === null ? undefined : { background: glyphColor(slot) }}
                />
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
