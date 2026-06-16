export type ViewMode = 'cards' | 'list'

interface Props {
  view: ViewMode
  onChange: (view: ViewMode) => void
}

/** Segmented Cards/List control for the manager header. */
export default function ViewToggle({ view, onChange }: Props) {
  return (
    <div className="view-toggle" role="group" aria-label="View mode">
      <button
        className="view-toggle-btn"
        aria-pressed={view === 'cards'}
        onClick={() => onChange('cards')}
      >
        <span aria-hidden="true">⊞</span> Cards
      </button>
      <button
        className="view-toggle-btn"
        aria-pressed={view === 'list'}
        onClick={() => onChange('list')}
      >
        <span aria-hidden="true">☰</span> List
      </button>
    </div>
  )
}
