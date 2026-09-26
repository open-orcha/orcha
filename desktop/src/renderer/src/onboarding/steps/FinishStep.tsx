import { Button } from '../../ui/Button'
import { Card } from '../../ui/Card'

/** Success screen at the end of the wizard: a staggered summary, one gentle CSS-only
 *  celebratory touch (the orca glyph doing a single arc — reuses onb-wave, no confetti
 *  libraries), then hand off to the portal. */
export default function FinishStep({
  project,
  portalUrl,
  fleetCreated,
  codeSourceBound = false,
  onOpenPortal
}: {
  project: string
  portalUrl: string
  fleetCreated: boolean
  /** True once bindCodeSource resolved the just-provisioned container to its local git
   *  repo (see onboarding/bindCodeSource.ts) — surfaced as one extra summary line, never
   *  blocking: a false here just means an older portal or a non-git folder, not an error. */
  codeSourceBound?: boolean
  onOpenPortal: () => void
}) {
  return (
    <div className="mx-auto flex w-full max-w-[640px] flex-col items-center gap-6 py-6 text-center">
      <span aria-hidden className="onb-wave onb-glyph-in text-4xl">
        🐋
      </span>
      <div className="onb-rise-in flex flex-col gap-1">
        <span className="onb-eyebrow">All set</span>
        <h2 className="onb-title text-2xl">{project} is ready</h2>
      </div>
      <div className="onb-stagger grid w-full max-w-sm grid-cols-1 gap-2 text-left">
        <Card className="flex items-center justify-between text-sm" style={{ '--onb-stagger-i': 0 } as React.CSSProperties}>
          <span className="text-text/50">Project</span>
          <span className="font-medium text-text">{project}</span>
        </Card>
        <Card className="flex items-center justify-between text-sm" style={{ '--onb-stagger-i': 1 } as React.CSSProperties}>
          <span className="text-text/50">Portal</span>
          <span className="truncate font-mono text-xs text-text">{portalUrl}</span>
        </Card>
        <Card className="flex items-center justify-between text-sm" style={{ '--onb-stagger-i': 2 } as React.CSSProperties}>
          <span className="text-text/50">Fleet</span>
          <span className="font-medium text-text">{fleetCreated ? 'Created' : 'Not created'}</span>
        </Card>
        {codeSourceBound && (
          <Card className="flex items-center justify-between text-sm" style={{ '--onb-stagger-i': 3 } as React.CSSProperties}>
            <span className="text-text/50">Code source</span>
            <span className="font-medium text-text">local repository</span>
          </Card>
        )}
      </div>
      <Button size="lg" className="onb-rise-in" data-onb-primary="true" onClick={onOpenPortal}>
        Open your portal
      </Button>
    </div>
  )
}
