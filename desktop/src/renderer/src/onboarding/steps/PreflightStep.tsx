import { useEffect, useState } from 'react'
import type { InstallProgress, PreflightReport, Prereq, PrereqProbe } from '../../../../shared/types'
import { Button } from '../../ui/Button'
import { Card } from '../../ui/Card'
import { AlertCircle, CheckCircle2, Circle, Download, Loader2, Sparkles } from 'lucide-react'

const DOCKER_DOWNLOAD_URL = 'https://www.docker.com/products/docker-desktop/'

/** The host tools Orcha needs, in install order, with plain-language labels. */
const PREREQS: { id: Prereq; label: string }[] = [
  { id: 'homebrew', label: 'Homebrew (installs the rest)' },
  { id: 'dockerEngine', label: 'Docker engine' },
  { id: 'orcha', label: 'Orcha helper' },
  { id: 'claude', label: 'Claude Code' },
  { id: 'apiKey', label: 'Anthropic API key' }
]

type RowStatus = 'ok' | 'missing' | 'running' | 'failed'

export default function PreflightStep({ onContinue }: { onContinue: () => void }) {
  const [report, setReport] = useState<PreflightReport | null>(null)
  const [probe, setProbe] = useState<PrereqProbe | null>(null)
  const [checking, setChecking] = useState(true)
  const [installing, setInstalling] = useState(false)
  const [running, setRunning] = useState<Partial<Record<Prereq, RowStatus>>>({})
  const [lastLine, setLastLine] = useState('')
  const [installError, setInstallError] = useState<string | null>(null)

  const check = (): void => {
    setChecking(true)
    void Promise.all([window.orchaDesktop.preflight(), window.orchaDesktop.probePrereqs()]).then(
      ([r, p]) => {
        setReport(r)
        setProbe(p)
        setChecking(false)
      }
    )
  }
  useEffect(() => check(), [])

  // Live install progress from the main process.
  useEffect(
    () =>
      window.orchaDesktop.onInstallProgress((e: InstallProgress) => {
        if (e.status === 'log') {
          setLastLine(e.line)
          return
        }
        const map: Record<typeof e.status, RowStatus> = {
          start: 'running',
          ok: 'ok',
          skip: 'missing',
          fail: 'failed'
        }
        setRunning((prev) => ({ ...prev, [e.id]: map[e.status] }))
      }),
    []
  )

  const dockerOk = report?.docker === 'ok'
  const allReady = !!probe && PREREQS.every((p) => probe[p.id]) && dockerOk
  const missingCount = probe ? PREREQS.filter((p) => !probe[p.id]).length : 0

  async function install(): Promise<void> {
    setInstalling(true)
    setInstallError(null)
    setRunning({})
    setLastLine('')
    try {
      const res = await window.orchaDesktop.installPrereqs()
      if (!res.ok) setInstallError(`Couldn’t finish installing (${res.failedAt}). ${res.detail}`)
    } catch {
      setInstallError('The setup couldn’t run. Please try again.')
    } finally {
      setInstalling(false)
      check() // re-probe so the checklist + Continue reflect reality
    }
  }

  function rowStatus(id: Prereq): RowStatus {
    if (installing && running[id]) return running[id] as RowStatus
    return probe?.[id] ? 'ok' : 'missing'
  }

  return (
    <div className="flex flex-col gap-4 animate-slide-in">
      <h2 className="text-lg font-semibold">What Orcha needs</h2>
      <p className="text-sm text-text/70">
        Orcha needs a few free tools to run agents on this Mac. We can install whatever’s missing
        for you — you’ll be asked for your Mac password once and your Anthropic API key once.
      </p>

      <Card className="flex flex-col gap-2 text-sm">
        {checking && !probe ? (
          <span className="flex items-center gap-2 text-text/70">
            <Loader2 className="h-4 w-4 animate-spin text-accent" /> Checking what’s installed…
          </span>
        ) : (
          PREREQS.map((p) => {
            const s = rowStatus(p.id)
            return (
              <span key={p.id} className="flex items-center gap-2">
                {s === 'ok' ? (
                  <CheckCircle2 className="h-4 w-4 shrink-0 text-ok" />
                ) : s === 'running' ? (
                  <Loader2 className="h-4 w-4 shrink-0 animate-spin text-accent" />
                ) : s === 'failed' ? (
                  <AlertCircle className="h-4 w-4 shrink-0 text-red-500" />
                ) : (
                  <Circle className="h-4 w-4 shrink-0 text-text/30" />
                )}
                <span className={s === 'ok' ? 'text-text' : 'text-text/70'}>{p.label}</span>
              </span>
            )
          })
        )}
      </Card>

      {installing && lastLine && (
        <p className="truncate font-mono text-xs text-text/50" title={lastLine}>
          {lastLine}
        </p>
      )}
      {installError && <p className="text-sm text-red-500">{installError}</p>}
      {!installing && !dockerOk && report?.hint && <p className="text-sm text-text/70">{report.hint}</p>}

      <div className="flex flex-wrap gap-2">
        {!allReady && (
          <Button disabled={installing || checking} onClick={() => void install()}>
            {installing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
            {installing ? 'Installing…' : `Install ${missingCount} for me`}
          </Button>
        )}
        {!installing && probe && !probe.dockerEngine && (
          <Button variant="outline" onClick={() => void window.orchaDesktop.openExternal(DOCKER_DOWNLOAD_URL)}>
            <Download className="h-4 w-4" />
            Get Docker Desktop
          </Button>
        )}
        {report && !allReady && (
          <Button variant="outline" disabled={checking || installing} onClick={check}>
            Re-check
          </Button>
        )}
        <Button disabled={!dockerOk || installing} onClick={onContinue}>
          Continue
        </Button>
      </div>
    </div>
  )
}
