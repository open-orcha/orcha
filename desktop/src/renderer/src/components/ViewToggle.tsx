import { cn } from '../ui/cn'

export type ViewMode = 'cards' | 'list'

export default function ViewToggle({
  view,
  onChange
}: {
  view: ViewMode
  onChange: (mode: ViewMode) => void
}) {
  return (
    <div className="inline-flex rounded-lg border border-border p-0.5" role="group" aria-label="View mode">
      {(['cards', 'list'] as const).map((mode) => (
        <button
          key={mode}
          aria-pressed={view === mode}
          onClick={() => onChange(mode)}
          className={cn(
            'rounded-md px-3 py-1 text-sm capitalize transition-colors duration-[var(--duration-base)]',
            view === mode ? 'bg-card text-text' : 'text-text/50 hover:text-text'
          )}
        >
          {mode}
        </button>
      ))}
    </div>
  )
}
