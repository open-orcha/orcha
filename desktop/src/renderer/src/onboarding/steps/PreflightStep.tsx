import { useEffect, useState } from 'react'
import type { PreflightReport } from '../../../../shared/types'
import { Button } from '../../ui/Button'
import { Card } from '../../ui/Card'
import { CheckCircle2, Download, Loader2 } from 'lucide-react'

const DOCKER_DOWNLOAD_URL = 'https://www.docker.com/products/docker-desktop/'

export default function PreflightStep({ onContinue }: { onContinue: () => void }) {
  const [report, setReport] = useState<PreflightReport | null>(null)
  const [checking, setChecking] = useState(true)

  const check = (): void => {
    setChecking(true)
    void window.orchaDesktop.preflight().then((r) => {
      setReport(r)
      setChecking(false)
    })
  }
  useEffect(() => check(), [])

  const ok = report?.docker === 'ok'
  const notInstalled = report?.docker === 'not-installed'

  return (
    <div className="flex flex-col gap-4 animate-slide-in">
      <h2 className="text-lg font-semibold">Check Docker</h2>
      <Card className="flex items-start gap-3 text-sm">
        {checking ? (
          <Loader2 className="mt-0.5 h-4 w-4 shrink-0 animate-spin text-accent" />
        ) : ok ? (
          <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-ok" />
        ) : (
          <Download className="mt-0.5 h-4 w-4 shrink-0 text-accent" />
        )}
        <span className={ok ? 'text-text' : 'text-text/80'}>
          {checking
            ? 'Checking Docker…'
            : ok
              ? 'Docker is ready.'
              : (report?.hint ??
                'Docker is required to run Orcha. Install Docker Desktop, then re-check.')}
        </span>
      </Card>
      <div className="flex gap-2">
        {notInstalled && (
          <Button onClick={() => void window.orchaDesktop.openExternal(DOCKER_DOWNLOAD_URL)}>
            <Download className="h-4 w-4" />
            Get Docker Desktop
          </Button>
        )}
        {report && !ok && (
          <Button variant="outline" disabled={checking} onClick={check}>
            Re-check
          </Button>
        )}
        <Button disabled={!ok} onClick={onContinue}>
          Continue
        </Button>
      </div>
    </div>
  )
}
