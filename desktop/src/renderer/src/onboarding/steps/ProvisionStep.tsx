import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { Check, ChevronDown, ChevronRight, Copy, X } from 'lucide-react'
import type { ProgressEvent, ProvisionStep as StepId } from '../../../../shared/types'
import type { ProvisionFailure } from '../provisionError'
import { InlineText, Notice, ObButton, StatusGlyph, StepFooter, StepHeader, type GlyphState } from '../ui'
import { formatElapsed, useElapsed } from '../motion'

export type ProvisionStatus = 'idle' | 'running' | 'done' | 'failed'

const STEPS: { id: StepId; label: string }[] = [
  { id: 'clone-repo', label: 'Clone the repository' },
  { id: 'preflight', label: 'Check Docker' },
  { id: 'render-compose', label: 'Prepare project files' },
  { id: 'copy-templates', label: 'Copy templates' },
  { id: 'compose-up', label: 'Start containers' },
  { id: 'wait-portal', label: 'Wait for the portal' },
  { id: 'create-container', label: 'Create the project' },
  { id: 'register-human', label: 'Register you' },
  { id: 'start-daemons', label: 'Start the agent worker' }
]

/** Steps every local provision walks; clone/preflight rows only appear when they apply. */
const CORE = new Set<StepId>([
  'render-compose',
  'copy-templates',
  'compose-up',
  'wait-portal',
  'create-container',
  'register-human',
  'start-daemons'
])

const ASIDE: Record<GlyphState, string> = {
  todo: '',
  running: 'Running…',
  done: 'Done',
  failed: 'Failed',
  skipped: 'Skipped',
  warning: ''
}

/** Create: a live launch view for provisioning (and cloning). A status orb, the stage in
 *  progress, elapsed time and an overall progress bar sit over a slow, subtle light field;
 *  below, a stepped timeline of the REAL provisioning stages (driven by the progress stream)
 *  fills its rail as each stage lands, with per-stage durations. Completion gets one calm
 *  moment — the orb resolves into a check with a single ripple.
 *
 *  Honest by design: the live log on demand, and — when it fails — a readable reason, the
 *  raw details on demand, Try again and Back. Never a dead end, and the title always matches
 *  what actually happened. */
export default function ProvisionStep({
  projectName,
  events,
  status,
  failure,
  warnings = [],
  gitTip = null,
  withClone = false,
  onContinue,
  onRetry,
  onBack
}: {
  projectName: string
  events: ProgressEvent[]
  status: ProvisionStatus
  failure: ProvisionFailure | null
  warnings?: string[]
  gitTip?: string | null
  withClone?: boolean
  onContinue: () => void
  onRetry: () => void
  onBack: () => void
}) {
  const stepState = new Map<StepId, GlyphState>()
  const logs: string[] = []
  for (const e of events) {
    if (e.status === 'log') logs.push(e.line)
    else
      stepState.set(
        e.step,
        e.status === 'ok' ? 'done' : e.status === 'fail' ? 'failed' : e.status === 'skip' ? 'skipped' : 'running'
      )
  }
  // A step still "running" when the attempt failed is the one that failed (the engine
  // doesn't always emit an explicit fail event before rejecting).
  if (status === 'failed') {
    for (const [k, v] of stepState) if (v === 'running') stepState.set(k, 'failed')
    if (failure?.step && !stepState.has(failure.step)) stepState.set(failure.step, 'failed')
  }
  const visible = STEPS.filter((s) => CORE.has(s.id) || stepState.has(s.id) || (s.id === 'clone-repo' && withClone))
  const finished = visible.filter((s) => {
    const st = stepState.get(s.id)
    return st === 'done' || st === 'skipped'
  }).length
  const current = visible.find((s) => stepState.get(s.id) === 'running')

  // When each stage started / finished, as seen by this view (events carry no timestamps).
  const [timing, setTiming] = useState<Map<StepId, { start?: number; end?: number }>>(new Map())
  useEffect(() => {
    if (events.length === 0) {
      setTiming((t) => (t.size ? new Map() : t))
      return
    }
    setTiming((prev) => {
      const next = new Map(prev)
      const now = Date.now()
      let changed = false
      for (const e of events) {
        if (e.status === 'log') continue
        const t = next.get(e.step) ?? {}
        if (e.status === 'start' && t.start === undefined) {
          next.set(e.step, { ...t, start: now })
          changed = true
        } else if (e.status !== 'start' && t.end === undefined) {
          next.set(e.step, { ...t, end: now })
          changed = true
        }
      }
      return changed ? next : prev
    })
  }, [events])

  // Elapsed time for the current attempt (restarts on Try again).
  const [startedAt, setStartedAt] = useState<number | null>(null)
  useEffect(() => {
    if (status === 'running') setStartedAt(Date.now())
  }, [status])
  const elapsed = useElapsed(startedAt, status === 'running')

  const [showLog, setShowLog] = useState(false)
  const logOpen = showLog || status === 'failed'
  const logRef = useRef<HTMLPreElement>(null)
  useEffect(() => {
    if (logOpen && logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight
  }, [logOpen, logs.length])
  const [showDetail, setShowDetail] = useState(false)
  const [hideSteps, setHideSteps] = useState(false)
  const notes = warnings.length + (gitTip ? 1 : 0)
  // Once done, the timeline stays in view for the completion moment; when there is
  // something to read (warnings / the git tip) it folds away so that comes first.
  const stepsOpen = status !== 'done' || (notes === 0 ? !hideSteps : hideSteps)

  const title =
    status === 'failed'
      ? `Couldn’t create ${projectName}`
      : status === 'done'
        ? `${projectName} is ready`
        : `Creating ${projectName}`
  const subtitle =
    status === 'failed'
      ? 'Nothing you entered is lost. Fix the problem below, then try again — or go back and change your choices.'
      : status === 'done'
        ? notes === 0
          ? 'The project is running. Next up: your agents.'
          : `The project is running. ${notes > 1 ? 'A few things' : 'One thing'} to know before you add agents:`
        : `Step ${Math.min(finished + 1, visible.length)} of ${visible.length}${current ? ` · ${current.label}` : ''}. This usually takes a minute or two.`

  const progress = status === 'done' ? 1 : visible.length ? finished / visible.length : 0
  const failedStep = visible.find((s) => stepState.get(s.id) === 'failed')
  const stageLabel =
    status === 'done'
      ? 'Everything is up'
      : status === 'failed'
        ? (failedStep?.label ?? 'Stopped')
        : (current?.label ?? (finished === 0 ? 'Getting ready' : 'Finishing up'))
  const lastLog = logs.length ? logs[logs.length - 1].trim() : ''

  return (
    <>
      <StepHeader title={title} subtitle={subtitle} />

      <section className="ob-launch" data-status={status} aria-label="Creation progress">
        <div className="ob-launch-field" aria-hidden="true">
          <span className="ob-launch-glow" data-n="1" />
          <span className="ob-launch-glow" data-n="2" />
        </div>
        <div className="ob-launch-head">
          <span className="ob-orb" aria-hidden="true">
            <span className="ob-orb-ring" />
            <span className="ob-orb-arc" />
            {status === 'done' && (
              <>
                <span className="ob-orb-ripple" />
                <span className="ob-orb-core ob-pop">
                  <Check className="h-4 w-4" strokeWidth={2.75} />
                </span>
              </>
            )}
            {status === 'failed' && (
              <span className="ob-orb-core ob-pop" data-tone="danger">
                <X className="h-4 w-4" strokeWidth={2.75} />
              </span>
            )}
          </span>
          <span className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span key={stageLabel} className="ob-launch-stage ob-swap">
              {stageLabel}
            </span>
            <span className="ob-meta truncate" title={status === 'running' ? lastLog : undefined}>
              {status === 'running'
                ? lastLog || `${finished} of ${visible.length} stages done`
                : status === 'done'
                  ? `Up and running in ${formatElapsed(elapsed)}`
                  : `${finished} of ${visible.length} stages finished`}
            </span>
          </span>
          <span className="ob-launch-time" aria-label={`Elapsed ${formatElapsed(elapsed)}`}>
            {formatElapsed(elapsed)}
          </span>
        </div>
        <div className="ob-launch-bar" aria-hidden="true">
          <span className="ob-launch-bar-fill" style={{ transform: `scaleX(${progress})` }} />
        </div>
      </section>

      {status === 'failed' && failure && (
        <Notice
          tone="danger"
          title={<InlineText text={failure.message} />}
          action={
            <div className="flex items-center gap-1.5">
              <ObButton variant="ghost" onClick={onBack}>
                Back
              </ObButton>
              <ObButton variant="primary" data-onb-primary="true" onClick={onRetry}>
                Try again
              </ObButton>
            </div>
          }
        >
          {(failure.cause || failure.detail) && (
            <div className="flex flex-col gap-1.5">
              {failure.cause && (
                <span className="ob-notice-cause" data-testid="failure-cause">
                  {failure.cause}
                </span>
              )}
              {failure.detail && (
                <div className="flex flex-col gap-2">
                  <button
                    type="button"
                    className="ob-disclosure"
                    aria-expanded={showDetail}
                    onClick={() => setShowDetail((v) => !v)}
                  >
                    {showDetail ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
                    {showDetail ? 'Hide details' : 'Show details'}
                  </button>
                  {showDetail && <pre className="ob-log max-h-40">{failure.detail.slice(-4000)}</pre>}
                </div>
              )}
            </div>
          )}
        </Notice>
      )}

      {status === 'done' && notes > 0 && (
        <div className="flex flex-col gap-2">
          {warnings.map((w, i) => (
            <Notice key={i} tone="warning">
              <InlineText text={w} />
            </Notice>
          ))}
          {gitTip && (
            <Notice>
              <InlineText text={gitTip} />
            </Notice>
          )}
        </div>
      )}

      {status === 'done' && (
        <button
          type="button"
          className="ob-disclosure"
          aria-expanded={stepsOpen}
          onClick={() => setHideSteps((v) => !v)}
        >
          {stepsOpen ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
          All {visible.length} steps finished
        </button>
      )}
      {stepsOpen && (
        <div className="ob-timeline" aria-label="Progress" role="list">
          {visible.map((s, i) => {
            const st = stepState.get(s.id) ?? 'todo'
            const t = timing.get(s.id)
            const took =
              t?.start !== undefined && t.end !== undefined && (st === 'done' || st === 'failed')
                ? Math.max(0, Math.round((t.end - t.start) / 1000))
                : null
            const next = visible[i + 1]
            const nextState = next ? (stepState.get(next.id) ?? 'todo') : null
            return (
              <div
                key={s.id}
                role="listitem"
                className="ob-tl-item"
                data-state={st}
                style={{ '--i': i } as CSSProperties}
              >
                <span className="ob-tl-node">
                  <StatusGlyph key={st} state={st} />
                </span>
                {next && (
                  <span
                    className="ob-tl-rail"
                    aria-hidden="true"
                    data-filled={st === 'done' || st === 'skipped'}
                    data-live={nextState === 'running'}
                  >
                    <span className="ob-tl-rail-fill" />
                  </span>
                )}
                <span className={`ob-tl-label ${st === 'todo' || st === 'skipped' ? 'text-text-3' : 'text-text'}`}>
                  {s.label}
                </span>
                <span className={`ob-row-aside tabular-nums ${st === 'failed' ? 'text-danger' : ''}`}>
                  {took !== null && st === 'done' ? `${took}s` : ASIDE[st]}
                </span>
              </div>
            )
          })}
        </div>
      )}

      {logs.length > 0 && (status !== 'done' || stepsOpen) && (
        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between">
            <button
              type="button"
              className="ob-disclosure"
              aria-expanded={logOpen}
              onClick={() => setShowLog((v) => !v)}
            >
              {logOpen ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
              Log · {logs.length} {logs.length === 1 ? 'line' : 'lines'}
            </button>
            {logOpen && (
              <button
                type="button"
                className="ob-disclosure"
                onClick={() => void navigator.clipboard?.writeText(logs.join('\n'))}
              >
                <Copy className="h-3 w-3" /> Copy log
              </button>
            )}
          </div>
          {logOpen && (
            <pre ref={logRef} className="ob-log" aria-label="Provisioning log">
              {logs.slice(-400).join('\n')}
            </pre>
          )}
        </div>
      )}

      {status === 'done' && (
        <StepFooter>
          <ObButton variant="primary" data-onb-primary="true" onClick={onContinue}>
            Continue
          </ObButton>
        </StepFooter>
      )}
    </>
  )
}
