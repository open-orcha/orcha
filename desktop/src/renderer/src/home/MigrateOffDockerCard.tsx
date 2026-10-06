import { useState } from 'react'
import type { Stack } from '../../../shared/types'
import { Button } from '../ui/Button'
import { Loader2 } from 'lucide-react'
import { readableError } from '../util/errorText'

/** Plan D2 (no-Docker issue 258): "Move this project off Docker" — one card per Docker project with a folder.
 *  The move is `orcha migrate-runtime --json` (provision mode 'migrate'): it copies the
 *  project's data out of Docker, keeps the Docker copy as the way back, and starts the
 *  project natively. Docker must be on for the copy; when it isn't, the CLI's own "start
 *  Docker once" message is shown as is, and nothing is created. */
export default function MigrateOffDockerCard({ stacks, onDone }: { stacks: Stack[]; onDone(): Promise<void> | void }) {
  const [moving, setMoving] = useState<string | null>(null)
  const [errors, setErrors] = useState<Record<string, string>>({})
  const docker = stacks.filter((s) => s.runtime === 'docker' && s.folder)
  if (docker.length === 0) return null

  const move = async (s: Stack): Promise<void> => {
    setMoving(s.project)
    setErrors((e) => ({ ...e, [s.project]: '' }))
    try {
      await window.orchaDesktop.provision({ folder: s.folder as string, mode: 'migrate' })
      await onDone()
    } catch (err) {
      const d = (err as { detail?: unknown })?.detail
      const r = readableError(err)
      setErrors((e) => ({ ...e, [s.project]: typeof d === 'string' && d ? d : (r.detail ?? r.summary) }))
    } finally {
      setMoving(null)
    }
  }

  return (
    <>
      {docker.map((s) => (
        <div
          key={s.project}
          role="status"
          data-testid="migrate-card"
          className="flex flex-col gap-1.5 rounded-md border border-border bg-bg/40 px-3 py-2 text-[13px]"
        >
          <div className="flex min-h-7 items-center gap-2.5">
            <span className="min-w-0 flex-1">
              <span className="font-medium">Move {s.project} off Docker</span>
              <span className="text-text-3"> — it then runs without Docker. Your data comes with it, and the Docker copy is kept.</span>
            </span>
            <Button size="sm" variant="secondary" disabled={moving !== null} onClick={() => void move(s)}>
              {moving === s.project ? (
                <>
                  <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" /> Moving…
                </>
              ) : (
                'Move off Docker'
              )}
            </Button>
          </div>
          {errors[s.project] && (
            <p className="text-[12px] text-danger" data-testid="migrate-error">
              {errors[s.project]}
            </p>
          )}
        </div>
      ))}
    </>
  )
}
