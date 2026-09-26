import { useEffect, useRef, useState } from 'react'

const COMMENT = 'Should this retry?'

/** Storyboard (b): Code Space — a mini file tree, a line-anchored comment bubble that
 *  types itself in, then a reply. The typewriter is a literal textContent char-append on
 *  an imperative ref (not React state per char), per the design-system rule. Runs once
 *  per mount; harmless to re-trigger since this frame just loops back into view. */
export default function CodeSpaceFrame() {
  const [showReply, setShowReply] = useState(false)
  const caretRef = useRef<HTMLSpanElement>(null)

  useEffect(() => {
    const el = caretRef.current
    if (!el) return
    let i = 0
    let cancelled = false
    const tick = (): void => {
      if (cancelled || i > COMMENT.length) return
      el.textContent = COMMENT.slice(0, i)
      i += 1
      if (i <= COMMENT.length) setTimeout(tick, 55)
      else setTimeout(() => !cancelled && setShowReply(true), 300)
    }
    tick()
    return () => {
      cancelled = true
    }
  }, [])

  return (
    <div className="flex h-full w-full gap-4 rounded-xl border border-border bg-bg p-5">
      <div className="flex w-24 flex-col gap-1.5 border-r border-border pr-3 text-xs text-text/40">
        <span className="text-text/60">src/</span>
        <span className="pl-2 text-accent">sync.ts</span>
        <span className="pl-2">types.ts</span>
      </div>
      <div className="flex flex-1 flex-col gap-1.5 font-mono text-xs text-text/50">
        <div>1 &nbsp;async function sync() &#123;</div>
        <div className="relative rounded bg-accent/10 px-1.5 py-0.5 text-text/80">2 &nbsp;&nbsp;await push(delta)</div>
        <div className="ml-5 mt-2 flex max-w-[85%] flex-col gap-1 rounded-md border border-accent/30 bg-card px-3 py-2">
          <span className="text-[10px] font-semibold uppercase tracking-wide text-accent">Sable</span>
          <span className="text-xs text-text/80">
            <span ref={caretRef} />
            <span className="onb-caret">|</span>
          </span>
        </div>
        {showReply && (
          <div className="onb-rise-in ml-5 flex max-w-[85%] flex-col gap-1 rounded-md border border-border bg-card px-3 py-2">
            <span className="text-[10px] font-semibold uppercase tracking-wide text-text/60">Atlas</span>
            <span className="text-xs text-text/80">Yeah — three attempts, then escalate.</span>
          </div>
        )}
        <div>3 &nbsp;&#125;</div>
      </div>
    </div>
  )
}
