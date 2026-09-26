export interface PillSegment {
  key: string
  label: string
  state: 'done' | 'current' | 'upcoming'
}

/** Clickable pill-segment progress (4px tall; the active segment is wider + filled, others
 *  sit at 25% opacity). Replaces the numbered Stepper for the cinematic wizard — segments
 *  are clickable only when already visited (`done`), mirroring back-navigation. */
export function ProgressPills({
  segments,
  onJump
}: {
  segments: PillSegment[]
  onJump?: (key: string) => void
}) {
  return (
    <div className="onb-pills" role="tablist" aria-label="Onboarding progress">
      {segments.map((seg) => (
        <button
          key={seg.key}
          type="button"
          role="tab"
          title={seg.label}
          aria-label={seg.label}
          aria-selected={seg.state === 'current'}
          data-state={seg.state}
          className="onb-pill"
          disabled={seg.state === 'upcoming' || !onJump}
          onClick={() => onJump?.(seg.key)}
        />
      ))}
    </div>
  )
}
