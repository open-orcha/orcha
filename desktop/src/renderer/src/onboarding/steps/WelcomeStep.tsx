import { useEffect, useRef, useState } from 'react'
import { Users, Terminal, GitBranch, Smartphone } from 'lucide-react'
import { Button } from '../../ui/Button'
import { Card } from '../../ui/Card'

const TAGLINE = 'Your agent fleet, on your machine.'

const FEATURES = [
  { icon: Users, title: 'A fleet, not one bot', body: 'Run several agents on the same project at once.' },
  { icon: GitBranch, title: 'Code Space', body: 'Leave inline comments, right on the diff.' },
  { icon: Terminal, title: 'Runs locally', body: 'Your code stays on your machine.' },
  { icon: Smartphone, title: 'Pair your phone', body: 'Check in on progress from anywhere.' }
]

/** First-run's cinematic open: glyph + wordmark reveal, a typewriter tagline (literal
 *  textContent char-append, imperative — not React state per char), then a staggered
 *  reveal of feature cards. `document.startViewTransition` guards the swap into Setup
 *  when the browser supports it (Chromium does, jsdom in tests does not). */
export default function WelcomeStep({ onContinue }: { onContinue: () => void }) {
  const taglineRef = useRef<HTMLParagraphElement>(null)
  const [showFeatures, setShowFeatures] = useState(false)

  useEffect(() => {
    const el = taglineRef.current
    if (!el) return
    let i = 0
    let cancelled = false
    const tick = (): void => {
      if (cancelled) return
      el.textContent = TAGLINE.slice(0, i)
      i += 1
      if (i <= TAGLINE.length) setTimeout(tick, 55)
      else setTimeout(() => !cancelled && setShowFeatures(true), 200)
    }
    tick()
    return () => {
      cancelled = true
    }
  }, [])

  function go(): void {
    const nav = (): void => onContinue()
    const withVT = document as Document & { startViewTransition?: (cb: () => void) => void }
    if (typeof withVT.startViewTransition === 'function') withVT.startViewTransition(nav)
    else nav()
  }

  return (
    <div className="mx-auto flex w-full max-w-[760px] flex-col items-center gap-8 py-6 text-center">
      <div className="onb-glyph-in flex flex-col items-center gap-3">
        <span
          aria-hidden
          className="onb-wave flex h-16 w-16 items-center justify-center rounded-2xl bg-accent/15 text-3xl"
        >
          🐋
        </span>
        <h1 className="onb-title">Orcha</h1>
      </div>
      <p ref={taglineRef} className="onb-body min-h-[1.5em] text-base" aria-label={TAGLINE}>
        <span className="onb-caret">|</span>
      </p>
      {showFeatures && (
        <div className="onb-stagger grid w-full grid-cols-2 gap-4 sm:grid-cols-4">
          {FEATURES.map((f, i) => (
            <Card
              key={f.title}
              className="flex flex-col items-center gap-2 p-4 text-center"
              style={{ '--onb-stagger-i': i } as React.CSSProperties}
            >
              <f.icon className="h-5 w-5 text-accent" />
              <span className="text-sm font-medium text-text">{f.title}</span>
              <span className="text-xs text-text/50">{f.body}</span>
            </Card>
          ))}
        </div>
      )}
      {showFeatures && (
        <Button size="lg" className="onb-rise-in" data-onb-primary="true" onClick={go}>
          Get started
        </Button>
      )}
    </div>
  )
}
