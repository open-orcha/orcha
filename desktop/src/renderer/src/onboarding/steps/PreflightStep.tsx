import { useEffect, useState } from 'react'
import type { PreflightReport } from '../../../../shared/types'
import { Button } from '../../ui/Button'
import { Card } from '../../ui/Card'

export default function PreflightStep({ onContinue }: { onContinue: () => void }) {
  const [report, setReport] = useState<PreflightReport | null>(null)
  const check = (): void => void window.orchaDesktop.preflight().then(setReport)
  useEffect(() => check(), [])
  const ok = report?.docker === 'ok'
  return (
    <div className="flex flex-col gap-4 animate-slide-in">
      <h2 className="text-lg font-semibold">Check Docker</h2>
      <Card className="text-sm">
        {report === null ? 'Checking Docker…' : ok ? 'Docker is ready.' : report.hint}
      </Card>
      <div className="flex gap-2">
        {report && !ok && (
          <Button variant="outline" onClick={check}>
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
