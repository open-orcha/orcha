import type { ReactNode } from 'react'
import { ArrowRight, Compass } from 'lucide-react'
import { ObButton, StepFooter, StepHeader } from '../ui'

export type ProjectSource = 'local' | 'github'

/** Local folder: a folder with a few lines of code on its face. Monochrome (currentColor)
 *  with one accent detail, so it follows both themes. */
function FolderArt() {
  return (
    <svg viewBox="0 0 64 48" width="64" height="48" fill="none" aria-hidden="true">
      <path
        d="M6 12a4 4 0 0 1 4-4h12.2a4 4 0 0 1 3 1.35L28 12.5h26a4 4 0 0 1 4 4V38a4 4 0 0 1-4 4H10a4 4 0 0 1-4-4V12Z"
        fill="currentColor"
        opacity="0.08"
      />
      <path
        d="M6 12a4 4 0 0 1 4-4h12.2a4 4 0 0 1 3 1.35L28 12.5h26a4 4 0 0 1 4 4V38a4 4 0 0 1-4 4H10a4 4 0 0 1-4-4V12Z"
        stroke="currentColor"
        strokeOpacity="0.55"
        strokeWidth="1.5"
      />
      <path d="M6 18h52" stroke="currentColor" strokeOpacity="0.3" strokeWidth="1.5" />
      <path d="M14 25.5h10" stroke="var(--color-accent)" strokeWidth="2" strokeLinecap="round" />
      <path d="M27 25.5h14" stroke="currentColor" strokeOpacity="0.45" strokeWidth="2" strokeLinecap="round" />
      <path d="M18 31h16" stroke="currentColor" strokeOpacity="0.45" strokeWidth="2" strokeLinecap="round" />
      <path d="M18 36.5h9" stroke="currentColor" strokeOpacity="0.3" strokeWidth="2" strokeLinecap="round" />
    </svg>
  )
}

/** From GitHub: a branch graph — main line, a feature branch that merges back. */
function RepoArt() {
  return (
    <svg viewBox="0 0 64 48" width="64" height="48" fill="none" aria-hidden="true">
      <rect x="6" y="6" width="52" height="36" rx="6" fill="currentColor" opacity="0.08" />
      <rect x="6" y="6" width="52" height="36" rx="6" stroke="currentColor" strokeOpacity="0.55" strokeWidth="1.5" />
      <path d="M16 36V12" stroke="currentColor" strokeOpacity="0.45" strokeWidth="1.75" strokeLinecap="round" />
      <path
        d="M16 30c0-7 12-6 12-13v-1"
        stroke="var(--color-accent)"
        strokeWidth="1.75"
        strokeLinecap="round"
        fill="none"
      />
      <circle cx="16" cy="36" r="3" fill="var(--color-card)" stroke="currentColor" strokeOpacity="0.7" strokeWidth="1.5" />
      <circle cx="16" cy="12" r="3" fill="var(--color-card)" stroke="currentColor" strokeOpacity="0.7" strokeWidth="1.5" />
      <circle cx="28" cy="15" r="3" fill="var(--color-accent)" />
      <path d="M36 17h14" stroke="currentColor" strokeOpacity="0.45" strokeWidth="2" strokeLinecap="round" />
      <path d="M36 24h10" stroke="currentColor" strokeOpacity="0.3" strokeWidth="2" strokeLinecap="round" />
      <path d="M36 31h12" stroke="currentColor" strokeOpacity="0.3" strokeWidth="2" strokeLinecap="round" />
    </svg>
  )
}

const OPTIONS: {
  key: ProjectSource
  art: () => ReactNode
  title: string
  body: string
  meta: string
}[] = [
  {
    key: 'local',
    art: FolderArt,
    title: 'Local folder',
    body: 'Use a folder on this Mac, or create a new one.',
    meta: 'Existing or new'
  },
  {
    key: 'github',
    art: RepoArt,
    title: 'From GitHub',
    body: 'Clone one of your repositories, or paste a URL.',
    meta: 'Clones to this Mac'
  }
]

/** First fork: where the project's code comes from. Illustrated source cards — hover lifts
 *  them, the last choice keeps a soft accent glow — and choosing one moves straight on.
 *
 *  `notice` is the slot for Add a project's background setup check: it only ever shows
 *  something when a requirement is missing, with the fix. Without `onBack` (Add a project
 *  closes from its Cancel instead) the footer is omitted. */
export default function SourceStep({
  selected = null,
  onChoose,
  onBack,
  notice
}: {
  selected?: ProjectSource | null
  onChoose: (source: ProjectSource) => void
  onBack?: () => void
  notice?: ReactNode
}) {
  return (
    <>
      <StepHeader
        icon={<Compass className="h-4 w-4" aria-hidden="true" />}
        title="Where’s your code?"
        subtitle="Embodent sets the project up in a folder on this Mac."
      />
      {notice}
      <div className="ob-source-grid" role="group" aria-label="Project source">
        {OPTIONS.map((o, i) => (
          <button
            key={o.key}
            type="button"
            className="ob-source-card"
            data-selected={selected === o.key}
            aria-pressed={selected === o.key}
            onClick={() => onChoose(o.key)}
            style={{ '--i': i } as React.CSSProperties}
          >
            <span className="ob-source-art">{o.art()}</span>
            <span className="flex min-w-0 flex-col gap-1">
              <span className="ob-source-title">{o.title}</span>
              <span className="ob-source-body">{o.body}</span>
            </span>
            <span className="ob-source-foot">
              <span className="ob-meta">{o.meta}</span>
              <ArrowRight className="ob-source-arrow h-3.5 w-3.5" aria-hidden="true" />
            </span>
          </button>
        ))}
      </div>
      {onBack && (
        <StepFooter
          left={
            <ObButton variant="ghost" onClick={onBack}>
              Back
            </ObButton>
          }
        />
      )}
    </>
  )
}
