import type { ProgressEvent } from '../../../../shared/types'
import { Card } from '../../ui/Card'
import { Button } from '../../ui/Button'
import ShowcaseCarousel from '../showcase/ShowcaseCarousel'
import { Check, Loader2, X } from 'lucide-react'

const STEP_LABELS: Record<string, string> = {
  'clone-repo': 'Clone repository',
  'render-compose': 'Render compose file',
  'copy-templates': 'Copy templates',
  'compose-up': 'Start containers',
  'wait-portal': 'Wait for portal',
  'create-container': 'Create container',
  'register-human': 'Register you',
  'start-daemons': 'Start the agent worker'
}

export default function ProvisionStep({
  events,
  done,
  error,
  warnings = [],
  gitTip = null,
  withClone = false,
  onContinue
}: {
  events: ProgressEvent[]
  done: boolean
  error: string | null
  warnings?: string[]
  /** One-line note shown in the success state when the provisioned folder isn't a git
   *  repo yet. Orcha never runs git itself — this is informational only. */
  gitTip?: string | null
  /** True for the "From GitHub" source: shows the "Clone repository" row ahead of the
   *  usual provision steps. Local-folder provisioning never emits a clone-repo event, so
   *  this stays false there and the row is omitted rather than sitting permanently hollow. */
  withClone?: boolean
  onContinue?: () => void
}) {
  // Latest status per step.
  const status = new Map<string, string>()
  const logs: string[] = []
  for (const e of events) {
    if (e.status === 'log' && 'line' in e) logs.push(e.line)
    else status.set(e.step, e.status)
  }
  const visibleSteps = Object.entries(STEP_LABELS).filter(([step]) => withClone || step !== 'clone-repo')
  return (
    <div className="onb-two-col grid grid-cols-1 items-center gap-10 lg:grid-cols-2">
      <div className="flex flex-col gap-5 animate-slide-in">
        <div className="flex flex-col gap-1">
          <span className="onb-eyebrow">Create</span>
          <h2 className="onb-title text-2xl">{done ? 'Project ready' : 'Creating your project…'}</h2>
        </div>
        <Card className="onb-checklist flex flex-col gap-3 p-5">
          {visibleSteps.map(([step, label]) => {
            const s = status.get(step)
            return (
              <div key={step} className="flex items-center gap-3 text-[15px]">
                {s === 'ok' ? (
                  <span className="onb-check-pop onb-check-badge">
                    <Check className="h-3.5 w-3.5" />
                  </span>
                ) : s === 'fail' ? (
                  <X className="h-5 w-5 text-danger" />
                ) : s === 'start' ? (
                  <span className="onb-spin flex h-5 w-5 items-center justify-center">
                    <Loader2 className="h-5 w-5 text-accent" />
                  </span>
                ) : (
                  <span className="h-5 w-5 rounded-full border border-border" />
                )}
                <span className={s === 'skip' ? 'text-text/40' : 'text-text/80'}>{label}</span>
              </div>
            )
          })}
        </Card>
        {error && <Card className="border-danger/40 text-sm text-danger">{error}</Card>}
        {done && !error && (warnings.length > 0 || gitTip) && (
          <Card className="flex flex-col gap-3 border-warning/40 text-sm">
            {warnings.length > 0 && (
              <>
                <span className="font-medium">Your project is ready — one thing to know:</span>
                <ul className="flex flex-col gap-2 text-text/80">
                  {warnings.map((w, i) => (
                    <li key={i} className="flex gap-2">
                      <span aria-hidden>•</span>
                      <span>{w}</span>
                    </li>
                  ))}
                </ul>
              </>
            )}
            {gitTip && <span className="text-text/60">{gitTip}</span>}
            {onContinue && (
              <div className="flex justify-end">
                <Button data-onb-primary="true" onClick={onContinue}>
                  Continue
                </Button>
              </div>
            )}
          </Card>
        )}
        {logs.length > 0 && (
          <details className="text-xs text-text/50">
            <summary className="cursor-pointer">Build log</summary>
            <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap font-mono">
              {logs.slice(-200).join('\n')}
            </pre>
          </details>
        )}
      </div>

      <div className="hidden lg:block">
        <ShowcaseCarousel />
      </div>
    </div>
  )
}
