const LINES = [
  '$ orcha up',
  '✓ containers started',
  '✓ portal ready · :8000',
  '→ Atlas picked up "Wire retry logic"'
]

/** Storyboard (c): a live terminal with streaming mono lines. Each line's entrance is
 *  staggered via CSS animation-delay (no JS timers) — the whole frame just needs to be
 *  visible long enough for the CSS to play once per loop pass. */
export default function TerminalFrame() {
  return (
    <div className="flex h-full w-full flex-col gap-2 rounded-xl border border-border bg-bg p-5 font-mono text-xs">
      <div className="mb-1 flex items-center gap-2">
        <span className="h-2.5 w-2.5 rounded-full bg-danger/60" />
        <span className="h-2.5 w-2.5 rounded-full bg-warning/60" />
        <span className="h-2.5 w-2.5 rounded-full bg-ok/60" />
      </div>
      {LINES.map((line, i) => (
        <div
          key={line}
          className="onb-term-line text-text/70"
          style={{ animationDelay: `${i * 220}ms` }}
        >
          {line}
        </div>
      ))}
    </div>
  )
}
