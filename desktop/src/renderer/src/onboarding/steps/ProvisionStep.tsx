import type { ProgressEvent } from '../../../../shared/types'
import { Card } from '../../ui/Card'
import { Check, Loader2, X } from 'lucide-react'

const STEP_LABELS: Record<string, string> = {
  'render-compose': 'Render compose file',
  'copy-templates': 'Copy templates',
  'compose-up': 'Start containers',
  'wait-portal': 'Wait for portal',
  'create-container': 'Create container',
  'register-human': 'Register you',
  'start-daemons': 'Start daemons'
}

export default function ProvisionStep({
  events,
  done,
  error
}: {
  events: ProgressEvent[]
  done: boolean
  error: string | null
}) {
  // Latest status per step.
  const status = new Map<string, string>()
  const logs: string[] = []
  for (const e of events) {
    if (e.status === 'log' && 'line' in e) logs.push(e.line)
    else status.set(e.step, e.status)
  }
  return (
    <div className="flex flex-col gap-4 animate-slide-in">
      <h2 className="text-lg font-semibold">{done ? 'Project ready' : 'Creating your project…'}</h2>
      <Card className="flex flex-col gap-2">
        {Object.entries(STEP_LABELS).map(([step, label]) => {
          const s = status.get(step)
          return (
            <div key={step} className="flex items-center gap-2 text-sm">
              {s === 'ok' ? (
                <Check className="h-4 w-4 text-ok" />
              ) : s === 'fail' ? (
                <X className="h-4 w-4 text-danger" />
              ) : s === 'start' ? (
                <Loader2 className="h-4 w-4 animate-spin text-accent" />
              ) : (
                <span className="h-4 w-4 rounded-full border border-border" />
              )}
              <span className={s === 'skip' ? 'text-text/40' : 'text-text/80'}>{label}</span>
            </div>
          )
        })}
      </Card>
      {error && <Card className="border-danger/40 text-sm text-danger">{error}</Card>}
      {logs.length > 0 && (
        <details className="text-xs text-text/50">
          <summary className="cursor-pointer">Build log</summary>
          <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap font-mono">
            {logs.slice(-200).join('\n')}
          </pre>
        </details>
      )}
    </div>
  )
}
